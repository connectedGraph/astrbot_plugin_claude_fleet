// Locate a Claude Code CLI binary cross-platform and verify it meets a
// minimum version gate. This is the "bring your own launcher" core: given a
// plain install of Claude Code, we find where it lives and refuse to proceed
// if it is older than required.
//
// Precedence (highest first):
//   1. CLAUDE_BIN env (explicit pin)
//   2. Platform-specific well-known locations
//   3. `where claude` / `which claude` (PATH) — resolved to the real binary
//
// Exports:
//   defaultMinVersion()                     -> env CLAUDE_MIN_VERSION || '2.0.0'
//   locateClaude(opts?)                     -> Promise<bin path> (throws ClaudeNotFoundError)
//   readClaudeVersion(bin)                  -> Promise<"x.y.z">
//   checkClaude({ bin?, minVersion? })      -> Promise<ClaudeInfo> (fails gate -> ClaudeVersionError)
//   ClaudeNotFoundError, ClaudeVersionError

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { satisfiesGE } from '../semver.js';

export const defaultMinVersion = () => process.env.CLAUDE_MIN_VERSION || '2.0.0';

export class ClaudeNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ClaudeNotFoundError';
    this.code = 'CLAUDE_NOT_FOUND';
  }
}

export class ClaudeVersionError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'ClaudeVersionError';
    this.code = 'CLAUDE_VERSION_TOO_OLD';
    if (detail) Object.assign(this, detail);
  }
}

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function home() {
  return os.homedir();
}

// Well-known install locations per platform. The npm-global real binary is
// resolved from `npm prefix` when possible so we avoid .cmd/.bat shims.
async function candidatePaths() {
  const list = [];

  if (process.env.CLAUDE_BIN) list.push(process.env.CLAUDE_BIN);

  if (isWin) {
    const appData = process.env.APPDATA || path.join(home(), 'AppData', 'Roaming');
    list.push(
      // npm global real exe (typical for a global install)
      path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      // npm -g with prefix elsewhere
      ...(await npmGlobalCandidates()),
      // scoop
      path.join(home(), 'scoop', 'apps', 'claude', 'current', 'claude.exe'),
      // manual / local
      path.join(home(), '.claude', 'local', 'claude.exe'),
    );
  } else if (isMac) {
    list.push(
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      path.join(home(), '.local', 'bin', 'claude'),
      path.join(home(), '.claude', 'local', 'claude'),
      ...(await npmGlobalCandidates()),
    );
  } else {
    // Linux
    list.push(
      '/usr/local/bin/claude',
      '/usr/bin/claude',
      path.join(home(), '.local', 'bin', 'claude'),
      path.join(home(), '.claude', 'local', 'claude'),
      ...(await npmGlobalCandidates()),
    );
  }
  return list;
}

async function npmGlobalCandidates() {
  const out = [];
  try {
    const prefix = await runCapture(isWin ? 'npm.cmd' : 'npm', ['prefix', '-g']);
    if (prefix) {
      out.push(
        path.join(prefix.trim(), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', isWin ? 'claude.exe' : 'claude'),
      );
    }
  } catch {
    // npm not on PATH; ignore.
  }
  return out;
}

function runCapture(command, args, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timed out running ${command}`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr += c; });
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`exited ${code}: ${stderr.trim()}`));
      else resolve(stdout);
    });
  });
}

// Resolve `which claude` / `where claude` to a concrete path found on PATH.
async function findOnPath() {
  try {
    const raw = await runCapture(isWin ? 'where.exe' : 'which', ['claude']);
    const first = raw.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

async function isExecutable(file) {
  if (!file || typeof file !== 'string') return false;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return false;
    if (isWin) return true; // Windows ignores exec bit; extension governs.
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

// Resolve to the located binary path, or throw ClaudeNotFoundError.
export async function locateClaude(opts = {}) {
  const candidates = opts.candidates || await candidatePaths();
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (await isExecutable(candidate)) return candidate;
  }
  // Last resort: PATH lookup via which/where.
  if (opts.allowPathFallback !== false) {
    const onPath = await findOnPath();
    if (onPath && await isExecutable(onPath)) return onPath;
  }

  throw new ClaudeNotFoundError(
    'Could not locate a Claude Code CLI. Install it (npm install -g @anthropic-ai/claude-code) ' +
    'or set CLAUDE_BIN to its absolute path.',
  );
}

// Run `claude --version` and parse the "x.y.z" out of the output.
export async function readClaudeVersion(bin) {
  let raw;
  try {
    raw = await runCapture(bin, ['--version']);
  } catch (error) {
    throw new ClaudeNotFoundError(`Found Claude CLI at ${bin} but could not read its version: ${error.message}`);
  }
  // Output looks like "2.1.233 (Claude Code)" or "v2.1.233 (Claude Code)".
  const match = /(\d+\.\d+\.\d+)/.exec(raw);
  if (!match) throw new ClaudeNotFoundError(`Could not parse Claude version from: ${JSON.stringify(raw.trim())}`);
  return match[1];
}

// Locate (if needed) and verify the version gate. Never throws on a *newer*
// version; throws ClaudeVersionError when below the gate.
export async function checkClaude(opts = {}) {
  const bin = opts.bin || await locateClaude(opts);
  const minVersion = opts.minVersion || defaultMinVersion();
  const version = opts.version || await readClaudeVersion(bin);
  const satisfied = satisfiesGE(version, minVersion);
  if (!satisfied) {
    throw new ClaudeVersionError(
      `Claude Code at ${bin} is ${version}, but >= ${minVersion} is required.`,
      { bin, version, minVersion, satisfied: false },
    );
  }
  return {
    bin,
    version,
    minVersion,
    satisfied: true,
    source: opts.source || (process.env.CLAUDE_BIN ? 'CLAUDE_BIN' : 'auto'),
  };
}