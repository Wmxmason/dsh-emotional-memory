import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryEngine, DEFAULTS, cleanup, renderContext } from '../lib/engine.js';
import { DAY } from '../lib/policy.js';
import { MemoryStore, emptyState } from '../lib/store.js';
import { fixture } from './helpers.js';

const START = Date.UTC(2026, 9, 27, 4);
function session(texts, id = 'qq-alice') {
  return { id, header: {}, snapshotEvents() { return this.events; }, events: texts.map((text, seq) => ({ seq, time: START + seq,
    type: 'user/message', data: { source: { kind: 'user', plugin: 'im-qqbot' }, content: [{ type: 'text', text }] } })) };
}

function plainSession(texts, id = 'harness-ui') {
  return { id, header: {}, snapshotEvents() { return this.events; }, events: texts.map((text, seq) => ({ seq, time: START + seq,
    type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })) };
}
function response(input, kind = 'routine') {
  const payload = JSON.parse(input);
  const first = payload.observations.find((item) => item.role === 'user');
  return JSON.stringify({ ops: first ? [{ op: 'add', content: first.text.slice(0, 500), kind,
    emotion: kind === 'emotional' ? 1 : 0, importance: 0.5, confidence: 1,
    topic: first.text.slice(0, 40), keywords: [{ text: first.text.slice(0, 40), sourceIds: [first.id] }],
    sourceIds: [first.id] }] : [], handoff: '' });
}

test('long conversations are processed in complete bounded batches without dropping their beginning', async (t) => {
  const store = await fixture(t);
  let now = START;
  const engine = new MemoryEngine(store, { maxDistillChars: 6000, maxObservationChars: 1000 }, () => now);
  const original = session(['开头的重要约定。' + '聊天内容'.repeat(4000), '最后一句']);
  await engine.capture(original);
  const pending = (await store.load(original.id)).inbox;
  assert.equal(pending.map((item) => item.text).join(''), original.events.map((e) => e.data.content[0].text).join(''));
  now += DAY;
  const seen = [];
  const generate = async (input) => {
    const payload = JSON.parse(input);
    seen.push(...payload.observations.map((item) => item.id));
    assert.ok(input.length < 6000);
    return JSON.stringify({ ops: [], handoff: '' });
  };
  let result;
  do { result = await engine.consolidate(original.id, generate); } while (result.status === 'partial');
  assert.equal(result.status, 'ready');
  assert.deepEqual(seen, pending.map((item) => item.id));
  assert.equal(result.state.inbox.length, 0);
});

test('QQ-only mode ignores unmarked Harness sessions without creating memory files', async (t) => {
  const store = await fixture(t);
  const engine = new MemoryEngine(store, {}, () => START);
  await engine.capture(plainSession(['只在 Harness 界面说的话']));
  assert.deepEqual(await store.list(), []);
  assert.equal(engine.context('harness-ui', 'Harness'), '');
});

test('an empty unidentified session captures its first QQ message when the source becomes known', async (t) => {
  const store = await fixture(t);
  const engine = new MemoryEngine(store, {}, () => START);
  const current = plainSession([], 'late-qq');
  assert.equal(await engine.capture(current), false);
  assert.deepEqual(await store.list(), []);
  current.events = session(['第一条 QQ 消息'], current.id).events;
  assert.equal(await engine.capture(current), true);
  const saved = await store.load(current.id);
  assert.equal(saved.channel, 'qq');
  assert.deepEqual(saved.inbox.map(({ id, text }) => ({ id, text })), [{ id: '0:0', text: '第一条 QQ 消息' }]);
});

test('a late QQ source promotes the whole session and later captures remain idempotent', async (t) => {
  const store = await fixture(t);
  const engine = new MemoryEngine(store, {}, () => START);
  const current = plainSession(['Harness 界面先发的消息'], 'mixed-qq');
  Object.defineProperty(current, 'seq', { get: () => current.events.length });
  assert.equal(await engine.capture(current), false);
  current.events.push({ ...session(['QQ 来源确认消息']).events[0], seq: 1, time: START + 1 });
  assert.equal(await engine.capture(current), true);
  current.events.push({ ...plainSession(['同一会话的后续界面消息']).events[0], seq: 2, time: START + 2 });
  for (let i = 0; i < 3; i++) assert.equal(await engine.capture(current), true);
  current.events.push({ ...session(['后续 QQ 消息']).events[0], seq: 3, time: START + 3 });
  await engine.capture(current);
  await new MemoryEngine(store, {}, () => START).capture(current);
  const saved = await store.load(current.id);
  assert.deepEqual(saved.inbox.map((item) => item.text),
    ['Harness 界面先发的消息', 'QQ 来源确认消息', '同一会话的后续界面消息', '后续 QQ 消息']);
  assert.deepEqual(saved.inbox.map((item) => item.id), ['0:0', '1:0', '2:0', '3:0']);
  assert.equal(saved.lastCapturedSeq, 3);
});

