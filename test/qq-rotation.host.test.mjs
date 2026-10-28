import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { Session } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { apply } from '../lib/index.js';
import { installQQBridge } from '../lib/qq-bridge.js';
import { fixture } from './helpers.js';

async function setup(t) {
  const store = await fixture(t);
  const { SessionManager } = await import(pathToFileURL(join(process.env.DSH_QQ_ROOT, 'dist/session/session-manager.js')).href);
  const bridge = await installQQBridge();
  const handlers = new Map();
  const definitions = new Map();
  const effects = [];
  const contexts = [];
  const live = new Map();
  const persisted = new Map();
  const prefsPath = join(store.root, 'qq-prefs.json');
  const sessionIds = new Map();
  const mounted = [];
  let calls = 0;
  let failModel = false;
  let rawResponse;
  let finishKind = 'stop';
  let rejectFlush;
  const ctx = {
    logger: { warn() {}, info() {} },
    sessions: { async flush(session) { if (rejectFlush?.(session)) throw new Error('synthetic flush failure'); persisted.set(String(session.id), session); } },
    agents: { get: (id) => live.get(String(id)), roots: () => [],
      async create(options) {
        const session = Session.create(options.sessionId, options.seed,
          { ...Session.create(options.sessionId).header, ...options.meta });
        return mount(session, options);
      },
      async resume(options) {
        const session = persisted.get(String(options.resumeSessionId));
        if (!session) throw new Error('Not persisted');
        return mount(session, options);
      },
    },
    tools: { register(definition) { definitions.set(definition.name, definition); } },
    systemPrompt: { context(context) { contexts.push(context); } },
    on(event, listener) { handlers.set(event, listener); },
    effect(factory) { effects.push(factory()); },
    get(service) {
      if (service === 'sessions') return this.sessions;
      if (service === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'synthetic', model: 'fake' }) };
      if (service === 'agentPresets') return {
        resolve: async (id) => ({ id: id ?? 'qq-persona' }),
        mount: async (_ctx, id) => { mounted.push(id); },
      };
    },
    llm: { async *stream(options) {
      calls++;
      if (failModel) throw failModel instanceof Error ? failModel : new Error('synthetic model failure');
      const input = JSON.parse(options.messages[0].content[0].text);
      const source = input.observations.find((item) => item.role === 'user');
      yield { type: 'text-delta', index: 0, text: rawResponse ?? JSON.stringify({ ops: source ? [{ op: 'add', content: '用户叫小林',
        kind: 'core', confidence: 1, importance: 1, emotion: 0.5, sourceIds: [source.id] }] : [], handoff: '明天继续画画' }) };
      yield { type: 'finish', reason: { kind: finishKind } };
    } },
  };
  async function mount(session, options) {
    const agent = { session, status: 'idle', cancel() {},
      async runMaintenance(job) {
        if (this.status !== 'idle') throw new Error('busy');
        this.status = 'running';
        try { return await job(new AbortController().signal); } finally { this.status = 'idle'; }
      },
    };
    live.set(String(session.id), agent);
    if (options.setup) await options.setup(ctx);
    await handlers.get('agent/created')?.({ agent });
    return { agent, async dispose() { live.delete(String(session.id)); } };
  }
  // Use the real QQ implementation without constructing its real-user PrefsStore.
  const manager = Object.assign(Object.create(SessionManager.prototype), {
    sessions: new Map(), ctx, agents: ctx.agents, logger: ctx.logger,
    config: { appId: store.root, cwd: store.root, preset: 'qq-persona' },
    modelResolver: {
      prefs: { prefsPath, sessionIds },
      getSessionId: (key) => sessionIds.get(key),
      setSessionId(key, id) { sessionIds.set(key, id); writeFileSync(prefsPath, JSON.stringify({ sessionIds: Object.fromEntries(sessionIds) })); },
      getEffectiveRoute: () => ({ provider: 'synthetic', model: 'fake' }),
      getResumeRoute: () => ({ provider: 'synthetic', model: 'fake' }), getPreset() {},
    },
  });
  const plugin = apply(ctx, { storageDir: store.root });
  t.after(async () => { for (const dispose of effects) await dispose(); });
  const old = await manager.getOrCreate('c2c', 'alice', 'alice', { id: 'synthetic' });
  old.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: '我叫小林，明天继续画画。' }] }), { surfaceOp: 'append' });
  await handlers.get('agent/pre-step')({ agent: old.agent, messages: old.agent.session.deriveMessages() }, () => {});
  const scope = bridge.scopeForSession(old.sessionId);
  return { ...plugin, manager, old, scope, store, contexts, definitions, mounted, handlers, persisted, live,
    ctx, async disposeEffects() { for (const dispose of effects.splice(0)) await dispose(); },
    calls: () => calls, failModel: (value) => { failModel = value; }, rejectFlush: (value) => { rejectFlush = value; },
    modelResponse: (value, finish = 'stop') => { rawResponse = value; finishKind = finish; } };
}

