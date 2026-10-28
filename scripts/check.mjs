import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const file of await readdir(join(root, 'lib'))) {
  if (!file.endsWith('.js')) continue;
  const result = spawnSync(process.execPath, ['--check', join(root, 'lib', file)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('All plugin modules passed syntax checks.');
