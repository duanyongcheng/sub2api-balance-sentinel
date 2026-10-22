import crypto from 'node:crypto';
import { generateTotpSecret, hashPasswordAsync, newToken, normalizeUsername, sha256, verifyTotpCode } from './auth.js';
import { decryptAccountSecret, encryptAccountSecret, isAccountKey } from './account-secrets.js';

const ROLES = ['admin', 'operator', 'auditor'];
const INVITATION_TTL_MS = 30 * 60_000;
const validPassword = (value) => typeof value === 'string' && value.length >= 12 && value.length <= 1024;
const reject = (reason, status = 400) => ({ ok: false, reason, status });

export class AccountManager {
  constructor({ store, auth, accountKey = '' }) {
    this.store = store;
    this.auth = auth;
    this.accountKey = accountKey;
  }

  get enabled() { return !this.auth.requireTotp || isAccountKey(this.accountKey); }

  list(principal) {
    if (!this.auth.isCurrentPrincipal(principal, 'admin')) return reject('Administrator access required', 403);
    return {
      ok: true, accountManagementEnabled: this.enabled, accountKeyConfigured: isAccountKey(this.accountKey),
      totpRequired: this.auth.requireTotp,
      bootstrap: { username: this.auth.username, role: 'admin', bootstrap: true },
      items: this.store.authAccounts().map(publicAccount),
    };
  }

  create({ username, role = 'auditor' }, principal) {
    if (!this.enabled) return reject('SENTINEL_ACCOUNT_KEY must be configured before managing accounts', 503);
    const normalized = normalizeUsername(username);
    if (!normalized || !ROLES.includes(role)) return reject('A valid username and role are required');
    if (normalized === normalizeUsername(this.auth.username)) return reject('The bootstrap administrator username is reserved', 409);
    const id = crypto.randomUUID();
    const invitation = this.newInvitation(id);
    const result = this.store.createAuthAccount({
      id, username: normalized, role, actor: principal.username,
      totp_ciphertext: invitation.ciphertext,
      invitation_hash: sha256(invitation.token), invitation_expires_at: invitation.expiresAt,
    }, () => this.auth.isCurrentPrincipal(principal, 'admin'));
    return this.invitationResult(result, invitation);
  }

  update(id, { role, enabled, version }, principal) {
    if (!ROLES.includes(role) && role !== undefined) return reject('Invalid account role');
    if (enabled !== undefined && typeof enabled !== 'boolean') return reject('enabled must be a boolean');
    if (role === undefined && enabled === undefined) return reject('Specify a role or enabled state');
    if (!Number.isSafeInteger(version) || version < 1) return reject('The current account version is required');
    if (principal.account_id === id) return reject('Use a different administrator to change your own role or enabled state', 409);
    const account = this.store.getAuthAccount(id);
    if (!account) return reject('Account not found', 404);
    const result = this.store.updateAuthAccount({
      id, role: role ?? account.role, enabled: enabled ?? Boolean(account.enabled), version, actor: principal.username,
    }, () => this.auth.isCurrentPrincipal(principal, 'admin'));
    return result.ok ? { ok: true, account: publicAccount(result.account) } : reject(result.reason, 409);
  }

  reinvite(id, version, principal) {
    if (!this.enabled) return reject('SENTINEL_ACCOUNT_KEY must be configured before managing accounts', 503);
    if (!Number.isSafeInteger(version) || version < 1) return reject('The current account version is required');
    if (principal.account_id === id) return reject('Use a different administrator to reset your own credentials', 409);
    if (!this.store.getAuthAccount(id)) return reject('Account not found', 404);
    const invitation = this.newInvitation(id);
    const result = this.store.reinviteAuthAccount({
      id, version, actor: principal.username, totp_ciphertext: invitation.ciphertext,
      invitation_hash: sha256(invitation.token), invitation_expires_at: invitation.expiresAt,
    }, () => this.auth.isCurrentPrincipal(principal, 'admin'));
    return this.invitationResult(result, invitation);
  }

