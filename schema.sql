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
  -- How to pay this person: an account number, a PromptPay id, whatever they
  -- actually give people. On the PERSON and not on an expense, so you enter it
  -- once instead of every time they pay for something. Display only.
  payment_note      text,
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
  -- SHARE LINK: null = not shared. A random token that unlocks a read-only
  -- public view of this one record (see get_shared_record at the bottom of
  -- this file). Revoke = set back to null; regenerate = write a new one,
  -- which kills every old link. `unique` still permits many nulls.
  share_token      text unique,
  share_created_at timestamptz,
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
  note          text,     -- free text: "what was this ฿400 for?", answered months later
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

-- ── share links: the ONLY public read path ─────────────────────────────
-- A read-only view of ONE record, unlocked by recordings.share_token.
--
-- 🔑 This adds NO RLS policy and changes none of the existing ones. Rather
-- than teaching the tables "this visitor may read this row" — a cross-table
-- lookup inside a policy, i.e. exactly the recursion that killed v1 — the
-- entire public surface is this one security-definer function. It only ever
-- SELECTs, so there is no public write path at all.
--
-- Every column is named EXPLICITLY: never row_to_json / select * here, or a
-- future column would silently become public. people.payment_note is
-- deliberately absent — it is how someone gets PAID, and this payload lands
-- in a group chat.

create or replace function get_shared_record(token text)
returns json
language sql
security definer
stable
set search_path = public
as $$
with
rec as (
  select * from recordings r
   where token is not null
     and r.share_token is not null
     and r.share_token = token
   limit 1
),
exp as (
  select e.* from expenses e where e.recording_id in (select id from rec)
),
itm as (
  select i.* from expense_items i where i.expense_id in (select id from exp)
),
mem as (
  select m.* from expense_item_members m where m.item_id in (select id from itm)
),
grp as (
  select g.* from summary_groups g where g.recording_id in (select id from rec)
),
xfer as (
  select t.* from summary_transfers t where t.recording_id in (select id from rec)
),
rmem as (
  select rm.* from recording_members rm where rm.recording_id in (select id from rec)
),
-- Everyone this record actually references …
seed_people as (
  select paid_by     as id from exp
  union select person_id   from mem
  union select from_person from xfer
  union select to_person   from xfer
  union select person_id   from rmem
),
-- … plus anyone they've been merged INTO. Without this a merged token
-- resolves (via merged_into_id) to a person missing from the payload and
-- renders as a blank name. ONE hop, which covers the real case (token →
-- account); a longer merge chain would drop its tail, and the failure mode
-- is a blank name on a shared page, never a wrong number.
ppl_ids as (
  select id from seed_people
  union
  select p.merged_into_id from people p
   where p.merged_into_id is not null
     and p.id in (select id from seed_people)
)
select case when not exists (select 1 from rec) then null::json else json_build_object(
  'recording', (select json_build_object(
      'id',            r.id,
      'name',          r.name,
      'base_currency', r.base_currency,
      'exchange_rate', r.exchange_rate,
      'home_currency', r.home_currency,
      'archived_at',   r.archived_at,
      'created_at',    r.created_at
    ) from rec r),

  'expenses', coalesce((select json_agg(json_build_object(
      'id',               e.id,
      'recording_id',     e.recording_id,
      'paid_by',          e.paid_by,
      'title',            e.title,
      'note',             e.note,
      'total_amount',     e.total_amount,
      'service_charge',   e.service_charge,
      'currency',         e.currency,
      'exchange_rate',    e.exchange_rate,
      'home_rate',        e.home_rate,
      'home_currency',    e.home_currency,
      'summary_group_id', e.summary_group_id,
      'created_at',       e.created_at
    )) from exp e), '[]'::json),

  'items', coalesce((select json_agg(json_build_object(
      'id',         i.id,
      'expense_id', i.expense_id,
      'label',      i.label,
      'amount',     i.amount,
      'is_rest',    i.is_rest,
      'sort_order', i.sort_order
    )) from itm i), '[]'::json),

  'members', coalesce((select json_agg(json_build_object(
      'item_id',    m.item_id,
      'person_id',  m.person_id,
      'settled_at', m.settled_at,
      'summary_id', m.summary_id
    )) from mem m), '[]'::json),

  'groups', coalesce((select json_agg(json_build_object(
      'id',           g.id,
      'recording_id', g.recording_id,
      'name',         g.name,
      'frozen_at',    g.frozen_at,
      'created_at',   g.created_at
    )) from grp g), '[]'::json),

  'transfers', coalesce((select json_agg(json_build_object(
      'id',            t.id,
      'summary_id',    t.summary_id,
      'recording_id',  t.recording_id,
      'from_person',   t.from_person,
      'to_person',     t.to_person,
      'amount',        t.amount,
      'currency',      t.currency,
      'home_amount',   t.home_amount,
      'home_currency', t.home_currency,
      'settled_at',    t.settled_at,
      'superseded_by', t.superseded_by
    )) from xfer t), '[]'::json),

  'recording_members', coalesce(
    (select json_agg(json_build_object('person_id', rm.person_id)) from rmem rm),
    '[]'::json),

  -- NOTE: payment_note is deliberately absent. It is how someone gets PAID,
  -- and this payload lands in a group chat.
  'people', coalesce((select json_agg(json_build_object(
      'id',             p.id,
      'display_name',   p.display_name,
      'avatar_emoji',   p.avatar_emoji,
      'avatar_color',   p.avatar_color,
      'merged_into_id', p.merged_into_id
    )) from people p
     where p.id in (select id from ppl_ids)
       -- defense-in-depth: RLS is bypassed in here, so scope to the owner too
       and p.owner_id = (select owner_id from rec)), '[]'::json)
) end;
$$;

grant execute on function get_shared_record(text) to anon, authenticated;
