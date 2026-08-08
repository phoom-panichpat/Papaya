// ═══════════════════════════════════════════════════════════════════════
// Balance layer — IO (load + mutations) on top of the pure math in
// balances-core.mjs (split out so the math is unit-testable in plain Node).
//
// There is NO stored balance. Every balance is derived from the split items,
// who's-in each item (expense_item_members), per-person settled status
// (settled_at), and any live summary_transfers. A debt is OPEN while it is
// neither settled nor superseded — the same rule for a share and for a transfer.
// ═══════════════════════════════════════════════════════════════════════
import { supabase } from "./supabase";

export {
  toHome, buildContributions, pairNet, pairNetByCurrency, pairNetByEra, sumHomeByEra,
  netByPerson, minimizeTransfers, directTransfers, statusForExpense,
  buildAliasMap, resolveAlias, patchContribsSettled, eraFor,
  serviceCharge, grandTotal, feeFactor,
  buildTransferAtoms, planSummary, canRevertSummary,
  groupDateName, sortLogEntries,
} from "./balances-core.mjs";

// ── load everything the money layer needs ────────────────────────────────
// Global scope (no arg) pulls the app-wide picture (Settlement / PersonDetail).
// Pass a `recordingId` to load ONLY that record's expense→item→member tree (one
// embedded, indexed round-trip) — enough for RecordSettleSheet, which only ever
// nets one record. Scoped loads still fetch full `people` (small; needed for
// alias resolution) and the record itself (so toHome can apply its base/home
// exchange rates).
//
// `transfers` is always supplied (empty when there are none), so
// buildContributions folds summary transfers in automatically and no screen can
// forget to include them.
export async function loadSettlementData(recordingId) {
  if (recordingId) return loadRecordScoped(recordingId);
  const [exp, items, mem, recs, ppl, xfer] = await Promise.all([
    supabase.from("expenses").select("*"),
    supabase.from("expense_items").select("*"),
    supabase.from("expense_item_members").select("*"),
    supabase.from("recordings").select("*"),
    supabase.from("people").select("*"), // needed for alias (merged_into_id) resolution
    supabase.from("summary_transfers").select("*"),
  ]);
  return {
    expenses: exp.data || [],
    items: items.data || [],
    members: mem.data || [],
    recordings: recs.data || [],
    people: ppl.data || [],
    transfers: xfer.data || [],
  };
}

