// HTTP assembly: wires the generic lib into a runnable service. Exposes:
//   GET  /health
//   POST /mcp                         (Streamable HTTP, tools: check/create/list)
//   GET/POST/DELETE /api/tasks[...]   (REST task API)
//   GET  /tasks/:id/artifact          (download the produced artifact)
//   GET  /api/providers ...           (provider registry CRUD)
//   GET  /api/login|/api/logout       (bare-instance admin auth)
//   POST /claude/v1/messages          (fixed-endpoint LLM proxy)
//   GET  /console                     (admin panel)
//
// The task executor is injectable and defaults to lib/claude/executor.js.
// To run a domain-specific workflow, pass EXECUTOR via FLEET_EXECUTOR or
// construct your own app and call startServer with a custom executor.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAuthenticator, unauthorized } from '../lib/auth/bearer.js';
import { KeyStore } from '../lib/auth/keystore.js';
import { JobStore } from '../lib/jobs/store.js';
import { startWorker } from '../lib/jobs/worker.js';
import { ProviderStore } from '../lib/llm/providers.js';
import { createClaudeProxy } from '../lib/llm/proxy.js';
import { createLocalAuth, createLocalAuthHandlers } from '../lib/auth/local.js';
import { createMcpRouter } from '../lib/mcp/transport.js';
import { defaultFleetExecutor } from '../lib/claude/executor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_PATH = path.join(__dirname, '..', 'public', 'console.html');
const KEYSTORE_FILE = process.env.KEYSTORE_FILE || path.join(__dirname, '..', 'data', 'keys.json');
const PROVIDERS_FILE = process.env.PROVIDERS_FILE || path.join(__dirname, '..', 'data', 'providers.json');

