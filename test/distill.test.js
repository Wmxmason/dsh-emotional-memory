import test from 'node:test';
import assert from 'node:assert/strict';
import { inputFor, migrationInputFor, parseDistillation, parseMigration, requestedRetentionDays } from '../lib/distill.js';

const base = { content: '用户喜欢晨跑', topic: '跑步', keywords: [{ text: '晨跑', sourceIds: ['u:0'] }],
  kind: 'core', emotion: 0, importance: 0.7, confidence: 1, sourceIds: ['u:0'] };

function observation(id, text, { actor = 'qq:alice', time = 10, eventId } = {}) {
  return { id, role: 'user', text, actor, time, eventId: eventId ?? id.slice(0, id.lastIndexOf(':')) };
}

function add(overrides = {}) {
  return { op: 'add', ...base, ...overrides };
}

function parse(op, batch = [observation('u:0', '我喜欢晨跑')], state = { records: [] }, editable) {
  return parseDistillation(JSON.stringify({ ops: [op], handoff: '' }), batch, state, editable);
}

test('topic and keywords rank relevant candidates ahead of old prefix records without merging topic collisions', () => {
  const state = { handoff: '', records: [
    { id: 'old', content: '无关的旧事实', topic: '吃饭', keywords: [{ text: '午餐' }] },
    { id: 'run', content: '另一件日常事实', topic: '跑步', keywords: [{ text: '慢跑' }] },
  ] };
  const input = JSON.parse(inputFor(state, [observation('u:0', '今晚慢跑五公里')], '2026-10-28', 3000));
  assert.equal(input.mode, 'daily');
  assert.equal(input.existing[0].id, 'run');
  const result = parse(add({ content: '同样是跑步，但发生在今天晚上', sourceIds: ['u:0'], keywords: [{ text: '慢跑', sourceIds: ['u:0'] }] }),
    [observation('u:0', '今晚慢跑')], { records: [{ id: 'run', content: '过去的慢跑', topic: '跑步', actor: 'qq:alice' }] });
  assert.equal(result.ops[0].op, 'add');
});

test('sources are event-normalized and reject assistant, forged, and cross-actor evidence', () => {
  const chunks = [observation('event:0', '我喜欢跑步', { eventId: 'event', time: 8 }), observation('event:80', '每周三次', { eventId: 'event', time: 8 })];
  const normalized = parse(add({ sourceIds: ['event:0', 'event:80'], keywords: [{ text: '跑步', sourceIds: ['event:0', 'event:80'] }] }), chunks);
  assert.deepEqual(normalized.ops[0].mentions, [{ id: 'event', time: 8 }]);
  assert.deepEqual(normalized.ops[0].keywords[0].mentions, [{ id: 'event', time: 8 }]);
  assert.throws(() => parse(add({ sourceIds: ['assistant:0'] }), [{ id: 'assistant:0', role: 'assistant', text: '她喜欢跑步', time: 1 }]),
    /Memory operation lacks valid in-scope user evidence/);
  assert.throws(() => parse(add({ sourceIds: ['forged:0'], content: '' }), chunks), /Memory operation lacks valid in-scope user evidence/);
  assert.throws(() => parse(add({ sourceIds: ['event:0', 'other:0'], keywords: [{ text: '跑步', sourceIds: ['event:0'] }] }),
    [...chunks, observation('other:0', '我也跑步', { actor: 'qq:bob', eventId: 'other' })]), /Memory operation lacks valid in-scope user evidence/);
});

test('unknown legacy actors cannot be claimed by named group actors', () => {
  for (const actor of [undefined, '', 'qq:alice']) {
    const state = { records: [{ id: 'legacy', actor }] };
    for (const op of [
      { op: 'reinforce', id: 'legacy', sourceIds: ['u:0'] },
      { ...add(), op: 'update', id: 'legacy' },
      { op: 'archive', id: 'legacy', sourceIds: ['u:0'] },
    ]) {
      assert.throws(() => parse(op, [observation('u:0', '用户发言', { actor: 'qq:bob' })], state),
        /Memory operation lacks valid in-scope user evidence/);
    }
  }
  assert.equal(parse({ op: 'reinforce', id: 'legacy', sourceIds: ['u:0'] },
    [observation('u:0', '私聊确认', { actor: '' })], { records: [{ id: 'legacy' }] }).ops[0].actor, null);
  assert.equal(parse({ op: 'reinforce', id: 'known', sourceIds: ['u:0'] },
    [observation('u:0', '本人确认')], { records: [{ id: 'known', actor: 'qq:alice' }] }).ops[0].actor, 'qq:alice');
});

