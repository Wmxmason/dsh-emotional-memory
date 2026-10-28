import { DAY, scheduleDate } from './policy.js';

export const LEVEL_DAYS = [0, 1, 3, 7, 30, 365, Infinity];

const HITS_TO_PROMOTE = [0, 1, 3, 5, 7, 10];
const CLEANUP_INTERVAL = 30 * DAY;
const DEFAULT_CURSOR = '';

function isLevel(value) {
  return Number.isInteger(value) && value >= 1 && value <= 6;
}

function eventParts(id) {
  if (typeof id !== 'string' || id.length === 0) return null;
  if (/^\d+$/.test(id)) return { session: DEFAULT_CURSOR, seq: Number(id) };
  const match = /^(.*):(\d+)$/.exec(id);
  if (!match || !match[1]) return null;
  return { session: match[1], seq: Number(match[2]) };
}

function validTime(value) {
  return Number.isFinite(value) ? value : null;
}

function businessDate(time, config) {
  return scheduleDate(time, config.dailyHour ?? 4, config.dailyMinute ?? 0);
}

function protectedRecord(record) {
  return record.pinned || record.kind === 'core' || record.kind === 'commitment';
}

export function topicIdentity(record) {
  const topic = String(record.topic ?? '').trim().toLocaleLowerCase();
  return JSON.stringify([topic, record.actor ?? '']);
}

function refreshExpiry(record) {
  if (record.level === 6 || protectedRecord(record)) {
    record.expiresAt = null;
    return;
  }
  const base = Math.max(record.periodStartedAt ?? -Infinity, record.lastMentionedAt ?? -Infinity);
  record.expiresAt = Number.isFinite(base) ? base + LEVEL_DAYS[record.level] * DAY : null;
}

function seedCursors(cursors, sourceIds) {
  for (const sourceId of sourceIds ?? []) acceptEvent(cursors, eventIdentity(sourceId));
}

