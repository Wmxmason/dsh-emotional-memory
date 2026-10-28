import test from 'node:test';
import assert from 'node:assert/strict';
import { containsKnownSecret, redact } from '../lib/secrets.js';
import { observations } from '../lib/engine.js';
import { parseDistillation } from '../lib/distill.js';

const SYNTHETIC = [
  'sk-abcdefghijklmnopqrstuvwxyz123456',
  'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
  'github_pat_abcdefghijklmnopqrstuvwxyz1234567890',
  'AKIAIOSFODNN7EXAMPLE',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c3ludGhldGljX3NpZ25hdHVyZQ',
  'password=hunter2', '验证码: 123456', 'api_key: synthetic-secret',
  'Bearer synthetic-token-123456',
  'password="correct horse battery staple"',
  "密码='多词口令 example secret'",
];

test('known credential patterns are refused in either automatic or explicit memory content', () => {
  const batch = [{ id: '1:0', role: 'user', text: '合成输入', time: 1 }];
  for (const content of SYNTHETIC) {
    assert.ok(containsKnownSecret(content));
    const raw = JSON.stringify({ ops: [{ op: 'add', content, kind: 'core', emotion: 0, importance: 1,
      confidence: 1, sourceIds: ['1:0'] }], handoff: '' });
    assert.throws(() => parseDistillation(raw, batch, { records: [] }), /refused/);
    const parsed = parseDistillation(JSON.stringify({ ops: [], handoff: content }), batch, { records: [] });
    assert.equal(parsed.handoff.includes(content), false);
  }
});

test('redaction occurs before chunk splitting, including tokens placed across a boundary', () => {
  for (const token of SYNTHETIC.slice(0, 5)) {
    const event = { seq: 1, time: 1, type: 'user/message', data: { source: { kind: 'user' },
      content: [{ type: 'text', text: 'x'.repeat(94) + ' ' + token + ' 继续聊天' }] } };
    const captured = observations([event], -1, 100).map((item) => item.text).join('');
    assert.equal(captured.includes(token), false);
    assert.ok(captured.includes('[敏感信息已隐藏]'));
  }
  assert.equal(redact('我希望回复简短一些'), '我希望回复简短一些');
});

test('quoted multi-word values and escaped quotes leave no credential suffix behind', () => {
  assert.equal(redact('password="correct horse battery staple"'), '[敏感信息已隐藏]');
  assert.equal(redact('password="correct \\"horse\\" battery staple"'), '[敏感信息已隐藏]');
  assert.equal(redact('password="unterminated secret words'), '[敏感信息已隐藏]');
});
