// Generic asynchronous job store: a durable task queue persisted as one
// meta.json per task. Business-agnostic — "task" is any unit of work that ends
// by producing a single artifact file (PDF, docx, tarball, ...). The artifact
// file name and the step-log/TTL policies are configurable so any caller can
// layer their own product on top without touching this core.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const TERMINAL = new Set(['succeeded', 'failed', 'expired']);

// Common file types a task may upload as reference input.
const ALLOWED_EXTENSIONS = new Set([
  '.tex', '.cls', '.sty', '.bib', '.md', '.txt', '.pdf', '.doc', '.docx',
  '.csv', '.json', '.jsonl', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.zip',
]);

const STATUS_LABELS = {
  queued: 'queued',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  expired: 'expired',
};

const CONSOLE_LIMIT = 200;

function now() {
  return new Date().toISOString();
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateRelativeName(name) {
  if (typeof name !== 'string' || !name || name.length > 180 || name.includes('\0')) {
    throw new Error(`invalid file name: ${String(name)}`);
  }
  if (name.includes('\\') || path.posix.isAbsolute(name)) {
    throw new Error(`file name must be a POSIX relative path: ${name}`);
  }
  const normalized = path.posix.normalize(name);
  if (normalized !== name || normalized === '.' || normalized.startsWith('../') || normalized.includes('/.')) {
    throw new Error(`unsafe file name: ${name}`);
  }
  const base = path.posix.basename(name);
  if (base.startsWith('.') || base.toLowerCase() === '.env' || base.toLowerCase() === '.gitignore') {
    throw new Error(`hidden file is not allowed: ${name}`);
  }
  const ext = path.posix.extname(name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`file type is not allowed: ${name}`);
  }
  return normalized;
}

export function publicTask(meta, { baseUrl, artifactSuffix = '/output/output.bin' }) {
  const result = {
    taskId: meta.taskId,
    status: meta.status,
    statusLabel: STATUS_LABELS[meta.status] || meta.status,
    phase: meta.phase,
    createdAt: meta.createdAt,
    startedAt: meta.startedAt || null,
    finishedAt: meta.finishedAt || null,
    updatedAt: meta.updatedAt,
    instructionsProvided: meta.instructionsProvided,
    fileCount: meta.fileCount,
    queuePosition: meta.queuePosition ?? null,
    message: meta.message || null,
    error: meta.status === 'failed' ? meta.error : undefined,
  };
  if (meta.status === 'succeeded') {
    result.artifactBytes = meta.artifactBytes;
    result.artifactUrl = `${baseUrl}/tasks/${encodeURIComponent(meta.taskId)}/artifact`;
  }
  if (Array.isArray(meta.console) && meta.console.length) {
    result.console = meta.console.slice(-50);
  }
  return result;
}

