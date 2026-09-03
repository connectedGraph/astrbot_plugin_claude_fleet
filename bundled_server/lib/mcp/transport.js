// Minimal MCP Streamable HTTP server transport, hand-written on Node's built-in
// http — zero dependencies. This intentionally replaces @modelcontextprotocol/sdk
// with a ~150-line JSON-RPC 2.0 layer that supports the stateless subset the
// server uses: initialize, tools/list, tools/call. No session memory is kept;
// every request is self-contained (session capabilities advertise `stateless`).
//
// It speaks to a Router (see createMcpRouter) that owns the tool table. The
// MCP client POSTs JSON-RPC; we reply application/json.

import crypto from 'node:crypto';

const LATEST_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07', '2024-06-07'];

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

// Internal server implementation format (camelCase JSON-RPC namespace).
// tools: [{ name, description, inputSchema (JSON Schema), handler(args)->{content:[{type:'text',text}]} }]
export function createMcpRouter({ name = 'fleet', version = '0.1.0', tools = [] }) {
  const table = new Map(tools.map((tool) => [tool.name, tool]));

  function toolList() {
    return tools.map((t) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }));
  }

  async function handleRaw(message) {
    if (!message || message.jsonrpc !== '2.0') {
      return rpcError(message?.id, -32600, 'Invalid Request');
    }
    const { id, method, params } = message;

    if (method === 'initialize') {
      const clientProtocol = params?.protocolVersion;
      const selected = SUPPORTED_VERSIONS.includes(clientProtocol)
        ? clientProtocol
        : LATEST_PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion: selected,
        capabilities: {
          tools: { listChanged: false },
          // Stateless: we don't hold a session between requests.
          ...(params?.capabilities?.streaming ? {} : {}),
        },
        serverInfo: { name, version },
        instructions: '',
      });
    }

    if (method === 'notifications/initialized' || method.endsWith('/initialized')) {
      // Stateless notifications: nothing to store.
      return null;
    }

    if (method === 'ping') {
      return rpcResult(id, {});
    }

    if (method === 'tools/list') {
      return rpcResult(id, { tools: toolList() });
    }

    if (method === 'tools/call') {
      const tool = table.get(params?.name);
      if (!tool) {
        return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
      }
      try {
        const out = await tool.handler(params?.arguments || {});
        return rpcResult(id, { content: out?.content || [{ type: 'text', text: 'ok' }], isError: out?.isError || false });
      } catch (error) {
        return rpcResult(id, {
          content: [{ type: 'text', text: String(error?.message || 'tool error') }],
          isError: true,
        });
      }
    }

    // Unknown method.
    return rpcError(id, -32601, `Method not found: ${method}`);
  }

  // Parse an HTTP request body (JSON or batched JSON-RPC) and write the
  // response. Returns true if handled.
  async function handleRequest(req, res) {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Allow', 'POST');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(rpcError(null, -32000, 'MCP over HTTP requires POST')));
      return true;
    }
    const chunks = [];
    let total = 0;
    const maxBytes = Number(process.env.MAX_BODY_BYTES || 25 * 1024 * 1024);
    for await (const chunk of req) {
      total += chunk.length;
      if (total > maxBytes) {
        res.statusCode = 413;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(rpcError(null, -32000, 'request body too large')));
        return true;
      }
      chunks.push(chunk);
    }
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(rpcError(null, -32700, 'Parse error')));
      return true;
    }

    const isBatch = Array.isArray(payload);
    const messages = isBatch ? payload : [payload];
    const results = [];
    for (const message of messages) {
      const result = await handleRaw(message);
      if (result) results.push(result);
    }
    if (!results.length) {
      // A pure notification (no id) — MCP clients may still expect 202 Accepted.
      res.statusCode = 202;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end();
      return true;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Mcp-Session-Id', crypto.randomUUID());
    res.end(JSON.stringify(isBatch ? results : results[0]));
    return true;
  }

  return { handleRequest, tools: toolList() };
}