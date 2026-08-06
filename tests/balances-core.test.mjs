// ═══════════════════════════════════════════════════════════════════════
// Guardrail tests for the pure money core (src/lib/balances-core.mjs).
// Plain Node, no framework:  node tests/balances-core.test.mjs  (or npm test)
//
// These encode the invariants locked during Phases 6–7b — run them after ANY
// change to the money path. They must stay green through the Phase 8-pre
// performance refactor (the math must not change, only how/when it runs).
// ═══════════════════════════════════════════════════════════════════════
import {
  toHome, buildContributions, pairNet, pairNetByCurrency, netByPerson,
  directTransfers, minimizeTransfers, statusForExpense,
  buildAliasMap, resolveAlias, patchContribsSettled, eraFor,
  pairNetByEra, sumHomeByEra,
  serviceCharge, grandTotal, feeFactor,
} from "../src/lib/balances-core.mjs";

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) pass++;
  else { fail++; console.error("  ✗ " + name); }
};
const approx = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

const HOME = "THB";

// One fixture family: the Busan record (KRW, rate 0.026 → THB) with two
// payers, plus a loose THB dinner (with a token) and a loose EUR expense.
function makeData() {
  const people = [
    { id: "you", is_self: true },
    { id: "rui" }, { id: "sofia" }, { id: "marco" },
    { id: "tok", is_token: true },
  ];
  const recordings = [
    { id: "busan", base_currency: "KRW", exchange_rate: 0.026 },
  ];
  const expenses = [
    { id: "e1", recording_id: "busan", currency: "KRW", exchange_rate: null, paid_by: "you" },   // KTX 118000
    { id: "e2", recording_id: "busan", currency: "KRW", exchange_rate: null, paid_by: "rui" },   // Raw fish 52000
    { id: "e3", recording_id: null,    currency: "THB", exchange_rate: null, paid_by: "you" },   // loose dinner 900
    { id: "e4", recording_id: null,    currency: "EUR", exchange_rate: 38,   paid_by: "marco" }, // loose foreign 30
  ];
  const items = [
    { id: "i1", expense_id: "e1", amount: 118000 },
    { id: "i2", expense_id: "e2", amount: 52000 },
    { id: "i3", expense_id: "e3", amount: 900 },
    { id: "i4", expense_id: "e4", amount: 30 },
  ];
  const members = [
    { item_id: "i1", person_id: "you" }, { item_id: "i1", person_id: "rui" }, { item_id: "i1", person_id: "sofia" },
    { item_id: "i2", person_id: "you" }, { item_id: "i2", person_id: "rui" }, { item_id: "i2", person_id: "sofia" },
    { item_id: "i3", person_id: "you" }, { item_id: "i3", person_id: "marco" }, { item_id: "i3", person_id: "tok" },
    { item_id: "i4", person_id: "you" }, { item_id: "i4", person_id: "marco" },
  ];
  return { people, recordings, expenses, items, members, settlements: [] };
}
const memberRow = (d, itemId, personId) =>
  d.members.find((m) => m.item_id === itemId && m.person_id === personId);

// ── toHome: two-hop convert, each hop skipped when currencies match ──────
{
  const d = makeData();
  const recMap = Object.fromEntries(d.recordings.map((r) => [r.id, r]));
  check("toHome: record currency → home (one hop, record rate)",
    approx(toHome(118000, d.expenses[0], recMap, HOME), 3068));
  check("toHome: foreign-in-record → two hops (expense rate then record rate)",
    approx(toHome(10, { recording_id: "busan", currency: "EUR", exchange_rate: 34 }, recMap, HOME), 8.84));
  check("toHome: loose home-currency expense unchanged",
    approx(toHome(900, d.expenses[2], recMap, HOME), 900));
  check("toHome: loose foreign expense uses its own rate",
    approx(toHome(30, d.expenses[3], recMap, HOME), 1140));
  check("toHome: missing rate defaults to 1",
    approx(toHome(10, { recording_id: "busan", currency: "EUR", exchange_rate: null }, recMap, HOME), 0.26));
}

