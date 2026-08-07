// ═══════════════════════════════════════════════════════════════════════
// Pure balance math — NO Supabase, so it can be unit-tested in plain Node.
// balances.js re-exports these and adds the IO (load + mutations).
// ═══════════════════════════════════════════════════════════════════════

// Convert an amount in an expense's own currency to the user's home currency.
//
// `expenses.home_rate` is the expense's OWN native→home rate, pinned when the
// expense is saved. A debt is frozen in the currency it was incurred in, so a
// recording's currency must never be able to move it: when the pin is present
// this is one multiply and the recording is not consulted at all.
//
// The live two-hop derivation below is the fallback, kept deliberately for:
//   (a) rows written before home_rate existed, and
//   (b) callers passing a SYNTHETIC expense to convert an amount that is
//       already denominated in a recording's base currency (RecordSettleSheet
//       does this for transfer totals) — there is no stored row to pin.
// Its hops are each skipped when the currencies already match:
//   expense currency → recording base (expenses.exchange_rate)
//   recording base   → home           (recordings.exchange_rate)
export function toHome(amount, expense, recMap, homeCurrency) {
  let amt = Number(amount) || 0;
  // A pin must be a usable positive rate; 0/NaN/negative is corrupt data, and
  // honouring it would silently zero out or invert real debts. Derive instead.
  const pinned = Number(expense.home_rate);
  if (expense.home_rate != null && Number.isFinite(pinned) && pinned > 0) return amt * pinned;
  const rec = expense.recording_id ? recMap[expense.recording_id] : null;
  const baseCur = rec?.base_currency || homeCurrency;
  const expCur = expense.currency || baseCur;
  if (expCur !== baseCur) amt *= Number(expense.exchange_rate) || 1;
  if (baseCur !== homeCurrency) amt *= Number(rec?.exchange_rate) || 1;
  return amt;
}

// An ERA is the home currency a pinned rate converts INTO. Eras are inherited
// from CONTAINERS, never read from the user's setting at the moment of logging:
// a recording keeps the era it was created under, and every expense filed there
// takes that era — including one added long after the user switched home
// currency. That switch is a fact about the USER, not about the group who share
// the record and settle against each other, so it must never re-denominate or
// split their record. A loose expense has no container, so it pins the user's
// home currency at creation. Nothing is ever converted between two eras.
export function eraFor(recording, homeCurrency) {
  return recording?.home_currency || homeCurrency;
}

// ── service charge / VAT ─────────────────────────────────────────────────
// A restaurant bill is printed as items, then fees below: ฿1,000 of food,
// +10% service, +7% VAT. `expenses.total_amount` stays the SUBTOTAL (what the
// items add up to, which is what "the rest" auto-fills against) and
// `expenses.service_charge` holds the fee in the same native currency. That
// keeps the fee a visible fact — the detail screen can show "฿1,000 + ฿177" —
// instead of silently baked into item amounts where it could never be shown,
// edited, or removed again.
//
// The fee is allocated PROPORTIONALLY to each item's subtotal, not split
// equally: whoever ordered the ฿500 wine carries half the service charge.
// Proportional allocation is arithmetically identical to scaling every item by
// one factor, which is why this costs the money core five lines rather than a
// new allocation engine.
//
// A null/0/negative/NaN charge means "no fee" — the same defensive stance
// toHome takes on a corrupt rate pin, and the reason the migration that adds
// this column moves no existing balance: every row starts null → factor 1.