test('same-millisecond event mentions keep numeric sequence order', () => {
  const ids = Array.from({ length: 12 }, (_, index) => `chat:${index}:0`);
  const batch = ids.map((id, index) => observation(id, `第${index}条`, { eventId: `chat:${index}`, time: 9 }));
  const parsed = parse(add({ sourceIds: ids, keywords: [{ text: '顺序', sourceIds: ids }] }), batch);
  assert.deepEqual(parsed.ops[0].mentions.map((item) => item.id), Array.from({ length: 12 }, (_, index) => `chat:${index}`));
});

test('keywords retain their individual user evidence and sensitive topic or tag is refused', () => {
  const batch = [observation('a:0', '我喜欢咖啡'), observation('b:0', '周末会慢跑', { time: 11, eventId: 'b' })];
  const parsed = parse(add({ sourceIds: ['a:0', 'b:0'], keywords: [{ text: '咖啡', sourceIds: ['a:0'] }, { text: '慢跑', sourceIds: ['b:0'] }] }), batch);
  assert.deepEqual(parsed.ops[0].keywords.map((item) => item.mentions), [[{ id: 'a', time: 10 }], [{ id: 'b', time: 11 }]]);
  assert.throws(() => parse(add({ topic: 'password=hunter2' })), /Credential-like memory refused/);
  assert.throws(() => parse(add({ keywords: [{ text: 'api_key: hidden-value', sourceIds: ['u:0'] }] })), /Credential-like memory refused/);
});

test('daily input remains bounded and only listed candidates are editable when supplied', () => {
  const state = { handoff: '', records: Array.from({ length: 8 }, (_, index) => ({ id: `r${index}`,
    content: '记录'.repeat(80), topic: index === 7 ? '跑步' : '其他', keywords: [{ text: index === 7 ? '慢跑' : '无关' }] })) };
  const input = JSON.parse(inputFor(state, [observation('u:0', '慢跑')], '2026-10-28', 550));
  assert.ok(JSON.stringify(input).length <= 550);
  assert.ok(input.existingIds.includes('r7'));
  const update = { op: 'update', id: 'r0', ...base, sourceIds: ['u:0'] };
  assert.throws(() => parse(update, [observation('u:0', '我喜欢晨跑')], { records: state.records }, input.existing),
    /Memory operation lacks valid in-scope user evidence/);
});

test('migration is bounded, redacted, one-to-one, and cannot change identities', () => {
  const records = [
    { id: 'legacy', content: 'sk-abcdefghijklmnopqrstuvwxyz123456', topic: 'password=hunter2', keywords: [{ text: 'api_key: x' }], kind: 'routine', emotion: 0, importance: 0.5, confidence: 1 },
    { id: 'classified', content: '已有级别', level: 3, kind: 'routine', emotion: 0, importance: 0.5, confidence: 1 },
  ];
  const { input, records: selected } = migrationInputFor({ records }, 3000);
  assert.deepEqual(selected.map((record) => record.id), ['legacy']);
  assert.equal(input.includes('hunter2'), false);
  const raw = JSON.stringify({ memories: [{ id: 'legacy', topic: '安全习惯', keywords: ['凭据'], kind: 'routine', emotion: 0, importance: 0.5, confidence: 1 }] });
  assert.deepEqual(parseMigration(raw, selected).map((item) => item.id), ['legacy']);
  assert.throws(() => parseMigration(JSON.stringify({ memories: [{ id: 'new', topic: 'x', keywords: ['x'], kind: 'routine', emotion: 0, importance: 0, confidence: 1 }] }), selected), /Invalid memory fields/);
});

