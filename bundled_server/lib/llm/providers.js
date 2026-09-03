// Provider registry: which real LLM endpoint+protocol the fixed-endpoint proxy
// routes to. Persisted as `data/providers.json`. API keys are stored in plaintext
// ONLY in this file (mode 0600); every outward-facing path masks them.

import fs from 'node:fs/promises';
import path from 'node:path';

export const SECRET_MASK = '***REDACTED***';
const PROVIDER_ID_RE = /^[a-zA-Z0-9_-]{1,32}$/;
const TYPES = new Set(['anthropic', 'openai']);

function now() {
  return new Date().toISOString();
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Masked shape for the panel: prefix + suffix only.
function maskKey(value) {
  const text = String(value || '');
  if (!text || text === SECRET_MASK) return '';
  if (text.length <= 10) return SECRET_MASK;
  return `${text.slice(0, 6)}••••••••${text.slice(-4)}`;
}

export class ProviderStore {
  constructor(file) {
    this.file = file;
    this.data = { activeProviderId: null, providers: {} };
  }

  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (data && typeof data === 'object') {
        this.data = {
          activeProviderId: typeof data.activeProviderId === 'string' ? data.activeProviderId : null,
          providers: data.providers && typeof data.providers === 'object' ? data.providers : {},
        };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`[providers] load: ${error.message}`);
    }
  }

  async persist() {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.file);
    await fs.chmod(this.file, 0o600).catch(() => {});
  }

  /** Masked provider list (no plaintext keys). */
  list() {
    return Object.entries(this.data.providers).map(([id, provider]) => ({
      id,
      type: provider.type,
      baseUrl: provider.baseUrl,
      apiKey: maskKey(provider.apiKey),
      model: provider.model,
      updatedAt: provider.updatedAt,
    }));
  }

  /** Current active mapping (proxy layer, includes plaintext key). */
  getActive() {
    const id = this.data.activeProviderId;
    const provider = id && this.data.providers[id];
    return provider
      ? { id, type: provider.type, baseUrl: provider.baseUrl, apiKey: provider.apiKey || '', model: provider.model }
      : null;
  }

  async setActive(id) {
    if (!this.data.providers[id]) throw new Error('provider not found');
    this.data.activeProviderId = id;
    await this.persist();
    return this.publicState();
  }

  async save(id, def) {
    if (!PROVIDER_ID_RE.test(id)) throw new Error('provider ID must be 1-32 chars of [A-Za-z0-9_-]');
    if (!def || typeof def !== 'object' || Array.isArray(def)) throw new Error('provider config must be an object');
    if (!TYPES.has(def.type)) throw new Error('type must be "anthropic" or "openai"');
    if (typeof def.baseUrl !== 'string' || !/^https?:\/\//.test(def.baseUrl)) throw new Error('baseUrl must be an http(s) URL');
    const model = String(def.model || '').trim();
    if (!model) throw new Error('model is required');

    const previous = this.data.providers[id];
    const apiKey = typeof def.apiKey === 'string' && def.apiKey && def.apiKey !== SECRET_MASK
      ? def.apiKey.trim()
      : previous?.apiKey || '';

    this.data.providers[id] = {
      type: def.type,
      baseUrl: def.baseUrl.replace(/\/+$/, ''),
      apiKey,
      model,
      updatedAt: now(),
    };
    await this.persist();
    return this.publicState();
  }

  async delete(id) {
    if (!this.data.providers[id]) throw new Error('provider not found');
    delete this.data.providers[id];
    if (this.data.activeProviderId === id) this.data.activeProviderId = null;
    await this.persist();
    return this.publicState();
  }

  publicState() {
    return {
      activeProviderId: this.data.activeProviderId,
      providers: this.list(),
      secretMask: SECRET_MASK,
    };
  }
}