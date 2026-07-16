// ═══════════════════════════════════════════════════════════════════════
// Pure balance math — NO Supabase, so it can be unit-tested in plain Node.
// balances.js re-exports these and adds the IO (load + mutations).
// ═══════════════════════════════════════════════════════════════════════

// Convert an amount in an expense's own currency to the user's home currency.
// Two hops, each skipped when the currencies already match:
//   expense currency → recording base (expenses.exchange_rate)
//   recording base   → home           (recordings.exchange_rate)
export function toHome(amount, expense, recMap, homeCurrency) {
  let amt = Number(amount) || 0;
  const rec = expense.recording_id ? recMap[expense.recording_id] : null;
  const baseCur = rec?.base_currency || homeCurrency;
  const expCur = expense.currency || baseCur;
  if (expCur !== baseCur) amt *= Number(expense.exchange_rate) || 1;
  if (baseCur !== homeCurrency) amt *= Number(rec?.exchange_rate) || 1;
  return amt;
}

// ── alias resolution (person merge) ──────────────────────────────────────
// A person can be pointed at another via `merged_into_id` (e.g. a placeholder
// token merged into a real account). This is NON-DESTRUCTIVE: the row stays,
// the pointer just says "this is really that person." Balances resolve every
// person id through the chain so all past splits follow a merge (and un-merge
// by clearing the pointer). Multi-user-ready: a claimed token later re-resolves
// to a real account and its whole history moves with it.

// Build { id -> merged_into_id } from a people list.
export function buildAliasMap(people = []) {
  const m = {};
  people.forEach((p) => { if (p?.merged_into_id) m[p.id] = p.merged_into_id; });
  return m;
}

// Follow the merge chain to its canonical endpoint (A→B→C ⇒ C). Cycle-guarded.
export function resolveAlias(id, aliasMap = {}) {
  let cur = id;
  const seen = new Set();
  while (aliasMap[cur] && !seen.has(cur)) { seen.add(cur); cur = aliasMap[cur]; }
  return cur;
}

// A "contribution" = one canonical person's share of one item = one debt atom.
// debtor owes creditor `home` (in home currency). settled = already paid.
//
// Every person id (payer + members) is resolved through the alias map first;
// aliases that land on the SAME canonical person within one item are deduped
// (the split is among distinct PEOPLE, so the divisor counts each once). Each
// contribution carries `settleKeys` = the ORIGINAL (item, person) member rows
// it stands for, so settling still writes the real rows even after a merge.
export function buildContributions(data, homeCurrency) {
  const { expenses, items, members } = data;
  const aliasMap = buildAliasMap(data.people || []);
  const rid = (id) => resolveAlias(id, aliasMap);
  const recMap = Object.fromEntries((data.recordings || []).map((r) => [r.id, r]));
  const expMap = Object.fromEntries(expenses.map((e) => [e.id, e]));
  const byItem = {};
  members.forEach((m) => { (byItem[m.item_id] = byItem[m.item_id] || []).push(m); });

  const contribs = [];
  items.forEach((it) => {
    const exp = expMap[it.expense_id];
    if (!exp) return;
    const rows = byItem[it.id] || [];
    if (!rows.length) return;
    const payer = rid(exp.paid_by);
    const rec = exp.recording_id ? recMap[exp.recording_id] : null;
    const baseCurrency = rec?.base_currency || homeCurrency;
    const expCur = exp.currency || baseCurrency;
    let baseAmt = Number(it.amount) || 0;
    if (expCur !== baseCurrency) baseAmt *= Number(exp.exchange_rate) || 1;
    // group original member rows by CANONICAL person id (dedup merged aliases)
    const groups = {}; // resolvedId -> [member rows]
    rows.forEach((m) => { const r = rid(m.person_id); (groups[r] = groups[r] || []).push(m); });
    const distinct = Object.keys(groups);
    const n = distinct.length; // divisor counts distinct people, not raw rows
    const native = (Number(it.amount) || 0) / n;
    const base = baseAmt / n;
    const home = toHome(Number(it.amount) || 0, exp, recMap, homeCurrency) / n;
    const currency = expCur;
    distinct.forEach((pid) => {
      if (pid === payer) return; // the payer never owes their own share (post-resolution)
      const grp = groups[pid];
      contribs.push({
        debtor: pid,
        creditor: payer,
        home, base, native, currency, baseCurrency,
        itemId: it.id,
        personId: pid, // CANONICAL id (display + tick identity)
        settleKeys: grp.map((m) => ({ itemId: it.id, personId: m.person_id })), // ORIGINAL rows to settle
        expenseId: exp.id,
        recordingId: exp.recording_id,
        settled: grp.every((m) => !!m.settled_at),
        settledAt: grp.map((m) => m.settled_at).filter(Boolean).sort()[0] || null,
        expense: exp,
        item: it,
      });
    });
  });
  return contribs;
}

