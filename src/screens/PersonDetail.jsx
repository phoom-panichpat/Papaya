import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabase";
import { currencySymbol, padIndex } from "../lib/format";
import { loadSettlementData, buildContributions, pairNetByEra, sumHomeByEra, buildAliasMap, resolveAlias, unmergePerson } from "../lib/balances";
import { EditSheet } from "./People";
import { useBackLayer } from "../lib/backstack.jsx";

function relTime(iso) {
  const d = new Date(iso), now = new Date();
  const s = (now - d) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  if (s < 604800) return `${Math.floor(s/86400)}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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

// Read-only person overview: net balance, recordings they're in, settled history.
// Settling/un-settling stays in Settlement / ExpenseDetail — not here.
export default function PersonDetail({ personId, people, onClose, onOpenExpense, onOpenRecording, refreshKey, onChanged }) {
  const [home, setHome] = useState("THB");
  const [data, setData] = useState(null);
  const [contribs, setContribs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [unmergeSheet, setUnmergeSheet] = useState(false);
  const [busyId, setBusyId] = useState(null);

  // Hardware back, innermost first.
  useBackLayer(true, () => onClose(false));
  useBackLayer(editing, () => setEditing(false));
  useBackLayer(unmergeSheet, () => setUnmergeSheet(false));

  const self = (people || []).find((p) => p.is_self);
  const person = useCallback((id) => (people || []).find((x) => x.id === id), [people]);
  const nameOf = useCallback((id) => {
    const p = person(id);
    return p ? (p.is_self ? "You" : p.display_name) : "—";
  }, [person]);
  const me = person(personId);

  // people merged INTO this person (their alias resolves here) — drives the Unmerge sheet
  const aliasMap = (people || []).length ? buildAliasMap(people) : {};
  const mergedIn = (people || []).filter((p) => p.id !== personId && resolveAlias(p.id, aliasMap) === personId);

  // close the unmerge sheet once the last merged-in person is popped back out
  useEffect(() => {
    if (unmergeSheet && mergedIn.length === 0) setUnmergeSheet(false);
  }, [unmergeSheet, mergedIn.length]);

  const load = useCallback(async () => {
    const { data: prof } = await supabase.from("profiles").select("home_currency").maybeSingle();
    const h = prof?.home_currency || "THB";
    setHome(h);
    const d = await loadSettlementData();
    setData(d);
    setContribs(buildContributions(d, h));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  // net between self and this person (positive = they owe you)
  // grouped PER ERA, same rule as the Settlement tab: home amounts pinned to
  // different home currencies are different units and are never added together
  const byEra = self ? pairNetByEra(contribs, self.id, personId) : [];
  const single = byEra.length === 1;
  const settledUp = byEra.length === 0;
  const theyOwe = single && byEra[0].net > 0;
  const youOwe = single && byEra[0].net < 0;

  // recordings this person appears in (payer or member) — any contrib in their pair with a recordingId
  const inRecordings = (() => {
    if (!data) return [];
    const ids = new Set();
    for (const c of contribs) {
      if (!c.recordingId) continue;
      if (c.creditor === personId || c.debtor === personId) ids.add(c.recordingId);
    }
    return [...ids]
      .map((id) => (data.recordings || []).find((r) => r.id === id))
      .filter(Boolean)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  })();

  // settled history between self and this person, grouped by settle event
  const settledEvents = (() => {
    if (!self) return [];
    const groups = {};
    for (const c of contribs) {
      if (!c.settled || !c.settledAt) continue;
      const inPair = (c.debtor === self.id && c.creditor === personId) || (c.debtor === personId && c.creditor === self.id);
      if (!inPair) continue;
      const key = `${c.settledAt}::${c.creditor}::${c.debtor}`;
      const g = groups[key] || (groups[key] = { settledAt: c.settledAt, creditor: c.creditor, debtor: c.debtor, contribs: [] });
      g.contribs.push(c);
    }
    return Object.values(groups)
      .map((g) => ({ ...g, byEra: sumHomeByEra(g.contribs) })) // totals per era, never summed across
      .sort((a, b) => new Date(b.settledAt) - new Date(a.settledAt));
  })();

  // refCount: how many expense rows reference this person (payer or member) — gates removal
  const refCount = (() => {
    if (!data) return 0;
    const asPayer = (data.expenses || []).filter((e) => e.paid_by === personId).length;
    const asMember = (data.members || []).filter((m) => m.person_id === personId).length;
    return asPayer + asMember;
  })();

  async function rename(name, emoji) {
    await supabase.from("people").update({ display_name: name, avatar_emoji: emoji }).eq("id", personId);
    setEditing(false);
    // The name/emoji we render come from the `people` PROP, not from load()'s
    // settlement data — so a local load() can't show the new name. Only App owns
    // the roster: onChanged reloads it (and bumps refreshKey, which re-runs load
    // for us). Same call unmerge() below already makes.
    onChanged?.();
  }
  async function remove() {
    await supabase.from("people").delete().eq("id", personId);
    onClose(true);
  }
  async function unmerge(pId) {
    setBusyId(pId);
    await unmergePerson(pId);
    onChanged?.();
    await load();
    setBusyId(null);
  }

  const iconBtn = { width: 38, height: 38, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13 };

  return (
    <div style={{ position: "absolute", inset: 0, background: "var(--bg)", zIndex: 40, display: "flex", flexDirection: "column" }}>
      {/* header */}
      <div style={{ height: 54, flex: "none", display: "flex", alignItems: "center", padding: "0 12px", gap: 4 }}>
        <button onClick={() => onClose(false)} style={{ width: 40, height: 40, fontSize: 20, borderRadius: "50%" }}>←</button>
        <div style={{ flex: 1, textAlign: "center" }}><span className="legend">Person</span></div>
        {mergedIn.length > 0 && (
          <button onClick={() => setUnmergeSheet(true)} className="mono" style={{ ...iconBtn, width: "auto", padding: "0 12px", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-3)" }}>Unmerge</button>
        )}
        <button onClick={() => setEditing(true)} className="mono" style={{ ...iconBtn, width: "auto", padding: "0 12px", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-3)" }}>Edit</button>
      </div>

      {loading || !me ? (
        <div style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--text-3)", fontSize: 14 }}>{loading ? "" : "Not found."}</div>
      ) : (
        <div style={{ flex: 1, overflowY: "auto", padding: "0 0 40px" }}>
          {/* title block */}
          <div style={{ padding: "8px 24px 20px", display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ width: 52, height: 52, borderRadius: "50%", background: me.avatar_color || "var(--knob-off)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, flex: "none" }}>{me.avatar_emoji || "🙂"}</span>
            <h1 style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em" }}>{me.display_name}</h1>
          </div>

          {/* amount summary */}
          <div style={{ padding: "0 24px 20px" }}>
            <div style={{ background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: "var(--r-card)", padding: "16px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span className="mono" style={{ fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: theyOwe ? "var(--settled)" : youOwe ? "var(--open)" : "var(--text-3)" }}>
                  {theyOwe ? "owes you" : youOwe ? "you owe" : "balance"}
                </span>
                <span style={{ fontSize: 15, fontWeight: 600 }}>
                  {settledUp ? "All settled up" : theyOwe ? `${me.display_name} owes you` : youOwe ? `You owe ${me.display_name}` : "Open balance"}
                </span>
              </span>
              {settledUp ? (
                <Money n={0} cur={home} color="var(--text-3)" style={{ fontSize: 22, flex: "none" }} />
              ) : (
                <span style={{ flex: "none", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                  {byEra.map((e) => (
                    <span key={e.currency} style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
                      {!single && (
                        <span className="mono" style={{ fontSize: 8.5, letterSpacing: "0.06em", textTransform: "uppercase", color: e.net > 0 ? "var(--settled)" : "var(--open)" }}>
                          {e.net > 0 ? "owes you" : "you owe"}
                        </span>
                      )}
                      <Money n={e.net} cur={e.currency} color={e.net > 0 ? "var(--settled)" : "var(--open)"} style={{ fontSize: single ? 22 : 16 }} />
                    </span>
                  ))}
                </span>
              )}
            </div>
          </div>

          {/* in recordings */}
          <div style={{ padding: "6px 24px 0" }}>
            <div className="legend" style={{ marginBottom: 10 }}>In recordings</div>
            {inRecordings.length === 0 ? (
              <div style={{ color: "var(--text-3)", fontSize: 14, padding: "4px 0 18px" }}>No recordings yet.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 18 }}>
                {inRecordings.map((r) => (
                  <button key={r.id} onClick={() => onOpenRecording(r.id)} style={{ width: "100%", background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: "var(--r-card)", padding: "13px 16px", textAlign: "left", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <span style={{ fontSize: 15, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
                    <span className="mono" style={{ fontSize: 10, color: "var(--text-3)", flex: "none" }}>{r.base_currency || home}{r.archived_at ? " · archived" : ""}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* settled with */}
          <div style={{ padding: "6px 24px 0" }}>
            <div className="legend" style={{ marginBottom: 10 }}>Settled with {me.display_name}</div>
            {settledEvents.length === 0 ? (
              <div style={{ color: "var(--text-3)", fontSize: 14, padding: "4px 0 18px" }}>Nothing settled yet.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {settledEvents.map((ev, i) => {
                  const theyPaidYou = ev.creditor === self.id;
                  const youPaid = ev.debtor === self.id;
                  const label = theyPaidYou
                    ? `${me.display_name} paid you`
                    : youPaid
                      ? `You paid ${me.display_name}`
                      : `${nameOf(ev.debtor)} paid ${nameOf(ev.creditor)}`;
                  return (
                    <div key={`${ev.settledAt}::${ev.creditor}::${ev.debtor}::${i}`} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 2px", borderBottom: "1px solid var(--hairline-3)" }}>
                      <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          <span className="mono" style={{ fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--settled)" }}>✓</span>
                          {label}
                        </span>
                        <span className="mono" style={{ fontSize: 9.5, color: "var(--text-3)" }}>{relTime(ev.settledAt)} · {ev.contribs.length} share{ev.contribs.length === 1 ? "" : "s"}</span>
                      </span>
                      <span style={{ flex: "none", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                        {ev.byEra.map((e) => (
                          <Money key={e.currency} n={e.amount} cur={e.currency} color="var(--text-3)" style={{ fontSize: 14 }} />
                        ))}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* edit sheet (reused from People) */}
      {editing && me && (
        <EditSheet
          title="Edit person"
          person={me}
          refCount={refCount}
          onSave={rename}
          onRemove={remove}
          onClose={() => setEditing(false)}
        />
      )}

      {/* unmerge sheet — lists people merged into this person */}
      {unmergeSheet && me && (
        <div onClick={() => setUnmergeSheet(false)} style={{ position: "absolute", inset: 0, background: "var(--scrim-sheet)", zIndex: 50, animation: "fadeIn 140ms ease" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "80%", overflowY: "auto", background: "var(--surface)", borderTop: "1px solid var(--hairline)", borderRadius: "var(--r-sheet) var(--r-sheet) 0 0", padding: "14px 20px 24px", animation: "sheetIn 240ms var(--ease)" }}>
            <div style={{ width: 36, height: 3, borderRadius: 2, background: "#DCD6C6", margin: "0 auto 14px" }} />
            <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em", marginBottom: 6 }}>Merged into {me.display_name}</div>
            <div className="mono" style={{ fontSize: 11, color: "var(--text-3)", lineHeight: 1.5, marginBottom: 16 }}>Unmerging pops this contact back out on its own. Their past shares re-route back automatically.</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {mergedIn.map((p) => {
                const busy = busyId === p.id;
                return (
                  <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 12, background: "var(--bg)", border: "1px solid var(--hairline)" }}>
                    <span style={{ width: 36, height: 36, borderRadius: "50%", background: p.avatar_color || "var(--knob-off)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flex: "none" }}>{p.avatar_emoji || "🙂"}</span>
                    <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                      <span style={{ fontSize: 15, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.display_name}</span>
                      <span className="mono" style={{ fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-3)" }}>{p.is_token ? "placeholder" : "account"}</span>
                    </span>
                    <button onClick={() => !busy && unmerge(p.id)} disabled={busy} className="mono" style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-3)", opacity: busy ? 0.4 : 1 }}>{busy ? "…" : "Unmerge"}</button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
