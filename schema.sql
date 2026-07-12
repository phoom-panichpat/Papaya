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
  created_at        timestamptz default now()
);

-- ── recordings (containers: trip / night out / recurring group) ─────────
-- Purely organizational. Date range is DERIVED from expenses, not stored.
-- base_currency null = use owner's home_currency. exchange_rate = base→home.
create table recordings (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references profiles(id) on delete cascade,
  name          text not null,
  base_currency text,
  exchange_rate numeric,
  is_active     boolean not null default false,  -- live session (max one per owner; enforced in app)
  created_at    timestamptz default now()
);

-- party roster (optional at creation, auto-grows as people appear in expenses)
create table recording_members (
  recording_id uuid not null references recordings(id) on delete cascade,
  person_id    uuid not null references people(id) on delete cascade,
  owner_id     uuid not null references profiles(id) on delete cascade,
  primary key (recording_id, person_id)
);

-- ── expenses ────────────────────────────────────────────────────────────
-- recording_id null = a loose (standalone) expense.
create table expenses (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references profiles(id) on delete cascade,
  recording_id  uuid references recordings(id) on delete set null,
  paid_by       uuid not null references people(id),
  title         text not null,
  total_amount  numeric not null,
  currency      text,     -- null = inherit recording base / home
  exchange_rate numeric,  -- per-expense override (rare edge case)
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

-- who's in each item (+ per-person settled status).
-- settled_at null = still open; set = that person's share of this item is paid.
create table expense_item_members (
  item_id    uuid not null references expense_items(id) on delete cascade,
  person_id  uuid not null references people(id) on delete cascade,
  owner_id   uuid not null references profiles(id) on delete cascade,
  settled_at timestamptz,
  primary key (item_id, person_id)
);

-- ── settlements (payment ledger) ────────────────────────────────────────
-- A payment from one person to another that offsets their balance.
-- recording_id set when settling a specific record; null = general settle-up.
create table settlements (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references profiles(id) on delete cascade,
  from_person  uuid not null references people(id),
  to_person    uuid not null references people(id),
  amount       numeric not null,
  recording_id uuid references recordings(id) on delete set null,
  note         text,
  created_at   timestamptz default now()
);

-- ── indexes ─────────────────────────────────────────────────────────────
create index on people(owner_id);
create index on recordings(owner_id);
create index on recording_members(owner_id);
create index on expenses(owner_id);
create index on expenses(recording_id);
create index on expense_items(expense_id);
create index on expense_item_members(owner_id);
create index on settlements(owner_id);

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
alter table settlements          enable row level security;

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
create policy "owner_all" on settlements          for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
