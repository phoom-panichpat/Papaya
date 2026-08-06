import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { supabase } from "../lib/supabase";
import { currencySymbol, formatMoney, padIndex } from "../lib/format";
import { statusForExpense, toHome, buildAliasMap, resolveAlias, eraFor, grandTotal } from "../lib/balances";
import DualMoney from "../components/DualMoney";
import SaveError from "../components/SaveError";
import { useBackLayer } from "../lib/backstack.jsx";

function monthDay(d) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── settled indicator ─────────────────────────────────────────────────────
// Derives per-expense settled status from item members' settled_at.
function SettledPill({ status }) {
  if (!status) return null;
  const map = {
    settled: { label: "settled", color: "var(--settled)" },
    open: { label: "open", color: "var(--open)" },
  };
  const s = status.kind === "partial"
    ? { label: status.label, color: "var(--accent)" }
    : map[status.kind];
  return (
    <span className="mono" style={{ fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: s.color }}>{s.label}</span>
  );
}

export default function RecordingDetail({ recordingId, people, onAddExpense, onOpenExpense, onSettle, onEdit, onClose, onArchiveClose, refreshKey }) {
  const [rec, setRec] = useState(null);
  const [logs, setLogs] = useState([]);
  const [memberIds, setMemberIds] = useState([]);
  const [home, setHome] = useState("THB");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState(false);
  const archiving = useRef(false); // skip self-reload during archive-close so the button doesn't flip before the pop

  // Hardware back = the back chevron: plain close, no refresh.
  useBackLayer(true, () => onClose(false));

  const aliasMap = useMemo(() => buildAliasMap(people), [people]);

  const nameOf = useCallback((id) => {
    const p = (people || []).find((x) => x.id === resolveAlias(id, aliasMap));
    return p ? (p.is_self ? "You" : p.display_name) : "—";
  }, [people, aliasMap]);

  const load = useCallback(async () => {
    // 4 independent queries in parallel; only items→members must stay sequential.
    const [profRes, recRes, rmRes, expRes] = await Promise.all([
      supabase.from("profiles").select("home_currency").maybeSingle(),
      supabase.from("recordings").select("*").eq("id", recordingId).maybeSingle(),
      supabase.from("recording_members").select("person_id").eq("recording_id", recordingId),
      supabase.from("expenses").select("*").eq("recording_id", recordingId).order("created_at", { ascending: true }),
    ]);
    const expList = expRes.data || [];
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
        e.status = statusForExpense(byExp[e.id] || [], e.paid_by, nameOf);
      });
    }
    // set all state together at the end → one render, no progressive shift
    setHome(profRes.data?.home_currency || "THB");
    setRec(recRes.data);
    setMemberIds([...new Set((rmRes.data || []).map((x) => resolveAlias(x.person_id, aliasMap)))]);
    setLogs(expList);
    setLoading(false);
  }, [recordingId, nameOf, aliasMap]);

  useEffect(() => { if (archiving.current) return; load(); }, [load, refreshKey]);

  async function toggleArchive() {
    if (busy) return;
    setBusy(true);
    const { error } = await supabase.from("recordings").update({ archived_at: rec?.archived_at ? null : new Date().toISOString() }).eq("id", recordingId);
    if (error) { setBusy(false); setSaveErr(true); return; } // write failed → stay in the detail so the user can retry
    archiving.current = true; // don't self-reload on the coming refreshKey bump (would flip the button before the pop)
    onArchiveClose(); // refresh the underlying list, then pop once it's fresh (detail stays busy meanwhile)
  }

  // This record's ERA — the home currency it was created under and keeps. Every
  // log here converts to THAT currency, not to whatever home is set today, so
  // the faded second line must be labelled with it.
  const era = eraFor(rec, home);
  const eraDiffers = !loading && era !== home;
  const base = rec?.base_currency || null;
  const baseCur = base || era;
  const dual = !!base && base !== era;
  const recMap = rec ? { [rec.id]: rec } : {};
  const dateLabel = (() => {
    if (!logs.length) return "New";
    const ds = logs.map((l) => new Date(l.created_at)).sort((a, b) => a - b);
    const first = monthDay(ds[0]);
    const last = rec?.is_active ? "now" : monthDay(ds[ds.length - 1]);
    return first === last ? first : `${first} – ${last}`;
  })();

  const roster = memberIds.length ? memberIds : [];
  const allSettled = logs.length === 0 || logs.every((e) => e.status?.kind === "settled");

  return (
    <div style={{ position: "absolute", inset: 0, background: "var(--bg)", zIndex: 30, display: "flex", flexDirection: "column" }}>
      {/* header */}
      <div style={{ height: 54, flex: "none", display: "flex", alignItems: "center", padding: "0 12px", gap: 8 }}>
        <button onClick={() => onClose(false)} style={{ width: 40, height: 40, fontSize: 20, borderRadius: "50%" }}>←</button>
        <div style={{ flex: 1, textAlign: "center" }}>
          <span className="legend">Recording</span>
        </div>
        {!loading && (
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button onClick={() => onEdit(recordingId)} className="mono" style={{ height: 40, padding: "0 10px", fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-3)" }}>Edit</button>
          {(allSettled || rec?.archived_at) && (
            <button onClick={toggleArchive} disabled={busy} className="mono" style={{ height: 40, padding: "0 10px", fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: busy ? "var(--text-4)" : rec?.archived_at ? "var(--accent)" : "var(--text-3)" }}>{rec?.archived_at ? "Unarchive" : "Archive"}</button>
          )}
        </div>
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "0 0 40px" }}>
        {loading ? null : (
        <div style={{ animation: "fadeIn 160ms ease" }}>
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
          {/* a record keeps the home currency it was started in — say so when
              that isn't the one in Settings today, or its faded lines look wrong */}
          {eraDiffers && (
            <div className="mono" style={{ fontSize: 10, color: "var(--text-4)", marginTop: 6 }}>
              logs in {era} · your home currency is {home}
            </div>
          )}
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

        {/* actions — settle-up ORANGE primary (inline ~80%), add-expense square "+" */}
        <div style={{ padding: "0 24px", display: "flex", flexDirection: "row", gap: 10 }}>
          <button onClick={onSettle} style={{ flex: 1, height: 48, borderRadius: 14, background: "var(--accent)", color: "#fff", fontSize: 15, fontWeight: 600 }}>Settle up this record</button>
          <button onClick={onAddExpense} aria-label="Add expense" title="Add expense" style={{ width: 48, height: 48, flex: "none", borderRadius: 14, border: "1px solid var(--hairline)", background: "var(--surface)", fontSize: 24, fontWeight: 400, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
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
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 0", borderBottom: "1px solid var(--hairline-3)", cursor: "pointer", opacity: log.status?.kind === "settled" ? 0.5 : 1 }}
              >
                <span className="mono" style={{ fontSize: 10, color: "var(--text-4)", flex: "none" }}>{padIndex(i + 1)}</span>
                <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3, flex: 1 }}>
                  <span style={{ fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textDecoration: log.status?.kind === "settled" ? "line-through" : "none" }}>{log.title}</span>
                  <SettledPill status={log.status} />
                </span>
                <DualMoney
                  style={{ flex: "none" }}
                  primary={
                    <span style={{ display: "flex", alignItems: "baseline", gap: 2 }}>
                      <span style={{ fontSize: 12, color: "var(--text-2)" }}>{currencySymbol(log.currency || base)}</span>
                      <span className="money" style={{ fontSize: 16 }}>{formatMoney(grandTotal(log), log.currency || base)}</span>
                    </span>
                  }
                  homeAmount={dual ? toHome(grandTotal(log), log, recMap, home) : null}
                  homeCur={era}
                />
              </div>
            ))
          )}
        </div>
        </div>)}
      </div>
      {saveErr && <SaveError onDone={() => setSaveErr(false)} />}
    </div>
  );
}
