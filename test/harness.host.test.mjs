import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, SessionStore } from '@deepseek-ai/dsh-session';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { createUserMessage, createAssistantMessage, createSystemMessage, createDeveloperMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { forgetNotices, replaceContext, selectSpan } from '../lib/checkpoint.js';
import { Config, apply, generate } from '../lib/index.js';
import * as plugin from '../lib/index.js';
import { fixture } from './helpers.js';

function history() {
  const session = Session.create('synthetic-qq-user');
  session.append('system/message', { message: createSystemMessage('始终保留的人格提示词') }, { surfaceOp: 'append' });
  session.append('developer/message', { message: createDeveloperMessage({ content: [{ type: 'text', text: '必须保留的约束' }],
    source: { kind: 'plugin', plugin: 'synthetic-persona' } }) }, { surfaceOp: 'append' });
  for (let i = 0; i < 7; i++) {
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `第${i}次用户输入。` + '历史细节。'.repeat(100) }],
      source: { kind: 'user', plugin: 'im-qqbot' } }), { surfaceOp: 'append' });
    session.append('assistant/message', { message: createAssistantMessage({ content: [{ type: 'text', text: `第${i}次回复。` + '回复内容。'.repeat(100) }],
      source: { provider: 'synthetic', model: 'fake' } }), turn: i + 1, step: 1, stream: [] }, { surfaceOp: 'append' });
  }
  return session;
}

test('the installed runtime SDK falls within the declared installation version range', (t) => {
  const versions = {};
  for (const name of ['dsh-desktop-host', 'dsh-agent', 'dsh-session', 'dsh-llm', 'dsh-compaction', 'dsh-tools', 'dsh-system-prompt']) {
    const version = JSON.parse(readFileSync(join(process.env.DSH_SDK_ROOT, 'node_modules', '@deepseek-ai', name, 'package.json'), 'utf8')).version;
    assert.ok(['0.2.1-rc.2', '0.2.1-rc.3'].includes(version));
    versions[name] = version;
  }
  t.diagnostic(JSON.stringify(versions));
});

test('real SDK loads the plugin schema and native tool definitions', async (t) => {
  const store = await fixture(t);
  const handlers = new Map();
  const tools = new Map();
  const effects = [];
  const contexts = [];
  const ctx = { logger: { warn() {} }, llm: {}, agents: { get() {}, roots: () => [] }, sessions: {},
    tools: { register(tool) { tools.set(tool.name, tool); } },
    systemPrompt: { context(value) { contexts.push(value); } },
    on(event, listener) { handlers.set(event, listener); }, effect(factory) { effects.push(factory()); }, get() {},
  };
  const result = apply(ctx, { storageDir: store.root });
  t.after(async () => { for (const dispose of effects) await dispose(); });
  assert.equal(new Config({}).dailyHour, 4);
  assert.equal(tools.size, 5);
  assert.ok(result.engine);
  assert.equal(contexts[0].required, true);
  assert.equal(typeof Context, 'function');
});

test('the real native agent reports idle during maintenance and the plugin defers a second reservation', async (t) => {
  const store = await fixture(t);
  const ctx = new Context();
  const fibers = [];
  const effects = [];
  let handle;
  let release;
  let held;
  ctx.provide('llm', { async *stream() {
    yield { type: 'text-delta', index: 0, text: '{"ops":[],"handoff":""}' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } });
  ctx.provide('tools', { register() {}, list: () => [] });
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'synthetic', model: 'fake' }) });
  try {
    for (const service of [SessionStore, SessionProjectionRegistry, SystemPrompt, AgentRegistry, AgentLoop]) {
      const fiber = ctx.plugin(service);
      fibers.push(fiber);
      await fiber;
    }
    const instance = apply({ agents: ctx.agents, sessions: ctx.sessions, systemPrompt: ctx.systemPrompt,
      llm: ctx.llm, tools: ctx.tools, logger: { warn() {} }, get: ctx.get.bind(ctx), on: ctx.on.bind(ctx),
      effect(factory) { effects.push(factory()); } }, { storageDir: store.root });
    handle = await ctx.agents.create({ sessionId: 'native-maintenance-admission',
      agentOptions: { provider: 'synthetic', model: 'fake' } });
    handle.agent.session.append('user/message', createUserMessage({ source: { kind: 'user', plugin: 'im-qqbot' },
      content: [{ type: 'text', text: '原生维护通道测试' }] }), { surfaceOp: 'append' });
    await instance.engine.capture(handle.agent.session);
    held = handle.agent.runMaintenance(() => new Promise((resolve) => { release = resolve; }));
    assert.equal(handle.agent.status, 'idle');
    assert.throws(() => handle.agent.runMaintenance(async () => {}), /already has active work/);
    assert.equal((await instance.runScope(handle.agent.session.id, true)).reason, 'maintenance-busy');
    release();
    await held;
    held = undefined;
    assert.equal((await instance.runScope(handle.agent.session.id, true)).status, 'complete');
  } finally {
    release?.();
    await held;
    for (const dispose of effects) await dispose();
    await handle?.dispose();
    for (const fiber of fibers.reverse()) await fiber.dispose();
  }
});

