import { supabase } from "./supabase";
import { buildAliasMap, resolveAlias } from "./balances-core.mjs";

// Compute people suggestions for assembling a party from scratch.
//   "From last time" = members of the most recent recording
//   "Often"          = people who appear in 2+ recordings (or distinct expenses)
// selfId is excluded (self is always added separately). Returns [] if no data.
// All person_ids are resolved through the merge alias so a merged-away token's
// id never reaches the returned chips.
export async function computePeopleSuggestions(selfId) {
  const notSelf = (id) => id !== selfId;
  const [{ data: recs }, { data: rms }, { data: exps }, { data: its }, { data: ppl }] = await Promise.all([
    supabase.from("recordings").select("id").order("created_at", { ascending: false }),
    supabase.from("recording_members").select("recording_id, person_id"),
    supabase.from("expenses").select("id, paid_by"),
    supabase.from("expense_items").select("id, expense_id"),
    supabase.from("people").select("id, merged_into_id"),
  ]);
  const aliasMap = buildAliasMap(ppl || []);
  const canon = (id) => resolveAlias(id, aliasMap);
  const itemIds = (its || []).map((i) => i.id);
  const { data: ims } = itemIds.length
    ? await supabase.from("expense_item_members").select("item_id, person_id").in("item_id", itemIds)
    : { data: [] };
  const itemToExp = Object.fromEntries((its || []).map((i) => [i.id, i.expense_id]));

  const sugg = [];
  if (recs?.length) {
    const lastIds = (rms || []).filter((m) => m.recording_id === recs[0].id).map((m) => canon(m.person_id)).filter(notSelf);
    if (lastIds.length) sugg.push({ label: "From last time", ids: [...new Set(lastIds)] });
  }

  const recCount = {};
  (rms || []).forEach((m) => { const cid = canon(m.person_id); recCount[cid] = (recCount[cid] || 0) + 1; });
  const expsByPerson = {};
  const addExp = (pid, eid) => { if (pid && eid) (expsByPerson[pid] = expsByPerson[pid] || new Set()).add(eid); };
  (ims || []).forEach((m) => addExp(canon(m.person_id), itemToExp[m.item_id]));
  (exps || []).forEach((e) => addExp(canon(e.paid_by), e.id));

  const allIds = new Set([...Object.keys(recCount), ...Object.keys(expsByPerson)]);
  const score = (id) => (recCount[id] || 0) + (expsByPerson[id]?.size || 0);
  const often = [...allIds].filter(notSelf).filter((id) => score(id) >= 2).sort((a, b) => score(b) - score(a)).slice(0, 5);
  if (often.length) sugg.push({ label: "Often", ids: often });
  return sugg;
}
