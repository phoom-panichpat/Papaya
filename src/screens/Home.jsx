import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabase";
import { seedDemo } from "../lib/seed";
import { currencySymbol, formatMoney, padIndex } from "../lib/format";

// ─── small pieces ────────────────────────────────────────────────────────────
function Amount({ value, currency }) {
  return (
    <span style={{ display: "flex", alignItems: "baseline", gap: 2, whiteSpace: "nowrap", flex: "none" }}>
      <span style={{ fontSize: 12, color: "var(--text-2)" }}>{currencySymbol(currency)}</span>
      <span className="money" style={{ fontSize: 16.5 }}>{formatMoney(value, currency)}</span>
    </span>
  );
}

function RecToggle({ live, onClick }) {
  return (
    <span
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", width: 48, height: 27,
        border: "1px solid var(--hairline)", borderRadius: "var(--r-toggle)",
        background: "var(--bg)", padding: "0 3px", cursor: "pointer", flex: "none",
      }}
    >
      <span style={{
        width: 20, height: 20, borderRadius: "50%",
        background: live ? "var(--accent)" : "var(--knob-off)",
        transform: `translateX(${live ? 20 : 0}px)`,
        transition: "transform 170ms var(--ease), background 170ms ease",
      }} />
    </span>
  );
}

function Accordion({ open, children }) {
  return (
    <div style={{ display: "grid", gridTemplateRows: open ? "1fr" : "0fr", transition: "grid-template-rows 260ms var(--ease)" }}>
      <div style={{ overflow: "hidden", minHeight: 0 }}>{children}</div>
    </div>
  );
}

// ─── recording card ──────────────────────────────────────────────────────────
function RecordingCard({ rec, expanded, onHeader, onToggle, onLogTap, onOpen }) {
  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: "var(--r-card)", flex: "none", overflow: "hidden" }}>
      <div
        onClick={onHeader}
        style={{ cursor: "pointer", height: 66, padding: "0 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
          {rec.is_active && (
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)", flex: "none", animation: "pulse 2.4s 300ms infinite" }} />
          )}
          <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{rec.name}</span>
          <span className="mono" style={{ fontSize: 10, color: "var(--text-4)", flex: "none" }}>{padIndex(rec.logs.length)}</span>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 9, flex: "none" }}>
          <span className="legend">Rec</span>
          <RecToggle live={rec.is_active} onClick={(e) => { e.stopPropagation(); onToggle(); }} />
        </span>
      </div>
      <Accordion open={expanded}>
        <div style={{ padding: "0 18px 14px 18px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0 6px 0" }}>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>{rec.dateLabel}</span>
            <span style={{ flex: 1 }} />
            <span
              onClick={(e) => { e.stopPropagation(); onOpen(); }}
              className="mono"
              style={{ fontSize: 9.5, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text)", cursor: "pointer", borderBottom: "1px solid #C9C3B3", paddingBottom: 1 }}
            >
              Open recording →
            </span>
          </div>
          {rec.logs.map((log, i) => (
            <div
              key={log.id}
              onClick={() => onLogTap(log)}
              style={{ display: "flex", alignItems: "center", gap: 10, height: 44, cursor: "pointer", borderRadius: 8, opacity: log.settled ? 0.5 : 1 }}
            >
              <span className="mono" style={{ fontSize: 10, color: "var(--text-4)", flex: "none" }}>{padIndex(i + 1)}</span>
              <span style={{ fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textDecoration: log.settled ? "line-through" : "none", color: log.settled ? "var(--text-3)" : "var(--text)" }}>{log.title}</span>
              <span style={{ flex: 1, borderTop: "1px solid var(--hairline-3)", minWidth: 12, marginTop: 2 }} />
              <Amount value={log.total_amount} currency={log.currency || rec.base_currency} />
            </div>
          ))}
        </div>
      </Accordion>
    </div>
  );
}

