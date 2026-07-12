# Papaya — Design Tokens & Component Spec
Reference screen: `Papaya Home Final.dc.html`. Direction: warm Swiss/Scandinavian editorial minimalism, flat, light mode, retro-instrument accents.

## 1. Color

| Token | Hex | Use |
|---|---|---|
| `bg` | `#F3F0E9` | Screen background, nav bar, toggle track. Warm cream — never white, never cool grey. |
| `surface` | `#FCFAF5` | Cards, dialogs, sheets. A hair lighter than bg. |
| `surface-press` | `#F6F3EB` | Press tint on surface (card rows, dialog buttons). |
| `bg-press` | `#ECE8DC` | Press tint on bg (loose rows, gear, demo chip). |
| `text` | `#1D1B16` | Primary text, FAB, primary buttons, active nav. Warm near-black. |
| `text-2` | `#8E887A` | Secondary text, labels, ₩ prefix, gear icon. |
| `text-3` | `#A39D8D` | Tertiary: helper line, metadata, inactive nav. |
| `text-4` | `#C0BAAA` | Faintest: index numbers, counts. |
| `hairline` | `#E4E0D3` | All borders on surface + section dividers. Always 1px. |
| `hairline-2` | `#E7E2D5` | Loose-row leader line (on bg). |
| `hairline-3` | `#EDE9DD` | Log-row leader line (on surface). |
| `frame` | `#D9D5CA` | Device/outermost frame border only. |
| `knob-off` | `#D8D3C5` | REC knob when off. |
| `accent` | `#E8622A` | Burnt orange. ONE element per screen: the live REC knob + its status dot. Nothing else. |
| `scrim` | `rgba(29,27,22,0.28)` | Dialog overlay. Sheet overlay uses 0.20. |

Rules: flat only — no gradients, no shadows. Separation = hairline + whitespace.

## 2. Type

Families:
- **Grotesque — Instrument Sans** (fallback Helvetica Neue): all UI text, names, buttons, nav.
- **Mono — IBM Plex Mono** 400/500: metadata, dates, index numbers, helper line, instrument legends.
- **Dot-matrix — Doto 800**: ALL money digits, app-wide (global money rule). Digits only — the `₩` symbol is grotesque 12px `text-2`, baseline-aligned, 2px gap.

Scale:
| Style | Font | Size / weight / tracking | Use |
|---|---|---|---|
| App title | Grotesque | 22 / 600 / −0.01em | "Papaya" |
| Card title | Grotesque | 17 / 600 / −0.01em | Recording names |
| Dialog/sheet title | Grotesque | 16–18 / 600 / −0.01em | |
| Body row | Grotesque | 15 / 400 | Expense names |
| Nav | Grotesque | 14; active 600 `text`, inactive 400 `text-3` | |
| Button | Grotesque | 13 / 600 | Dialog + sheet buttons |
| Caption | Grotesque | 12.5 / 400 / `text-2`, line-height 1.55 | Dialog body |
| Amount | Doto | 16.5 / 800 / +0.02em | All money digits |
| Meta mono | Mono | 10.5 / 400 / `text-3` | Dates, "paid by…", helper |
| Legend | Mono or grotesque | 9.5 / 500–600 / +0.14–0.16em / UPPERCASE / `text-2` | REC, RECORDING, dialog kickers |
| Index | Mono | 10 / 400 / `text-4` | 01 02… log indices, counts (zero-padded) |

## 3. Geometry

Radii: card/dialog 18 · sheet top 22 · device 28 · pill buttons height/2 (full) · toggle 14 · row press-tint 8–10 · FAB & knob circle.
Borders: 1px everywhere, no exceptions. No 2px+ strokes.
Spacing scale: 2 / 6 / 10 / 12 / 16 / 18 / 20 / 24. Screen gutter 20; card inner padding 18; header 24.
Heights: card header 66 · log row 44 · loose row 44 · nav 64 · buttons 40 · FAB 56 · toggle 27×48 (knob 20, travel 20px) · helper row 12px v-padding.

## 4. Components

**Recording card** — `surface`, 1px `hairline`, r18. Header row 66px: [live dot 7px accent, pulsing] name 17/600 + count `04` (mono 10 `text-4`) · right: REC legend + toggle. Expanded body: mono date line, then log rows: index `01` · name 15 · leader line 1px `hairline-3` (flex-fill) · ₩ + Doto amount. Collapse/expand = grid-rows animation.

**REC toggle** — 48×27 track, `bg` fill, 1px `hairline`, r14. Knob 20px circle: off `knob-off` left, on `accent` right. The live card also shows the 7px accent dot before its name.

**Loose expense row (bare)** — no container. 44px, 10px side padding: name 15 · single 1px `hairline-2` flex line · ₩ + Doto amount. Press = `bg-press` tint, r10. Expanded: mono meta + "OPEN DETAIL →" (mono 9.5 caps, underlined with 1px `#C9C3B3`).

**FAB** — 56px circle, `text` fill, cream 1.8px-stroke plus icon. 20px from right, 22px above nav. Press: scale 0.9, 110ms.

**Bottom nav** — 64px, `bg`, top hairline, 3 equal columns. Active: 14/600 `text` + 16×2px underline bar. Inactive: 14/400 `text-3`. Press: opacity 0.55.

**Dialog** — centered on `scrim`, `surface` r18, 1px hairline, padding 22/20. Kicker (mono legend) → title → caption → two 40px pill buttons (ghost: hairline border; primary: `text` fill, cream text).

**Sheet (stubs)** — bottom, `surface`, top corners r22, grab handle 36×3 `#DCD6C6`. Kicker → title → caption → ghost pill button.

**Helper line** — mono 10.5 `text-3`, hairline below, 12px v-padding. Dismissible copy pattern: `a = b · c = d`.

## 5. Motion — instrument-like: quick, precise, flat. No bounce, no overshoot.

Standard easing `cubic-bezier(0.2, 0, 0, 1)`; simple `ease` for tints/fades.

| Motion | Spec |
|---|---|
| Accordion | `grid-template-rows 0fr↔1fr`, 260ms std easing. One open at a time — old closes as new opens, same curve. |
| REC ignite | Knob: transform+background 170ms std. Dot: scale 0→1 180ms, then opacity pulse 2.4s infinite (1→0.35). |
| Switch confirm | Scrim fade 140ms; dialog pop 0.96→1 + fade, 160ms std. |
| Expense files in | Row fades in from −8px translateY, 280ms std; card auto-expands if closed. |
| FAB press | scale 0.9, 110ms std, on :active. |
| Press tints | background 120ms ease. |
| Sheet | translateY 28px→0 + fade, 240ms std. |

Durations: 110–170ms micro, 240–280ms structural. Nothing longer.
