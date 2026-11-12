---
version: 1
slug: "web-src-app-jsx"
primary_target: "web/src/App.jsx"
related_targets: ["web/src/styles.css","web/src/Accounts.jsx","web/src/Overview.jsx","web/src/ui.jsx"]
---

# Surface brief: sentinel console (web/src)

Scope: the whole authenticated console (overview, monitored users, approvals, ledger, unresolved, reconciliation, run log, accounts) plus login and enrollment. Visitor mode: Operate.

Audience and job: one operator, desktop, routine checks a few times a day. First need: what is waiting for their hand (pending approvals, pending/unknown records, tripped circuit breaker), then balance health, then money owed. Restructuring navigation is approved; every function, permission rule, and factual copy stays.

## Direction contract

THESIS: The console reads like a station departure board: one glance says what is waiting for you and whether everything runs on time. It refuses the category default of a KPI-card row over tabs and grey tables.

OWN-WORLD: Railway-navy shell (#0E2A52 top bar and action board) over a cool light ground (#F3F5F8) with white panels, one 1px rule colour, three ink values, 2px corners at most, no decorative shadow. Signal yellow (#F2B705) only on things awaiting the operator; red for unknown and critical; green for running. Times, IDs and money set in self-hosted Fira Sans Condensed with tabular figures; Chinese in the system 黑体 stack. (Barlow Semi Condensed was the first pick but ships no tabular figures: with tnum on, 1111.11 and 8888.88 still render at different widths, and money columns must align per PRODUCT principle 4.)

STORY: Open, read the count and the board rows, act on each row in place, scan balance gauges sorted by urgency, see what is owed, go deeper through the tabs.

FIRST VIEWPORT: Navy top bar: name, tabs with yellow counts, next-patrol countdown, user, 立即巡检, 急停. Global blockers as strips. Then the action board: left tally (large yellow count phrase plus run status), right timetable rows (时间, 用户, 事项, 金额, 状态, action), expanding in place. Below: urgency-sorted balance gauges beside the owed total.

FORM: Station departure board, 6 of 7 on the ordered list, seed:6824b2f0bb4c8b62. Signature: the action board in timetable column rhythm with the live patrol countdown; new rows light up once; resolved rows leave; an empty board collapses to one line. Raises kept: scale-contrast hierarchy; one decision expanded at a time; fixed-ramp balance gauge with threshold tick; yellow reserved for the operator's hand; one rule weight and three ink values.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Unresolved

- "Since last visit" is not tracked; the board shows open items only.