// ── buildContributions: baseline (no merges) ─────────────────────────────
{
  const d = makeData();
  const cs = buildContributions(d, HOME);
  check("contribs: one debt atom per non-payer per item (7 total)", cs.length === 7);
  check("contribs: the payer never owes their own share",
    cs.every((c) => c.debtor !== c.creditor));
  const rui1 = cs.find((c) => c.itemId === "i1" && c.debtor === "rui");
  check("contribs: native = item/n", approx(rui1.native, 39333.33));
  check("contribs: base = native when expense currency is the record base", approx(rui1.base, 39333.33));
  check("contribs: home = base × record rate", approx(rui1.home, 1022.67));
  check("contribs: settleKeys carry the original member row",
    rui1.settleKeys.length === 1 && rui1.settleKeys[0].itemId === "i1" && rui1.settleKeys[0].personId === "rui");
  const you4 = cs.find((c) => c.itemId === "i4");
  check("contribs: loose foreign — native in expense currency, base=home in home currency",
    approx(you4.native, 15) && approx(you4.base, 570) && approx(you4.home, 570) &&
    you4.currency === "EUR" && you4.baseCurrency === "THB");

  d.items.push({ id: "i9", expense_id: "e3", amount: 50 }); // item with no members
  check("contribs: memberless item contributes nothing",
    buildContributions(d, HOME).length === 7);

  const d2 = makeData();
  memberRow(d2, "i2", "you").settled_at = "2026-07-01T00:00:00Z";
  const settled = buildContributions(d2, HOME).find((c) => c.itemId === "i2" && c.debtor === "you");
  check("contribs: settled_at on the row → contribution settled",
    settled.settled === true && settled.settledAt === "2026-07-01T00:00:00Z");
}

// ── alias resolution (person merge) ──────────────────────────────────────
{
  check("alias: chain A→B→C resolves to C",
    resolveAlias("a", { a: "b", b: "c" }) === "c");
  const cyc = resolveAlias("a", { a: "b", b: "a" });
  check("alias: cycle terminates (guarded)", cyc === "a" || cyc === "b");
  check("alias: buildAliasMap only maps merged people",
    Object.keys(buildAliasMap([{ id: "x" }, { id: "y", merged_into_id: "x" }])).join(",") === "y");

  // redirect: token merged into sofia → sofia inherits the token's share
  const d = makeData();
  d.people.find((p) => p.id === "tok").merged_into_id = "sofia";
  const cs = buildContributions(d, HOME);
  const red = cs.find((c) => c.itemId === "i3" && c.debtor === "sofia");
  check("merge: redirected debtor is the canonical person, split still ÷3",
    !!red && approx(red.home, 300));
  check("merge: redirected settleKeys still point at the ORIGINAL token row",
    red.settleKeys.length === 1 && red.settleKeys[0].personId === "tok");

  // overlap dedup: token merged into marco who is ALSO on the item → re-split ÷2
  const d2 = makeData();
  d2.people.find((p) => p.id === "tok").merged_into_id = "marco";
  const dup = buildContributions(d2, HOME).filter((c) => c.itemId === "i3");
  check("merge: aliases landing on one person dedup — divisor counts distinct people",
    dup.length === 1 && dup[0].debtor === "marco" && approx(dup[0].home, 450));
  check("merge: deduped contribution carries BOTH original rows as settleKeys",
    dup[0].settleKeys.length === 2 &&
    dup[0].settleKeys.some((k) => k.personId === "marco") &&
    dup[0].settleKeys.some((k) => k.personId === "tok"));

  // self-wash: token merged into the PAYER → its share vanishes
  const d3 = makeData();
  d3.people.find((p) => p.id === "tok").merged_into_id = "you";
  const wash = buildContributions(d3, HOME).filter((c) => c.expenseId === "e3");
  check("merge: token merged into the payer washes to zero (marco re-splits ÷2)",
    wash.length === 1 && wash[0].debtor === "marco" && approx(wash[0].home, 450));

  // settled status after dedup: every underlying row must be settled
  const d4 = makeData();
  d4.people.find((p) => p.id === "tok").merged_into_id = "marco";
  memberRow(d4, "i3", "tok").settled_at = "2026-07-01T00:00:00Z";
  let m = buildContributions(d4, HOME).find((c) => c.itemId === "i3");
  check("merge: deduped contrib is unsettled while ANY underlying row is open", m.settled === false);
  memberRow(d4, "i3", "marco").settled_at = "2026-07-02T00:00:00Z";
  m = buildContributions(d4, HOME).find((c) => c.itemId === "i3");
  check("merge: deduped contrib settled once ALL underlying rows are", m.settled === true);
}

