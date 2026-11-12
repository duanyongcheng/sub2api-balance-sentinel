---
name: sub2api 余额哨兵
description: Departure-board console for watching, topping up and reconciling whitelisted Sub2API balances.
colors:
  railway-navy: "#0e2a52"
  navy-raised: "#163a6b"
  navy-rule: "#29497a"
  navy-ink: "#ffffff"
  navy-ink-2: "#c3d1e6"
  navy-ink-3: "#93a8c8"
  signal-yellow: "#f2b705"
  signal-yellow-hover: "#ffc61a"
  signal-ink: "#1b1600"
  danger: "#c22f35"
  danger-fill: "#d93a3f"
  danger-on-navy: "#ff8a8d"
  danger-tint: "#fdeced"
  ok: "#18744a"
  ok-on-navy: "#5fd59a"
  ok-tint: "#e6f5ec"
  caution: "#855800"
  caution-fill: "#d08a0c"
  caution-tint: "#fdf3d8"
  caution-on-navy: "#f5a35c"
  ground: "#f2f4f8"
  panel: "#ffffff"
  panel-sunk: "#f7f8fb"
  ink: "#13203a"
  ink-2: "#44526b"
  ink-3: "#5f6c84"
  rule: "#d8dee8"
  rule-soft: "#e8ecf2"
  focus: "#2f6fdb"
  select: "#dce7fa"
typography:
  display:
    fontFamily: "'Fira Sans Condensed', 'PingFang SC', system-ui, sans-serif"
    fontSize: "112px"
    fontWeight: 600
    lineHeight: 0.9
    letterSpacing: "-0.02em"
    fontFeature: "'tnum' 1, 'lnum' 1"
  figure-lg:
    fontFamily: "'Fira Sans Condensed', 'PingFang SC', system-ui, sans-serif"
    fontSize: "52px"
    fontWeight: 500
    lineHeight: 1.05
    letterSpacing: "-0.01em"
    fontFeature: "'tnum' 1, 'lnum' 1"
  figure-md:
    fontFamily: "'Fira Sans Condensed', 'PingFang SC', system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 500
    lineHeight: 1.1
    fontFeature: "'tnum' 1, 'lnum' 1"
  headline:
    fontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.3
  title:
    fontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.55
  body:
    fontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
  body-sm:
    fontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.5
  mono:
    fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  base: "2px"
spacing:
  xxs: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "20px"
  xl: "24px"
  xxl: "32px"
  page: "1360px"
components:
  button-default:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.base}"
    padding: "6px 14px"
    height: "34px"
  button-default-hover:
    backgroundColor: "{colors.panel-sunk}"
  button-primary:
    backgroundColor: "{colors.railway-navy}"
    textColor: "{colors.navy-ink}"
    rounded: "{rounded.base}"
    padding: "6px 14px"
    height: "34px"
  button-primary-hover:
    backgroundColor: "{colors.navy-raised}"
  button-signal:
    backgroundColor: "{colors.signal-yellow}"
    textColor: "{colors.signal-ink}"
    rounded: "{rounded.base}"
    padding: "6px 14px"
    height: "34px"
  button-signal-hover:
    backgroundColor: "{colors.signal-yellow-hover}"
  button-danger:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.danger}"
    rounded: "{rounded.base}"
    padding: "6px 14px"
    height: "34px"
  button-danger-hover:
    backgroundColor: "{colors.danger-tint}"
  button-sm:
    padding: "3px 10px"
    height: "28px"
  badge-ok:
    backgroundColor: "{colors.ok-tint}"
    textColor: "{colors.ok}"
    typography: "{typography.label}"
    rounded: "{rounded.base}"
    padding: "1px 7px"
  badge-caution:
    backgroundColor: "{colors.caution-tint}"
    textColor: "{colors.caution}"
    typography: "{typography.label}"
    rounded: "{rounded.base}"
    padding: "1px 7px"
  badge-danger:
    backgroundColor: "{colors.danger-tint}"
    textColor: "{colors.danger}"
    typography: "{typography.label}"
    rounded: "{rounded.base}"
    padding: "1px 7px"
  badge-muted:
    backgroundColor: "{colors.panel-sunk}"
    textColor: "{colors.ink-3}"
    typography: "{typography.label}"
    rounded: "{rounded.base}"
    padding: "1px 7px"
  tab-count:
    backgroundColor: "{colors.signal-yellow}"
    textColor: "{colors.signal-ink}"
    rounded: "{rounded.base}"
    padding: "0 6px"
    height: "18px"
  input:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.base}"
    padding: "6px 10px"
    height: "34px"
    width: "168px"
  panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.base}"
    padding: "14px 20px"
  shell:
    backgroundColor: "{colors.railway-navy}"
    textColor: "{colors.navy-ink}"
    height: "64px"
    padding: "0 32px"
  action-board:
    backgroundColor: "{colors.railway-navy}"
    textColor: "{colors.navy-ink}"
    rounded: "{rounded.base}"
  action-board-row-open:
    backgroundColor: "{colors.navy-raised}"
  toast:
    backgroundColor: "{colors.railway-navy}"
    textColor: "{colors.navy-ink}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.base}"
    padding: "10px 18px"
