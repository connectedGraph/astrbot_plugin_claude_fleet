// Persistent per-owner client key store. Only SHA-256 hashes are kept on disk;
// the plaintext key is returned to the owner exactly once at issue time.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeEqualHex(a, b) {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export class KeyStore {
  constructor(file) {
    this.file = file;
    this.records = new Map(); // ownerId -> { hash, createdAt }
  }

  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      for (const [ownerId, record] of Object.entries(data || {})) {
        if (record && typeof record.hash === 'string' && record.hash.length === 64) {
          this.records.set(ownerId, { hash: record.hash, createdAt: record.createdAt || null });
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`[keystore] load: ${error.message}`);
    }
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const data = Object.fromEntries(this.records.entries());
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  async issue(ownerId) {
    const key = `fk_${crypto.randomBytes(24).toString('base64url')}`;
    const record = { hash: sha256Hex(key), createdAt: new Date().toISOString() };
    this.records.set(ownerId, record);
    await this.save();
    return { key, createdAt: record.createdAt };
  }

  async revoke(ownerId) {
    const removed = this.records.delete(ownerId);
    if (removed) await this.save();
    return removed;
  }

  get(ownerId) {
    return this.records.get(ownerId) || null;
  }

  lookup(token) {
    if (!token || typeof token !== 'string') return null;
    const presented = sha256Hex(token);
    for (const [ownerId, record] of this.records) {
      if (safeEqualHex(presented, record.hash)) return ownerId;
    }
    return null;
  }
}