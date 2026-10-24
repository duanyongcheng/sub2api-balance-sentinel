import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { InstanceBindingError, instanceIdentity, compatibleRecordedTarget } from '../lib/instance.js';

const INSTANCE_BINDING_KEY = 'instance_binding';

const SCHEMA = `
-- Users under supervision. Whitelist by explicit id: nothing is topped up unless
-- it appears here, so a bug in the monitor loop cannot touch the whole site.
CREATE TABLE IF NOT EXISTS monitored_users (
  user_id        INTEGER PRIMARY KEY,
  email          TEXT,
  username       TEXT,
  threshold      REAL    NOT NULL,          -- top up when balance < threshold
  amount         REAL    NOT NULL,          -- how much to add per event
  enabled        INTEGER NOT NULL DEFAULT 1,
  mode           TEXT    NOT NULL DEFAULT 'auto', -- auto | approval (approval = needs operator OK)
  rule_revision  TEXT    NOT NULL DEFAULT '',
  note           TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

-- Top-ups the sentinel wants to make but has NOT executed, because the user is
-- in 'approval' mode. Nothing is written to sub2api until an operator approves.
-- Keeping this separate from topup_records means the ledger only ever contains
-- money that actually moved.
CREATE TABLE IF NOT EXISTS proposals (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL,
  email        TEXT,
  balance_at_proposal REAL,
  threshold_at_time   REAL NOT NULL,
  amount       REAL NOT NULL,
  rule_revision TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL,               -- pending | processing | approved | rejected | expired
  decided_at   TEXT,
  decided_note TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status, created_at DESC);

-- The ledger. One row per top-up *attempt*; status tells you whether money moved.
-- Ambiguous outcomes (timeout / 5xx) are kept as 'unknown' rather than guessed,
-- because a wrong 'failed' would silently under-charge the customer.
CREATE TABLE IF NOT EXISTS topup_records (
  id                TEXT PRIMARY KEY,       -- our idempotency key for sub2api
  user_id           INTEGER NOT NULL,
  email             TEXT,
  balance_before    REAL,
  balance_after     REAL,                   -- read back from sub2api after the write
  amount            REAL NOT NULL,
  threshold_at_time REAL NOT NULL,
  status            TEXT NOT NULL,          -- pending | success | failed | unknown
  source            TEXT NOT NULL,          -- auto | manual
  idempotent_replay INTEGER NOT NULL DEFAULT 0,
  sub2api_status    INTEGER,                -- HTTP status
  provider_reference TEXT,                  -- optional sub2api transaction/adjustment id
  provider_origin   TEXT,
  proposal_id       TEXT,
  actor             TEXT,                   -- operator username or system/cli
  error             TEXT,
  reconciled        INTEGER NOT NULL DEFAULT 0,
  reconciled_at     TEXT,
  reconciled_by     TEXT,
  reconcile_note    TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_topup_user_created
  ON topup_records(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_topup_status
  ON topup_records(status, created_at DESC);

-- Evidence is append-only: a later check never erases an earlier discrepancy
-- or the original outcome of a manually resolved attempt.
CREATE TABLE IF NOT EXISTS ledger_checks (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  id                TEXT NOT NULL UNIQUE,
  topup_id          TEXT NOT NULL REFERENCES topup_records(id),
  kind              TEXT NOT NULL CHECK (kind IN ('verification', 'resolution_applied')),
  outcome           TEXT NOT NULL CHECK (outcome IN ('matched', 'not_found', 'mismatch', 'incomplete', 'error')),
  previous_status   TEXT NOT NULL,
  actor             TEXT NOT NULL,
  summary           TEXT NOT NULL,
  provider_reference TEXT,
  evidence_json     TEXT NOT NULL,
  evidence_sha256   TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_checks_topup ON ledger_checks(topup_id, seq DESC);
CREATE TRIGGER IF NOT EXISTS ledger_checks_no_update BEFORE UPDATE ON ledger_checks
BEGIN SELECT RAISE(ABORT, 'ledger checks are append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_checks_no_delete BEFORE DELETE ON ledger_checks
BEGIN SELECT RAISE(ABORT, 'ledger checks are append-only'); END;

-- Cross-process lock so the web server and a cron CLI cannot credit the same
-- user concurrently. A stale lock is reclaimable after the request timeout.
CREATE TABLE IF NOT EXISTS topup_locks (
  user_id     INTEGER PRIMARY KEY,
  token       TEXT NOT NULL,
  acquired_at TEXT NOT NULL
);

-- Append-only narration of what the sentinel saw and did. Never rewritten.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  level      TEXT NOT NULL,                 -- info | warn | error
  user_id    INTEGER,
  actor      TEXT,
  kind       TEXT NOT NULL,
  message    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_at ON events(at DESC);

-- Key/value store for runtime switches (kill switch, circuit breaker state).
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Browser sessions. Only token digests are stored; the bearer token itself
-- exists only in the HttpOnly cookie held by the operator's browser.
CREATE TABLE IF NOT EXISTS auth_sessions (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  csrf_hash     TEXT NOT NULL,
  username      TEXT NOT NULL,
  account_id    TEXT,
  account_version INTEGER,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  ip            TEXT,
  user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_token ON auth_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS auth_accounts (
  id                    TEXT PRIMARY KEY,
  username              TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role                  TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'auditor')),
  enabled               INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  password_hash         TEXT,
  totp_ciphertext       TEXT NOT NULL,
  last_totp_counter     INTEGER NOT NULL DEFAULT -1,
  credential_version    INTEGER NOT NULL DEFAULT 1,
  invitation_hash       TEXT UNIQUE,
  invitation_expires_at TEXT,
  enrolled_at           TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  created_by            TEXT NOT NULL
);

-- Prevent reuse of a TOTP code after it has authenticated once.
CREATE TABLE IF NOT EXISTS auth_totp_state (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  last_counter INTEGER NOT NULL DEFAULT -1
);
INSERT OR IGNORE INTO auth_totp_state (id, last_counter) VALUES (1, -1);

CREATE TABLE IF NOT EXISTS auth_login_attempts (
  ip_hash          TEXT PRIMARY KEY,
  window_started_ms INTEGER NOT NULL,
  attempts         INTEGER NOT NULL,
  updated_at       TEXT NOT NULL
);
`;

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  // The DB contains account identifiers, auth-session digests, and the
  // bookkeeping ledger. Keep the DB and SQLite's WAL/SHM sidecars private.
  process.umask(0o077);
  const db = new Database(dbPath);
  fs.chmodSync(dbPath, 0o600);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    if (fs.existsSync(sidecar)) fs.chmodSync(sidecar, 0o600);
  }
  migrate(db);
  return db;
}