test('a persisted QQ session captures unmarked Harness user messages after restart', async (t) => {
  const store = await fixture(t);
  const resumed = plainSession(['从 Harness 界面继续聊'], 'confirmed-qq');
  await store.update(resumed.id, (state) => { state.channel = 'qq'; });
  const restarted = new MemoryEngine(store, {}, () => START);
  assert.equal(await restarted.capture(resumed), true);
  assert.deepEqual((await store.load(resumed.id)).inbox.map((item) => item.text), ['从 Harness 界面继续聊']);
});

test('an independent Harness session stays excluded from capture and forced daily consolidation', async (t) => {
  const store = await fixture(t);
  const engine = new MemoryEngine(store, {}, () => START);
  const current = plainSession([], 'independent-harness');
  assert.equal(await engine.capture(current), false);
  current.events = plainSession(['普通界面会话消息'], current.id).events;
  for (let i = 0; i < 3; i++) assert.equal(await engine.capture(current), false);
  let modelCalls = 0;
  const result = await engine.consolidate(current.id, async () => { modelCalls++; return '{"ops":[],"handoff":""}'; }, { force: true });
  assert.equal(result.status, 'ignored');
  assert.equal(modelCalls, 0);
  assert.equal(engine.context(current.id, '界面'), '');
  assert.deepEqual(await store.list(), []);
});

test('failed extraction keeps pending input; a fresh engine can finish after restart', async (t) => {
  const store = await fixture(t);
  let now = START;
  const engine = new MemoryEngine(store, {}, () => now);
  await engine.capture(session(['请叫我小林']));
  now += DAY;
  await assert.rejects(engine.consolidate('qq-alice', async () => { throw new Error('provider unavailable'); }));
  assert.equal((await store.load('qq-alice')).inbox.length, 1);
  assert.equal((await store.load('qq-alice')).checkpoint, null);
  const restarted = new MemoryEngine(new MemoryStore(store.root), {}, () => now);
  const result = await restarted.consolidate('qq-alice', async (input) => response(input, 'core'));
  assert.equal(result.state.records[0].content, '请叫我小林');
  await restarted.finish('qq-alice', result.date);
  assert.equal((await store.load('qq-alice')).lastRunDate, '2026-10-28');
});

test('a malformed or invented-source response cannot clear input or alter existing memory', async (t) => {
  const store = await fixture(t);
  const engine = new MemoryEngine(store, {}, () => START);
  await engine.capture(session(['今天很高兴']));
  const before = await store.load('qq-alice');
  await assert.rejects(engine.consolidate('qq-alice', async () => JSON.stringify({
    ops: [{ op: 'add', sourceIds: ['other-user:1'], content: 'invented' }], handoff: '',
  }), { force: true }));
  const after = await store.load('qq-alice');
  assert.deepEqual(after.inbox, before.inbox);
  assert.deepEqual(after.records, before.records);
  assert.equal(after.lastRunDate, before.lastRunDate);
});

test('recall and empty daily整理 do not strengthen a memory or refresh its age', async (t) => {
  const store = await fixture(t);
  let now = START;
  const engine = new MemoryEngine(store, {}, () => now);
  await engine.capture(session(['我很喜欢公园散步']));
  const result = await engine.consolidate('qq-alice', async (input) => response(input, 'core'), { force: true });
  await engine.finish('qq-alice', result.date);
  const record = structuredClone((await store.load('qq-alice')).records[0]);
  for (let i = 0; i < 10; i++) engine.context('qq-alice', '公园');
  now += DAY;
  const next = await engine.consolidate('qq-alice', async () => { throw new Error('No input means no model call'); });
  assert.deepEqual(next.state.records[0], record);
});

test('explicit forgetting removes active and archived copies and pending source data', async (t) => {
  const store = await fixture(t);
  const engine = new MemoryEngine(store, {}, () => START);
  await engine.capture(session(['我很喜欢公园散步']));
  const result = await engine.consolidate('qq-alice', async (input) => response(input), { force: true });
  const id = result.state.records[0].id;
  assert.equal(await engine.forget('qq-alice', id), true);
  const state = await store.load('qq-alice');
  assert.equal(JSON.stringify(state).includes('我很喜欢公园散步'), false);
  assert.equal(state.records.length, 0);
  assert.equal(state.archive.length, 0);
  assert.equal(engine.context('qq-alice', '公园'), '');
});