---

# Design System: sub2api 余额哨兵

## Overview

**Creative North Star: "The Departure Board"**

The console reads like a station departure board. Railway navy owns the frame: the top bar and the action board, where a large signal-yellow count says how many things wait for the operator and timetable rows say what each one is. Everything below the board is a cool light working ground with white panels, set dense and quiet, so that the board stays the loudest thing on any screen.

Hierarchy comes from scale contrast and colour discipline, not from decoration. Times, user IDs and money are set in a condensed face with tabular figures so columns align like a printed timetable; Chinese text runs in the system 黑体 stack. One rule weight, three ink values, 2px corners, and no decorative shadow keep the surface flat and legible. Colour is semantic before it is atmospheric: yellow means "your hand is needed", red means unknown or critical, green means running or settled, amber means below threshold or stale.

The system rejects the category default of a KPI-card row over tabs and grey tables. A dashboard tile grid is the thing this board replaces.

**Key Characteristics:**
- Navy frame (shell, action board, login gate) over a cool light ground with white panels.
- Signal yellow reserved for things awaiting the operator.
- Tabular condensed figures for every time, ID and amount.
- One 1px rule weight, 2px corners, flat surfaces.
- Dense, desktop-first tables that restack into cards on phones.

## Colors

A navy-and-paper palette with four semantic signals, each in a text-safe variant for light tints and a brighter variant for fills and the navy board.

### Primary
- **Railway Navy** (railway-navy): The shell, the action board, the login gate, primary buttons, toast background, and the default balance-gauge fill. Its raised step (navy-raised) marks the expanded board row and hovered navy buttons; navy-rule draws every divider on navy.
- **Navy Inks** (navy-ink, navy-ink-2, navy-ink-3): The three ink values on navy: white for figures and active tabs, pale steel for secondary text and inactive tabs, muted steel for column heads, metadata and dt labels.

### Secondary
- **Signal Yellow** (signal-yellow, with signal-ink text): The operator's hand. Tab counts, the tally number, the 待审批 board state, and approve buttons (批准并加额). It brightens to signal-yellow-hover on hover. The board's arrival flash is a 28% wash of the same yellow.

### Tertiary (state signals)
- **Alarm Red** (danger text, danger-fill, danger-on-navy, danger-tint): Unknown results, blocked users, mismatched verification, the kill switch (急停), destructive actions. danger is the AA-safe text value on danger-tint; danger-fill paints the blocked gauge and the released-switch button; danger-on-navy is for text on the board and shell.
- **Running Green** (ok, ok-on-navy, ok-tint): Patrol running, success, matched verification, settled amounts. ok is the AA-safe text value on ok-tint; ok-on-navy for the board.
- **Caution Amber** (caution, caution-fill, caution-tint, caution-on-navy): Below-threshold balances and stale data. caution is the AA-safe text value; caution-fill paints a low gauge; caution-tint backs caution strips and the invitation box; caution-on-navy is the orange used for caution text and badges on the navy board (observe mode, partial failure counts), kept distinct from signal yellow.

### Neutral
- **Cool Ground** (ground): The page background behind panels.
- **Panel White** (panel) and **Sunk Panel** (panel-sunk): Panel surfaces; sunk for table-row hover, edit rows, evidence blocks and quiet badges.
- **Ink, Ink 2, Ink 3** (ink, ink-2, ink-3): The three ink values on light: primary text, secondary text, labels and metadata.
- **Rule** (rule) and **Soft Rule** (rule-soft): Panel borders and table-head dividers; soft rule for row dividers and the empty gauge track.
- **Focus Blue** (focus) and **Selection** (select): Focus rings, caret, text links; selected table rows and text selection.

### Named Rules
**The Operator's Hand Rule.** Signal yellow appears only on things awaiting the operator: pending counts, approve actions, the tally number. Never use it for decoration, branding, or general emphasis.

**The Two-Variant Rule.** Every state colour has a dark text value tuned for WCAG AA on its own tint (ok, danger, caution) and a brighter value for fills and navy (ok-on-navy, danger-fill / danger-on-navy, caution-fill / caution-on-navy). Text on a light tint always takes the dark value.

