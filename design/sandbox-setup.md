# Sandbox setup — a throwaway Supabase project for the multi-user phase

**Why:** multi-user changes the database's *security rules*, which are instant and
global. A wrong rule doesn't delete data, but it can make the app show nothing,
show too much, or error on every query (the bug that killed v1). None of that is
acceptable on a database you're using on a trip.

**And you need it regardless:** you cannot test "Rui gets invited and joins my
record" with one login. Multi-user work requires two real accounts, so a second
project isn't a precaution bolted on top — it's a requirement of the work.

**Time:** ~10 minutes. Nothing here touches production.

---

## Before you start (do this once, from wherever you are)

- [ ] **Export a CSV of every record you care about.** Record → Share → Download CSV.
      Free-tier Supabase has no backups, so this is your only real snapshot.

---

## 1. Create the project

- [ ] https://supabase.com/dashboard → **New project**
- [ ] Name: `papaya-sandbox` · region: same as production is fine · free tier
- [ ] Save the database password somewhere (you won't need it for the app, but
      losing it is annoying)

## 2. Auth settings (both are required — the app breaks without the first)

- [ ] **Auth → Sign In / Providers → Email → turn "Confirm email" OFF.**
      Otherwise a new signup can never log in.
- [ ] **Auth → Sign In / Providers → turn "Anonymous sign-ins" ON.**
      This is what makes the DEV "continue as guest" button work, which is how
      Claude verifies UI changes without touching real data.

## 3. Apply the schema

- [ ] SQL editor → paste all of `schema.sql` → Run.
- [ ] It should report success. If it errors, nothing is lost — the editor runs
      the script in one transaction, so a failure rolls the whole thing back.
      Fix and re-run.

## 4. Point the app at it

- [ ] Project **Settings → API** → copy the **Project URL** and the **anon public** key
- [ ] Create `.env.sandbox` in the repo root:

```
VITE_SUPABASE_URL=https://<your-sandbox-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<the anon public key>
```

- [ ] Confirm it's ignored by git: `git status` must NOT list `.env.sandbox`.
      (`.gitignore` covers `.env.*`, but check — these are live keys.)

## 5. Run against it

```bash
npm run dev:sandbox
```

That loads `.env.sandbox` instead of `.env`. **Plain `npm run dev` still points at
production** — so switching back is just dropping the `:sandbox`.

- [ ] **Sanity check before trusting it:** sign in, and confirm you see an EMPTY
      account, not your Korea data. If you see real records, you're on production —
      stop and re-check the env file.

## 6. Seed it, twice

- [ ] Create account **A** (e.g. `a@test.com`) → Home → **add demo data**
- [ ] Create account **B** (e.g. `b@test.com`) → leave it empty

Account B is the friend you'll be inviting. Multi-user is untestable without it.

---

## Rules while working in the sandbox

- **Production is never touched until a design is proven here and you deliberately
  migrate it.** Migrations get run on the sandbox first, always.
- **Never point the Vercel project at the sandbox.** Production env vars stay as
  they are. (Vite inlines them at build time, so a change there needs a redeploy —
  which is also your safety net: it can't happen by accident.)
- Deploying sandbox *code* is fine as long as it's additive and the production
  database has had its migration run. Rule of thumb from `CLAUDE.md` §10.7:
  **does the new code WRITE the new column?** If yes, the SQL runs first.

## When you're done with it

Delete the project, or leave it — it's free and it's the right place to test every
future migration. Recommend leaving it.
