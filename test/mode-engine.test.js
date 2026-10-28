import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryEngine, DEFAULTS, cleanup, needsKeywordCleanup, observations } from '../lib/engine.js';
import { initializeRecord } from '../lib/lifecycle.js';
import { DAY, scheduleDate } from '../lib/policy.js';
import { fixture } from './helpers.js';

const START = Date.UTC(2026, 9, 28, 4);
const scope = 'qq:qqbot:synthetic:c2c:alice';
function chat(messages, id = 'chat') {
  return { id, header: {}, get seq() { return this.events.length; }, snapshotEvents() { return this.events; },
    events: messages.map(([time, text], seq) => ({ seq, time, type: 'user/message',
      data: { source: { kind: 'user', plugin: 'im-qqbot' }, content: [{ type: 'text', text }] } })) };
}

function fact(sources, overrides = {}) {
  const value = { op: 'add', content: '设备维修经历', kind: 'routine', emotion: 0, importance: 0.5, confidence: 1,
    topic: '设备维修', sourceIds: sources.map((source) => source.id),
    keywords: [{ text: '维修', sourceIds: sources.map((source) => source.id) }], ...overrides };
  if (value.op === 'reinforce') for (const key of ['content', 'kind', 'emotion', 'importance', 'confidence']) delete value[key];
  return value;
}

function migration(input) {
  return JSON.stringify({ memories: input.memories.map((record) => ({ id: record.id, topic: '旧事件' + record.id,
    keywords: ['旧关键词'], kind: 'routine', emotion: 0, importance: 0.5, confidence: 1 })) });
}

test('three independent mentions on the first business day seed level two in a single daily batch', async (t) => {
  const store = await fixture(t);
  const engine = new MemoryEngine(store, {}, () => START + 4 * 3600000);
  await engine.capture(chat([[START, '这次设备维修'], [START + 1000, '维修又有进展'], [START + 2000, '再说说维修']] ), scope);
  const result = await engine.consolidate(scope, async (raw) => {
    const input = JSON.parse(raw);
    return JSON.stringify({ ops: [fact(input.observations)], handoff: '' });
  }, { force: true });
  const record = result.state.records[0];
  assert.equal(record.level, 2);
  assert.equal(record.mentionCount, 3);
  assert.equal(record.levelHits, 0);
  assert.equal(record.expiresAt, START + 2000 + 3 * DAY);
  assert.equal(record.keywords.length, 1);
  assert.deepEqual(record.keywords[0].sourceIds, ['chat:0:0', 'chat:1:0', 'chat:2:0']);
});

test('model additions with identical content under different topics retain separate facts and evidence', async (t) => {
  const store = await fixture(t);
  const engine = new MemoryEngine(store, {}, () => START + 1000);
  await engine.capture(chat([[START, '家用设备维修结束'], [START + 1000, '公司设备维修结束']]), scope);
  const result = await engine.consolidate(scope, async (raw) => {
    const input = JSON.parse(raw);
    return JSON.stringify({ ops: input.observations.map((source, index) => fact([source], {
      content: '设备维修结束', topic: index === 0 ? '家用设备' : '公司设备',
    })), handoff: '' });
  }, { force: true });
  assert.equal(result.state.records.length, 2);
  assert.deepEqual(result.state.records.map((record) => record.topic), ['家用设备', '公司设备']);
  assert.deepEqual(result.state.records.map((record) => record.sourceIds), [['chat:0:0'], ['chat:1:0']]);
  assert.deepEqual(result.state.records.map((record) => record.mentionCount), [1, 1]);
});

test('one long user event cannot become three mentions when extracted across batches and a restart', async (t) => {
  const store = await fixture(t);
  const config = { maxObservationChars: 300, maxDistillChars: 6000, maxBatchesPerRun: 1 };
  let engine = new MemoryEngine(store, config, () => START);
  await engine.capture(chat([[START, '维修'.repeat(3000)]]), scope);
  const generate = async (raw) => {
    const input = JSON.parse(raw);
    const existing = input.existing.find((record) => record.content === '设备维修经历');
    return JSON.stringify({ ops: [fact(input.observations.filter((item) => item.role === 'user'),
      existing ? { op: 'reinforce', id: existing.id } : {})], handoff: '' });
  };
  let result = await engine.consolidate(scope, generate, { force: true });
  assert.equal(result.status, 'partial');
  engine = new MemoryEngine(store, config, () => START);
  do { result = await engine.consolidate(scope, generate); } while (result.status === 'partial');
  assert.equal(result.state.records.length, 1);
  assert.equal(result.state.records[0].mentionCount, 1);
  assert.equal(result.state.records[0].level, 1);
  assert.equal(result.state.records[0].keywords[0].mentionCount, 1);
});