test('retention requires an explicit memory request, supports split events, and preserves fractional days', () => {
  assert.equal(requestedRetentionDays('请保留半个月'), 15);
  assert.equal(requestedRetentionDays('请记住两周'), 14);
  assert.equal(requestedRetentionDays('记2天'), 2);
  assert.equal(requestedRetentionDays('请永远记住'), 366);
  assert.equal(requestedRetentionDays('请把这件事保留至少半个月'), 15);
  assert.equal(requestedRetentionDays('这件事请记住两天'), 2);
  assert.equal(requestedRetentionDays('keep this for 1.5 months'), 45);
  assert.equal(requestedRetentionDays('请保留0.5天'), 0.5);
  assert.equal(requestedRetentionDays('明天出差三天'), null);
  assert.equal(requestedRetentionDays('去年旅行半个月'), null);
  assert.equal(requestedRetentionDays('永久居民'), null);
  assert.equal(requestedRetentionDays('请记住，我去年旅游了三天'), null);
  assert.equal(requestedRetentionDays('请记住三天前的事故'), null);
  assert.equal(requestedRetentionDays('不要记住两天'), null);
  const explicit = parse(add({ content: '用户要求保留两周的跑步计划', sourceIds: ['u:0'] }), [observation('u:0', '请保留两周')]);
  assert.equal(explicit.ops[0].retentionDays, 14);
  const split = parse(add({ sourceIds: ['e:0'], keywords: [{ text: '晨跑', sourceIds: ['e:0'] }] }),
    [observation('e:0', '请记住半', { eventId: 'e' }), observation('e:10', '个月', { eventId: 'e' })]);
  assert.equal(split.ops[0].retentionDays, 15);
  const separate = parse(add({ sourceIds: ['a:0', 'b:0'], keywords: [{ text: '晨跑', sourceIds: ['a:0'] }] }),
    [observation('a:0', '请记住'), observation('b:0', '两天', { eventId: 'b' })]);
  assert.equal(separate.ops[0].retentionDays, undefined);
  assert.throws(() => parse(add({ retentionDays: 2 }), [observation('u:0', '请保留两周')]), /Invalid memory fields/);
});

test('migration accepts retention only when legacy content contains an explicit request', () => {
  const records = [{ id: 'kept', content: '请记住半个月', kind: 'routine', emotion: 0, importance: 0.5, confidence: 1 }];
  const valid = JSON.stringify({ memories: [{ id: 'kept', topic: '计划', keywords: ['期限'], kind: 'routine', emotion: 0, importance: 0.5, confidence: 1, retentionDays: 15 }] });
  assert.equal(parseMigration(valid, records)[0].retentionDays, 15);
  const invalid = JSON.stringify({ memories: [{ id: 'kept', topic: '计划', keywords: ['期限'], kind: 'routine', emotion: 0, importance: 0.5, confidence: 1, retentionDays: 14 }] });
  assert.throws(() => parseMigration(invalid, records), /Invalid memory fields/);
});

test('past-time English references do not become retention requests', () => {
  for (const text of ['remember 2 days ago when we met', 'remember 3 weeks earlier', 'remember 2 days before the trip']) {
    assert.equal(requestedRetentionDays(text), null, text);
    assert.equal(parse(add(), [observation('u:0', text)]).ops[0].retentionDays, undefined);
  }
  assert.equal(requestedRetentionDays('remember this for 2 days'), 2);
  assert.equal(requestedRetentionDays('keep this for 2 days after launch'), 2);
  assert.equal(requestedRetentionDays('retain this for 3 months after termination'), 90);
});

test('affirmative retention clauses and post-verb Chinese objects retain their explicit durations', () => {
  for (const [text, days] of [
    ['不要记住两天；请保留两周', 14],
    ["Don't remember this for 2 days. Keep this for 2 weeks.", 14],
    ['记住这件事两天', 2],
    ['请保存这个事情三天', 3],
    ['请保留这件事至少半个月', 15],
  ]) {
    assert.equal(requestedRetentionDays(text), days, text);
    assert.equal(parse(add(), [observation('u:0', text)]).ops[0].retentionDays, days);
  }
  assert.equal(requestedRetentionDays('不要记住两天；不用保留三天'), null);
});
