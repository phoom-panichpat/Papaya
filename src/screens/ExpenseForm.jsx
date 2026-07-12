import { useState, useEffect, useRef } from "react";
import { supabase } from "../lib/supabase";
import { currencySymbol } from "../lib/format";
import PeoplePicker from "../components/PeoplePicker";

const CURRENCIES = ["THB", "KRW", "USD", "EUR", "JPY", "GBP", "SGD", "MYR", "LAK"];

function nowTitle() {
  return new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function displayAmount(str) {
  const [i, d] = str.split(".");
  const gi = Number(i || 0).toLocaleString("en-US");
  return d !== undefined ? gi + "." + d : gi;
}

// small avatar cluster
function Cluster({ ids, people }) {
  const shown = ids.slice(0, 4);
  return (
    <span style={{ display: "flex", alignItems: "center" }}>
      {shown.map((id, i) => {
        const p = people.find((x) => x.id === id);
        return (
          <span key={id} style={{ width: 24, height: 24, borderRadius: "50%", background: p?.avatar_color || "var(--knob-off)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, marginLeft: i ? -6 : 0, border: "1.5px solid var(--surface)" }}>
            {p?.avatar_emoji || "🙂"}
          </span>
        );
      })}
      {ids.length > 4 && <span className="mono" style={{ fontSize: 10, color: "var(--text-4)", marginLeft: 4 }}>+{ids.length - 4}</span>}
    </span>
  );
}

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "back"];

export default function ExpenseForm({ people, onClose }) {
  const [localPeople, setLocalPeople] = useState(people);
  const [amount, setAmount] = useState("0");
  const [currency, setCurrency] = useState("THB");
  const [ts] = useState(nowTitle());
  const [title, setTitle] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [paidBy, setPaidBy] = useState(null);
  const [splitIds, setSplitIds] = useState(new Set());
  const [recording, setRecording] = useState(null);
  const [members, setMembers] = useState([]);
  const [keypadOpen, setKeypadOpen] = useState(true);
  const [picker, setPicker] = useState(null); // "paid" | "split"
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const [note, setNote] = useState(null);
  const [saving, setSaving] = useState(false);
  const [homeCurrency, setHomeCurrency] = useState("THB");
  const [rate, setRate] = useState("");
  const [sliced, setSliced] = useState(false);
  const [restMembers, setRestMembers] = useState(new Set());
  const [items, setItems] = useState([]); // carve-outs: {id, label, amount, members:Set}
  const [itemPicker, setItemPicker] = useState(null); // "rest" | itemId
  const idRef = useRef(0);

  useEffect(() => { setLocalPeople(people); }, [people]);
  const self = localPeople.find((p) => p.is_self);

  useEffect(() => {
    (async () => {
      const { data: prof } = await supabase.from("profiles").select("home_currency").maybeSingle();
      if (prof?.home_currency) setHomeCurrency(prof.home_currency);
      const { data: recs } = await supabase.from("recordings").select("*").eq("is_active", true).limit(1);
      const rec = recs?.[0] || null;
      setRecording(rec);
      let memberIds = [];
      if (rec) {
        const { data: rm } = await supabase.from("recording_members").select("person_id").eq("recording_id", rec.id);
        memberIds = (rm || []).map((r) => r.person_id);
        if (rec.base_currency) setCurrency(rec.base_currency);
      }
      setMembers(memberIds);
      setSplitIds(new Set(memberIds.length ? memberIds : self ? [self.id] : []));
      setPaidBy(self?.id || null);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [self?.id]);

  function press(k) {
    setAmount((a) => {
      if (k === "back") return a.length <= 1 ? "0" : a.slice(0, -1);
      if (k === ".") return a.includes(".") ? a : a + ".";
      if (a.includes(".") && a.split(".")[1].length >= 2) return a;
      if (a === "0") return k;
      return a + k;
    });
  }

  const total = parseFloat(amount) || 0;
  const perHead = splitIds.size ? total / splitIds.size : 0;
  const baseCurrency = recording?.base_currency || homeCurrency;
  const foreign = currency !== baseCurrency;
  const rateNum = parseFloat(rate);
  const converted = foreign && rateNum > 0 ? total * rateNum : null;

  const carveTotal = items.reduce((s, it) => s + (parseFloat(it.amount) || 0), 0);
  const restAmount = total - carveTotal;
  const balanced = restAmount >= -0.001;
  const everyoneIds = [...new Set([...members, ...(self ? [self.id] : []), ...restMembers])];
  const slicedValid =
    balanced &&
    (restAmount <= 0.001 || restMembers.size > 0) &&
    items.every((it) => { const a = parseFloat(it.amount) || 0; return a <= 0 || it.members.size > 0; });
  const canSave = total > 0 && paidBy && !saving && (sliced ? slicedValid : splitIds.size > 0);

  const shares = (() => {
    const m = {};
    const add = (id, amt) => { m[id] = (m[id] || 0) + amt; };
    if (sliced) {
      if (restMembers.size && restAmount > 0) {
        const per = restAmount / restMembers.size;
        restMembers.forEach((id) => add(id, per));
      }
      items.forEach((it) => {
        const a = parseFloat(it.amount) || 0;
        if (it.members.size && a > 0) {
          const per = a / it.members.size;
          it.members.forEach((id) => add(id, per));
        }
      });
    }
    return m;
  })();

  function toggleSplit(p) {
    setSplitIds((s) => {
      const n = new Set(s);
      n.has(p.id) ? n.delete(p.id) : n.add(p.id);
      return n;
    });
  }

  async function createPerson(name) {
    const owner_id = self?.owner_id;
    const { data: p } = await supabase.from("people").insert({ owner_id, display_name: name, is_token: true }).select().single();
    if (p) {
      setLocalPeople((list) => [...list, p]);
      if (picker === "paid") { setPaidBy(p.id); setPicker(null); }
      else setSplitIds((s) => new Set(s).add(p.id));
    }
  }

  function enterSliced() {
    setSliced(true);
    setKeypadOpen(false);
    setRestMembers(new Set(splitIds));
  }
  function addItem() {
    setItems((l) => [...l, { id: ++idRef.current, label: "", amount: "", members: new Set() }]);
  }
  function removeItem(id) {
    setItems((l) => l.filter((it) => it.id !== id));
  }
  function updateItem(id, key, val) {
    setItems((l) => l.map((it) => (it.id === id ? { ...it, [key]: val } : it)));
  }
  function toggleItemMember(target, p) {
    if (target === "rest") {
      setRestMembers((s) => { const n = new Set(s); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; });
    } else {
      setItems((l) => l.map((it) => {
        if (it.id !== target) return it;
        const n = new Set(it.members);
        n.has(p.id) ? n.delete(p.id) : n.add(p.id);
        return { ...it, members: n };
      }));
    }
  }
  function setTargetAll(target, on) {
    const set = new Set(on ? everyoneIds : []);
    if (target === "rest") setRestMembers(set);
    else setItems((l) => l.map((it) => (it.id === target ? { ...it, members: new Set(set) } : it)));
  }
  async function createPersonForItem(name) {
    const owner_id = self?.owner_id;
    const { data: p } = await supabase.from("people").insert({ owner_id, display_name: name, is_token: true }).select().single();
    if (p) { setLocalPeople((l) => [...l, p]); toggleItemMember(itemPicker, p); }
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    const owner_id = self.owner_id;
    if (foreign && rateNum > 0) localStorage.setItem(`papaya:rate:${currency}:${baseCurrency}`, rate);
    const { data: exp } = await supabase
      .from("expenses")
      .insert({ owner_id, recording_id: recording?.id || null, paid_by: paidBy, title: title.trim() || ts, total_amount: total, currency, exchange_rate: foreign && rateNum > 0 ? rateNum : null })
      .select()
      .single();
    const participants = new Set();
    async function insertItem(label, amt, isRest, memberSet) {
      const { data: it } = await supabase
        .from("expense_items")
        .insert({ owner_id, expense_id: exp.id, label, amount: amt, is_rest: isRest })
        .select()
        .single();
      const ids = [...memberSet];
      if (ids.length) await supabase.from("expense_item_members").insert(ids.map((pid) => ({ item_id: it.id, person_id: pid, owner_id })));
      ids.forEach((id) => participants.add(id));
    }

    if (sliced) {
      await insertItem(null, restAmount, true, restMembers);
      for (const it of items) {
        const a = parseFloat(it.amount) || 0;
        if (a <= 0 || !it.members.size) continue;
        await insertItem(it.label.trim() || null, a, false, it.members);
      }
    } else {
      await insertItem(null, total, true, splitIds);
    }

    if (recording && participants.size) {
      const toAdd = [...participants].filter((id) => !members.includes(id));
      if (toAdd.length) {
        await supabase.from("recording_members").upsert(
          toAdd.map((pid) => ({ recording_id: recording.id, person_id: pid, owner_id })),
          { onConflict: "recording_id,person_id" }
        );
      }
    }
    setSaving(false);
    onClose(true);
  }

  const payer = localPeople.find((p) => p.id === paidBy);
  const row = { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderTop: "1px solid var(--hairline)", minHeight: 56, cursor: "pointer" };
  const label = { fontSize: 15 };
  const itemCard = { background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: 12, padding: "14px 16px", marginBottom: 10 };
  const danger = "#B23B2E";

  return (
    <div style={{ position: "absolute", inset: 0, background: "var(--bg)", zIndex: 30, display: "flex", flexDirection: "column" }}>
      {/* header */}
      <div style={{ height: 54, flex: "none", display: "flex", alignItems: "center", padding: "0 12px", gap: 8 }}>
        <button onClick={() => onClose(false)} style={{ width: 40, height: 40, fontSize: 20, borderRadius: "50%" }}>←</button>
        <div style={{ flex: 1, display: "flex", justifyContent: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, height: 30, padding: "0 13px", background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: 999 }}>
            <span className="legend">{recording ? `Recording · ${recording.name}` : "No recording"}</span>
          </div>
        </div>
        <button onClick={save} disabled={!canSave} style={{ height: 32, padding: "0 17px", borderRadius: 999, background: "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 600, opacity: canSave ? 1 : 0.4 }}>Save</button>
      </div>

      {/* amount */}
      <div onClick={() => setKeypadOpen(true)} style={{ padding: "18px 20px 20px", textAlign: "center", cursor: "pointer", flex: "none" }}>
        <div className="legend">Total amount</div>
        <div style={{ marginTop: 10, display: "flex", alignItems: "baseline", justifyContent: "center", gap: 8 }}>
          <span style={{ fontSize: 20, color: "var(--text-2)" }}>{currencySymbol(currency)}</span>
          <span className="money" style={{ fontSize: 46, lineHeight: 1, color: total > 0 ? "var(--text)" : "var(--text-3)" }}>{displayAmount(amount)}</span>
          <button
            onClick={(e) => { e.stopPropagation(); setCurrencyOpen(true); setKeypadOpen(false); }}
            style={{ display: "flex", alignItems: "center", gap: 5, height: 26, padding: "0 11px", marginLeft: 4, background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: 999, alignSelf: "center" }}
          >
            <span className="mono" style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--text)" }}>{currency}</span>
            <span className="mono" style={{ fontSize: 8.5, color: "var(--text-4)" }}>⌄</span>
          </button>
        </div>
      </div>

      {/* body */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {/* currency + exchange rate — contained card, shown only for a foreign currency */}
        {foreign && (
          <div style={{ margin: "10px 20px 6px", background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: "var(--r-card)", overflow: "hidden" }}>
            <div onClick={() => { setKeypadOpen(false); setCurrencyOpen(true); }} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", cursor: "pointer" }}>
              <span style={{ fontSize: 15 }}>Currency</span>
              <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span className="mono" style={{ fontSize: 12, letterSpacing: "0.08em", color: "var(--text)" }}>{currency}</span>
                <span className="mono" style={{ fontSize: 9, color: "var(--text-4)" }}>⌄</span>
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderTop: "1px solid var(--hairline-3)" }}>
              <span style={{ fontSize: 15 }}>Exchange rate</span>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>1 {currency} =</span>
                <input
                  value={rate}
                  onChange={(e) => setRate(e.target.value.replace(/[^0-9.]/g, ""))}
                  onFocus={() => setKeypadOpen(false)}
                  inputMode="decimal"
                  placeholder="0.00"
                  style={{ width: 76, height: 30, textAlign: "right", background: "var(--bg)", border: "1px solid var(--hairline)", borderRadius: 8, fontFamily: "var(--font-mono)", fontSize: 13, outline: "none", padding: "0 8px" }}
                />
                <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>{baseCurrency}</span>
              </span>
            </div>
            <div style={{ padding: "0 16px 14px" }}>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>
                {converted != null
                  ? `≈ ${currencySymbol(baseCurrency)}${converted.toLocaleString("en-US", { maximumFractionDigits: 2 })} in ${baseCurrency}`
                  : "optional — converts to your base currency"}
              </span>
            </div>
          </div>
        )}

        {/* title — the timestamp shows as a clearable hint, not fixed text */}
        <div style={row} onClick={() => { setKeypadOpen(false); setEditingTitle(true); }}>
          <span style={{ ...label, color: "var(--text-2)" }}>Title</span>
          {editingTitle ? (
            <input autoFocus value={title} placeholder={ts} onChange={(e) => setTitle(e.target.value)} onBlur={() => setEditingTitle(false)} onKeyDown={(e) => e.key === "Enter" && setEditingTitle(false)} style={{ textAlign: "right", background: "none", border: "none", outline: "none", fontSize: 15, maxWidth: 220 }} />
          ) : (
            <span style={{ ...label, color: title ? "var(--text)" : "var(--text-3)" }}>{title || ts}</span>
          )}
        </div>

        {/* paid by */}
        <div style={row} onClick={() => { setKeypadOpen(false); setPicker("paid"); }}>
          <span style={{ ...label, color: "var(--text-2)" }}>Paid by</span>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 24, height: 24, borderRadius: "50%", background: payer?.avatar_color || "var(--knob-off)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11 }}>{payer?.avatar_emoji || "🙂"}</span>
            <span style={label}>{payer ? (payer.is_self ? "You" : payer.display_name) : "—"}</span>
          </span>
        </div>

        {!sliced ? (
          <>
            {/* split between (even) */}
            <div style={row} onClick={() => { setKeypadOpen(false); setPicker("split"); }}>
              <span style={{ ...label, color: "var(--text-2)" }}>Split between</span>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Cluster ids={[...splitIds]} people={localPeople} />
                <span className="legend">{String(splitIds.size).padStart(2, "0")} people</span>
              </span>
            </div>
            <div style={{ padding: "18px 20px", borderTop: "1px solid var(--hairline)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span className="legend">Split evenly</span>
                <span style={{ display: "flex", alignItems: "baseline", gap: 2 }}>
                  <span style={{ fontSize: 12, color: "var(--text-2)" }}>{currencySymbol(currency)}</span>
                  <span className="money" style={{ fontSize: 15 }}>{perHead ? perHead.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "0"}</span>
                  <span style={{ fontSize: 12, color: "var(--text-2)", marginLeft: 4 }}>each</span>
                </span>
              </div>
              <button onClick={enterSliced} style={{ width: "100%", marginTop: 14, height: 44, border: "1px solid var(--hairline)", borderRadius: 12, fontSize: 14, fontWeight: 500 }}>Split it up</button>
            </div>
          </>
        ) : (
          <div style={{ padding: "16px 20px", borderTop: "1px solid var(--hairline)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <span className="legend">Split into items</span>
              <button onClick={() => setSliced(false)} className="mono" style={{ fontSize: 10, letterSpacing: "0.08em", color: "var(--text-3)", textTransform: "uppercase" }}>even split</button>
            </div>

            {/* the rest */}
            <div style={itemCard}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 15, fontWeight: 600 }}>The rest</span>
                  <span className="legend" style={{ background: "var(--bg)", padding: "2px 6px", borderRadius: 6 }}>auto</span>
                </span>
                <span style={{ display: "flex", alignItems: "baseline", gap: 2, color: balanced ? "var(--text)" : danger }}>
                  <span style={{ fontSize: 12, color: "var(--text-2)" }}>{currencySymbol(currency)}</span>
                  <span className="money" style={{ fontSize: 15 }}>{restAmount.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>
                </span>
              </div>
              <div onClick={() => setItemPicker("rest")} style={{ marginTop: 10, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}>
                <Cluster ids={[...restMembers]} people={localPeople} />
                <span className="legend">{restMembers.size} in</span>
              </div>
            </div>

            {/* carve-outs */}
            {items.map((it) => (
              <div key={it.id} style={itemCard}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input value={it.label} onChange={(e) => updateItem(it.id, "label", e.target.value)} onFocus={() => setKeypadOpen(false)} placeholder="Item" style={{ flex: 1, background: "none", border: "none", outline: "none", fontSize: 15, fontWeight: 600 }} />
                  <span style={{ fontSize: 12, color: "var(--text-2)" }}>{currencySymbol(currency)}</span>
                  <input value={it.amount} onChange={(e) => updateItem(it.id, "amount", e.target.value.replace(/[^0-9.]/g, ""))} onFocus={() => setKeypadOpen(false)} inputMode="decimal" placeholder="0" style={{ width: 68, textAlign: "right", background: "none", border: "none", outline: "none", fontFamily: "var(--font-money)", fontWeight: 800, fontSize: 15 }} />
                  <button onClick={() => removeItem(it.id)} style={{ width: 24, height: 24, borderRadius: "50%", color: "var(--text-3)", fontSize: 13, flex: "none" }}>✕</button>
                </div>
                <div onClick={() => setItemPicker(it.id)} style={{ marginTop: 10, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}>
                  {it.members.size ? (
                    <>
                      <Cluster ids={[...it.members]} people={localPeople} />
                      <span className="legend">{it.members.size} in</span>
                    </>
                  ) : (
                    <span className="legend" style={{ color: "var(--text-3)" }}>+ who's in?</span>
                  )}
                </div>
              </div>
            ))}

            <button onClick={addItem} style={{ width: "100%", height: 44, border: "1px dashed var(--hairline)", borderRadius: 12, fontSize: 14, fontWeight: 500, color: "var(--text-2)", marginTop: 4 }}>+ Add item</button>

            {/* checks out */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--hairline)" }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: balanced ? "var(--text)" : danger }}>{balanced ? "✓ Checks out" : "Items exceed total"}</span>
              <span style={{ display: "flex", alignItems: "baseline", gap: 2 }}>
                <span style={{ fontSize: 12, color: "var(--text-2)" }}>{currencySymbol(currency)}</span>
                <span className="money" style={{ fontSize: 15 }}>{total.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>
              </span>
            </div>

            {/* per-person peek */}
            {Object.keys(shares).length > 0 && (
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                {Object.entries(shares).map(([pid, amt]) => {
                  const p = localPeople.find((x) => x.id === pid);
                  return (
                    <div key={pid} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 22, height: 22, borderRadius: "50%", background: p?.avatar_color || "var(--knob-off)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10 }}>{p?.avatar_emoji || "🙂"}</span>
                      <span style={{ flex: 1, fontSize: 13 }}>{p?.is_self ? "You" : p?.display_name || "—"}</span>
                      <span style={{ display: "flex", alignItems: "baseline", gap: 2 }}>
                        <span style={{ fontSize: 11, color: "var(--text-2)" }}>{currencySymbol(currency)}</span>
                        <span className="money" style={{ fontSize: 13 }}>{amt.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* logged timestamp — read-only */}
        <div style={{ padding: "10px 20px 20px", textAlign: "center" }}>
          <span className="mono" style={{ fontSize: 10.5, color: "var(--text-4)" }}>logged · {ts}</span>
        </div>
      </div>

      {/* keypad */}
      {keypadOpen && (
        <div style={{ flex: "none", background: "var(--surface)", borderTop: "1px solid var(--hairline)", display: "grid", gridTemplateColumns: "1fr 1fr 1fr" }}>
          {KEYS.map((k) => (
            <button key={k} onClick={() => press(k)} style={{ height: 60, fontSize: k === "back" ? 20 : 24, fontWeight: 400, borderRight: "1px solid var(--hairline-3)", borderBottom: "1px solid var(--hairline-3)" }}>
              {k === "back" ? "⌫" : k}
            </button>
          ))}
        </div>
      )}

      {/* currency dropdown */}
      {currencyOpen && (
        <div onClick={() => setCurrencyOpen(false)} style={{ position: "absolute", inset: 0, background: "var(--scrim-sheet)", zIndex: 40, animation: "fadeIn 140ms ease" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "70%", overflowY: "auto", background: "var(--surface)", borderTop: "1px solid var(--hairline)", borderRadius: "var(--r-sheet) var(--r-sheet) 0 0", padding: "14px 0 24px", animation: "sheetIn 240ms var(--ease)" }}>
            <div style={{ width: 36, height: 3, borderRadius: 2, background: "#DCD6C6", margin: "0 auto 8px" }} />
            <div className="legend" style={{ padding: "6px 20px 4px" }}>Currency</div>
            {CURRENCIES.map((c) => (
              <button key={c} onClick={() => { setCurrency(c); setCurrencyOpen(false); if (c === baseCurrency) { setRate(""); } else { setRate(localStorage.getItem(`papaya:rate:${c}:${baseCurrency}`) || "1"); } }} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderTop: "1px solid var(--hairline-3)" }}>
                <span style={{ fontSize: 15 }}>{c}</span>
                <span style={{ fontSize: 16, color: "var(--text-2)" }}>{currencySymbol(c)}{c === currency ? "  ✓" : ""}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* people picker */}
      {picker && (
        <PeoplePicker
          people={localPeople}
          selectedIds={picker === "paid" ? new Set(paidBy ? [paidBy] : []) : splitIds}
          multi={picker === "split"}
          memberIds={members}
          title={picker === "paid" ? "Paid by" : "Who's in"}
          onToggle={(p) => (picker === "paid" ? (setPaidBy(p.id), setPicker(null)) : toggleSplit(p))}
          onClose={() => setPicker(null)}
          onCreate={createPerson}
        />
      )}

      {/* note */}
      {note && (
        <div onClick={() => setNote(null)} style={{ position: "absolute", inset: 0, background: "var(--scrim)", display: "flex", alignItems: "center", justifyContent: "center", padding: 32, zIndex: 50, animation: "fadeIn 140ms ease" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: "var(--r-card)", padding: "22px 20px", width: "100%", animation: "popIn 160ms var(--ease)" }}>
            <div style={{ fontSize: 14, lineHeight: 1.5 }}>{note}</div>
            <button onClick={() => setNote(null)} style={{ width: "100%", height: 40, border: "1px solid var(--hairline)", borderRadius: 20, fontSize: 13, fontWeight: 600, marginTop: 18 }}>OK</button>
          </div>
        </div>
      )}
    </div>
  );
}