test('different events sharing one timestamp are all counted in numeric sequence order', async (t) => {
  const store = await fixture(t);
  const engine = new MemoryEngine(store, {}, () => START);
  await engine.capture(chat(Array.from({ length: 12 }, () => [START, '再次提及维修'])), scope);
  const result = await engine.consolidate(scope, async (raw) => {
    const input = JSON.parse(raw);
    return JSON.stringify({ ops: [fact(input.observations)], handoff: '' });
  }, { force: true });
  assert.equal(result.state.records[0].mentionCount, 12);
  assert.equal(result.state.records[0].level, 2);
});

test('source timestamps out of sequence still count each independent event exactly once', async (t) => {
  const store = await fixture(t);
  const engine = new MemoryEngine(store, {}, () => START + 10000);
  await engine.capture(chat([[START + 5000, '维修甲'], [START + 2000, '维修乙']]), scope);
  const result = await engine.consolidate(scope, async (raw) => JSON.stringify({
    ops: [fact(JSON.parse(raw).observations)], handoff: '',
  }), { force: true });
  assert.equal(result.state.records[0].mentionCount, 2);
  assert.equal(result.state.records[0].createdAt, START + 2000);
});

test('a retention request at the end of a long event applies before later chunks are processed', async (t) => {
  const store = await fixture(t);
  const engine = new MemoryEngine(store, { maxBatchesPerRun: 1, maxObservationChars: 300, maxDistillChars: 6000 }, () => START);
  await engine.capture(chat([[START, '维修的经过。' + '描述'.repeat(3000) + '请保留一年。']]), scope);
  const generate = async (raw) => {
    const input = JSON.parse(raw);
    return JSON.stringify({ ops: [fact(input.observations, input.existing.length
      ? { op: 'reinforce', id: input.existing[0].id } : {})], handoff: '' });
  };
  let result = await engine.consolidate(scope, generate, { force: true });
  assert.equal(result.status, 'partial');
  assert.equal((await store.load(scope)).records[0].level, 5);
  do { result = await engine.consolidate(scope, generate); } while (result.status === 'partial');
  assert.equal(result.state.records[0].mentionCount, 1);
  assert.equal(result.state.records[0].expiresAt, START + 365 * DAY);
});

test('each event carries its own retention request across expiry inside one extraction operation', async (t) => {
  for (const messages of [
    [[START, '维修请保留3天'], [START + 5 * DAY, '再提维修']],
    [[START, '维修的事情'], [START + 5 * DAY, '维修请保留一年']],
  ]) {
    const store = await fixture(t);
    const engine = new MemoryEngine(store, {}, () => START + 5 * DAY);
    await engine.capture(chat(messages), scope);
    const result = await engine.consolidate(scope, async (raw) => JSON.stringify({
      ops: [fact(JSON.parse(raw).observations)], handoff: '',
    }), { force: true });
    const record = result.state.records[0];
    const expected = messages[1][1].includes('一年') ? 5 : 1;
    assert.equal(record.level, expected);
    assert.equal(record.mentionCount, 1);
    assert.equal(record.levelHits, 0);
    assert.equal(record.expiresAt, START + (expected === 5 ? 370 : 6) * DAY);
  }
});