// ── pairNet ──────────────────────────────────────────────────────────────
{
  const d = makeData();
  const cs = buildContributions(d, HOME);
  // rui owes you 39333.33 (KTX), you owe rui 17333.33 (raw fish) → net in home
  check("pairNet: nets both directions, home currency, from A's perspective",
    approx(pairNet(cs, "you", "rui"), 22000 * 0.026));
  check("pairNet: antisymmetric", approx(pairNet(cs, "rui", "you"), -22000 * 0.026));
  memberRow(d, "i2", "you").settled_at = "2026-07-01T00:00:00Z";
  check("pairNet: settled shares excluded",
    approx(pairNet(buildContributions(d, HOME), "you", "rui"), 39333.33 * 0.026));
}

// ── pairNetByCurrency: frozen native nets, one per currency ───────────────
{
  const cs = buildContributions(makeData(), HOME);
  // You↔rui is entirely in the KRW record → one KRW line, rui owes you ₩22,000
  const ru = pairNetByCurrency(cs, "you", "rui");
  check("pairNetByCurrency: single currency nets in native, not home",
    ru.length === 1 && ru[0].currency === "KRW" && approx(ru[0].net, 22000));
  check("pairNetByCurrency: antisymmetric", approx(pairNetByCurrency(cs, "rui", "you")[0].net, -22000));
  // You↔marco spans currencies that DON'T net: marco owes ฿300 (dinner) but you
  // owe €15 (loose EUR) → two separate frozen lines, larger first
  const ma = pairNetByCurrency(cs, "you", "marco");
  check("pairNetByCurrency: cross-currency debts stay separate (not merged)",
    ma.length === 2 &&
    ma[0].currency === "THB" && approx(ma[0].net, 300) &&
    ma[1].currency === "EUR" && approx(ma[1].net, -15));
  // none of this touches home currency → immune to a home-currency change
  const csUsd = buildContributions(makeData(), "USD");
  check("pairNetByCurrency: unchanged when home currency changes",
    approx(pairNetByCurrency(csUsd, "you", "rui")[0].net, 22000));
}

// ── netByPerson ──────────────────────────────────────────────────────────
{
  const cs = buildContributions(makeData(), HOME);
  const nets = netByPerson(cs, (c) => c.recordingId === "busan", "base");
  check("netByPerson: in-record nets in the record's BASE currency",
    approx(nets.you, 61333.33) && approx(nets.rui, -4666.67) && approx(nets.sofia, -56666.67));
  check("netByPerson: nets sum to zero",
    approx(Object.values(nets).reduce((s, v) => s + v, 0), 0));
}

