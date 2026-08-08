-- ═══════════════════════════════════════════════════════════════════════
-- PAPAYA v2 — Database schema
-- Apply to a CLEAN database: a fresh Supabase project (recommended), OR drop
-- the old v1 tables first. See schema.v1.sql for the old model.
--
-- Model: single-user. Every row is owned by one user (owner_id = auth.uid()).
-- RLS is deliberately SIMPLE — a plain owner_id check on every table — so it
-- can NEVER recurse (that was the v1 bug). No cross-table policy lookups.
-- ═══════════════════════════════════════════════════════════════════════

-- ── profiles (extends auth.users) ──────────────────────────────────────
create table profiles (
  id            uuid primary key references auth.users on delete cascade,
  display_name  text not null,
  email         text,
  avatar_url    text,
  home_currency text not null default 'THB',
  created_at    timestamptz default now()
);

-- ── people (global contacts + tokens) ──────────────────────────────────
-- The atomic unit. A person is either a real account (is_token=false,
-- linked_profile_id set) or a placeholder token (is_token=true). Each user
-- has a "self" person representing "You".
create table people (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references profiles(id) on delete cascade,
  display_name      text not null,
  avatar_emoji      text default '🙂',
  avatar_color      text default '#E8622A',
  is_token          boolean not null default true,
  is_self           boolean not null default false,
  linked_profile_id uuid references profiles(id),
  merged_into_id    uuid references people(id),  -- non-destructive alias: this person IS that person (token→account merge); balances resolve through it, un-merge = null
  created_at        timestamptz default now()
);

-- ── recordings (containers: trip / night out / recurring group) ─────────
-- Purely organizational. Date range is DERIVED from expenses, not stored.
-- base_currency null = use the recording's home_currency (its era).
-- exchange_rate = base→that era.
create table recordings (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references profiles(id) on delete cascade,
  name          text not null,
  base_currency text,
  exchange_rate numeric,
  -- The home currency this recording was created under — its ERA. Fixed at
  -- creation and inherited by EVERY expense filed here, including ones added
  -- after the user switches home currency: that switch is a fact about the
  -- user, not about the group who share this record, so it must never
  -- re-denominate or split it. Editing a recording never changes this.
  home_currency text,
  is_active     boolean not null default false,  -- live session (max one per owner; enforced in app)
  archived_at   timestamptz,                     -- null = active (on Home); set = archived (in History)
  created_at    timestamptz default now()
);

-- party roster (optional at creation, auto-grows as people appear in expenses)
create table recording_members (
  recording_id uuid not null references recordings(id) on delete cascade,
  person_id    uuid not null references people(id) on delete cascade,
  owner_id     uuid not null references profiles(id) on delete cascade,
  primary key (recording_id, person_id)
);

-- ── summary_groups (consolidation, as a thing you can see) ──────────────
-- A group is a SET OF EXPENSES inside one record that you've decided to settle
-- together. In the log it renders as one collapsible box: the summary (a few
-- netted transfers) on top, the expenses it covers underneath.
--
-- 🔑 A GROUP IS LIVE UNTIL SOMEONE PAYS. While frozen_at is null no transfer
-- rows exist at all — the plan is DERIVED from the group's open shares on every
-- render, so editing an expense inside simply changes the plan. The moment a
-- transfer is marked paid the group FREEZES: the plan is materialized into
-- summary_transfers with pinned amounts, its shares are stamped closed, and its
-- expenses become read-only.
--
-- That trigger is the whole design. A plan nobody has acted on is safe to
-- recompute; the moment real money moves it has to stop moving. Freezing at
-- creation instead (the first cut) meant adding one expense forced you to
-- unwind the entire summary.
--
-- Unfreezing = clearing every settled transfer. Frozen groups are never added
-- to: new expenses form a new group, which is what keeps this repeatable.
create table summary_groups (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references profiles(id) on delete cascade,
  recording_id   uuid not null references recordings(id) on delete cascade,
  name           text,          -- editable; null = derive from the date range of its expenses
  frozen_at      timestamptz,   -- null = live (transfers derived); set = hardened
  freeze_event_id uuid,         -- → settlement_events(id); FK added below (declared later)
  created_at     timestamptz default now()
);

