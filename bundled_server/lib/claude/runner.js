// Run a single Claude Code CLI process as a worker: spawn, stream-parse the
// stream-json output, surface phase/session/tool progress, support resume, and
// enforce a timeout. This is the generic "launcher" — it knows nothing about
// what business task it is running. Callers pass in how to build the prompt
// (and, on Windows, how to scope permissions) via options.
//
// To keep the core reusable, all mutable inputs (workspace layout, binary
// paths, prompt builder, permission builder) are injected here, not imported.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

export const isWin = process.platform === 'win32';

function tail(value, max = 1200) {
  const text = String(value || '').trim();
  return text.length > max ? `...${text.slice(-max)}` : text;
}

function textFromMessage(message) {
  if (!message || typeof message !== 'object') return '';
  if (typeof message.result === 'string') return message.result;
  if (typeof message.message?.content === 'string') return message.message.content;
  if (Array.isArray(message.message?.content)) {
    return message.message.content
      .filter((block) => block?.type === 'text')
      .map((block) => block.text || '')
      .join('\n');
  }
  if (typeof message.content === 'string') return message.content;
  return '';
}

function phaseFromMessage(message) {
  if (message?.type === 'assistant') return 'agent_working';
  if (message?.type === 'result') return 'agent_finished';
  if (message?.type === 'system') return 'agent_started';
  return null;
}

function phaseMessage(phase, text) {
  const labels = {
    agent_started: 'Agent started, processing…',
    agent_working: 'Agent is thinking / writing…',
    agent_finished: 'Agent finished core work, validating the artifact…',
  };
  const base = labels[phase] || phase;
  return text ? `${base} ${tail(text, 160)}` : base;
}

// Default production-report hook used when the runner must produce a deliverable
// file. Overridden by callers with their own validation logic on the request.
async function ensureDeliverable(output, deliveredBy) {
  const stat = await fs.stat(output).catch(() => null);
  if (!stat || stat.size < 5) {
    throw new Error(`worker finished without producing ${path.basename(output)}`);
  }
  return stat.size;
}

/**
 * Spawn a Claude Code CLI worker and resolve when it exits.
 *
 * @param {object} opts
 * @param {string} opts.bin              Claude CLI executable path
 * @param {string} opts.cwd              working directory for the process
 * @param {string} opts.prompt           the task prompt (unused if resuming)
 * @param {string} [opts.sessionId]      existing session to resume from
 * @param {object} [opts.env]            extra env merged over defaults
 * @param {number} [opts.timeoutMs]      hard timeout before SIGTERM/SIGKILL
 * @param {string}  opts.configDir       CLAUDE_CONFIG_DIR (isolates this worker)
 * @param {string}  opts.output          path to the expected deliverable
 * @param {(progress:object)=>Promise} [opts.onProgress]  phase/session/tool events
 * @param {Function} [opts.validateOutput] async (output, {byRun:'validate'|'guard'})=>number|void
 * @param {string}  [opts.extraArgs]     additional claude args (e.g. --permission-mode)
 * @returns {Promise<{exitCode, signal, pdfBytes, summary}>}
 */
export async function runTask(opts) {
  const {
    bin,
    cwd,
    prompt,
    sessionId,
    env,
    timeoutMs = 15 * 60 * 1000,
    configDir,
    output,
    onProgress = async () => {},
    validateOutput = ensureDeliverable,
    extraArgs = [],
  } = opts;

  await onProgress({ phase: 'agent_starting', message: sessionId ? 'Resuming session…' : 'Starting Claude worker…' });

  const resume = Boolean(sessionId && typeof sessionId === 'string' && sessionId.length > 0);
  const baseArgs = resume
    ? ['--resume', sessionId, '-p', 'Continue the current task and deliver the final artifact. If already complete, confirm it.']
    : ['-p', prompt];
  const args = [
    ...baseArgs,
    '--setting-sources', 'user',
    '--output-format', 'stream-json',
    '--verbose',
    ...extraArgs,
  ];

  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME || requireHomedir(),
    LANG: process.env.LANG || 'C.UTF-8',
    CLAUDE_CONFIG_DIR: configDir,
    // Local proxy stays disabled by default unless caller sets the real vars.
    ...(env || {}),
  };

  const child = spawn(bin, args, { cwd, env: childEnv, detached: !isWin, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let lastText = '';
  let lastPhase = null;
  let lineBuffer = '';

  const consumeLine = async (line) => {
    if (!line.trim()) return;
    try {
      const message = JSON.parse(line);
      if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
        await onProgress({ phase: 'session_started', sessionId: message.session_id });
      }
      const phase = phaseFromMessage(message);
      const text = textFromMessage(message);
      if (text) lastText = tail(text, 800);
      if (phase && phase !== lastPhase) {
        lastPhase = phase;
        await onProgress({ phase, message: phaseMessage(phase, text) });
      }
      if (message.type === 'assistant') {
        const tools = (message.message?.content || [])
          .filter((block) => block?.type === 'tool_use')
          .map((block) => block.name)
          .filter(Boolean);
        if (tools.length) {
          lastPhase = 'agent_using_tools';
          await onProgress({ phase: 'agent_using_tools', tools, message: `Using tools: ${tools.join('、')}` });
        }
      }
    } catch {
      // Non-JSON diagnostics stay private in stderr.
    }
  };

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    lineBuffer += chunk;
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() || '';
    for (const line of lines) consumeLine(line).catch(() => {});
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000).unref();
  }, timeoutMs);

  const result = await new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
    child.once('error', (error) => resolve({ code: null, signal: null, error }));
  });
  clearTimeout(timer);
  if (lineBuffer.trim()) await consumeLine(lineBuffer);

  if (timedOut) throw new Error(`worker timed out after ${Math.round(timeoutMs / 60000)} minutes`);
  if (result.error) throw new Error(`could not start Claude: ${result.error.message}`);

  // First pass: validate the deliverable (guard) even on a good exit.
  let bytes = 0;
  if (output) {
    try {
      bytes = await validateOutput(output, { byRun: 'guard' });
    } catch (error) {
      if (result.code === 0) {
        throw new Error(`worker exited cleanly but ${error.message}: ${tail(lastText || stderr, 900)}`);
      }
      throw new Error(`worker exited with code ${result.code ?? 'unknown'}${result.signal ? ` (${result.signal})` : ''}: ${tail(stderr || lastText, 900)}`);
    }
  }

  if (result.code !== 0) {
    throw new Error(`worker exited with code ${result.code ?? 'unknown'}${result.signal ? ` (${result.signal})` : ''}: ${tail(stderr || lastText, 900)}`);
  }

  return { exitCode: result.code, signal: result.signal, bytes, summary: tail(lastText, 800) };
}

function requireHomedir() {
  return process.env.HOME || os.homedir();
}