import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEVEL_DAYS, applyMentions, eventIdentity, initialLevel, initializeRecord, levelForDuration, sweepKeywords,
  topicIdentity,
} from '../lib/lifecycle.js';
import { DAY } from '../lib/policy.js';

const T = Date.UTC(2026, 0, 10, 0);
const event = (id, time) => ({ id, time });
const record = (overrides = {}) => ({ kind: 'routine', pinned: false, emotion: 0, sourceIds: [], reinforcementCount: 0, ...overrides });
const op = (mentions, extra = {}) => ({ mentions, topic: 'project', actor: 'user', keywords: [], ...extra });

test('six level duration boundaries, emotion boundaries, and protected records have deterministic initials', () => {
  assert.deepEqual(LEVEL_DAYS, [0, 1, 3, 7, 30, 365, Infinity]);
  assert.deepEqual([0, 1, 1.1, 3, 3.1, 7, 7.1, 30, 30.1, 365, 365.1].map(levelForDuration), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6]);
  assert.deepEqual([0.19, 0.2, 0.4, 0.6, 0.8, 1].map((emotion) => initialLevel(record({ kind: 'emotional', emotion }))), [1, 2, 3, 4, 5, 5]);
  assert.equal(initialLevel(record({ kind: 'core' })), 6);
  assert.equal(initialLevel(record({ pinned: true })), 6);
  assert.equal(eventIdentity('session:12:3'), 'session:12');
});

test('the first business day seeds at most level two and does not spend later hit thresholds', () => {
  const state = {};
  const item = initializeRecord(record(), T);
  applyMentions(state, item, op([event('s:0', T), event('s:1', T), event('s:2', T)]));
  assert.equal(item.level, 2);
  assert.equal(item.initialMentions, 3);
  assert.equal(item.levelHits, 0);
  assert.equal(item.reinforcementCount, 2);
  applyMentions(state, item, op([event('s:3', T + DAY)]));
  assert.equal(item.level, 2);
  assert.equal(item.levelHits, 1);
});

test('later hits use every level threshold while one topic may promote only once per business day', () => {
  const state = {};
  const item = initializeRecord(record(), T, { migration: true });
  applyMentions(state, item, op([event('s:0', T)]));
  assert.equal(item.level, 2);
  applyMentions(state, item, op([event('s:1', T), event('s:2', T), event('s:3', T)]));
  assert.equal(item.level, 2);
  assert.equal(item.levelHits, 3);
  applyMentions(state, item, op([event('s:4', T + DAY)]));
  assert.equal(item.level, 3);
  for (let i = 5; i < 10; i++) applyMentions(state, item, op([event(`s:${i}`, T + 2 * DAY)]));
  assert.equal(item.level, 4);
  for (let i = 10; i < 17; i++) applyMentions(state, item, op([event(`s:${i}`, T + 3 * DAY)]));
  assert.equal(item.level, 5);
  for (let i = 17; i < 27; i++) applyMentions(state, item, op([event(`s:${i}`, T + 4 * DAY)]));
  assert.equal(item.level, 6);
  assert.equal(item.levelHits, 0);
});

test('renaming the topic cannot promote the same fact twice in one business day', () => {
  const state = {};
  const item = initializeRecord(record(), T, { migration: true });
  applyMentions(state, item, op([event('s:0', T)], { topic: 'alpha' }));
  assert.equal(item.level, 2);
  applyMentions(state, item, op([event('s:1', T), event('s:2', T), event('s:3', T)], { topic: 'beta' }));
  assert.equal(item.level, 2);
  assert.equal(item.levelHits, 3);
  applyMentions(state, item, op([event('s:4', T + DAY)], { topic: 'beta' }));
  assert.equal(item.level, 3);
});

test('cursor high water marks make chunking, replay, and independent sessions idempotent', () => {
  const state = {};
  const item = initializeRecord(record(), T);
  applyMentions(state, item, op([event('a:0', T), event('a:1', T)]));
  const afterFirst = structuredClone(item);
  applyMentions(state, item, op([event('a:0', T), event('a:1', T)]));
  assert.deepEqual(item, afterFirst);
  applyMentions(state, item, op([event('b:0', T)]));
  assert.equal(item.initialMentions, 3);
  assert.deepEqual(item.mentionCursors, { a: [[0, 1]], b: [[0, 0]] });
});