// ── directTransfers: pairwise, item-backed, no stranded shares ───────────
{
  const cs = buildContributions(makeData(), HOME);
  const ts = directTransfers(cs, (c) => c.recordingId === "busan", "base");
  check("directTransfers: one transfer per indebted pair (two-payer record → 3)",
    ts.length === 3);
  check("directTransfers: sorted by amount desc, pairwise nets correct",
    ts[0].from === "sofia" && ts[0].to === "you" && approx(ts[0].amount, 39333.33) &&
    ts[1].from === "rui" && ts[1].to === "you" && approx(ts[1].amount, 22000) &&
    ts[2].from === "sofia" && ts[2].to === "rui" && approx(ts[2].amount, 17333.33));
  check("directTransfers: a netted pair's transfer carries BOTH directions' item shares",
    ts[1].shares.length === 2 &&
    ts[1].shares.some((s) => s.itemId === "i1" && s.personId === "rui") &&
    ts[1].shares.some((s) => s.itemId === "i2" && s.personId === "you"));
  const inScope = cs.filter((c) => c.recordingId === "busan" && !c.settled);
  const carried = ts.flatMap((t) => t.shares);
  check("directTransfers: no stranded shares — every open share rides in some transfer",
    inScope.every((c) => c.settleKeys.every((k) =>
      carried.some((s) => s.itemId === k.itemId && s.personId === k.personId))));

  // equal-and-opposite pair washes out → no payment needed
  const wash = {
    people: [{ id: "a" }, { id: "b" }],
    recordings: [],
    expenses: [
      { id: "wa", recording_id: null, currency: "THB", paid_by: "a" },
      { id: "wb", recording_id: null, currency: "THB", paid_by: "b" },
    ],
    items: [
      { id: "wi1", expense_id: "wa", amount: 100 },
      { id: "wi2", expense_id: "wb", amount: 100 },
    ],
    members: [
      { item_id: "wi1", person_id: "a" }, { item_id: "wi1", person_id: "b" },
      { item_id: "wi2", person_id: "a" }, { item_id: "wi2", person_id: "b" },
    ],
  };
  check("directTransfers: equal mutual debts wash out (no transfer)",
    directTransfers(buildContributions(wash, HOME), null, "home").length === 0);
}

// ── minimizeTransfers (kept in the core for reference) ───────────────────
{
  const ts = minimizeTransfers({ a: 100, b: -60, c: -40 });
  check("minimizeTransfers: clears nets with fewest payments",
    ts.length === 2 &&
    ts.some((t) => t.from === "b" && t.to === "a" && approx(t.amount, 60)) &&
    ts.some((t) => t.from === "c" && t.to === "a" && approx(t.amount, 40)));
  check("minimizeTransfers: balanced input → no transfers",
    minimizeTransfers({ a: 0, b: 0.001 }).length === 0);
}

// ── patchContribsSettled: optimistic local flip, no re-fetch ─────────────
{
  const cs = buildContributions(makeData(), HOME);
  const rui1 = cs.find((c) => c.itemId === "i1" && c.debtor === "rui");
  const at = "2026-07-17T10:00:00Z";

  const settled = patchContribsSettled(cs, rui1.settleKeys, at);
  const hit = settled.find((c) => c.itemId === "i1" && c.debtor === "rui");
  check("patch: settling flips only the matching contribution",
    hit.settled === true && hit.settledAt === at &&
    settled.filter((c) => c.settled).length === 1);
  check("patch: untouched contributions keep their identity (no churn)",
    settled.find((c) => c.itemId === "i2" && c.debtor === "you") ===
    cs.find((c) => c.itemId === "i2" && c.debtor === "you"));
  check("patch: original array not mutated", !rui1.settled);

  const undone = patchContribsSettled(settled, rui1.settleKeys, null);
  check("patch: null timestamp un-settles",
    undone.every((c) => !c.settled && c.settledAt === null || !c.settled && !c.settledAt));

  // merged contrib (2 settleKeys) — a transfer's key list settles it whole
  const dm = makeData();
  dm.people.find((p) => p.id === "tok").merged_into_id = "marco";
  const mcs = buildContributions(dm, HOME);
  const merged = mcs.find((c) => c.itemId === "i3");
  const patched = patchContribsSettled(mcs, merged.settleKeys, at)
    .find((c) => c.itemId === "i3");
  check("patch: deduped (merged) contribution flips as one", patched.settled === true);

  check("patch: agrees with a rebuild after the same DB write", (() => {
    const d2 = makeData();
    rui1.settleKeys.forEach((k) => { memberRow(d2, k.itemId, k.personId).settled_at = at; });
    const rebuilt = buildContributions(d2, HOME);
    const p = patchContribsSettled(buildContributions(makeData(), HOME), rui1.settleKeys, at);
    return rebuilt.every((r, i) =>
      r.settled === p[i].settled && r.settledAt === p[i].settledAt &&
      r.debtor === p[i].debtor && approx(r.home, p[i].home));
  })());
}