/**
 * Additive migrations for databases created by an earlier version.
 * SQLite cannot add a NOT NULL column without a default, so these are simple
 * idempotent ALTERs. Existing users keep the permissive-but-supervised 'auto'
 * mode they were created under.
 */
function migrate(db) {
  const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols('monitored_users').includes('mode')) {
    db.exec("ALTER TABLE monitored_users ADD COLUMN mode TEXT NOT NULL DEFAULT 'auto'");
  }
  if (!cols('monitored_users').includes('rule_revision')) {
    db.exec("ALTER TABLE monitored_users ADD COLUMN rule_revision TEXT NOT NULL DEFAULT ''");
  }
  if (!cols('proposals').includes('rule_revision')) {
    db.exec("ALTER TABLE proposals ADD COLUMN rule_revision TEXT NOT NULL DEFAULT ''");
  }
  db.exec("UPDATE monitored_users SET rule_revision = lower(hex(randomblob(16))) WHERE rule_revision = ''");
  // Older proposals have no provable link to the currently authorized rule.
  db.exec("UPDATE proposals SET status = 'expired', decided_note = 'rule revision unavailable; create a new proposal', decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE status = 'pending' AND rule_revision = ''");
  if (!cols('topup_records').includes('provider_reference')) {
    db.exec('ALTER TABLE topup_records ADD COLUMN provider_reference TEXT');
  }
  if (!cols('topup_records').includes('actor')) db.exec('ALTER TABLE topup_records ADD COLUMN actor TEXT');
  if (!cols('topup_records').includes('proposal_id')) db.exec('ALTER TABLE topup_records ADD COLUMN proposal_id TEXT');
  if (!cols('topup_records').includes('provider_origin')) db.exec('ALTER TABLE topup_records ADD COLUMN provider_origin TEXT');
  if (!cols('topup_records').includes('reconciled_by')) db.exec('ALTER TABLE topup_records ADD COLUMN reconciled_by TEXT');
  if (!cols('events').includes('actor')) db.exec('ALTER TABLE events ADD COLUMN actor TEXT');
  if (!cols('auth_sessions').includes('account_id')) db.exec('ALTER TABLE auth_sessions ADD COLUMN account_id TEXT');
  if (!cols('auth_sessions').includes('account_version')) db.exec('ALTER TABLE auth_sessions ADD COLUMN account_version INTEGER');
}

const now = () => new Date().toISOString();