const hostTest = process.env.DSH_QQ_ROOT ? test : test.skip;

hostTest('real QQ 0.5.2 manager routes to a fresh native session with inherited memory and preset', async (t) => {
  const s = await setup(t);
  const before = s.old.agent.session.snapshotEvents();
  const result = await s.runScope(s.scope, true);
  assert.equal(result.status, 'complete');
  assert.notEqual(result.newSessionId, s.old.sessionId);
  const next = await s.manager.getOrCreate('c2c', 'alice', 'alice', { id: 'next' });
  assert.equal(next.sessionId, result.newSessionId);
  assert.equal(next.agent.session.deriveMessages().length, 0);
  assert.deepEqual(s.old.agent.session.snapshotEvents(), before);
  assert.equal(next.agentPreset, 'qq-persona');
  assert.deepEqual(s.mounted, ['qq-persona', 'qq-persona']);
  const injected = s.contexts[0].text({ agent: next.agent });
  assert.ok(injected.includes('小林') && injected.includes('画画'));
  const saved = await s.store.load(s.scope);
  assert.equal(saved.rotation, null);
  assert.ok(saved.lastRotationDate);
  const calls = s.calls();
  assert.equal((await s.runScope(s.scope)).status, 'up-to-date');
  assert.equal(s.calls(), calls);
  const other = await s.manager.getOrCreate('c2c', 'bob', 'bob', {});
  assert.equal(s.contexts[0].text({ agent: other.agent }), '');
});

hostTest('model failure and a busy QQ agent preserve the original session and pending observations', async (t) => {
  const s = await setup(t);
  s.old.agent.status = 'running';
  assert.equal((await s.runScope(s.scope, true)).status, 'deferred');
  assert.equal(s.calls(), 0);
  s.old.agent.status = 'idle';
  s.failModel(true);
  assert.equal((await s.runScope(s.scope, true)).status, 'retry-pending');
  assert.equal(s.manager.getSessionRecord('c2c', 'alice'), s.old);
  assert.ok((await s.store.load(s.scope)).inbox.length);
  s.failModel(false);
  assert.equal((await s.runScope(s.scope, true)).status, 'complete');
});

hostTest('memory tools report the values actually stored, including emotion, importance and reinforcement', async (t) => {
  const s = await setup(t);
  const exec = { agent: s.old.agent };
  const saved = JSON.parse((await s.definitions.get('memory_save').execute({
    content: '测试情绪经历', kind: 'emotional', emotion: 0.8, importance: 0.7,
  }, exec)).text);
  const state = await s.store.load(s.scope);
  const record = state.records.find((item) => item.id === saved.id);
  assert.ok(record);
  assert.equal(saved.emotion, record.emotion);
  assert.equal(saved.importance, record.importance);
  assert.equal(saved.reinforcementCount, record.reinforcementCount);
  assert.equal(saved.createdAt, record.createdAt);
  const searched = JSON.parse((await s.definitions.get('memory_search').execute({ query: '测试情绪' }, exec)).text);
  assert.equal(searched[0].emotion, 0.8);
  assert.equal(searched[0].importance, 0.7);
  assert.equal(searched[0].reinforcementCount, 0);
});