function acceptEvent(cursors, id) {
  const parts = eventParts(id);
  if (!parts) return false;
  const previous = cursors[parts.session];
  const ranges = Array.isArray(previous) ? previous : Number.isInteger(previous) ? [[previous, previous]] : [];
  if (ranges.some(([first, last]) => parts.seq >= first && parts.seq <= last)) return false;
  const merged = [];
  for (const range of [...ranges, [parts.seq, parts.seq]].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  cursors[parts.session] = merged;
  return true;
}

function hasSeenEvents(record) {
  return (record.mentionCount ?? 0) > 0 || (record.initialMentions ?? 0) > 0
    || Object.keys(record.mentionCursors ?? {}).length > 0;
}

function resetExpiredRecord(record, time, config) {
  record.level = initialLevel(record);
  record.levelHits = 0;
  record.mentionCount = 0;
  record.initialDate = businessDate(time, config);
  record.initialMentions = 0;
  record.periodStartedAt = time;
  record.evidenceStartedAt = time;
  record.lastMentionedAt = null;
  refreshExpiry(record);
}

export function levelForDuration(days) {
  const duration = Number(days);
  if (!Number.isFinite(duration)) return duration === Infinity ? 6 : 1;
  if (duration <= 1) return 1;
  if (duration <= 3) return 2;
  if (duration <= 7) return 3;
  if (duration <= 30) return 4;
  if (duration <= 365) return 5;
  return 6;
}

export function initialLevel(record, retentionDays = record.retentionDays) {
  if (protectedRecord(record)) return 6;
  let level = retentionDays == null ? 1 : levelForDuration(retentionDays);
  if (record.kind === 'emotional') {
    const emotion = Math.max(0, Math.min(1, Number(record.emotion) || 0));
    const emotionalLevel = emotion < 0.2 ? 1 : emotion < 0.4 ? 2 : emotion < 0.6 ? 3 : emotion < 0.8 ? 4 : 5;
    level = Math.max(level, emotionalLevel);
  }
  return level;
}

// A source id has a final message offset; the preceding value is its event id.
export function eventIdentity(sourceId) {
  if (typeof sourceId !== 'string') return '';
  const offset = sourceId.lastIndexOf(':');
  return offset >= 0 ? sourceId.slice(0, offset) : sourceId;
}

export function initializeRecord(record, at, { migration = false, config = {} } = {}) {
  const time = validTime(at) ?? 0;
  if (!isLevel(record.level)) record.level = initialLevel(record);
  record.levelHits = Math.max(0, Number(record.levelHits) || 0);
  record.mentionCount = Math.max(0, Number(record.mentionCount) || 0);
  record.initialMentions = Math.max(0, Number(record.initialMentions) || 0);
  record.mentionCursors ??= {};
  record.keywords ??= [];

  if (migration) {
    record.levelHits = 0;
    record.mentionCount = 0;
    record.initialMentions = 0;
    record.initialDate = null;
    record.periodStartedAt = time;
    // Unprocessed observations predate migration; only old source IDs are replay evidence.
    record.evidenceStartedAt = 0;
    record.lastMentionedAt = null;
    seedCursors(record.mentionCursors, record.sourceIds);
    for (const keyword of record.keywords) {
      keyword.firstSeenAt ??= time;
      keyword.lastMentionedAt ??= time;
      keyword.lastConfirmedAt ??= null;
      keyword.mentionCursors ??= {};
      keyword.sourceIds ??= [...(record.sourceIds ?? [])];
      seedCursors(keyword.mentionCursors, record.sourceIds);
      keyword.mentionCount = Math.max(0, Number(keyword.mentionCount) || 0);
    }
  } else {
    record.initialDate ??= businessDate(time, config);
    record.periodStartedAt ??= time;
    record.evidenceStartedAt ??= time;
    record.lastMentionedAt ??= null;
  }
  record.reinforcementCount = Math.max(0, Number(record.reinforcementCount) || 0);
  refreshExpiry(record);
  return record;
}

export function applyMentions(state, record, op, config = {}) {
  const mentions = Array.isArray(op.mentions) ? op.mentions : [];
  const firstTime = mentions.map((mention) => validTime(mention.time)).find((time) => time != null);
  if (!isLevel(record.level)) initializeRecord(record, firstTime ?? 0, { config });
  state.topicPromotions ??= {};
  record.mentionCursors ??= {};
  record.keywords ??= [];
  if (op.topic != null) record.topic = op.topic;
  if (op.actor != null) record.actor = op.actor;

  for (const mention of mentions) {
    const time = validTime(mention.time);
    if (time == null) continue;
    const seenBefore = hasSeenEvents(record);
    const accepted = acceptEvent(record.mentionCursors, mention.id);
    if (time < (record.evidenceStartedAt ?? record.periodStartedAt)) continue;
    const requested = op.retentionByEvent == null ? op.retentionDays : op.retentionByEvent[mention.id];
    if (accepted && record.expiresAt != null && time >= record.expiresAt) {
      if (requested == null) delete record.retentionDays;
      else record.retentionDays = requested;
      resetExpiredRecord(record, time, config);
    }
    let raisedByRequest = false;
    if (requested != null && (accepted || op.retentionByEvent != null)) {
      record.retentionDays = requested;
      const minimumLevel = levelForDuration(requested);
      if (minimumLevel > record.level) {
        record.level = minimumLevel;
        record.levelHits = 0;
        raisedByRequest = true;
      }
      refreshExpiry(record);
    }
    if (!accepted) continue;
    record.mentionCount += 1;
    if (seenBefore) record.reinforcementCount += 1;
    record.lastMentionedAt = Math.max(record.lastMentionedAt ?? -Infinity, time);
    record.lastReinforcedAt = Math.max(record.lastReinforcedAt ?? -Infinity, time);
    const date = businessDate(time, config);
    record.lastReinforcedDate = businessDate(record.lastReinforcedAt, config);
    const promotionKey = topicIdentity(record);
    const canPromote = (state.topicPromotions[promotionKey] == null || date > state.topicPromotions[promotionKey])
      && (record.lastPromotionDate == null || date > record.lastPromotionDate);

    if (record.initialDate !== null && date === record.initialDate) {
      record.initialMentions += 1;
      if (record.level === 1 && record.initialMentions >= 3 && canPromote) {
        record.level = 2;
        record.levelHits = 0;
        record.lastPromotionDate = date;
        state.topicPromotions[promotionKey] = date;
      }
    } else if (record.level < 6 && !raisedByRequest) {
      record.levelHits += 1;
      if (record.levelHits >= HITS_TO_PROMOTE[record.level] && canPromote) {
        record.level += 1;
        record.levelHits = 0;
        record.lastPromotionDate = date;
        state.topicPromotions[promotionKey] = date;
      }
    }
    refreshExpiry(record);
  }

  for (const incoming of Array.isArray(op.keywords) ? op.keywords : []) {
    if (typeof incoming.text !== 'string' || incoming.text.length === 0) continue;
    const evidence = (incoming.mentions ?? []).filter((mention) => mention.time >= (record.evidenceStartedAt ?? record.periodStartedAt));
    if (!evidence.length) continue;
    const normalizedText = incoming.text.trim().toLocaleLowerCase();
    let keyword = record.keywords.find((item) => String(item.text ?? '').trim().toLocaleLowerCase() === normalizedText);
    const existed = Boolean(keyword);
    if (!keyword) {
      keyword = { text: incoming.text, firstSeenAt: null, lastMentionedAt: null, lastConfirmedAt: null,
        mentionCount: 0, mentionCursors: {}, sourceIds: [] };
      record.keywords.push(keyword);
    }
    keyword.mentionCursors ??= {};
    keyword.mentionCount = Math.max(0, Number(keyword.mentionCount) || 0);
    keyword.sourceIds = [...new Set([...(keyword.sourceIds ?? []), ...(incoming.sourceIds ?? [])])].slice(-40);
    for (const mention of evidence) {
      const time = validTime(mention.time);
      if (time == null || !acceptEvent(keyword.mentionCursors, mention.id)) continue;
      const confirmedBefore = keyword.mentionCount > 0 || (record.initialDate === null && existed);
      keyword.mentionCount += 1;
      keyword.firstSeenAt = keyword.firstSeenAt == null ? time : Math.min(keyword.firstSeenAt, time);
      keyword.lastMentionedAt = Math.max(keyword.lastMentionedAt ?? -Infinity, time);
      if (confirmedBefore) keyword.lastConfirmedAt = Math.max(keyword.lastConfirmedAt ?? -Infinity, time);
    }
  }
  return record;
}

export function nextKeywordCleanupAt(state) {
  if (!Number.isFinite(state.modeActivatedAt)) return null;
  const anchor = state.modeActivatedAt;
  const previous = Number.isFinite(state.lastKeywordCleanupAt) ? Math.max(anchor, state.lastKeywordCleanupAt) : anchor;
  return anchor + (Math.floor((previous - anchor) / CLEANUP_INTERVAL) + 1) * CLEANUP_INTERVAL;
}

export function sweepKeywords(state, now) {
  if (!Number.isFinite(now)) return state;
  if (!Number.isFinite(state.modeActivatedAt)) {
    state.modeActivatedAt = now;
    state.lastKeywordCleanupAt = now;
    return state;
  }
  let boundary = nextKeywordCleanupAt(state);
  state.lastKeywordCleanupAt = boundary - CLEANUP_INTERVAL;
  while (boundary <= now) {
    const start = boundary - 40 * DAY;
    const end = boundary - 10 * DAY;
    for (const record of state.records ?? []) {
      if (protectedRecord(record) || record.level === 6 || !Array.isArray(record.keywords)) continue;
      record.keywords = record.keywords.filter((keyword) => keyword.firstSeenAt == null || keyword.firstSeenAt >= end
        || (keyword.lastConfirmedAt != null && keyword.lastConfirmedAt >= start));
    }
    state.lastKeywordCleanupAt = boundary;
    boundary += CLEANUP_INTERVAL;
  }
  return state;
}