test('empty native agent creation can later identify QQ ownership and captures all its user messages', async (t) => {
  const store = await fixture(t);
  const handlers = new Map();
  const effects = [];
  let modelCalls = 0;
  const ctx = { logger: { warn() {} }, agents: { get() {}, roots: () => [] }, sessions: { async flush() {} },
    tools: { register() {} }, systemPrompt: { context() {} }, get() {},
    llm: { async *stream() { modelCalls++; throw new Error('Independent Harness sessions must not use the memory model'); } },
    on(event, callback) { handlers.set(event, callback); }, effect(factory) { effects.push(factory()); },
  };
  const instance = apply(ctx, { storageDir: store.root });
  t.after(async () => { for (const dispose of effects) await dispose(); });
  const native = Session.create('late-native-qq');
  const agent = { session: native, status: 'idle' };
  await handlers.get('agent/created')({ agent });
  assert.deepEqual(await store.list(), []);
  native.append('user/message', createUserMessage({ source: { kind: 'user', plugin: 'im-qqbot' },
    content: [{ type: 'text', text: '创建空会话后的第一条 QQ 消息' }] }), { surfaceOp: 'append' });
  await handlers.get('agent/pre-step')({ agent, messages: native.deriveMessages() }, () => {});
  assert.equal((await store.load(native.id)).inbox.length, 1);
  native.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: '同一 QQ 会话中从 Harness 界面发送的消息' }] }), { surfaceOp: 'append' });
  for (let i = 0; i < 3; i++) {
    await handlers.get('agent/pre-step')({ agent, messages: native.deriveMessages() }, () => {});
  }
  const saved = await store.load(native.id);
  assert.equal(saved.channel, 'qq');
  assert.deepEqual(saved.inbox.map((item) => item.text),
    ['创建空会话后的第一条 QQ 消息', '同一 QQ 会话中从 Harness 界面发送的消息']);
  assert.equal(new Set(saved.inbox.map((item) => item.id)).size, 2);

  const group = Session.create('separate-native-qq-group');
  const groupAgent = { session: group, status: 'idle' };
  await handlers.get('agent/created')({ agent: groupAgent });
  group.append('user/message', createUserMessage({ source: { kind: 'user', plugin: 'im-qqbot' },
    content: [{ type: 'text', text: '独立 QQ 群的消息' }] }), { surfaceOp: 'append' });
  await handlers.get('agent/pre-step')({ agent: groupAgent, messages: group.deriveMessages() }, () => {});
  assert.deepEqual((await store.load(group.id)).inbox.map((item) => item.text), ['独立 QQ 群的消息']);
  assert.deepEqual((await store.load(native.id)).inbox, saved.inbox);

  const ordinary = Session.create('independent-native-harness');
  const ordinaryAgent = { session: ordinary, status: 'idle' };
  await handlers.get('agent/created')({ agent: ordinaryAgent });
  ordinary.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: '普通 Harness 会话的消息' }] }), { surfaceOp: 'append' });
  await handlers.get('agent/pre-step')({ agent: ordinaryAgent, messages: ordinary.deriveMessages() }, () => {});
  assert.equal(await instance.engine.capture(ordinary), false);
  assert.equal((await instance.runScope(ordinary.id, true)).status, 'ignored');
  assert.equal(modelCalls, 0);
  assert.deepEqual((await store.list()).map((state) => state.scope).sort(), [native.id, group.id].sort());
});

test('real native session replacement preserves persona and recent messages and replays identically', async () => {
  const session = history();
  const before = session.deriveMessages();
  const seqCount = session.seq;
  const state = { checkpoint: { digest: 'test-checkpoint' }, handoff: '明天继续修改项目报告。' };
  const result = await replaceContext(session, state, { retainTurns: 2 }, async () => {}, new AbortController().signal);
  assert.ok(result.replaced > 4);
  const after = session.deriveMessages();
  assert.equal(after[0].content[0].text, '始终保留的人格提示词');
  assert.equal(after[1].content[0].text, '必须保留的约束');
  assert.deepEqual(after.slice(-4), before.slice(-4));
  assert.ok(after.length < before.length);
  assert.ok(session.seq > seqCount); // Append-only native log remains recoverable.
  const restored = Session.create(session.id, session.snapshotEvents(), session.header);
  assert.deepEqual(restored.deriveMessages(), after);
});

