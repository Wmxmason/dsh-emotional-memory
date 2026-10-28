import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function emptyState(scope) {
  return {
    version: 1, scope, channel: null, records: [], inbox: [], archive: [], forgottenEventSeqs: [],
    lastCapturedSeq: -1, lastRunDate: null, processingDate: null, handoff: '', handoffUpdatedAt: 0,
    checkpoint: null, route: null, forgetNoticePending: false, revision: 0,
    redirectedTo: null, redirectedAt: 0, captureCursors: {}, forgottenSourceEvents: [],
    rotation: null, lastRotationDate: null, maintenance: null,
    memoryModeVersion: 0, modeActivatedAt: null, lastKeywordCleanupAt: null, topicPromotions: {},
  };
}

export function scopeFileName(scope) {
  return `${createHash('sha256').update(scope).digest('hex')}.json`;
}

function validate(value, scope) {
  if (value?.version !== 1 || value.scope !== scope
    || !['records', 'inbox', 'archive'].every((key) => Array.isArray(value[key]))) {
    throw new Error('Invalid memory state; the existing file was preserved');
  }
  if (value.channel != null && !['qq', 'generic'].includes(value.channel)) {
    throw new Error('Invalid memory channel; the existing file was preserved');
  }
  return { ...emptyState(scope), ...value };
}

// A Desktop host is the single writer. Mutations in that host are serialized per scope.
export class MemoryStore {
  constructor(root) {
    this.root = root;
    this.scopesDir = join(root, 'scopes');
    this.locks = new Map();
  }

  fileFor(scope) { return join(this.scopesDir, scopeFileName(scope)); }

  async load(scope) {
    try {
      return validate(JSON.parse(await readFile(this.fileFor(scope), 'utf8')), scope);
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState(scope);
      throw error;
    }
  }

  async save(state) {
    const file = this.fileFor(state.scope);
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(state) + '\n', 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async update(scope, mutator) {
    const previous = this.locks.get(scope) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const state = await this.load(scope);
      const result = await mutator(state);
      await this.save(state);
      return result ?? state;
    });
    const tail = operation.catch(() => {});
    this.locks.set(scope, tail);
    try {
      return await operation;
    } finally {
      if (this.locks.get(scope) === tail) this.locks.delete(scope);
    }
  }

  async flush() { await Promise.all([...this.locks.values()]); }

  async list(onError = () => {}) {
    let names;
    try { names = await readdir(this.scopesDir); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const states = [];
    for (const name of names.filter((item) => item.endsWith('.json'))) {
      try {
        const value = JSON.parse(await readFile(join(this.scopesDir, name), 'utf8'));
        if (typeof value.scope !== 'string' || scopeFileName(value.scope) !== name) {
          throw new Error('Memory scope/file identity mismatch');
        }
        states.push(validate(value, value.scope));
      } catch (error) { onError(name, error); }
    }
    return states;
  }

  static fromConfig(config) {
    return new MemoryStore(config.storageDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'emotional-memory'));
  }
}