// ── statusForExpense ─────────────────────────────────────────────────────
{
  const nameOf = (pid) => pid[0].toUpperCase() + pid.slice(1);
  const rows = [
    { person_id: "you", settled_at: null },
    { person_id: "rui", settled_at: null },
    { person_id: "sofia", settled_at: null },
  ];
  check("status: nothing settled → open",
    statusForExpense(rows, "you", nameOf).kind === "open");
  rows[1].settled_at = "2026-07-01T00:00:00Z";
  const part = statusForExpense(rows, "you", nameOf);
  check("status: some settled → partial with 'N of M · Name open' label",
    part.kind === "partial" && part.label === "1 of 2 · Sofia open");
  rows[2].settled_at = "2026-07-01T00:00:00Z";
  check("status: all owers settled → settled",
    statusForExpense(rows, "you", nameOf).kind === "settled");
  check("status: payer-only expense → settled (nobody owes)",
    statusForExpense([{ person_id: "you", settled_at: null }], "you", nameOf).kind === "settled");
}

// ═══════════════════════════════════════════════════════════════════════
// THE CURRENCY INVARIANT (locked 2026-07-17 — see CLAUDE.md §8)
//
//   A debt is frozen in the currency it was incurred in. A recording's
//   currency is a DEFAULT for new logs and a display lens — never the pivot
//   a past debt is re-computed through.
//
// Enforced by `expenses.home_rate`: each expense pins its own native→home
// rate at creation, and toHome reads that pin instead of walking the
// recording. These tests are the guard on that — they are the reason the
// column exists, so do not relax them.
// ═══════════════════════════════════════════════════════════════════════

// Phoom's exact repro: KRW record @0.02, home THB. Taxi ₩10,000 paid by Rui,
// split with You → You owes ₩5,000 = ฿100. Then the record is switched to
// USD @33. Before the pin existed this made You owe ฿165,000.
function makeTaxi({ rec = {}, exp = {} } = {}) {
  return {
    people: [{ id: "you", is_self: true }, { id: "rui" }],
    recordings: [{ id: "trip", base_currency: "KRW", exchange_rate: 0.02, ...rec }],
    expenses: [{ id: "t1", recording_id: "trip", currency: "KRW", exchange_rate: null, home_rate: 0.02, paid_by: "rui", ...exp }],
    items: [{ id: "ti", expense_id: "t1", amount: 10000 }],
    members: [{ item_id: "ti", person_id: "you" }, { item_id: "ti", person_id: "rui" }],
    settlements: [],
  };
}
const taxiShare = (d) => buildContributions(d, HOME).find((c) => c.debtor === "you");

{
  const before = taxiShare(makeTaxi());
  check("invariant: taxi share is ฿100 / ₩5,000 to begin with",
    approx(before.home, 100) && approx(before.base, 5000) && approx(before.native, 5000));

  // …now change ONLY the recording's currency. Nothing about the expense moves.
  const after = taxiShare(makeTaxi({ rec: { base_currency: "USD", exchange_rate: 33 } }));
  check("invariant: changing the record's currency does NOT move the home debt",
    approx(after.home, before.home));
  check("invariant: changing the record's currency does NOT move the native debt",
    approx(after.native, before.native));
  check("invariant: base re-denominates to the new currency at the SAME real value",
    approx(after.base, 100 / 33) && approx(after.base * 33, after.home));
  check("invariant: the settlement currency follows the record",
    before.baseCurrency === "KRW" && after.baseCurrency === "USD");

  // The bug this column fixes, documented: an UNPINNED row still walks the
  // recording, so the same currency change inflates the debt 1650×.
  const unpinned = taxiShare(makeTaxi({ rec: { base_currency: "USD", exchange_rate: 33 }, exp: { home_rate: null } }));
  check("invariant: an unpinned row is exactly the bug the pin prevents",
    approx(unpinned.home, 165000));

  // Corrupt pins must not be honoured — silently zeroing a debt is worse than
  // falling back to the old derivation.
  check("invariant: a zero/negative pin falls back instead of zeroing the debt",
    approx(taxiShare(makeTaxi({ exp: { home_rate: 0 } })).home, 100) &&
    approx(taxiShare(makeTaxi({ exp: { home_rate: -5 } })).home, 100));
}