// ─── loose expense row ───────────────────────────────────────────────────────
function LooseRow({ exp, expanded, onHeader, onDetail, onArchive }) {
  const canArchive = exp.settled || exp.archived_at;
  return (
    <div style={{ flex: "none" }}>
      <div
        onClick={onHeader}
        style={{ display: "flex", alignItems: "center", gap: 12, height: 44, padding: "0 10px", cursor: "pointer", borderRadius: 10, opacity: exp.settled ? 0.5 : 1 }}
      >
        <span style={{ fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textDecoration: exp.settled ? "line-through" : "none", color: exp.settled ? "var(--text-3)" : "var(--text)" }}>{exp.title}</span>
        <span style={{ flex: 1, borderTop: "1px solid var(--hairline-2)", minWidth: 16, marginTop: 2 }} />
        <Amount value={exp.total_amount} currency={exp.currency} />
      </div>
      <Accordion open={expanded}>
        <div style={{ padding: "6px 10px 10px 10px", display: "flex", alignItems: "center", gap: 16 }}>
          <span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>{exp.metaLabel}</span>
          <span
            onClick={(e) => { e.stopPropagation(); onDetail(); }}
            className="mono"
            style={{ fontSize: 9.5, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text)", cursor: "pointer", borderBottom: "1px solid #C9C3B3", paddingBottom: 1 }}
          >
            Open detail →
          </span>
          {canArchive && (
            <span
              onClick={(e) => { e.stopPropagation(); onArchive(); }}
              className="mono"
              style={{ fontSize: 9.5, letterSpacing: "0.12em", textTransform: "uppercase", color: exp.archived_at ? "var(--accent)" : "var(--text-3)", cursor: "pointer", borderBottom: "1px solid #C9C3B3", paddingBottom: 1 }}
            >
              {exp.archived_at ? "Unarchive" : "Archive"}
            </span>
          )}
        </div>
      </Accordion>
    </div>
  );
}

// ─── date range helper (derived from logs) ───────────────────────────────────
function monthDay(d) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function recDateLabel(rec) {
  if (!rec.logs.length) return "New";
  const ds = rec.logs.map((l) => new Date(l.created_at)).sort((a, b) => a - b);
  const first = monthDay(ds[0]);
  const last = rec.is_active ? "now" : monthDay(ds[ds.length - 1]);
  return first === last ? first : `${first} – ${last}`;
}

// ─── Home screen (merged feed: recordings + loose, search, new recording) ─────
export default function Home({ people, onNewExpense, onOpenExpense, onOpenRecording, onNewRecording, onOpenSettings, refreshKey, onLoaded }) {
  const [feed, setFeed] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    const [{ data: recs }, { data: exps }, { data: ims }] = await Promise.all([
      supabase.from("recordings").select("*").order("created_at", { ascending: false }),
      supabase.from("expenses").select("*").order("created_at", { ascending: true }),
      supabase.from("expense_item_members").select("item_id, person_id, settled_at"),
    ]);
    // settled map: an expense is "settled" when every ower's share is settled
    const { data: its } = await supabase.from("expense_items").select("id, expense_id");
    const itemToExp = Object.fromEntries((its || []).map((i) => [i.id, i.expense_id]));
    const byExp = {};
    (ims || []).forEach((m) => { const eid = itemToExp[m.item_id]; if (eid) (byExp[eid] = byExp[eid] || []).push(m); });
    const isSettled = (e) => {
      const rows = byExp[e.id] || [];
      const owers = [...new Set(rows.map((r) => r.person_id))].filter((pid) => pid !== e.paid_by);
      if (!owers.length) return false; // nothing to settle → treat as open (not "done")
      return owers.every((pid) => rows.filter((r) => r.person_id === pid).every((r) => r.settled_at));
    };

    const payerName = (id) => {
      const p = (people || []).find((x) => x.id === id);
      return p ? (p.is_self ? "You" : p.display_name) : "—";
    };

    const recordings = (recs || [])
      .filter((r) => !r.archived_at) // archived records live in Settlement → History
      .map((r) => {
        const logs = (exps || []).filter((e) => e.recording_id === r.id).map((e) => ({ ...e, settled: isSettled(e) }));
        const rec = { ...r, logs };
        rec.dateLabel = recDateLabel(rec);
        return rec;
      });
    const loose = (exps || [])
      .filter((e) => !e.recording_id && !e.archived_at) // archived loose live in Settlement → History
      .map((e) => ({ ...e, isExp: true, settled: isSettled(e), metaLabel: `paid by ${payerName(e.paid_by)} · ${monthDay(e.created_at)}` }));

    const items = [...recordings.map((r) => ({ ...r, isRec: true, sortAt: r.created_at })), ...loose.map((e) => ({ ...e, sortAt: e.created_at }))]
      .sort((a, b) => new Date(b.sortAt) - new Date(a.sortAt));

    setFeed(items);
    setLoading(false);
    setExpanded((cur) => cur ?? (recordings.find((r) => r.is_active)?.id || null));
    onLoaded?.(); // tell App this screen is fresh (used to defer an archive pop)
  }, [people, onLoaded]);

  useEffect(() => { load(); }, [load, refreshKey]);

  async function setLive(recId, makeLive) {
    setBusy(true);
    if (makeLive) {
      await supabase.from("recordings").update({ is_active: false }).neq("id", recId);
      await supabase.from("recordings").update({ is_active: true }).eq("id", recId);
    } else {
      await supabase.from("recordings").update({ is_active: false }).eq("id", recId);
    }
    await load();
    setBusy(false);
  }

  function onToggle(rec) {
    if (busy) return;
    const currentLive = feed.find((f) => f.isRec && f.is_active);
    if (rec.is_active) return setLive(rec.id, false);
    if (currentLive) { setConfirm({ fromName: currentLive.name, toId: rec.id, toName: rec.name }); return; }
    setLive(rec.id, true);
    setExpanded(rec.id);
  }

  async function doSeed() {
    setBusy(true);
    await seedDemo();
    await load();
    setBusy(false);
  }

  const live = feed.find((f) => f.isRec && f.is_active);
  const query = q.trim().toLowerCase();
  const shown = query
    ? feed.filter((f) => (f.isRec ? f.name : f.title || "").toLowerCase().includes(query))
    : feed;

  const gear = (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-2)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", position: "relative", background: "var(--bg)" }}>
      {/* header */}
      <div style={{ padding: "26px 24px 14px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", flex: "none" }}>
        <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.01em" }}>Papaya</div>
        <div onClick={onOpenSettings} style={{ width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", borderRadius: "50%" }}>{gear}</div>
      </div>

      {/* recording bar (D/b) — which record is live, pinned under the header */}
      <div
        onClick={() => live && onOpenRecording(live.id)}
        style={{ margin: "0 20px", height: 42, flex: "none", display: "flex", alignItems: "center", gap: 10, padding: "0 14px", borderRadius: 12, border: "1px solid var(--hairline)", background: live ? "var(--surface)" : "transparent", cursor: live ? "pointer" : "default" }}
      >
        {live ? (
          <>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent)", boxShadow: "0 0 0 3px rgba(232,98,42,0.18)", animation: "pulse 2.4s 300ms infinite", flex: "none" }} />
            <span className="mono" style={{ fontSize: 9.5, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--accent)", flex: "none" }}>Rec</span>
            <span style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{live.name}</span>
            <span style={{ flex: 1 }} />
            <span className="mono" style={{ fontSize: 12, color: "var(--text-4)", flex: "none" }}>›</span>
          </>
        ) : (
          <span className="mono" style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-4)" }}>No live recording · flip a REC toggle</span>
        )}
      </div>

      {/* search + new recording */}
      <div style={{ padding: "12px 20px 12px", flex: "none", display: "flex", gap: 10, alignItems: "center" }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" style={{ flex: 1, height: 38, padding: "0 14px", background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: 12, fontSize: 15, outline: "none" }} />
        <button onClick={onNewRecording} className="mono" style={{ fontSize: 10.5, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text)", border: "1px solid #C9C4B7", borderRadius: 12, padding: "0 12px", height: 38, background: "var(--bg)", flex: "none" }}>+ Rec</button>
      </div>

      {/* feed */}
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 20px 120px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
        {loading ? null : feed.length === 0 ? (
          <div style={{ textAlign: "center", padding: "60px 0", color: "var(--text-2)" }}>
            <p style={{ fontSize: 15 }}>Nothing here yet</p>
            <button onClick={doSeed} disabled={busy} className="mono" style={{ marginTop: 16, fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text)", border: "1px solid #C9C4B7", borderRadius: 18, padding: "9px 16px", background: "var(--bg)" }}>
              {busy ? "…" : "add demo data"}
            </button>
          </div>
        ) : shown.length === 0 ? (
          <div style={{ textAlign: "center", padding: "50px 0", color: "var(--text-3)", fontSize: 14 }}>Nothing matches.</div>
        ) : (
          shown.map((item) =>
            item.isRec ? (
              <RecordingCard
                key={item.id}
                rec={item}
                expanded={expanded === item.id}
                onHeader={() => setExpanded(expanded === item.id ? null : item.id)}
                onToggle={() => onToggle(item)}
                onLogTap={(log) => onOpenExpense(log.id)}
                onOpen={() => onOpenRecording(item.id)}
              />
            ) : (
              <LooseRow
                key={item.id}
                exp={item}
                expanded={expanded === item.id}
                onHeader={() => setExpanded(expanded === item.id ? null : item.id)}
                onDetail={() => onOpenExpense(item.id)}
                onArchive={async () => {
                  await supabase.from("expenses").update({ archived_at: item.archived_at ? null : new Date().toISOString() }).eq("id", item.id);
                  load();
                }}
              />
            )
          )
        )}
      </div>

      {/* FAB */}
      <div
        onClick={onNewExpense}
        style={{ position: "absolute", right: 20, bottom: 24, width: 56, height: 56, borderRadius: "50%", background: "var(--text)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", zIndex: 5 }}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="var(--bg)" strokeWidth="1.8" strokeLinecap="round"><path d="M10 3.5v13M3.5 10h13" /></svg>
      </div>

      {/* switch-confirm dialog */}
      {confirm && (
        <div onClick={() => setConfirm(null)} style={{ position: "absolute", inset: 0, background: "var(--scrim)", display: "flex", alignItems: "center", justifyContent: "center", padding: 32, zIndex: 20, animation: "fadeIn 140ms ease" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: "var(--r-card)", padding: "22px 20px", width: "100%", animation: "popIn 160ms var(--ease)" }}>
            <div className="legend" style={{ color: "var(--text-2)" }}>Switch live session?</div>
            <div style={{ margin: "12px 0 6px 0", fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>{confirm.fromName} → {confirm.toName}</div>
            <div style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.55 }}>New expenses will start filing into {confirm.toName}.</div>
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <div onClick={() => setConfirm(null)} style={{ flex: 1, height: 40, border: "1px solid var(--hairline)", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</div>
              <div onClick={() => { const id = confirm.toId; setConfirm(null); setLive(id, true); setExpanded(id); }} style={{ flex: 1, height: 40, background: "var(--accent)", color: "#FFF", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Switch</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