hostTest('status distinguishes agent-busy deferral from timeout retry without exposing provider errors', async (t) => {
  const s = await setup(t);
  const status = async () => JSON.parse((await s.definitions.get('memory_status').execute({}, { agent: s.old.agent })).text);
  s.old.agent.status = 'running';
  await s.runScope(s.scope, true);
  assert.equal((await status()).maintenance.reason, 'agent-busy');
  s.old.agent.status = 'idle';
  const privateError = new Error('synthetic-private-provider-body');
  privateError.name = 'TimeoutError';
  s.failModel(privateError);
  assert.equal((await s.runScope(s.scope, true)).status, 'retry-pending');
  const value = await status();
  assert.equal(value.maintenance.status, 'retry-pending');
  assert.equal(value.maintenance.reason, 'request-timeout');
  assert.equal(value.maintenance.failures, 1);
  assert.ok(value.maintenance.nextRetryAt > Date.now());
  assert.ok(value.processingDate);
  assert.equal(JSON.stringify(value).includes('synthetic-private-provider-body'), false);
  assert.equal((await s.store.load(s.scope)).maintenance.reason, 'request-timeout');
  s.failModel(false);
  assert.equal((await s.runScope(s.scope, true)).status, 'complete');
  assert.equal((await s.store.load(s.scope)).maintenance.status, 'complete');
  assert.equal((await status()).maintenance.nextRetryAt, null);
});

hostTest('another maintenance reservation is deferred without being counted as a model failure', async (t) => {
  const s = await setup(t);
  s.old.agent.runMaintenance = () => { throw new Error('synthetic occupied maintenance reservation'); };
  assert.equal(s.old.agent.status, 'idle');
  const result = await s.runScope(s.scope, true);
  assert.equal(result.status, 'deferred');
  assert.equal(result.reason, 'maintenance-busy');
  assert.equal(s.calls(), 0);
  assert.equal((await s.store.load(s.scope)).maintenance.reason, 'maintenance-busy');
  assert.equal((await s.store.load(s.scope)).inbox.length, 1);
});

hostTest('an admitted retry reports its running phase instead of the previous retry deadline', async (t) => {
  const s = await setup(t);
  s.failModel(new Error('synthetic first failure'));
  await s.runScope(s.scope, true);
  s.failModel(false);
  const stream = s.ctx.llm.stream;
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const waiting = new Promise((resolve) => { entered = resolve; });
  s.ctx.llm.stream = async function* (options) { entered(); await gate; yield* stream(options); };
  const running = s.runScope(s.scope, true);
  try {
    await waiting;
    const status = JSON.parse((await s.definitions.get('memory_status').execute({}, { agent: s.old.agent })).text);
    assert.equal(status.maintenance.running, true);
    assert.equal(status.maintenance.status, 'running');
    assert.equal(status.maintenance.phase, 'consolidating');
    assert.equal(status.maintenance.reason, null);
  } finally { release(); await running; }
});

hostTest('a restart honors a persisted retry deadline and an explicit request can replace an old deferral', async (t) => {
  const s = await setup(t);
  s.failModel(new Error('synthetic failure'));
  await s.runScope(s.scope, true);
  const calls = s.calls();
  await s.disposeEffects();
  const restarted = apply(s.ctx, { storageDir: s.store.root });
  try {
    assert.equal((await restarted.runScope(s.scope)).status, 'retry-pending');
    await restarted.tick();
    assert.equal(s.calls(), calls);
    s.old.agent.status = 'running';
    assert.equal((await restarted.runScope(s.scope, true)).reason, 'agent-busy');
    s.old.agent.status = 'idle';
    await s.definitions.get('memory_run_daily').execute({}, { agent: s.old.agent });
    const status = JSON.parse((await s.definitions.get('memory_status').execute({}, { agent: s.old.agent })).text);
    assert.equal(status.maintenance.status, 'queued');
    assert.equal(status.maintenance.nextRetryAt, null);
    assert.equal(status.maintenance.requested, true);
  } finally { await s.disposeEffects(); }
});

hostTest('a queued manual request survives restart even when the daily date is already current', async (t) => {
  const s = await setup(t);
  await s.definitions.get('memory_run_daily').execute({}, { agent: s.old.agent });
  assert.equal((await s.store.load(s.scope)).maintenance.force, true);
  await s.disposeEffects();
  const restarted = apply(s.ctx, { storageDir: s.store.root });
  try {
    assert.equal((await restarted.runScope(s.scope)).status, 'complete');
    assert.equal(s.calls(), 1);
    assert.equal((await s.store.load(s.scope)).maintenance.force, false);
  } finally { await s.disposeEffects(); }
});

