#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output') {
  console.error('Usage: node server/src/generate-account-key.js --output ./secrets/account-key');
  process.exitCode = 1;
} else {
  try {
    const file = path.resolve(args[1]);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // Never overwrite: changing this key would make existing MFA secrets unreadable.
    fs.writeFileSync(file, `${crypto.randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
    console.error('Account encryption key created in a private file; keep a protected backup.');
  } catch {
    console.error('Cannot create account key; the file must not already exist and its parent must be writable.');
    process.exitCode = 1;
  }
}
