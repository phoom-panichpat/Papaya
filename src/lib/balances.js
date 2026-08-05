// ═══════════════════════════════════════════════════════════════════════
// Balance layer — IO (load + mutations) on top of the pure math in
// balances-core.mjs (split out so the math is unit-testable in plain Node).
//
// There is NO stored balance. Every balance is derived from the split items,
// who's-in each item (expense_item_members), and per-person settled status
// (settled_at). A share is OUTSTANDING until its settled_at is set. Settling =
// set settled_at (source of truth); `settlements` is a payment-history ledger.
// ═══════════════════════════════════════════════════════════════════════
import { supabase } from "./supabase";

export {
  toHome, buildContributions, pairNet, pairNetByCurrency, pairNetByEra, sumHomeByEra,
  netByPerson, minimizeTransfers, directTransfers, statusForExpense,
  buildAliasMap, resolveAlias, patchContribsSettled, eraFor,
} from "./balances-core.mjs";

// ── load everything the money layer needs ────────────────────────────────
// Global scope (no arg) pulls all six tables for the app-wide picture
// (Settlement / PersonDetail). Pass a `recordingId` to load ONLY that record's
// expense→item→member tree (one embedded, indexed round-trip) — enough for
// RecordSettleSheet, which only ever nets one record. Scoped loads still fetch
// full `people` (small; needed for alias resolution) and the record itself (so
// toHome can apply its base/home exchange rates), and skip the settlements
// ledger, which the money math never reads.
export async function loadSettlementData(recordingId) {
  if (recordingId) return loadRecordScoped(recordingId);
  const [exp, items, mem, setl, recs, ppl] = await Promise.all([
    supabase.from("expenses").select("*"),
    supabase.from("expense_items").select("*"),
    supabase.from("expense_item_members").select("*"),
    supabase.from("settlements").select("*").order("created_at", { ascending: false }),
    supabase.from("recordings").select("*"),
    supabase.from("people").select("*"), // needed for alias (merged_into_id) resolution
  ]);
  return {
    expenses: exp.data || [],
    items: items.data || [],
    members: mem.data || [],
    settlements: setl.data || [],
    recordings: recs.data || [],
    people: ppl.data || [],
  };
}

// One record's tree in a single PostgREST-embedded query, then flattened back
// into the {expenses, items, members} shape buildContributions expects.
async function loadRecordScoped(recordingId) {
  const [tree, recRes, pplRes] = await Promise.all([
    supabase
      .from("expenses")
      .select("*, expense_items(*, expense_item_members(*))")
      .eq("recording_id", recordingId),
    supabase.from("recordings").select("*").eq("id", recordingId),
    supabase.from("people").select("*"),
  ]);
  const expenses = [], items = [], members = [];
  (tree.data || []).forEach((row) => {
    const { expense_items, ...exp } = row;
    expenses.push(exp);
    (expense_items || []).forEach((it) => {
      const { expense_item_members, ...item } = it;
      items.push(item);
      (expense_item_members || []).forEach((m) => members.push(m));
    });
  });
  return {
    expenses,
    items,
    members,
    settlements: [], // not read by the money math; unused in the record sheet
    recordings: recRes.data || [],
    people: pplRes.data || [],
  };
}

// ── person merge (alias) — non-destructive & reversible ───────────────────
// Point `personId` at `targetId` (a token → its real account). Balances
// resolve through the pointer, so all of the token's past splits follow the
// account. Un-merge = clear the pointer.
export async function mergePerson(personId, targetId) {
  await supabase.from("people").update({ merged_into_id: targetId }).eq("id", personId);
}

export async function unmergePerson(personId) {
  await supabase.from("people").update({ merged_into_id: null }).eq("id", personId);
}

// ── mutations ────────────────────────────────────────────────────────────
// Settle / un-settle specific (item, person) shares. settled_at is the
// single source of truth for outstanding balances.
// `at` is optional: optimistic callers pin the timestamp themselves so the
// local patch and the DB row carry the SAME settled_at (History groups by it).
// Throws on a failed write so optimistic UIs can re-sync instead of lying.
export async function settleShares(rows, at) {
  const now = at || new Date().toISOString();
  const results = await Promise.all(rows.map((r) =>
    supabase.from("expense_item_members")
      .update({ settled_at: now })
      .eq("item_id", r.itemId).eq("person_id", r.personId)
  ));
  const bad = results.find((r) => r.error);
  if (bad) throw bad.error;
  return now;
}

export async function unsettleShares(rows) {
  const results = await Promise.all(rows.map((r) =>
    supabase.from("expense_item_members")
      .update({ settled_at: null })
      .eq("item_id", r.itemId).eq("person_id", r.personId)
  ));
  const bad = results.find((r) => r.error);
  if (bad) throw bad.error;
}

// Record a payment in the history ledger. Returns the new row's id (for Undo).
export async function recordPayment({ ownerId, from, to, amount, recordingId = null, note = null }) {
  const { data } = await supabase.from("settlements")
    .insert({ owner_id: ownerId, from_person: from, to_person: to, amount, recording_id: recordingId, note })
    .select("id").single();
  return data?.id || null;
}

export async function deletePayment(id) {
  if (id) await supabase.from("settlements").delete().eq("id", id);
}