  startEnrollment(token, context = {}) {
    if (!this.takeEnrollmentAttempt(context)) return reject('Too many enrollment attempts', 429);
    const account = this.invitedAccount(token);
    if (!account) return reject('Invitation is invalid or expired', 401);
    const info = { ok: true, username: account.username, role: account.role,
      totpRequired: this.auth.requireTotp, expiresAt: account.invitation_expires_at };
    if (!this.auth.requireTotp) return info;
    let secret;
    try { secret = decryptAccountSecret(account.totp_ciphertext, account.id, this.accountKey); }
    catch { return reject('Invitation is unavailable; ask an administrator for a new invitation', 503); }
    const issuer = 'Sub2API Balance Sentinel';
    return {
      ...info, secret,
      otpAuthUri: `otpauth://totp/${encodeURIComponent(`${issuer}:${account.username}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`,
    };
  }

  async finishEnrollment({ token, password, otp }, context = {}) {
    if (!this.takeEnrollmentAttempt(context)) return reject('Too many enrollment attempts', 429);
    if (!validPassword(password)) return reject('Password must contain 12 to 1024 characters');
    const account = this.invitedAccount(token);
    if (!account) return reject('Invitation is invalid or expired', 401);
    let counter = null;
    if (this.auth.requireTotp) {
      try {
        const secret = decryptAccountSecret(account.totp_ciphertext, account.id, this.accountKey);
        counter = verifyTotpCode(secret, otp, Date.now(), account.last_totp_counter);
      } catch { return reject('Invitation is unavailable; ask an administrator for a new invitation', 503); }
      if (counter === null) return reject('Invalid dynamic code', 401);
    }
    if (this.auth.activeChecks >= 2) return reject('Credential verification is busy; retry shortly', 429);
    this.auth.activeChecks += 1;
    let passwordHash;
    try { passwordHash = await hashPasswordAsync(password); }
    finally { this.auth.activeChecks -= 1; }
    const result = this.store.enrollAuthAccount({
      id: account.id, version: account.credential_version,
      invitation_hash: sha256(token), password_hash: passwordHash, counter,
    });
    return result.ok ? { ok: true, username: result.account.username } : reject(result.reason, 401);
  }

  async changePassword(principal, newPassword) {
    if (!principal.account_id) return reject('The bootstrap password is managed through the protected server configuration', 409);
    if (!validPassword(newPassword)) return reject('Password must contain 12 to 1024 characters');
    if (this.auth.activeChecks >= 2) return reject('Credential verification is busy; retry shortly', 429);
    this.auth.activeChecks += 1;
    let passwordHash;
    try { passwordHash = await hashPasswordAsync(newPassword); }
    finally { this.auth.activeChecks -= 1; }
    const result = this.store.changeAccountPassword({
      id: principal.account_id, version: principal.account_version, passwordHash, actor: principal.username,
    }, () => this.auth.isCurrentPrincipal(principal));
    return result.ok ? result : reject(result.reason, 409);
  }

  newInvitation(accountId) {
    return {
      token: newToken(), expiresAt: new Date(Date.now() + INVITATION_TTL_MS).toISOString(),
      ciphertext: this.auth.requireTotp ? encryptAccountSecret(generateTotpSecret(), accountId, this.accountKey) : '',
    };
  }

  invitationResult(result, invitation) {
    if (!result.ok) return reject(result.reason, 409);
    // The bearer invitation is returned only by the creating/resetting action.
    return { ok: true, account: publicAccount(result.account), enrollmentToken: invitation.token, expiresAt: invitation.expiresAt };
  }

  invitedAccount(token) {
    if (!this.enabled || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const account = this.store.invitationAccount(sha256(token));
    return account && !account.enabled && Date.parse(account.invitation_expires_at) > Date.now() ? account : null;
  }

  takeEnrollmentAttempt(context) {
    return this.store.consumeLoginAttempt(sha256(`enrollment:${context.ip || 'unknown'}`), Date.now(), this.auth.loginWindowMs, 20);
  }
}

function publicAccount(account) {
  return {
    id: account.id, username: account.username, role: account.role, enabled: Boolean(account.enabled),
    status: account.invitation_hash ? 'invited' : account.enabled ? 'active' : 'disabled',
    version: account.credential_version, enrolledAt: account.enrolled_at,
    invitationExpiresAt: account.invitation_expires_at,
    createdAt: account.created_at, updatedAt: account.updated_at, createdBy: account.created_by,
  };
}
