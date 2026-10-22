import crypto from 'node:crypto';

export function isAccountKey(value) {
  return typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value);
}

export function encryptAccountSecret(secret, accountId, encodedKey) {
  if (!isAccountKey(encodedKey)) throw new Error('A 32-byte account encryption key is required');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(encodedKey, 'hex'), iv);
  cipher.setAAD(Buffer.from(`sentinel-account:${accountId}`));
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptAccountSecret(value, accountId, encodedKey) {
  if (!isAccountKey(encodedKey) || typeof value !== 'string') throw new Error('Account secret is unavailable');
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Account secret is unavailable');
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    if (iv.length !== 12 || tag.length !== 16) throw new Error('invalid envelope');
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(encodedKey, 'hex'), iv);
    decipher.setAAD(Buffer.from(`sentinel-account:${accountId}`));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    // Do not include key, ciphertext, account identity, or cryptographic errors.
    throw new Error('Account secret is unavailable');
  }
}
