# Papaya — project guide (read this first)

Papaya is a casual **expense-splitting app for friend groups** (a lighter, more flexible Splitwise). This file is the single source of truth for any agent continuing the build. Read it fully before working.

---

## 1. What it is (the product model)

- **People-first, not trip-first.** The durable unit is the *group of people*, not a trip. Balances between people persist forever (no per-trip reset).
- **Expense-first capture.** The app opens ready to log an expense in seconds (what / how much / who). Organization is optional and happens after.
- **Recordings** = optional containers that group expense logs (a trip, a night out, a recurring group). Purely organizational — they never hold balances. An expense can also be **loose** (no recording). One recording can be the **live session** (its `REC` toggle on) — new expenses auto-file into it; only one live at a time.
- **People are the atom.** Global, persistent. A person is either a real account or a **token** (placeholder, no account). Everyone (including "You") is a person row.
- **The splitting engine** is the signature feature: an expense = a list of **items**, each with an amount + its own member set. One catch-all item ("the rest") auto-fills its amount (total − carve-outs) and defaults to everyone but is editable. Covers even-split, wine-for-some, someone's extra dish, people-who-left-early — all with one model.
- **Currency:** three layers, each inheriting: MAIN (user home currency, default THB, in Settings) → RECORD currency (optional per recording) → EXPENSE currency (inherits record). A foreign expense shows an editable exchange rate to the **recording's base currency**.
- **Settlement:** balances are pairwise between people, global. Global tab settles person-by-person; minimized "who pays who" is scoped inside a record (never route a payment between people who don't share a record).

Deeper design rationale lives in the agent memory file (`~/.claude/projects/-Users-hokkaido-Desktop-claude-Papaya/memory/papaya_v2_direction.md`) and in `design/` (approved wireframes → styled reference + token spec).

---

## 2. Current status

**This is v2, a full rewrite of a v1 prototype. Branch: `papaya-v2`.** Build phases:

| Phase | Status |
|---|---|
| 1. Foundation (schema, tokens, shell, auth) | ✅ done, committed |
| 2. Auth + onboarding | ✅ minimal (inline in App.jsx) |
| 3. Home screen | ✅ done, verified live |
| 4. Expense form (even-split capture) | ✅ done, verified live |
| 4b. "Split it up" carve-out engine | ✅ done, verified live |
| 5. Records / Recording detail / Create recording | ✅ done, verified live |
| 6. Settlement / Expense detail | ⬜ not started (both stubbed) |
| 7. Settings / Friends | ⬜ not started |
| 8. Punch-list + deploy | ⬜ |

**What works right now (verified running against live Supabase):** sign in → Home accordion feed (recordings + loose expenses, live REC toggle with switch-confirm, dot-matrix amounts) → FAB opens expense form → amount keypad, currency dropdown, foreign exchange-rate card, payer + split pickers → Save persists and Home refreshes.

**"Split it up" is now complete** (verified live: total → "Split it up" → add item "Wine" ฿300 → picker with Everyone/Clear chips assigns all 5 → the rest auto-recomputes to ฿700 → per-person peek correct (You ฿760, others ฿60) → Save persists as a loose expense, Home refreshes). Two wiring steps done: `itemPicker` now renders a `PeoplePicker`; `PeoplePicker` gained `onEveryone`/`onClear` chips. Also fixed: `setTargetAll`'s "Everyone" now selects all `localPeople` (previously only recording members + self, so it selected nobody on a loose expense).

**Phase 5 (Records / Recording detail / Create recording) is now complete** (verified live). New files: `src/screens/Records.jsx` (segmented Recordings|Loose control with per-view counts, search across both, "+ New recording", recording cards → detail, loose rows → expense-detail stub), `src/screens/RecordingDetail.jsx` (title + derived date range + logs/currency meta, "Who's in" party roster, ORANGE "Settle up this record" primary [stub → Phase 6] + "+ Add expense" secondary, per-expense settled indicators derived from `expense_item_members.settled_at` → "settled"/"open"/"N of M · Name open", log rows → expense-detail stub), `src/screens/CreateRecording.jsx` (name, optional "Who's in" via PeoplePicker, optional "Different currency" reveal + exchange rate, "Start recording now" toggle → clears other live recordings then inserts active; always adds self to members). **PeoplePicker has two multi-select shortcut modes** (a picker uses one, not both): (a) `onEveryone`/`onClear` chips = pare-down a known group, for the EXPENSE FORM (split/item pickers); (b) `suggestions` (`[{label, ids}]`) + `onAddPeople(ids)` chips = assemble a party from scratch, for CREATE RECORDING — it passes "From last time" (members of the most recent recording) + "Often" (people in ≥2 recordings), each a one-tap add that flips to a ✓ done state once its people are all selected. Design rationale (Phoom, 2026-07-13): Everyone/Clear is a splitting affordance and belongs only in the expense form; building a recording's roster wants recency/frequency suggestions, not "everyone". Verified: create "Chiang Mai trip" w/ Everyone → persists members + becomes the live REC session (took over from Busan, one-live enforced); add-expense from a recording detail forces that recording (chip "Recording · Seoul in June", inherits KRW, roster pre-filled) → saves → detail + Records both refresh (06→07 logs, date range extends).

**App.jsx navigation was refactored from a single `overlay` to an overlay STACK** (`stack` array + `push`/`popOverlay`) so nested pushes work (recording detail → add expense → pop back refreshed). `popOverlay(changed)` bumps `refreshKey` + reloads people; underlying mounted screens re-fetch on `refreshKey`. Records/RecordingDetail hit unbuilt screens (expense detail, settle-up) via an App-level `StubSheet`. `ExpenseForm` now accepts `forceRecordingId` to file into a specific recording instead of auto-detecting the live one.

Settled-indicator green uses `var(--settled, #4E7A55)` with an inline fallback — no `--settled` token defined yet; per the design note, make settled/open colors an intentional TE-palette choice in the styling/settlement pass.

Commits on `papaya-v2`: `8725d11` (foundation/Home/expense form), `c2a23f2` (cleanup + form refinements). The finished "Split it up" work + all of Phase 5 are **uncommitted** (ExpenseForm.jsx, PeoplePicker.jsx, App.jsx, + 3 new screens). Dev/demo note: testing left an empty "Chiang Mai trip" recording (now the live session) and a couple of harmless test expenses in the seed DB — re-seed to reset.

---

## 3. How to run

```bash
npm install
npm run dev      # Vite dev server, http://localhost:5173
npm run build    # production build (use to verify compile after changes)
```

- Env: `.env` holds `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (gitignored; template in `.env.example`). The Supabase project is fresh and the v2 schema is applied.
- **Email confirmation is OFF** in the Supabase project (required — otherwise signup can't log in). If auth breaks, re-check Auth → Sign In/Providers → Email → "Confirm email" is off.
- Empty account? Home's empty state has an **"add demo data"** button (`src/lib/seed.js`) that seeds realistic recordings/expenses/people.
- Preview server config: `.claude/launch.json` (name `papaya`).

---

## 4. Tech stack & repo structure

React 18 + Vite, plain JSX (no TypeScript), Supabase (auth + Postgres). No router lib — navigation is state-based in `App.jsx`.

```
src/
  App.jsx            # auth gate, 3-tab shell, overlay navigation, loads `people`
  main.jsx           # entry; imports index.css
  index.css          # ALL design tokens (CSS vars) + fonts + keyframes
  lib/
    supabase.js      # client from env vars
    format.js        # currencySymbol / formatMoney / padIndex
    seed.js          # dev demo-data seeder
  screens/
    Home.jsx         # accordion feed (done)
    ExpenseForm.jsx  # expense capture (even-split done; "split it up" ~80%)
  components/
    PeoplePicker.jsx # reusable bottom-sheet: search-that-creates, single/multi select
schema.sql           # v2 Postgres schema (apply to a clean DB)
design/              # TOKENS.md (design spec) + reference .dc.html mockups
CLAUDE.md            # this file
```

---

## 5. Data model (schema.sql)

Single-user model — **every table has `owner_id` and RLS is a plain `owner_id = auth.uid()` check.** This is deliberate and non-recursive (the v1 bug was recursive RLS policies; never reintroduce cross-table policy lookups).

- `profiles` (extends auth.users; `home_currency` default THB)
- `people` (global contacts/tokens; `is_token`, `is_self`, `linked_profile_id`; a "self" person is auto-created on signup by the `handle_new_user` trigger)
- `recordings` (`base_currency`, `exchange_rate`, `is_active`) + `recording_members`
- `expenses` (`recording_id` null = loose; `paid_by` → people; `currency`, `exchange_rate`)
- `expense_items` (`is_rest` catch-all + carve-outs; `amount`, `label`) + `expense_item_members` (`settled_at` for per-person settled status)
- `settlements` (payment ledger: `from_person`, `to_person`, `amount`, `recording_id`)

Balances are **derived client-side** from items/members/settlements (no balance column). Composite-key tables (`expense_item_members`, `recording_members`) have no `id` column.

---

## 6. Design system (source of truth: `design/TOKENS.md` + `src/index.css`)

**Aesthetic:** warm Swiss/Scandinavian editorial minimalism, flat, light mode, retro-instrument accents (Teenage Engineering / Braun / Dieter Rams). Airy, hairlines not heavy borders.

- **Fonts** (Google Fonts, in index.css): **Instrument Sans** (grotesque UI), **IBM Plex Mono** (labels/meta/legends, UPPERCASE letter-spaced), **Doto** (ALL money digits — global rule; the currency symbol is grotesque, greyed).
- **Palette (CSS vars):** `--bg #F3F0E9` (warm cream), `--surface #FCFAF5`, text `--text #1D1B16` / `--text-2` / `--text-3` / `--text-4`, `--hairline #E4E0D3`, **`--accent #E8622A`** (burnt orange — ONE element per screen only: the live REC / primary action). Flat: no gradients/shadows.
- Radii: cards 18, sheet 22, toggle 14. Motion easing `cubic-bezier(0.2,0,0,1)`, 110–280ms. Helpers: `.money`, `.mono`, `.legend`.
- **Reproduce the look by matching the styled reference in `design/`, not by re-deriving it.** Dark mode is deferred (derive later via token swap).

---

## 7. Conventions, patterns & gotchas

- **Navigation:** `App.jsx` holds `tab` (home/records/settlement), an overlay **`stack`** (array of full-screen pushed screens — ExpenseForm, CreateRecording, RecordingDetail — rendered on top of the tab, last on top), a `stub` (App-level StubSheet for not-yet-built targets like expense-detail/settle), and `refreshKey` (bump → mounted screens reload). Push with `push(o)`; each pushed screen gets `onClose`/`popOverlay(changed)` — `changed=true` pops + bumps refreshKey + reloads people. Screens re-fetch on the `refreshKey` prop so an underlying screen refreshes when an overlay above it saves.
- **RLS scopes queries automatically** to the owner; you never filter by `owner_id` in selects, but you MUST set `owner_id` on every insert.
- **After creating tokens/people**, refresh the `people` list (App reloads on overlay close).
- **Browser testing:** controls are `<div onClick>` not semantic buttons; coordinate clicks are unreliable. Drive via `javascript_tool` DOM `.click()` (e.g. find the FAB by its SVG path, click `.closest('div')`). React controlled inputs need real typing or the native value-setter + `input` event.
- **Permissions:** `.claude/settings.local.json` (gitignored) is set to `acceptEdits` + a broad Bash allow-list — routine git/npm/bash/edits run without prompting. Still confirm outward-facing/irreversible actions.
- Commit only meaningful checkpoints. Commit messages end with `Co-Authored-By: Claude <noreply@anthropic.com>`. Never commit to `main` (v1 is there / deployed).

---

## 8. Immediate next task: Phase 6 — Settlement + Expense detail

Phases 4b (Split it up) and 5 (Records/Recording detail/Create recording) are **done + verified live**. Next is Phase 6, currently both STUBBED (App-level `StubSheet`, reached from Records/RecordingDetail log rows and the "Settle up this record" button):

- **Expense detail** (§9.6) — read-only view of one logged expense: title/amount (+ base-currency equiv if foreign), paid-by/date/recording, full split breakdown (the rest + carve-outs, who's-in + per-person amounts), per-person settled/open pills, Edit (→ ExpenseForm) + Delete (confirm cautions if settled portions exist). Reached by tapping an expense anywhere (Home log, recording-detail log, Records loose row, settlement breakdown). Derive the breakdown from `expense_items` + `expense_item_members`; the settled indicator logic already exists in `RecordingDetail.jsx` (`settled_at`-based) — reuse/extract it.
- **Settlement** (§9.3) — global tab = **direct pairwise** settle (settle with each person you actually owe; NEVER route between people who don't share a record). Minimized "who pays who" is **scoped inside a record** and lives behind the RecordingDetail "Settle up this record" button (currently a stub). Partial settlement = **checking off breakdown items** (not typing amounts) → writes `settled_at` on `expense_item_members` + a `settlements` ledger row; deliberate commit + Undo. Balances are derived client-side from items/members/settlements. See the memory direction file for the full settlement design (item-check model, per-person outstanding, Undo snackbar, misclick protection).

**After Phase 6:** Settings + Friends (Phase 7), then punch-list + deploy (Phase 8, Vercel). Each screen has an approved wireframe (see memory) and reuses established patterns (overlay stack, PeoplePicker, the money/legend/mono helpers).

---

## 9. Build punch-list (fold in as relevant screens are built)

1. **Home** — settings gear is present (opens a stub); wire it to a real Settings screen when built.
2. **Expense form** — "the rest" membership editable (done in the carve-out engine); delete-item affordance (done). Verify both once §8 is finished.
3. **Settlement** — minimization scoped within-record only; global tab = direct pairwise; never route between strangers. Minimized "settle up this record" lives on the recording-detail screen.
4. **Recording detail** — ✅ DONE: "Settle up this record" ORANGE primary (add-expense secondary, stub → Phase 6); per-expense settled indicators ("settled" / "N of M · Name open" / "open"); "who's in" party roster.
5. **Records** — ✅ DONE: segmented "Recordings | Loose" two-view control with counts; search across both; "+ New recording".
6. **Expense detail** — read-only view (missing screen): title/amount (+ base equiv if foreign), paid-by/date/recording, full split breakdown, per-person settled/open pills, Edit + Delete (delete confirm cautions if settled portions exist).
7. **Friends** — filter/segment Account vs Placeholder; person detail with claim/merge/remove.
8. **Settings** — home currency lives here (default THB); profile; token reconciliation (merge/claim).
9. **Auth/Onboarding** — move the Create/Sign-in toggle to the email form; keep onboarding minimal.
10. **Token wording** — pick one user-facing term ("Placeholder" vs "Guest") and use it everywhere.
