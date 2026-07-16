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
  toHome, buildContributions, pairNet, netByPerson, minimizeTransfers, directTransfers, statusForExpense,
  buildAliasMap, resolveAlias,
} from "./balances-core.mjs";

// ── load everything the money layer needs ────────────────────────────────
export async function loadSettlementData() {
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
export async function settleShares(rows) {
  const now = new Date().toISOString();
  await Promise.all(rows.map((r) =>
    supabase.from("expense_item_members")
      .update({ settled_at: now })
      .eq("item_id", r.itemId).eq("person_id", r.personId)
  ));
  return now;
}

export async function unsettleShares(rows) {
  await Promise.all(rows.map((r) =>
    supabase.from("expense_item_members")
      .update({ settled_at: null })
      .eq("item_id", r.itemId).eq("person_id", r.personId)
  ));
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