-- ── expenses ────────────────────────────────────────────────────────────
-- recording_id null = a loose (standalone) expense.
create table expenses (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references profiles(id) on delete cascade,
  recording_id  uuid references recordings(id) on delete set null,
  paid_by       uuid not null references people(id),
  title         text not null,
  total_amount  numeric not null,  -- the SUBTOTAL: what the items add up to (excludes service_charge)
  -- Service charge / VAT / any extra fee, in this expense's own currency.
  -- Kept OUT of total_amount and out of item amounts so it stays a visible,
  -- editable fact rather than being silently baked into the split. Allocated
  -- PROPORTIONALLY to each item's subtotal at derive time (see feeFactor in
  -- balances-core.mjs) — whoever ordered the expensive dish carries more of it.
  -- null = no fee, which is why adding this column moved no existing balance.
  service_charge numeric,
  currency      text,     -- null = inherit recording base / home
  exchange_rate numeric,  -- expense currency → recording base (pre-fill / edit default)
  -- THE CURRENCY INVARIANT: this expense's OWN native→home rate, PINNED at
  -- creation. It is what every balance reads (see toHome), so a recording's
  -- currency can never retroactively rewrite a debt logged under it.
  home_rate     numeric,
  -- The currency home_rate converts INTO — this expense's ERA. A rate without
  -- the currency it points at is meaningless: change your home currency and
  -- every old pin would silently be labelled wrong. Expenses logged under THB
  -- stay knowable in THB forever; ones logged after a switch to USD are
  -- knowable in USD. Nothing old is ever converted between eras.
  home_currency text,
  archived_at   timestamptz,  -- loose expenses only: null = on Home; set = archived (Settlement → History). Deliberate act; settled ≠ archived.
  -- Which summary group this expense belongs to (null = ungrouped). Membership
  -- is by EXPENSE, not by share: a group is something you can see in the log,
  -- so it has to survive an edit that rebuilds the expense's items.
  summary_group_id uuid references summary_groups(id) on delete set null,
  created_at    timestamptz default now()
);

-- split items: the catch-all "the rest" (is_rest=true) + carve-outs (Wine, …)
create table expense_items (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references profiles(id) on delete cascade,
  expense_id  uuid not null references expenses(id) on delete cascade,
  label       text,     -- null for "the rest"
  amount      numeric not null,
  is_rest     boolean not null default false,
  sort_order  int default 0,
  created_at  timestamptz default now()
);

-- ── settlement_events (append-only log) ─────────────────────────────────
-- Every settlement-shaped ACTION is appended here and never edited or deleted.
-- A summary IS an event, so "undo" appends `summary_reverted` rather than
-- erasing — which is what makes an audit trail possible at all. (Un-settling a
-- share used to erase the settle with no trace; that was the July 2026
-- complaint this table finally answers.)
--
--   kind = 'summary'          — a record's open debts were consolidated
--          'summary_reverted' — that consolidation was undone (ref_event_id)
--          'settle_shares'    — shares marked paid      (not written yet — 5d)
--          'unsettle_shares'  — shares reopened         (not written yet — 5d)
--
-- ⚠️ Nothing in this table affects a balance. Balances come from open shares
-- and live summary_transfers only. This is a log; keep it a log.
-- (Declared before expense_item_members because that table points at it.)
create table settlement_events (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references profiles(id) on delete cascade,
  kind          text not null,
  recording_id  uuid references recordings(id) on delete set null,
  ref_event_id  uuid references settlement_events(id),  -- e.g. the summary a revert undoes
  shares        jsonb,   -- [{itemId, personId}] the shares this event covered
  note          text,
  created_at    timestamptz default now()
);

-- summary_groups was declared before expenses (which point at it), so its FK to
-- the event log is added here, once settlement_events exists.
alter table summary_groups
  add constraint summary_groups_freeze_event_fk
  foreign key (freeze_event_id) references settlement_events(id);

