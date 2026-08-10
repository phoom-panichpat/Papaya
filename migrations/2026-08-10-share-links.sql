-- ═══════════════════════════════════════════════════════════════════════
-- SHARE LINKS — a read-only public view of ONE record
--
-- ⚠️ RUN THIS AS TWO SEPARATE QUERIES. The Supabase SQL editor wraps a
-- script in ONE transaction, so a failure in step 2 silently rolls back
-- step 1 and it looks like nothing ran at all.
--
-- Run this BEFORE deploying the matching code (the Share control WRITES
-- share_token, so shipping early would 400).
--
-- Safety: this adds NO row-level-security policy and changes NONE of the
-- existing ones. Every table keeps its flat `owner_id = auth.uid()` check.
-- The single security-definer function in step 2 is the entire public
-- surface, and it only ever SELECTs. There is deliberately no write path.
-- ═══════════════════════════════════════════════════════════════════════


-- ═══ STEP 1 ═══ run this on its own first ══════════════════════════════
-- null = not shared. Revoke = set back to null. Regenerate = write a new
-- one, which kills every old link. `unique` still allows many nulls.
-- Safe to re-run.

alter table recordings add column if not exists share_token      text unique;
alter table recordings add column if not exists share_created_at timestamptz;


-- ═══ STEP 2 ═══ then run this on its own ═══════════════════════════════
-- The ONLY public read path. Returns null for an unknown/revoked token —
-- a visitor cannot tell an expired link from one that never existed.
--
-- Every column is named EXPLICITLY. Never `row_to_json` / `select *` here:
-- a future column would silently become public. Deliberately excluded:
-- people.payment_note (semi-private, same call as the export), owner_id,
-- emails, is_self, linked_profile_id, and anything outside this record.

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