test('delayed on-time mentions survive an earlier unrelated batch and refresh from the user time', async (t) => {
  const store = await fixture(t);
  await store.update(scope, (state) => {
    state.channel = 'qq'; state.memoryModeVersion = 2; state.modeActivatedAt = START; state.lastKeywordCleanupAt = START;
    const record = { id: 'existing', content: '设备维修经历', topic: '设备维修', actor: '', kind: 'routine',
      emotion: 0, status: 'active', sourceIds: ['old:0:0'], createdAt: START, retentionDays: 3 };
    initializeRecord(record, START, { migration: true });
    state.records.push(record);
  });
  const engine = new MemoryEngine(store, { maxBatchesPerRun: 1, maxObservationChars: 800, maxDistillChars: 6000 }, () => START + 5 * DAY);
  await engine.capture(chat([[START + 2 * DAY, '无关内容'.repeat(1600)],
    [START + 2.5 * DAY, '再说一下那次维修']] ), scope);
  const generate = async (raw) => {
    const input = JSON.parse(raw);
    const source = input.observations.find((item) => item.text.includes('那次维修'));
    return JSON.stringify({ ops: source ? [fact([source], { op: 'reinforce', id: 'existing' })] : [], handoff: '' });
  };
  let result = await engine.consolidate(scope, generate, { force: true });
  assert.equal(result.status, 'partial');
  assert.equal((await store.load(scope)).records[0].id, 'existing');
  do { result = await engine.consolidate(scope, generate); } while (result.status === 'partial');
  const record = result.state.records[0];
  assert.equal(record.id, 'existing');
  assert.equal(record.level, 2);
  assert.equal(record.levelHits, 1);
  assert.equal(record.expiresAt, START + 5.5 * DAY);
});

test('legacy migration resumes committed batches and starts new TTL at activation without invented mentions', async (t) => {
  const store = await fixture(t);
  const oldCreated = START - 300 * DAY;
  await store.update(scope, (state) => {
    state.channel = 'qq'; state.lastRunDate = '2026-10-28';
    for (let i = 0; i < 14; i++) state.records.push({ id: 'old-' + i, content: '旧事实' + i,
      kind: i === 0 ? 'commitment' : 'routine', emotion: 0, importance: 0.5, confidence: 1,
      status: 'active', createdAt: oldCreated, lastReinforcedAt: oldCreated,
      reinforcementCount: 9, sourceIds: ['prior:7:0'] });
  });
  let calls = 0;
  const generate = async (raw) => { calls++; return migration(JSON.parse(raw)); };
  let engine = new MemoryEngine(store, { maxBatchesPerRun: 1 }, () => START);
  let result = await engine.consolidate(scope, generate);
  assert.equal(result.status, 'partial');
  const partial = await store.load(scope);
  const committed = partial.records.filter((record) => record.level != null).length;
  assert.ok(committed > 0 && committed < 14);
  engine = new MemoryEngine(store, { maxBatchesPerRun: 1 }, () => START + 1000);
  do { result = await engine.consolidate(scope, generate); } while (result.status === 'partial');
  assert.equal(result.state.records.length, 14);
  for (const record of result.state.records) {
    assert.equal(record.createdAt, oldCreated);
    assert.equal(record.lastReinforcedAt, oldCreated);
    assert.equal(record.reinforcementCount, 9);
    assert.equal(record.mentionCount, 0);
    assert.equal(record.levelHits, 0);
    assert.deepEqual(record.sourceIds, ['prior:7:0']);
    assert.equal(record.expiresAt, record.kind === 'commitment' ? null : record.periodStartedAt + DAY);
    assert.equal(record.periodStartedAt, Number(record.id.slice(4)) < committed ? START : START + 1000);
  }
  assert.equal(result.state.records[0].kind, 'commitment');
  assert.equal(result.state.records[0].level, 6);
  assert.equal(result.state.modeActivatedAt, START);
  assert.equal(result.state.memoryModeVersion, 2);
  await engine.finish(scope, result.date);
  assert.equal((await engine.consolidate(scope, generate)).status, 'up-to-date');
  assert.equal(calls, 2);
});

test('an incomplete migration keeps original records and can retry without overwriting facts', async (t) => {
  const store = await fixture(t);
  const original = { id: 'old', content: '必须保留原事实', kind: 'routine', emotion: 0,
    importance: 0.5, confidence: 1, status: 'active', createdAt: START - 30 * DAY,
    lastReinforcedAt: START - 30 * DAY, sourceIds: ['7:0'] };
  await store.update(scope, (state) => { state.channel = 'qq'; state.records.push(original); });
  const engine = new MemoryEngine(store, {}, () => START);
  await assert.rejects(engine.consolidate(scope, async () => '{"memories":[]}'));
  assert.deepEqual((await store.load(scope)).records, [original]);
  const result = await engine.consolidate(scope, async (raw) => migration(JSON.parse(raw)));
  assert.equal(result.state.records[0].content, original.content);
  assert.equal(result.state.records[0].expiresAt, START + DAY);
});

