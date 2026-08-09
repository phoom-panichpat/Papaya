import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { supabase } from "../lib/supabase";
import { currencySymbol, formatMoney } from "../lib/format";
import { settleShares, unsettleShares, toHome, buildAliasMap, resolveAlias, eraFor, grandTotal, serviceCharge, feeFactor } from "../lib/balances";
import DualMoney from "../components/DualMoney";
import SaveError from "../components/SaveError";
import { useBackLayer } from "../lib/backstack.jsx";

function fullDate(d) {
  return new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function SettledPill({ settled }) {
  return (
    <span className="mono" style={{ fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: settled ? "var(--settled)" : "var(--open)" }}>
      {settled ? "settled" : "open"}
    </span>
  );
}

export default function ExpenseDetail({ expenseId, people, onClose, onEdit, onArchiveClose, refreshKey }) {
  const [exp, setExp] = useState(null);
  const [items, setItems] = useState([]);
  const [membersByItem, setMembersByItem] = useState({});
  const [rec, setRec] = useState(null);
  const [group, setGroup] = useState(null);   // the summary group this expense sits in, if any
  const [home, setHome] = useState("THB");
  const [loading, setLoading] = useState(true);
  const [confirmDel, setConfirmDel] = useState(false);
  const [openItems, setOpenItems] = useState(new Set()); // "Made up of" cards — collapsed by default
  const [busy, setBusy] = useState(false);          // delete/archive only — settle toggles are optimistic
  const [dirty, setDirty] = useState(false);        // signal underlying refresh on close
  const [saveErr, setSaveErr] = useState(false);
  const chain = useRef(Promise.resolve());          // serializes background settle writes
  const archiving = useRef(false);                  // skip self-reload during archive-close so the button doesn't flip before the pop

  // Hardware back = the back chevron: closes, signalling a refresh if a settle
  // toggle happened while we were here.
  useBackLayer(true, () => onClose(dirty));
  useBackLayer(confirmDel, () => setConfirmDel(false));

  const aliasMap = useMemo(() => buildAliasMap(people), [people]);
  const canon = (id) => resolveAlias(id, aliasMap);
  const person = useCallback((id) => (people || []).find((x) => x.id === canon(id)), [people, aliasMap]);
  const nameOf = useCallback((id) => {
    const p = person(id);
    return p ? (p.is_self ? "You" : p.display_name) : "—";
  }, [person]);

  const load = useCallback(async () => {
    const { data: e } = await supabase.from("expenses").select("*").eq("id", expenseId).maybeSingle();
    setExp(e);
    if (!e) { setLoading(false); return; }
    const { data: prof } = await supabase.from("profiles").select("home_currency").maybeSingle();
    if (prof?.home_currency) setHome(prof.home_currency);
    if (e.recording_id) {
      const { data: r } = await supabase.from("recordings").select("*").eq("id", e.recording_id).maybeSingle();
      setRec(r);
    }
    if (e.summary_group_id) {
      const { data: g } = await supabase.from("summary_groups").select("*").eq("id", e.summary_group_id).maybeSingle();
      setGroup(g);
    } else setGroup(null);
    const { data: its } = await supabase.from("expense_items").select("*").eq("expense_id", expenseId).order("is_rest", { ascending: false }).order("sort_order");
    const list = its || [];
    setItems(list);
    const ids = list.map((i) => i.id);
    const { data: ims } = ids.length
      ? await supabase.from("expense_item_members").select("*").in("item_id", ids)
      : { data: [] };
    const grp = {};
    (ims || []).forEach((m) => { (grp[m.item_id] = grp[m.item_id] || []).push(m); });
    setMembersByItem(grp);
    setLoading(false);
  }, [expenseId]);

  useEffect(() => { if (archiving.current) return; load(); }, [load, refreshKey]);

  // This expense's ERA — the home currency its pinned rate converts into (from
  // its record, or from home at the moment a loose expense was logged). Every
  // home figure below is in THAT currency, never in today's setting.
  const era = exp?.home_currency || eraFor(rec, home);
  const eraDiffers = !!exp && era !== home;
  const cur = exp?.currency || rec?.base_currency || era;
  const recMap = rec ? { [rec.id]: rec } : {};
  // what was actually charged = subtotal + service/VAT (total_amount is only the subtotal)
  const homeAmount = cur !== era ? toHome(grandTotal(exp), exp, recMap, home) : null;

  // per-person breakdown (everyone but the payer): total, settled state, and
  // ALL of the person's (itemId, personId) shares so we can toggle them at once.
  const perPerson = (() => {
    const acc = {}; // pid -> { amount, allShares, settled }
    items.forEach((it) => {
      const rows = membersByItem[it.id] || [];
      if (!rows.length) return;
      const canonRows = new Map();          // canonId -> [raw member rows]
      rows.forEach((m) => {
        const cid = canon(m.person_id);
        if (!canonRows.has(cid)) canonRows.set(cid, []);
        canonRows.get(cid).push(m);
      });
      // scaled by feeFactor so these rows match buildContributions (which spreads
      // the service charge over every item in proportion) — and so Settlement agrees
      const per = ((Number(it.amount) || 0) * feeFactor(exp)) / canonRows.size;
      const payerCanon = canon(exp.paid_by);
      canonRows.forEach((raws, cid) => {
        if (cid === payerCanon) return;     // payer never owes their own share
        const a = (acc[cid] = acc[cid] || { amount: 0, allShares: [], settled: true });
        a.amount += per;
        raws.forEach((m) => {
          a.allShares.push({ itemId: it.id, personId: m.person_id }); // RAW id
          if (!m.settled_at) a.settled = false;
        });
      });
    });
    return Object.entries(acc).map(([pid, v]) => ({ pid, ...v }));
  })();

  // ── grouped / locked ─────────────────────────────────────────────────────
  // GROUPED (live or frozen): the per-person settle boxes go away. Mathematically
  // they'd be harmless while the group is live — the summary would just recompute
  // — but two different ways to say "paid" for the same debt at the same time is
  // exactly the ambiguity that made minimized transfers untappable in Phase 6.
  // Rule: once grouped, the group is where you settle. Reading still works.
  //
  // LOCKED (the group has frozen, i.e. someone has paid against it): editing and
  // deleting go too, because the transfers were computed from these numbers.
  const grouped = !!group;
  const locked = !!group?.frozen_at;
  const anySettled = perPerson.some((p) => p.settled);
  const fullySettled = perPerson.length === 0 || perPerson.every((p) => p.settled);

  // direct toggle: tap an open person → settled, tap a settled person → open.
  // Reversibility-in-place is the misclick guard (tap again to reverse).
  // Optimistic: flip the local rows instantly, write in the background; on a
  // failed write re-sync from the server and say so.
  function togglePerson(p) {
    const at = p.settled ? null : new Date().toISOString();
    setMembersByItem((prev) => {
      const next = {};
      Object.entries(prev).forEach(([itemId, rows]) => {
        next[itemId] = rows.map((m) =>
          p.allShares.some((s) => s.itemId === itemId && s.personId === m.person_id)
            ? { ...m, settled_at: at }
            : m
        );
      });
      return next;
    });
    setDirty(true);
    chain.current = chain.current
      .then(() => (p.settled ? unsettleShares(p.allShares) : settleShares(p.allShares, at)))
      .catch(() => { setSaveErr(true); return load().catch(() => {}); });
  }

  async function del() {
    setBusy(true);
    await supabase.from("expenses").delete().eq("id", expenseId); // items + members cascade
    setBusy(false);
    onClose(true);
  }

  // archive/unarchive — loose expenses only (in-record ones archive via their record)
  async function toggleArchive() {
    if (busy || !exp) return;
    setBusy(true);
    const { error } = await supabase.from("expenses").update({ archived_at: exp.archived_at ? null : new Date().toISOString() }).eq("id", expenseId);
    if (error) { setBusy(false); setSaveErr(true); return; } // write failed → stay in the detail so the user can retry
    archiving.current = true; // don't self-reload on the coming refreshKey bump (would flip the button before the pop)
    onArchiveClose(); // refresh the underlying list, then pop once it's fresh (detail stays busy meanwhile)
  }

  const iconBtn = { width: 38, height: 38, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13 };
  const payer = person(exp?.paid_by);

  return (
    <div style={{ position: "absolute", inset: 0, background: "var(--bg)", zIndex: 40, display: "flex", flexDirection: "column" }}>
      {/* header */}
      <div style={{ height: 54, flex: "none", display: "flex", alignItems: "center", padding: "0 12px", gap: 4 }}>
        <button onClick={() => onClose(dirty)} style={{ width: 40, height: 40, fontSize: 20, borderRadius: "50%" }}>←</button>
        <div style={{ flex: 1, textAlign: "center" }}><span className="legend">Expense</span></div>
        {/* a locked expense backs transfers someone has already paid against —
            editing or deleting it would silently move what they owe */}
        {!locked && (
          <button onClick={() => onEdit(expenseId)} className="mono" style={{ ...iconBtn, width: "auto", padding: "0 12px", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text)" }}>Edit</button>
        )}
        {!loading && exp && !exp.recording_id && (fullySettled || exp.archived_at) && (
          <button onClick={toggleArchive} disabled={busy} className="mono" style={{ ...iconBtn, width: "auto", padding: "0 12px", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: busy ? "var(--text-4)" : exp.archived_at ? "var(--accent)" : "var(--text-3)" }}>{exp.archived_at ? "Unarchive" : "Archive"}</button>
        )}
        {!locked && (
          <button onClick={() => setConfirmDel(true)} style={{ ...iconBtn, color: "var(--text-3)", fontSize: 16 }}>🗑</button>
        )}
      </div>

      {loading || !exp ? (
        <div style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--text-3)", fontSize: 14 }}>{loading ? "" : "Not found."}</div>
      ) : (
        <div style={{ flex: 1, overflowY: "auto", padding: "0 0 40px" }}>
          {/* title + amount */}
          <div style={{ padding: "8px 24px 22px", textAlign: "center" }}>
            <h1 style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.01em" }}>{exp.title}</h1>
            <div style={{ marginTop: 12 }}>
              <DualMoney
                primary={
                  <span style={{ display: "inline-flex", alignItems: "baseline", gap: 2 }}>
                    <span style={{ fontSize: 18, color: "var(--text-2)" }}>{currencySymbol(cur)}</span>
                    <span className="money" style={{ fontSize: 42, lineHeight: 1 }}>{formatMoney(grandTotal(exp), cur)}</span>
                  </span>
                }
                homeAmount={homeAmount}
                homeCur={era}
                style={{ alignItems: "center" }}
              />
            </div>
            {/* this expense's rate was pinned to the currency below, not to the
                one in Settings today — say which, or the faded line looks wrong */}
            {eraDiffers && (
              <div className="mono" style={{ fontSize: 10, color: "var(--text-4)", marginTop: 8 }}>
                pinned in {era} · your home currency is {home}
              </div>
            )}
          </div>

          {/* meta */}
          <div style={{ padding: "0 24px" }}>
            <Meta label="Paid by" value={
              <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span style={{ width: 22, height: 22, borderRadius: "50%", background: payer?.avatar_color || "var(--knob-off)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11 }}>{payer?.avatar_emoji || "🙂"}</span>
                {nameOf(exp.paid_by)}
              </span>
            } />
            <Meta label="When" value={<span className="mono" style={{ fontSize: 12.5 }}>{fullDate(exp.created_at)}</span>} />
            {rec && <Meta label="Recording" value={rec.name} />}
          </div>

          {/* note — free text, so it gets room to wrap instead of a Meta row */}
          {exp.note && (
            <div style={{ padding: "16px 24px 0" }}>
              <div className="legend" style={{ marginBottom: 7 }}>Note</div>
              <div style={{ fontSize: 14.5, lineHeight: 1.55, color: "var(--text-2)", whiteSpace: "pre-wrap" }}>{exp.note}</div>
            </div>
          )}

          {/* Grouped state — say it plainly, so the missing Edit / settle boxes
              read as a rule rather than a bug. */}
          {grouped && (
            <div style={{ margin: "16px 24px 0", padding: "11px 14px", border: "1px solid var(--hairline)", borderRadius: 12, background: "var(--surface)" }}>
              <div className="mono" style={{ fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: locked ? "var(--text-4)" : "var(--open)" }}>
                {locked ? "Locked" : "In a summary"}
              </div>
              <div style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.55, marginTop: 5 }}>
                {locked
                  ? "Someone has paid against this summary, so this expense is fixed. Clear the paid transfers in the record to unlock it."
                  : "This expense is part of a summary. Settle it there — the summary updates as you change things here."}
              </div>
            </div>
          )}

          {/* split breakdown */}
          <div style={{ padding: "20px 24px 0" }}>
            <div className="legend" style={{ marginBottom: 10 }}>Made up of</div>
            {items.map((it) => {
              const rows = membersByItem[it.id] || [];
              // distinct PEOPLE, not raw rows — after a merge two rows can be the
              // same person, and "Who owes" already divides by distinct people
              const ids = [...new Set(rows.map((m) => canon(m.person_id)))];
              // fee-inclusive, like "Who owes" below — item amounts here add up to
              // the grand total shown at the top
              const itemAmount = (Number(it.amount) || 0) * feeFactor(exp);
              const per = ids.length ? itemAmount / ids.length : 0;
              const open = openItems.has(it.id);
              return (
                <div key={it.id} style={{ background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: 14, padding: "13px 15px", marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 15, fontWeight: 600 }}>{it.is_rest ? "The rest" : (it.label || "Item")}</span>
                      {it.is_rest && <span className="legend" style={{ background: "var(--bg)", padding: "2px 6px", borderRadius: 6 }}>auto</span>}
                    </span>
                    {/* fee-inclusive figure, with what it's made of stated beneath
                        it — the fee is spread across items, so without the split
                        out you can't tell why an item reads 824 when 700 was
                        ordered. Only shown when there IS a fee. */}
                    <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1 }}>
                      <span style={{ display: "flex", alignItems: "baseline", gap: 2 }}>
                        <span style={{ fontSize: 12, color: "var(--text-2)" }}>{currencySymbol(cur)}</span>
                        <span className="money" style={{ fontSize: 15 }}>{formatMoney(itemAmount, cur)}</span>
                      </span>
                      {serviceCharge(exp) > 0 && (
                        <span className="mono" style={{ fontSize: 10, color: "var(--text-4)" }}>
                          {formatMoney(Number(it.amount) || 0, cur)} + {formatMoney(itemAmount - (Number(it.amount) || 0), cur)}
                        </span>
                      )}
                    </span>
                  </div>
                  {/* collapsed: who + how many, one line. Tap for the names and the per-head. */}
                  <div
                    onClick={() => setOpenItems((s) => { const n = new Set(s); n.has(it.id) ? n.delete(it.id) : n.add(it.id); return n; })}
                    style={{ marginTop: 9, display: "flex", alignItems: open ? "flex-start" : "center", justifyContent: "space-between", gap: 8, cursor: "pointer" }}
                  >
                    {open ? (
                      <span style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                        {ids.map((cid) => {
                           const p = person(cid);
                           return (
                             <span key={cid} title={nameOf(cid)} style={{ display: "flex", alignItems: "center", gap: 4, background: "var(--bg)", borderRadius: 999, padding: "3px 9px 3px 3px" }}>
                               <span style={{ width: 18, height: 18, borderRadius: "50%", background: p?.avatar_color || "var(--knob-off)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9 }}>{p?.avatar_emoji || "🙂"}</span>
                               <span style={{ fontSize: 11, color: "var(--text-2)" }}>{nameOf(cid)}</span>
                             </span>
                           );
                         })}
                      </span>
                    ) : (
                      <span className="legend" style={{ color: "var(--text-3)" }}>
                        {ids.length ? `${String(ids.length).padStart(2, "0")} people` : "nobody"}
                      </span>
                    )}
                    <span style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
                      {open && ids.length > 0 && (
                        <span className="mono" style={{ fontSize: 10, color: "var(--text-3)" }}>{currencySymbol(cur)}{per.toLocaleString("en-US", { maximumFractionDigits: 2 })} ea</span>
                      )}
                      <span className="mono" style={{ fontSize: 9, color: "var(--text-4)" }}>{open ? "⌃" : "⌄"}</span>
                    </span>
                  </div>
                </div>
              );
            })}
            {/* the fee isn't an item — it's spread across the ones above, so it's
                stated quietly rather than sitting in the list as another card */}
            {serviceCharge(exp) > 0 && (
              <div style={{ padding: "2px 2px 4px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span className="mono" style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-3)" }}>Service &amp; VAT</span>
                  <span style={{ display: "flex", alignItems: "baseline", gap: 2, color: "var(--text-3)" }}>
                    <span style={{ fontSize: 11 }}>{currencySymbol(cur)}</span>
                    <span className="money" style={{ fontSize: 13 }}>{formatMoney(serviceCharge(exp), cur)}</span>
                  </span>
                </div>
                <div className="mono" style={{ fontSize: 10.5, color: "var(--text-4)", marginTop: 4 }}>
                  included in the amounts above, in proportion to each item
                </div>
              </div>
            )}
          </div>

          {/* who owes — tap a row to toggle settled on/off, in place */}
          {perPerson.length > 0 && (
            <div style={{ padding: "14px 24px 0" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <span className="legend">Who owes {nameOf(exp.paid_by)}</span>
                <span className="mono" style={{ fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-3)" }}>
                  {grouped ? "settle in the group" : "tap to settle"}
                </span>
              </div>
              {perPerson.map((pp) => {
                const { pid, amount, settled } = pp;
                const p = person(pid);
                return (
                  <button
                    key={pid}
                    onClick={() => { if (!grouped) togglePerson(pp); }}
                    disabled={busy || grouped}
                    style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "11px 0", borderBottom: "1px solid var(--hairline-3)", textAlign: "left", cursor: grouped ? "default" : "pointer", opacity: settled ? 0.55 : 1 }}
                  >
                    {/* no checkbox at all once grouped — the group owns settling */}
                    {!grouped && (
                    <span style={{ width: 24, height: 24, borderRadius: 7, border: settled ? "none" : "1.5px solid var(--hairline)", background: settled ? "var(--settled)" : "var(--bg)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, flex: "none" }}>{settled ? "✓" : ""}</span>
                    )}
                    <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                      <span style={{ fontSize: 14, textDecoration: settled ? "line-through" : "none" }}>{nameOf(pid)}</span>
                      <SettledPill settled={settled} />
                    </span>
                    <DualMoney
                      primary={
                        <span style={{ display: "flex", alignItems: "baseline", gap: 2 }}>
                          <span style={{ fontSize: 11, color: "var(--text-2)" }}>{currencySymbol(cur)}</span>
                          <span className="money" style={{ fontSize: 14, textDecoration: settled ? "line-through" : "none" }}>{amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>
                        </span>
                      }
                      homeAmount={cur !== era ? toHome(amount, exp, recMap, home) : null}
                      homeCur={era}
                      strike={settled}
                    />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* delete confirm */}
      {confirmDel && (
        <div onClick={() => setConfirmDel(false)} style={{ position: "absolute", inset: 0, background: "var(--scrim)", display: "flex", alignItems: "center", justifyContent: "center", padding: 32, zIndex: 20, animation: "fadeIn 140ms ease" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: "var(--r-card)", padding: "22px 20px", width: "100%", animation: "popIn 160ms var(--ease)" }}>
            <div className="legend" style={{ color: "var(--text-2)" }}>Delete expense?</div>
            <div style={{ margin: "12px 0 6px", fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>{exp?.title}</div>
            <div style={{ fontSize: 12.5, color: anySettled ? "var(--open)" : "var(--text-2)", lineHeight: 1.55 }}>
              {anySettled
                ? "Some shares here are already marked settled. Deleting removes this expense and its settled record — this can’t be undone."
                : "This removes the expense and its split. This can’t be undone."}
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <div onClick={() => setConfirmDel(false)} style={{ flex: 1, height: 40, border: "1px solid var(--hairline)", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</div>
              <div onClick={() => { if (!busy) del(); }} style={{ flex: 1, height: 40, background: "#B23B2E", color: "#fff", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, cursor: "pointer", opacity: busy ? 0.5 : 1 }}>Delete</div>
            </div>
          </div>
        </div>
      )}

      {saveErr && <SaveError onDone={() => setSaveErr(false)} />}
    </div>
  );
}

function Meta({ label, value }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 0", borderBottom: "1px solid var(--hairline-3)" }}>
      <span style={{ fontSize: 13, color: "var(--text-2)" }}>{label}</span>
      <span style={{ fontSize: 14 }}>{value}</span>
    </div>
  );
}