-- who's in each item (+ per-person settled status).
-- settled_at null = still open; set = that person's share of this item is paid.
create table expense_item_members (
  item_id    uuid not null references expense_items(id) on delete cascade,
  person_id  uuid not null references people(id) on delete cascade,
  owner_id   uuid not null references profiles(id) on delete cascade,
  settled_at timestamptz,
  -- CLOSED BY A SUMMARY. Set = this share was folded into a summary's transfers
  -- and no longer counts as a debt on its own. This is a THIRD state, distinct
  -- from settled: nobody paid it, it was replaced. It is the entire freeze
  -- mechanism — without it a summary's transfer and the share it consolidated
  -- would both be live and neither would know about the other (the exact
  -- ambiguity that made minimized transfers un-tappable in Phase 6).
  -- Reverting a summary nulls this and the share is simply open again.
  summary_id uuid references settlement_events(id),
  primary key (item_id, person_id)
);

-- ── summary_transfers (the live obligations a summary creates) ──────────
-- "C pays A ฿200". Replaces the shares it consolidated, and carries its own
-- settled_at with exactly the same lifecycle as a share's (tap = paid, tap
-- again = unpaid, faded + struck when settled).
--
-- OPEN DEBT = anything not settled AND not superseded. The one rule, applied
-- identically to shares and transfers — which is why a second summary sweeps up
-- new expenses AND unpaid transfers from the first with no special-casing.
--
-- home_amount is PINNED, not derived: netting several expenses (each with its
-- own pinned rate) into two transfers has no unique correct home split, so the
-- amount itself is stored rather than recomputed later. Same reasoning as
-- expenses.home_rate — a figure that is re-derived at display time is a figure
-- that can silently change.
create table summary_transfers (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references profiles(id) on delete cascade,
  summary_id    uuid not null references settlement_events(id) on delete cascade,
  recording_id  uuid references recordings(id) on delete set null,  -- denormalized from the summary, so a record-scoped load is one indexed filter
  from_person   uuid not null references people(id),   -- the debtor
  to_person     uuid not null references people(id),   -- the creditor
  amount        numeric not null,   -- in the record's base currency
  currency      text,
  home_amount   numeric,
  home_currency text,               -- the era this transfer's home amount is in
  settled_at    timestamptz,
  -- Kept from the pre-group model, where a later summary could fold in an
  -- earlier one's unpaid transfers. Under the group model it is always null:
  -- a frozen group is never added to, so nothing supersedes it. buildTransferAtoms
  -- still honours it, which keeps any row written by the old flow correct.
  superseded_by uuid references settlement_events(id),
  created_at    timestamptz default now()
);

-- ── indexes ─────────────────────────────────────────────────────────────
create index on people(owner_id);
create index on recordings(owner_id);
create index on recording_members(owner_id);
create index on expenses(owner_id);
create index on expenses(recording_id);
create index on expense_items(expense_id);
create index on expense_item_members(owner_id);
create index on settlement_events(owner_id);
create index on settlement_events(recording_id);
create index on summary_transfers(owner_id);
create index on summary_transfers(recording_id);
create index on summary_transfers(summary_id);
create index on summary_groups(owner_id);
create index on summary_groups(recording_id);
create index on expenses(summary_group_id);

-- ── auto-create profile + "self" person on signup ───────────────────────
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  new_name text;
begin
  new_name := coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1));
  insert into profiles (id, display_name, email)
    values (new.id, new_name, new.email);
  insert into people (owner_id, display_name, is_token, is_self, linked_profile_id)
    values (new.id, new_name, false, true, new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ── RLS: simple owner-scoped, non-recursive ─────────────────────────────
alter table profiles             enable row level security;
alter table people               enable row level security;
alter table recordings           enable row level security;
alter table recording_members    enable row level security;
alter table expenses             enable row level security;
alter table expense_items        enable row level security;
alter table expense_item_members enable row level security;
alter table settlement_events    enable row level security;
alter table summary_transfers    enable row level security;
alter table summary_groups       enable row level security;

-- profiles: user sees/edits only their own row
create policy "profiles_select" on profiles for select using (id = auth.uid());
create policy "profiles_update" on profiles for update using (id = auth.uid());
create policy "profiles_insert" on profiles for insert with check (id = auth.uid());

-- every other table: full CRUD where owner_id = auth.uid()
create policy "owner_all" on people               for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "owner_all" on recordings           for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "owner_all" on recording_members    for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "owner_all" on expenses             for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "owner_all" on expense_items        for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "owner_all" on expense_item_members for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "owner_all" on settlement_events    for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "owner_all" on summary_transfers    for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "owner_all" on summary_groups       for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