for (const [reason, response, finish] of [
  ['invalid-model-json', 'invalid-json', 'stop'],
  ['invalid-source', '{"ops":[{"op":"add","sourceIds":["invented"]}],"handoff":""}', 'stop'],
  ['model-truncated', '{"ops":[],"handoff":""}', 'max-tokens'],
]) {
  hostTest(`status reports ${reason} and retains the pending input`, async (t) => {
    const s = await setup(t);
    s.modelResponse(response, finish);
    assert.equal((await s.runScope(s.scope, true)).reason, reason);
    const value = JSON.parse((await s.definitions.get('memory_status').execute({}, { agent: s.old.agent })).text);
    assert.equal(value.maintenance.reason, reason);
    assert.equal(value.maintenance.phase, 'consolidating');
    assert.equal(value.pending, 1);
    assert.equal(s.manager.getSessionRecord('c2c', 'alice').sessionId, s.old.sessionId);
  });
}

hostTest('new-session flush failure leaves the previous QQ route intact and retries the same journal ID', async (t) => {
  const s = await setup(t);
  s.rejectFlush((session) => String(session.id) !== String(s.old.sessionId));
  assert.equal((await s.runScope(s.scope, true)).status, 'retry-pending');
  const pending = await s.store.load(s.scope);
  assert.ok(pending.rotation && pending.records.length);
  assert.equal(s.manager.getSessionRecord('c2c', 'alice'), s.old);
  s.rejectFlush(undefined);
  const retried = await s.runScope(s.scope, true);
  assert.equal(retried.status, 'complete');
  assert.equal(retried.newSessionId, pending.rotation.to);
});

hostTest('a crash after routing commit finishes the memory journal without rotating twice', async (t) => {
  const s = await setup(t);
  const finish = s.engine.finish.bind(s.engine);
  s.engine.finish = async () => { throw new Error('synthetic interrupted finish'); };
  assert.equal((await s.runScope(s.scope, true)).status, 'retry-pending');
  const next = s.manager.getSessionRecord('c2c', 'alice');
  assert.notEqual(next.sessionId, s.old.sessionId);
  const calls = s.calls();
  s.engine.finish = finish;
  const recovered = await s.runScope(s.scope);
  assert.equal(recovered.recovered, true);
  assert.equal(s.manager.getSessionRecord('c2c', 'alice').sessionId, next.sessionId);
  assert.equal(s.calls(), calls);
  assert.equal((await s.store.load(s.scope)).rotation, null);
});

hostTest('QQ /new keeps peer memory and new numeric event sequences are captured independently', async (t) => {
  const s = await setup(t);
  await s.runScope(s.scope, true);
  await s.manager.remove('c2c', 'alice');
  const next = await s.manager.getOrCreate('c2c', 'alice', 'alice', {});
  assert.ok(s.contexts[0].text({ agent: next.agent }).includes('小林'));
  next.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: '今天的新消息' }] }), { surfaceOp: 'append' });
  await s.handlers.get('agent/pre-step')({ agent: next.agent, messages: next.agent.session.deriveMessages() }, () => {});
  const state = await s.store.load(s.scope);
  assert.ok(state.inbox.some((item) => item.text === '今天的新消息' && item.id.startsWith(next.sessionId + ':')));
  assert.equal(state.records.length, 1);
});

hostTest('an unrelated model fork after an uncommitted journal still receives a genuinely fresh session', async (t) => {
  const s = await setup(t);
  s.rejectFlush((session) => String(session.id) !== String(s.old.sessionId));
  assert.equal((await s.runScope(s.scope, true)).status, 'retry-pending');
  const previousPlan = (await s.store.load(s.scope)).rotation;
  const seed = s.old.agent.session.snapshotEvents();
  const id = 'synthetic-model-fork';
  const session = Session.create(id, seed, { ...Session.create(id).header,
    isSeeded: true, parentSession: s.old.sessionId }, seed.length);
  const agent = { ...s.old.agent, session };
  const fork = { ...s.old, sessionId: id, agent, handle: { agent, async dispose() {} } };
  s.manager.sessions.set(s.old.sessionKey, fork);
  s.manager.modelResolver.setSessionId(s.old.sessionKey, id);
  await s.manager.getOrCreate('c2c', 'alice', 'alice', {});
  await s.handlers.get('agent/created')({ agent });
  s.rejectFlush(undefined);
  const result = await s.runScope(s.scope, true);
  assert.equal(result.status, 'complete');
  assert.notEqual(result.newSessionId, id);
  assert.notEqual(result.newSessionId, previousPlan.to);
  assert.equal(s.manager.getSessionRecord('c2c', 'alice').agent.session.deriveMessages().length, 0);
  assert.equal((await s.store.load(s.scope)).inbox.length, 0);
});