test('migration infers an explicit old retention request even when the model omits the field', async (t) => {
  const store = await fixture(t);
  await store.update(scope, (state) => {
    state.channel = 'qq';
    state.records.push({ id: 'old', content: '这次维修请保留半个月', kind: 'routine', emotion: 0,
      status: 'active', createdAt: START - 50 * DAY, sourceIds: ['2:0'] });
  });
  const engine = new MemoryEngine(store, {}, () => START);
  const result = await engine.consolidate(scope, async (raw) => migration(JSON.parse(raw)));
  assert.equal(result.state.records[0].level, 4);
  assert.equal(result.state.records[0].expiresAt, START + 30 * DAY);
  assert.equal(result.state.records[0].mentionCount, 0);
});

test('migration counts still-pending earlier user mentions without counting old sources or shortening the new TTL', async (t) => {
  const store = await fixture(t);
  await store.update(scope, (state) => {
    state.channel = 'qq';
    state.records.push({ id: 'old', content: '设备维修经历', kind: 'routine', emotion: 0,
      status: 'active', createdAt: START - 50 * DAY, sourceIds: ['chat:0:0'] });
    state.inbox.push({ id: 'chat:0:0', eventId: 'chat:0', role: 'user', text: '旧来源', time: START - 50 * DAY },
      { id: 'chat:1:0', eventId: 'chat:1', role: 'user', text: '维修的新进展', time: START - DAY });
  });
  const engine = new MemoryEngine(store, {}, () => START);
  const result = await engine.consolidate(scope, async (raw) => {
    const input = JSON.parse(raw);
    return input.mode === 'migration' ? migration(input) : JSON.stringify({
      ops: [fact(input.observations, { op: 'reinforce', id: 'old' })], handoff: '',
    });
  });
  const record = result.state.records[0];
  assert.equal(record.mentionCount, 1);
  assert.equal(record.level, 2);
  assert.equal(record.expiresAt, START + 3 * DAY);
  assert.equal(record.lastMentionedAt, START - DAY);
});

test('forget removes the new topic promotion metadata along with its memory and keyword provenance', async (t) => {
  const store = await fixture(t);
  const engine = new MemoryEngine(store, {}, () => START);
  await engine.capture(chat([[START, '维修甲'], [START + 1, '维修乙'], [START + 2, '维修丙']]), scope);
  const result = await engine.consolidate(scope, async (raw) => JSON.stringify({
    ops: [fact(JSON.parse(raw).observations)], handoff: '',
  }), { force: true });
  assert.equal(Object.keys(result.state.topicPromotions).length, 1);
  await engine.forget(scope, result.state.records[0].id);
  const stored = JSON.stringify(await store.load(scope));
  assert.equal(stored.includes('设备维修'), false);
});

test('a cleanup boundary runs during an otherwise up-to-date business day without a model call', async (t) => {
  const store = await fixture(t);
  const activation = START + 3600000;
  const now = activation + 30 * DAY;
  await store.update(scope, (state) => {
    Object.assign(state, { channel: 'qq', memoryModeVersion: 2, modeActivatedAt: activation,
      lastKeywordCleanupAt: activation, lastRunDate: '2026-11-27' });
    state.records.push({ id: 'kept', content: '维修摘要继续保留', topic: '维修', level: 5, kind: 'routine',
      status: 'active', expiresAt: activation + 365 * DAY, keywords: [{ text: '旧标签', firstSeenAt: activation, lastConfirmedAt: null }] });
  });
  const engine = new MemoryEngine(store, {}, () => now);
  const result = await engine.consolidate(scope, async () => { throw new Error('Cleanup must not use the model'); });
  assert.equal(result.status, 'ready');
  assert.equal(result.state.records[0].content, '维修摘要继续保留');
  assert.deepEqual(result.state.records[0].keywords, []);
  assert.equal(result.state.lastKeywordCleanupAt, now);
});

