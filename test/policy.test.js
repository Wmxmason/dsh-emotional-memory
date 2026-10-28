import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY, scheduleDate, selectMemories, shouldArchive, strength } from '../lib/policy.js';

const now = Date.UTC(2026, 0, 10, 0);
const record = (overrides = {}) => ({
  kind: 'routine', emotion: 0, importance: 0.5, pinned: false, status: 'active',
  createdAt: now, lastReinforcedAt: null, reinforcementCount: 0, expiresAt: null,
  content: '默认内容', ...overrides,
});

test('emotion and reinforcement lengthen a memory half-life', () => {
  const age = now + 7 * DAY;
  assert.ok(strength(record(), age) < 0.51);
  assert.ok(strength(record({ emotion: 1, reinforcementCount: 4 }), age) > 0.75);
});

test('pinned, core, and active commitments retain strength, but expiry wins', () => {
  assert.equal(strength(record({ kind: 'core', pinned: true }), now + 9_999 * DAY), 1);
  assert.equal(shouldArchive(record({ kind: 'core', pinned: true }), now + 9_999 * DAY), false);
  assert.equal(strength(record({ kind: 'commitment' }), now + 9_999 * DAY), 1);
  assert.equal(shouldArchive(record({ kind: 'commitment' }), now + 9_999 * DAY), false);
  const expired = record({ kind: 'commitment', expiresAt: now });
  assert.equal(strength(expired, now), 0);
  assert.equal(shouldArchive(expired, now), true);
});

test('ordinary memories decay naturally and archived records are zero', () => {
  assert.equal(strength(record(), now + 7 * DAY), 0.5);
  assert.equal(shouldArchive(record(), now + 35 * DAY), true);
  assert.equal(strength(record({ status: 'archived' }), now), 0);
});

test('lifecycle records stay fully strong until expiry, while level six ignores dirty expiry data', () => {
  const active = record({ level: 3, expiresAt: now + DAY });
  assert.equal(strength(active, now), 1);
  assert.equal(strength(active, now + DAY), 0);
  assert.equal(shouldArchive(active, now + DAY), true);
  const permanent = record({ level: 6, expiresAt: now - DAY });
  assert.equal(strength(permanent, now), 1);
  assert.equal(shouldArchive(permanent, now), false);
  assert.equal(strength({ ...permanent, status: 'archived' }, now), 0);
  assert.equal(shouldArchive({ ...permanent, status: 'archived' }, now), true);
});

test('selection recognizes Chinese bigrams and English words without recalling unrelated emotion', () => {
  const records = [
    record({ content: '我喜欢在公园散步', emotion: 0 }),
    record({ content: 'Deploy the payment service after review', emotion: 0 }),
    record({ content: '热烈的海边烟花旅行', emotion: 1 }),
  ];
  assert.deepEqual(selectMemories(records, '公园', { now }), [records[0]]);
  assert.deepEqual(selectMemories(records, 'payment', { now }), [records[1]]);
  assert.deepEqual(selectMemories(records, '嗯', { now }), []);
});

test('selection keeps up to three resident core/pinned records, honors budget, and does not mutate input', () => {
  const records = [
    record({ kind: 'core', content: '长期偏好' }),
    record({ pinned: true, content: '固定提醒' }),
    record({ kind: 'core', content: '重要背景' }),
    record({ pinned: true, content: '第四条不能常驻' }),
    record({ content: '会议安排已经确认' }),
  ];
  const before = structuredClone(records);
  assert.deepEqual(selectMemories(records, '会议', { now, maxChars: 12 }), [records[0], records[1], records[2]]);
  assert.deepEqual(selectMemories(records, '会议', { now, maxChars: 8 }), [records[0], records[1]]);
  assert.deepEqual(records, before);
});

test('schedule date uses Asia/Shanghai 04:00 boundary across years independent of server timezone', () => {
  assert.equal(scheduleDate(Date.UTC(2025, 11, 31, 19, 59)), '2025-12-31'); // 03:59 CST
  assert.equal(scheduleDate(Date.UTC(2025, 11, 31, 20, 0)), '2026-01-01'); // 04:00 CST
  assert.equal(scheduleDate(Date.UTC(2026, 5, 1, 0, 0)), '2026-06-01'); // 08:00 CST
});