test('compatibility time fields update only for newly accepted events and bare legacy cursors use the empty session', () => {
  const state = {};
  const item = initializeRecord(record({ sourceIds: ['7:0'] }), T, { migration: true });
  assert.deepEqual(item.mentionCursors, { '': [[7, 7]] });
  applyMentions(state, item, op([event('7', T + DAY / 2)]));
  assert.equal(item.mentionCount, 0);
  applyMentions(state, item, op([event('8', T + DAY / 2)]));
  assert.equal(item.lastReinforcedAt, T + DAY / 2);
  assert.equal(item.lastReinforcedDate, '2026-01-10');
  const before = structuredClone(item);
  applyMentions(state, item, op([event('8', T + DAY / 2)]));
  assert.deepEqual(item, before);
});

test('an explicit retention floor needs a new event, bypasses the daily promotion cap, and is not inherited after expiry', () => {
  const state = {};
  const item = initializeRecord(record(), T);
  applyMentions(state, item, op([event('a:0', T)], { retentionDays: 30 }));
  assert.equal(item.retentionDays, 30);
  assert.equal(item.level, 4);
  assert.equal(item.expiresAt, T + 30 * DAY);
  assert.equal(item.lastReinforcedAt, T);
  assert.equal(item.lastReinforcedDate, '2026-01-10');
  assert.equal(item.lastPromotionDate, undefined);
  const beforeReplay = structuredClone(item);
  applyMentions(state, item, op([event('a:0', T)], { retentionDays: 365 }));
  assert.deepEqual(item, beforeReplay);
  applyMentions(state, item, op([event('a:1', T + 31 * DAY)]));
  assert.equal(item.level, 1);
  assert.equal(item.retentionDays, undefined);
  assert.equal(item.expiresAt, T + 32 * DAY);
});

test('topic promotion identity and keyword storage normalize case and whitespace across days', () => {
  const state = {};
  const item = initializeRecord(record(), T, { migration: true });
  applyMentions(state, item, op([event('a:0', T)], { topic: ' Coffee ', keywords: [{ text: 'Coffee', mentions: [event('a:0', T)] }] }));
  assert.equal(item.level, 2);
  const key = topicIdentity(item);
  assert.equal(state.topicPromotions[key], '2026-01-10');
  applyMentions(state, item, op([event('a:1', T), event('a:2', T), event('a:3', T)], {
    topic: 'coffee', keywords: [{ text: 'coffee', mentions: [event('a:1', T)] }],
  }));
  assert.equal(item.level, 2);
  assert.equal(item.keywords.length, 1);
  assert.equal(item.keywords[0].mentionCount, 2);
  applyMentions(state, item, op([event('a:4', T + DAY)], { topic: 'COFFEE' }));
  assert.equal(item.level, 3);
  assert.equal(item.lastPromotionDate, '2026-01-11');
});

test('a late event from before an expired period cannot strengthen its replacement period', () => {
  const state = {};
  const item = initializeRecord(record(), T);
  applyMentions(state, item, op([event('session:0', T)]));
  applyMentions(state, item, op([event('session:1', T + 4 * DAY)]));
  const before = { level: item.level, hits: item.levelHits, count: item.mentionCount, expiresAt: item.expiresAt };
  applyMentions(state, item, op([event('session:2', T + DAY / 2)]));
  assert.deepEqual({ level: item.level, hits: item.levelHits, count: item.mentionCount, expiresAt: item.expiresAt }, before);
});

test('a late prior-day source cannot reopen a topic promotion cap already set on the next day', () => {
  const state = {};
  const item = initializeRecord(record(), T, { migration: true });
  const nextBusinessDay = T + 20 * 3_600_000;
  applyMentions(state, item, op([event('d2-first:0', nextBusinessDay)]));
  assert.equal(item.level, 2);
  applyMentions(state, item, op([event('d1-late:0', T), event('d1-late:1', T), event('d1-late:2', T)]));
  for (let i = 0; i < 5; i++) applyMentions(state, item, op([event(`d2-later:${i}`, nextBusinessDay)]));
  assert.equal(item.level, 2);
  assert.equal(item.lastPromotionDate, '2026-01-11');
});

