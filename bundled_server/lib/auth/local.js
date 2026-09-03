// Local admin login for bare instances that have no nginx auth_request in
// front. Replicates a cookie-session auth flow: GET/POST /api/login,
// GET/POST /api/logout, and an authenticate(req) used as the identity source
// (the equivalent of nginx auth_request_set X-Auth-User).
//
// Credentials: an htpasswd file ({SSHA}/{SHA}/{PLAIN}) or FLEET_ADMIN_USER /
// FLEET_ADMIN_PASS env vars.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIE_NAME = 'fleet_admin_session';
const DEFAULT_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const SECRET_FILE = process.env.FLEET_SESSION_SECRET_FILE || path.join(__dirname, '..', '..', 'data', '.local-session-secret');

async function loadSecret() {
  try {
    const existing = (await fs.readFile(SECRET_FILE, 'utf8')).trim();
    if (existing) return existing;
  } catch {
    // fall through to generate
  }
  const generated = crypto.randomBytes(48).toString('hex');
  await fs.mkdir(path.dirname(SECRET_FILE), { recursive: true, mode: 0o700 });
  await fs.writeFile(SECRET_FILE, generated, { mode: 0o600 });
  return generated;
}

function signSession(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifySession(secret, token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const aBuf = Buffer.from(signature);
  const bBuf = Buffer.from(expected);
  if (aBuf.length !== bBuf.length || !crypto.timingSafeEqual(aBuf, bBuf)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp !== 'number' || payload.exp <= Date.now()) return null;
  if (typeof payload.u !== 'string' || !payload.u) return null;
  return payload;
}

function readCookie(request, name) {
  const header = String(request.headers.cookie || '');
  if (!header) return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    if (trimmed.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(trimmed.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function safeCompareString(a, b) {
  const sA = String(a || '');
  const sB = String(b || '');
  const bufA = Buffer.from(sA, 'utf8');
  const bufB = Buffer.from(sB, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function safeCompareBuffer(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Verify an htpasswd-style hash ({SSHA}/{SHA}/{PLAIN}). Plain text is also
// accepted for easy local debugging.
function verifyHtpasswdPassword(password, stored) {
  const candidate = String(password || '');
  const hash = String(stored || '');
  if (hash.startsWith('{SSHA}')) {
    let decoded;
    try {
      decoded = Buffer.from(hash.slice(6), 'base64');
    } catch {
      return false;
    }
    if (decoded.length <= 20) return false;
    const expectedDigest = decoded.subarray(0, 20);
    const salt = decoded.subarray(20);
    const actualDigest = crypto.createHash('sha1').update(candidate, 'utf8').update(salt).digest();
    return safeCompareBuffer(actualDigest, expectedDigest);
  }
  if (hash.startsWith('{SHA}')) {
    const actualDigest = crypto.createHash('sha1').update(candidate, 'utf8').digest('base64');
    return safeCompareString(actualDigest, hash.slice(5));
  }
  if (hash.startsWith('{PLAIN}')) {
    return safeCompareString(candidate, hash.slice(7));
  }
  return safeCompareString(candidate, hash);
}

async function loadHtpasswd(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const sep = line.indexOf(':');
        if (sep < 0) return null;
        return { username: line.slice(0, sep), passwordHash: line.slice(sep + 1).split(':')[0] };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function createLocalAuth() {
  let secretPromise = null;
  const getSecret = () => (secretPromise ||= loadSecret());

  const htpasswdFile = process.env.FLEET_ADMIN_HTPASSWD || '';
  const envUser = process.env.FLEET_ADMIN_USER || '';
  const envPass = process.env.FLEET_ADMIN_PASS || '';

  async function validateCredentials(username, password) {
    if (!username || !password) return false;
    if (htpasswdFile) {
      const records = await loadHtpasswd(htpasswdFile);
      const record = records.find((r) => safeCompareString(username, r.username));
      if (record && verifyHtpasswdPassword(password, record.passwordHash)) return true;
    }
    if (envUser && envPass) {
      if (safeCompareString(username, envUser) && safeCompareString(password, envPass)) return true;
    }
    return false;
  }

  async function isConfigured() {
    if (htpasswdFile) {
      const records = await loadHtpasswd(htpasswdFile);
      if (records.length) return true;
    }
    return Boolean(envUser && envPass);
  }

  function setSessionCookie(response, username, maxAgeMs = DEFAULT_MAX_AGE_MS) {
    return getSecret().then((secret) => {
      const exp = Date.now() + maxAgeMs;
      const token = signSession(secret, { u: username, exp });
      response.setHeader(
        'Set-Cookie',
        `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`,
      );
    });
  }

  function clearSessionCookie(response) {
    response.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    );
  }

  async function authenticate(request) {
    const token = readCookie(request, COOKIE_NAME);
    if (!token) return null;
    const secret = await getSecret();
    const session = verifySession(secret, token);
    return session ? session.u : null;
  }

  return { validateCredentials, isConfigured, setSessionCookie, clearSessionCookie, authenticate };
}

function renderLoginPage({ next, error, username, realm }) {
  const safeNext = String(next || '/console').replace(/"/g, '&quot;');
  const safeError = String(error || '').replace(/"/g, '&quot;');
  const safeUser = String(username || '').replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 · Claude Fleet</title>
<style>
  :root{--paper:#f7f3ea;--card:#fffdf7;--ink:#3a3226;--line-dark:#c9bda3;--accent:#8c6b3f;--accent-deep:#6e5330;--seal:#a5382e;}
  *{box-sizing:border-box;}
  body{margin:0;color:var(--ink);background:var(--paper);font-family:"Noto Serif SC","Songti SC","SimSun",Georgia,serif;
      display:flex;min-height:100vh;align-items:center;justify-content:center;
      background-image:radial-gradient(ellipse at top, rgba(255,255,255,.6), transparent 60%);}
  .box{width:360px;max-width:92vw;background:var(--card);border:1px solid var(--line-dark);border-radius:4px;
       padding:34px 30px;box-shadow:0 4px 16px rgba(90,75,50,.08);position:relative;}
  .box::before{content:"";position:absolute;top:8px;left:8px;right:8px;bottom:8px;border:1px solid rgba(140,107,63,.12);border-radius:2px;pointer-events:none;}
  h1{margin:0 0 4px;font-size:22px;letter-spacing:5px;text-align:center;}
  h1 .dot{color:var(--seal);}
  .sub{text-align:center;color:#7a7060;font-size:13px;margin:0 0 24px;}
  label{display:block;font-size:13px;color:#7a7060;margin:14px 0 5px;letter-spacing:1px;}
  input{width:100%;padding:10px 12px;border:1px solid var(--line-dark);border-radius:3px;font-size:14px;background:#fffef9;font-family:inherit;}
  input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 2px rgba(140,107,63,.12);}
  button{width:100%;margin-top:22px;padding:10px;border:1px solid var(--accent-deep);border-radius:3px;background:var(--accent);
         color:#fff;font-size:15px;letter-spacing:3px;cursor:pointer;font-family:inherit;}
  button:hover{background:var(--accent-deep);}
  .err{color:var(--seal);font-size:13px;margin-top:14px;text-align:center;}
  .foot{margin-top:20px;text-align:center;font-size:12px;color:#a89a7e;}
</style>
</head>
<body>
<div class="box">
  <h1>Claude Fleet<span class="dot"> · </span>登录</h1>
  <p class="sub">${realm || 'Admin Console'}</p>
  <form method="post" action="/api/login">
    <input type="hidden" name="next" value="${safeNext}">
    <label for="username">用户名</label>
    <input id="username" name="username" value="${safeUser}" autocomplete="username" required>
    <label for="password">密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">登 录</button>
    ${safeError ? `<div class="err">${safeError}</div>` : ''}
  </form>
  <div class="foot">本地服务管理面板</div>
</div>
</body>
</html>`;
}

export function createLocalAuthHandlers(localAuth) {
  async function handleLoginGet(request, response, url) {
    if (!(await localAuth.isConfigured())) {
      response.statusCode = 503;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end('Admin authentication is not configured');
      return;
    }
    const user = await localAuth.authenticate(request);
    if (user) {
      response.statusCode = 302;
      response.setHeader('Location', safeNext(url.searchParams.get('next')));
      response.end();
      return;
    }
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end(renderLoginPage({ next: url.searchParams.get('next'), error: url.searchParams.get('error') || '' }));
  }

  async function handleLoginPost(request, response, url) {
    if (!(await localAuth.isConfigured())) {
      response.statusCode = 503;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end('Admin authentication is not configured');
      return;
    }
    const raw = (await readBody(request, 64 * 1024)).toString('utf8');
    const params = new URLSearchParams(raw);
    const username = String(params.get('username') || '').trim();
    const password = String(params.get('password') || '');
    const next = safeNext(params.get('next'));
    if (!username || !password) {
      response.statusCode = 400;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.end(renderLoginPage({ next, error: '请输入用户名和密码', username }));
      return;
    }
    const ok = await localAuth.validateCredentials(username, password);
    if (!ok) {
      response.statusCode = 401;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.end(renderLoginPage({ next, error: '用户名或密码错误', username }));
      return;
    }
    await localAuth.setSessionCookie(response, username);
    response.setHeader('Cache-Control', 'no-store');
    response.statusCode = 302;
    response.setHeader('Location', next);
    response.end();
  }

  function handleLogout(request, response, url) {
    localAuth.clearSessionCookie(response);
    response.setHeader('Cache-Control', 'no-store');
    const next = safeNext(url.searchParams.get('next')) || '/api/login';
    response.statusCode = 302;
    response.setHeader('Location', next);
    response.end();
  }

  return { handleLoginGet, handleLoginPost, handleLogout };
}

function safeNext(value) {
  if (!value || typeof value !== 'string') return '/console';
  try {
    const u = new URL(value, 'http://localhost');
    return u.pathname + u.search + u.hash;
  } catch {
    return '/console';
  }
}

async function readBody(request, maxBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}