// Bounded durable request-outcome log for the portable inference broker.
//
// The broker appends one sanitized entry per admitted logical request before
// reservation and one outcome entry after resolution. Entries hold only
// whitelisted bounded fields (id, fixed model, outcome code, integer base-unit
// amounts, peer uid, byte counts). Prompts, tool payloads, endpoints and any
// credential material never enter this log; tests enforce that with a canary
// credential. The log is capped in bytes; when full, appends fail and the
// broker fails closed (no transmission) until an operator rotates the file by
// hand — a bounded artifact can never silently wrap or drop accountability.
// Appends are serialized by the same kernel flock primitive as the budget
// journal (separate directory and lock inode) and fsynced before returning.
import { open, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { runLocked } from './lock.mjs';

const maxLogBytes = 262144; // 256KiB bounded log
const maxLineBytes = 2048;

const outcomes = new Set(['reserved', 'refused', 'completed', 'abandoned']);
const bounded = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const amount = value => value === null || (typeof value === 'string' && /^\d{1,19}$/.test(value));
const digits = value => value === null || (typeof value === 'string' && /^\d{1,19}$/.test(value));

export function sanitizeLogEntry(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('Invalid log entry');
  const out = {
    at: typeof entry.at === 'string' && Number.isFinite(Date.parse(entry.at)) ? entry.at : new Date().toISOString(),
    id: bounded(entry.id) ? entry.id : null,
    model: entry.model === 'private/gpt-oss-120b' ? entry.model : null,
    outcome: outcomes.has(entry.outcome) ? entry.outcome : null,
  };
  if (out.id === null || out.model === null || out.outcome === null) throw new Error('Log entry missing required bounded fields');
  for (const [key, check] of [['code', bounded], ['amount', amount], ['charged', amount], ['bytes', digits], ['uid', v => Number.isSafeInteger(v) && v >= 0 && v < 2 ** 31]]) {
    if (entry[key] !== undefined) {
      if (!check(entry[key])) throw new Error(`Invalid log entry field ${key}`);
      out[key] = entry[key];
    }
  }
  const keys = Object.keys(out).sort();
  if (keys.some(k => !['at', 'id', 'model', 'outcome', 'code', 'amount', 'charged', 'bytes', 'uid'].includes(k))) throw new Error('Unexpected log entry field');
  return out;
}

export class RequestLog {
  constructor(directory) {
    this.directory = resolve(directory);
    this.path = join(this.directory, 'requests.log');
  }

  async append(entry) {
    const clean = sanitizeLogEntry(entry);
    const line = JSON.stringify(clean) + '\n';
    if (Buffer.byteLength(line) > maxLineBytes) throw new Error('Log entry exceeds the per-line bound');
    return runLocked(this.directory, 'requests.flock', async release => {
      let existing = 0;
      try {
        const info = await stat(this.path);
        if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.nlink !== 1) {
          throw new Error('Request log must be an owned private regular file with no hard links');
        }
        existing = info.size;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (existing + Buffer.byteLength(line) > maxLogBytes) {
        throw new Error('Request log is full; rotate it by hand before further inference');
      }
      const file = await open(this.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const check = await file.stat();
        if (!check.isFile() || check.uid !== process.getuid() || (check.mode & 0o077) || check.nlink !== 1) {
          throw new Error('Request log must be an owned private regular file with no hard links');
        }
        await file.write(line);
        await file.sync();
      } finally {
        await file.close().catch(() => {});
      }
    });
  }

  async readAll() {
    let file;
    try {
      file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error('Request log is not a regular file');
      if (info.size > maxLogBytes) throw new Error('Request log exceeds its cap');
      const buffer = Buffer.alloc(info.size);
      await file.read(buffer, 0, info.size, 0);
      return buffer.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    } finally {
      await file.close().catch(() => {});
    }
  }
}