test('merged session cleanup progress catches up on the scope activation schedule', async (t) => {
  const store = await fixture(t);
  const now = START + 60 * DAY;
  await store.update(scope, (state) => {
    Object.assign(state, { channel: 'qq', memoryModeVersion: 2, modeActivatedAt: START,
      lastKeywordCleanupAt: now, lastRunDate: scheduleDate(now, 4, 0) });
    state.records.push({ id: 'kept', content: '设备维修经历', topic: '维修', level: 5, kind: 'routine',
      status: 'active', expiresAt: START + 365 * DAY, keywords: [
        { text: 'recent', firstSeenAt: START + 55 * DAY, lastConfirmedAt: null },
      ] });
  });
  await store.update('legacy-session', (state) => {
    Object.assign(state, { channel: 'qq', memoryModeVersion: 2,
      modeActivatedAt: START + 10 * DAY, lastKeywordCleanupAt: START + 40 * DAY });
  });
  const engine = new MemoryEngine(store, {}, () => now);
  await engine.bindScope(chat([], 'legacy-session'), scope);
  const merged = await store.load(scope);
  assert.equal(merged.modeActivatedAt, START);
  assert.equal(merged.lastKeywordCleanupAt, START + 40 * DAY);
  assert.equal(needsKeywordCleanup(merged, now), true);
  const result = await engine.consolidate(scope, async () => { throw new Error('Cleanup must not use the model'); });
  assert.equal(result.state.lastKeywordCleanupAt, now);
  assert.deepEqual(result.state.records[0].keywords.map((keyword) => keyword.text), ['recent']);
});

test('correcting a memory kind enters and leaves protected level six consistently', async (t) => {
  const store = await fixture(t);
  let now = START;
  const engine = new MemoryEngine(store, {}, () => now);
  const current = chat([[START, '这是普通维修事件']]);
  await engine.capture(current, scope);
  let result = await engine.consolidate(scope, async (raw) => JSON.stringify({
    ops: [fact(JSON.parse(raw).observations)], handoff: '',
  }), { force: true });
  const id = result.state.records[0].id;
  for (const kind of ['core', 'routine', 'emotional']) {
    now += 1000;
    const event = chat([[now, '纠正记忆分类']]).events[0];
    event.seq = current.events.length;
    current.events.push(event);
    await engine.capture(current, scope);
    result = await engine.consolidate(scope, async (raw) => JSON.stringify({
      ops: [fact(JSON.parse(raw).observations, { op: 'update', id, kind, emotion: kind === 'emotional' ? 0.8 : 0 })], handoff: '',
    }), { force: true });
    assert.equal(result.state.records[0].level, kind === 'core' ? 6 : kind === 'emotional' ? 5 : 1);
    assert.equal(result.state.records[0].expiresAt, kind === 'core' ? null : now + (kind === 'emotional' ? 365 : 1) * DAY);
  }
});

test('QQ 0.5.2 group history and quotations do not count as fresh user text and actors survive chunking', () => {
  const text = '[Chat history begins]\n[小甲 (actor-a)] 旧历史\n\n[Chat history ends]\n[Current message]\n'
    + '- Image: synthetic.png\n\n[Quoted message begins]\n旧引用\n[Quoted message ends]\n[Current message]\n'
    + '[小乙 (actor-b)] 当前发言'.repeat(1);
  const items = observations(chat([[START, text]]).events, -1, 3, 'group-session', true);
  assert.equal(items.map((item) => item.text).join(''), '当前发言');
  assert.ok(items.every((item) => item.actor === 'actor-b' && item.eventId === 'group-session:0'));
  const plain = chat([[START, '[小乙 (actor-b)] 普通用户自己写的标签']]);
  plain.events[0].data.source = { kind: 'user' };
  assert.equal(observations(plain.events, -1, 100)[0].actor, '');
});

test('permanent ordinary events are protected from capacity eviction', async (t) => {
  const store = await fixture(t);
  const state = await store.load(scope);
  state.records = [{ id: 'permanent', content: '永久事件', kind: 'routine', level: 6, status: 'active', importance: 0 },
    { id: 'ordinary', content: '普通事件', kind: 'routine', level: 5, status: 'active', expiresAt: START + 365 * DAY, importance: 1 }];
  cleanup(state, START, { ...DEFAULTS, maxRecords: 1 });
  assert.deepEqual(state.records.map((record) => record.id), ['permanent']);
});