test('newer mentions refresh expiry, old mentions cannot shorten it, and post-expiry starts a new period', () => {
  const state = {};
  const item = initializeRecord(record(), T);
  applyMentions(state, item, op([event('a:0', T)]));
  assert.equal(item.expiresAt, T + DAY);
  applyMentions(state, item, op([event('a:1', T + DAY / 2)]));
  assert.equal(item.expiresAt, T + DAY / 2 + DAY);
  applyMentions(state, item, op([event('b:0', T + DAY / 4)]));
  assert.equal(item.expiresAt, T + DAY / 2 + 3 * DAY);
  applyMentions(state, item, op([event('a:2', T + DAY * 4)]));
  assert.equal(item.level, 1);
  assert.equal(item.levelHits, 0);
  assert.equal(item.initialMentions, 1);
  assert.equal(item.periodStartedAt, T + DAY * 4);
  assert.equal(item.expiresAt, T + DAY * 5);
});

test('migration preserves legacy provenance without inventing initial hits and its first keyword confirmation is valid', () => {
  const item = record({ createdAt: T - DAY, lastReinforcedAt: T - DAY, sourceIds: ['legacy:4:0'], reinforcementCount: 7,
    keywords: [{ text: 'legacy' }] });
  initializeRecord(item, T, { migration: true });
  assert.equal(item.initialDate, null);
  assert.equal(item.mentionCount, 0);
  assert.equal(item.reinforcementCount, 7);
  assert.deepEqual(item.mentionCursors, { legacy: [[4, 4]] });
  assert.deepEqual(item.keywords[0], { text: 'legacy', firstSeenAt: T, lastMentionedAt: T, lastConfirmedAt: null,
    mentionCount: 0, mentionCursors: { legacy: [[4, 4]] }, sourceIds: ['legacy:4:0'] });
  applyMentions({}, item, op([event('new:0', T + DAY / 2)], { keywords: [{ text: 'legacy', mentions: [event('new:0', T + DAY / 2)] }] }));
  assert.equal(item.mentionCount, 1);
  assert.equal(item.level, 2);
  assert.equal(item.keywords[0].lastConfirmedAt, T + DAY / 2);
});

test('keyword cleanup observes fixed boundaries, preserves recent and L6 keywords, and is replay safe', () => {
  const activation = T;
  const state = {
    modeActivatedAt: activation,
    lastKeywordCleanupAt: activation,
    records: [
      record({ level: 2, keywords: [
        { text: 'drop', firstSeenAt: activation - 5 * DAY, lastConfirmedAt: null },
        { text: 'keep', firstSeenAt: activation - 5 * DAY, lastConfirmedAt: activation - 10 * DAY },
        { text: 'recent', firstSeenAt: activation + 25 * DAY, lastConfirmedAt: null },
      ] }),
      record({ level: 6, keywords: [{ text: 'forever', firstSeenAt: activation - 100 * DAY, lastConfirmedAt: null }] }),
    ],
  };
  sweepKeywords(state, activation + 30 * DAY);
  assert.deepEqual(state.records[0].keywords.map((item) => item.text), ['keep', 'recent']);
  assert.deepEqual(state.records[1].keywords.map((item) => item.text), ['forever']);
  const afterBoundary = structuredClone(state);
  sweepKeywords(state, activation + 30 * DAY);
  assert.deepEqual(state, afterBoundary);
  sweepKeywords(state, activation + 61 * DAY);
  assert.equal(state.lastKeywordCleanupAt, activation + 60 * DAY);
  assert.deepEqual(state.records[0].keywords, []);
});

test('off-phase cleanup progress is reconciled to the original activation schedule', () => {
  const state = { modeActivatedAt: T, lastKeywordCleanupAt: T + 40 * DAY,
    records: [record({ level: 5, keywords: [
      { text: 'stale', firstSeenAt: T + 35 * DAY, lastConfirmedAt: null },
      { text: 'recent', firstSeenAt: T + 55 * DAY, lastConfirmedAt: null },
    ] })] };
  sweepKeywords(state, T + 70 * DAY);
  assert.equal(state.lastKeywordCleanupAt, T + 60 * DAY);
  assert.deepEqual(state.records[0].keywords.map((item) => item.text), ['recent']);
});
