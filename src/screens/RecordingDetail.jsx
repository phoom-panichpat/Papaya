import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabase";
import { currencySymbol, formatMoney, padIndex } from "../lib/format";

function monthDay(d) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── settled indicator ─────────────────────────────────────────────────────
// Derives per-expense settled status from item members' settled_at.
function SettledPill({ status }) {
  if (!status) return null;
  const map = {
    settled: { label: "settled", color: "var(--settled, #4E7A55)" },
    open: { label: "open", color: "var(--text-3)" },
  };
  const s = status.kind === "partial"
    ? { label: status.label, color: "var(--accent)" }
    : map[status.kind];
  return (
    <span className="mono" style={{ fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: s.color }}>{s.label}</span>
  );
}

export default function RecordingDetail({ recordingId, people, onAddExpense, onOpenExpense, onSettle, onClose, refreshKey }) {
  const [rec, setRec] = useState(null);
  const [logs, setLogs] = useState([]);
  const [memberIds, setMemberIds] = useState([]);
  const [loading, setLoading] = useState(true);

  const nameOf = useCallback((id) => {
    const p = (people || []).find((x) => x.id === id);
    return p ? (p.is_self ? "You" : p.display_name) : "—";
  }, [people]);

  const load = useCallback(async () => {
    const { data: r } = await supabase.from("recordings").select("*").eq("id", recordingId).maybeSingle();
    setRec(r);
    const { data: rm } = await supabase.from("recording_members").select("person_id").eq("recording_id", recordingId);
    setMemberIds((rm || []).map((x) => x.person_id));
    const { data: exps } = await supabase.from("expenses").select("*").eq("recording_id", recordingId).order("created_at", { ascending: true });
    const expList = exps || [];
    if (expList.length) {
      const ids = expList.map((e) => e.id);
      const { data: its } = await supabase.from("expense_items").select("id, expense_id").in("expense_id", ids);
      const itemIds = (its || []).map((i) => i.id);
      const { data: ims } = itemIds.length
        ? await supabase.from("expense_item_members").select("item_id, person_id, settled_at").in("item_id", itemIds)
        : { data: [] };
      const itemToExp = Object.fromEntries((its || []).map((i) => [i.id, i.expense_id]));
      // group member rows by expense
      const byExp = {};
      (ims || []).forEach((m) => {
        const eid = itemToExp[m.item_id];
        (byExp[eid] = byExp[eid] || []).push(m);
      });
      expList.forEach((e) => {
        const rows = byExp[e.id] || [];
        // owers = distinct persons who aren't the payer
        const owers = [...new Set(rows.map((r2) => r2.person_id))].filter((pid) => pid !== e.paid_by);
        if (!owers.length) { e.status = { kind: "settled" }; return; }
        const settledOf = (pid) => rows.filter((r2) => r2.person_id === pid).every((r2) => r2.settled_at);
        const settled = owers.filter(settledOf);
        if (settled.length === owers.length) e.status = { kind: "settled" };
        else if (settled.length === 0) e.status = { kind: "open" };
        else {
          const open = owers.filter((pid) => !settledOf(pid));
          const firstOpen = nameOf(open[0]);
          e.status = { kind: "partial", label: `${settled.length} of ${owers.length} · ${firstOpen} open` };
        }
      });
    }
    setLogs(expList);
    setLoading(false);
  }, [recordingId, nameOf]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const base = rec?.base_currency || null;
  const dateLabel = (() => {
    if (!logs.length) return "New";
    const ds = logs.map((l) => new Date(l.created_at)).sort((a, b) => a - b);
    const first = monthDay(ds[0]);
    const last = rec?.is_active ? "now" : monthDay(ds[ds.length - 1]);
    return first === last ? first : `${first} – ${last}`;
  })();

  const roster = memberIds.length ? memberIds : [];

  return (
    <div style={{ position: "absolute", inset: 0, background: "var(--bg)", zIndex: 30, display: "flex", flexDirection: "column" }}>
      {/* header */}
      <div style={{ height: 54, flex: "none", display: "flex", alignItems: "center", padding: "0 12px", gap: 8 }}>
        <button onClick={onClose} style={{ width: 40, height: 40, fontSize: 20, borderRadius: "50%" }}>←</button>
        <div style={{ flex: 1, textAlign: "center" }}>
          <span className="legend">Recording</span>
        </div>
        <div style={{ width: 40 }} />
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "0 0 40px" }}>
        {/* title block */}
        <div style={{ padding: "8px 24px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            {rec?.is_active && <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent)", flex: "none", animation: "pulse 2.4s 300ms infinite" }} />}
            <h1 style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em" }}>{rec?.name || "…"}</h1>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>{dateLabel}</span>
            <span style={{ color: "#C6C0B1", fontSize: 10 }}>·</span>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>{padIndex(logs.length)} logs</span>
            {base && <><span style={{ color: "#C6C0B1", fontSize: 10 }}>·</span><span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>{base}</span></>}
          </div>
        </div>

        {/* party roster */}
        {roster.length > 0 && (
          <div style={{ padding: "0 24px 20px" }}>
            <div className="legend" style={{ marginBottom: 10 }}>Who's in</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
              {roster.map((id) => {
                const p = (people || []).find((x) => x.id === id);
                return (
                  <div key={id} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5, width: 52 }}>
                    <span style={{ width: 40, height: 40, borderRadius: "50%", background: p?.avatar_color || "var(--knob-off)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>{p?.avatar_emoji || "🙂"}</span>
                    <span style={{ fontSize: 11, color: "var(--text-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 52 }}>{p?.is_self ? "You" : p?.display_name || "—"}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* actions — settle-up ORANGE primary, add-expense secondary */}
        <div style={{ padding: "0 24px", display: "flex", flexDirection: "column", gap: 10 }}>
          <button onClick={onSettle} style={{ height: 48, borderRadius: 14, background: "var(--accent)", color: "#fff", fontSize: 15, fontWeight: 600 }}>Settle up this record</button>
          <button onClick={onAddExpense} style={{ height: 48, borderRadius: 14, border: "1px solid var(--hairline)", background: "var(--surface)", fontSize: 15, fontWeight: 500 }}>+ Add expense</button>
        </div>

        {/* logs */}
        <div style={{ padding: "24px 24px 0" }}>
          <div className="legend" style={{ marginBottom: 6 }}>Expenses</div>
          {loading ? null : logs.length === 0 ? (
            <div style={{ padding: "24px 0", color: "var(--text-3)", fontSize: 14 }}>No expenses yet.</div>
          ) : (
            logs.map((log, i) => (
              <div
                key={log.id}
                onClick={() => onOpenExpense(log.id)}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 0", borderBottom: "1px solid var(--hairline-3)", cursor: "pointer" }}
              >
                <span className="mono" style={{ fontSize: 10, color: "var(--text-4)", flex: "none" }}>{padIndex(i + 1)}</span>
                <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3, flex: 1 }}>
                  <span style={{ fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{log.title}</span>
                  <SettledPill status={log.status} />
                </span>
                <span style={{ display: "flex", alignItems: "baseline", gap: 2, flex: "none" }}>
                  <span style={{ fontSize: 12, color: "var(--text-2)" }}>{currencySymbol(log.currency || base)}</span>
                  <span className="money" style={{ fontSize: 16 }}>{formatMoney(log.total_amount, log.currency || base)}</span>
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
