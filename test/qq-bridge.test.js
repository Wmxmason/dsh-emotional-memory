import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { attachQQBridge } from '../lib/qq-bridge.js';
import { fixture } from './helpers.js';

async function setup(t) {
  const store = await fixture(t);
  const prefsPath = join(store.root, 'model-prefs.json');
  const live = new Map();
  const created = [];
  const disposed = [];
  let blockCreate;
  let failFlush = false;
  class Manager {
    sessions = new Map();
    config = { appId: 'synthetic', cwd: store.root };
    logger = { warn() {} };
    modelResolver = { prefs: { prefsPath, sessionIds: new Map() }, getEffectiveRoute: () => ({ provider: 'fake', model: 'fake' }) };
    agents = {
      get: (id) => live.get(id),
      async resume() { throw new Error('No persisted blank session'); },
      async create(options) {
        await blockCreate?.();
        created.push(options);
        const agent = { status: 'idle', session: { id: options.sessionId, seq: 0, header: options.meta, requestHeader() {}, snapshotEvents: () => [] } };
        live.set(options.sessionId, agent);
        return { agent, async dispose() { live.delete(options.sessionId); disposed.push(options.sessionId); } };
      },
    };
    ctx = { get: () => ({ async flush() { if (failFlush) throw new Error('simulated disk failure'); } }) };
    sessionKey(scope, peer) { return `qqbot:synthetic:${scope}:${peer}`; }
    currentSessionId(key) { return this.modelResolver.prefs.sessionIds.get(key) ?? `old-${key}`; }
    getSessionRecord(scope, peer) { return this.sessions.get(this.sessionKey(scope, peer)); }
    getEffectivePresetByKey() { return 'persona'; }
    async composePreset(id) { return { agentPreset: id, setup: async () => {} }; }
    async rebuildSession(record) { this.rebuilt = record; }
    async remove(scope, peer) {
      const key = this.sessionKey(scope, peer);
      const old = this.sessions.get(key);
      this.sessions.delete(key);
      this.modelResolver.prefs.sessionIds.set(key, 'manual-new');
      await old?.handle.dispose();
    }
    async getOrCreate(scope, peer, senderId, replyTarget) {
      const key = this.sessionKey(scope, peer);
      const existing = this.sessions.get(key);
      if (existing) return existing;
      const sessionId = this.currentSessionId(key);
      const handle = await this.agents.create({ sessionId, meta: { cwd: store.root } });
      const record = { sessionKey: key, sessionId, scope, peerId: peer, senderId, replyTarget,
        agent: handle.agent, handle, agentPreset: 'persona' };
      this.sessions.set(key, record);
      return record;
    }
  }
  const bridge = attachQQBridge(Manager, { records: new Map(), identities: new Map(), queues: new Map() });
  const manager = new Manager();
  const record = await manager.getOrCreate('c2c', 'alice', 'alice', { id: 'reply' });
  const scope = bridge.scopeForSession(record.sessionId);
  const plan = { from: record.sessionId, to: 'new-synthetic', date: '2026-10-27' };
  return { bridge, manager, record, scope, plan, prefsPath, created, disposed,
    setBlock: (value) => { blockCreate = value; }, failFlush: () => { failFlush = true; } };
}

test('rotation creates an empty session with the same preset and durably switches QQ routing', async (t) => {
  const s = await setup(t);
  await writeFile(s.prefsPath, JSON.stringify({ overrides: { unrelated: { model: 'keep' } }, presets: { unrelated: 'keep' } }));
  const result = await s.bridge.runExclusive(s.scope, (_record, rotate) => rotate(s.plan, () => true));
  assert.equal(result.status, 'rotated');
  const options = s.created.at(-1);
  assert.equal(options.seed, undefined);
  assert.equal(options.meta.agentPreset, 'persona');
  assert.equal(typeof options.setup, 'function');
  assert.equal((await s.manager.getOrCreate('c2c', 'alice', 'alice', {})).sessionId, s.plan.to);
  const prefs = JSON.parse(await readFile(s.prefsPath));
  assert.equal(prefs.sessionIds[s.record.sessionKey], s.plan.to);
  assert.equal(prefs.presets.unrelated, 'keep');
  assert.ok(s.disposed.includes(s.plan.from));
  assert.equal(s.bridge.scopeForSession(s.plan.to), s.scope);
  assert.equal(s.bridge.scopeForSession('unrelated'), undefined);
});

