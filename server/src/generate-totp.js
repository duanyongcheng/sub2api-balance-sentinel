#!/usr/bin/env node
import { generateTotpSecret } from './lib/auth.js';

const secret = generateTotpSecret();
const username = process.env.SENTINEL_ADMIN_USERNAME || 'admin';
const label = encodeURIComponent(`sub2api-balance-sentinel:${username}`);
const issuer = encodeURIComponent('sub2api-balance-sentinel');
const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;

console.log('One-time setup secret. Store it in SENTINEL_ADMIN_TOTP_SECRET and add it to an authenticator app:');
console.log(secret);
console.log('Provisioning URI (contains the secret; do not share it):');
console.log(uri);