test('failed flush is retried without duplicating a landed checkpoint', async () => {
  const session = history();
  const state = { checkpoint: { digest: 'retry-digest' }, handoff: '继续计划。' };
  await assert.rejects(replaceContext(session, state, { retainTurns: 2 }, async () => { throw new Error('disk error'); }));
  const length = session.seq;
  const retry = await replaceContext(session, state, { retainTurns: 2 }, async () => {});
  assert.equal(retry.recovered, true);
  assert.equal(session.seq, length);
});

test('short histories do not receive a larger summary', async () => {
  const session = Session.create('short');
  const before = session.seq;
  const result = await replaceContext(session, { checkpoint: { digest: 'd' }, handoff: '' }, { retainTurns: 2 }, async () => {});
  assert.equal(result.replaced, 0);
  assert.equal(session.seq, before);
  assert.equal(selectSpan(session), null);
});

test('SDK stream assembler refuses token-truncated distillation', async () => {
  const ctx = { get: () => ({ currentSelection: () => ({ provider: 'fake', model: 'fake' }) }), llm: {
    async *stream() {
      yield { type: 'text-delta', index: 0, text: '{"ops":[],"handoff":""}' };
      yield { type: 'finish', reason: { kind: 'max-tokens' } };
    },
  } };
  const agent = { session: { id: 'fake', requestHeader() {} } };
  await assert.rejects(generate(ctx, agent, '{}', { requestTimeoutMs: 1000, distillMaxTokens: 1000 }, new AbortController().signal), /normally/);
});

test('a provider abort caused by the request deadline is reported as a timeout', async () => {
  const ctx = { llm: { async *stream({ signal }) {
    await new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('synthetic timeout did not fire')), 1000);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('synthetic provider abort', 'AbortError'));
      }, { once: true });
    });
  } } };
  const agent = { session: { id: 'synthetic-timeout', requestHeader: () => ({ config: { provider: 'synthetic', model: 'fake' } }) } };
  await assert.rejects(generate(ctx, agent, '{}', { requestTimeoutMs: 10, distillMaxTokens: 1000 }, new AbortController().signal), { name: 'TimeoutError' });
});

test('native Cordis mounts the plugin and injects scoped memory without growing native history', async (t) => {
  const store = await fixture(t);
  const ctx = new Context();
  const definitions = new Map();
  ctx.provide('agents', { get() {}, roots: () => [] });
  ctx.provide('tools', { register(definition) { definitions.set(definition.name, definition); } });
  ctx.provide('llm', { async *stream() { throw new Error('This test must not call a provider'); } });
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, personaPrefix: '固定人格' });
  const fiber = ctx.plugin(plugin, { storageDir: store.root });
  await fiber;
  t.after(() => fiber.dispose());
  const session = ctx.sessions.create('native-qq');
  const message = createUserMessage({ source: { kind: 'user', plugin: 'im-qqbot' }, content: [{ type: 'text', text: '请记住，我叫小林' }] });
  session.append('user/message', message, { surfaceOp: 'append' });
  const agent = { session };
  await definitions.get('memory_save').execute({ content: '用户希望被称为小林', kind: 'core' }, { agent });
  const count = session.seq;
  for (let i = 0; i < 3; i++) {
    await ctx.waterfall('agent/pre-step', { agent, messages: [message] }, () => ({ kind: 'enter', messages: [message] }));
    const assembly = await ctx.systemPrompt.assemble({ agent });
    assert.ok(assembly.contexts.some((item) => item.name === plugin.name && item.text.includes('小林')));
    assert.ok(assembly.sections.some((item) => item.text === '固定人格'));
  }
  assert.equal(session.seq, count);
  const other = ctx.sessions.create('another-qq');
  const assembly = await ctx.systemPrompt.assemble({ agent: { session: other } });
  assert.ok(assembly.contexts.every((item) => !item.text.includes('小林')));
  await store.update('native-qq', (state) => {
    state.records.push({ ...state.records[0], id: 'legacy', kind: 'routine',
      content: 'project token ghp_abcdefghijklmnopqrstuvwxyz1234567890' });
  });
  const search = await definitions.get('memory_search').execute({ query: 'project token' }, { agent });
  assert.equal(search.text.includes('ghp_abcdefghijklmnopqrstuvwxyz1234567890'), false);
  assert.ok(search.text.includes('[敏感信息已隐藏]'));
  session.append('user/message', createUserMessage({
    source: { kind: 'plugin', plugin: plugin.name, form: 'notice', summary: '旧交接' },
    content: [{ type: 'text', text: '只在旧交接中出现的约定TARGET' }],
  }), { surfaceOp: 'append' });
  const saved = await store.load('native-qq');
  await definitions.get('memory_forget').execute({ id: saved.records[0].id }, { agent });
  assert.ok(session.deriveMessages().every((m) => !m.content.some((b) => b.text?.includes('TARGET'))));
  assert.ok(session.deriveMessages().some((m) => m.source.kind === 'user'));
  const forgottenAssembly = await ctx.systemPrompt.assemble({ agent });
  assert.ok(forgottenAssembly.contexts.every((item) => !item.text.includes('小林')));
});

