-- PAPAYA - Trip Expense Splitter
-- Run this in Supabase SQL Editor

-- Profiles (extends auth.users)
create table profiles (
  id uuid references auth.users on delete cascade primary key,
  display_name text not null,
  avatar_url text,
  email text,
  created_at timestamptz default now()
);

-- Auto-create profile on signup
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into profiles (id, display_name, email, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    new.email,
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Trips
create table trips (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  description text,
  start_date date,
  end_date date,
  base_currency text not null default 'THB',
  created_by uuid references profiles(id),
  invite_code text unique default substr(md5(random()::text), 1, 8),
  created_at timestamptz default now()
);

-- Trip members (real users + avatar tokens)
create table trip_members (
  id uuid default gen_random_uuid() primary key,
  trip_id uuid references trips(id) on delete cascade,
  profile_id uuid references profiles(id) on delete set null,
  display_name text not null,
  avatar_color text default '#FF6B6B',
  avatar_emoji text default '🧑',
  is_avatar boolean default false,
  claimed_by uuid references profiles(id),
  created_at timestamptz default now()
);

-- Expenses
create table expenses (
  id uuid default gen_random_uuid() primary key,
  trip_id uuid references trips(id) on delete cascade,
  paid_by uuid references trip_members(id),
  title text not null,
  total_amount numeric not null,
  currency text not null,
  exchange_rate numeric not null default 1,
  created_at timestamptz default now()
);

-- Expense line items (for partial splits)
create table expense_lines (
  id uuid default gen_random_uuid() primary key,
  expense_id uuid references expenses(id) on delete cascade,
  description text not null,
  amount numeric not null,
  created_at timestamptz default now()
);

-- Who splits each line item
create table expense_line_splits (
  id uuid default gen_random_uuid() primary key,
  expense_line_id uuid references expense_lines(id) on delete cascade,
  trip_member_id uuid references trip_members(id) on delete cascade,
  created_at timestamptz default now()
);

-- Enable RLS
alter table profiles enable row level security;
alter table trips enable row level security;
alter table trip_members enable row level security;
alter table expenses enable row level security;
alter table expense_lines enable row level security;
alter table expense_line_splits enable row level security;

-- RLS Policies

-- Profiles: users can read all, update own
create policy "Profiles are viewable by everyone" on profiles for select using (true);
create policy "Users can update own profile" on profiles for update using (auth.uid() = id);

-- Trips: anyone with invite code can view, members can edit
create policy "Trips viewable by members" on trips for select using (
  exists (select 1 from trip_members where trip_id = trips.id and profile_id = auth.uid())
  or created_by = auth.uid()
);
create policy "Authenticated users can create trips" on trips for insert with check (auth.uid() = created_by);
create policy "Trip creator can update" on trips for update using (auth.uid() = created_by);

-- Trip members: viewable by trip members
create policy "Trip members viewable by trip members" on trip_members for select using (
  exists (select 1 from trip_members tm where tm.trip_id = trip_members.trip_id and tm.profile_id = auth.uid())
  or exists (select 1 from trips t where t.id = trip_members.trip_id and t.created_by = auth.uid())
);
create policy "Trip members can be created by trip members" on trip_members for insert with check (
  exists (select 1 from trips t where t.id = trip_id and t.created_by = auth.uid())
  or exists (select 1 from trip_members tm where tm.trip_id = trip_id and tm.profile_id = auth.uid())
);
create policy "Trip members can be updated by trip members" on trip_members for update using (
  exists (select 1 from trip_members tm where tm.trip_id = trip_members.trip_id and tm.profile_id = auth.uid())
);

-- Expenses
create policy "Expenses viewable by trip members" on expenses for select using (
  exists (select 1 from trip_members tm where tm.trip_id = expenses.trip_id and tm.profile_id = auth.uid())
);
create policy "Trip members can add expenses" on expenses for insert with check (
  exists (select 1 from trip_members tm where tm.trip_id = trip_id and tm.profile_id = auth.uid())
);
create policy "Trip members can update expenses" on expenses for update using (
  exists (select 1 from trip_members tm where tm.trip_id = expenses.trip_id and tm.profile_id = auth.uid())
);
create policy "Trip members can delete expenses" on expenses for delete using (
  exists (select 1 from trip_members tm where tm.trip_id = expenses.trip_id and tm.profile_id = auth.uid())
);

-- Expense lines
create policy "Expense lines viewable by trip members" on expense_lines for select using (
  exists (
    select 1 from expenses e
    join trip_members tm on tm.trip_id = e.trip_id
    where e.id = expense_lines.expense_id and tm.profile_id = auth.uid()
  )
);
create policy "Trip members can add expense lines" on expense_lines for insert with check (
  exists (
    select 1 from expenses e
    join trip_members tm on tm.trip_id = e.trip_id
    where e.id = expense_id and tm.profile_id = auth.uid()
  )
);
create policy "Trip members can delete expense lines" on expense_lines for delete using (
  exists (
    select 1 from expenses e
    join trip_members tm on tm.trip_id = e.trip_id
    where e.id = expense_lines.expense_id and tm.profile_id = auth.uid()
  )
);

-- Expense line splits
create policy "Splits viewable by trip members" on expense_line_splits for select using (
  exists (
    select 1 from expense_lines el
    join expenses e on e.id = el.expense_id
    join trip_members tm on tm.trip_id = e.trip_id
    where el.id = expense_line_splits.expense_line_id and tm.profile_id = auth.uid()
  )
);
create policy "Trip members can add splits" on expense_line_splits for insert with check (
  exists (
    select 1 from expense_lines el
    join expenses e on e.id = el.expense_id
    join trip_members tm on tm.trip_id = e.trip_id
    where el.id = expense_line_id and tm.profile_id = auth.uid()
  )
);
create policy "Trip members can delete splits" on expense_line_splits for delete using (
  exists (
    select 1 from expense_lines el
    join expenses e on e.id = el.expense_id
    join trip_members tm on tm.trip_id = e.trip_id
    where el.id = expense_line_splits.expense_line_id and tm.profile_id = auth.uid()
  )
);
