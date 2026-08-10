import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { supabase } from "../lib/supabase";
import { currencySymbol, formatMoney, padIndex } from "../lib/format";
import {
  statusForExpense, toHome, buildAliasMap, resolveAlias, eraFor, grandTotal,
  loadSettlementData, buildContributions, planSummary, groupDateName, sortLogEntries,
  directTransfers,
  loadGroups, createGroup, setGroupExpenses, renameGroup, ungroup,
  freezeGroup, unfreezeGroup, settleTransfer, unsettleTransfer,
} from "../lib/balances";
import DualMoney from "../components/DualMoney";
import SaveError from "../components/SaveError";
import { buildRecordText, buildRecordCsv, shareText, downloadCsv, safeFilename } from "../lib/exportRecord";
import { createShareLink, revokeShareLink, shareUrl } from "../lib/share";
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
  // Shrinkable + ellipsized: this is the variable-length half of the meta line
  // ("2 of 4 · Sofia open"), and inside a group box the card padding makes the
  // row narrow enough to collide. It yields first so "paid by X" — the short,
  // fixed part people scan down the column — always survives intact.
  return (
    <span className="mono" style={{ fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: s.color, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{s.label}</span>
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

// One person in the record's roster. A guest wears a dashed ring rather than
// being faded — faded means "settled" everywhere else in this app, and a guest
// is neither settled nor lesser, just not a member yet.
function RosterFace({ person: p, guest, fixed, caption, nudge, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5, width: 56, cursor: onClick ? "pointer" : "default" }}
    >
      <span style={{
        width: 40, height: 40, borderRadius: "50%",
        background: p?.avatar_color || "var(--knob-off)",
        display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18,
        border: guest ? "1.5px dashed var(--hairline)" : "1.5px solid transparent",
        boxSizing: "content-box", marginTop: guest ? -1.5 : 0,
        opacity: fixed ? 0.9 : 1,
      }}>{p?.avatar_emoji || "🙂"}</span>
      <span style={{ fontSize: 11, color: "var(--text-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 56 }}>
        {p?.is_self ? "You" : p?.display_name || "—"}
      </span>
      {caption && (
        <span className="mono" style={{ fontSize: 8.5, letterSpacing: "0.05em", textTransform: "uppercase", color: nudge ? "var(--open)" : "var(--text-4)", whiteSpace: "nowrap" }}>
          {caption}
        </span>
      )}
    </div>
  );
}

// ── "how this was worked out" ────────────────────────────────────────────
// The summary is the most magic thing in the app: it turns a pile of expenses
// into "Boat → You ₩259,551" with no visible derivation, and an unexplained
// number is socially expensive between friends.
//
// 🔑 Written for the FRIEND WHO DOESN'T HAVE THE APP and thinks their number
// looks wrong — so it shows THEIR arithmetic, in plain words, rather than
// describing the algorithm. A prose page saying "we minimise transfers" answers
// a question nobody is asking.
//
// It computes nothing new: the same `contribs` and the same scope filter that
// planSummary uses, so this page cannot drift from the plan it explains.
function ExplainPanel({ title, contribs, scope, plan, baseCur, nameOf, onClose }) {
  const [openPid, setOpenPid] = useState(null);
  const [showDirect, setShowDirect] = useState(false);
  useBackLayer(true, onClose, BACK_LEVEL.SHEET);

  // EXACTLY planSummary's filter — copied deliberately, not approximated.
  const inScope = (contribs || []).filter((c) => !c.settled && (!scope || scope(c)));

  const byPerson = {};
  const touch = (id) => (byPerson[id] = byPerson[id] || { id, lines: [], owes: 0, paid: 0, owesKeys: new Set() });
  inScope.forEach((c) => {
    const d = touch(c.debtor), r = touch(c.creditor);
    // ⚠️ the count is of expenses they have a SHARE in, not every expense they
    // appear in — a payer who owes nothing was reading "share of 2 expenses ₩0"
    d.owes += c.base; d.lines.push({ c, sign: 1 }); d.owesKeys.add(c.expenseId || c.transferId);
    r.paid += c.base; r.lines.push({ c, sign: -1 });
  });
  const people = Object.values(byPerson)
    .map((p) => ({ ...p, net: p.owes - p.paid, count: p.owesKeys.size }))
    .sort((a, b) => b.net - a.net);

  const owedTotal = people.reduce((s, p) => s + Math.max(0, p.net), 0);
  const backTotal = people.reduce((s, p) => s + Math.max(0, -p.net), 0);
  const direct = directTransfers(inScope, null, "base");

  const M = ({ n }) => <Money n={n} cur={baseCur} style={{ fontSize: 14 }} />;
  const label = { fontSize: 13, color: "var(--text-2)" };

  return (
    <div style={{ position: "absolute", inset: 0, background: "var(--bg)", zIndex: 60, display: "flex", flexDirection: "column", animation: "fadeIn 140ms ease" }}>
      <div style={{ height: 54, flex: "none", display: "flex", alignItems: "center", padding: "0 12px", gap: 8 }}>
        <button onClick={onClose} style={{ width: 40, height: 40, fontSize: 20, borderRadius: "50%" }}>←</button>
        <div style={{ flex: 1, textAlign: "center" }}><span className="legend">How this works</span></div>
        <span style={{ width: 40 }} />
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "0 24px 60px" }}>
        <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 6 }}>How this was worked out</div>
        <div style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--text-2)", marginBottom: 26 }}>
          Everyone’s share of every expense is added up. Debts that point both ways cancel
          out, so the group makes as few payments as possible.{" "}
          <span style={{ color: "var(--text)" }}>Nobody pays a different amount than they owe — only who they hand it to changes.</span>
        </div>

        {/* 1 — each person's arithmetic, drillable to the expense */}
        <div className="legend" style={{ marginBottom: 10 }}>1 · What each person owes</div>
        {people.map((p) => {
          const open = openPid === p.id;
          const verb = p.net > 0.005 ? "pays" : p.net < -0.005 ? "gets back" : "square";
          return (
            <div key={p.id} style={{ background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: "var(--r-card)", padding: "13px 16px", marginBottom: 8 }}>
              <div onClick={() => setOpenPid(open ? null : p.id)} style={{ cursor: "pointer" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <span style={{ fontSize: 15, fontWeight: 600 }}>{nameOf(p.id)}</span>
                  <Chevron open={open} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}>
                  <span style={label}>{p.count ? `share of ${p.count} expense${p.count === 1 ? "" : "s"}` : "no shares of their own"}</span><M n={p.owes} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}>
                  <span style={label}>paid for others</span>
                  <span style={{ display: "flex", alignItems: "baseline" }}><span style={{ fontSize: 14, color: "var(--text-2)", marginRight: 1 }}>−</span><M n={p.paid} /></span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0 0", marginTop: 6, borderTop: "1px solid var(--hairline-3)" }}>
                  <span style={{ ...label, color: "var(--text)", fontWeight: 600 }}>{verb}</span>
                  {verb === "square" ? <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>nothing</span> : <M n={Math.abs(p.net)} />}
                </div>
              </div>
              {open && (
                <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--hairline-3)" }}>
                  {p.lines.map((l, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "6px 0" }}>
                      <span style={{ minWidth: 0, fontSize: 12.5, color: "var(--text-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {l.c.expense?.title || "summary transfer"}
                        <span className="mono" style={{ fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-4)", marginLeft: 6 }}>
                          {l.sign > 0 ? "their share" : `${nameOf(l.c.debtor)}’s share · they paid`}
                        </span>
                      </span>
                      <span style={{ display: "flex", alignItems: "baseline", flex: "none" }}>
                        {l.sign < 0 && <span style={{ fontSize: 13, color: "var(--text-2)", marginRight: 1 }}>−</span>}
                        <Money n={l.c.base} cur={baseCur} style={{ fontSize: 13 }} />
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {/* 2 — the check anyone can do on the spot */}
        <div className="legend" style={{ margin: "24px 0 10px" }}>2 · It balances</div>
        <div style={{ background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: "var(--r-card)", padding: "13px 16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}>
            <span style={label}>owed by people who owe</span><M n={owedTotal} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}>
            <span style={label}>due to people who are owed</span><M n={backTotal} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0 0", marginTop: 6, borderTop: "1px solid var(--hairline-3)" }}>
            <span style={{ ...label, color: "var(--text)", fontWeight: 600 }}>difference</span>
            <span className="mono" style={{ fontSize: 12, color: Math.abs(owedTotal - backTotal) < 0.01 ? "var(--settled)" : "var(--danger)" }}>
              {Math.abs(owedTotal - backTotal) < 0.01 ? "0 ✓" : (owedTotal - backTotal).toFixed(2)}
            </span>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-3)", lineHeight: 1.5, marginTop: 10 }}>
            These two are always the same number. If they ever weren’t, the app would be wrong.
          </div>
        </div>

        {/* 3 — minimisation, performed rather than described */}
        <div className="legend" style={{ margin: "24px 0 10px" }}>3 · Who pays who</div>
        <div style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--text-2)", marginBottom: 12 }}>
          {direct.length > plan.transfers.length ? (
            <>
              There {direct.length === 1 ? "is" : "are"} <span style={{ color: "var(--text)" }}>{direct.length} separate debt{direct.length === 1 ? "" : "s"}</span> between people here.
              Cancelling the ones that point both ways settles all of them with just{" "}
              <span style={{ color: "var(--text)" }}>{plan.transfers.length} payment{plan.transfers.length === 1 ? "" : "s"}</span>.
            </>
          ) : (
            // equal counts: nothing cancelled, and claiming otherwise would be a lie
            <>Nothing cancels out here — no two people owe each other — so this is already
              the fewest payments possible:{" "}
              <span style={{ color: "var(--text)" }}>{plan.transfers.length} payment{plan.transfers.length === 1 ? "" : "s"}</span>.</>
          )}
        </div>
        <div style={{ background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: "var(--r-card)", padding: "6px 16px", marginBottom: 10 }}>
          {plan.transfers.map((t, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "9px 0", borderBottom: i < plan.transfers.length - 1 ? "1px solid var(--hairline-3)" : "none" }}>
              <span style={{ fontSize: 13.5, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{nameOf(t.from)} → {nameOf(t.to)}</span>
              <M n={t.amount} />
            </div>
          ))}
        </div>
        <button onClick={() => setShowDirect((v) => !v)} className="mono" style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-3)", padding: "4px 0" }}>
          {showDirect ? "hide" : "show"} the {direct.length} original debt{direct.length === 1 ? "" : "s"}
        </button>
        {showDirect && (
          <div style={{ border: "1px solid var(--hairline)", borderRadius: "var(--r-card)", padding: "6px 16px", marginTop: 8 }}>
            {direct.map((t, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "8px 0", borderBottom: i < direct.length - 1 ? "1px solid var(--hairline-3)" : "none" }}>
                <span style={{ fontSize: 12.5, color: "var(--text-2)", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{nameOf(t.from)} → {nameOf(t.to)}</span>
                <Money n={t.amount} cur={baseCur} style={{ fontSize: 12.5 }} />
              </div>
            ))}
          </div>
        )}

        <div style={{ fontSize: 11.5, color: "var(--text-4)", lineHeight: 1.55, marginTop: 26 }}>{title}</div>
      </div>
    </div>
  );
}

// A quiet ⓘ — the summary is the one place in the app worth explaining.
function InfoDot({ onClick }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      aria-label="How this was worked out"
      style={{ width: 20, height: 20, borderRadius: "50%", border: "1px solid var(--hairline)", color: "var(--text-3)", fontSize: 11, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center", flex: "none", fontStyle: "italic", fontFamily: "Georgia, serif" }}
    >i</button>
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
// Who paid, as a quiet mono caption on the row's meta line. Deliberately FIRST,
// ahead of the status: the status label is the variable-length one ("2 of 4 ·
// Sofia open"), so leading with the payer keeps every name at the same
// x-position down the list — which is what makes the column scannable for
// "wait, who paid that?" without opening anything.
//
// Just the name, no "paid by" (Phoom, 2026-08-08): the position is consistent
// enough to be learned once, and the label cost three words on every row of a
// list whose whole job is being skimmable.
function PaidBy({ name }) {
  return (
    <span className="mono" style={{ fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-3)", flex: "none" }}>
      {name}
    </span>
  );
}
const MetaDot = () => <span style={{ color: "#C6C0B1", fontSize: 9, flex: "none" }}>·</span>;

function ExpenseRow({ e, idx, locked, onClick, base, dual, recMap, home, era, nameOf }) {
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
        <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden", whiteSpace: "nowrap" }}>
          <PaidBy name={nameOf(e.paid_by)} />
          <MetaDot />
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
  // everyone who actually appears in this record's expenses → how many they're in.
  // A GUEST is simply someone in here who has no recording_members row: guest-ness
  // is derived, never stored, so promoting is one insert and demoting is one delete.
  const [participation, setParticipation] = useState({});
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
  const [shareOpen, setShareOpen] = useState(false);
  const [includeWorking, setIncludeWorking] = useState(false);
  // { label, scope, plan } — what the explain panel is explaining
  const [explain, setExplain] = useState(null);
  const [shareMsg, setShareMsg] = useState(null);
  // The live share link. Mirrors rec.share_token so the sheet reacts instantly
  // to create/revoke without waiting on a reload.
  const [shareToken, setShareToken] = useState(null);
  const [linkBusy, setLinkBusy] = useState(false);

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
  useBackLayer(shareOpen, () => setShareOpen(false), BACK_LEVEL.SHEET);

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
    // who actually turns up in this record, and in how many expenses. Counts the
    // payer too — paying for dinner is being there, even if you owe nothing.
    const seen = {}; // pid -> Set of expense ids
    const mark = (pid, eid) => {
      if (!pid || !eid) return;
      const id = resolveAlias(pid, aliasMap);
      (seen[id] = seen[id] || new Set()).add(eid);
    };
    (data.members || []).forEach((m) => mark(m.person_id, itemToExp[m.item_id]));
    (data.expenses || []).forEach((e) => mark(e.paid_by, e.id));
    setParticipation(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v.size])));
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
  // ── guests ───────────────────────────────────────────────────────────────
  // Someone who came for an expense or two but was never added to the record.
  // Derived, not stored: guest = participates here AND has no membership row.
  // That's why the suggestion paths need no changes at all — "Everyone", the
  // split pre-fill and suggestions.js all read recording_members, so a guest is
  // never proposed for a new expense, but still sits one tap away in the
  // picker's "Everyone else" group.
  const GUEST_NUDGE_AT = 3; // in this many expenses, they're not really a guest
  const guestIds = Object.keys(participation)
    .filter((id) => !memberIds.includes(id))
    .sort((a, b) => (participation[b] || 0) - (participation[a] || 0));

  // Moving between the two is a plain tap, no confirm: the person visibly moves
  // between two labelled sections and tapping them there puts them back. Same
  // toggle-in-place reasoning as settling and the REC switch.
  function moveRoster(pid, toMember) {
    if (!rec) return;
    setMemberIds((ids) => (toMember ? [...new Set([...ids, pid])] : ids.filter((x) => x !== pid)));
    background(async () => {
      const q = toMember
        ? supabase.from("recording_members").insert({ recording_id: rec.id, person_id: pid, owner_id: ownerId })
        : supabase.from("recording_members").delete().eq("recording_id", rec.id).eq("person_id", pid);
      const { error } = await q;
      if (error) throw error;
    });
  }
  // A record is settleable-away when nothing is left owing: every ungrouped
  // expense settled AND every group's transfers paid.
  const allSettled =
    looseLogs.every((e) => e.status?.kind === "settled") && groupViews.every((g) => !g.open);

  const collapse = (k) => setCollapsed((c) => ({ ...c, [k]: !c[k] }));

  // ── export ───────────────────────────────────────────────────────────────
  // Everything here is DERIVED from the same contribs the screen renders, so a
  // shared summary can never disagree with what's on screen.
  //
  // 🔑 MINIMIZED (planSummary), not direct pairwise — this is the one place the
  // two genuinely differ in value. A real 25-expense record produced THIRTEEN
  // direct "who owes who" lines, which is unreadable in a group chat and is the
  // same noise problem that killed the old settle sheet. planSummary is also
  // exactly what "Settle up this record" previews, so the message matches the
  // plan you'd act on. Frozen groups need no special case: their shares are
  // closed and only their transfer atoms are open, so they net through.
  function buildExport() {
    const scope = (c) => c.recordingId === recordingId;
    const plan = planSummary(contribs, scope, "base");
    const transfers = plan.transfers.map((t) => ({
      from: nameOf(t.from), to: nameOf(t.to), amount: t.amount, home: t.homeAmount,
    }));
    const expenses = logs.map((e) => ({
      date: new Date(e.created_at).toLocaleDateString("en-CA"), // ISO-ish, sorts in a spreadsheet
      title: e.title,
      payer: nameOf(e.paid_by),
      amount: grandTotal(e),
      currency: e.currency || base,
      settled: e.status?.kind === "settled",
      note: e.note || "",
    }));
    // ⚠️ Deliberately NOT included: anyone's payment_note. It's semi-private and
    // this text is headed for a group chat. Only add it if Phoom asks.
    // "show your working" — the same arithmetic the ⓘ panel renders, flattened
    // to text. Built from the identical filter planSummary uses, so the message
    // and the screen can't disagree.
    let working = null;
    if (includeWorking) {
      const inScope = contribs.filter((c) => !c.settled && scope(c));
      const acc = {};
      const touch = (id) => (acc[id] = acc[id] || { id, owesTotal: 0, paidTotal: 0, keys: new Set() });
      inScope.forEach((c) => {
        const d = touch(c.debtor), r = touch(c.creditor);
        // counts expenses they have a SHARE in — see the same note in ExplainPanel
        d.owesTotal += c.base; d.keys.add(c.expenseId || c.transferId);
        r.paidTotal += c.base;
      });
      working = {
        people: Object.values(acc)
          .map((p) => ({ name: nameOf(p.id), owesTotal: p.owesTotal, paidTotal: p.paidTotal, net: p.owesTotal - p.paidTotal, count: p.keys.size }))
          .sort((a, b) => b.net - a.net),
        directCount: directTransfers(inScope, null, "base").length,
      };
    }

    const common = { name: rec?.name, dateRange: dateLabel, baseCurrency: base, era, expenses };
    return {
      text: buildRecordText({ ...common, transfers, settledUp: transfers.length === 0, working }),
      csv: buildRecordCsv(common),
    };
  }

  // ── the live link ─────────────────────────────────────────────────────────
  // Creating one is a plain owner-scoped update; the public read goes through
  // the security-definer function (see lib/share.js). Failures surface through
  // SaveError like every other write on this screen.
  async function doSendLink() {
    setLinkBusy(true);
    try {
      const token = shareToken || (await createShareLink(recordingId));
      setShareToken(token);
      setShareOpen(false);
      const how = await shareText(shareUrl(token), rec?.name || "Record");
      if (how === "copied") setShareMsg("link copied");
      else if (how === "failed") setShareMsg("couldn’t share — try again");
    } catch {
      setSaveErr(true);
    } finally {
      setLinkBusy(false);
    }
  }

  async function doCopyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl(shareToken));
      setShareMsg("link copied");
    } catch {
      setShareMsg("couldn’t copy");
    }
  }

  async function doRevokeLink() {
    setLinkBusy(true);
    try {
      await revokeShareLink(recordingId);
      setShareToken(null);
      setShareMsg("link turned off");
    } catch {
      setSaveErr(true);
    } finally {
      setLinkBusy(false);
    }
  }

  async function doShareText() {
    const { text } = buildExport();
    setShareOpen(false);
    const how = await shareText(text, rec?.name || "Record");
    // the OS sheet is its own feedback; only say something when nothing showed
    if (how === "copied") setShareMsg("copied to clipboard");
    else if (how === "failed") setShareMsg("couldn’t share — try again");
  }

  function doDownloadCsv() {
    const { csv } = buildExport();
    setShareOpen(false);
    downloadCsv(csv, `${safeFilename(rec?.name)}.csv`);
  }

  useEffect(() => {
    if (!shareMsg) return;
    const t = setTimeout(() => setShareMsg(null), 2600);
    return () => clearTimeout(t);
  }, [shareMsg]);

  useEffect(() => { setShareToken(rec?.share_token || null); }, [rec?.share_token]);

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
          <button onClick={() => setShareOpen(true)} className="mono" style={{ height: 40, padding: "0 10px", fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-3)" }}>Share</button>
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
        {!checkMode && (roster.length > 0 || guestIds.length > 0) && (
          <div style={{ padding: "0 24px 20px" }}>
            {roster.length > 0 && (
              <>
                <div className="legend" style={{ marginBottom: 10 }}>Who's in</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
                  {roster.map((id) => {
                    const p = person(id);
                    // you are always in your own record
                    const fixed = !!p?.is_self;
                    return (
                      <RosterFace
                        key={id} person={p} fixed={fixed}
                        onClick={fixed ? undefined : () => moveRoster(id, false)}
                      />
                    );
                  })}
                </div>
              </>
            )}

            {guestIds.length > 0 && (
              <div style={{ marginTop: roster.length > 0 ? 18 : 0 }}>
                <div className="legend" style={{ marginBottom: 4 }}>Guests</div>
                <div className="mono" style={{ fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-4)", marginBottom: 10 }}>
                  joined through an expense · tap to add to who’s in
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
                  {guestIds.map((id) => {
                    const n = participation[id] || 0;
                    return (
                      <RosterFace
                        key={id} person={person(id)} guest
                        caption={`${n} expense${n === 1 ? "" : "s"}`}
                        nudge={n >= GUEST_NUDGE_AT}
                        onClick={() => moveRoster(id, true)}
                      />
                    );
                  })}
                </div>
              </div>
            )}
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
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="legend">Who pays who</span>
                  {checkPlan.transfers.length > 0 && (
                    <InfoDot onClick={() => setExplain({
                      label: `${rec?.name || "This record"} · ${checked.size} expense${checked.size === 1 ? "" : "s"} selected`,
                      scope: (c) => checked.has(c.expenseId),
                      plan: checkPlan,
                    })} />
                  )}
                </span>
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
                    <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden", whiteSpace: "nowrap" }}>
                      <PaidBy name={nameOf(e.paid_by)} />
                      <MetaDot />
                      <SettledPill status={e.status} />
                    </span>
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
                return <ExpenseRow key={entry.id} e={entry.e} idx={idx + 1} onClick={() => onOpenExpense(entry.e.id)} base={base} dual={dual} recMap={recMap} home={home} era={era} nameOf={nameOf} />;
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
                      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span className="legend">Summary</span>
                        {!g.frozen && g.plan?.transfers?.length > 0 && (
                          <InfoDot onClick={() => setExplain({
                            label: `${rec?.name || "This record"} · ${g.label}`,
                            scope: (c) => new Set(g.exps.map((e) => e.id)).has(c.expenseId),
                            plan: g.plan,
                          })} />
                        )}
                      </span>
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
                      <ExpenseRow key={e.id} e={e} idx={i + 1} locked={g.frozen} onClick={() => onOpenExpense(e.id)} base={base} dual={dual} recMap={recMap} home={home} era={era} nameOf={nameOf} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        </div>)}
      </div>

      {explain && (
        <ExplainPanel
          title={explain.label}
          contribs={contribs}
          scope={explain.scope}
          plan={explain.plan}
          baseCur={base}
          nameOf={nameOf}
          onClose={() => setExplain(null)}
        />
      )}

      {/* share sheet — two formats behind one entry point */}
      {shareOpen && (
        <div onClick={() => setShareOpen(false)} style={{ position: "absolute", inset: 0, background: "var(--scrim-sheet)", zIndex: 50, animation: "fadeIn 140ms ease" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", left: 0, right: 0, bottom: 0, background: "var(--surface)", borderTop: "1px solid var(--hairline)", borderRadius: "var(--r-sheet) var(--r-sheet) 0 0", padding: "14px 20px 24px", animation: "sheetIn 240ms var(--ease)" }}>
            <div style={{ width: 36, height: 3, borderRadius: 2, background: "#DCD6C6", margin: "0 auto 14px" }} />
            <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em", marginBottom: 4 }}>Share {rec?.name}</div>
            <div style={{ fontSize: 12.5, color: "var(--text-3)", lineHeight: 1.5, marginBottom: 16 }}>
              For people who don’t have the app. Nobody’s payment details are included.
            </div>

            {/* A link beats a message for the thing Phoom actually wanted — it
                stays correct as expenses keep arriving, where a pasted summary
                goes stale the moment you log the next dinner. */}
            <button onClick={doSendLink} disabled={linkBusy} style={{ width: "100%", height: 52, borderRadius: 14, background: "var(--accent)", color: "#fff", fontSize: 15, fontWeight: 600, marginBottom: 10, textAlign: "left", padding: "0 18px", opacity: linkBusy ? 0.55 : 1 }}>
              {shareToken ? "Send link again" : "Send a link"}
              <div style={{ fontSize: 11.5, fontWeight: 500, opacity: 0.85, marginTop: 1 }}>a page they can open — always up to date</div>
            </button>

            {shareToken && (
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <button onClick={doCopyLink} className="mono" style={{ flex: 1, height: 40, borderRadius: 12, background: "var(--bg)", border: "1px solid var(--hairline)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-2)" }}>
                  Copy link
                </button>
                <button onClick={doRevokeLink} disabled={linkBusy} className="mono" style={{ flex: 1, height: 40, borderRadius: 12, background: "var(--bg)", border: "1px solid var(--hairline)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--danger)", opacity: linkBusy ? 0.55 : 1 }}>
                  Stop sharing
                </button>
              </div>
            )}

            <button onClick={doShareText} style={{ width: "100%", height: 52, borderRadius: 14, background: "var(--bg)", border: "1px solid var(--hairline)", fontSize: 15, fontWeight: 600, marginBottom: 10, textAlign: "left", padding: "0 18px" }}>
              Send summary
              <div className="mono" style={{ fontSize: 10, fontWeight: 500, color: "var(--text-3)", marginTop: 2, letterSpacing: "0.05em", textTransform: "uppercase" }}>a snapshot, as plain text</div>
            </button>

            {/* opt-in: roughly doubles the message, so the default stays short */}
            <div onClick={() => setIncludeWorking((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 11, padding: "10px 4px 14px", cursor: "pointer" }}>
              <span style={{ width: 22, height: 22, borderRadius: 7, flex: "none", border: includeWorking ? "none" : "1.5px solid var(--hairline)", background: includeWorking ? "var(--settled)" : "var(--bg)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}>{includeWorking ? "✓" : ""}</span>
              <span style={{ minWidth: 0 }}>
                <span style={{ fontSize: 13.5 }}>Include the working</span>
                <span style={{ display: "block", fontSize: 11.5, color: "var(--text-3)", marginTop: 1 }}>each person’s share, minus what they paid — for anyone who wants to check</span>
              </span>
            </div>

            <button onClick={doDownloadCsv} style={{ width: "100%", height: 52, borderRadius: 14, background: "var(--bg)", border: "1px solid var(--hairline)", fontSize: 15, fontWeight: 600, textAlign: "left", padding: "0 18px" }}>
              Download CSV
              <div className="mono" style={{ fontSize: 10, fontWeight: 500, color: "var(--text-3)", marginTop: 2, letterSpacing: "0.05em", textTransform: "uppercase" }}>one row per expense · for a spreadsheet</div>
            </button>
          </div>
        </div>
      )}

      {/* only shown when the share produced nothing visible of its own */}
      {shareMsg && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 26, display: "flex", justifyContent: "center", zIndex: 60, pointerEvents: "none", animation: "fadeIn 140ms ease" }}>
          <span className="mono" style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-2)", background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: 18, padding: "9px 16px" }}>{shareMsg}</span>
        </div>
      )}

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