export function createStore(db, { instance = null } = {}) {
  const bindingTarget = instance;
  const ledgerSelect = `SELECT r.*,
    (SELECT outcome FROM ledger_checks WHERE topup_id = r.id AND kind = 'verification' ORDER BY seq DESC LIMIT 1) AS verification_status,
    (SELECT created_at FROM ledger_checks WHERE topup_id = r.id AND kind = 'verification' ORDER BY seq DESC LIMIT 1) AS verified_at
    FROM topup_records r`;
  const stmt = {
    listUsers: db.prepare('SELECT * FROM monitored_users ORDER BY user_id'),
    getUsers: db.prepare('SELECT * FROM monitored_users WHERE enabled = 1'),
    getUser: db.prepare('SELECT * FROM monitored_users WHERE user_id = ?'),
    upsertUser: db.prepare(`
      INSERT INTO monitored_users (user_id, email, username, threshold, amount, enabled, mode, note, rule_revision, created_at, updated_at)
      VALUES (@user_id, @email, @username, @threshold, @amount, @enabled, @mode, @note, @rule_revision, @ts, @ts)
      ON CONFLICT(user_id) DO UPDATE SET
        email = excluded.email,
        username = COALESCE(excluded.username, monitored_users.username),
        threshold = excluded.threshold,
        amount = excluded.amount,
        enabled = excluded.enabled,
        mode = excluded.mode,
        note = excluded.note,
        rule_revision = excluded.rule_revision,
        updated_at = excluded.updated_at
    `),
    deleteUser: db.prepare('DELETE FROM monitored_users WHERE user_id = ?'),
    updateUserIdentity: db.prepare('UPDATE monitored_users SET email = ?, username = COALESCE(?, username) WHERE user_id = ?'),

    insertProposal: db.prepare(`
      INSERT INTO proposals
        (id, user_id, email, balance_at_proposal, threshold_at_time, amount, rule_revision, status, created_at, updated_at)
      VALUES (@id, @user_id, @email, @balance, @threshold, @amount, @rule_revision, 'pending', @ts, @ts)
    `),
    getProposal: db.prepare('SELECT * FROM proposals WHERE id = ?'),
    pendingProposalForUser: db.prepare(`
      SELECT * FROM proposals WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1
    `),
    listProposals: db.prepare(`
      SELECT * FROM proposals WHERE (@status IS NULL OR status = @status) ORDER BY created_at DESC LIMIT @limit
    `),
    decideProposal: db.prepare(`
      UPDATE proposals SET status = @status, decided_at = @ts, decided_note = @note, updated_at = @ts
      WHERE id = @id AND status = 'pending'
    `),
    claimProposal: db.prepare(`
      UPDATE proposals SET status = 'processing', updated_at = @ts
      WHERE id = @id AND status = 'pending'
    `),
    completeProposal: db.prepare(`
      UPDATE proposals SET status = @status, decided_at = @ts, decided_note = @note, updated_at = @ts
      WHERE id = @id AND status = 'processing'
    `),
    reopenProposal: db.prepare(`
      UPDATE proposals SET status = 'pending', decided_at = NULL, decided_note = @note, updated_at = @ts
      WHERE id = @id AND status = 'processing'
    `),
    expireProposalsForUser: db.prepare(`
      UPDATE proposals SET status = 'expired', decided_at = @ts, decided_note = @note, updated_at = @ts
      WHERE user_id = @user_id AND status = 'pending'
    `),

    insertTopup: db.prepare(`
      INSERT INTO topup_records
        (id, user_id, email, balance_before, amount, threshold_at_time, status, source, actor, proposal_id, provider_origin, created_at, updated_at)
      VALUES
        (@id, @user_id, @email, @balance_before, @amount, @threshold, 'pending', @source, @actor, @proposal_id, @provider_origin, @ts, @ts)
    `),
    finishTopup: db.prepare(`
      UPDATE topup_records SET
        status = @status,
        balance_after = @balance_after,
        idempotent_replay = @idempotent_replay,
        sub2api_status = @sub2api_status,
        provider_reference = @provider_reference,
        actor = @actor,
        error = @error,
        updated_at = @ts
      WHERE id = @id AND status = 'pending'
    `),
    getTopup: db.prepare(`${ledgerSelect} WHERE r.id = ?`),
    recentTopups: db.prepare(`
      ${ledgerSelect}
      WHERE (@user_id IS NULL OR user_id = @user_id)
        AND (@status IS NULL OR status = @status OR (@status = 'unresolved' AND status IN ('pending', 'unknown')))
      ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset
    `),
    countTopupRecords: db.prepare(`
      SELECT COUNT(*) AS total FROM topup_records
      WHERE (@user_id IS NULL OR user_id = @user_id)
        AND (@status IS NULL OR status = @status OR (@status = 'unresolved' AND status IN ('pending', 'unknown')))
    `),
    exportTopups: db.prepare(`
      ${ledgerSelect}
      WHERE (@user_id IS NULL OR user_id = @user_id)
        AND (@status IS NULL OR status = @status OR (@status = 'unresolved' AND status IN ('pending', 'unknown')))
      ORDER BY created_at ASC, id ASC
    `),
    countTopupsSince: db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total
      FROM topup_records
      WHERE status IN ('pending','success','unknown') AND created_at >= ?
        AND (@user_id IS NULL OR user_id = @user_id)
    `),
    lastTopupForUser: db.prepare(`
      SELECT * FROM topup_records
      WHERE user_id = ? AND status IN ('pending','success','unknown')
      ORDER BY created_at DESC LIMIT 1
    `),
    unresolvedTopupForUser: db.prepare("SELECT id FROM topup_records WHERE user_id = ? AND status IN ('pending', 'unknown') LIMIT 1"),
    markReconciled: db.prepare(`
      UPDATE topup_records SET reconciled = 1, reconciled_at = @ts, reconciled_by = @actor, reconcile_note = @note, updated_at = @ts
      WHERE id = @id AND status = 'success' AND reconciled = 0
    `),
    unreconciled: db.prepare(`
      ${ledgerSelect}
      WHERE status = 'success' AND reconciled = 0
      ORDER BY created_at ASC
    `),
    insertLedgerCheck: db.prepare(`
      INSERT INTO ledger_checks (id, topup_id, kind, outcome, previous_status, actor, summary,
        provider_reference, evidence_json, evidence_sha256, created_at)
      VALUES (@id, @topup_id, @kind, @outcome, @previous_status, @actor, @summary,
        @provider_reference, @evidence_json, @evidence_sha256, @ts)
    `),
    getLedgerCheck: db.prepare('SELECT * FROM ledger_checks WHERE id = ?'),
    latestVerification: db.prepare("SELECT * FROM ledger_checks WHERE topup_id = ? AND kind = 'verification' ORDER BY seq DESC LIMIT 1"),
    ledgerChecks: db.prepare('SELECT * FROM ledger_checks WHERE topup_id = ? ORDER BY seq DESC LIMIT 100'),
    exportLedgerChecks: db.prepare('SELECT * FROM ledger_checks WHERE topup_id = ? ORDER BY seq ASC'),
    resolveApplied: db.prepare(`
      UPDATE topup_records SET status = 'success', provider_reference = @reference, updated_at = @ts
      WHERE id = @id AND status IN ('pending', 'unknown', 'failed')
    `),
    providerReferenceUsed: db.prepare("SELECT id FROM topup_records WHERE id != ? AND provider_reference = ? AND status = 'success' LIMIT 1"),

    insertEvent: db.prepare(`
      INSERT INTO events (at, level, user_id, actor, kind, message) VALUES (?, ?, ?, ?, ?, ?)
    `),
    recentEvents: db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?'),

    getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    setSetting: db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `),

    createAuthSession: db.prepare(`
      INSERT INTO auth_sessions
        (id, token_hash, csrf_hash, username, account_id, account_version, created_at, last_seen_at, expires_at, ip, user_agent)
      VALUES (@id, @token_hash, @csrf_hash, @username, @account_id, @account_version, @created_at, @created_at, @expires_at, @ip, @user_agent)
    `),
    getAuthSession: db.prepare('SELECT * FROM auth_sessions WHERE token_hash = ?'),
    getAuthSessionById: db.prepare('SELECT * FROM auth_sessions WHERE id = ?'),
    touchAuthSession: db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL'),
    rotateAuthCsrf: db.prepare('UPDATE auth_sessions SET csrf_hash = ? WHERE id = ? AND revoked_at IS NULL'),
    revokeAuthSession: db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'),
    revokeAllAuthSessions: db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE revoked_at IS NULL'),
    purgeAuthSessions: db.prepare('DELETE FROM auth_sessions WHERE expires_at < ? OR revoked_at IS NOT NULL'),
    lastTotpCounter: db.prepare('SELECT last_counter FROM auth_totp_state WHERE id = 1'),
    consumeTotpCounter: db.prepare('UPDATE auth_totp_state SET last_counter = ? WHERE id = 1 AND last_counter < ?'),
    authAccounts: db.prepare('SELECT * FROM auth_accounts ORDER BY created_at, username'),
    getAuthAccount: db.prepare('SELECT * FROM auth_accounts WHERE id = ?'),
    findAuthAccount: db.prepare('SELECT * FROM auth_accounts WHERE username = ? COLLATE NOCASE'),
    invitationAccount: db.prepare('SELECT * FROM auth_accounts WHERE invitation_hash = ?'),
    authAccountCount: db.prepare('SELECT COUNT(*) AS n FROM auth_accounts'),
    insertAuthAccount: db.prepare(`
      INSERT INTO auth_accounts (id, username, role, totp_ciphertext, invitation_hash, invitation_expires_at, created_at, updated_at, created_by)
      VALUES (@id, @username, @role, @totp_ciphertext, @invitation_hash, @invitation_expires_at, @ts, @ts, @actor)
    `),
    updateAuthAccount: db.prepare(`
      UPDATE auth_accounts SET role = @role, enabled = @enabled, credential_version = credential_version + 1,
        invitation_hash = NULL, invitation_expires_at = NULL, updated_at = @ts
      WHERE id = @id AND credential_version = @version
    `),
    reinviteAuthAccount: db.prepare(`
      UPDATE auth_accounts SET enabled = 0, password_hash = NULL, totp_ciphertext = @totp_ciphertext,
        last_totp_counter = -1, credential_version = credential_version + 1,
        invitation_hash = @invitation_hash, invitation_expires_at = @invitation_expires_at,
        enrolled_at = NULL, updated_at = @ts
      WHERE id = @id AND credential_version = @version
    `),
    enrollAuthAccount: db.prepare(`
      UPDATE auth_accounts SET password_hash = @password_hash, enabled = 1, enrolled_at = @ts,
        invitation_hash = NULL, invitation_expires_at = NULL, last_totp_counter = COALESCE(@counter, last_totp_counter),
        credential_version = credential_version + 1, updated_at = @ts
      WHERE id = @id AND credential_version = @version AND invitation_hash = @invitation_hash
        AND invitation_expires_at > @ts AND enabled = 0 AND (@counter IS NULL OR last_totp_counter < @counter)
    `),
    consumeAccountTotp: db.prepare(`
      UPDATE auth_accounts SET last_totp_counter = @counter
      WHERE id = @id AND enabled = 1 AND enrolled_at IS NOT NULL
        AND credential_version = @version AND last_totp_counter < @counter
    `),
    changeAccountPassword: db.prepare(`
      UPDATE auth_accounts SET password_hash = @password_hash, credential_version = credential_version + 1, updated_at = @ts
      WHERE id = @id AND enabled = 1 AND credential_version = @version
    `),
    revokeAccountSessions: db.prepare('UPDATE auth_sessions SET revoked_at = @ts WHERE account_id = @id AND revoked_at IS NULL'),
    acquireTopupLock: db.prepare(`
      INSERT INTO topup_locks (user_id, token, acquired_at)
      VALUES (@user_id, @token, @acquired_at)
      ON CONFLICT(user_id) DO UPDATE SET token = excluded.token, acquired_at = excluded.acquired_at
      WHERE topup_locks.acquired_at < @stale_before
    `),
    releaseTopupLock: db.prepare('DELETE FROM topup_locks WHERE user_id = @user_id AND token = @token'),
    acquireGlobalTopupLock: db.prepare(`
      INSERT INTO topup_locks (user_id, token, acquired_at) VALUES (0, @token, @acquired_at)
      ON CONFLICT(user_id) DO UPDATE SET token = excluded.token, acquired_at = excluded.acquired_at
      WHERE topup_locks.acquired_at < @stale_before
    `),
    releaseGlobalTopupLock: db.prepare('DELETE FROM topup_locks WHERE user_id = 0 AND token = ?'),
    ownsTopupLock: db.prepare('SELECT COUNT(*) AS n FROM topup_locks WHERE user_id IN (0, @user_id) AND token = @token'),
    getConsecutiveFailures: db.prepare("SELECT CAST(value AS INTEGER) AS value FROM settings WHERE key = 'consecutive_failures'"),
    incrementConsecutiveFailures: db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('consecutive_failures', '1', @ts)
      ON CONFLICT(key) DO UPDATE SET value = CAST(settings.value AS INTEGER) + 1, updated_at = excluded.updated_at
    `),
    resetConsecutiveFailures: db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('consecutive_failures', '0', @ts)
      ON CONFLICT(key) DO UPDATE SET value = '0', updated_at = excluded.updated_at
    `),
    consumeLoginAttempt: db.prepare(`
      INSERT INTO auth_login_attempts (ip_hash, window_started_ms, attempts, updated_at)
      VALUES (@ip_hash, @now_ms, 1, @ts)
      ON CONFLICT(ip_hash) DO UPDATE SET
        window_started_ms = CASE WHEN auth_login_attempts.window_started_ms + @window_ms <= @now_ms THEN @now_ms ELSE auth_login_attempts.window_started_ms END,
        attempts = CASE WHEN auth_login_attempts.window_started_ms + @window_ms <= @now_ms THEN 1 ELSE auth_login_attempts.attempts + 1 END,
        updated_at = excluded.updated_at
      WHERE auth_login_attempts.window_started_ms + @window_ms <= @now_ms OR auth_login_attempts.attempts < @max_attempts
    `),
    clearLoginAttempts: db.prepare('DELETE FROM auth_login_attempts WHERE ip_hash = ?'),
  };

  function bindingStatus(target = bindingTarget) {
    let configured;
    try { configured = instanceIdentity(target); } catch {
      return { ok: false, status: 'invalid', reason: 'A valid configured Sub2API instance identity is required' };
    }
    const row = stmt.getSetting.get(INSTANCE_BINDING_KEY);
    if (!row) return { ok: false, status: 'unbound', configured, reason: 'Ledger is unbound; confirm the existing instance locally with writes disabled' };
    let expected;
    try {
      const saved = JSON.parse(row.value);
      if (saved.version !== 1 || typeof saved.baseUrl !== 'string' || typeof saved.instanceId !== 'string') throw new Error();
      expected = instanceIdentity(saved);
    } catch {
      return { ok: false, status: 'invalid', configured, reason: 'Ledger instance binding is invalid; refusing upstream operations' };
    }
    const ok = expected.baseUrl === configured.baseUrl && expected.instanceId === configured.instanceId;
    return { ok, status: ok ? 'bound' : 'mismatch', expected, configured,
      ...(ok ? {} : { reason: 'Configured Sub2API instance differs from this ledger; refusing upstream operations' }) };
  }

  function assertBinding(target = bindingTarget) {
    const status = bindingStatus(target);
    if (!status.ok) throw new InstanceBindingError(status.reason);
    return status.configured;
  }

  function writeUser(params) {
    stmt.upsertUser.run({
      user_id: params.userId, email: params.email ?? null, username: params.username ?? null,
      threshold: params.threshold, amount: params.amount, enabled: params.enabled === undefined || params.enabled ? 1 : 0,
      mode: params.mode === 'approval' ? 'approval' : 'auto', note: params.note ?? null,
      rule_revision: crypto.randomUUID(), ts: now(),
    });
    stmt.expireProposalsForUser.run({ user_id: params.userId, note: 'monitoring rule changed', ts: now() });
    return stmt.getUser.get(params.userId);
  }

  function ruleAuthorization({ instance, authorizeActor } = {}) {
    assertBinding(instance);
    return !authorizeActor || authorizeActor()
      ? null : { ok: false, status: 403, reason: 'operator authorization changed' };
  }

  const store = {
    instanceBindingStatus: bindingStatus,
    assertInstanceBinding: assertBinding,
    ensureInstanceBinding(target) {
      return db.transaction(() => {
        const status = bindingStatus(target);
        if (status.status !== 'unbound') return status;
        const nonempty = ['monitored_users', 'proposals', 'topup_records', 'ledger_checks', 'events', 'settings',
          'topup_locks', 'auth_sessions', 'auth_accounts', 'auth_login_attempts']
          .some((table) => db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) ||
          stmt.lastTotpCounter.get().last_counter !== -1;
        if (nonempty) return status;
        stmt.setSetting.run(INSTANCE_BINDING_KEY, JSON.stringify({ version: 1, ...status.configured }), now());
        return bindingStatus(target);
      }).immediate();
    },
    confirmInstanceBinding(target, { writesEnabled, confirmation } = {}) {
      return db.transaction(() => {
        const identity = instanceIdentity(target);
        if (writesEnabled !== false || confirmation !== identity.baseUrl) {
          throw new InstanceBindingError('Binding requires AUTO_TOPUP_ENABLED=false and explicit confirmation of the full canonical base URL');
        }
        const status = bindingStatus(target);
        if (status.status !== 'unbound') {
          if (!status.ok) throw new InstanceBindingError(status.reason);
          return status;
        }
        const origins = db.prepare('SELECT DISTINCT provider_origin FROM topup_records WHERE provider_origin IS NOT NULL').all();
        if (origins.some((r) => !compatibleRecordedTarget(r.provider_origin, identity))) {
          throw new InstanceBindingError('Historical attempts reference a different Sub2API instance; binding refused');
        }
        stmt.setSetting.run(INSTANCE_BINDING_KEY, JSON.stringify({ version: 1, ...identity }), now());
        stmt.insertEvent.run(now(), 'warn', null, 'cli', 'instance_bound', 'Legacy ledger instance confirmed locally with money writes disabled');
        return bindingStatus(target);
      }).immediate();
    },
    // ---- monitored users ----
    listUsers: () => stmt.listUsers.all(),
    enabledUsers: () => stmt.getUsers.all(),
    getUser: (id) => stmt.getUser.get(id),
    createUser(params, authorization) {
      return db.transaction(() => {
        const denied = ruleAuthorization(authorization);
        if (denied) return denied;
        if (stmt.getUser.get(params.userId)) return { ok: false, status: 409, reason: 'User already monitored; edit the existing rule with its current revision' };
        return { ok: true, user: writeUser(params) };
      }).immediate();
    },
    updateUser(params, ruleRevision, authorization) {
      return db.transaction(() => {
        const denied = ruleAuthorization(authorization);
        if (denied) return denied;
        const current = stmt.getUser.get(params.userId);
        if (!current) return { ok: false, status: 404, reason: 'User not monitored' };
        if (!ruleRevision || current.rule_revision !== ruleRevision) return { ok: false, status: 409, reason: 'Monitoring rule changed; refresh before editing' };
        return { ok: true, user: writeUser({ email: current.email, username: current.username,
          threshold: current.threshold, amount: current.amount, enabled: Boolean(current.enabled), mode: current.mode, note: current.note, ...params }) };
      }).immediate();
    },
    removeUser(id, ruleRevision, authorization) {
      return db.transaction(() => {
        const denied = ruleAuthorization(authorization);
        if (denied) return denied;
        const current = stmt.getUser.get(id);
        if (!current) return { ok: false, status: 404, reason: 'User not monitored' };
        if (!ruleRevision || current.rule_revision !== ruleRevision) return { ok: false, status: 409, reason: 'Monitoring rule changed; refresh before deleting' };
        stmt.deleteUser.run(id);
        stmt.expireProposalsForUser.run({ user_id: id, note: 'user is no longer monitored', ts: now() });
        return { ok: true };
      }).immediate();
    },
    // Internal fixture/import primitive, not exposed through Web or CLI.
    upsertUser(params) { return db.transaction(() => writeUser(params)).immediate(); },
    deleteUser: (id) => db.transaction(() => {
      const changes = stmt.deleteUser.run(id).changes;
      stmt.expireProposalsForUser.run({ user_id: id, note: 'user is no longer monitored', ts: now() });
      return changes;
    }).immediate(),
    updateUserIdentity: (id, email, username = null, instance) => db.transaction(() => {
      assertBinding(instance);
      return stmt.updateUserIdentity.run(email ?? null, username, id).changes;
    }).immediate(),

    // ---- proposals (approval mode) ----
    createProposal({ id, userId, email, balance, threshold, amount, ruleRevision, instance }) {
      return db.transaction(() => {
        assertBinding(instance);
        const user = stmt.getUser.get(userId);
        if (!user?.enabled || user.mode !== 'approval' || user.rule_revision !== ruleRevision ||
            user.threshold !== threshold || user.amount !== amount) return null;
        const existing = stmt.pendingProposalForUser.get(userId);
        if (existing) return existing;
        stmt.insertProposal.run({
          id, user_id: userId, email, balance, threshold, amount, rule_revision: ruleRevision, ts: now(),
        });
        return stmt.getProposal.get(id);
      }).immediate();
    },
    getProposal: (id) => stmt.getProposal.get(id),
    pendingProposalForUser: (userId) => stmt.pendingProposalForUser.get(userId),
    listProposals: ({ status = null, limit = 100 }) => stmt.listProposals.all({ status, limit }),
    /** Returns the proposal only if it was still pending (guards double-approval). */
    decideProposal(id, status, note) {
      const changes = stmt.decideProposal.run({ id, status, note: note || null, ts: now() }).changes;
      return changes ? stmt.getProposal.get(id) : null;
    },
    claimProposal(id, instance, authorizeActor = null) {
      return db.transaction(() => {
        assertBinding(instance);
        if (authorizeActor && !authorizeActor()) return null;
        const changes = stmt.claimProposal.run({ id, ts: now() }).changes;
        return changes ? stmt.getProposal.get(id) : null;
      }).immediate();
    },
    completeProposal(id, status, note) {
      const changes = stmt.completeProposal.run({ id, status, note: note || null, ts: now() }).changes;
      return changes ? stmt.getProposal.get(id) : null;
    },
    reopenProposal(id, note = 'execution did not start') {
      const changes = stmt.reopenProposal.run({ id, note, ts: now() }).changes;
      return changes ? stmt.getProposal.get(id) : null;
    },
    expireProposalsForUser(userId, note = 'superseded') {
      return stmt.expireProposalsForUser.run({ user_id: userId, note, ts: now() }).changes;
    },

    // ---- top-ups ----
    beginTopup({ id, userId, email, balanceBefore, amount, threshold, source, actor = 'system', proposalId = null, providerOrigin = null }) {
      stmt.insertTopup.run({
        id,
        user_id: userId,
        email,
        balance_before: balanceBefore,
        amount,
        threshold,
        source,
        actor,
        proposal_id: proposalId,
        provider_origin: providerOrigin,
        ts: now(),
      });
    },
    // Authorization and the durable pending reservation share a write transaction:
    // a second process cannot change rules/limits between these two operations.
    reserveTopup(record, authorize) {
      return db.transaction(() => {
        assertBinding(record.instance);
        const decision = authorize();
        if (!decision.ok) return decision;
        stmt.insertTopup.run({
          id: record.id, user_id: record.userId, email: record.email,
          balance_before: record.balanceBefore, amount: record.amount,
          threshold: record.threshold, source: record.source, actor: record.actor,
          proposal_id: record.proposalId ?? null, provider_origin: record.providerOrigin ?? null, ts: now(),
        });
        return { ok: true };
      }).immediate();
    },
    finishTopup({ id, status, balanceAfter = null, replay = false, httpStatus = null, providerReference = null, actor = undefined, error = null }) {
      const existing = stmt.getTopup.get(id);
      stmt.finishTopup.run({
        id,
        status,
        balance_after: balanceAfter,
        idempotent_replay: replay ? 1 : 0,
        sub2api_status: httpStatus,
        provider_reference: providerReference,
        actor: actor ?? existing?.actor ?? 'system',
        error,
        ts: now(),
      });
      return stmt.getTopup.get(id);
    },
    getTopup: (id) => stmt.getTopup.get(id),
    recentTopups: ({ userId = null, status = null, limit = 200, offset = 0 }) =>
      stmt.recentTopups.all({ user_id: userId, status, limit, offset }),
    countTopupRecords: ({ userId = null, status = null } = {}) =>
      stmt.countTopupRecords.get({ user_id: userId, status }).total,
    exportTopups: ({ userId = null, status = null } = {}) =>
      stmt.exportTopups.iterate({ user_id: userId, status }),
    countTopupsSince: (sinceIso, userId = null) =>
      stmt.countTopupsSince.get(sinceIso, { user_id: userId }),
    lastTopupForUser: (userId) => stmt.lastTopupForUser.get(userId),
    unresolvedTopupForUser: (userId) => stmt.unresolvedTopupForUser.get(userId),
    markReconciled: (id, note, actor = null) => db.transaction(() => {
      const changes = stmt.markReconciled.run({ id, note: note || null, actor, ts: now() }).changes;
      if (changes) stmt.insertEvent.run(now(), 'info', stmt.getTopup.get(id).user_id, actor, 'payment_confirmed', `record ${id}: payment confirmed`);
      return changes;
    }).immediate(),
    unreconciled: () => stmt.unreconciled.all(),

    // ---- upstream reconciliation evidence ----
    recordVerification({ recordId, outcome, actor, summary, providerReference = null, evidence }) {
      return db.transaction(() => {
        const record = stmt.getTopup.get(recordId);
        if (!record) return null;
        return insertCheck(record, { kind: 'verification', outcome, actor, summary, providerReference, evidence });
      }).immediate();
    },
    ledgerChecks: (recordId) => stmt.ledgerChecks.all(recordId).map(parseCheck),
    exportLedgerChecks: (recordId) => stmt.exportLedgerChecks.iterate(recordId),
    resolveApplied({ recordId, verificationId, actor, lockToken, instance }, authorizeActor = null) {
      return db.transaction(() => {
        assertBinding(instance);
        if (authorizeActor && !authorizeActor()) return { ok: false, reason: 'operator authorization changed' };
        const record = stmt.getTopup.get(recordId);
        if (!record || !['pending', 'unknown', 'failed'].includes(record.status)) return { ok: false, reason: 'record is not unresolved' };
        if (stmt.ownsTopupLock.get({ user_id: record.user_id, token: lockToken }).n !== 2) return { ok: false, reason: 'reconciliation lock was lost' };
        const check = stmt.latestVerification.get(recordId);
        const checkedAt = Date.parse(check?.created_at);
        if (!check || check.id !== verificationId || check.outcome !== 'matched' || !check.provider_reference ||
            !Number.isFinite(checkedAt) || checkedAt > Date.now() + 1000 || Date.now() - checkedAt > 5 * 60_000) {
          return { ok: false, reason: 'a fresh matching upstream verification is required' };
        }
        if (stmt.providerReferenceUsed.get(recordId, check.provider_reference)) return { ok: false, reason: 'upstream reference is already assigned to another record' };
        stmt.resolveApplied.run({ id: recordId, reference: check.provider_reference, ts: now() });
        const resolution = insertCheck(record, {
          kind: 'resolution_applied', outcome: 'matched', actor,
          summary: 'Operator confirmed the credit using a matching upstream adjustment; no money request sent',
          providerReference: check.provider_reference,
          evidence: { verificationId: check.id, verificationSha256: check.evidence_sha256 },
        });
        if (record.proposal_id) stmt.completeProposal.run({ id: record.proposal_id, status: 'approved', note: `confirmed by reconciliation ${resolution.id}`, ts: now() });
        stmt.insertEvent.run(now(), 'warn', record.user_id, actor, 'ledger_resolved', `record ${recordId}: ${record.status} -> success; evidence ${check.id}`);
        return { ok: true, record: stmt.getTopup.get(recordId), resolution };
      }).immediate();
    },

    // ---- events ----
    log(level, kind, message, userId = null, actor = null) {
      stmt.insertEvent.run(now(), level, userId, actor, kind, message);
    },
    recentEvents: (limit = 100) => stmt.recentEvents.all(limit),

    // ---- settings ----
    getSetting(key, fallback = null) {
      const row = stmt.getSetting.get(key);
      return row ? row.value : fallback;
    },
    setSetting: (key, value) => stmt.setSetting.run(key, String(value), now()),

    // ---- authentication sessions ----
    createAuthSession({ tokenHash, csrfHash, username, accountId = null, accountVersion = null, createdAt, expiresAt, ip = null, userAgent = null }) {
      const id = crypto.randomUUID();
      stmt.createAuthSession.run({
        id,
        token_hash: tokenHash,
        csrf_hash: csrfHash,
        username,
        account_id: accountId,
        account_version: accountVersion,
        created_at: createdAt || now(),
        expires_at: expiresAt,
        ip,
        user_agent: userAgent,
      });
      return id;
    },
    getAuthSession: (tokenHash) => stmt.getAuthSession.get(tokenHash),
    getAuthSessionById: (id) => stmt.getAuthSessionById.get(id),
    touchAuthSession: (id, at = now()) => stmt.touchAuthSession.run(at, id).changes,
    rotateAuthCsrf: (id, csrfHash) => stmt.rotateAuthCsrf.run(csrfHash, id).changes,
    revokeAuthSession: (id, at = now()) => stmt.revokeAuthSession.run(at, id).changes,
    revokeAllAuthSessions: (at = now()) => stmt.revokeAllAuthSessions.run(at).changes,
    purgeAuthSessions: (before = now()) => stmt.purgeAuthSessions.run(before).changes,
    lastTotpCounter: () => stmt.lastTotpCounter.get().last_counter,
    consumeTotpCounter: (counter) => stmt.consumeTotpCounter.run(counter, counter).changes === 1,

    // ---- operator account management ----
    authAccounts: () => stmt.authAccounts.all(),
    getAuthAccount: (id) => stmt.getAuthAccount.get(id),
    findAuthAccount: (username) => stmt.findAuthAccount.get(username),
    invitationAccount: (hash) => stmt.invitationAccount.get(hash),
    createAuthAccount(params, authorize) {
      return db.transaction(() => {
        if (!authorize()) return { ok: false, reason: 'administrator authorization changed' };
        if (stmt.authAccountCount.get().n >= 500) return { ok: false, reason: 'account limit reached' };
        if (stmt.findAuthAccount.get(params.username)) return { ok: false, reason: 'username already exists' };
        stmt.insertAuthAccount.run({ ...params, ts: now() });
        stmt.insertEvent.run(now(), 'info', null, params.actor, 'account_invited', `account ${params.id} invited with role ${params.role}`);
        return { ok: true, account: stmt.getAuthAccount.get(params.id) };
      }).immediate();
    },
    updateAuthAccount({ id, role, enabled, version, actor }, authorize) {
      return db.transaction(() => {
        if (!authorize()) return { ok: false, reason: 'administrator authorization changed' };
        const previous = stmt.getAuthAccount.get(id);
        if (!previous || previous.credential_version !== version) return { ok: false, reason: 'account changed; reload before editing' };
        if (enabled && !previous.enrolled_at) return { ok: false, reason: 'account must complete enrollment first' };
        stmt.updateAuthAccount.run({ id, role, enabled: enabled ? 1 : 0, version, ts: now() });
        stmt.revokeAccountSessions.run({ id, ts: now() });
        stmt.insertEvent.run(now(), 'warn', null, actor, 'account_changed', `account ${id}: role ${previous.role} -> ${role}; enabled ${previous.enabled} -> ${enabled ? 1 : 0}; sessions revoked`);
        return { ok: true, account: stmt.getAuthAccount.get(id) };
      }).immediate();
    },
    reinviteAuthAccount(params, authorize) {
      return db.transaction(() => {
        if (!authorize()) return { ok: false, reason: 'administrator authorization changed' };
        if (stmt.reinviteAuthAccount.run({ ...params, ts: now() }).changes !== 1) return { ok: false, reason: 'account changed; reload before resetting' };
        stmt.revokeAccountSessions.run({ id: params.id, ts: now() });
        stmt.insertEvent.run(now(), 'warn', null, params.actor, 'account_reset', `account ${params.id}: credentials reset; sessions revoked; new enrollment required`);
        return { ok: true, account: stmt.getAuthAccount.get(params.id) };
      }).immediate();
    },
    enrollAuthAccount(params) {
      return db.transaction(() => {
        if (stmt.enrollAuthAccount.run({ ...params, ts: now() }).changes !== 1) return { ok: false, reason: 'invitation is invalid or expired' };
        const account = stmt.getAuthAccount.get(params.id);
        stmt.revokeAccountSessions.run({ id: params.id, ts: now() });
        stmt.insertEvent.run(now(), 'info', null, account.username, 'account_enrolled', `account ${params.id} completed credential enrollment`);
        return { ok: true, account };
      }).immediate();
    },
    consumeAccountTotp: (id, version, counter) => stmt.consumeAccountTotp.run({ id, version, counter }).changes === 1,
    changeAccountPassword({ id, version, passwordHash, actor }, authorize) {
      return db.transaction(() => {
        if (!authorize()) return { ok: false, reason: 'account authorization changed' };
        if (stmt.changeAccountPassword.run({ id, version, password_hash: passwordHash, ts: now() }).changes !== 1) return { ok: false, reason: 'account changed; sign in again' };
        stmt.revokeAccountSessions.run({ id, ts: now() });
        stmt.insertEvent.run(now(), 'warn', null, actor, 'account_password_changed', `account ${id}: password changed; all sessions revoked`);
        return { ok: true };
      }).immediate();
    },
    acquireTopupLock(userId, token, staleBefore) {
      const acquire = db.transaction(() => {
        const params = { token, acquired_at: now(), stale_before: staleBefore };
        if (stmt.acquireGlobalTopupLock.run(params).changes !== 1) return false;
        const userAcquired = stmt.acquireTopupLock.run({ ...params, user_id: userId }).changes === 1;
        if (!userAcquired) stmt.releaseGlobalTopupLock.run(token);
        return userAcquired;
      });
      return acquire.immediate();
    },
    releaseTopupLock(userId, token) {
      const release = db.transaction(() => {
        stmt.releaseTopupLock.run({ user_id: userId, token });
        stmt.releaseGlobalTopupLock.run(token);
      });
      release.immediate();
    },
    ownsTopupLock: (userId, token) => stmt.ownsTopupLock.get({ user_id: userId, token }).n === 2,
    getConsecutiveFailures: () => Number(stmt.getConsecutiveFailures.get()?.value || 0),
    incrementConsecutiveFailures() {
      stmt.incrementConsecutiveFailures.run({ ts: now() });
      return Number(stmt.getConsecutiveFailures.get()?.value || 0);
    },
    resetConsecutiveFailures() { stmt.resetConsecutiveFailures.run({ ts: now() }); },
    consumeLoginAttempt(ipHash, nowMs, windowMs, maxAttempts) {
      const changes = stmt.consumeLoginAttempt.run({ ip_hash: ipHash, now_ms: nowMs, window_ms: windowMs, max_attempts: maxAttempts, ts: now() }).changes;
      return changes === 1;
    },
    clearLoginAttempts: (ipHash) => stmt.clearLoginAttempts.run(ipHash).changes,
  };

  if (bindingTarget) store.ensureInstanceBinding(bindingTarget);
  return store;

  function insertCheck(record, { kind, outcome, actor, summary, providerReference = null, evidence }) {
    const id = crypto.randomUUID();
    const evidenceJson = JSON.stringify(evidence);
    stmt.insertLedgerCheck.run({
      id, topup_id: record.id, kind, outcome, previous_status: record.status,
      actor, summary, provider_reference: providerReference, evidence_json: evidenceJson,
      evidence_sha256: crypto.createHash('sha256').update(evidenceJson).digest('hex'), ts: now(),
    });
    return parseCheck(stmt.getLedgerCheck.get(id));
  }
}

function parseCheck(row) {
  const { evidence_json, ...fields } = row;
  return { ...fields, evidence: JSON.parse(evidence_json) };
}
