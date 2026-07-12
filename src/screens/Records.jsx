import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabase";
import { currencySymbol, formatMoney, padIndex } from "../lib/format";

function monthDay(d) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function recDateLabel(rec, logs) {
  if (!logs.length) return "New";
  const ds = logs.map((l) => new Date(l.created_at)).sort((a, b) => a - b);
  const first = monthDay(ds[0]);
  const last = rec.is_active ? "now" : monthDay(ds[ds.length - 1]);
  return first === last ? first : `${first} – ${last}`;
}

function Amount({ value, currency }) {
  return (
    <span style={{ display: "flex", alignItems: "baseline", gap: 2, whiteSpace: "nowrap", flex: "none" }}>
      <span style={{ fontSize: 12, color: "var(--text-2)" }}>{currencySymbol(currency)}</span>
      <span className="money" style={{ fontSize: 16 }}>{formatMoney(value, currency)}</span>
    </span>
  );
}

export default function Records({ people, refreshKey, onOpenRecording, onNewRecording, onOpenExpense }) {
  const [view, setView] = useState("recordings"); // "recordings" | "loose"
  const [q, setQ] = useState("");
  const [recordings, setRecordings] = useState([]);
  const [loose, setLoose] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [{ data: recs }, { data: exps }] = await Promise.all([
      supabase.from("recordings").select("*").order("created_at", { ascending: false }),
      supabase.from("expenses").select("*").order("created_at", { ascending: false }),
    ]);
    const payerName = (id) => {
      const p = (people || []).find((x) => x.id === id);
      return p ? (p.is_self ? "You" : p.display_name) : "—";
    };
    setRecordings((recs || []).map((r) => {
      const logs = (exps || []).filter((e) => e.recording_id === r.id);
      return { ...r, logs, dateLabel: recDateLabel(r, logs) };
    }));
    setLoose((exps || [])
      .filter((e) => !e.recording_id)
      .map((e) => ({ ...e, metaLabel: `paid by ${payerName(e.paid_by)} · ${monthDay(e.created_at)}` })));
    setLoading(false);
  }, [people]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const query = q.trim().toLowerCase();
  const recShown = query ? recordings.filter((r) => r.name.toLowerCase().includes(query)) : recordings;
  const looseShown = query ? loose.filter((e) => (e.title || "").toLowerCase().includes(query)) : loose;

  const seg = (id, label, count) => {
    const active = view === id;
    return (
      <button
        onClick={() => setView(id)}
        style={{ flex: 1, height: 34, borderRadius: 9, background: active ? "var(--surface)" : "transparent", border: active ? "1px solid var(--hairline)" : "1px solid transparent", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 13.5, fontWeight: active ? 600 : 500, color: active ? "var(--text)" : "var(--text-3)" }}
      >
        {label}
        <span className="mono" style={{ fontSize: 10, color: "var(--text-4)" }}>{count}</span>
      </button>
    );
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      {/* header */}
      <div style={{ padding: "26px 24px 14px", borderBottom: "1px solid var(--hairline)", flex: "none", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.01em" }}>Records</div>
        <button onClick={onNewRecording} className="mono" style={{ fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text)", border: "1px solid #C9C4B7", borderRadius: 18, padding: "8px 13px", background: "var(--bg)" }}>+ New recording</button>
      </div>

      {/* search + segmented */}
      <div style={{ padding: "14px 20px 12px", borderBottom: "1px solid var(--hairline)", flex: "none", display: "flex", flexDirection: "column", gap: 12 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search records"
          style={{ height: 40, padding: "0 14px", background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: 12, fontSize: 15, outline: "none" }}
        />
        <div style={{ display: "flex", gap: 4, background: "var(--bg)", border: "1px solid var(--hairline)", borderRadius: 12, padding: 3 }}>
          {seg("recordings", "Recordings", padIndex(recordings.length))}
          {seg("loose", "Loose", padIndex(loose.length))}
        </div>
      </div>

      {/* list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px 120px" }}>
        {loading ? null : view === "recordings" ? (
          recShown.length === 0 ? (
            <Empty text={query ? "No recordings match." : "No recordings yet."} />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {recShown.map((r) => (
                <div
                  key={r.id}
                  onClick={() => onOpenRecording(r.id)}
                  style={{ background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: "var(--r-card)", padding: "16px 18px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}
                >
                  <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {r.is_active && <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)", flex: "none" }} />}
                      <span style={{ fontSize: 16.5, fontWeight: 600, letterSpacing: "-0.01em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
                    </span>
                    <span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>{r.dateLabel} · {padIndex(r.logs.length)} logs{r.base_currency ? ` · ${r.base_currency}` : ""}</span>
                  </span>
                  <span className="mono" style={{ fontSize: 12, color: "var(--text-4)", flex: "none" }}>›</span>
                </div>
              ))}
            </div>
          )
        ) : looseShown.length === 0 ? (
          <Empty text={query ? "No loose expenses match." : "No loose expenses."} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {looseShown.map((e) => (
              <div
                key={e.id}
                onClick={() => onOpenExpense(e.id)}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 4px", borderBottom: "1px solid var(--hairline-3)", cursor: "pointer" }}
              >
                <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3, flex: 1 }}>
                  <span style={{ fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.title}</span>
                  <span className="mono" style={{ fontSize: 10, color: "var(--text-4)" }}>{e.metaLabel}</span>
                </span>
                <Amount value={e.total_amount} currency={e.currency} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Empty({ text }) {
  return <div style={{ textAlign: "center", padding: "60px 0", color: "var(--text-3)", fontSize: 14 }}>{text}</div>;
}