// ── THE ERA: each expense records the currency its rate converts INTO ────
// `home_rate` is a rate with no destination; `home_currency` is what names it.
// This is the half that makes changing the home currency safe: expenses stay
// knowable in the currency they were logged under, and nothing old is ever
// converted between eras (the conversion is exactly what corrupted live data).
{
  const withEra = taxiShare(makeTaxi({ exp: { home_currency: "THB" } }));
  check("era: a contribution carries its expense's home_currency",
    withEra.homeCurrency === "THB" && approx(withEra.home, 100));

  // Rows written before the column existed fall back to the current home
  // currency — exactly today's behaviour, which is why the era moves no number.
  const noEra = taxiShare(makeTaxi());
  check("era: a null home_currency falls back to the passed home currency",
    makeTaxi().expenses[0].home_currency === undefined && noEra.homeCurrency === HOME);

  // THE CASE THE WHOLE MODEL EXISTS FOR: the taxi was logged while home was
  // THB; the user then switched to USD and logged another. Both live in one
  // dataset, each keeping its own era and its own frozen home amount. Neither
  // is converted into the other, and no THB↔USD rate is ever asked for.
  const mixed = {
    people: [{ id: "you", is_self: true }, { id: "rui" }],
    recordings: [],
    expenses: [
      { id: "old", recording_id: null, currency: "KRW", home_rate: 0.02,    home_currency: "THB", paid_by: "rui" },
      { id: "new", recording_id: null, currency: "KRW", home_rate: 0.00061, home_currency: "USD", paid_by: "rui" },
    ],
    items: [{ id: "oi", expense_id: "old", amount: 10000 }, { id: "ni", expense_id: "new", amount: 10000 }],
    members: [
      { item_id: "oi", person_id: "you" }, { item_id: "oi", person_id: "rui" },
      { item_id: "ni", person_id: "you" }, { item_id: "ni", person_id: "rui" },
    ],
    settlements: [],
  };
  // Eras are INHERITED FROM CONTAINERS, not read from the user's setting at the
  // moment of logging. A record started under THB keeps logging in THB after the
  // user moves to USD — the switch is a fact about the user, not about the group
  // who share that record. Because of this a record can never hold two eras, so
  // its single base rate is always era-consistent.
  check("era: an expense in a recording inherits the RECORD's era, not the current home",
    eraFor({ home_currency: "THB" }, "USD") === "THB");
  check("era: a loose expense pins the user's home currency at creation",
    eraFor(null, "USD") === "USD" && eraFor(undefined, "THB") === "THB");
  check("era: a recording with no era of its own falls back to the current home",
    eraFor({ base_currency: "KRW" }, "USD") === "USD");

  const eraOf = (cs, id) => cs.find((c) => c.expenseId === id);
  const asThb = buildContributions(mixed, "THB");
  const asUsd = buildContributions(mixed, "USD");
  check("era: two eras coexist in one dataset, each keeping its own currency",
    eraOf(asThb, "old").homeCurrency === "THB" && eraOf(asThb, "new").homeCurrency === "USD");
  check("era: each debt's home amount is frozen by its own pin",
    approx(eraOf(asThb, "old").home, 100) && approx(eraOf(asThb, "new").home, 3.05));
  check("era: changing the home currency moves neither debt nor its era",
    eraOf(asUsd, "old").homeCurrency === "THB" && approx(eraOf(asUsd, "old").home, 100) &&
    eraOf(asUsd, "new").homeCurrency === "USD" && approx(eraOf(asUsd, "new").home, 3.05));

  // End to end: the Korea trip was started under THB; the user has since moved
  // to USD. A taxi filed into that trip is still a THB-era ฿100 debt.
  const inRecord = makeTaxi({
    rec: { home_currency: "THB" },
    exp: { home_currency: eraFor({ home_currency: "THB" }, "USD") }, // what the form pins
  });
  const share = buildContributions(inRecord, "USD").find((c) => c.debtor === "you");
  check("era: an expense in a THB-era record stays a THB debt under a USD home",
    share.homeCurrency === "THB" && approx(share.home, 100) && approx(share.native, 5000));

  // ── displaying eras: group, never add across ──────────────────────────
  // A home figure is only summable WITHIN an era — adding two eras' figures
  // would need a rate between two home currencies, which never exists here.
  const mixedCs = buildContributions(mixed, "THB");
  const paired = pairNetByEra(mixedCs, "rui", "you"); // rui is owed by you in both
  check("display: pairNetByEra keeps each era's home total separate",
    paired.length === 2 &&
    approx(paired.find((e) => e.currency === "THB").net, 100) &&
    approx(paired.find((e) => e.currency === "USD").net, 3.05));
  check("display: pairNetByEra is antisymmetric, like pairNet",
    pairNetByEra(mixedCs, "you", "rui").every((e) =>
      approx(e.net, -paired.find((x) => x.currency === e.currency).net)));
  check("display: pairNetByEra is unchanged by the home currency in view",
    JSON.stringify(pairNetByEra(buildContributions(mixed, "USD"), "rui", "you")) === JSON.stringify(paired));

  const summed = sumHomeByEra(mixedCs);
  check("display: sumHomeByEra totals within an era and lists across",
    summed.length === 2 &&
    approx(summed.find((e) => e.currency === "THB").amount, 100) &&
    approx(summed.find((e) => e.currency === "USD").amount, 3.05));
  check("display: a single-era dataset still yields exactly one figure",
    sumHomeByEra(buildContributions(makeTaxi({ exp: { home_currency: "THB" } }), "THB")).length === 1);
}

