export const DAY = 86_400_000;
const HALF_LIFE_DAYS = { ephemeral: 1, routine: 7, emotional: 30, core: 180 };
const FILLER = /^(好的?|谢谢|感谢|嗯+|哦+|哈哈+|知道了|明白了|可以了|ok|okay|thanks)[！!。 .]*$/i;
const STOP_BIGRAMS = new Set(['怎么', '什么', '这个', '那个', '可以', '一下', '帮我', '有没有', '了吗', '好的']);

export function strength(record, now) {
  if (record.status !== 'active') return 0;
  if (Number.isInteger(record.level) && record.level >= 1 && record.level <= 6) {
    if (record.level === 6 || record.pinned || record.kind === 'core' || record.kind === 'commitment') return 1;
    if (record.expiresAt != null && now >= record.expiresAt) return 0;
    return 1;
  }
  if (record.expiresAt != null && now >= record.expiresAt) return 0;
  if (record.pinned || record.kind === 'core' || record.kind === 'commitment') return 1;
  const emotion = Math.max(0, Math.min(1, Number(record.emotion) || 0));
  const repetitions = Math.max(0, Math.min(4, Number(record.reinforcementCount) || 0));
  const halfLife = HALF_LIFE_DAYS[record.kind] * DAY * (1 + 2 * emotion) * (1 + 0.25 * repetitions);
  return halfLife > 0 ? 2 ** (-Math.max(0, now - (record.lastReinforcedAt ?? record.createdAt)) / halfLife) : 0;
}

export function shouldArchive(record, now, threshold = 0.05) {
  if (record.status !== 'active') return true;
  if (Number.isInteger(record.level) && record.level >= 1 && record.level <= 6) {
    return record.level !== 6 && !record.pinned && !['core', 'commitment'].includes(record.kind)
      && record.expiresAt != null && now >= record.expiresAt;
  }
  if (record.expiresAt != null && now >= record.expiresAt) return true;
  return !record.pinned && !['core', 'commitment'].includes(record.kind) && strength(record, now) < threshold;
}

export function relevance(content, query) {
  const text = content.toLowerCase();
  const input = query.trim().toLowerCase();
  if (input.length < 2 || FILLER.test(input)) return 0;
  const tokens = new Set();
  for (const run of input.match(/[\u3400-\u9fff]+/g) ?? []) {
    for (let i = 0; i + 1 < run.length; i++) {
      const token = run.slice(i, i + 2);
      if (!STOP_BIGRAMS.has(token)) tokens.add(token);
    }
  }
  const words = input.match(/[a-z0-9_]{2,}/g) ?? [];
  let score = 0;
  for (const token of tokens) if (text.includes(token)) score += 1;
  const contentWords = new Set(text.match(/[a-z0-9_]+/g) ?? []);
  for (const word of words) if (contentWords.has(word)) score += 1;
  if (score > 0 && text.includes(input)) score += 3;
  return score;
}

export function selectMemories(records, query, { now, limit = 8, maxChars = 1800, includeResident = true }) {
  const candidates = records.filter((record) => strength(record, now) > 0);
  const residents = includeResident ? new Set(candidates
    .filter((record) => record.pinned || record.kind === 'core' || record.kind === 'commitment')
    .slice(0, 3).map((record) => record.id ?? record)) : new Set();
  const ranked = candidates.map((record, index) => ({
    record, index, score: relevance(record.content, query), resident: residents.has(record.id ?? record),
  })).filter((item) => item.resident || item.score > 0)
    .sort((a, b) => Number(b.resident) - Number(a.resident) || b.score - a.score
      || strength(b.record, now) - strength(a.record, now) || a.index - b.index);
  const selected = [];
  let used = 0;
  for (const { record } of ranked) {
    if (selected.length >= limit) break;
    if (used + record.content.length > maxChars) continue;
    selected.push(record);
    used += record.content.length;
  }
  return selected;
}

// The latest elapsed 04:00 business-date boundary, independent of the server timezone.
export function scheduleDate(now, hour = 4, minute = 0) {
  return new Date(now + 8 * 3_600_000 - (hour * 60 + minute) * 60_000).toISOString().slice(0, 10);
}
