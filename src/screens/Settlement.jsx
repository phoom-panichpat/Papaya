import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "../lib/supabase";
import { currencySymbol, padIndex } from "../lib/format";
import DualMoney from "../components/DualMoney";
import SaveError from "../components/SaveError";
import { useBackLayer } from "../lib/backstack.jsx";
import {
  loadSettlementData, buildContributions, pairNet, pairNetByEra, sumHomeByEra,
  settleShares, unsettleShares, patchContribsSettled, grandTotal,
  loadEvents, buildAliasMap, resolveAlias,
} from "../lib/balances";

// The append-only log's four kinds, as the user reads them. SETTLED is the
// settled-green, REOPENED is the danger red (a reversal must never read as a
// settle — same reasoning as the red Un-settle button), summaries are neutral.
const EVENT_KINDS = {
  settle_shares:    { label: "Settled",          color: "var(--settled)" },
  unsettle_shares:  { label: "Reopened",         color: "var(--danger)" },
  summary:          { label: "Summary",          color: "var(--text-3)" },
  summary_reverted: { label: "Summary reverted", color: "var(--text-3)" },
};

function money(n, cur) {
  return `${currencySymbol(cur)}${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function relTime(iso) {
  const d = new Date(iso), now = new Date();
  const s = (now - d) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  if (s < 604800) return `${Math.floor(s/86400)}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fullDate(iso) {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

// money = greyed grotesque symbol + Doto digits (global rule); digits can be tinted
function Money({ n, cur, color, style = {} }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 2, ...style }}>
      <span style={{ fontSize: "0.8em", color: "var(--text-2)" }}>{currencySymbol(cur)}</span>
      <span className="money" style={color ? { color } : undefined}>{Math.abs(Number(n) || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>
    </span>
  );
}

// ── the global tab: direct pairwise balances between You and each person ──
// `active` = this tab is the visible one — see the note in People.jsx.
export default function Settlement({ people, refreshKey, onOpenExpense, onOpenRecording, onLoaded, active = true }) {
  const [home, setHome] = useState("THB");
  const [contribs, setContribs] = useState([]);
  const [data, setData] = useState(null);
  const [view, setView] = useState("balances"); // balances | history
  const [loading, setLoading] = useState(true);
  const [openPid, setOpenPid] = useState(null);
  const [openEvent, setOpenEvent] = useState(null);
  const [saveErr, setSaveErr] = useState(false);
  const [histSeg, setHistSeg] = useState("settled"); // settled | records | expenses | activity
  const [histQ, setHistQ] = useState("");
  const [events, setEvents] = useState([]); // the append-only settlement_events log
  const chain = useRef(Promise.resolve()); // serializes background writes

  // Hardware back closes an open sheet.
  useBackLayer(active && !!openPid, () => setOpenPid(null));
  useBackLayer(active && !!openEvent, () => setOpenEvent(null));

  const self = (people || []).find((p) => p.is_self);
  const person = useCallback((id) => (people || []).find((x) => x.id === id), [people]);
  const nameOf = useCallback((id) => {
    const p = person(id);
    return p ? (p.is_self ? "You" : p.display_name) : "—";
  }, [person]);

  const load = useCallback(async () => {
    // one phase — the log is independent of the money data, so it rides along
    const [d, ev] = await Promise.all([loadSettlementData(), loadEvents()]);
    setData(d);
    setContribs(buildContributions(d, home));
    setEvents(ev);
    setLoading(false);
    onLoaded?.(); // tell App this screen is fresh (used to defer an archive pop)
  }, [home, onLoaded]);

  // archived loose expenses → History (settled ≠ archived; archiving is deliberate, like records)
  const archivedLoose = (data?.expenses || [])
    .filter((e) => !e.recording_id && e.archived_at)
    .sort((a, b) => new Date(b.archived_at) - new Date(a.archived_at));

  // archived recordings → History
  const archivedRecs = (data?.recordings || [])
    .filter((r) => r.archived_at)
    .map((r) => ({ ...r, count: (data?.expenses || []).filter((e) => e.recording_id === r.id).length }))
    .sort((a, b) => new Date(b.archived_at) - new Date(a.archived_at));

  // settlement events → History: settled contribs grouped by settledAt + person-PAIR
  // (RecordSettleSheet "Mark all as paid" stamps several different pairs with the same
  //  timestamp — keep them separate events by including creditor::debtor in the key)
  const settleEvents = (() => {
    const groups = {};
    for (const c of contribs) {
      if (!c.settled || !c.settledAt) continue;
      const key = `${c.settledAt}::${c.creditor}::${c.debtor}`;
      const g = groups[key] || (groups[key] = { settledAt: c.settledAt, creditor: c.creditor, debtor: c.debtor, contribs: [] });
      g.contribs.push(c);
    }
    // totals are per ERA — home amounts pinned to different home currencies are
    // different units and are never added together
    return Object.values(groups)
      .map((g) => ({ ...g, byEra: sumHomeByEra(g.contribs) }))
      .sort((a, b) => new Date(b.settledAt) - new Date(a.settledAt));
  })();

  // ── Activity: the append-only log, described in plain language ──────────
  // An event stores only `shares` = [{itemId, personId}], so what it COVERED is
  // resolved here against data this screen has already loaded. Shares can go
  // stale — editing an expense deletes and rebuilds its items — so an older
  // event may point at ids that no longer exist. That degrades to a truthful
  // "details no longer available" rather than rendering "undefined".
  const activity = (() => {
    if (!data) return [];
    const alias = buildAliasMap(data.people || []);
    const expById = {};
    (data.expenses || []).forEach((e) => { expById[e.id] = e; });
    const expByItem = {};
    (data.items || []).forEach((it) => { expByItem[it.id] = expById[it.expense_id]; });
    const recById = {};
    (data.recordings || []).forEach((r) => { recById[r.id] = r; });

    return (events || []).map((ev) => {
      const shares = Array.isArray(ev.shares) ? ev.shares : [];
      const exps = [], names = new Set();
      const seen = new Set();
      shares.forEach((s) => {
        const e = expByItem[s.itemId];
        if (e && !seen.has(e.id)) { seen.add(e.id); exps.push(e); }
        if (s.personId) names.add(nameOf(resolveAlias(alias, s.personId)));
      });
      const rec = ev.recording_id ? recById[ev.recording_id] : null;
      const n = shares.length;
      const countPart = `${n} share${n === 1 ? "" : "s"}`;

      // A summary is about a whole record, so name the record when we have it;
      // a share settle is about an expense, so name that.
      let detail;
      if (rec) detail = rec.name;
      else if (exps.length === 1) detail = exps[0].title;
      else if (exps.length > 1) detail = `${exps.length} expenses`;
      else detail = n ? "details no longer available" : null;

      const kind = EVENT_KINDS[ev.kind] || { label: ev.kind, color: "var(--text-3)" };
      return {
        ev, kind,
        line: [n ? countPart : null, detail].filter(Boolean).join(" · ") || "—",
        haystack: [kind.label, detail, ev.note, ...names, ...exps.map((e) => e.title)]
          .filter(Boolean).join(" ").toLowerCase(),
      };
    });
  })();

  const historyEmpty =
    archivedLoose.length === 0 && archivedRecs.length === 0 &&
    settleEvents.length === 0 && activity.length === 0;

  // read home currency once
  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("profiles").select("home_currency").maybeSingle();
      if (data?.home_currency) setHome(data.home_currency);
    })();
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  // Optimistic mutations (owned here so patch + write + failure re-sync live
  // together): flip local contribs instantly, write in the background; on a
  // failed write, reload the truth from the server and say so.
  const background = useCallback((write) => {
    chain.current = chain.current
      .then(write)
      // the write just appended a log row — pull the log back so Activity is
      // current, without re-loading (and re-deriving) the whole money picture
      .then(() => loadEvents().then(setEvents).catch(() => {}))
      .catch(() => { setSaveErr(true); return load().catch(() => {}); });
  }, [load]);

  // Per other person: their debt expressed in home currency, grouped PER ERA
  // (byEra) — every record/expense already carries its own manually-set rate
  // to the currency it was logged under, so within one era there's nothing
  // left to convert; the figure is already correct. A second era only appears
  // once the user has actually changed their home currency. `homeNet` sums
  // across eras and is therefore only ever used to order the list, never shown
  // (adding two different eras' home figures together would be meaningless).
  // positive = they owe you.
  const rows = self
    ? (people || [])
        .filter((p) => !p.is_self)
        .map((p) => ({
          p,
          byEra: pairNetByEra(contribs, self.id, p.id),
          homeNet: pairNet(contribs, self.id, p.id),
        }))
        .filter((r) => r.byEra.length > 0)
        .sort((a, b) => b.homeNet - a.homeNet)
    : [];

  // Summary totals, one line per era — walk every row's own byEra entries
  // (not homeNet) so one person owing you in the old era while you owe them
  // in the new era lands as two separate figures on opposite sides.
  const owedByEra = {}, oweByEra = {};
  rows.forEach((r) => r.byEra.forEach((e) => {
    if (e.net > 0) owedByEra[e.currency] = (owedByEra[e.currency] || 0) + e.net;
    else if (e.net < 0) oweByEra[e.currency] = (oweByEra[e.currency] || 0) - e.net;
  }));
  const toSortedList = (bucket) =>
    Object.entries(bucket)
      .map(([currency, amount]) => ({ currency, amount }))
      .filter((x) => Math.abs(x.amount) > 0.005)
      .sort((a, b) => b.amount - a.amount);
  const owedList = toSortedList(owedByEra);
  const oweList = toSortedList(oweByEra);

  // PersonSettleSheet commit: `rows` = the original member rows to settle
  function commitSettle(rows) {
    const at = new Date().toISOString();
    setContribs((cs) => patchContribsSettled(cs, rows, at));
    setOpenPid(null);
    background(() => settleShares(rows, at));
  }

  // EventSheet un-settle: `rows` = the (possibly partial) member rows to reopen.
  // `note` is optional and only reaches the log — it can never move a balance.
  function unsettleEvent(rows, note) {
    setContribs((cs) => patchContribsSettled(cs, rows, null));
    setOpenEvent(null);
    background(() => unsettleShares(rows, note));
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg)", position: "relative" }}>
      {/* header */}
      <div style={{ padding: "26px 24px 14px", borderBottom: "1px solid var(--hairline)", flex: "none" }}>
        <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.01em", marginBottom: 14 }}>Settlement</div>
        <div style={{ display: "flex", gap: 4, background: "var(--bg)", border: "1px solid var(--hairline)", borderRadius: 12, padding: 3 }}>
          {["balances", "history"].map((v) => {
            const active = view === v;
            return (
              <button key={v} onClick={() => setView(v)} style={{ flex: 1, height: 34, borderRadius: 9, textTransform: "capitalize", background: active ? "var(--surface)" : "transparent", border: active ? "1px solid var(--hairline)" : "1px solid transparent", fontSize: 13.5, fontWeight: active ? 600 : 500, color: active ? "var(--text)" : "var(--text-3)" }}>{v}</button>
            );
          })}
        </div>
      </div>

      {view === "history" ? (
        historyEmpty ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ textAlign: "center", color: "var(--text-3)", fontSize: 14 }}>Nothing settled or archived yet.</div>
          </div>
        ) : (
          <>
            {/* search + sub-nav (subordinate to the main Balances|History control) */}
            <div style={{ padding: "14px 20px 12px", borderBottom: "1px solid var(--hairline)", flex: "none", display: "flex", flexDirection: "column", gap: 12 }}>
              <input value={histQ} onChange={(e) => setHistQ(e.target.value)} placeholder="Search history" style={{ height: 40, padding: "0 14px", background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: 12, fontSize: 15, outline: "none" }} />
              <div style={{ display: "flex", gap: 18 }}>
                {[
                  { id: "settled", label: "Settled", count: settleEvents.length },
                  { id: "records", label: "Records", count: archivedRecs.length },
                  { id: "expenses", label: "Expenses", count: archivedLoose.length },
                  { id: "activity", label: "Activity", count: activity.length },
                ].map((s) => {
                  const active = histSeg === s.id;
                  return (
                    <button key={s.id} onClick={() => setHistSeg(s.id)} style={{ background: "none", border: "none", borderBottom: active ? "1.5px solid var(--text)" : "1.5px solid transparent", paddingBottom: 6, display: "flex", alignItems: "baseline", gap: 5, fontSize: 13, fontWeight: active ? 600 : 500, color: active ? "var(--text)" : "var(--text-3)" }}>
                      {s.label}<span className="mono" style={{ fontSize: 10, color: "var(--text-4)" }}>{padIndex(s.count)}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px 120px" }}>
              {histSeg === "settled" && (() => {
                const q = histQ.trim().toLowerCase();
                const list = q
                  ? settleEvents.filter((ev) => nameOf(ev.creditor).toLowerCase().includes(q) || nameOf(ev.debtor).toLowerCase().includes(q))
                  : settleEvents;
                if (!list.length) return <div style={{ textAlign: "center", padding: "50px 0", color: "var(--text-3)", fontSize: 14 }}>{settleEvents.length ? "No matches." : "No settled activity yet."}</div>;
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {list.map((ev, i) => {
                      const youPaid = ev.debtor === self?.id;
                      const theyPaidYou = ev.creditor === self?.id;
                      const label = theyPaidYou
                        ? `${nameOf(ev.debtor)} paid you`
                        : youPaid
                          ? `You paid ${nameOf(ev.creditor)}`
                          : `${nameOf(ev.debtor)} paid ${nameOf(ev.creditor)}`;
                      return (
                        <button key={`${ev.settledAt}::${ev.creditor}::${ev.debtor}::${i}`} onClick={() => setOpenEvent(ev)} style={{ width: "100%", background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: "var(--r-card)", padding: "14px 18px", textAlign: "left", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                          <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                            <span style={{ fontSize: 15, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "inline-flex", alignItems: "center", gap: 6 }}>
                              <span className="mono" style={{ fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--settled)" }}>✓</span>
                              {label}
                            </span>
                            <span className="mono" style={{ fontSize: 10, color: "var(--text-3)" }}>{relTime(ev.settledAt)} · {ev.contribs.length} share{ev.contribs.length === 1 ? "" : "s"}</span>
                          </span>
                          <span style={{ flex: "none", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                            {ev.byEra.map((e) => (
                              <Money key={e.currency} n={e.amount} cur={e.currency} color="var(--text-3)" style={{ fontSize: 15 }} />
                            ))}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })()}

              {histSeg === "records" && (() => {
                const q = histQ.trim().toLowerCase();
                const list = q ? archivedRecs.filter((r) => (r.name || "").toLowerCase().includes(q)) : archivedRecs;
                if (!list.length) return <div style={{ textAlign: "center", padding: "50px 0", color: "var(--text-3)", fontSize: 14 }}>{archivedRecs.length ? "No matches." : "No archived records."}</div>;
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {list.map((r) => {
                      const hasOpen = contribs.some((c) => c.recordingId === r.id && !c.settled);
                      return (
                        <button key={r.id} onClick={() => onOpenRecording && onOpenRecording(r.id)} style={{ width: "100%", background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: "var(--r-card)", padding: "14px 18px", textAlign: "left", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, opacity: hasOpen ? 1 : 0.7 }}>
                          <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                            <span style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 16, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                              {hasOpen && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--open)", flex: "none" }} />}
                              {r.name}
                            </span>
                            <span className="mono" style={{ fontSize: 10, color: "var(--text-3)" }}>archived · {r.count} log{r.count === 1 ? "" : "s"}{r.base_currency ? ` · ${r.base_currency}` : ""}{hasOpen ? ` · ` : ""}{hasOpen && <span style={{ color: "var(--open)" }}>open</span>}</span>
                          </span>
                          <span className="mono" style={{ fontSize: 12, color: "var(--text-4)", flex: "none" }}>›</span>
                        </button>
                      );
                    })}
                  </div>
                );
              })()}

              {histSeg === "expenses" && (() => {
                const q = histQ.trim().toLowerCase();
                const list = q ? archivedLoose.filter((e) => (e.title || "").toLowerCase().includes(q)) : archivedLoose;
                if (!list.length) return <div style={{ textAlign: "center", padding: "50px 0", color: "var(--text-3)", fontSize: 14 }}>{archivedLoose.length ? "No matches." : "No archived expenses."}</div>;
                return list.map((e) => {
                  const hasOpen = contribs.some((c) => c.expenseId === e.id && !c.settled);
                  return (
                    <button key={e.id} onClick={() => onOpenExpense && onOpenExpense(e.id)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "12px 4px", borderBottom: "1px solid var(--hairline-3)", textAlign: "left", opacity: hasOpen ? 1 : 0.6 }}>
                      {hasOpen ? (
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--open)", flex: "none" }} />
                      ) : (
                        <span className="mono" style={{ fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--settled)", flex: "none" }}>✓</span>
                      )}
                      <span style={{ flex: 1, minWidth: 0, fontSize: 15, textDecoration: hasOpen ? "none" : "line-through", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: hasOpen ? "var(--text)" : undefined }}>{e.title}</span>
                      <span style={{ display: "flex", alignItems: "baseline", gap: 2, flex: "none" }}>
                        <span style={{ fontSize: 11, color: hasOpen ? "var(--text-2)" : "var(--text-3)" }}>{currencySymbol(e.currency || home)}</span>
                        <span className="money" style={{ fontSize: 13, color: hasOpen ? "var(--text)" : "var(--text-3)" }}>{Math.abs(grandTotal(e)).toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>
                      </span>
                    </button>
                  );
                });
              })()}

              {/* Activity — the append-only log. READ-ONLY on purpose: reversing
                  a settle lives in the Settled section's sheet, so there is
                  exactly one control surface for it. A log you can act on is
                  how the Phase-6 stuck state happened. */}
              {histSeg === "activity" && (() => {
                const q = histQ.trim().toLowerCase();
                const list = q ? activity.filter((a) => a.haystack.includes(q)) : activity;
                if (!list.length) return <div style={{ textAlign: "center", padding: "50px 0", color: "var(--text-3)", fontSize: 14 }}>{activity.length ? "No matches." : "No activity yet."}</div>;
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {list.map((a) => (
                      <div key={a.ev.id} style={{ background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: "var(--r-card)", padding: "13px 18px", display: "flex", flexDirection: "column", gap: 5 }}>
                        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
                          <span className="mono" style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: a.kind.color, flex: "none" }}>{a.kind.label}</span>
                          <span className="mono" style={{ fontSize: 10, color: "var(--text-4)", flex: "none" }}>{relTime(a.ev.created_at)}</span>
                        </div>
                        <div style={{ fontSize: 14.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.line}</div>
                        {a.ev.note && <div style={{ fontSize: 13, color: "var(--text-3)" }}>{a.ev.note}</div>}
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          </>
        )
      ) : (
      <>
      {/* summary */}
      <div style={{ padding: "16px 24px", borderBottom: "1px solid var(--hairline)", flex: "none", display: "flex", gap: 28 }}>
        <div>
          <div className="legend" style={{ color: "var(--settled)" }}>Owed to you</div>
          {owedList.length === 0 ? (
            <Money n={0} cur={home} color="var(--text-3)" style={{ fontSize: 22, marginTop: 4 }} />
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 6, marginTop: 4 }}>
              {owedList.map((e, i) => (
                <span key={e.currency} style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                  {i > 0 && <span style={{ color: "var(--text-4)" }}>·</span>}
                  <Money n={e.amount} cur={e.currency} color="var(--text)" style={{ fontSize: 22 }} />
                </span>
              ))}
            </div>
          )}
        </div>
        <div>
          <div className="legend" style={{ color: "var(--open)" }}>You owe</div>
          {oweList.length === 0 ? (
            <Money n={0} cur={home} color="var(--text-3)" style={{ fontSize: 22, marginTop: 4 }} />
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 6, marginTop: 4 }}>
              {oweList.map((e, i) => (
                <span key={e.currency} style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                  {i > 0 && <span style={{ color: "var(--text-4)" }}>·</span>}
                  <Money n={e.amount} cur={e.currency} color="var(--text)" style={{ fontSize: 22 }} />
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* helper */}
      <div style={{ padding: "12px 24px", borderBottom: "1px solid var(--hairline)", flex: "none" }} className="mono">
        <span style={{ fontSize: 10.5, lineHeight: 1.7, color: "var(--text-3)" }}>direct settle · tap a person to mark what’s paid</span>
      </div>

      {/* people list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px 120px" }}>
        {loading ? null : rows.length === 0 ? (
          <div style={{ textAlign: "center", padding: "70px 0", color: "var(--text-3)" }}>
            <div style={{ fontSize: 15, color: "var(--text-2)" }}>All settled up</div>
            <div className="mono" style={{ fontSize: 10.5, marginTop: 6 }}>no outstanding balances</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {rows.map(({ p, byEra }) => {
              const single = byEra.length === 1;
              return (
                <div
                  key={p.id}
                  onClick={() => setOpenPid(p.id)}
                  style={{ background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: "var(--r-card)", padding: "14px 18px", cursor: "pointer", display: "flex", alignItems: "center", gap: 12 }}
                >
                  <span style={{ width: 40, height: 40, borderRadius: "50%", background: p.avatar_color || "var(--knob-off)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flex: "none" }}>{p.avatar_emoji || "🙂"}</span>
                  <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                    <span style={{ fontSize: 16, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.display_name}</span>
                    {single && (
                      <span className="mono" style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: byEra[0].net > 0 ? "var(--settled)" : "var(--open)" }}>
                        {byEra[0].net > 0 ? "owes you" : "you owe"}
                      </span>
                    )}
                  </span>
                  <span style={{ flex: "none", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                    {byEra.map((e) => {
                      const they = e.net > 0;
                      return (
                        <span key={e.currency} style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
                          {!single && (
                            <span className="mono" style={{ fontSize: 8.5, letterSpacing: "0.06em", textTransform: "uppercase", color: they ? "var(--settled)" : "var(--open)" }}>
                              {they ? "owes you" : "you owe"}
                            </span>
                          )}
                          <Money n={e.net} cur={e.currency} color={they ? "var(--settled)" : "var(--open)"} style={{ fontSize: single ? 18 : 15 }} />
                        </span>
                      );
                    })}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      </>
      )}

      {/* person settle sheet */}
      {openPid && self && (
        <PersonSettleSheet
          self={self}
          other={person(openPid)}
          contribs={contribs}
          home={home}
          nameOf={nameOf}
          onClose={() => setOpenPid(null)}
          onCommitted={commitSettle}
        />
      )}

      {/* settled-event detail sheet */}
      {openEvent && self && (
        <EventSheet
          event={openEvent}
          self={self}
          home={home}
          nameOf={nameOf}
          onClose={() => setOpenEvent(null)}
          onUnsettle={unsettleEvent}
        />
      )}

      {saveErr && <SaveError onDone={() => setSaveErr(false)} />}
    </div>
  );
}

// ── person detail: item-check partial settle ─────────────────────────────
function PersonSettleSheet({ self, other, contribs, home, nameOf, onClose, onCommitted }) {
  // unsettled shares between the two, either direction
  const shares = contribs.filter(
    (c) => !c.settled && (
      (c.debtor === self.id && c.creditor === other.id) ||
      (c.debtor === other.id && c.creditor === self.id)
    )
  );
  const [ticked, setTicked] = useState(() => new Set());

  function keyOf(c) { return c.transferId ? `t:${c.transferId}` : `${c.itemId}:${c.personId}`; }
  // A summary's transfer has no item shares behind it, so there is nothing here
  // to tick — ticking it would settle zero rows and leave the row stuck on
  // "paid" while the debt stayed open (the Phase-6 bug). It still LISTS, so this
  // sheet keeps adding up to the person card, but it is settled in the record
  // where its summary lives.
  const tickable = shares.filter((c) => !c.transferId);
  function toggle(c) {
    if (c.transferId) return;
    setTicked((s) => { const n = new Set(s); const k = keyOf(c); n.has(k) ? n.delete(k) : n.add(k); return n; });
  }

  // Signed home net PER ERA. These readouts cross items and people, so they
  // have to convert — but home amounts pinned to different home currencies are
  // different units, so they're listed per era and never added across.
  const signedByEra = (list) =>
    sumHomeByEra(list.map((c) => ({ ...c, home: c.creditor === self.id ? c.home : -c.home })))
      .map(({ currency, amount }) => ({ currency, net: amount })); // read as a signed net below

  const tickedList = shares.filter((c) => ticked.has(keyOf(c)));
  const remaining = signedByEra(shares.filter((c) => !ticked.has(keyOf(c)))); // what's left after this settle
  const settling = signedByEra(tickedList);

  function commit() {
    if (!tickedList.length) return;
    onCommitted(tickedList.flatMap((c) => c.settleKeys)); // original member rows (merge-aware)
  }

  return (
    <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "var(--scrim-sheet)", zIndex: 50, animation: "fadeIn 140ms ease" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "86%", background: "var(--surface)", borderTop: "1px solid var(--hairline)", borderRadius: "var(--r-sheet) var(--r-sheet) 0 0", padding: "14px 20px 20px", animation: "sheetIn 240ms var(--ease)", display: "flex", flexDirection: "column" }}>
        <div style={{ width: 36, height: 3, borderRadius: 2, background: "#DCD6C6", margin: "0 auto 14px" }} />

        {/* head */}
        <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 4 }}>
          <span style={{ width: 40, height: 40, borderRadius: "50%", background: other?.avatar_color || "var(--knob-off)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>{other?.avatar_emoji || "🙂"}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em" }}>{other?.display_name}</div>
            <div className="mono" style={{ fontSize: 10, color: "var(--text-3)" }}>{shares.length} open {shares.length === 1 ? "item" : "items"}</div>
          </div>
        </div>

        {/* How to pay them, at the moment you'd want it — only when the balance
            runs YOUR way. If they owe you, their account number is just noise. */}
        {/* keyed off the WHOLE balance, not `remaining` — otherwise ticking
            everything would hide the details right as you go to pay */}
        {other?.payment_note && signedByEra(shares).some((e) => e.net < 0) && (
          <div style={{ margin: "10px 0 2px", padding: "10px 13px", background: "var(--bg)", border: "1px solid var(--hairline)", borderRadius: 12 }}>
            <div className="mono" style={{ fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-3)", marginBottom: 4 }}>Pay {other.display_name}</div>
            <div style={{ fontSize: 14, color: "var(--text-2)", userSelect: "text", whiteSpace: "pre-wrap" }}>{other.payment_note}</div>
          </div>
        )}

        {shares.length === 0 ? (
          <div style={{ padding: "30px 0", textAlign: "center", color: "var(--text-3)", fontSize: 14 }}>Nothing outstanding.</div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "12px 0 4px" }}>
              <span className="legend">Check what’s paid</span>
              <button
                onClick={() => setTicked((s) => s.size === tickable.length ? new Set() : new Set(tickable.map(keyOf)))}
                className="mono" style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-3)" }}
              >
                {ticked.size === tickable.length && tickable.length > 0 ? "Clear" : "Check all"}
              </button>
            </div>

            <div style={{ overflowY: "auto", marginTop: 4 }}>
              {shares.map((c) => {
                const k = keyOf(c);
                const on = ticked.has(k);
                const theyOwe = c.creditor === self.id;
                const isTransfer = !!c.transferId;
                return (
                  <button key={k} onClick={() => toggle(c)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 11, padding: "12px 2px", borderBottom: "1px solid var(--hairline-3)", textAlign: "left", opacity: isTransfer ? 0.75 : 1 }}>
                    <span style={{ width: 22, height: 22, borderRadius: 7, border: on ? "none" : "1.5px solid var(--hairline)", background: on ? "var(--settled)" : "var(--bg)", color: isTransfer ? "var(--text-4)" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, flex: "none" }}>{isTransfer ? "–" : (on ? "✓" : "")}</span>
                    <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                      <span style={{ fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{isTransfer ? "Summary transfer" : c.expense?.title}</span>
                      <span className="mono" style={{ fontSize: 9.5, letterSpacing: "0.06em", textTransform: "uppercase", color: theyOwe ? "var(--settled)" : "var(--open)" }}>
                        {isTransfer
                          ? `settle in the record · ${theyOwe ? "owes you" : "you owe"}`
                          : `${c.item?.is_rest ? "the rest" : (c.item?.label || "item")} · ${theyOwe ? "owes you" : "you owe"}`}
                      </span>
                    </span>
                    {/* home-per-era primary, so these rows visibly add up to the
                        person card and to the footer readouts. DualMoney's
                        secondary slot carries the NATIVE amount here — the
                        inverse of the record-scoped screens, which lead with
                        native and fade the home line. */}
                    <DualMoney
                      primary={<Money n={c.home} cur={c.homeCurrency} color={theyOwe ? "var(--settled)" : "var(--open)"} style={{ fontSize: 14, flex: "none" }} />}
                      homeAmount={c.currency && c.currency !== c.homeCurrency ? c.native : null}
                      homeCur={c.currency}
                      style={{ flex: "none", alignItems: "flex-end" }}
                    />
                  </button>
                );
              })}
            </div>

            {/* footer */}
            <div style={{ borderTop: "1px solid var(--hairline)", marginTop: 10, paddingTop: 14 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>
                  {remaining.length === 0
                    ? "settles up fully"
                    : remaining
                        .map((e) => (e.net > 0 ? `${money(e.net, e.currency)} still owed to you` : `you'd still owe ${money(e.net, e.currency)}`))
                        .join(" · ")}
                </span>
                <span className="mono" style={{ fontSize: 10.5, color: "var(--text-2)" }}>
                  settling {settling.length === 0
                    ? `+${money(0, home)}`
                    : settling.map((e) => `${e.net >= 0 ? "+" : "−"}${money(e.net, e.currency)}`).join(" · ")}
                </span>
              </div>
              <button
                onClick={commit}
                disabled={!tickedList.length}
                style={{ width: "100%", height: 48, borderRadius: 14, background: "var(--accent)", color: "#fff", fontSize: 15, fontWeight: 600, opacity: tickedList.length ? 1 : 0.4 }}
              >
                {`Mark ${tickedList.length} settled`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── settled-event detail: the shares behind one settlement, + partial un-settle ──
function EventSheet({ event, self, home, nameOf, onClose, onUnsettle }) {
  function keyOf(c) { return `${c.itemId}:${c.personId}`; }
  const [ticked, setTicked] = useState(() => new Set()); // start unchecked — un-settling is deliberate
  const [note, setNote] = useState(""); // optional "why?" — goes to the log only
  function toggle(c) {
    setTicked((s) => { const n = new Set(s); const k = keyOf(c); n.has(k) ? n.delete(k) : n.add(k); return n; });
  }
  const tickedContribs = event.contribs.filter((c) => ticked.has(keyOf(c)));

  const youPaid = event.debtor === self.id;
  const theyPaidYou = event.creditor === self.id;
  const label = theyPaidYou
    ? `${nameOf(event.debtor)} paid you`
    : youPaid
      ? `You paid ${nameOf(event.creditor)}`
      : `${nameOf(event.debtor)} paid ${nameOf(event.creditor)}`;

  function unsettle() {
    if (!tickedContribs.length) return;
    // ORIGINAL member rows (merge-safe); the note rides along to the log
    onUnsettle(tickedContribs.flatMap((c) => c.settleKeys), note.trim() || undefined);
  }

  return (
    <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "var(--scrim-sheet)", zIndex: 50, animation: "fadeIn 140ms ease" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "86%", background: "var(--surface)", borderTop: "1px solid var(--hairline)", borderRadius: "var(--r-sheet) var(--r-sheet) 0 0", padding: "14px 20px 20px", animation: "sheetIn 240ms var(--ease)", display: "flex", flexDirection: "column" }}>
        <div style={{ width: 36, height: 3, borderRadius: 2, background: "#DCD6C6", margin: "0 auto 14px" }} />

        {/* head: who paid who + total + full date */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 4 }}>
          <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em" }}>
              <span className="mono" style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--settled)" }}>✓</span>
              {label}
            </div>
            <div className="mono" style={{ fontSize: 10, color: "var(--text-3)" }}>{fullDate(event.settledAt)}</div>
          </div>
          <span style={{ flex: "none", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
            {event.byEra.map((e) => (
              <Money key={e.currency} n={e.amount} cur={e.currency} color="var(--text)" style={{ fontSize: 20 }} />
            ))}
          </span>
        </div>

        {/* underlying shares — tickable for partial un-settle */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "12px 0 4px" }}>
          <span className="legend">Shares</span>
          <button
            onClick={() => setTicked((s) => s.size === event.contribs.length ? new Set() : new Set(event.contribs.map(keyOf)))}
            className="mono" style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-3)" }}
          >
            {ticked.size === event.contribs.length ? "Clear" : "Check all"}
          </button>
        </div>
        <div style={{ overflowY: "auto", marginTop: 4 }}>
          {event.contribs.map((c) => {
            const k = keyOf(c);
            const on = ticked.has(k);
            return (
              <button key={k} onClick={() => toggle(c)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 11, padding: "12px 2px", borderBottom: "1px solid var(--hairline-3)", textAlign: "left" }}>
                <span style={{ width: 22, height: 22, borderRadius: 7, border: on ? "none" : "1.5px solid var(--hairline)", background: on ? "var(--danger)" : "var(--bg)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, flex: "none" }}>{on ? "✓" : ""}</span>
                <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                  {/* transfer atoms are never `settled`, so they can't reach a
                      settled event — the optional chaining is belt-and-braces. */}
                  <span style={{ fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.expense?.title}</span>
                  <span className="mono" style={{ fontSize: 9.5, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-3)" }}>
                    {c.item?.is_rest ? "the rest" : (c.item?.label || "item")}
                  </span>
                </span>
                <Money n={c.home} cur={c.homeCurrency} color="var(--text-3)" style={{ fontSize: 14, flex: "none" }} />
              </button>
            );
          })}
        </div>

        {/* footer: bordered secondary un-settle (NOT the orange primary) */}
        <div style={{ borderTop: "1px solid var(--hairline)", marginTop: 10, paddingTop: 14 }}>
          {/* optional reason — the log keeps it forever, so a reversal can be
              explained later. Only on this deliberate path: the per-person
              toggle in an expense is a tap, and a prompt would ruin it. */}
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="why? (optional)"
            style={{ width: "100%", height: 40, padding: "0 14px", marginBottom: 10, background: "var(--bg)", border: "1px solid var(--hairline)", borderRadius: 12, fontSize: 14, outline: "none" }}
          />
          <div className="mono" style={{ fontSize: 10.5, color: "var(--text-3)", marginBottom: 10 }}>
            returns {tickedContribs.length} share{tickedContribs.length === 1 ? "" : "s"} to balances
          </div>
          <button
            onClick={unsettle}
            disabled={!tickedContribs.length}
            style={{ width: "100%", height: 48, borderRadius: 14, background: "transparent", border: "1.5px solid var(--danger)", color: "var(--danger)", fontSize: 15, fontWeight: 600, opacity: tickedContribs.length ? 1 : 0.4 }}
          >
            {`Un-settle ${tickedContribs.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}