const PORT = Number(process.env.PORT || 3180);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`;
const TASK_ROOT = process.env.TASK_ROOT || path.join(__dirname, '..', 'data', 'tasks');
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 25 * 1024 * 1024);
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 8 * 1024 * 1024);
const MAX_TOTAL_BYTES = Number(process.env.MAX_TOTAL_BYTES || 20 * 1024 * 1024);
const MAX_FILES = Number(process.env.MAX_FILES || 20);
const RETENTION_MS = Number(process.env.RETENTION_MS || 24 * 60 * 60 * 1000);
const LOW_DISK_FREE = Number(process.env.LOW_DISK_FREE_BYTES || 1024 * 1024 * 1024);
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 15 * 60 * 1000);
const ALLOWED_HOSTS = new Set((process.env.ALLOWED_HOSTS || 'localhost,127.0.0.1').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

function parseKeys(raw) {
  return Object.fromEntries(String(raw || '').split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const sep = entry.indexOf(':');
    if (sep <= 0) throw new Error('FLEET_API_KEYS entries must be key:owner');
    return [entry.slice(0, sep), entry.slice(sep + 1)];
  }));
}

// Resolve the executor: allow a module path override, else the default.
async function resolveExecutor() {
  if (process.env.FLEET_EXECUTOR) {
    const mod = await import(pathToFileURL(path.resolve(process.cwd(), process.env.FLEET_EXECUTOR)));
    return mod.default || mod;
  }
  return defaultFleetExecutor;
}

export async function startServer(options = {}) {
  const { executor = await resolveExecutor(), serviceName = 'claude-fleet-server', version = '0.1.0' } = options;

  const keystore = new KeyStore(KEYSTORE_FILE);
  const authenticator = createAuthenticator(parseKeys(process.env.FLEET_API_KEYS), keystore);
  const limits = {
    maxInstructions: 20_000,
    maxFiles: MAX_FILES,
    maxFileBytes: MAX_FILE_BYTES,
    maxTotalBytes: MAX_TOTAL_BYTES,
    maxQueuedPerOwner: Number(process.env.MAX_QUEUED_PER_OWNER || 10),
    maxList: 100,
    retentionMs: RETENTION_MS,
  };
  // NOTE: artifactSuffix is overridden by domain executors (e.g. handouts emits
  // output.pdf). The default executor emits output.bin.
  const store = new JobStore({
    root: TASK_ROOT,
    baseUrl: PUBLIC_BASE_URL,
    limits,
    artifactSuffix: process.env.FLEET_ARTIFACT_SUFFIX || '/output/output.bin',
  });
  const providers = new ProviderStore(PROVIDERS_FILE);
  const claudeProxy = createClaudeProxy({ providers, localKey: process.env.CLAUDE_LOCAL_KEY });
  const localAuth = createLocalAuth();
  const localAuthHandlers = createLocalAuthHandlers(localAuth);

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

  function requestHostAllowed(request) {
    const host = String(request.headers.host || '').split(':')[0].toLowerCase();
    if (host && !ALLOWED_HOSTS.has(host)) return false;
    const origin = request.headers.origin;
    if (!origin) return true;
    try {
      return ALLOWED_HOSTS.has(new URL(origin).hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  async function serveHtml(response, filePath, cacheControl = 'no-cache') {
    try {
      const html = await fs.readFile(filePath, 'utf8');
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader('Cache-Control', cacheControl);
      response.end(html);
      return true;
    } catch (error) {
      json(response, 404, { error: 'page not found' });
      return false;
    }
  }

  // Minimal MCP router over the store.
  const mcpRouter = createMcpRouter({
    name: serviceName,
    version,
    tools: [
      {
        name: 'task_check',
        description: 'Check the task service and your queue.',
        inputSchema: { type: 'object', properties: {} },
        handler: async (args, ownerId) => store.check(ownerId),
      },
      {
        name: 'task_create',
        description: 'Create an asynchronous task that produces one artifact. Poll task_list with the returned taskId.',
        inputSchema: {
          type: 'object',
          properties: {
            instructions: { type: 'string' },
            files: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, contentBase64: { type: 'string' } } } },
            mainFileName: { type: 'string' },
          },
        },
        handler: async (updatedArgs) => {
          const result = await store.create(updatedArgs.ownerId, updatedArgs.args);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        },
      },
      {
        name: 'task_list',
        description: 'List your tasks or inspect one task. Poll every 5-10 seconds until succeeded or failed.',
        inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, limit: { type: 'number' } } },
        handler: async () => ({ content: [{ type: 'text', text: 'poll via /api/tasks' }] }),
      },
    ],
  });

  async function handleMcp(request, response, auth) {
    try {
      await mcpRouter.handleRequest(request, response);
    } catch (error) {
      console.error(`[mcp] ${error.stack || error.message}`);
      if (!response.headersSent) json(response, 500, { error: 'mcp request failed' });
    }
  }

  async function handleRest(request, response, auth, pathname, url) {
    if (pathname === '/api/tasks/check') {
      if (request.method !== 'GET') return json(response, 405, { error: 'method not allowed' });
      return json(response, 200, store.check(auth.ownerId));
    }
    if (pathname === '/api/tasks/stats') {
      if (request.method !== 'GET') return json(response, 405, { error: 'method not allowed' });
      return json(response, 200, store.stats(auth.ownerId));
    }
    if (pathname === '/api/tasks') {
      if (request.method === 'GET') {
        return json(response, 200, store.list(auth.ownerId, url.searchParams.get('taskId'), url.searchParams.get('limit'), {
          status: url.searchParams.get('status'),
          scope: url.searchParams.get('scope'),
          offset: url.searchParams.get('offset'),
        }));
      }
      if (request.method === 'POST') {
        const body = JSON.parse((await readBody(request)).toString('utf8') || '{}');
        return json(response, 202, await store.create(auth.ownerId, body));
      }
      return json(response, 405, { error: 'method not allowed' });
    }
    const itemMatch = /^\/api\/tasks\/([0-9a-f-]{36})$/.exec(pathname);
    if (itemMatch && request.method === 'GET') {
      const records = store.list(auth.ownerId, itemMatch[1], 1);
      return records.length ? json(response, 200, records[0]) : json(response, 404, { error: 'task not found' });
    }
    return json(response, 404, { error: 'not found' });
  }

  async function handleArtifact(request, response, pathname) {
    const match = /^\/tasks\/([0-9a-f-]{36})\/artifact$/.exec(pathname);
    if (!match) return json(response, 404, { error: 'not found' });
    const task = store.getInternal(match[1]);
    if (!task) return json(response, 404, { error: 'task not found' });
    if (task.status !== 'succeeded') return json(response, 409, { error: 'task is not complete', status: task.status });
    const artifact = store.artifactPath(match[1]);
    try {
      const stat = await fs.stat(artifact);
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Length', stat.size);
      response.setHeader('Content-Disposition', `attachment; filename="artifact-${task.taskId}.bin"`);
      response.setHeader('Cache-Control', 'private, max-age=3600');
      const data = await fs.readFile(artifact);
      response.end(data);
    } catch {
      json(response, 404, { error: 'artifact not found' });
    }
  }

  // Provider mapping API (guarded by auth identity = x-auth-user or session cookie).
  async function handleProvidersApi(request, response, pathname) {
    const rest = pathname === '/api/providers' ? '' : pathname.slice('/api/providers'.length);
    if (!(pathname === '/api/providers' || /^\/(?:active|[a-zA-Z0-9_-]{1,32})$/.test(rest))) {
      return json(response, 404, { error: 'not found' });
    }
    const user = String(request.headers['x-auth-user'] || '').trim();
    if (!user) return json(response, 401, { error: 'authentication required' });

    try {
      if (rest === '/active') {
        if (request.method !== 'POST') return json(response, 405, { error: 'method not allowed' });
        const body = JSON.parse((await readBody(request, 64 * 1024)).toString('utf8') || '{}');
        return json(response, 200, await providers.setActive(body.id));
      }
      const id = rest ? rest.slice(1) : null;
      if (request.method === 'GET') return json(response, 200, providers.publicState());
      if (request.method === 'PUT' && id) {
        const body = JSON.parse((await readBody(request, 256 * 1024)).toString('utf8') || '{}');
        return json(response, 200, await providers.save(id, body));
      }
      if (request.method === 'DELETE' && id) {
        return json(response, 200, await providers.delete(id));
      }
      return json(response, 405, { error: 'method not allowed' });
    } catch (error) {
      return json(response, error.statusCode || 400, { error: error.message || 'invalid provider configuration' });
    }
  }

  async function handleRequest(request, response) {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const { pathname } = url;

    // Local login/logout.
    if (pathname === '/api/login') {
      if (request.method === 'GET') return localAuthHandlers.handleLoginGet(request, response, url);
      if (request.method === 'POST') return localAuthHandlers.handleLoginPost(request, response, url);
      return json(response, 405, { error: 'method not allowed' });
    }
    if (pathname === '/api/logout') {
      if (request.method === 'GET' || request.method === 'POST') return localAuthHandlers.handleLogout(request, response, url);
      return json(response, 405, { error: 'method not allowed' });
    }
    // Identity: on deployments behind nginx, X-Auth-User is injected by
    // auth_request. On a bare instance, fall back to the signed cookie.
    if (!String(request.headers['x-auth-user'] || '').trim()) {
      try {
        const cookieUser = await localAuth.authenticate(request);
        if (cookieUser) request.headers['x-auth-user'] = cookieUser;
      } catch (error) {
        console.error(`[auth] cookie fallback failed: ${error.message}`);
      }
    }

    if (pathname === '/health') return json(response, 200, { ok: true, service: serviceName, version });
    if (pathname === '/console' || pathname === '/console/') {
      if (!String(request.headers['x-auth-user'] || '').trim()) {
        response.statusCode = 302;
        response.setHeader('Location', `/api/login?next=${encodeURIComponent(pathname)}`);
        return response.end();
      }
      return serveHtml(response, CONSOLE_PATH);
    }
    if (pathname === '/api/keys') {
      const user = String(request.headers['x-auth-user'] || '').trim();
      if (!user) return json(response, 401, { error: 'authentication required' });
      if (request.method === 'GET') {
        const record = keystore.get(user);
        return json(response, 200, { ownerId: user, hasKey: Boolean(record) });
      }
      if (request.method === 'POST') {
        try {
          const { key } = await keystore.issue(user);
          return json(response, 201, { ownerId: user, key });
        } catch (error) {
          return json(response, 500, { error: 'failed to issue key' });
        }
      }
      return json(response, 405, { error: 'method not allowed' });
    }
    if (pathname === '/api/providers' || pathname.startsWith('/api/providers/')) {
      return handleProvidersApi(request, response, pathname);
    }
    // Fixed LLM proxy (workers only carry the local key).
    if (pathname === '/claude/v1/messages') return claudeProxy(request, response);
    if (pathname === '/claude/v1/messages/count_tokens') {
      return json(response, 501, { error: 'count_tokens is not supported through the proxy' });
    }
    if (!requestHostAllowed(request)) return json(response, 421, { error: 'host/origin not allowed' });

    // Artifact download is public by design (task ID is the capability).
    if (pathname.startsWith('/tasks/') && pathname.endsWith('/artifact')) {
      return handleArtifact(request, response, pathname);
    }

    const authUser = String(request.headers['x-auth-user'] || '').trim();
    const auth = authUser ? { ownerId: authUser, source: 'auth_request' } : authenticator.authenticate(request);
    if (!auth) return unauthorized(response);

    if (pathname === '/mcp') return handleMcp(request, response, auth);
    if (pathname.startsWith('/api/tasks')) return handleRest(request, response, auth, pathname, url);
    return json(response, 404, { error: 'not found' });
  }

  await keystore.load();
  await providers.load();
  await store.init();
  startWorker(store, { concurrency: Number(process.env.WORKER_CONCURRENCY || 1), timeoutMs: AGENT_TIMEOUT_MS, execute: executor });
  setInterval(() => store.cleanup(LOW_DISK_FREE).catch((error) => console.error(`[cleanup] ${error.message}`)), 60 * 60 * 1000).unref();

  return http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      console.error(`[http] ${error.stack || error.message}`);
      if (!response.headersSent) json(response, error.statusCode || 500, { error: error.statusCode === 413 ? error.message : 'internal server error' });
      else response.destroy();
    });
  });
}

// Run when invoked directly: `node app/server.js`.
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const server = await startServer();
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  server.listen(PORT, HOST, () => console.log(`[server] claude-fleet-server listening on http://${HOST}:${PORT}`));
  const shutdown = (signal) => {
    console.log(`[server] ${signal}, stopping`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}