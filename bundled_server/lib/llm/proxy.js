// Fixed-endpoint LLM proxy. Claude worker processes always talk to a single
// local URL (http://HOST:PORT/claude/v1/messages) carrying one static local key;
// this handler decides the real provider + protocol from the active mapping:
//   - type=anthropic -> pass through byte-for-byte (swap x-api-key / base_url)
//   - type=openai    -> convert Anthropic->OpenAI, forward, synthesize Anthropic SSE
// Registers into the same HTTP listener — no extra port/process.

import { formatAnthropicToOpenAI } from './format-request.js';
import { streamOpenAIToAnthropic } from './format-stream.js';
import { formatOpenAIToAnthropic } from './format-response.js';

const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 25 * 1024 * 1024);

function json(response, status, value) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(value));
}

async function readBody(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Always respond with an Anthropic-shaped error JSON so the Claude CLI can
// parse a useful message.
function anthropicError(status, message) {
  const type = status === 401
    ? 'authentication_error'
    : status === 429
      ? 'rate_limit_error'
      : status === 413
        ? 'invalid_request_error'
        : 'api_error';
  return { type: 'error', error: { type, message: String(message || '').slice(0, 800) } };
}

// Pipe the upstream Response body byte-for-byte to the local response.
async function pipeUpstream(response, upstreamRes) {
  const contentType = upstreamRes.headers.get('content-type') || 'application/json';
  response.statusCode = upstreamRes.status;
  response.setHeader('Content-Type', contentType);
  response.setHeader('Cache-Control', 'no-cache');
  const body = upstreamRes.body;
  if (!body) {
    response.end();
    return;
  }
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      response.write(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  response.end();
}

async function forwardAnthropic(request, response, provider) {
  const body = await readBody(request);
  const upstream = `${provider.baseUrl}/messages`;
  const headers = {
    'content-type': 'application/json',
    'x-api-key': provider.apiKey,
    'anthropic-version': String(request.headers['anthropic-version'] || '2023-06-01'),
  };
  const beta = request.headers['anthropic-beta'];
  if (beta) headers['anthropic-beta'] = beta;
  const upstreamRes = await fetch(upstream, { method: 'POST', headers, body });
  if (upstreamRes.status >= 400) {
    const text = await upstreamRes.text();
    return json(response, upstreamRes.status, anthropicError(upstreamRes.status, text));
  }
  return pipeUpstream(response, upstreamRes);
}

async function convertOpenAI(request, response, provider) {
  let anthropicBody;
  try {
    anthropicBody = JSON.parse((await readBody(request)).toString('utf8'));
  } catch {
    return json(response, 400, anthropicError(400, 'invalid JSON request body'));
  }

  const openaiBody = formatAnthropicToOpenAI(anthropicBody, { model: provider.model });
  const upstreamRes = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(openaiBody),
  });

  if (upstreamRes.status >= 400) {
    const text = await upstreamRes.text();
    console.error(`[proxy] openai upstream ${upstreamRes.status}: ${text.slice(0, 500)}`);
    return json(response, upstreamRes.status, anthropicError(upstreamRes.status, text));
  }

  if (openaiBody.stream) {
    const anthropicStream = streamOpenAIToAnthropic(upstreamRes.body, provider.model);
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');
    const reader = anthropicStream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        response.write(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    response.end();
    return;
  }

  const completion = await upstreamRes.json();
  return json(response, 200, formatOpenAIToAnthropic(completion, provider.model));
}

/**
 * Create the fixed-endpoint proxy handler.
 * @param {object} deps
 * @param {import('./providers.js').ProviderStore} deps.providers
 * @param {string} deps.localKey  CLAUDE_LOCAL_KEY (static key carried by workers)
 */
export function createClaudeProxy({ providers, localKey }) {
  return async function handleClaudeMessages(request, response) {
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      return json(response, 405, anthropicError(405, 'method not allowed'));
    }
    if (!localKey) return json(response, 500, anthropicError(500, 'CLAUDE_LOCAL_KEY is not configured'));
    // Different Claude versions/platforms send different headers; accept both.
    const headerKey = String(request.headers['x-api-key'] || '');
    const bearer = String(request.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    const authKey = headerKey || bearer;
    if (!authKey || authKey !== localKey) return json(response, 401, anthropicError(401, 'invalid x-api-key'));

    const provider = providers.getActive();
    if (!provider) return json(response, 500, anthropicError(500, 'no active provider configured'));

    try {
      if (provider.type === 'anthropic') return await forwardAnthropic(request, response, provider);
      return await convertOpenAI(request, response, provider);
    } catch (error) {
      console.error(`[proxy] ${error.stack || error.message}`);
      if (!response.headersSent) json(response, 502, anthropicError(502, `upstream failed: ${error.message}`));
      else response.destroy();
    }
  };
}