// Optimistic local update: flip settled state on the contributions whose
// settleKeys intersect `keys`, WITHOUT re-fetching. Every settle flow acts on
// whole contributions (settleKeys sets are disjoint between contribs), so an
// intersection means "this contribution was toggled". Pass an ISO timestamp
// to settle (must match what the DB write stores) or null to un-settle.
export function patchContribsSettled(contribs, keys, settledAt = null) {
  const hit = new Set((keys || []).map((k) => `${k.itemId}:${k.personId}`));
  return contribs.map((c) =>
    c.settleKeys.some((k) => hit.has(`${k.itemId}:${k.personId}`))
      ? { ...c, settled: !!settledAt, settledAt }
      : c
  );
}

// Net (home currency) between two people, from A's perspective:
// positive => B owes A, negative => A owes B. Unsettled only.
export function pairNet(contribs, aId, bId) {
  let net = 0;
  contribs.forEach((c) => {
    if (c.settled) return;
    if (c.debtor === bId && c.creditor === aId) net += c.home;
    if (c.debtor === aId && c.creditor === bId) net -= c.home;
  });
  return net;
}

// Net per person within an optional scope. positive = is owed, negative = owes.
// key selects which amount to net in ("home" for global, "base" for a record).
export function netByPerson(contribs, scope, key = "home") {
  const nets = {};
  contribs.forEach((c) => {
    if (c.settled) return;
    if (scope && !scope(c)) return;
    nets[c.creditor] = (nets[c.creditor] || 0) + c[key];
    nets[c.debtor] = (nets[c.debtor] || 0) - c[key];
  });
  return nets;
}

// Direct pairwise transfers within a scope, each backed by REAL item shares
// (so "Paid" maps to marking those shares settled — no indirect routing, which
// is incompatible with per-item settled tracking). Returns
// [{ from, to, amount, shares:[{itemId,personId}] }] for each pair with a net.
export function directTransfers(contribs, scope, key = "base") {
  const pairs = {}; // "x|y" (sorted) -> { sums:{ "a>b":amt }, shares:[] }
  contribs.forEach((c) => {
    if (c.settled) return;
    if (scope && !scope(c)) return;
    const a = c.debtor, b = c.creditor;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    const p = (pairs[k] = pairs[k] || { sums: {}, shares: [] });
    p.sums[`${a}>${b}`] = (p.sums[`${a}>${b}`] || 0) + c[key];
    p.shares.push(...(c.settleKeys || [{ itemId: c.itemId, personId: c.personId }]));
  });
  const out = [];
  Object.entries(pairs).forEach(([k, p]) => {
    const [x, y] = k.split("|");
    const net = (p.sums[`${x}>${y}`] || 0) - (p.sums[`${y}>${x}`] || 0);
    if (Math.abs(net) < 0.005) return; // they wash out even — no payment needed
    out.push(net > 0 ? { from: x, to: y, amount: net, shares: p.shares }
                     : { from: y, to: x, amount: -net, shares: p.shares });
  });
  out.sort((a, b) => b.amount - a.amount);
  return out;
}

// Greedy minimal transfers: fewest payments that clear a set of net balances.
// nets: { personId: balance }  (positive = owed, negative = owes)
export function minimizeTransfers(nets) {
  const creditors = [], debtors = [];
  Object.entries(nets).forEach(([id, bal]) => {
    if (bal > 0.005) creditors.push({ id, amt: bal });
    else if (bal < -0.005) debtors.push({ id, amt: -bal });
  });
  creditors.sort((a, b) => b.amt - a.amt);
  debtors.sort((a, b) => b.amt - a.amt);
  const transfers = [];
  let ci = 0, di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const c = creditors[ci], d = debtors[di];
    const pay = Math.min(c.amt, d.amt);
    transfers.push({ from: d.id, to: c.id, amount: pay });
    c.amt -= pay; d.amt -= pay;
    if (c.amt < 0.005) ci++;
    if (d.amt < 0.005) di++;
  }
  return transfers;
}

// Per-expense settled status (extracted so RecordingDetail + ExpenseDetail agree).
// rows = expense_item_members rows for ONE expense.
export function statusForExpense(rows, paidBy, nameOf) {
  const owers = [...new Set(rows.map((r) => r.person_id))].filter((pid) => pid !== paidBy);
  if (!owers.length) return { kind: "settled" };
  const settledOf = (pid) => rows.filter((r) => r.person_id === pid).every((r) => r.settled_at);
  const settled = owers.filter(settledOf);
  if (settled.length === owers.length) return { kind: "settled" };
  if (settled.length === 0) return { kind: "open" };
  const open = owers.filter((pid) => !settledOf(pid));
  return { kind: "partial", label: `${settled.length} of ${owers.length} · ${nameOf(open[0])} open` };
}