// One record's tree in a single PostgREST-embedded query, then flattened back
// into the {expenses, items, members} shape buildContributions expects.
async function loadRecordScoped(recordingId) {
  const [tree, recRes, pplRes, xferRes] = await Promise.all([
    supabase
      .from("expenses")
      .select("*, expense_items(*, expense_item_members(*))")
      .eq("recording_id", recordingId),
    supabase.from("recordings").select("*").eq("id", recordingId),
    supabase.from("people").select("*"),
    // summary_transfers carries its own recording_id (denormalized from the
    // summary) precisely so this stays one indexed filter, not a join.
    supabase.from("summary_transfers").select("*").eq("recording_id", recordingId),
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
    recordings: recRes.data || [],
    people: pplRes.data || [],
    transfers: xferRes.data || [],
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

// ── summaries ────────────────────────────────────────────────────────────
// Write a planned summary (see planSummary, which produces `plan` and writes
// nothing). Returns the new summary's event id.
//
// ⚠️ THE WRITE ORDER IS THE SAFETY PROPERTY, not an implementation detail.
// These are four statements, not one transaction, so a failure can land
// half-way. Creating the replacement FIRST and freezing the originals LAST
// means a partial failure leaves both live — a visible double-count you can see
// and revert. The opposite order would freeze shares that no transfer replaced:
// money silently gone, with nothing on screen to tell you. Fail loud, never
// quiet. (If this ever proves not good enough, the upgrade is a Postgres RPC —
// the same answer C2 needed for the same reason.)
// Returns { summaryId, transfers } — the caller needs the written rows to settle
// the transfer that triggered a freeze.
export async function createSummary({ ownerId, recordingId, plan, note = null }) {
  const { data: ev, error: evErr } = await supabase
    .from("settlement_events")
    .insert({
      owner_id: ownerId, kind: "summary", recording_id: recordingId,
      shares: plan.shareKeys || [], note,
    })
    .select("id").single();
  if (evErr) throw evErr;
  const summaryId = ev.id;

  let transfers = [];
  if (plan.transfers?.length) {
    const { data, error } = await supabase.from("summary_transfers").insert(
      plan.transfers.map((t) => ({
        owner_id: ownerId,
        summary_id: summaryId,
        recording_id: recordingId,
        from_person: t.from,
        to_person: t.to,
        amount: t.amount,
        currency: plan.currency,
        home_amount: t.homeAmount,
        home_currency: plan.homeCurrency,
      }))
    ).select();
    if (error) throw error;
    transfers = data || [];
  }

  // unpaid transfers from an earlier summary that this one folds in
  if (plan.transferIds?.length) {
    const { error } = await supabase.from("summary_transfers")
      .update({ superseded_by: summaryId }).in("id", plan.transferIds);
    if (error) throw error;
  }

  const results = await Promise.all((plan.shareKeys || []).map((k) =>
    supabase.from("expense_item_members")
      .update({ summary_id: summaryId })
      .eq("item_id", k.itemId).eq("person_id", k.personId)
  ));
  const bad = results.find((r) => r.error);
  if (bad) throw bad.error;
  return { summaryId, transfers };
}

// Undo a summary. Only legal while it is the latest and none of its transfers
// are settled — check canRevertSummary first.
//
// Order mirrors createSummary's reasoning in reverse: put the real debts BACK
// before removing what stood in for them, so a partial failure double-counts
// (loud) rather than erases (silent). The summary's own transfer rows are
// deleted — they never happened — while the event log keeps both the summary
// and this revert, which is the whole point of an append-only log.
export async function revertSummary({ ownerId, summaryId, recordingId = null, note = null }) {
  const un = await supabase.from("expense_item_members")
    .update({ summary_id: null }).eq("summary_id", summaryId);
  if (un.error) throw un.error;

  const restore = await supabase.from("summary_transfers")
    .update({ superseded_by: null }).eq("superseded_by", summaryId);
  if (restore.error) throw restore.error;

  const del = await supabase.from("summary_transfers").delete().eq("summary_id", summaryId);
  if (del.error) throw del.error;

  const { error } = await supabase.from("settlement_events").insert({
    owner_id: ownerId, kind: "summary_reverted", recording_id: recordingId,
    ref_event_id: summaryId, note,
  });
  if (error) throw error;
}

// A transfer's settled lifecycle is exactly a share's: set the timestamp, clear
// it to reverse. Both throw on a failed write so optimistic UIs re-sync instead
// of lying about what was saved.
export async function settleTransfer(id, at) {
  const now = at || new Date().toISOString();
  const { error } = await supabase.from("summary_transfers")
    .update({ settled_at: now }).eq("id", id);
  if (error) throw error;
  return now;
}

export async function unsettleTransfer(id) {
  const { error } = await supabase.from("summary_transfers")
    .update({ settled_at: null }).eq("id", id);
  if (error) throw error;
}

// ── summary groups ───────────────────────────────────────────────────────
// A group is the visible half of a summary: a set of expenses you've decided to
// settle together, LIVE (plan derived, nothing written but the membership)
// until someone marks a transfer paid.
//
// Lifecycle: createGroup → [edit its expenses freely, plan recomputes] →
// freezeGroup (on first payment: materializes transfers + closes shares) →
// unfreezeGroup (on clearing every settled transfer).

export async function loadGroups(recordingId) {
  const [gRes, tRes] = await Promise.all([
    supabase.from("summary_groups").select("*")
      .eq("recording_id", recordingId).order("created_at", { ascending: false }),
    supabase.from("summary_transfers").select("*").eq("recording_id", recordingId),
  ]);
  const transfers = tRes.data || [];
  return (gRes.data || []).map((g) => ({
    ...g,
    // A live group has no transfer rows at all — its plan is derived. Only a
    // frozen one carries them, keyed by the event created at freeze time.
    transfers: g.freeze_event_id
      ? transfers.filter((t) => t.summary_id === g.freeze_event_id)
      : [],
  }));
}

export async function createGroup({ ownerId, recordingId, expenseIds, name = null }) {
  const { data, error } = await supabase.from("summary_groups")
    .insert({ owner_id: ownerId, recording_id: recordingId, name })
    .select("id").single();
  if (error) throw error;
  await setGroupExpenses(data.id, expenseIds, recordingId);
  return data.id;
}

// Set a LIVE group's membership to exactly `expenseIds`. Clears any expense in
// this record that pointed here and is no longer selected, so re-running
// check-mode is idempotent. Also absorbs expenses from other live groups, which
// is how two pending groups merge into one.
export async function setGroupExpenses(groupId, expenseIds, recordingId) {
  const clear = await supabase.from("expenses")
    .update({ summary_group_id: null })
    .eq("recording_id", recordingId).eq("summary_group_id", groupId);
  if (clear.error) throw clear.error;
  if (expenseIds?.length) {
    const { error } = await supabase.from("expenses")
      .update({ summary_group_id: groupId }).in("id", expenseIds);
    if (error) throw error;
  }
}

export async function renameGroup(groupId, name) {
  const { error } = await supabase.from("summary_groups")
    .update({ name: name || null }).eq("id", groupId);
  if (error) throw error;
}

// Dissolve a LIVE group — the expenses go back to standing on their own.
// Membership is released BEFORE the row is deleted so a failure leaves an empty
// group (visible, harmless) rather than expenses pointing at nothing.
export async function ungroup(groupId, recordingId) {
  await setGroupExpenses(groupId, [], recordingId);
  const { error } = await supabase.from("summary_groups").delete().eq("id", groupId);
  if (error) throw error;
}

// FREEZE — triggered by the first payment, never by creating the group.
// Materializes the derived plan into real transfers, closes the shares behind
// it, and marks the group hardened. Reuses createSummary so the write-order
// safety property (replacement first, freeze the originals last) lives in one
// place. Returns the written transfer rows so the caller can settle the one
// that was tapped.
export async function freezeGroup({ ownerId, groupId, recordingId, plan }) {
  const { summaryId, transfers } = await createSummary({ ownerId, recordingId, plan });
  const { error } = await supabase.from("summary_groups")
    .update({ frozen_at: new Date().toISOString(), freeze_event_id: summaryId })
    .eq("id", groupId);
  if (error) throw error;
  return transfers;
}

// UNFREEZE — every settled transfer has been cleared, so the group goes back to
// being a live plan. Mirrors freezeGroup: the debts come back first (inside
// revertSummary), then the group is marked live again.
export async function unfreezeGroup({ ownerId, groupId, recordingId, summaryId }) {
  await revertSummary({ ownerId, summaryId, recordingId });
  const { error } = await supabase.from("summary_groups")
    .update({ frozen_at: null, freeze_event_id: null }).eq("id", groupId);
  if (error) throw error;
}

// All summaries for a record, newest first, with their transfers attached.
export async function loadSummaries(recordingId) {
  const [evRes, xferRes] = await Promise.all([
    supabase.from("settlement_events").select("*")
      .eq("recording_id", recordingId).order("created_at", { ascending: false }),
    supabase.from("summary_transfers").select("*").eq("recording_id", recordingId),
  ]);
  const transfers = xferRes.data || [];
  const events = evRes.data || [];
  // A reverted summary stays in the log (that's the audit trail) but is no
  // longer a live summary, so it is not returned here.
  const reverted = new Set(
    events.filter((e) => e.kind === "summary_reverted").map((e) => e.ref_event_id)
  );
  return events
    .filter((e) => e.kind === "summary" && !reverted.has(e.id))
    .map((e) => ({ ...e, transfers: transfers.filter((t) => t.summary_id === e.id) }));
}