test('native balanced-cut checks keep a crossing tool call and result together', () => {
  const session = history();
  const recent = [...session.surface.nodes].slice(-4);
  const old = session.surface.nodes[2];
  const call = session.append('assistant/message', { message: createAssistantMessage({
    source: { provider: 'fake', model: 'fake' }, content: [{ type: 'tool-call', id: 'lookup-1', name: 'lookup', arguments: '{}' }],
  }), turn: 8, step: 1, stream: [] }, { surfaceOp: 'append' });
  session.append('user/message', createUserMessage({ source: { kind: 'user', plugin: 'im-qqbot' }, content: [{ type: 'text', text: '工具执行中补充的消息' }] }), { surfaceOp: 'append' });
  session.append('tool/result', { message: createToolResultMessage({ callId: 'lookup-1', content: [{ type: 'text', text: 'result' }], isError: false }) }, { surfaceOp: 'append' });
  const span = selectSpan(session, 1);
  assert.ok(span.includes(old));
  assert.equal(span.includes(call.seq), false);
  assert.ok(recent.every((seq) => session.surface.nodes.includes(seq)));
});

test('full daily pipeline commits memory before context replacement and defers a busy agent', async (t) => {
  const store = await fixture(t);
  const native = history();
  const definitions = new Map();
  const effects = [];
  let calls = 0;
  let busy = false;
  const agent = { session: native, get status() { return busy ? 'running' : 'idle'; }, async runMaintenance(job) {
    if (busy) throw new Error('busy');
    busy = true;
    try { return await job(new AbortController().signal); } finally { busy = false; }
  } };
  const ctx = {
    logger: { warn() {} },
    agents: { get: (scope) => scope === native.id ? agent : undefined, roots: () => [] },
    sessions: { async flush() {} },
    llm: { async *stream(options) {
      calls++;
      const input = JSON.parse(options.messages[0].content[0].text);
      const source = input.observations.find((item) => item.role === 'user');
      const response = { ops: source ? [{ op: 'add', content: '用户希望保留重要约定', kind: 'core',
        emotion: 0, importance: 1, confidence: 1, sourceIds: [source.id] }] : [], handoff: '下一次继续完善报告。' };
      yield { type: 'text-delta', index: 0, text: JSON.stringify(response) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } },
    get: () => ({ currentSelection: () => ({ provider: 'fake', model: 'fake' }) }),
    tools: { register(tool) { definitions.set(tool.name, tool); } },
    systemPrompt: { context() {} }, on() {}, effect(factory) { effects.push(factory()); },
  };
  const result = apply(ctx, { storageDir: store.root });
  t.after(async () => { for (const dispose of effects) await dispose(); });
  await result.engine.capture(native);
  busy = true;
  assert.equal((await result.runScope(native.id, true)).status, 'deferred');
  assert.equal(calls, 0);
  busy = false;
  const size = native.surface.nodes.length;
  assert.equal((await result.runScope(native.id, true)).status, 'complete');
  const saved = await result.engine.store.load(native.id);
  assert.equal(saved.records[0].kind, 'core');
  assert.equal(saved.inbox.length, 0);
  assert.equal(saved.checkpoint, null);
  assert.ok(native.surface.nodes.length < size);
  assert.equal(native.id, 'synthetic-qq-user');
  const previousCalls = calls;
  assert.equal((await result.runScope(native.id)).status, 'up-to-date');
  assert.equal(calls, previousCalls);
  assert.ok(definitions.has('memory_run_daily'));
});

test('an evicted QQ session still consolidates at night and applies its checkpoint after reconnection', async (t) => {
  const store = await fixture(t);
  const native = history();
  let live;
  let calls = 0;
  const effects = [];
  const ctx = {
    logger: { warn() {} }, agents: { get: () => live, roots: () => [] }, sessions: { async flush() {} },
    tools: { register() {} }, systemPrompt: { context() {} }, on() {}, effect(fn) { effects.push(fn()); },
    get: () => ({ currentSelection: () => ({ provider: 'fake', model: 'fake' }) }),
    llm: { async *stream() { calls++; yield { type: 'text-delta', index: 0, text: '{"ops":[],"handoff":"明天继续写报告"}' };
      yield { type: 'finish', reason: { kind: 'stop' } }; } },
  };
  const pluginInstance = apply(ctx, { storageDir: store.root });
  t.after(async () => { for (const dispose of effects) await dispose(); });
  await pluginInstance.engine.capture(native);
  const result = await pluginInstance.runScope(native.id, true);
  assert.equal(result.status, 'context-pending');
  assert.ok((await store.load(native.id)).checkpoint);
  const afterNight = calls;
  assert.equal((await pluginInstance.runScope(native.id)).status, 'up-to-date');
  assert.equal(calls, afterNight);
  live = { session: native, status: 'idle', runMaintenance: (job) => job(new AbortController().signal) };
  assert.equal((await pluginInstance.runScope(native.id)).status, 'complete');
  assert.equal(calls, afterNight);
  assert.equal((await store.load(native.id)).checkpoint, null);
  assert.ok(native.deriveMessages().some((m) => m.source.plugin === plugin.name));
});

test('an expired handoff is replaced even when the surface is already compact', async () => {
  const native = history();
  await replaceContext(native, { checkpoint: { digest: 'old-handoff' }, handoff: '过期话题TARGET' }, { retainTurns: 2 }, async () => {});
  assert.equal(selectSpan(native, 2), null);
  await replaceContext(native, { checkpoint: { digest: 'new-handoff' }, handoff: '' }, { retainTurns: 2 }, async () => {});
  assert.ok(native.deriveMessages().every((m) => !m.content.some((b) => b.text?.includes('TARGET'))));
});

test('old recent messages are eligible for retirement after the raw-context age limit', () => {
  const native = history();
  const future = native.snapshotEvents().at(-1).time + 3 * 86400000;
  const span = selectSpan(native, 2, future, 48);
  assert.equal(span.at(-1), native.surface.nodes.at(-1));
  assert.equal(span.includes(native.surface.nodes[0]), false);
  assert.equal(span.includes(native.surface.nodes[1]), false);
});

for (const failure of ['crash-before-cleanup', 'flush-failure']) {
  test(`forget recovery after ${failure} clears stale native notices before the next step`, async (t) => {
    const store = await fixture(t);
    const native = history();
    const checkpoint = { checkpoint: { digest: failure }, handoff: '需要忘记的TARGET' };
    await replaceContext(native, checkpoint, { retainTurns: 2 }, async () => {});
    const persistedBeforeForget = native.snapshotEvents();
    const makeContext = (agent) => {
      const handlers = new Map();
      const effects = [];
      const ctx = { logger: { warn() {} }, agents: { get: () => agent, roots: () => [] }, sessions: { async flush() {} },
        tools: { register() {} }, systemPrompt: { context() {} }, llm: {}, get() {},
        on(event, callback) { handlers.set(event, callback); }, effect(fn) { effects.push(fn()); },
      };
      return { ctx, handlers, effects };
    };
    const first = makeContext(undefined);
    const initial = apply(first.ctx, { storageDir: store.root });
    await initial.engine.capture(native);
    await store.update(native.id, (s) => { s.records.push({ id: 'target', content: '需要忘记的TARGET', sourceIds: ['2:0'] }); });
    assert.equal(await initial.engine.forget(native.id, 'target'), true);
    if (failure === 'flush-failure') {
      await assert.rejects(forgetNotices(native, async () => { throw new Error('simulated disk failure'); }));
    }
    assert.equal((await store.load(native.id)).forgetNoticePending, true);
    for (const dispose of first.effects) await dispose();
    // Replay the pre-cleanup native log to model a process dying before the replacement reached disk.
    const restored = Session.create(native.id, persistedBeforeForget, native.header);
    const agent = { session: restored, status: 'idle', runMaintenance: (job) => job(new AbortController().signal) };
    const second = makeContext(agent);
    apply(second.ctx, { storageDir: store.root });
    try {
      await second.handlers.get('agent/created')({ agent });
      assert.equal((await store.load(native.id)).forgetNoticePending, false);
      assert.ok(restored.deriveMessages().every((m) => !m.content.some((b) => b.text?.includes('TARGET'))));
    } finally {
      for (const dispose of second.effects) await dispose();
    }
  });
}