test('failed persistence keeps the old agent and routing available', async (t) => {
  const s = await setup(t);
  s.failFlush();
  await assert.rejects(s.bridge.runExclusive(s.scope, (_record, rotate) => rotate(s.plan, () => true)), /disk/);
  assert.equal(s.bridge.recordForScope(s.scope), s.record);
  assert.equal(s.manager.currentSessionId(s.record.sessionKey), s.plan.from);
  assert.equal(s.disposed.includes(s.plan.from), false);
});

test('an inactive QQ scope has no record and its exclusive rotation reports not-active', async (t) => {
  const s = await setup(t);
  const inactiveScope = `${s.scope}-inactive`;
  assert.equal(s.bridge.recordForScope(inactiveScope), undefined);
  let callbackRecord = Symbol('not-called');
  const result = await s.bridge.runExclusive(inactiveScope, async (record, rotate) => {
    callbackRecord = record;
    return rotate({ from: 'old-inactive', to: 'new-inactive', date: '2026-10-29' }, () => true);
  });
  assert.equal(callbackRecord, undefined);
  assert.deepEqual(result, { status: 'not-active' });
});

test('corrupt QQ preferences are preserved and prevent the route swap', async (t) => {
  const s = await setup(t);
  await writeFile(s.prefsPath, '{broken');
  await assert.rejects(s.bridge.runExclusive(s.scope, (_record, rotate) => rotate(s.plan, () => true)));
  assert.equal(await readFile(s.prefsPath, 'utf8'), '{broken');
  assert.equal(s.bridge.recordForScope(s.scope), s.record);
});

test('incoming getOrCreate waits for rotation and receives the newly committed session', async (t) => {
  const s = await setup(t);
  let entered;
  let release;
  const entering = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  s.setBlock(async () => { entered(); await gate; });
  const rotating = s.bridge.runExclusive(s.scope, (_record, rotate) => rotate(s.plan, () => true));
  await entering;
  let received = false;
  const inbound = s.manager.getOrCreate('c2c', 'alice', 'alice', {}).then((record) => { received = true; return record; });
  await Promise.resolve();
  assert.equal(received, false);
  release();
  assert.equal((await rotating).status, 'rotated');
  assert.equal((await inbound).sessionId, s.plan.to);
});

test('a final history change defers rotation and keeps the previous session intact', async (t) => {
  const s = await setup(t);
  const result = await s.bridge.runExclusive(s.scope, (_record, rotate) => rotate(s.plan, () => false));
  assert.equal(result.status, 'deferred');
  assert.equal(s.bridge.recordForScope(s.scope), s.record);
  assert.equal(s.disposed.includes(s.plan.from), false);
});

test('a committed journal can be retried without creating a second new session', async (t) => {
  const s = await setup(t);
  await s.bridge.runExclusive(s.scope, (_record, rotate) => rotate(s.plan, () => true));
  const count = s.created.length;
  const result = await s.bridge.runExclusive(s.scope, (_record, rotate) => rotate(s.plan, () => true));
  assert.equal(result.recovered, true);
  assert.equal(s.created.length, count);
});

test('a model rebuild queued behind rotation re-resolves the current record before using it', async (t) => {
  const s = await setup(t);
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const entering = new Promise((resolve) => { entered = resolve; });
  s.setBlock(async () => { entered(); await gate; });
  const rotating = s.bridge.runExclusive(s.scope, (_record, rotate) => rotate(s.plan, () => true));
  await entering;
  const rebuilding = s.manager.rebuildSession(s.record, { route: { provider: 'new', model: 'new' } });
  release();
  await rotating;
  await rebuilding;
  assert.equal(s.manager.rebuilt.sessionId, s.plan.to);
  assert.notEqual(s.manager.rebuilt, s.record);
});
