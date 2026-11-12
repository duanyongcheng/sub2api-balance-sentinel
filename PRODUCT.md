# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user runs a Sub2API instance and fronts balance to a whitelist of its users, then collects the money afterwards. Today that is one person, working alone, who opens the sentinel on a desktop browser a few times a day as a routine check: is the patrol running, who was topped up, what needs a decision, who owes what.

The product also supports additional accounts by role (admin, operator, read-only auditor), invited by an admin. The UI must stay correct for all three roles even though the current day-to-day user is a single admin.

## Product Purpose

Sub2API Balance Sentinel watches the balances of explicitly whitelisted Sub2API users, tops them up by a fixed amount when they drop below a threshold (automatically, or after human approval), and keeps a complete audit ledger of every top-up (balance before, amount, balance after, status, actor, upstream verification evidence) so that what each person owes can be reconciled and collected.

Success means: money never moves twice by accident, every uncertain write stops and waits for a human, and the operator can see in one routine visit what needs their hand and how much is owed.

## Positioning

It refuses to guess. An uncertain top-up is recorded as `unknown` and blocks further writes for that user until a human verifies it against upstream history; it is never retried. Every write passes hard guards (per-event cap, per-user daily count and total, circuit breaker, kill switch, instance binding) checked inside one ledger transaction. Verification evidence is kept with a SHA-256 digest and exportable.

## Operating Context

- Routine daily visits on a desktop browser, single operator; notifications (WeCom / Feishu / DingTalk / Slack webhooks) can prompt a visit for `unknown`, `failure`, `circuit`, `proposal`, and `topup` events.
- The service is published on `127.0.0.1` and reached through an HTTPS reverse proxy or VPN.
- The patrol loop polls on an interval (`cfg.monitor.intervalMs`); the UI refreshes every 15 seconds.
- CSV exports (owed totals, full ledger, per-record verification evidence) are taken out to collect payment.
- First deployment runs in observe-only mode (`AUTO_TOPUP_ENABLED=false`) until balances are confirmed correct.
- A CLI shares the same SQLite ledger (`tick`, `owed`, `bind-instance`).

## Capabilities and Constraints

- Monitored users: add by Sub2API user ID with threshold, fixed amount, and mode (approval is the UI default, auto must be chosen explicitly). Edit threshold/amount, toggle mode, enable/disable, manual top-up, remove (history kept). Edits carry `rule_revision`; stale edits are refused.
- Approvals: pending proposals with balance at proposal, proposed amount, projected balance; approve (re-reads live balance first) or reject with an optional note.
- Ledger: paginated, filterable by user ID and status (`success`, `pending`, `unknown`, `failed`, plus the `unresolved` grouping). Per record: verify against upstream, view evidence, confirm applied (only after a `matched` verification), mark collected.
- Reconciliation: owed totals per user, bulk "collected" per user, CSV exports.
- Run log: events with level, user, actor, kind, message.
- System controls: kill switch, run patrol now, test notification, reset circuit breaker. Banners for missing admin key, failed instance binding, observe-only mode, tripped circuit breaker.
- Accounts: change own password; admins invite accounts, change roles, enable/disable, reinvite / reset credentials, all behind re-entering the current password (and TOTP when enabled). One-time enrollment links arrive as a URL fragment.
- Auth: username + password, optional TOTP. Auditors can view and export but not act; permissions are enforced server-side, the UI only reflects them.
- Interface language is Simplified Chinese. Status codes (`success`, `pending`, `unknown`, `failed`) and env var names appear verbatim.
- Stack: React 18 + Vite, plain CSS, no component library; served by the Express backend from `web/dist`.

## Brand Commitments

- Name: "sub2api 余额哨兵" (Sub2API Balance Sentinel).
- Voice: plain, exact, safety-first Chinese. Copy states consequences honestly ("这会真实写入 sub2api", "不会补发", "急停不能撤回已经发出的请求") and never promises absolute safety.

## Evidence on Hand

- No logo, imagery, or brand assets exist.
- A local mock Sub2API (`scripts/mock-sub2api.js`, three fictional users) exists for demos; its data is synthetic.

## Product Principles

1. What needs a human comes first. Unresolved records, pending approvals, and tripped guards outrank everything else on screen.
2. Uncertainty is shown, never smoothed over. `unknown` and stale data look different from success and from failure.
3. Every write states its consequence before it happens and leaves a trace after.
4. Money figures are exact and comparable: tabular numerals, consistent precision, before/after side by side.
5. Read-only roles see the same truth without the controls.
