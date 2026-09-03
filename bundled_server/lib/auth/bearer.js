// Bearer-token authentication: static keys (env) + dynamic per-owner keystore.
// Mirrors the nginx auth_request model on platforms without nginx.

import crypto from 'node:crypto';

function readBearer(request) {
  const value = typeof request.headers?.get === 'function'
    ? request.headers.get('authorization')
    : request.headers?.authorization;
  const match = /^Bearer\s+(.+)$/i.exec(String(value || '').trim());
  return match ? match[1].trim() : null;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function createAuthenticator(entries, keystore) {
  const normalized = Object.entries(entries || {})
    .map(([key, ownerId]) => ({ key, ownerId }))
    .filter(({ key, ownerId }) => key && ownerId);

  return {
    authenticate(request) {
      const token = readBearer(request);
      if (!token) return null;
      const staticMatch = normalized.find(({ key }) => safeEqual(token, key));
      if (staticMatch) return { ownerId: staticMatch.ownerId, source: 'static' };
      if (keystore) {
        const ownerId = keystore.lookup(token);
        if (ownerId) return { ownerId, source: 'keystore' };
      }
      return null;
    },
    ownerIds() {
      const staticIds = normalized.map(({ ownerId }) => ownerId);
      return keystore ? [...new Set([...staticIds, ...keystore.records.keys()])] : staticIds;
    },
  };
}

export function unauthorized(response) {
  response.statusCode = 401;
  response.setHeader('WWW-Authenticate', 'Bearer');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify({ error: 'unauthorized' }));
}

export function forbidden(response) {
  response.statusCode = 403;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify({ error: 'forbidden' }));
}