**The Uncertainty Is Red Rule.** Unknown and blocked are alarm red, never caution amber and never neutral grey; uncertainty must look different from success and from failure.

## Typography

**Display / Figures Font:** Fira Sans Condensed, self-hosted (latin 400/500/600), with PingFang SC and system-ui fallback
**Body Font:** System 黑体 stack (PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans CJK SC, system-ui)
**Mono Font:** ui-monospace / SF Mono / Menlo, for evidence, digests and enrollment secrets

**Character:** A narrow timetable numeral beside a plain CJK sans. The figures face carries every number with tabular and lining figures on, so money columns align to the cent; the Chinese stays system-native and unadorned.

### Hierarchy
- **Display** (600, 112px, 0.9, yellow): The tally count only. Drops to 80px below 1200px.
- **Figure Large** (500, 52px, 1.05): The owed total and reconciliation total. 40px below 640px.
- **Clock** (500, 30px, 1): The next-patrol countdown in the shell.
- **Figure Medium** (500, 26px, 1.1): Board times and amounts; 20px below 960px. Board user IDs at 22px/600.
- **Headline** (600, 22px): Login and enrollment card titles; dialog titles at 17px.
- **Title** (600, 15px): Panel heads and the board's 事项 line.
- **Body** (400, 14px, 1.55): Default text and form inputs. Tables and strips run at 13px.
- **Label** (500, 12px): Table heads, field labels, badges, metadata. Board column heads are tracked at 0.12em in muted steel.

### Named Rules
**The Tabular Figures Rule.** Every time, user ID and amount takes the figures face with `tnum` and `lnum` on. A face that ships no true tabular figures is not eligible, however well it fits otherwise (Barlow Semi Condensed was rejected for this).

**The Scale Contrast Rule.** Hierarchy is carried by size jumps between figures and labels (112 / 52 / 26 against 12-14), not by colour fills, cards, or extra weights.

## Layout

A single centred column capped at 1360px with 32px side padding (16px below 640px), and 24px between major blocks. The shell is a sticky navy band: a 64px top row (brand, countdown, identity, actions) over a scrolling tab bar. Global blockers sit directly under the shell as full-width strips with 8px between them.

The Overview stacks the action board, then a two-column lower band (balance gauge list beside a 360px owed panel, 24px gap). Inside panels, heads pad 14px 20px, bodies 20px, table cells 10px 16px with 20px at the outer edges. Spacing steps are 4, 8, 12, 16, 20, 24, 32, with 48px reserved for empty states and the gate.

Responsive behavior:
- **Below 1200px:** the lower band becomes one column; the board's tally moves above the rows as a horizontal strip.
- **Below 960px:** the shell stops being sticky and wraps; board column heads hide and each board row regrids into time / user / state, time / what / amount, then a full-width actions line.
- **Below 640px:** the gauge and users tables restack into two-column cards, each cell labelled from its column name; form fields go full width.

## Elevation & Depth

Flat. Depth comes from tone, not shadow: navy against ground, white panels with a 1px rule, sunk panels for nested content, and navy-raised for the open board row. Only two elements float above the page, and both carry functional elevation.

### Shadow Vocabulary
- **Toast** (`box-shadow: 0 8px 24px rgba(14, 42, 82, .28)`): The transient confirmation pinned bottom-centre.
- **Dialog** (`box-shadow: 0 24px 64px rgba(14, 42, 82, .35)`): The credential dialog over a 60% navy scrim.
- **Focus halo** (`box-shadow: 0 0 0 3px rgba(47, 111, 219, .18)`): Focused inputs, paired with a focus-blue border.

### Named Rules
**The Flat Board Rule.** Panels, the board, strips and buttons never cast shadows. Shadow means "this floats above the page right now", and only toasts and modal dialogs float.

## Shapes

Nearly square. Every container, button, badge, input, tab count and evidence block uses the single 2px corner; nothing is pill-shaped or circular. Borders are always 1px in rule, rule-soft or navy-rule. The two exceptions are functional: the 2px active-tab underline and the 2px threshold tick on the gauge. The balance gauge itself is an 8px square-ended bar; a missing balance shows a dashed track instead of a fill.

## Components

### Buttons
Compact, quiet, and colour-coded by consequence.
- **Shape:** 2px corners, 34px tall, 6px 14px padding, 13px/500 label; small size 28px tall.
- **Default:** White with a 1px rule border; hover deepens the border and sinks the fill, active sinks further.
- **Primary:** Railway navy for the main forward action on light ground (去对账收款, 登录); hover goes to navy-raised.
- **Signal:** Signal yellow with near-black ink at 600, only for approving something that waits on the operator.
- **Danger:** Red text on white with a pink border; hover fills danger-tint. In the shell, the released kill switch becomes a solid danger-fill button.
- **On navy:** Buttons turn transparent with a steel border and white text; hover adds an 8% white wash. Focus rings turn white.
- **Ghost / Icon:** Borderless; the icon button is 34px square and carries an inline SVG chevron that rotates 180° when open.
- **Disabled:** 45% opacity, not-allowed cursor.

