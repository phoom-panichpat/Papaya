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
| 4b. "Split it up" carve-out engine | 🔶 ~80% — compiles, needs 2 wiring steps (see §8) |
| 5. Records / Recording detail / Create recording | ⬜ not started |
| 6. Settlement / Expense detail | ⬜ not started |
| 7. Settings / Friends | ⬜ not started |
| 8. Punch-list + deploy | ⬜ |

**What works right now (verified running against live Supabase):** sign in → Home accordion feed (recordings + loose expenses, live REC toggle with switch-confirm, dot-matrix amounts) → FAB opens expense form → amount keypad, currency dropdown, foreign exchange-rate card, payer + split pickers → Save persists and Home refreshes.

Two commits on `papaya-v2`: `8725d11` (foundation/Home/expense form), `c2a23f2` (cleanup + form refinements). The half-done "Split it up" work is **uncommitted** in `src/screens/ExpenseForm.jsx`.

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

- **Navigation:** `App.jsx` holds `tab` (home/records/settlement), `overlay` (full-screen pushed screens like ExpenseForm), and `refreshKey` (bump → child screens reload). Full-screen screens are rendered as overlays; pass `onClose(changed)` — `changed=true` bumps refreshKey + reloads people.
- **RLS scopes queries automatically** to the owner; you never filter by `owner_id` in selects, but you MUST set `owner_id` on every insert.
- **After creating tokens/people**, refresh the `people` list (App reloads on overlay close).
- **Browser testing:** controls are `<div onClick>` not semantic buttons; coordinate clicks are unreliable. Drive via `javascript_tool` DOM `.click()` (e.g. find the FAB by its SVG path, click `.closest('div')`). React controlled inputs need real typing or the native value-setter + `input` event.
- **Permissions:** `.claude/settings.local.json` (gitignored) is set to `acceptEdits` + a broad Bash allow-list — routine git/npm/bash/edits run without prompting. Still confirm outward-facing/irreversible actions.
- Commit only meaningful checkpoints. Commit messages end with `Co-Authored-By: Claude <noreply@anthropic.com>`. Never commit to `main` (v1 is there / deployed).

---

## 8. Immediate next task: finish "Split it up" (§4b)

`src/screens/ExpenseForm.jsx` already has: `sliced` state, `restMembers`, `items` (carve-outs), `restAmount`/`balanced`/`shares` computed, the item helpers (`addItem`/`removeItem`/`updateItem`/`toggleItemMember`/`setTargetAll`/`createPersonForItem`), the sliced render (rest card + item cards + "+ Add item" + checks-out + per-person peek), and a `sliced`-aware `save()`. **It compiles.** Two pieces remain:

1. **Render a `PeoplePicker` for `itemPicker`.** State `itemPicker` is set to `"rest"` or an item `id` when the user taps an item's "who's in" area, but nothing renders yet. Add (next to the existing `{picker && <PeoplePicker .../>}`):
   ```jsx
   {itemPicker && (() => {
     const isRest = itemPicker === "rest";
     const cur = isRest ? restMembers : (items.find((it) => it.id === itemPicker)?.members || new Set());
     return (
       <PeoplePicker people={localPeople} selectedIds={cur} multi memberIds={members}
         title={isRest ? "Who splits the rest?" : "Who's in?"}
         onToggle={(p) => toggleItemMember(itemPicker, p)}
         onEveryone={() => setTargetAll(itemPicker, true)}
         onClear={() => setTargetAll(itemPicker, false)}
         onClose={() => setItemPicker(null)} onCreate={createPersonForItem} />
     );
   })()}
   ```
2. **Add `Everyone`/`Clear` shortcut chips to `PeoplePicker`.** Accept `onEveryone` + `onClear` props; when `multi` and either is provided, render two pill chips above the people groups (Everyone → selects all, Clear → deselects all).

Then verify: FAB → enter amount → "Split it up" → add an item ("Wine", amount) → assign members → confirm "the rest" auto-recomputes, "Checks out" shows total, per-person peek is correct → Save → check it persists.

**After that:** apply the build punch-list below and continue to Records → Recording detail → Create recording → Settlement → Expense detail → Settings → Friends, then deploy (Vercel). Each screen has an approved wireframe (see memory) and reuses established patterns.

---

## 9. Build punch-list (fold in as relevant screens are built)

1. **Home** — settings gear is present (opens a stub); wire it to a real Settings screen when built.
2. **Expense form** — "the rest" membership editable (done in the carve-out engine); delete-item affordance (done). Verify both once §8 is finished.
3. **Settlement** — minimization scoped within-record only; global tab = direct pairwise; never route between strangers. Minimized "settle up this record" lives on the recording-detail screen.
4. **Recording detail** — "Settle up this record" is the ORANGE primary (add-expense secondary); per-expense settled indicators ("settled" / "2 of 3 · Mia open" / "open"); a "who's in" party roster.
5. **Records** — segmented "Recordings | Loose" two-view control (each scrolls independently); search across both.
6. **Expense detail** — read-only view (missing screen): title/amount (+ base equiv if foreign), paid-by/date/recording, full split breakdown, per-person settled/open pills, Edit + Delete (delete confirm cautions if settled portions exist).
7. **Friends** — filter/segment Account vs Placeholder; person detail with claim/merge/remove.
8. **Settings** — home currency lives here (default THB); profile; token reconciliation (merge/claim).
9. **Auth/Onboarding** — move the Create/Sign-in toggle to the email form; keep onboarding minimal.
10. **Token wording** — pick one user-facing term ("Placeholder" vs "Guest") and use it everywhere.
