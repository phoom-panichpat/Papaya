import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { supabase } from "../lib/supabase";
import { currencySymbol, formatMoney, padIndex } from "../lib/format";
import {
  statusForExpense, toHome, buildAliasMap, resolveAlias, eraFor, grandTotal,
  loadSettlementData, buildContributions, planSummary, groupDateName, sortLogEntries,
  loadGroups, createGroup, setGroupExpenses, renameGroup, ungroup,
  freezeGroup, unfreezeGroup, settleTransfer, unsettleTransfer,
} from "../lib/balances";
import DualMoney from "../components/DualMoney";
import SaveError from "../components/SaveError";
import { useBackLayer, BACK_LEVEL } from "../lib/backstack.jsx";

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
  if (!s) return null;
  return (
    <span className="mono" style={{ fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: s.color }}>{s.label}</span>
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

function Face({ p }) {
  return (
    <span style={{ width: 24, height: 24, borderRadius: "50%", background: p?.avatar_color || "var(--knob-off)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, flex: "none" }}>{p?.avatar_emoji || "🙂"}</span>
  );
}

function Chevron({ open }) {
  return (
    <span className="mono" style={{ fontSize: 10, color: "var(--text-4)", transform: open ? "rotate(180deg)" : "none", transition: "transform 140ms var(--ease)", display: "inline-block" }}>⌄</span>
  );
}

// Declared at MODULE scope, not inside the component. A component defined in a
// render body is a NEW type every render, so React unmounts and rebuilds every
// row on any state change — wasteful with a long log, and it throws away the
// rows' animation state.
// ── expense row (shared by the loose feed and a group's expense list) ────
function ExpenseRow({ e, idx, locked, onClick, base, dual, recMap, home, era }) {
  // A locked expense's shares are CLOSED, not open — the pill would say
  // "open" and contradict the group header, so the group's state speaks for it.
  const settled = e.status?.kind === "settled";
  return (
    <div
      onClick={onClick}
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 0", borderBottom: "1px solid var(--hairline-3)", cursor: "pointer", opacity: settled ? 0.5 : 1 }}
    >
      <span className="mono" style={{ fontSize: 10, color: "var(--text-4)", flex: "none" }}>{padIndex(idx)}</span>
      <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3, flex: 1 }}>
        <span style={{ fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textDecoration: settled ? "line-through" : "none" }}>{e.title}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
          {!locked && <SettledPill status={e.status} />}
          {locked && (
            <span className="mono" style={{ fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-4)" }}>locked</span>
          )}
        </span>
      </span>
      <DualMoney
        style={{ flex: "none" }}
        primary={
          <span style={{ display: "flex", alignItems: "baseline", gap: 2 }}>
            <span style={{ fontSize: 12, color: "var(--text-2)" }}>{currencySymbol(e.currency || base)}</span>
            <span className="money" style={{ fontSize: 16 }}>{formatMoney(grandTotal(e), e.currency || base)}</span>
          </span>
        }
        homeAmount={dual ? toHome(grandTotal(e), e, recMap, home) : null}
        homeCur={era}
      />
    </div>
  );
}

function TransferRow({ g, row, person, nameOf, busy, baseCur, onTransferTap }) {
  return (
    <button
      onClick={() => onTransferTap(g, row)}
      disabled={busy}
      style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "11px 0", borderBottom: "1px solid var(--hairline-3)", textAlign: "left", opacity: row.settled ? 0.5 : 1 }}
    >
      <span style={{ width: 20, height: 20, borderRadius: 6, border: row.settled ? "none" : "1.5px solid var(--hairline)", background: row.settled ? "var(--settled)" : "var(--bg)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, flex: "none" }}>{row.settled ? "✓" : ""}</span>
      <span style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
        <Face p={person(row.from)} />
        <span className="mono" style={{ fontSize: 12, color: "var(--text-3)" }}>→</span>
        <Face p={person(row.to)} />
        <span style={{ fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textDecoration: row.settled ? "line-through" : "none" }}>
          <b style={{ fontWeight: 600 }}>{nameOf(row.from)}</b> → {nameOf(row.to)}
        </span>
      </span>
      <DualMoney
        style={{ flex: "none", textDecoration: row.settled ? "line-through" : "none" }}
        primary={<Money n={row.amount} cur={row.currency || baseCur} style={{ fontSize: 14 }} />}
        homeAmount={row.homeCurrency && row.homeCurrency !== (row.currency || baseCur) ? row.homeAmount : null}
        homeCur={row.homeCurrency}
        strike={row.settled}
      />
    </button>
  );
}


export default function RecordingDetail({ recordingId, people, onAddExpense, onOpenExpense, onEdit, onClose, onArchiveClose, refreshKey }) {
  const [rec, setRec] = useState(null);
  const [logs, setLogs] = useState([]);
  const [groups, setGroups] = useState([]);
  const [contribs, setContribs] = useState([]);
  const [memberIds, setMemberIds] = useState([]);
  const [home, setHome] = useState("THB");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState(false);

  // check-mode: the record's "who owes who" view AND the way a group is made.
  // Looking and committing are the same gesture, which is why dropping the old
  // settle sheet costs nothing.
  const [checkMode, setCheckMode] = useState(false);
  const [checked, setChecked] = useState(() => new Set());
  const [collapsed, setCollapsed] = useState({});   // `${id}:sum` / `${id}:exp` -> true
  const [renaming, setRenaming] = useState(null);   // group being renamed
  const [nameDraft, setNameDraft] = useState("");
  const [confirmUngroup, setConfirmUngroup] = useState(null);

  const archiving = useRef(false); // skip self-reload during archive-close so the button doesn't flip before the pop
  const chain = useRef(Promise.resolve()); // serializes background writes

  const aliasMap = useMemo(() => buildAliasMap(people), [people]);
  const self = useMemo(() => (people || []).find((p) => p.is_self), [people]);
  const ownerId = self?.owner_id;

  const nameOf = useCallback((id) => {
    const p = (people || []).find((x) => x.id === resolveAlias(id, aliasMap));
    return p ? (p.is_self ? "You" : p.display_name) : "—";
  }, [people, aliasMap]);
  const person = useCallback(
    (id) => (people || []).find((x) => x.id === resolveAlias(id, aliasMap)),
    [people, aliasMap]
  );

  // Hardware back: check-mode swallows the first press (it's a mode, not a screen).
  useBackLayer(true, () => onClose(false));
  useBackLayer(checkMode, () => setCheckMode(false));
  useBackLayer(!!renaming, () => setRenaming(null));
  useBackLayer(!!confirmUngroup, () => setConfirmUngroup(null), BACK_LEVEL.SHEET);

  const load = useCallback(async () => {
    // ONE parallel phase. The record-scoped settlement load already carries this
    // record's expenses → items → members, so the two extra sequential queries
    // the old version made for settled status are gone.
    const [profRes, recRes, rmRes, grps, data] = await Promise.all([
      supabase.from("profiles").select("home_currency").maybeSingle(),
      supabase.from("recordings").select("*").eq("id", recordingId).maybeSingle(),
      supabase.from("recording_members").select("person_id").eq("recording_id", recordingId),
      loadGroups(recordingId),
      loadSettlementData(recordingId),
    ]);
    const hc = profRes.data?.home_currency || "THB";
    const itemToExp = Object.fromEntries((data.items || []).map((i) => [i.id, i.expense_id]));
    const byExp = {};
    (data.members || []).forEach((m) => {
      const eid = itemToExp[m.item_id];
      if (eid) (byExp[eid] = byExp[eid] || []).push(m);
    });
    const expList = (data.expenses || []).map((e) => ({
      ...e,
      status: statusForExpense(byExp[e.id] || [], e.paid_by, nameOf),
    }));
    setHome(hc);
    setRec(recRes.data);
    setMemberIds([...new Set((rmRes.data || []).map((x) => resolveAlias(x.person_id, aliasMap)))]);
    setLogs(expList);
    setGroups(grps);
    setContribs(buildContributions(data, hc));
    setLoading(false);
  }, [recordingId, nameOf, aliasMap]);

  useEffect(() => { if (archiving.current) return; load(); }, [load, refreshKey]);

  // optimistic: flip local state instantly, write in the background; if a write
  // fails, re-sync from the server and say so (never lie about saved state).
  const background = useCallback((write) => {
    chain.current = chain.current
      .then(write)
      .catch(() => { setSaveErr(true); return load().catch(() => {}); });
  }, [load]);

  // ── derived: era / currency ──────────────────────────────────────────────
  const era = eraFor(rec, home);
  const eraDiffers = !loading && era !== home;
  const base = rec?.base_currency || null;
  const baseCur = base || era;
  const dual = !!base && base !== era;
  const recMap = rec ? { [rec.id]: rec } : {};

  // ── derived: groups + their plans ────────────────────────────────────────
  const groupViews = useMemo(() => groups.map((g) => {
    const exps = logs.filter((e) => e.summary_group_id === g.id);
    const frozen = !!g.frozen_at;
    // A LIVE group holds no transfer rows — its plan is derived here on every
    // render, which is exactly what lets an edit inside it move the summary.
    const ids = new Set(exps.map((e) => e.id));
    const plan = frozen ? null : planSummary(contribs, (c) => ids.has(c.expenseId), "base");
    const rows = frozen
      ? g.transfers.filter((t) => !t.superseded_by).map((t) => ({
          id: t.id, from: t.from_person, to: t.to_person, amount: t.amount,
          currency: t.currency, homeAmount: t.home_amount, homeCurrency: t.home_currency,
          settled: !!t.settled_at,
        }))
      : (plan?.transfers || []).map((t, i) => ({
          id: `live:${i}`, from: t.from, to: t.to, amount: t.amount,
          currency: plan.currency, homeAmount: t.homeAmount, homeCurrency: plan.homeCurrency,
          settled: false,
        }));
    const dates = exps.map((e) => e.created_at);
    return {
      ...g, exps, frozen, plan, rows,
      label: g.name || groupDateName(dates),
      date: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : g.created_at,
      open: rows.some((r) => !r.settled),
    };
  }), [groups, logs, contribs]);

  const grouped = useMemo(
    () => new Set(groupViews.flatMap((g) => g.exps.map((e) => e.id))),
    [groupViews]
  );
  const looseLogs = useMemo(() => logs.filter((e) => !grouped.has(e.id)), [logs, grouped]);

  // THE LOG ORDER: things that still need attention first, newest first within
  // that; fully cleared things sink. With 100 expenses you should never scroll
  // to find the new unsettled one.
  const feed = useMemo(() => sortLogEntries([
    ...groupViews.map((g) => ({ kind: "group", id: g.id, date: g.date, open: g.open, g })),
    ...looseLogs.map((e) => ({
      kind: "expense", id: e.id, date: e.created_at,
      open: e.status?.kind !== "settled", e,
    })),
  ]), [groupViews, looseLogs]);

  // ── check-mode ───────────────────────────────────────────────────────────
  // Everything not already hardened is selectable, and a live group's expenses
  // start ticked — so re-entering check-mode edits the pending group rather
  // than starting from nothing.
  const frozenIds = useMemo(
    () => new Set(groupViews.filter((g) => g.frozen).flatMap((g) => g.exps.map((e) => e.id))),
    [groupViews]
  );
  const selectable = useMemo(() => {
    const list = logs.filter((e) => !frozenIds.has(e.id));
    return sortLogEntries(list.map((e) => ({
      kind: "expense", id: e.id, date: e.created_at,
      open: e.status?.kind !== "settled", e,
    })));
  }, [logs, frozenIds]);

  function enterCheckMode() {
    // all ticked by default — the answer is "all of them" ~90% of the time, and
    // unticking is the escape hatch for "settle up week one, we're still going"
    setChecked(new Set(selectable.map((s) => s.id)));
    setCheckMode(true);
  }

  const checkPlan = useMemo(
    () => planSummary(contribs, (c) => checked.has(c.expenseId), "base"),
    [contribs, checked]
  );

  function toggleCheck(id) {
    setChecked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function commitGroup() {
    if (busy) return;
    const ids = [...checked];
    setBusy(true);
    try {
      const live = groupViews.filter((g) => !g.frozen);
      if (!ids.length) {
        // unticking everything means "no pending group" — dissolve, don't leave
        // an empty box behind
        for (const g of live) await ungroup(g.id, recordingId);
      } else if (live.length) {
        // reuse the first live group so a custom name survives re-grouping, and
        // absorb any others (this is how two pending groups merge into one)
        await setGroupExpenses(live[0].id, ids, recordingId);
        for (const g of live.slice(1)) await ungroup(g.id, recordingId);
      } else {
        await createGroup({ ownerId, recordingId, expenseIds: ids });
      }
      setCheckMode(false);
      await load();
    } catch {
      setSaveErr(true);
      await load().catch(() => {});
    }
    setBusy(false);
  }

  // ── settling a transfer ──────────────────────────────────────────────────
  // Tapping a LIVE group's transfer is what FREEZES it: the plan is materialized
  // into real rows, its shares are closed, and only then is that row marked
  // paid. A plan nobody has acted on is safe to recompute; the moment real money
  // moves it has to stop moving.
  async function payLiveTransfer(g, row) {
    if (busy) return;
    setBusy(true);
    try {
      const rows = await freezeGroup({ ownerId, groupId: g.id, recordingId, plan: g.plan });
      const match = rows.find((t) => t.from_person === row.from && t.to_person === row.to);
      if (match) await settleTransfer(match.id);
      await load();
    } catch {
      setSaveErr(true);
      await load().catch(() => {});
    }
    setBusy(false);
  }

  // Clearing the LAST settled transfer unfreezes the whole group — the expenses
  // become editable again and the plan goes back to being derived.
  async function unpayFrozenTransfer(g, row) {
    const remaining = g.rows.filter((r) => r.settled && r.id !== row.id).length;
    if (remaining === 0) {
      if (busy) return;
      setBusy(true);
      try {
        await unsettleTransfer(row.id);
        await unfreezeGroup({ ownerId, groupId: g.id, recordingId, summaryId: g.freeze_event_id });
        await load();
      } catch {
        setSaveErr(true);
        await load().catch(() => {});
      }
      setBusy(false);
      return;
    }
    // still frozen afterwards → safe to flip locally and write in the background
    setGroups((gs) => gs.map((x) => x.id !== g.id ? x : {
      ...x, transfers: x.transfers.map((t) => t.id === row.id ? { ...t, settled_at: null } : t),
    }));
    background(() => unsettleTransfer(row.id));
  }

  function onTransferTap(g, row) {
    if (!g.frozen) return payLiveTransfer(g, row);
    if (row.settled) return unpayFrozenTransfer(g, row);
    const at = new Date().toISOString();
    setGroups((gs) => gs.map((x) => x.id !== g.id ? x : {
      ...x, transfers: x.transfers.map((t) => t.id === row.id ? { ...t, settled_at: at } : t),
    }));
    background(() => settleTransfer(row.id, at));
  }

  async function saveName() {
    const g = renaming;
    setRenaming(null);
    if (!g) return;
    const next = nameDraft.trim();
    setGroups((gs) => gs.map((x) => x.id === g.id ? { ...x, name: next || null } : x));
    background(() => renameGroup(g.id, next));
  }

  async function doUngroup(g) {
    setConfirmUngroup(null);
    if (busy) return;
    setBusy(true);
    try { await ungroup(g.id, recordingId); await load(); }
    catch { setSaveErr(true); await load().catch(() => {}); }
    setBusy(false);
  }

  async function toggleArchive() {
    if (busy) return;
    setBusy(true);
    const { error } = await supabase.from("recordings").update({ archived_at: rec?.archived_at ? null : new Date().toISOString() }).eq("id", recordingId);
    if (error) { setBusy(false); setSaveErr(true); return; } // write failed → stay in the detail so the user can retry
    archiving.current = true; // don't self-reload on the coming refreshKey bump (would flip the button before the pop)
    onArchiveClose(); // refresh the underlying list, then pop once it's fresh (detail stays busy meanwhile)
  }

  const dateLabel = (() => {
    if (!logs.length) return "New";
    const ds = logs.map((l) => new Date(l.created_at)).sort((a, b) => a - b);
    const first = monthDay(ds[0]);
    const last = rec?.is_active ? "now" : monthDay(ds[ds.length - 1]);
    return first === last ? first : `${first} – ${last}`;
  })();

  const roster = memberIds.length ? memberIds : [];
  // A record is settleable-away when nothing is left owing: every ungrouped
  // expense settled AND every group's transfers paid.
  const allSettled =
    looseLogs.every((e) => e.status?.kind === "settled") && groupViews.every((g) => !g.open);

  const collapse = (k) => setCollapsed((c) => ({ ...c, [k]: !c[k] }));

  return (
    <div style={{ position: "absolute", inset: 0, background: "var(--bg)", zIndex: 30, display: "flex", flexDirection: "column" }}>
      {/* header */}
      <div style={{ height: 54, flex: "none", display: "flex", alignItems: "center", padding: "0 12px", gap: 8 }}>
        <button onClick={() => (checkMode ? setCheckMode(false) : onClose(false))} style={{ width: 40, height: 40, fontSize: 20, borderRadius: "50%" }}>←</button>
        <div style={{ flex: 1, textAlign: "center" }}>
          <span className="legend">{checkMode ? "Settle up" : "Recording"}</span>
        </div>
        {!loading && !checkMode && (
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

        {/* party roster — hidden in check-mode, which is about the money */}
        {!checkMode && roster.length > 0 && (
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

        {/* actions */}
        <div style={{ padding: "0 24px", display: "flex", flexDirection: "row", gap: 10 }}>
          {checkMode ? (
            <>
              <button onClick={() => setCheckMode(false)} style={{ width: 90, height: 48, flex: "none", borderRadius: 14, border: "1px solid var(--hairline)", background: "var(--surface)", fontSize: 14, fontWeight: 600 }}>Cancel</button>
              <button onClick={commitGroup} disabled={busy} style={{ flex: 1, height: 48, borderRadius: 14, background: "var(--accent)", color: "#fff", fontSize: 15, fontWeight: 600, opacity: busy ? 0.6 : 1 }}>
                Done · {padIndex(checked.size)}
              </button>
            </>
          ) : (
            <>
              <button onClick={enterCheckMode} disabled={!logs.length} style={{ flex: 1, height: 48, borderRadius: 14, background: "var(--accent)", color: "#fff", fontSize: 15, fontWeight: 600, opacity: logs.length ? 1 : 0.4 }}>Settle up this record</button>
              <button onClick={onAddExpense} aria-label="Add expense" title="Add expense" style={{ width: 48, height: 48, flex: "none", borderRadius: 14, border: "1px solid var(--hairline)", background: "var(--surface)", fontSize: 24, fontWeight: 400, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
            </>
          )}
        </div>

        {checkMode ? (
          /* ── CHECK-MODE: the plan, live, above the tickable list ──────────
             This doubles as the record's "who owes who" view — look, then
             either commit with Done or back out. */
          <div style={{ padding: "22px 24px 0" }}>
            <div style={{ background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: "var(--r-card)", padding: "14px 16px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <span className="legend">Who pays who</span>
                <span className="mono" style={{ fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-3)" }}>
                  {checkPlan.transfers.length === 1 ? "1 payment" : `${checkPlan.transfers.length} payments`}
                </span>
              </div>
              {checkPlan.transfers.length === 0 ? (
                <div className="mono" style={{ fontSize: 11, color: "var(--text-3)", padding: "6px 0" }}>
                  {checked.size === 0 ? "nothing selected" : "nothing outstanding in this selection"}
                </div>
              ) : checkPlan.transfers.map((t, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 0" }}>
                  <Face p={person(t.from)} />
                  <span className="mono" style={{ fontSize: 12, color: "var(--text-3)" }}>→</span>
                  <Face p={person(t.to)} />
                  <span style={{ fontSize: 13, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    <b style={{ fontWeight: 600 }}>{nameOf(t.from)}</b> → {nameOf(t.to)}
                  </span>
                  <Money n={t.amount} cur={checkPlan.currency || baseCur} style={{ fontSize: 14, flex: "none" }} />
                </div>
              ))}
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "22px 0 2px" }}>
              <span className="legend">Include</span>
              <button
                onClick={() => setChecked(checked.size === selectable.length ? new Set() : new Set(selectable.map((s) => s.id)))}
                className="mono" style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-3)" }}
              >
                {checked.size === selectable.length && selectable.length > 0 ? "Clear" : "Check all"}
              </button>
            </div>
            {selectable.length === 0 ? (
              <div style={{ padding: "24px 0", color: "var(--text-3)", fontSize: 14 }}>Everything here is already settled up.</div>
            ) : selectable.map(({ e }, i) => {
              const on = checked.has(e.id);
              const settled = e.status?.kind === "settled";
              return (
                <div key={e.id} onClick={() => toggleCheck(e.id)} style={{ display: "flex", alignItems: "center", gap: 11, padding: "12px 0", borderBottom: "1px solid var(--hairline-3)", cursor: "pointer", opacity: settled ? 0.5 : 1 }}>
                  <span style={{ width: 22, height: 22, borderRadius: 7, border: on ? "none" : "1.5px solid var(--hairline)", background: on ? "var(--accent)" : "var(--bg)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, flex: "none" }}>{on ? "✓" : ""}</span>
                  <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3, flex: 1 }}>
                    <span style={{ fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textDecoration: settled ? "line-through" : "none" }}>{e.title}</span>
                    <SettledPill status={e.status} />
                  </span>
                  <span style={{ display: "flex", alignItems: "baseline", gap: 2, flex: "none" }}>
                    <span style={{ fontSize: 12, color: "var(--text-2)" }}>{currencySymbol(e.currency || base)}</span>
                    <span className="money" style={{ fontSize: 15 }}>{formatMoney(grandTotal(e), e.currency || base)}</span>
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          /* ── NORMAL: the log — groups and loose expenses, ordered by what
               still needs attention ───────────────────────────────────────── */
          <div style={{ padding: "24px 24px 0" }}>
            <div className="legend" style={{ marginBottom: 6 }}>Expenses</div>
            {logs.length === 0 ? (
              <div style={{ padding: "24px 0", color: "var(--text-3)", fontSize: 14 }}>No expenses yet.</div>
            ) : feed.map((entry, idx) => {
              if (entry.kind === "expense") {
                return <ExpenseRow key={entry.id} e={entry.e} idx={idx + 1} onClick={() => onOpenExpense(entry.e.id)} base={base} dual={dual} recMap={recMap} home={home} era={era} />;
              }
              const g = entry.g;
              const sumHidden = collapsed[`${g.id}:sum`];
              const expHidden = collapsed[`${g.id}:exp`];
              const unpaid = g.rows.filter((r) => !r.settled).length;
              return (
                <div key={g.id} style={{ border: "1px solid var(--hairline)", borderRadius: "var(--r-card)", background: "var(--surface)", margin: "10px 0", overflow: "hidden", opacity: g.open ? 1 : 0.62 }}>
                  {/* group header */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "13px 15px 11px" }}>
                    <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                      <span
                        onClick={() => { setRenaming(g); setNameDraft(g.name || g.label); }}
                        style={{ fontSize: 15, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", cursor: "pointer" }}
                      >{g.label}</span>
                      <span className="mono" style={{ fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: g.frozen ? "var(--text-4)" : "var(--open)" }}>
                        {g.frozen
                          ? (unpaid ? `locked · ${unpaid} unpaid` : "locked · all paid")
                          : `pending · ${padIndex(g.exps.length)} expenses`}
                      </span>
                    </span>
                    {!g.frozen && (
                      <button onClick={() => setConfirmUngroup(g)} className="mono" style={{ fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-3)", padding: "6px 4px" }}>Ungroup</button>
                    )}
                  </div>

                  {/* half 1 — the summary */}
                  <div style={{ borderTop: "1px solid var(--hairline-3)", padding: "0 15px" }}>
                    <div onClick={() => collapse(`${g.id}:sum`)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", cursor: "pointer" }}>
                      <span className="legend">Summary</span>
                      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span className="mono" style={{ fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-3)" }}>
                          {g.rows.length === 1 ? "1 payment" : `${g.rows.length} payments`}
                        </span>
                        <Chevron open={!sumHidden} />
                      </span>
                    </div>
                    {!sumHidden && (
                      <div style={{ paddingBottom: 4 }}>
                        {g.rows.length === 0 ? (
                          <div className="mono" style={{ fontSize: 11, color: "var(--text-3)", padding: "4px 0 12px" }}>nothing outstanding</div>
                        ) : (
                          <>
                            {g.rows.map((row) => <TransferRow key={row.id} g={g} row={row} person={person} nameOf={nameOf} busy={busy} baseCur={baseCur} onTransferTap={onTransferTap} />)}
                            {!g.frozen && (
                              <div className="mono" style={{ fontSize: 9.5, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-4)", padding: "9px 0 3px" }}>
                                tap one to mark paid · that locks this group
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  {/* half 2 — the expenses it covers */}
                  <div style={{ borderTop: "1px solid var(--hairline-3)", padding: "0 15px 4px" }}>
                    <div onClick={() => collapse(`${g.id}:exp`)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", cursor: "pointer" }}>
                      <span className="legend">Expenses</span>
                      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span className="mono" style={{ fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-3)" }}>{padIndex(g.exps.length)}</span>
                        <Chevron open={!expHidden} />
                      </span>
                    </div>
                    {!expHidden && g.exps.map((e, i) => (
                      <ExpenseRow key={e.id} e={e} idx={i + 1} locked={g.frozen} onClick={() => onOpenExpense(e.id)} base={base} dual={dual} recMap={recMap} home={home} era={era} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        </div>)}
      </div>

      {saveErr && <SaveError onDone={() => setSaveErr(false)} />}

      {/* rename a group */}
      {renaming && (
        <div onClick={() => setRenaming(null)} style={{ position: "absolute", inset: 0, background: "var(--scrim)", display: "flex", alignItems: "center", justifyContent: "center", padding: 32, zIndex: 60, animation: "fadeIn 140ms ease" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: "var(--r-card)", padding: "22px 20px", width: "100%", animation: "popIn 160ms var(--ease)" }}>
            <div className="legend" style={{ color: "var(--text-2)" }}>Name this group</div>
            <input
              id="group-name" name="group-name" autoFocus value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder={groupDateName(renaming.exps?.map((e) => e.created_at) || [])}
              style={{ width: "100%", marginTop: 14, height: 44, borderBottom: "1px solid var(--hairline)", fontSize: 16, background: "transparent" }}
            />
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <div onClick={() => setRenaming(null)} style={{ flex: 1, height: 40, border: "1px solid var(--hairline)", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</div>
              <div onClick={saveName} style={{ flex: 1, height: 40, background: "var(--accent)", color: "#fff", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Save</div>
            </div>
          </div>
        </div>
      )}

      {/* ungroup confirm */}
      {confirmUngroup && (
        <div onClick={() => setConfirmUngroup(null)} style={{ position: "absolute", inset: 0, background: "var(--scrim)", display: "flex", alignItems: "center", justifyContent: "center", padding: 32, zIndex: 60, animation: "fadeIn 140ms ease" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: "var(--r-card)", padding: "22px 20px", width: "100%", animation: "popIn 160ms var(--ease)" }}>
            <div className="legend" style={{ color: "var(--text-2)" }}>Ungroup?</div>
            <div style={{ margin: "12px 0 6px", fontSize: 16, fontWeight: 600 }}>{confirmUngroup.label}</div>
            <div style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.55 }}>Its {confirmUngroup.exps.length} expenses go back to standing on their own. Nothing has been paid against this group, so no balance changes.</div>
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <div onClick={() => setConfirmUngroup(null)} style={{ flex: 1, height: 40, border: "1px solid var(--hairline)", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</div>
              <div onClick={() => doUngroup(confirmUngroup)} style={{ flex: 1, height: 40, border: "1px solid var(--danger)", color: "var(--danger)", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Ungroup</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