export function serviceCharge(expense) {
  const v = Number(expense?.service_charge);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

// What was actually charged: subtotal + fee, in the expense's native currency.
// This is the figure to DISPLAY as "the amount" — total_amount alone understates
// what the payer put on their card.
export function grandTotal(expense) {
  return (Number(expense?.total_amount) || 0) + serviceCharge(expense);
}

// Multiplier taking an item's subtotal amount to its fee-inclusive share.
// Guarded against a zero subtotal (a fee with nothing to spread it over has no
// proportional answer, so charge nobody rather than divide by zero).
export function feeFactor(expense) {
  const sub = Number(expense?.total_amount) || 0;
  if (sub <= 0) return 1;
  const f = grandTotal(expense) / sub;
  return Number.isFinite(f) && f > 0 ? f : 1;
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
    // Item amounts are stored EXCLUDING the expense's service charge / VAT;
    // scaling by feeFactor here allocates that fee proportionally to every
    // item, so it flows into home/base/native and every downstream net for
    // free. No fee (the default, and every pre-migration row) ⇒ factor 1.
    const nativeAmt = (Number(it.amount) || 0) * feeFactor(exp);
    const homeAmt = toHome(nativeAmt, exp, recMap, homeCurrency);
    // The ERA: which currency this expense's home amount is denominated in.
    // `home_rate` records a rate but not what it points at, so without this a
    // home-currency change would silently mislabel every old pin. Falls back to
    // the current home currency for rows written before the column existed —
    // which is exactly today's behaviour, so adding the era moves no number.
    const homeCur = exp.home_currency || homeCurrency;
    // `base` = the item in the recording's base currency — the ONE shared
    // currency an in-record settlement is denominated in. Derive it from the
    // pinned home value rather than through the recording's currency, so that
    // changing that currency re-denominates the whole record at a consistent
    // rate instead of rewriting what anyone owes. When the expense is already
    // in the base currency the conversion is a no-op by definition, so take the
    // native amount directly and keep it exact (no float round-trip).
    const recRate = baseCurrency !== homeCurrency ? Number(rec?.exchange_rate) || 1 : 1;
    const baseAmt = expCur === baseCurrency ? nativeAmt : homeAmt / recRate;
    // group original member rows by CANONICAL person id (dedup merged aliases)
    const groups = {}; // resolvedId -> [member rows]
    rows.forEach((m) => { const r = rid(m.person_id); (groups[r] = groups[r] || []).push(m); });
    const distinct = Object.keys(groups);
    // ⚠️ The divisor counts distinct people, not raw rows — and it is computed
    // BEFORE any summary filtering. Closing one person's share must never
    // enlarge what the others owe: the split happened at the table, and a
    // consolidation afterwards is not a re-split.
    const n = distinct.length;
    const native = nativeAmt / n;
    const base = baseAmt / n;
    const home = homeAmt / n;
    const currency = expCur;
    distinct.forEach((pid) => {
      if (pid === payer) return; // the payer never owes their own share (post-resolution)
      const grp = groups[pid];
      // CLOSED BY A SUMMARY — folded into a transfer, so it is no longer a debt
      // of its own. Distinct from settled (nobody paid it; it was replaced), and
      // the reason a summary is unambiguous: the share and the transfer that
      // consolidated it can never both be live. Mirrors the `.every` convention
      // used for `settled` just below; our own writes always close whole
      // contributions, so a partly-closed group cannot arise from this app.
      if (grp.every((m) => m.summary_id)) return;
      contribs.push({
        debtor: pid,
        creditor: payer,
        home, base, native, currency, baseCurrency,
        homeCurrency: homeCur, // the currency `home` is in — this debt's era
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
  return contribs.concat(buildTransferAtoms(data, homeCurrency));
}

// ── summaries ────────────────────────────────────────────────────────────
// A SUMMARY is minimization as an ACTION, not a view. Invoked on a record, it
// freezes every open share in scope (expense_item_members.summary_id) and
// replaces them with a handful of transfers that carry their own settled_at.
// You then settle the transfers instead.
//
// Why an action and not a toggle: a view recomputes whenever anything changes,
// so you can never point at it and say "that's the plan we agreed" — and worse,
// the underlying shares keep living independently, so "B paid A ฿100" and
// "A owes B ฿200" end up both true with neither aware of the other. That
// ambiguity is what made minimized transfers un-tappable in Phase 6. Freezing
// removes it at the source, so no allocation rule is ever needed. In accounting
// terms it is a closing entry: take everything open, net it, post the result,
// mark the originals closed.
//
// THE ONE RULE, applied identically to shares and transfers:
//     open debt = anything not settled AND not superseded.
// Which is why a second summary sweeps up new expenses AND unpaid transfers
// from the first with no special-casing — a transfer is just another thing a
// later summary can close.

// Live transfers as SYNTHETIC CONTRIBUTIONS. A transfer "X pays Y ฿N" is
// arithmetically a debt of N from X to Y, so every net function (pairNet,
// pairNetGrouped, netByPerson, directTransfers) works on it unchanged — they
// only ever sum signed amounts over debtor/creditor pairs. buildContributions
// appends these automatically, so no screen can forget to include them; screens
// that must exclude them filter on the positive `transferId` marker.
//
// Person ids resolve through the alias map like everywhere else, so merging two
// people after a summary re-routes its transfers too.
export function buildTransferAtoms(data, homeCurrency) {
  const aliasMap = buildAliasMap(data?.people || []);
  const rid = (id) => resolveAlias(id, aliasMap);
  return (data?.transfers || [])
    .filter((t) => !t.settled_at && !t.superseded_by) // the one rule
    .map((t) => {
      const amount = Number(t.amount) || 0;
      const homeAmt = Number(t.home_amount);
      // home_amount is pinned at creation; fall back to the native amount only
      // for a corrupt/absent pin, never to a live conversion (same stance as
      // toHome takes on a bad rate pin).
      const home = Number.isFinite(homeAmt) ? homeAmt : amount;
      const cur = t.currency || t.home_currency || homeCurrency;
      const debtor = rid(t.from_person);
      return {
        debtor,
        creditor: rid(t.to_person),
        // A transfer is already denominated in the record's settlement currency,
        // so native = base = amount, with no conversion hop of any kind.
        home, base: amount, native: amount,
        currency: cur, baseCurrency: cur,
        homeCurrency: t.home_currency || homeCurrency,
        itemId: null,
        personId: debtor,
        settleKeys: [], // no item shares behind it — settle the transfer row itself
        expenseId: null,
        recordingId: t.recording_id || null,
        settled: false,
        settledAt: null,
        transferId: t.id,   // the marker screens filter on
        summaryId: t.summary_id,
        expense: null,
        item: null,
      };
    });
}

// Plan a summary over a scope WITHOUT writing anything — this is what the
// preview-confirm renders. Returns the transfers to create, the share keys to
// freeze, and the ids of any unpaid transfers this summary supersedes.
//
// `key` is the currency the plan is denominated in: "base" (the record's
// settlement currency) for a record summary.
//
// ⚠️ THE HOME AMOUNT IS A DESIGN DECISION, NOT ARITHMETIC. Each expense pins
// its own native→home rate, so netting several of them into two transfers has
// no unique correct home split — it is a transportation problem, not a
// division. We pin one BLENDED rate for the whole summary (its total home ÷ its
// total base), which keeps the summary's aggregate home value identical to what
// it replaced and degenerates to the record's own rate whenever every expense
// in it shares a pin (the common case). Individual people's home figures can
// shift by a hair; their amounts in the SETTLEMENT currency are exact.
export function planSummary(contribs, scope, key = "base") {
  const inScope = (contribs || []).filter((c) => !c.settled && (!scope || scope(c)));
  const transfers = minimizeTransfers(netByPerson(inScope, null, key));
  let sumKey = 0, sumHome = 0;
  inScope.forEach((c) => { sumKey += c[key]; sumHome += c.home; });
  const blended = sumKey > 0.005 ? sumHome / sumKey : 1;
  const rate = Number.isFinite(blended) && blended > 0 ? blended : 1;
  const first = inScope[0] || null;
  return {
    transfers: transfers.map((t) => ({ ...t, homeAmount: t.amount * rate })),
    shareKeys: inScope.flatMap((c) => c.settleKeys || []),
    // Unpaid transfers from an earlier summary that this one folds in. They are
    // superseded rather than deleted, so the earlier summary stays readable.
    transferIds: [...new Set(inScope.map((c) => c.transferId).filter(Boolean))],
    currency: first ? (key === "base" ? first.baseCurrency : first.homeCurrency) : null,
    // A record can only ever hold ONE era (eras are inherited from the
    // container), so a single home currency for the whole plan is well-defined.
    homeCurrency: first ? first.homeCurrency : null,
    rate,
    count: inScope.length,
  };
}

// A summary can be reverted only while it is the LATEST (nothing has superseded
// its transfers) and NONE of its transfers are settled. Settling even one locks
// it — un-settle that transfer first. This is the guard, not a trap: you cannot
// unwind Summary 1 while Summary 2 sits on top of it.
export function canRevertSummary(transfers = [], summaryId) {
  const mine = transfers.filter((t) => t.summary_id === summaryId);
  if (!mine.length) return false; // also covers a summary that produced no transfers
  return !mine.some((t) => t.superseded_by || t.settled_at);
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

// Direct pairwise net between two people, grouped along some currency axis and
// never converted across it. positive net = bId owes aId (mirrors pairNet).
// Returns one entry per non-zero currency, largest first.
function pairNetGrouped(contribs, aId, bId, curOf, amtOf) {
  const byCur = {};
  contribs.forEach((c) => {
    if (c.settled) return;
    const k = curOf(c);
    if (c.debtor === bId && c.creditor === aId) byCur[k] = (byCur[k] || 0) + amtOf(c);
    else if (c.debtor === aId && c.creditor === bId) byCur[k] = (byCur[k] || 0) - amtOf(c);
  });
  return Object.entries(byCur)
    .map(([currency, net]) => ({ currency, net }))
    .filter((e) => Math.abs(e.net) > 0.005)
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
}

// …split by the debt's own NATIVE currency. NOT used by any screen right now —
// the Settlement tab shows home-per-era instead (Phoom's call, 2026-08-05).
// Kept + tested because it's the other honest way to show a cross-currency
// balance, and the record-scoped screens still lead with native amounts.
// A person's balance can span
// currencies that don't net against each other (a KRW record + a THB loose
// expense), so a single home figure can't represent it without a conversion
// that moves when home currency changes. Keeps each debt frozen in the currency
// it was incurred in.
export function pairNetByCurrency(contribs, aId, bId) {
  return pairNetGrouped(contribs, aId, bId, (c) => c.currency, (c) => c.native);
}

// …split by ERA (the currency each debt's pinned rate converts into). Home
// amounts from different eras are different units: adding them would need a
// rate between two home currencies, which this model never has and never asks
// for. So a home-currency figure is summed WITHIN an era and listed across.
export function pairNetByEra(contribs, aId, bId) {
  return pairNetGrouped(contribs, aId, bId, (c) => c.homeCurrency, (c) => c.home);
}

// Plain (unsigned) sum of home amounts grouped by era — for settled events and
// other "what did this add up to" readouts. Same no-cross-era rule as above.
export function sumHomeByEra(contribs) {
  const byEra = {};
  (contribs || []).forEach((c) => { byEra[c.homeCurrency] = (byEra[c.homeCurrency] || 0) + c.home; });
  return Object.entries(byEra)
    .map(([currency, amount]) => ({ currency, amount }))
    .filter((e) => Math.abs(e.amount) > 0.005)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
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
    const p = (pairs[k] = pairs[k] || { sums: {}, shares: [], transferIds: [] });
    p.sums[`${a}>${b}`] = (p.sums[`${a}>${b}`] || 0) + c[key];
    p.shares.push(...(c.settleKeys || [{ itemId: c.itemId, personId: c.personId }]));
    // A summary's transfer has no item shares behind it, so a row can be backed
    // by shares, by transfers, or by both. Callers must settle BOTH lists or the
    // row would look paid while half of it stayed open.
    if (c.transferId) p.transferIds.push(c.transferId);
  });
  const out = [];
  Object.entries(pairs).forEach(([k, p]) => {
    const [x, y] = k.split("|");
    const net = (p.sums[`${x}>${y}`] || 0) - (p.sums[`${y}>${x}`] || 0);
    if (Math.abs(net) < 0.005) return; // they wash out even — no payment needed
    const row = { amount: 0, shares: p.shares, transferIds: p.transferIds };
    out.push(net > 0 ? { ...row, from: x, to: y, amount: net }
                     : { ...row, from: y, to: x, amount: -net });
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