// Backfill parity: the migration sets home_rate = toHome(1, …), i.e. today's
// derived rate. Pinning that value must reproduce today's numbers EXACTLY for
// every expense shape in the app — this is what makes the migration a no-op.
{
  const d = makeData();
  const recMap = Object.fromEntries(d.recordings.map((r) => [r.id, r]));
  const parity = d.expenses.every((e) => {
    const backfilled = toHome(1, e, recMap, HOME); // ← the SQL's formula
    return approx(toHome(1234, { ...e, home_rate: backfilled }, recMap, HOME),
                  toHome(1234, e, recMap, HOME), 0.0001);
  });
  check("backfill: pinning toHome(1) reproduces today's value for every expense shape", parity);

  const pinnedFixture = { ...d, expenses: d.expenses.map((e) => ({ ...e, home_rate: toHome(1, e, recMap, HOME) })) };
  const oldCs = buildContributions(d, HOME);
  const newCs = buildContributions(pinnedFixture, HOME);
  check("backfill: no contribution's home/base/native moves once pinned",
    oldCs.length === newCs.length && oldCs.every((o, i) =>
      approx(o.home, newCs[i].home, 0.0001) &&
      approx(o.base, newCs[i].base, 0.0001) &&
      approx(o.native, newCs[i].native, 0.0001)));
}

