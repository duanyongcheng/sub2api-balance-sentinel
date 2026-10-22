#!/usr/bin/env node
import fs from 'node:fs';
import { hashPassword } from './lib/auth.js';

if (process.argv.length > 2) {
  console.error('Read the password from stdin; do not pass it as a command-line argument.');
  process.exit(1);
}
if (process.stdin.isTTY) {
  console.error('Read the password without echo, then pipe it into this command.');
  console.error("Example: read -r -s -p 'Password: ' password; printf '\\n'; printf '%s' \"$password\" | node server/src/hash-password.js");
  process.exit(1);
}
const password = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');

try {
  process.stdout.write(`${hashPassword(password)}\n`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
