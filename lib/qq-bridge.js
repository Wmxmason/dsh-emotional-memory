import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BRIDGE_KEY = Symbol.for('dsh-emotional-memory.qq-bridge');
const WRAPPED = Symbol.for('dsh-emotional-memory.qq-manager-wrapped');

function state() {
  return { records: new Map(), identities: new Map(), queues: new Map(), installed: false, promise: null };
}

function shared() {
  return globalThis[BRIDGE_KEY] ??= state();
}

async function exclusive(bridge, key, callback) {
  const previous = bridge.queues.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(callback);
  const tail = operation.catch(() => {});
  bridge.queues.set(key, tail);
  try { return await operation; }
  finally { if (bridge.queues.get(key) === tail) bridge.queues.delete(key); }
}

function register(bridge, manager, record) {
  if (!record?.sessionKey || !record?.sessionId) throw new Error('Unsupported QQ session record');
  bridge.identities.set(String(record.sessionId), { manager, key: record.sessionKey });
  bridge.records.set(record.sessionKey, { manager, record });
}

function active(bridge, key) {
  const entry = bridge.records.get(key);
  return entry?.manager.getSessionRecord(entry.record.scope, entry.record.peerId) === entry.record ? entry : undefined;
}

// QQ 0.5.2 swallows PrefsStore write failures. Commit this routing field atomically
// and synchronously so an inbound continuation cannot interleave with the swap.
function commitRoute(manager, key, from, to) {
  const prefs = manager.modelResolver.prefs;
  let saved = {};
  try { saved = JSON.parse(readFileSync(prefs.prefsPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)
    || saved.sessionIds != null && (typeof saved.sessionIds !== 'object' || Array.isArray(saved.sessionIds))) {
    throw new Error('Invalid QQ preferences; routing preserved');
  }
  const persisted = saved.sessionIds?.[key];
  if (persisted && persisted !== from && persisted !== to) throw new Error('QQ route changed during rotation');
  saved.sessionIds = { ...saved.sessionIds, [key]: to };
  mkdirSync(dirname(prefs.prefsPath), { recursive: true });
  const temporary = `${prefs.prefsPath}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(saved, null, 2) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, prefs.prefsPath);
  } finally { rmSync(temporary, { force: true }); }
  prefs.sessionIds.set(key, to);
}

async function rotate(bridge, key, plan, verify) {
  const entry = active(bridge, key);
  if (!entry) return { status: 'not-active' };
  const { manager, record } = entry;
  if (String(record.sessionId) === plan.to) return { status: 'rotated', recovered: true, record };
  if (String(record.sessionId) !== plan.from || record.agent.status !== 'idle') return { status: 'deferred' };
  const composed = await manager.composePreset(record.agentPreset ?? manager.getEffectivePresetByKey(key));
  if (record.agentPreset && composed.agentPreset !== record.agentPreset) throw new Error('QQ preset unavailable; original session retained');
  const route = record.agent.session.requestHeader?.()?.config ?? manager.modelResolver.getEffectiveRoute(key);
  bridge.identities.set(plan.to, { manager, key });
  let created = manager.agents.get(plan.to);
  let handle;
  if (!created) {
    const options = {
      sessionId: plan.to,
      meta: { cwd: record.agent.session.header?.cwd || manager.config.cwd || process.cwd(),
        ...(composed.agentPreset ? { agentPreset: composed.agentPreset } : {}) },
      ...(route ? { agentOptions: route } : {}),
      ...(composed.setup ? { setup: composed.setup } : {}),
    };
    try {
      handle = await manager.agents.resume({ resumeSessionId: plan.to,
        ...(route ? { agentOptions: route } : {}), ...(composed.setup ? { setup: composed.setup } : {}) });
    } catch { handle = await manager.agents.create(options); }
    created = handle.agent;
  }
  try {
    await manager.ctx.get('sessions').flush(created.session);
    if (created.status !== 'idle' || active(bridge, key)?.record !== record
      || String(record.sessionId) !== plan.from || record.agent.status !== 'idle' || !verify()) {
      return { status: 'deferred' };
    }
    commitRoute(manager, key, plan.from, plan.to);
    const next = { ...record, sessionId: plan.to, agent: created,
      handle: handle ?? { agent: created, dispose: async () => {} },
      agentPreset: composed.agentPreset, lastActivity: Date.now() };
    manager.sessions.set(key, next);
    register(bridge, manager, next);
    void record.handle.dispose().catch(() => manager.logger.warn('Memory rotation: previous agent disposal failed'));
    return { status: 'rotated', record: next };
  } finally {
    if (handle && active(bridge, key)?.record?.agent !== created) await handle.dispose();
  }
}

function api(bridge) {
  return {
    scopeForSession(sessionId, parentId) {
      const id = String(sessionId);
      const identity = bridge.identities.get(id) ?? (parentId ? bridge.identities.get(String(parentId)) : undefined);
      if (identity) bridge.identities.set(id, identity);
      return identity ? `qq:${identity.key}` : undefined;
    },
    recordForScope(scope) { return scope?.startsWith('qq:') ? active(bridge, scope.slice(3))?.record : undefined; },
    runExclusive(scope, callback) {
      const key = scope.slice(3);
      return exclusive(bridge, key, () => callback(active(bridge, key)?.record,
        (plan, verify) => rotate(bridge, key, plan, verify)));
    },
  };
}

// This adapter deliberately supports the locally verified QQ 0.5.2 API only.
export function attachQQBridge(SessionManager, bridge = shared()) {
  const proto = SessionManager.prototype;
  for (const method of ['getOrCreate', 'remove', 'rebuildSession', 'sessionKey', 'currentSessionId', 'getSessionRecord', 'composePreset']) {
    if (typeof proto[method] !== 'function') throw new Error('Unsupported QQ session manager');
  }
  if (!proto[WRAPPED]) {
    for (const method of ['getOrCreate', 'remove', 'rebuildSession']) {
      const original = proto[method];
      proto[method] = function (...args) {
        const key = method === 'rebuildSession' ? args[0].sessionKey : this.sessionKey(args[0], args[1]);
        return exclusive(bridge, key, async () => {
          if (method === 'getOrCreate') bridge.identities.set(String(this.currentSessionId(key)), { manager: this, key });
          if (method === 'rebuildSession') {
            const current = this.sessions.get(key);
            if (!current) return;
            args[0] = current;
          }
          const result = await original.apply(this, args);
          const record = this.sessions.get(key);
          if (record) register(bridge, this, record);
          else bridge.records.delete(key);
          return result;
        });
      };
    }
    Object.defineProperty(proto, WRAPPED, { value: true });
  }
  bridge.installed = true;
  return api(bridge);
}

export async function installQQBridge() {
  const bridge = shared();
  if (bridge.installed) return api(bridge);
  return bridge.promise ??= (async () => {
    let entry;
    try { entry = fileURLToPath(import.meta.resolve('@tencent-connect/dsh-qqbot')); }
    catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND') return undefined; throw error; }
    const manifest = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8'));
    if (manifest.version !== '0.5.2') throw new Error('QQ memory rotation requires dsh-qqbot 0.5.2');
    const { SessionManager } = await import(pathToFileURL(join(dirname(entry), 'session', 'session-manager.js')).href);
    return attachQQBridge(SessionManager, bridge);
  })();
}

export function currentQQBridge() { return shared().installed ? api(shared()) : undefined; }
