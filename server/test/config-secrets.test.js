import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hashPassword } from '../src/lib/auth.js';

const configPath = fileURLToPath(new URL('../src/config.js', import.meta.url));

function loadConfig(overrides, field = 'adminKey', validate = false) {
  // Never read the developer's .env while checking default or missing secrets.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-config-source-'));
  const source = path.join(root, 'server/src');
  fs.mkdirSync(path.join(source, 'lib'), { recursive: true });
  for (const file of ['config.js', 'lib/auth.js', 'lib/account-secrets.js']) {
    fs.copyFileSync(path.join(path.dirname(configPath), file), path.join(source, file));
  }
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  const script = `import { config, assertConfigured } from ${JSON.stringify(pathToFileURL(path.join(source, 'config.js')).href)}; ${validate ? 'assertConfigured();' : ''} process.stdout.write(String(config.${field}));`;
  try { return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH || '',
      HOME: os.tmpdir(),
      SUB2API_BASE_URL: 'https://sub2api.example.test',
      ...overrides,
    },
  }); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('secret files load and ignore a trailing CRLF', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-secret-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const secretPath = path.join(dir, 'admin-key');
  fs.writeFileSync(secretPath, 'admin-from-file\r\n', { mode: 0o600 });

  const result = loadConfig({
    SUB2API_ADMIN_API_KEY: '',
    SUB2API_ADMIN_API_KEY_FILE: secretPath,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'admin-from-file');
});

test('a missing secret file fails configuration without exposing the system error', () => {
  const result = loadConfig({
    SUB2API_ADMIN_API_KEY: '',
    SUB2API_ADMIN_API_KEY_FILE: path.join(os.tmpdir(), 'sentinel-secret-does-not-exist'),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SUB2API_ADMIN_API_KEY_FILE could not be read/);
  assert.doesNotMatch(result.stderr, /ENOENT/);
});

test('a secret value and its _FILE alternative cannot both be set', () => {
  const result = loadConfig({
    SUB2API_ADMIN_API_KEY: 'admin-from-env',
    SUB2API_ADMIN_API_KEY_FILE: '/run/secrets/sub2api-admin-key',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SUB2API_ADMIN_API_KEY and SUB2API_ADMIN_API_KEY_FILE must not both be set/);
});

test('the managed-account encryption key supports a private _FILE source', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-account-key-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'key');
  fs.writeFileSync(file, 'ab'.repeat(32) + '\n', { mode: 0o600 });
  const result = loadConfig({ AUTH_REQUIRE_TOTP: 'true', SENTINEL_ACCOUNT_KEY_FILE: file }, 'auth.accountKey');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'ab'.repeat(32));
  const conflict = loadConfig({ AUTH_REQUIRE_TOTP: 'true', SENTINEL_ACCOUNT_KEY: 'cd'.repeat(32), SENTINEL_ACCOUNT_KEY_FILE: file });
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /SENTINEL_ACCOUNT_KEY and SENTINEL_ACCOUNT_KEY_FILE must not both be set/);
});

test('password-only startup is the default and needs neither MFA nor an account encryption key', () => {
  const values = {
    SUB2API_ADMIN_API_KEY: 'admin-synthetic-config-test', SENTINEL_ADMIN_USERNAME: 'admin',
    SENTINEL_ADMIN_PASSWORD_HASH: hashPassword('synthetic-config-password'),
    SENTINEL_ADMIN_TOTP_SECRET_FILE: '/nonexistent/old-totp', SENTINEL_ACCOUNT_KEY_FILE: '/nonexistent/old-account-key',
  };
  const result = loadConfig(values, 'auth.requireTotp', true);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'false');
  const optedIn = loadConfig({ ...values, AUTH_REQUIRE_TOTP: 'true' });
  assert.notEqual(optedIn.status, 0, 'opting in must still require valid, readable MFA secrets');
  assert.match(optedIn.stderr, /SENTINEL_ADMIN_TOTP_SECRET_FILE could not be read/);
  const typo = loadConfig({ AUTH_REQUIRE_TOTP: 'ture' });
  assert.notEqual(typo.status, 0);
  assert.match(typo.stderr, /AUTH_REQUIRE_TOTP must be a boolean/);
});