test('failed capture is retried from the native log without a sequence hole', async (t) => {
  const store = await fixture(t);
  const update = store.update.bind(store);
  let failOnce = true;
  store.update = (...args) => failOnce ? (failOnce = false, Promise.reject(new Error('disk unavailable'))) : update(...args);
  const engine = new MemoryEngine(store, {}, () => START);
  await assert.rejects(engine.capture(session(['first'])));
  await assert.rejects(engine.flush());
  await engine.capture(session(['first', 'second']));
  await engine.flush();
  assert.deepEqual((await store.load('qq-alice')).inbox.map((item) => item.text), ['first', 'second']);
});

test('temporary memories disappear from both active and archive storage after their lifecycle', () => {
  const state = emptyState('scope');
  state.records.push({ id: 'temporary', content: '一次性查询', kind: 'ephemeral', status: 'active',
    emotion: 0, importance: 0, reinforcementCount: 0, createdAt: START, updatedAt: START });
  cleanup(state, START + 5 * DAY, DEFAULTS);
  assert.equal(state.records.length, 0);
  assert.equal(state.archive.length, 1);
  cleanup(state, START + 13 * DAY, DEFAULTS);
  assert.equal(state.archive.length, 0);
});

test('rendered injection stays within the complete budget including labels and metadata', () => {
  const state = emptyState('scope');
  for (let i = 0; i < 20; i++) state.records.push({ id: 'record-' + i, kind: 'core', confidence: 1,
    content: '带有引号的记忆"'.repeat(50), createdAt: START, status: 'active' });
  const text = renderContext(state, '', START, { ...DEFAULTS, injectMaxChars: 800 });
  assert.ok(text.length <= 800);
  assert.doesNotThrow(() => JSON.parse(text.slice(text.indexOf('\n') + 1)));
});

test('forgetting one chunk suppresses all siblings of that event, without matching another event prefix', async (t) => {
  const store = await fixture(t);
  const engine = new MemoryEngine(store, {}, () => START);
  await store.update('scope', (s) => {
    s.channel = 'qq';
    s.records = [{ id: 'forget', content: '要忘记的事实', sourceIds: ['7:0'] }];
    s.inbox = [{ id: '7:0', text: '要忘记' }, { id: '7:100', text: '同源后续片段' }, { id: '70:0', text: '其他事件保留' }];
  });
  await engine.forget('scope', 'forget');
  const state = await store.load('scope');
  assert.deepEqual(state.inbox.map((item) => item.id), ['70:0']);
  assert.deepEqual(state.forgottenEventSeqs, [7]);
});

test('per-run batch limit preserves progress and allows a later run to finish a large backlog', async (t) => {
  const store = await fixture(t);
  const engine = new MemoryEngine(store, { maxDistillChars: 6000, maxObservationChars: 300, maxBatchesPerRun: 1 }, () => START);
  await engine.capture(session(['测试'.repeat(4000)]));
  const count = (await store.load('qq-alice')).inbox.length;
  const noFacts = async () => '{"ops":[],"handoff":""}';
  let result = await engine.consolidate('qq-alice', noFacts, { force: true });
  assert.equal(result.status, 'partial');
  const partial = await store.load('qq-alice');
  assert.ok(partial.inbox.length < count && partial.inbox.length > 0);
  assert.ok(partial.processingDate);
  assert.equal(partial.maintenance.status, 'partial');
  assert.equal(partial.maintenance.reason, 'batch-limit');
  assert.equal(partial.maintenance.processed, count - partial.inbox.length);
  assert.equal(partial.maintenance.batches, 1);
  do { result = await engine.consolidate('qq-alice', noFacts); } while (result.status === 'partial');
  assert.equal(result.status, 'ready');
  assert.equal(result.state.inbox.length, 0);
  assert.equal(result.state.maintenance.phase, 'context-pending');
});

test('an old conversation topic expires without deleting a separately stored unfinished commitment', () => {
  const state = emptyState('scope');
  state.handoff = '两周前的临时话题';
  state.handoffUpdatedAt = START;
  state.records.push({ id: 'promise', content: '尚未完成的承诺', kind: 'commitment', status: 'active',
    createdAt: START, expiresAt: null });
  cleanup(state, START + 15 * DAY, DEFAULTS);
  assert.equal(state.handoff, '');
  assert.equal(state.records.length, 1);
});

test('a concurrent explicit forget invalidates an older model proposal instead of resurrecting its handoff', async (t) => {
  const store = await fixture(t);
  const engine = new MemoryEngine(store, {}, () => START);
  await engine.capture(session(['first fact', 'a later independent message']));
  await store.update('qq-alice', (s) => {
    s.records.push({ id: 'old', content: 'old fact', sourceIds: ['0:0'], level: 6, kind: 'core', status: 'active' });
    s.handoff = 'old fact';
  });
  await assert.rejects(engine.consolidate('qq-alice', async () => {
    await engine.forget('qq-alice', 'old');
    return '{"ops":[],"handoff":"old fact"}';
  }, { force: true }), /changed/);
  assert.equal((await store.load('qq-alice')).handoff, '');
});

