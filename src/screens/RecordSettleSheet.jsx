import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabase";
import { currencySymbol } from "../lib/format";
import {
  loadSettlementData, buildContributions, toHome,
  settleShares, unsettleShares,
} from "../lib/balances";
import DualMoney from "../components/DualMoney";

// Scoped settle for ONE record's party: direct pairwise "who owes who", each row
// backed by real item shares. Rows toggle paid/unpaid in place (fade + strike),
// no disappearing — reversibility is the misclick guard, plus an Undo toast.
export default function RecordSettleSheet({ recordingId, people, onClose }) {
  const [rec, setRec] = useState(null);
  const [home, setHome] = useState("THB");
  const [contribs, setContribs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [bump, setBump] = useState(0);
  const [confirmAll, setConfirmAll] = useState(false);

  const person = useCallback((id) => (people || []).find((x) => x.id === id), [people]);
  const nameOf = useCallback((id) => {
    const p = person(id);
    return p ? (p.is_self ? "You" : p.display_name) : "—";
  }, [person]);

  const load = useCallback(async () => {
    const { data: prof } = await supabase.from("profiles").select("home_currency").maybeSingle();
    const hc = prof?.home_currency || "THB";
    setHome(hc);
    const { data: r } = await supabase.from("recordings").select("*").eq("id", recordingId).maybeSingle();
    setRec(r);
    const data = await loadSettlementData();
    setContribs(buildContributions(data, hc));
    setLoading(false);
  }, [recordingId]);

  useEffect(() => { load(); }, [load, bump]);

  const baseCur = rec?.base_currency || home;
  const dual = !!rec?.base_currency && rec.base_currency !== home;
  const recMap = rec ? { [rec.id]: rec } : {};

  // Direct pairwise over ALL of the record's shares (settled + unsettled), so a
  // paid pair stays visible (faded) and reversible. amount = net over all shares;
  // paid = every share in the pair is settled.
  const transfers = (() => {
    const pairs = {};
    contribs.filter((c) => c.recordingId === recordingId).forEach((c) => {
      const a = c.debtor, b = c.creditor;
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      const p = (pairs[k] = pairs[k] || { sums: {}, shares: [], total: 0, settled: 0 });
      p.sums[`${a}>${b}`] = (p.sums[`${a}>${b}`] || 0) + c.base;
      p.shares.push(...c.settleKeys); // original member rows (merge-aware)
      p.total++; if (c.settled) p.settled++;
    });
    return Object.entries(pairs).map(([k, p]) => {
      const [x, y] = k.split("|");
      const net = (p.sums[`${x}>${y}`] || 0) - (p.sums[`${y}>${x}`] || 0);
      const [from, to] = net >= 0 ? [x, y] : [y, x];
      return { from, to, amount: Math.abs(net), shares: p.shares, paid: p.settled === p.total };
    }).filter((t) => t.amount > 0.005).sort((a, b) => (a.paid - b.paid) || (b.amount - a.amount));
  })();

  const anyUnpaid = transfers.some((t) => !t.paid);

  async function toggle(t) {
    if (busy) return;
    setBusy(true);
    const action = t.paid ? "open" : "settled";
    if (t.paid) await unsettleShares(t.shares);
    else await settleShares(t.shares);
    setBusy(false);
    setBump((n) => n + 1);
  }

  async function markAll() {
    if (busy) return;
    setBusy(true);
    setConfirmAll(false);
    const all = transfers.filter((t) => !t.paid).flatMap((t) => t.shares);
    await settleShares(all);
    setBusy(false);
    setBump((n) => n + 1);
  }

  return (
    <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "var(--scrim-sheet)", zIndex: 50, animation: "fadeIn 140ms ease" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "86%", background: "var(--surface)", borderTop: "1px solid var(--hairline)", borderRadius: "var(--r-sheet) var(--r-sheet) 0 0", padding: "14px 20px 20px", animation: "sheetIn 240ms var(--ease)", display: "flex", flexDirection: "column" }}>
        <div style={{ width: 36, height: 3, borderRadius: 2, background: "#DCD6C6", margin: "0 auto 14px" }} />

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <div>
            <div className="legend" style={{ color: "var(--text-3)" }}>Settle up</div>
            <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em", marginTop: 3 }}>{rec?.name || "…"}</div>
          </div>
          <span className="mono" style={{ fontSize: 10, color: "var(--text-3)" }}>who owes who · {baseCur}</span>
        </div>

        {loading ? (
          <div style={{ padding: "40px 0" }} />
        ) : transfers.length === 0 ? (
          <div style={{ padding: "40px 0 30px", textAlign: "center" }}>
            <div style={{ fontSize: 15, color: "var(--text-2)" }}>This record is settled up</div>
            <div className="mono" style={{ fontSize: 10.5, color: "var(--text-3)", marginTop: 6 }}>no outstanding balances in the party</div>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "12px 0 4px" }}>
              <span className="legend">Who pays who</span>
              <span className="mono" style={{ fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-3)" }}>tap to mark paid</span>
            </div>
            <div style={{ overflowY: "auto" }}>
              {transfers.map((t, i) => (
                <button
                  key={i}
                  onClick={() => toggle(t)}
                  disabled={busy}
                  style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "13px 2px", borderBottom: "1px solid var(--hairline-3)", textAlign: "left", opacity: t.paid ? 0.5 : 1 }}
                >
                  <span style={{ width: 22, height: 22, borderRadius: 7, border: t.paid ? "none" : "1.5px solid var(--hairline)", background: t.paid ? "var(--settled)" : "var(--bg)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, flex: "none" }}>{t.paid ? "✓" : ""}</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
                    <Face p={person(t.from)} />
                    <span className="mono" style={{ fontSize: 14, color: "var(--text-3)" }}>→</span>
                    <Face p={person(t.to)} />
                    <span style={{ fontSize: 13.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textDecoration: t.paid ? "line-through" : "none" }}>
                      <b style={{ fontWeight: 600 }}>{nameOf(t.from)}</b> pays {nameOf(t.to)}
                    </span>
                  </span>
                  <DualMoney
                    style={{ flex: "none", textDecoration: t.paid ? "line-through" : "none" }}
                    primary={<Money n={t.amount} cur={baseCur} style={{ fontSize: 15 }} />}
                    homeAmount={dual ? toHome(t.amount, { recording_id: rec?.id, currency: baseCur, exchange_rate: 1 }, recMap, home) : null}
                    homeCur={home}
                    strike={t.paid}
                  />
                </button>
              ))}
            </div>

            {anyUnpaid && (
              <div style={{ borderTop: "1px solid var(--hairline)", marginTop: 10, paddingTop: 14 }}>
                <button
                  onClick={() => setConfirmAll(true)}
                  disabled={busy}
                  style={{ width: "100%", height: 48, borderRadius: 14, background: "var(--accent)", color: "#fff", fontSize: 15, fontWeight: 600 }}
                >
                  Mark all as paid
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* mark-all confirm */}
      {confirmAll && (
        <div onClick={(e) => { e.stopPropagation(); setConfirmAll(false); }} style={{ position: "absolute", inset: 0, background: "var(--scrim)", display: "flex", alignItems: "center", justifyContent: "center", padding: 32, zIndex: 60, animation: "fadeIn 140ms ease" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: "var(--r-card)", padding: "22px 20px", width: "100%", animation: "popIn 160ms var(--ease)" }}>
            <div className="legend" style={{ color: "var(--text-2)" }}>Mark everything paid?</div>
            <div style={{ margin: "12px 0 6px", fontSize: 16, fontWeight: 600 }}>{transfers.filter((t) => !t.paid).length} {transfers.filter((t) => !t.paid).length === 1 ? "transfer" : "transfers"}</div>
            <div style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.55 }}>Clears every outstanding balance in this record. You can undo right after.</div>
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <div onClick={() => setConfirmAll(false)} style={{ flex: 1, height: 40, border: "1px solid var(--hairline)", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</div>
              <div onClick={markAll} style={{ flex: 1, height: 40, background: "var(--accent)", color: "#fff", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Mark paid</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Face({ p }) {
  return (
    <span style={{ width: 26, height: 26, borderRadius: "50%", background: p?.avatar_color || "var(--knob-off)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, flex: "none" }}>{p?.avatar_emoji || "🙂"}</span>
  );
}

// money = greyed grotesque symbol + Doto digits (global rule)
function Money({ n, cur, style = {} }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 2, ...style }}>
      <span style={{ fontSize: "0.8em", color: "var(--text-2)" }}>{currencySymbol(cur)}</span>
      <span className="money">{Math.abs(Number(n) || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>
    </span>
  );
}
