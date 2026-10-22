import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('the account key generator writes a private file without printing or overwriting the key', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-key-generator-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'secrets', 'account-key');
  const script = fileURLToPath(new URL('../src/generate-account-key.js', import.meta.url));
  const run = () => spawnSync(process.execPath, [script, '--output', file], { encoding: 'utf8' });
  const first = run();
  assert.equal(first.status, 0);
  const key = fs.readFileSync(file, 'utf8');
  assert.match(key, /^[a-f0-9]{64}\n$/);
  assert.equal(first.stdout, '');
  assert.equal(first.stderr.includes(key.trim()), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(run().status, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), key);
});
