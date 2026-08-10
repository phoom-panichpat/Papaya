import { useEffect, useState } from "react";
import { loadSharedRecord } from "../lib/share";
import {
  buildContributions, buildAliasMap, resolveAlias, planSummary,
  directTransfers, statusForExpense, grandTotal, eraFor,
} from "../lib/balances-core.mjs";
import { currencySymbol, formatMoney, padIndex } from "../lib/format";

// ═══════════════════════════════════════════════════════════════════════════
// The PUBLIC read-only view of one record, reached at /s/<token>.
//
// Rendered instead of <App/> at boot (see main.jsx), so it never touches the
// auth gate: a visitor needs no account and no session.
//
// 🔑 It computes NOTHING of its own. Every figure comes from the same
// balances-core functions the app uses, fed the same shaped payload, so this
// page and Phoom's screen can never disagree. The one thing it deliberately
// does differently is names: there is no "You" here, because the reader isn't
// the owner — everyone is called by their name.
// ═══════════════════════════════════════════════════════════════════════════

// ── money ───────────────────────────────────────────────────────────────────
// TWO formatters, and they must not be collapsed (the §12 export lesson):
// formatMoney rounds THB/KRW/JPY/… to whole units, which is right for an
// amount someone TYPED, but a computed share or transfer is genuinely
// fractional and gets up to 2dp.
function Money({ amount, cur, size = 15, dim, weight = 500 }) {
  return (
    <span style={{ whiteSpace: "nowrap", fontSize: size, fontWeight: weight, color: dim ? "var(--text-3)" : "var(--text)" }}>
      <span style={{ color: "var(--text-4)", marginRight: 1 }}>{currencySymbol(cur)}</span>
      <span className="money">{amount}</span>
    </span>
  );
}
const computed = (n) =>
  Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const entered = (n, cur) => formatMoney(n, cur);