export class JobStore {
  constructor({ root, baseUrl, limits, onJobQueued, artifactSuffix = '/output/output.bin' }) {
    this.root = root;
    this.baseUrl = baseUrl;
    this.limits = limits;
    this.onJobQueued = onJobQueued;
    this.artifactSuffix = artifactSuffix;
    this.jobs = new Map();
    this.queue = [];
    this.running = false;
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true });
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const meta = await this.readMeta(entry.name);
        if (meta.status === 'running') {
          meta.status = 'queued';
          meta.phase = 'recovered_after_restart';
          meta.updatedAt = now();
          await this.writeMeta(meta);
        }
        this.jobs.set(meta.taskId, meta);
        if (meta.status === 'queued') this.queue.push(meta.taskId);
      } catch (error) {
        console.error(`[jobs] skip invalid task ${entry.name}: ${error.message}`);
      }
    }
    this.queue.sort((a, b) => this.jobs.get(a).createdAt.localeCompare(this.jobs.get(b).createdAt));
    this.onJobQueued?.();
  }

  async readMeta(taskId) {
    return JSON.parse(await fs.readFile(path.join(this.root, taskId, 'meta.json'), 'utf8'));
  }

  async writeMeta(meta) {
    const directory = path.join(this.root, meta.taskId);
    const temp = path.join(directory, `.meta-${process.pid}-${Date.now()}.tmp`);
    await fs.writeFile(temp, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temp, path.join(directory, 'meta.json'));
  }

  async create(ownerId, { instructions, files, mainFileName } = {}) {
    if (typeof instructions !== 'undefined' && typeof instructions !== 'string') {
      throw new Error('instructions must be a string');
    }
    if (instructions && instructions.length > this.limits.maxInstructions) {
      throw new Error(`instructions exceed ${this.limits.maxInstructions} characters`);
    }
    if (!Array.isArray(files)) files = [];
    if (files.length > this.limits.maxFiles) throw new Error(`too many files; maximum is ${this.limits.maxFiles}`);
    if (this.queue.filter((taskId) => this.jobs.get(taskId)?.ownerId === ownerId).length >= this.limits.maxQueuedPerOwner) {
      throw new Error('owner queue limit reached');
    }

    const taskId = crypto.randomUUID();
    const taskRoot = path.join(this.root, taskId);
    await Promise.all([
      path.join(taskRoot, 'input'),
      path.join(taskRoot, 'workspace'),
      path.join(taskRoot, 'output'),
    ].map((directory) => fs.mkdir(directory, { recursive: true, mode: 0o700 })));

    let totalBytes = 0;
    const storedFiles = [];
    for (const file of files) {
      if (!file || typeof file.name !== 'string' || typeof file.contentBase64 !== 'string') {
        throw new Error('each file needs name and contentBase64');
      }
      const name = validateRelativeName(file.name);
      let content;
      try {
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(file.contentBase64) || file.contentBase64.length % 4 !== 0) {
          throw new Error('invalid base64');
        }
        content = Buffer.from(file.contentBase64, 'base64');
        if (content.toString('base64') !== file.contentBase64) throw new Error('invalid base64');
      } catch {
        throw new Error(`invalid base64 file: ${name}`);
      }
      if (!content.length) throw new Error(`empty file is not allowed: ${name}`);
      if (content.length > this.limits.maxFileBytes) throw new Error(`file exceeds limit: ${name}`);
      totalBytes += content.length;
      if (totalBytes > this.limits.maxTotalBytes) throw new Error('total upload size exceeds limit');
      const destination = path.resolve(path.join(taskRoot, 'input'), name);
      if (!isWithin(path.join(taskRoot, 'input'), destination)) throw new Error(`unsafe destination: ${name}`);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.writeFile(destination, content, { flag: 'wx', mode: 0o600 });
      storedFiles.push({ name, bytes: content.length });
    }

    const meta = {
      taskId,
      ownerId,
      taskRoot,
      status: 'queued',
      phase: 'queued',
      createdAt: now(),
      updatedAt: now(),
      startedAt: null,
      finishedAt: null,
      instructionsProvided: Boolean(instructions?.trim()),
      instructions: instructions || '',
      mainFileName: mainFileName || null,
      files: storedFiles,
      fileCount: storedFiles.length,
      totalInputBytes: totalBytes,
      artifactBytes: null,
      error: null,
      attempt: 0,
      console: [],
      message: null,
      sessionId: null,
    };
    await this.writeMeta(meta);
    this.jobs.set(taskId, meta);
    this.queue.push(taskId);
    meta.queuePosition = this.queuePosition(taskId);
    await this.writeMeta(meta);
    this.onJobQueued?.();
    return publicTask(meta, this);
  }

  artifactPath(taskId) {
    const meta = this.jobs.get(taskId);
    if (!meta) return null;
    return path.join(meta.taskRoot, this.artifactSuffix);
  }

  list(ownerId, taskId, limit = 20, options = {}) {
    const max = Math.min(Math.max(Number(limit) || 20, 1), this.limits.maxList);
    const offset = Math.max(Number(options.offset) || 0, 0);
    const status = options.status && String(options.status).trim();
    const scope = options.scope && String(options.scope).trim();
    const active = new Set(['queued', 'running']);
    const records = [...this.jobs.values()]
      .filter((meta) => meta.ownerId === ownerId && (!taskId || meta.taskId === taskId))
      .filter((meta) => !status || meta.status === status)
      .filter((meta) => scope !== 'active' || active.has(meta.status))
      .filter((meta) => scope !== 'history' || !active.has(meta.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(offset, offset + max);
    return records.map((meta) => publicTask(meta, this));
  }

  stats(ownerId) {
    const own = [...this.jobs.values()].filter((meta) => meta.ownerId === ownerId);
    const counts = {
      total: own.length,
      queued: own.filter((meta) => meta.status === 'queued').length,
      running: own.filter((meta) => meta.status === 'running').length,
      succeeded: own.filter((meta) => meta.status === 'succeeded').length,
      failed: own.filter((meta) => meta.status === 'failed').length,
      expired: own.filter((meta) => meta.status === 'expired').length,
    };
    return {
      ownerId,
      counts,
      active: counts.queued + counts.running,
      history: counts.succeeded + counts.failed + counts.expired,
      latestCreatedAt: own.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.createdAt || null,
    };
  }

  check(ownerId, { service = 'claude-fleet-server', version = '0.1.0', pollTool = 'task_list' } = {}) {
    const own = [...this.jobs.values()].filter((meta) => meta.ownerId === ownerId);
    return {
      service,
      version,
      ownerId,
      capabilities: ['check', 'create', 'list', 'download'],
      mode: 'asynchronous-polling',
      limits: this.limits,
      queue: {
        queued: own.filter((meta) => meta.status === 'queued').length,
        running: own.filter((meta) => meta.status === 'running').length,
        succeeded: own.filter((meta) => meta.status === 'succeeded').length,
        failed: own.filter((meta) => meta.status === 'failed').length,
      },
      pollTool,
      pollSuggestion: `Poll ${pollTool}(taskId) every 5-10 seconds until succeeded or failed.`,
    };
  }

  async update(taskId, patch) {
    const meta = this.jobs.get(taskId);
    if (!meta) throw new Error('task not found');
    Object.assign(meta, patch, { updatedAt: now() });
    await this.writeMeta(meta);
    return meta;
  }

  async appendConsole(taskId, entry) {
    const meta = this.jobs.get(taskId);
    if (!meta) return;
    if (!Array.isArray(meta.console)) meta.console = [];
    meta.console.push({
      at: now(),
      phase: entry.phase || meta.phase || 'step',
      message: String(entry.message ?? '').slice(0, 400),
      ...(entry.tools ? { tools: entry.tools } : {}),
    });
    if (meta.console.length > CONSOLE_LIMIT) meta.console = meta.console.slice(-CONSOLE_LIMIT);
    if (entry.message) meta.message = String(entry.message).slice(0, 800);
    meta.updatedAt = now();
    await this.writeMeta(meta);
  }

  getInternal(taskId) {
    return this.jobs.get(taskId) || null;
  }

  async cleanup(lowDiskFreeBytes = 0) {
    const cutoff = Date.now() - this.limits.retentionMs;
    let diskPressure = false;
    let freeBytes = Infinity;
    if (lowDiskFreeBytes > 0) {
      try {
        const stats = await fs.statfs(this.root);
        freeBytes = stats.bavail * stats.bsize;
        diskPressure = freeBytes < lowDiskFreeBytes;
      } catch {
        diskPressure = false;
      }
    }
    for (const meta of this.jobs.values()) {
      if (!TERMINAL.has(meta.status)) continue;
      const reachedCutoff = Date.parse(meta.finishedAt || meta.updatedAt) <= cutoff;
      if (!reachedCutoff && !diskPressure) continue;
      await fs.rm(path.join(this.root, meta.taskId), { recursive: true, force: true });
      meta.status = 'expired';
      meta.phase = 'expired';
      this.jobs.delete(meta.taskId);
    }
    if (diskPressure) {
      console.warn(`[cleanup] disk pressure: free ${Math.round(freeBytes / 1024 / 1024)} MiB; expired terminal tasks early`);
    }
  }

  queuePosition(taskId) {
    const index = this.queue.indexOf(taskId);
    return index < 0 ? null : index + 1;
  }
}

export { validateRelativeName };