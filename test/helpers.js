import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { MemoryStore } from '../lib/store.js';

export async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-memory-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('dsh-memory-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  return new MemoryStore(directory);
}