### Badges
- **Style:** 1px border, 2px corners, 12px/500 label, 1px 7px padding, on the matching tint with the AA-safe text value.
- **Tones:** ok (success, matched, 正常), caution (failed, below threshold, incomplete scan), danger (pending, unknown, blocked, mismatch), muted (not yet verified). On the board, badges go transparent with a navy-rule border and on-navy text.

### Cards / Containers
- **Corner Style:** 2px.
- **Background:** Panel white on cool ground; sunk panel for nested evidence and edit rows.
- **Shadow Strategy:** None (see Elevation & Depth).
- **Border:** 1px rule; panel heads separated by a 1px rule.
- **Internal Padding:** 14px 20px heads, 20px bodies.
- **Strips:** Full-width notices with a bold lead word; danger and caution strips take their tint and a tinted border.

### Inputs / Fields
- **Style:** 1px rule border, 2px corners, white, 34px tall, 168px default width, 14px tabular text; a 12px label sits 6px above. Selects use an inline SVG chevron.
- **Focus:** Border turns focus blue with a 3px soft blue halo; no outline.
- **Error / Disabled:** Invalid fields take a danger border once the user leaves them; form errors are 13px danger text.

### Navigation
- **Style:** Navy tab bar under the shell's top row, 14px tabs in pale steel, 4px apart.
- **Active:** White, 600, with a 2px white underline.
- **Counts:** Yellow tab-count chips (12px/600, 18px tall) show items awaiting the operator.
- **Mobile:** The bar scrolls horizontally with the scrollbar hidden.

### Tables
Dense ledger tables: 12px/500 ink-3 heads over a 1px rule, 13px rows on soft-rule dividers, 14px tabular figures, right-aligned money. Hover sinks the row; selection uses the select blue. Wide tables scroll horizontally inside their panel. Below 640px, gauge and users tables restack into labelled two-column cards.

### Action Board (signature)
The navy timetable that opens the Overview. A 240px tally column on the left holds the yellow count, a short phrase, and a run-status list (auto top-up, consecutive failures, last patrol) in on-navy tones. On the right, rows follow fixed timetable columns (时间, 用户, 事项, 金额, 状态, actions), 76px minimum height, divided by navy-rule.
- **Expansion:** One row opens at a time, in place, on navy-raised, revealing a four-column detail list.
- **Arrival:** A newly arrived row flashes a yellow wash once over 1.6s; resolved rows leave the board.
- **States:** 待审批 in signal yellow, 待核实 in danger-on-navy, both 20px/600.
- **Empty:** With nothing waiting, the board collapses to a single line holding the clear phrase and the run status.

### Balance Gauge
An 8px bar on a fixed ramp per rule: empty at 0, full at threshold plus top-up amount, with a 2px ink tick at the threshold. Navy fill when healthy, caution-fill when below threshold, danger-fill when blocked, and a dashed track when the balance is unknown. Lists are sorted by urgency.

### Toast
Bottom-centre, navy, 13px white text, rising 8px into place over 0.2s. A success toast leads with a small green square; a failure toast turns deep red.

## Do's and Don'ts

### Do:
- **Do** keep signal yellow for things waiting on the operator: tab counts, approve buttons, the tally, the 待审批 state.
- **Do** set every time, ID and amount in Fira Sans Condensed with `tnum` and `lnum` on, and right-align money columns.
- **Do** use the dark text values (ok #18744a, danger #c22f35, caution #855800) on their tints, and the brighter variants only for fills and on navy.
- **Do** use one 1px rule weight and the single 2px corner on every container, button, badge and input.
- **Do** show unknown and blocked in alarm red, and missing data as a dashed or muted state, never as success.
- **Do** restack wide tables into labelled cards below 640px rather than shrinking text.
- **Do** keep motion short and functional (0.15s state transitions on the ease-out curve), and honour reduced motion.

### Don't:
- **Don't** build a KPI-card row over tabs and grey tables; the action board is the summary.
- **Don't** use signal yellow for decoration, branding, highlights or general warnings.
- **Don't** add decorative shadows to panels, the board, strips or buttons; only toasts and modal dialogs float.
- **Don't** round corners past 2px or introduce pill and circular shapes.
- **Don't** use a figures face without true tabular figures.
- **Don't** expand more than one board row at a time.
