import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MemoryStore } from '../lib/store.js';
import { fixture } from './helpers.js';

test('parallel writes to one scope retain all observations and cannot escape the store', async (t) => {
  const store = await fixture(t);
  const scope = '../../private-user';
  await Promise.all(Array.from({ length: 30 }, (_, id) => store.update(scope, (s) => { s.inbox.push({ id }); })));
  assert.equal((await store.load(scope)).inbox.length, 30);
  assert.equal(dirname(store.fileFor(scope)), join(store.root, 'scopes'));
  assert.equal(store.locks.size, 0);
});

test('separate QQ scopes never share records, even after opening a fresh store', async (t) => {
  const store = await fixture(t);
  await store.update('alice', (s) => { s.records.push({ content: 'Alice prefers tea' }); });
  await store.update('bob', (s) => { s.records.push({ content: 'Bob prefers coffee' }); });
  const reopened = new MemoryStore(store.root);
  assert.deepEqual((await reopened.load('alice')).records, [{ content: 'Alice prefers tea' }]);
  assert.deepEqual((await reopened.load('bob')).records, [{ content: 'Bob prefers coffee' }]);
});

test('a corrupt or mismatched file is rejected and never silently overwritten', async (t) => {
  const store = await fixture(t);
  await store.update('scope', () => {});
  const file = store.fileFor('scope');
  await writeFile(file, '{broken');
  await assert.rejects(store.update('scope', (s) => { s.records = []; }));
  assert.equal(await readFile(file, 'utf8'), '{broken');
  await writeFile(file, JSON.stringify({ version: 1, scope: 'different', records: [], inbox: [], archive: [] }));
  await assert.rejects(store.load('scope'), /Invalid memory state/);
});

test('a failed mutation leaves the previous durable state intact', async (t) => {
  const store = await fixture(t);
  await store.update('scope', (s) => { s.handoff = 'continue the unfinished task'; });
  await assert.rejects(store.update('scope', (s) => { s.handoff = 'lost'; throw new Error('failure'); }));
  assert.equal((await store.load('scope')).handoff, 'continue the unfinished task');
});

test('one corrupt scope is reported while healthy scopes are still enumerated', async (t) => {
  const store = await fixture(t);
  await store.update('good', () => {});
  await store.update('bad', () => {});
  await writeFile(store.fileFor('bad'), '{incomplete');
  const failures = [];
  assert.deepEqual((await store.list((name) => failures.push(name))).map((s) => s.scope), ['good']);
  assert.equal(failures.length, 1);
  assert.equal(await readFile(store.fileFor('bad'), 'utf8'), '{incomplete');
});