// ═══════════════════════════════════════════════════════════════════════
// SERVICE CHARGE / VAT — allocated proportionally, never per head
// ═══════════════════════════════════════════════════════════════════════
// The scenario the feature exists for: a ฿1,000 dinner where ฿700 is shared by
// all three and a ฿300 bottle of wine is for two of them, plus 10% service and
// 7% VAT compounded = ฿177 of fees. Sofia didn't drink the wine, so she must
// carry LESS of the fee than Rui — that is the whole point of allocating
// proportionally to each item's subtotal instead of splitting fees per head.
{
  const feeData = (charge) => ({
    people: [{ id: "you", is_self: true }, { id: "rui" }, { id: "sofia" }],
    recordings: [],
    expenses: [{
      id: "f1", recording_id: null, currency: "THB", paid_by: "you",
      total_amount: 1000, service_charge: charge, home_rate: 1, home_currency: "THB",
    }],
    items: [
      { id: "fr", expense_id: "f1", amount: 700, is_rest: true },
      { id: "fw", expense_id: "f1", amount: 300 },
    ],
    members: [
      { item_id: "fr", person_id: "you" }, { item_id: "fr", person_id: "rui" }, { item_id: "fr", person_id: "sofia" },
      { item_id: "fw", person_id: "you" }, { item_id: "fw", person_id: "rui" },
    ],
    settlements: [],
  });
  const owed = (cs, pid) => cs.filter((c) => c.debtor === pid).reduce((s, c) => s + c.home, 0);

  // ── helpers ──
  const exp = feeData(177).expenses[0];
  check("fee: grandTotal = subtotal + charge", grandTotal(exp) === 1177);
  check("fee: serviceCharge reads the column", serviceCharge(exp) === 177);
  check("fee: feeFactor = grand / subtotal", approx(feeFactor(exp), 1.177, 0.0001));

  // ── MIGRATION SAFETY: a null charge must move nothing ──
  // Every pre-migration row has service_charge null, so this is the assertion
  // that made adding the column safe to deploy against real trip data.
  const noFee = buildContributions(feeData(null), HOME);
  const noCol = buildContributions((() => {
    const d = feeData(null);
    delete d.expenses[0].service_charge; // as if the column did not exist
    return d;
  })(), HOME);
  check("fee: null charge ⇒ identical to the column not existing",
    noFee.length === noCol.length && noFee.every((c, i) => approx(c.home, noCol[i].home, 0.000001)));
  check("fee: null charge ⇒ untouched split (sofia owes 700/3)", approx(owed(noFee, "sofia"), 233.333));
  check("fee: null charge ⇒ untouched split (rui owes 700/3 + 300/2)", approx(owed(noFee, "rui"), 383.333));

  // ── PROPORTIONAL, not per head ──
  const cs = buildContributions(feeData(177), HOME);
  const sofia = owed(cs, "sofia"), rui = owed(cs, "rui");
  check("fee: sofia owes her subtotal × 1.177", approx(sofia, 233.333 * 1.177));
  check("fee: rui owes his subtotal × 1.177", approx(rui, 383.333 * 1.177));
  // Splitting the ฿177 per head would give sofia 233.33 + 59 = 292.33.
  check("fee: sofia is NOT charged an equal per-head slice of the fee", !approx(sofia, 292.333, 1));
  check("fee: the wine drinker carries more of the fee than the non-drinker",
    (rui - 383.333) > (sofia - 233.333));

  // The payer's own share never becomes a contribution, so add it back to prove
  // the whole fee is accounted for and none of it is invented or lost.
  const youSubtotal = 700 / 3 + 300 / 2;
  const allocated = (sofia - 233.333) + (rui - 383.333) + (youSubtotal * 1.177 - youSubtotal);
  check("fee: every ฿ of the charge is allocated, none invented", approx(allocated, 177));

  // ── guards: a corrupt or absent charge means "no fee", never a broken split ──
  [null, undefined, 0, -50, NaN, "abc"].forEach((bad) => {
    check(`fee: charge ${String(bad)} ⇒ factor 1`, feeFactor(feeData(bad).expenses[0]) === 1);
  });
  check("fee: zero subtotal ⇒ factor 1, not a divide-by-zero",
    feeFactor({ total_amount: 0, service_charge: 100 }) === 1);

  // ── the fee rides through the currency layers ──
  // home/base/native all derive from the scaled native amount, so an in-record
  // foreign expense settles fee-inclusive in the record's base currency too.
  const recData = (() => {
    const d = feeData(177);
    d.recordings = [{ id: "r1", base_currency: "KRW", exchange_rate: 0.026, home_currency: "THB" }];
    d.expenses[0] = { ...d.expenses[0], recording_id: "r1", currency: "KRW", home_rate: 0.026 };
    return d;
  })();
  const rc = buildContributions(recData, HOME);
  const sofiaRec = rc.find((c) => c.debtor === "sofia");
  check("fee: native scales with the fee", approx(sofiaRec.native, 233.333 * 1.177));
  check("fee: home scales with the fee", approx(sofiaRec.home, 233.333 * 1.177 * 0.026, 0.001));
  check("fee: base (what an in-record settle charges) scales with the fee",
    approx(sofiaRec.base, 233.333 * 1.177));
}

// ─────────────────────────────────────────────────────────────────────────
console.log(`${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
