// ═══════════════════════════════════════════════════════════════════════
// Guardrail tests for the pure money core (src/lib/balances-core.mjs).
// Plain Node, no framework:  node tests/balances-core.test.mjs  (or npm test)
//
// These encode the invariants locked during Phases 6–7b — run them after ANY
// change to the money path. They must stay green through the Phase 8-pre
// performance refactor (the math must not change, only how/when it runs).
// ═══════════════════════════════════════════════════════════════════════
import {
  toHome, buildContributions, pairNet, netByPerson,
  directTransfers, minimizeTransfers, statusForExpense,
  buildAliasMap, resolveAlias, patchContribsSettled,
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

// ─────────────────────────────────────────────────────────────────────────
console.log(`${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
