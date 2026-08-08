import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "../lib/supabase";
import { currencySymbol } from "../lib/format";
import {
  loadSettlementData, buildContributions, toHome, eraFor,
  settleShares, unsettleShares, patchContribsSettled,
  loadSummaries, planSummary, createSummary, revertSummary, canRevertSummary,
  settleTransfer, unsettleTransfer,
} from "../lib/balances";
import DualMoney from "../components/DualMoney";
import SaveError from "../components/SaveError";
import { useBackLayer } from "../lib/backstack.jsx";

// Scoped settle for ONE record's party: direct pairwise "who owes who", each row
// backed by real item shares. Rows toggle paid/unpaid in place (fade + strike),
// no disappearing — reversibility is the misclick guard, plus an Undo toast.
export default function RecordSettleSheet({ recordingId, people, onClose }) {
  const [rec, setRec] = useState(null);
  const [home, setHome] = useState("THB");
  const [contribs, setContribs] = useState([]);
  const [summaries, setSummaries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirmAll, setConfirmAll] = useState(false);
  const [confirmSummary, setConfirmSummary] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(null); // summary id
  const [saveErr, setSaveErr] = useState(false);
  const chain = useRef(Promise.resolve()); // serializes background writes

  // Hardware back, innermost first.
  useBackLayer(true, () => onClose());
  useBackLayer(confirmAll, () => setConfirmAll(false));
  useBackLayer(confirmSummary, () => setConfirmSummary(false));
  useBackLayer(!!confirmRevert, () => setConfirmRevert(null));

  const self = (people || []).find((p) => p.is_self);
  const ownerId = self?.owner_id;

  const person = useCallback((id) => (people || []).find((x) => x.id === id), [people]);
  const nameOf = useCallback((id) => {
    const p = person(id);
    return p ? (p.is_self ? "You" : p.display_name) : "—";
  }, [person]);

  const load = useCallback(async () => {
    const [{ data: prof }, { data: r }, data, sums] = await Promise.all([
      supabase.from("profiles").select("home_currency").maybeSingle(),
      supabase.from("recordings").select("*").eq("id", recordingId).maybeSingle(),
      loadSettlementData(recordingId),
      loadSummaries(recordingId),
    ]);
    const hc = prof?.home_currency || "THB";
    setHome(hc); setRec(r); setContribs(buildContributions(data, hc));
    setSummaries(sums || []); setLoading(false);
  }, [recordingId]);

  useEffect(() => { load(); }, [load]);

  // optimistic: flip local state instantly, write in the background; if a
  // write fails, re-sync from the server and say so (never lie about saved).
  const background = useCallback((write) => {
    chain.current = chain.current
      .then(write)
      .catch(() => { setSaveErr(true); return load().catch(() => {}); });
  }, [load]);

  // this record's ERA — what its pinned rates convert into (see eraFor)
  const era = eraFor(rec, home);
  const baseCur = rec?.base_currency || era;
  const dual = !!rec?.base_currency && rec.base_currency !== era;
  const recMap = rec ? { [rec.id]: rec } : {};

  const scope = (c) => c.recordingId === recordingId;

  // Direct pairwise over ALL of the record's shares (settled + unsettled), so a
  // paid pair stays visible (faded) and reversible. amount = net over all shares;
  // paid = every share in the pair is settled.
  //
  // Summary transfers are deliberately EXCLUDED here (`!c.transferId`) and drawn
  // as their own rows from `summaries` instead. They arrive as synthetic
  // contributions with EMPTY settleKeys, so a row built from them would settle
  // zero shares and stick forever — the exact Phase-6 bug this model kills. A
  // transfer is settled through its own row (settleTransfer), not through shares.
  const directRows = (() => {
    const pairs = {};
    contribs.filter((c) => scope(c) && !c.transferId).forEach((c) => {
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
    }).filter((t) => t.amount > 0.005).sort((a, b) => b.amount - a.amount);
  })();

  const anyUnpaid = directRows.some((t) => !t.paid);

  // Rows a summary posts. A transfer folded into a LATER summary
  // (`superseded_by`) is no longer live and is dropped silently; a SETTLED one
  // stays, faded + struck — settled things never disappear in this app.
  const summaryBlocks = summaries
    .map((s) => ({
      s,
      rows: (s.transfers || [])
        .filter((t) => !t.superseded_by)
        .sort((a, b) => (b.amount || 0) - (a.amount || 0)),
    }))
    .filter((b) => b.rows.length > 0);
  const newestId = summaries[0]?.id;

  // The plan a new summary would post, computed from the FULL contribution list:
  // a second summary must sweep up both new shares and any unpaid transfers left
  // over from the first. Pure preview — writes nothing.
  //
  // One correction on top of `scope`: a transfer settled OPTIMISTICALLY is still
  // an unsettled atom inside `contribs` (those are only rebuilt by load()), so
  // without this the plan would re-net money that was just paid and supersede
  // the paid row, hiding it. `summaries` is the live truth for a transfer.
  const paidTransferIds = new Set(
    summaries.flatMap((s) => (s.transfers || []).filter((t) => t.settled_at).map((t) => t.id))
  );
  const planScope = (c) => scope(c) && !(c.transferId && paidTransferIds.has(c.transferId));
  const plan = planSummary(contribs, planScope, "base");
  // ⚠️ `shareKeys` empty means NOTHING NEW has happened since the last summary:
  // every open debt in scope is already a transfer that summary posted. Re-netting
  // an already-minimal set just reproduces it, so a second summary would supersede
  // the first with an identical plan — and since only the LATEST summary can be
  // reverted, stacking five of them costs five reverts to undo. (Phoom hit exactly
  // that and reasonably thought the app was broken.) A summary is only offered
  // when there is a real item-share for it to close.
  const canSummarize = !!ownerId && plan.transfers.length > 0 && plan.shareKeys.length > 0;
  // Expenses the plan actually closes. `!c.settled` mirrors planSummary's own
  // filter — an already-settled expense isn't closed by the summary.
  const planExpenses = new Set(
    contribs.filter((c) => scope(c) && !c.settled && c.expenseId).map((c) => c.expenseId)
  ).size;
  // Rows the plan would actually replace — the honest thing to compare its
  // transfer count against. (All-rows would include already-paid ones and hide
  // the "this won't help" note on a single-payer record that's part-settled.)
  const openRowCount =
    directRows.filter((t) => !t.paid).length +
    summaryBlocks.reduce((n, b) => n + b.rows.filter((r) => !r.settled_at).length, 0);

  function toggle(t) {
    const at = t.paid ? null : new Date().toISOString();
    setContribs((cs) => patchContribsSettled(cs, t.shares, at));
    background(() => (t.paid ? unsettleShares(t.shares) : settleShares(t.shares, at)));
  }

  function markAll() {
    setConfirmAll(false);
    const all = directRows.filter((t) => !t.paid).flatMap((t) => t.shares);
    const at = new Date().toISOString();
    setContribs((cs) => patchContribsSettled(cs, all, at));
    background(() => settleShares(all, at));
  }

  // A transfer's settled lifecycle is exactly a share's, so this is the same
  // optimistic pattern: flip local state now, write in the background.
  function toggleTransfer(t) {
    const at = t.settled_at ? null : new Date().toISOString();
    setSummaries((ss) => ss.map((s) => ({
      ...s,
      transfers: (s.transfers || []).map((x) => (x.id === t.id ? { ...x, settled_at: at } : x)),
    })));
    background(() => (t.settled_at ? unsettleTransfer(t.id) : settleTransfer(t.id, at)));
  }

  function doCreateSummary() {
    setConfirmSummary(false);
    background(async () => { await createSummary({ ownerId, recordingId, plan }); await load(); });
  }

  function doRevert(summaryId) {
    setConfirmRevert(null);
    background(async () => { await revertSummary({ ownerId, summaryId, recordingId }); await load(); });
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
        ) : directRows.length === 0 && summaryBlocks.length === 0 ? (
          <div style={{ padding: "40px 0 30px", textAlign: "center" }}>
            <div style={{ fontSize: 15, color: "var(--text-2)" }}>This record is settled up</div>
            <div className="mono" style={{ fontSize: 10.5, color: "var(--text-3)", marginTop: 6 }}>no outstanding balances in the party</div>
          </div>
        ) : (
          <>
            <div style={{ overflowY: "auto" }}>
              {summaryBlocks.map(({ s, rows }) => (
                <div key={s.id}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "12px 0 4px" }}>
                    <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                      <span className="legend">Summary</span>
                      <span className="mono" style={{ fontSize: 9.5, color: "var(--text-3)" }}>{relTime(s.created_at)}</span>
                    </span>
                    {s.id === newestId && canRevertSummary(s.transfers, s.id) && (
                      <div
                        onClick={() => setConfirmRevert(s.id)}
                        style={{ border: "1px solid var(--danger)", color: "var(--danger)", borderRadius: 14, padding: "3px 11px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}
                      >
                        Revert
                      </div>
                    )}
                  </div>
                  {rows.map((t) => (
                    <PayRow
                      key={t.id}
                      from={person(t.from_person)}
                      to={person(t.to_person)}
                      nameFrom={nameOf(t.from_person)}
                      nameTo={nameOf(t.to_person)}
                      paid={!!t.settled_at}
                      amount={t.amount}
                      cur={t.currency}
                      // PINNED at creation — never recompute a transfer's home figure.
                      homeAmount={t.home_currency && t.home_currency !== t.currency ? t.home_amount : null}
                      homeCur={t.home_currency}
                      onClick={() => toggleTransfer(t)}
                    />
                  ))}
                </div>
              ))}

              {directRows.length > 0 && (
                <>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "12px 0 4px" }}>
                    <span className="legend">Who pays who</span>
                    <span className="mono" style={{ fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-3)" }}>tap to mark paid</span>
                  </div>
                  {directRows.map((t, i) => (
                    <PayRow
                      key={i}
                      from={person(t.from)}
                      to={person(t.to)}
                      nameFrom={nameOf(t.from)}
                      nameTo={nameOf(t.to)}
                      paid={t.paid}
                      amount={t.amount}
                      cur={baseCur}
                      homeAmount={dual ? toHome(t.amount, { recording_id: rec?.id, currency: baseCur, exchange_rate: 1 }, recMap, home) : null}
                      homeCur={era}
                      onClick={() => toggle(t)}
                    />
                  ))}
                </>
              )}
            </div>

            {(anyUnpaid || canSummarize) && (
              <div style={{ borderTop: "1px solid var(--hairline)", marginTop: 10, paddingTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                {anyUnpaid && (
                  <button
                    onClick={() => setConfirmAll(true)}
                    style={{ width: "100%", height: 48, borderRadius: 14, background: "var(--accent)", color: "#fff", fontSize: 15, fontWeight: 600 }}
                  >
                    Mark all as paid
                  </button>
                )}
                {canSummarize && (
                  <button
                    onClick={() => setConfirmSummary(true)}
                    style={{ width: "100%", height: 48, borderRadius: 14, border: "1px solid var(--hairline)", background: "var(--bg)", color: "var(--text)", fontSize: 15, fontWeight: 600 }}
                  >
                    Create summary
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {saveErr && <SaveError onDone={() => setSaveErr(false)} />}

      {/* mark-all confirm */}
      {confirmAll && (
        <div onClick={(e) => { e.stopPropagation(); setConfirmAll(false); }} style={{ position: "absolute", inset: 0, background: "var(--scrim)", display: "flex", alignItems: "center", justifyContent: "center", padding: 32, zIndex: 60, animation: "fadeIn 140ms ease" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: "var(--r-card)", padding: "22px 20px", width: "100%", animation: "popIn 160ms var(--ease)" }}>
            <div className="legend" style={{ color: "var(--text-2)" }}>Mark everything paid?</div>
            <div style={{ margin: "12px 0 6px", fontSize: 16, fontWeight: 600 }}>{directRows.filter((t) => !t.paid).length} {directRows.filter((t) => !t.paid).length === 1 ? "transfer" : "transfers"}</div>
            <div style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.55 }}>Clears every outstanding balance in this record. You can undo right after.</div>
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <div onClick={() => setConfirmAll(false)} style={{ flex: 1, height: 40, border: "1px solid var(--hairline)", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</div>
              <div onClick={markAll} style={{ flex: 1, height: 40, background: "var(--accent)", color: "#fff", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Mark paid</div>
            </div>
          </div>
        </div>
      )}

      {/* create-summary preview-confirm — shows the ACTUAL plan, not a warning.
          Deliberately NOT a typed confirmation: this is reversible until someone
          marks a transfer paid, so typing a code would be theatre. */}
      {confirmSummary && (
        <div onClick={(e) => { e.stopPropagation(); setConfirmSummary(false); }} style={{ position: "absolute", inset: 0, background: "var(--scrim)", display: "flex", alignItems: "center", justifyContent: "center", padding: 32, zIndex: 60, animation: "fadeIn 140ms ease" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: "var(--r-card)", padding: "22px 20px", width: "100%", maxHeight: "80%", overflowY: "auto", animation: "popIn 160ms var(--ease)" }}>
            <div className="legend" style={{ color: "var(--text-2)" }}>Create summary?</div>
            <div style={{ margin: "12px 0 6px", fontSize: 16, fontWeight: 600, lineHeight: 1.35 }}>
              {planExpenses} {planExpenses === 1 ? "expense" : "expenses"} · {plan.shareKeys.length} {plan.shareKeys.length === 1 ? "share" : "shares"} will be closed and replaced by {plan.transfers.length} {plan.transfers.length === 1 ? "transfer" : "transfers"}
            </div>

            <div style={{ margin: "14px 0 4px" }}>
              {plan.transfers.map((t, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: "1px solid var(--hairline-3)" }}>
                  <Face p={person(t.from)} />
                  <span className="mono" style={{ fontSize: 13, color: "var(--text-3)" }}>→</span>
                  <Face p={person(t.to)} />
                  <span style={{ fontSize: 13, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    <b style={{ fontWeight: 600 }}>{nameOf(t.from)}</b> pays {nameOf(t.to)}
                  </span>
                  <Money n={t.amount} cur={plan.currency || baseCur} style={{ fontSize: 14, flex: "none" }} />
                </div>
              ))}
            </div>

            {plan.transfers.length >= openRowCount && (
              <div className="mono" style={{ fontSize: 10, color: "var(--text-3)", lineHeight: 1.6, marginTop: 10 }}>This record has one payer, so this won't reduce the number of payments.</div>
            )}

            <div style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.55, marginTop: 12 }}>The expenses stay exactly as they are — their shares just stop counting separately. You can undo this until someone marks a transfer paid.</div>
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <div onClick={() => setConfirmSummary(false)} style={{ flex: 1, height: 40, border: "1px solid var(--hairline)", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</div>
              <div onClick={doCreateSummary} style={{ flex: 1, height: 40, background: "var(--accent)", color: "#fff", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Create summary</div>
            </div>
          </div>
        </div>
      )}

      {/* revert confirm — a reversal, so it's danger-red, not settle-green */}
      {confirmRevert && (
        <div onClick={(e) => { e.stopPropagation(); setConfirmRevert(null); }} style={{ position: "absolute", inset: 0, background: "var(--scrim)", display: "flex", alignItems: "center", justifyContent: "center", padding: 32, zIndex: 60, animation: "fadeIn 140ms ease" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: "var(--r-card)", padding: "22px 20px", width: "100%", animation: "popIn 160ms var(--ease)" }}>
            <div className="legend" style={{ color: "var(--text-2)" }}>Revert this summary?</div>
            <div style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.55, marginTop: 12 }}>The original shares go back to being owed directly. The summary stays in your history.</div>
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <div onClick={() => setConfirmRevert(null)} style={{ flex: 1, height: 40, border: "1px solid var(--hairline)", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</div>
              <div onClick={() => doRevert(confirmRevert)} style={{ flex: 1, height: 40, background: "var(--danger)", color: "#fff", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Revert</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
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

// One row shape for both kinds of debt on this screen — a direct pairwise net
// (backed by item shares) and a summary transfer (backed by its own row). They
// settle through different writes but they are the same thing to the eye, and
// settled rows stay visible: faded + struck, never gone.
function PayRow({ from, to, nameFrom, nameTo, paid, amount, cur, homeAmount, homeCur, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "13px 2px", borderBottom: "1px solid var(--hairline-3)", textAlign: "left", opacity: paid ? 0.5 : 1 }}
    >
      <span style={{ width: 22, height: 22, borderRadius: 7, border: paid ? "none" : "1.5px solid var(--hairline)", background: paid ? "var(--settled)" : "var(--bg)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, flex: "none" }}>{paid ? "✓" : ""}</span>
      <span style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
        <Face p={from} />
        <span className="mono" style={{ fontSize: 14, color: "var(--text-3)" }}>→</span>
        <Face p={to} />
        <span style={{ fontSize: 13.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textDecoration: paid ? "line-through" : "none" }}>
          <b style={{ fontWeight: 600 }}>{nameFrom}</b> pays {nameTo}
        </span>
      </span>
      <DualMoney
        style={{ flex: "none", textDecoration: paid ? "line-through" : "none" }}
        primary={<Money n={amount} cur={cur} style={{ fontSize: 15 }} />}
        homeAmount={homeAmount}
        homeCur={homeCur}
        strike={paid}
      />
    </button>
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
