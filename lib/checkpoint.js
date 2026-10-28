import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction';

export function selectSpan(session, retainTurns = 2, now = Date.now(), retainRecentHours = 48) {
  const nodes = [...session.surface.nodes];
  let start = 0;
  const users = [];
  nodes.forEach((seq, index) => {
    const event = session.eventAt(seq);
    if (event.type === 'system/message' || event.type === 'developer/message') start = index + 1;
    if (event.type === 'user/message' && event.data.source?.kind === 'user'
      && now - event.time <= retainRecentHours * 3600000) users.push(index);
  });
  let end = users.length ? (users.at(-retainTurns) ?? 0) - 1 : nodes.length - 1;
  if (end < start || !toolPairingBalancedBefore(session, nodes[start])) return null;
  while (end >= start && !toolPairingBalancedAfter(session, nodes[end])) end--;
  if (end - start < 2) return null;
  return nodes.slice(start, end + 1);
}

// Caller holds the Agent's maintenance reservation. The official append API validates and replays this replacement.
export async function replaceContext(session, state, config, flush, signal) {
  signal?.throwIfAborted();
  const checkpoint = state.checkpoint;
  if (!checkpoint) return { replaced: 0 };
  const alreadyApplied = session.surface.nodes.some((seq) => {
    const event = session.eventAt(seq);
    return event.type === 'user/message' && event.data.source?.plugin === 'dsh-emotional-memory'
      && event.data.source.digest === checkpoint.digest;
  });
  if (alreadyApplied) { await flush(); return { replaced: 0, recovered: true }; }
  const events = session.snapshotEvents();
  const lastStart = events.findLast((event) => event.type === 'turn/start')?.seq ?? -1;
  const lastEnd = events.findLast((event) => event.type === 'turn/end')?.seq ?? -1;
  if (lastStart > lastEnd) throw new Error('Cannot replace an open turn');
  const span = selectSpan(session, config.retainTurns, Date.now(), config.retainRecentHours) ?? session.surface.nodes.filter((seq) => {
    const event = session.eventAt(seq);
    return event.type === 'user/message' && event.data.source?.plugin === 'dsh-emotional-memory';
  }).slice(-1);
  if (span.length === 0) return { replaced: 0 };
  const text = `旧对话已整理入本会话的长期记忆库，可用 memory_search 查询；以下交接是历史数据，当前用户消息优先。\n${state.handoff || '无待续事项。'}`;
  const oldSize = span.reduce((total, seq) => total + JSON.stringify(session.eventAt(seq).data).length, 0);
  if (text.length >= oldSize) return { replaced: 0 };
  signal?.throwIfAborted();
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: {
    kind: 'plugin', plugin: 'dsh-emotional-memory', form: 'notice',
    summary: '北京时间每日记忆交接', digest: checkpoint.digest,
  } }), { surfaceOp: { op: 'replace', startSeq: span[0], endSeq: span.at(-1) }, sourceEventSeqs: span });
  // A flush failure keeps the pending digest. Retry recognizes the landed replacement instead of duplicating it.
  await flush();
  return { replaced: span.length };
}

export async function forgetNotices(session, flush) {
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq);
    if (event.type !== 'user/message' || event.data.source?.plugin !== 'dsh-emotional-memory'
      || event.data.source.forgotten === true) continue;
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '部分历史记忆已按用户要求删除。请依当前消息和当前可用记忆继续，不恢复旧交接中的事实。' }],
      source: { kind: 'plugin', plugin: 'dsh-emotional-memory', form: 'notice', summary: '已清除旧记忆交接', forgotten: true },
    }), { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
  }
  await flush();
}