function Legend({ children, style }) {
  return <div className="mono" style={{ fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-4)", ...style }}>{children}</div>;
}

function Face({ p, size = 26 }) {
  return (
    <span style={{ width: size, height: size, flex: "none", borderRadius: "50%", background: "var(--bg)", border: "1px solid var(--hairline)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.5 }}>
      {p?.avatar_emoji || "🙂"}
    </span>
  );
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function dateRangeLabel(dates) {
  const ds = dates.map((d) => new Date(d)).filter((d) => !isNaN(d)).sort((a, b) => a - b);
  if (!ds.length) return "";
  const a = ds[0], b = ds[ds.length - 1];
  const f = (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  if (a.toDateString() === b.toDateString()) return f(a);
  if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()) return `${f(a)}–${b.getDate()}`;
  return `${f(a)} – ${f(b)}`;
}

export default function SharedRecord({ token }) {
  const [state, setState] = useState({ loading: true });
  const [openWork, setOpenWork] = useState(false);
  const [openWho, setOpenWho] = useState(null);

  useEffect(() => {
    let alive = true;
    loadSharedRecord(token)
      .then((data) => alive && setState({ loading: false, data }))
      .catch((e) => alive && setState({ loading: false, error: e }));
    return () => { alive = false; };
  }, [token]);

  if (state.loading) {
    return (
      <Shell>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Legend>loading…</Legend>
        </div>
      </Shell>
    );
  }

  if (state.error || !state.data) {
    return (
      <Shell>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "0 32px", textAlign: "center", gap: 10 }}>
          <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em" }}>
            {state.error ? "Couldn’t load this record" : "This link isn’t active"}
          </div>
          <div style={{ fontSize: 13, color: "var(--text-3)", lineHeight: 1.55 }}>
            {state.error
              ? "Check your connection and try again."
              : "It may have been turned off by whoever shared it, or replaced by a newer link. Ask them for a fresh one."}
          </div>
        </div>
        <Footer />
      </Shell>
    );
  }

  const data = state.data;
  const rec = data.recording;
  const era = eraFor(rec, rec.home_currency);
  const base = rec.base_currency || era;
  const contribs = buildContributions(data, era);

  const aliasMap = buildAliasMap(data.people || []);
  const peopleById = Object.fromEntries((data.people || []).map((p) => [p.id, p]));
  const person = (id) => peopleById[resolveAlias(id, aliasMap)] || peopleById[id];
  const nameOf = (id) => person(id)?.display_name || "—";

  const plan = planSummary(contribs, null, "base");
  const directCount = directTransfers(contribs, null, "base").length;
  const dual = era && base && era !== base;

  const expenses = [...(data.expenses || [])].sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  );
  const membersByItem = {};
  (data.members || []).forEach((m) => { (membersByItem[m.item_id] = membersByItem[m.item_id] || []).push(m); });
  const itemsByExpense = {};
  (data.items || []).forEach((it) => { (itemsByExpense[it.expense_id] = itemsByExpense[it.expense_id] || []).push(it); });
  const frozenGroups = new Set((data.groups || []).filter((g) => g.frozen_at).map((g) => g.id));

  // The working: each person's share of everything, minus what they paid for
  // others. Same filter planSummary uses, so the two always agree.
  const inScope = contribs.filter((c) => !c.settled);
  const acc = {};
  const bump = (id) => (acc[id] = acc[id] || { owes: 0, paid: 0, expenses: new Set(), lines: [] });
  inScope.forEach((c) => {
    const d = bump(c.debtor), cr = bump(c.creditor);
    d.owes += c.base; cr.paid += c.base;
    if (c.expenseId) d.expenses.add(c.expenseId);
    // A transfer atom has no expense behind it — it IS the leftover of an
    // earlier summary, so name it rather than rendering a blank row.
    d.lines.push({
      label: c.transferId ? "carried over from a summary" : c.expense?.title || "—",
      to: c.creditor,
      amount: c.base,
    });
  });
  const working = Object.entries(acc)
    .map(([id, v]) => ({ id, ...v, net: v.owes - v.paid, count: v.expenses.size }))
    .sort((a, b) => b.net - a.net);
  const totalOwed = working.reduce((s, w) => s + Math.max(0, w.net), 0);
  const totalDue = working.reduce((s, w) => s + Math.max(0, -w.net), 0);

  return (
    <Shell>
      <div style={{ flex: 1, overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
        {/* ── header ─────────────────────────────────────────────────── */}
        <div style={{ padding: "22px 20px 18px" }}>
          <Legend style={{ marginBottom: 7 }}>shared record · read only</Legend>
          <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.15 }}>{rec.name}</div>
          <div className="mono" style={{ fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-3)", marginTop: 8 }}>
            {[dateRangeLabel(expenses.map((e) => e.created_at)), `${padIndex(expenses.length)} expenses`, base]
              .filter(Boolean).join(" · ")}
          </div>
          {dual && (
            <div className="mono" style={{ fontSize: 9.5, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-4)", marginTop: 5 }}>
              logs in {era}
            </div>
          )}
        </div>

        <div style={{ height: 1, background: "var(--hairline)" }} />

        {/* ── who pays who ───────────────────────────────────────────── */}
        <div style={{ padding: "18px 20px 4px" }}>
          <Legend style={{ marginBottom: 12 }}>who pays who</Legend>
          {plan.transfers.length === 0 ? (
            <div style={{ fontSize: 14, color: "var(--text-3)", paddingBottom: 14 }}>
              Everything here is settled up.
            </div>
          ) : (
            plan.transfers.map((t, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 0", borderBottom: i < plan.transfers.length - 1 ? "1px solid var(--hairline)" : "none" }}>
                <Face p={person(t.from)} />
                <span style={{ minWidth: 0, flex: 1, fontSize: 14.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {nameOf(t.from)}
                  <span style={{ color: "var(--text-4)", margin: "0 6px" }}>→</span>
                  {nameOf(t.to)}
                </span>
                <span style={{ textAlign: "right", flex: "none" }}>
                  <Money amount={computed(t.amount)} cur={base} weight={600} />
                  {dual && (
                    <span style={{ display: "block", marginTop: 1 }}>
                      <Money amount={computed(t.homeAmount)} cur={era} size={11} dim />
                    </span>
                  )}
                </span>
              </div>
            ))
          )}
        </div>

        {/* ── the working ────────────────────────────────────────────── */}
        {plan.transfers.length > 0 && (
          <div style={{ padding: "6px 20px 18px" }}>
            <button
              onClick={() => setOpenWork((v) => !v)}
              className="mono"
              style={{ fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-3)", padding: "8px 0", textAlign: "left" }}
            >
              how this was worked out {openWork ? "⌃" : "⌄"}
            </button>

            {openWork && (
              <div style={{ animation: "fadeIn 160ms var(--ease)" }}>
                <div style={{ fontSize: 12.5, color: "var(--text-3)", lineHeight: 1.6, margin: "4px 0 16px" }}>
                  Everyone’s share of every expense is added up, then what they already
                  paid for other people is taken off. What’s left is what they owe or
                  are owed — and those are cancelled off against each other so the
                  fewest payments settle it.
                </div>

                {working.map((w) => (
                  <div key={w.id} style={{ borderTop: "1px solid var(--hairline)", padding: "12px 0" }}>
                    <div onClick={() => setOpenWho(openWho === w.id ? null : w.id)} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                      <Face p={person(w.id)} size={24} />
                      <span style={{ flex: 1, minWidth: 0, fontSize: 14 }}>{nameOf(w.id)}</span>
                      <span style={{ textAlign: "right" }}>
                        <Money amount={computed(Math.abs(w.net))} cur={base} size={14} weight={600} />
                        <Legend style={{ marginTop: 2 }}>{w.net > 0.005 ? "pays" : w.net < -0.005 ? "gets back" : "square"}</Legend>
                      </span>
                    </div>
                    <div className="mono" style={{ fontSize: 10, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-4)", marginTop: 6, paddingLeft: 34 }}>
                      {w.count
                        ? `share of ${padIndex(w.count)} expenses ${currencySymbol(base)}${computed(w.owes)}`
                        : "no shares of their own"}
                      {w.paid > 0.005 && ` − paid ${currencySymbol(base)}${computed(w.paid)} for others`}
                    </div>

                    {openWho === w.id && w.lines.length > 0 && (
                      <div style={{ marginTop: 9, paddingLeft: 34, animation: "fadeIn 140ms var(--ease)" }}>
                        {w.lines.map((l, i) => (
                          <div key={i} style={{ display: "flex", gap: 8, padding: "4px 0", fontSize: 12, color: "var(--text-2)" }}>
                            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {l.label} <span style={{ color: "var(--text-4)" }}>· to {nameOf(l.to)}</span>
                            </span>
                            <Money amount={computed(l.amount)} cur={base} size={12} dim />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}

                {/* the one claim a reader can check on the spot */}
                <div style={{ borderTop: "1px solid var(--hairline)", padding: "12px 0", display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ flex: 1, fontSize: 12.5, color: "var(--text-3)", lineHeight: 1.5 }}>
                    Owed and due come to the same number. If they ever didn’t, the app would be wrong.
                  </span>
                  <span style={{ flex: "none", textAlign: "right" }}>
                    <Money amount={computed(totalOwed)} cur={base} size={13} />
                    <Legend style={{ marginTop: 2, color: Math.abs(totalOwed - totalDue) < 0.02 ? "var(--settled)" : "var(--danger)" }}>
                      {Math.abs(totalOwed - totalDue) < 0.02 ? "balances ✓" : "off by " + computed(totalOwed - totalDue)}
                    </Legend>
                  </span>
                </div>

                {directCount > plan.transfers.length ? (
                  <div style={{ fontSize: 12.5, color: "var(--text-3)", lineHeight: 1.6, paddingTop: 4 }}>
                    There are {padIndex(directCount)} separate debts here; cancelling the ones
                    that point both ways settles them with {padIndex(plan.transfers.length)} payments.
                  </div>
                ) : (
                  <div style={{ fontSize: 12.5, color: "var(--text-3)", lineHeight: 1.6, paddingTop: 4 }}>
                    Nothing cancels out here — no two people owe each other — so this is
                    already the fewest payments possible.
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div style={{ height: 1, background: "var(--hairline)" }} />

        {/* ── expenses ───────────────────────────────────────────────── */}
        <div style={{ padding: "18px 20px 8px" }}>
          <Legend style={{ marginBottom: 4 }}>expenses</Legend>
        </div>
        {expenses.map((e) => {
          const items = itemsByExpense[e.id] || [];
          const rows = items.flatMap((it) => membersByItem[it.id] || []);
          const st = rows.length ? statusForExpense(rows, e.paid_by, nameOf) : { kind: "open" };
          const settled = st.kind === "settled";
          const cur = e.currency || base;
          const inFrozen = e.summary_group_id && frozenGroups.has(e.summary_group_id);
          return (
            <div key={e.id} style={{ padding: "12px 20px", borderTop: "1px solid var(--hairline)", display: "flex", alignItems: "flex-start", gap: 12, opacity: settled ? 0.5 : 1 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14.5, textDecoration: settled ? "line-through" : "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {e.title}
                </div>
                <div className="mono" style={{ fontSize: 9.5, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-4)", marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {[nameOf(e.paid_by), settled ? "settled" : st.kind === "partial" ? st.label : "open", inFrozen ? "in a summary" : null]
                    .filter(Boolean).join(" · ")}
                </div>
                {e.note && (
                  <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 5, lineHeight: 1.45 }}>{e.note}</div>
                )}
              </div>
              <span style={{ flex: "none", textAlign: "right", paddingTop: 1 }}>
                <Money amount={entered(grandTotal(e), cur)} cur={cur} size={14} dim={settled} />
              </span>
            </div>
          );
        })}

        <Footer />
      </div>
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div style={{ position: "absolute", inset: 0, background: "var(--bg)", display: "flex", flexDirection: "column" }}>
      {children}
    </div>
  );
}

function Footer() {
  return (
    <div style={{ padding: "26px 20px 34px", borderTop: "1px solid var(--hairline)", marginTop: 18 }}>
      <div className="mono" style={{ fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-4)", lineHeight: 1.8 }}>
        shared from papaya · read only
        <br />
        nobody’s payment details are included
      </div>
    </div>
  );
}