test('forget also discards pending assistant echoes while retaining independent user observations', async (t) => {
  const store = await fixture(t);
  const engine = new MemoryEngine(store, {}, () => START);
  await store.update('scope', (s) => {
    s.channel = 'qq';
    s.records = [{ id: 'target', content: 'TARGET', sourceIds: ['7:0'] }];
    s.inbox = [{ id: '7:100', role: 'user', text: 'TARGET' },
      { id: '8:0', role: 'assistant', text: '你刚说了TARGET' },
      { id: '9:0', role: 'user', text: '独立的新事项' }];
  });
  await engine.forget('scope', 'target');
  const state = await store.load('scope');
  assert.deepEqual(state.inbox.map((item) => item.id), ['9:0']);
  assert.ok(state.forgottenEventSeqs.includes(8));
  assert.equal(JSON.stringify(state).includes('TARGET'), false);
});

test('a verified QQ binding captures unmarked QQ 0.5.2 messages across fresh session sequence numbers', async (t) => {
  const store = await fixture(t);
  const scope = 'qq:qqbot:synthetic:c2c:alice';
  const engine = new MemoryEngine(store, {}, () => START);
  await engine.capture(plainSession(['old message'], 'old-session'), scope);
  await engine.capture(plainSession(['new message'], 'new-session'), scope);
  await engine.capture(plainSession(['old message'], 'old-session'), scope);
  const state = await store.load(scope);
  assert.deepEqual(state.inbox.map((item) => item.id), ['old-session:0:0', 'new-session:0:0']);
  assert.equal(state.channel, 'qq');
  assert.equal((await store.list()).length, 1);
});

test('legacy session memory migrates once with its capture cursor and forgotten event identities', async (t) => {
  const store = await fixture(t);
  const scope = 'qq:qqbot:synthetic:c2c:alice';
  await store.update('legacy', (s) => {
    s.records = [{ id: 'kept', content: '稳定偏好', sourceIds: ['0:0'] }];
    s.inbox = [{ id: '1:0', role: 'user', text: 'pending', time: START }];
    s.lastCapturedSeq = 1;
    s.forgottenEventSeqs = [2];
    s.handoff = '继续报告'; s.handoffUpdatedAt = START;
  });
  const original = plainSession(['first', 'pending', 'forgotten', 'next'], 'legacy');
  for (let attempt = 0; attempt < 2; attempt++) {
    const engine = new MemoryEngine(store, {}, () => START);
    await engine.capture(original, scope);
  }
  const state = await store.load(scope);
  assert.deepEqual(state.records[0].sourceIds, ['legacy:0:0']);
  assert.deepEqual(state.inbox.map((item) => item.id), ['legacy:1:0', 'legacy:3:0']);
  assert.equal(state.handoff, '继续报告');
  assert.equal((await store.load('legacy')).redirectedTo, scope);
});

test('forgetting a bound source never suppresses the same sequence number in a new session', async (t) => {
  const store = await fixture(t);
  const scope = 'qq:qqbot:synthetic:c2c:alice';
  const engine = new MemoryEngine(store, {}, () => START);
  const old = plainSession(['TARGET'], 'old');
  await engine.capture(old, scope);
  await store.update(scope, (s) => { s.records.push({ id: 'remove', sourceIds: ['old:0:0'] }); });
  await engine.forget(scope, 'remove');
  await engine.capture(plainSession(['independent'], 'new'), scope);
  await new MemoryEngine(store, {}, () => START).capture(old, scope);
  const state = await store.load(scope);
  assert.deepEqual(state.inbox.map((item) => item.text), ['independent']);
  assert.ok(state.forgottenSourceEvents.includes('old:0'));
});

test('model-switch forks skip inherited history while retaining subsequent messages', async (t) => {
  const store = await fixture(t);
  const scope = 'qq:qqbot:synthetic:c2c:alice';
  const engine = new MemoryEngine(store, {}, () => START);
  await engine.capture(plainSession(['inherited'], 'parent'), scope);
  const child = plainSession(['inherited', 'new fact'], 'child');
  child.header.seedLength = 1;
  await engine.capture(child, scope);
  assert.deepEqual((await store.load(scope)).inbox.map((item) => item.id), ['parent:0:0', 'child:1:0']);
});

test('a handoff and memory together respect the smallest configured injection budget', () => {
  const state = emptyState('budget');
  state.handoff = '交接'.repeat(1500);
  assert.ok(renderContext(state, '', START, { ...DEFAULTS, injectMaxChars: 800 }).length <= 800);
});
