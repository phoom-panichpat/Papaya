import { useState, useEffect, useRef } from "react";
import { supabase } from "../lib/supabase";
import { currencySymbol } from "../lib/format";
import PeoplePicker from "../components/PeoplePicker";
import { computePeopleSuggestions } from "../lib/suggestions";
import { buildAliasMap, resolveAlias, mergePerson, eraFor, feeFactor, grandTotal } from "../lib/balances";

const CURRENCIES = ["THB", "KRW", "USD", "EUR", "JPY", "GBP", "SGD", "MYR", "LAK"];

function nowTitle() {
  return new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function displayAmount(str) {
  const [i, d] = str.split(".");
  const gi = Number(i || 0).toLocaleString("en-US");
  return d !== undefined ? gi + "." + d : gi;
}

// The rate on an expense is its OWN rate to its ERA currency — that is what
// gets pinned (home_rate) and frozen. Pre-fill order: the recording's own rate
// (when the expense is in the recording's currency, that rate already IS
// native→era), then the last rate used for this pair, then 1.
function defaultRate(cur, era, rec) {
  if (!cur || cur === era) return "";
  if (rec?.base_currency === cur && rec.exchange_rate) return String(rec.exchange_rate);
  return localStorage.getItem(`papaya:rate:${cur}:${era}`) || "1";
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

// "another item for these same people" — quiet by design; the one accent on this
// screen is Save.
// "Another item for these same people." A duplicate glyph rather than words:
// it sits inside a row that already has a label and an amount, and the old
// "+ SAME PEOPLE" pill read louder than the "+ Add item" button below it.
function ChainBtn({ onClick }) {
  return (
    <button
      onClick={onClick}
      title="Another item, same people"
      aria-label="Another item, same people"
      style={{ flex: "none", display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--bg)", color: "var(--text-3)" }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {/* back sheet, offset up-right — the "duplicate" read */}
        <path d="M9 3h9a3 3 0 0 1 3 3v9" />
        {/* front sheet with the + */}
        <rect x="3" y="7" width="14" height="14" rx="3" />
        <path d="M10 11.5v6M7 14.5h6" />
      </svg>
    </button>
  );
}

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "back"];

export default function ExpenseForm({ people, onClose, forceRecordingId = null, editExpenseId = null }) {
  const [localPeople, setLocalPeople] = useState(() => people.filter((p) => !p.merged_into_id));
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
  const [loading, setLoading] = useState(true);
  const [homeCurrency, setHomeCurrency] = useState("THB");
  const [rate, setRate] = useState("");
  const [feePct, setFeePct] = useState(""); // service & VAT, as a % of the subtotal
  const [confirmBack, setConfirmBack] = useState(false);
  const [sliced, setSliced] = useState(false);
  const [restMembers, setRestMembers] = useState(new Set());
  const [whosIn, setWhosIn] = useState(new Set());
  const [items, setItems] = useState([]); // carve-outs: {id, label, amount, members:Set}
  const [itemPicker, setItemPicker] = useState(null); // "rest" | itemId
  const [suggestions, setSuggestions] = useState([]);
  const idRef = useRef(0);

  useEffect(() => { setLocalPeople(people.filter((p) => !p.merged_into_id)); }, [people]);
  const self = localPeople.find((p) => p.is_self);

  useEffect(() => {
    (async () => {
      try {
        const aliasMap = buildAliasMap(people);

        // ── edit mode: reconstruct the form from an existing expense ──
        if (editExpenseId) {
          // Phase 1 — profile, expense, items: all keyed on ids we already have
          const [profRes, expRes, itemsRes] = await Promise.all([
            supabase.from("profiles").select("home_currency").maybeSingle(),
            supabase.from("expenses").select("*").eq("id", editExpenseId).maybeSingle(),
            supabase.from("expense_items").select("*").eq("expense_id", editExpenseId).order("is_rest", { ascending: false }).order("sort_order"),
          ]);
          const hc = profRes.data?.home_currency || "THB";
          const e = expRes.data;
          if (!e) return; // missing → bail (finally still sets loading false)
          const list = itemsRes.data || [];
          const ids = list.map((i) => i.id);

          // Phase 2 — recording + recording_members (if any) + item members (if any)
          const [recRes, rmRes, imsRes] = await Promise.all([
            e.recording_id ? supabase.from("recordings").select("*").eq("id", e.recording_id).maybeSingle() : null,
            e.recording_id ? supabase.from("recording_members").select("person_id").eq("recording_id", e.recording_id) : null,
            ids.length ? supabase.from("expense_item_members").select("item_id, person_id").in("item_id", ids) : null,
          ]);
          const rec = recRes?.data || null;
          const memberIds = [...new Set((rmRes?.data || []).map((x) => resolveAlias(x.person_id, aliasMap)))];
          const byItem = {};
          (imsRes?.data || []).forEach((m) => { (byItem[m.item_id] = byItem[m.item_id] || []).push(resolveAlias(m.person_id, aliasMap)); });
          const rest = list.find((i) => i.is_rest);
          const carve = list.filter((i) => !i.is_rest);

          // set all state together → one render, no progressive fill
          if (profRes.data?.home_currency) setHomeCurrency(profRes.data.home_currency);
          setRecording(rec);
          setMembers(memberIds);
          setPaidBy(resolveAlias(e.paid_by, aliasMap));
          const editEra = eraFor(rec, hc);
          const editCur = e.currency || rec?.base_currency || editEra;
          setCurrency(editCur);
          setAmount(String(e.total_amount ?? "0"));
          setTitle(e.title || "");
          // the fee is stored as an AMOUNT; the form edits a percentage, so
          // derive it back from what the subtotal was when it was saved
          const sc = Number(e.service_charge) || 0, t = Number(e.total_amount) || 0;
          setFeePct(sc > 0 && t > 0 ? String(+((sc / t) * 100).toFixed(4)) : "");
          // the rate field means native→era, so pre-fill from the pin. Older
          // rows (never pinned) fall back to their stored expense→base rate.
          setRate(e.home_rate ? String(e.home_rate)
            : e.exchange_rate ? String(e.exchange_rate)
            : defaultRate(editCur, editEra, rec));
          setKeypadOpen(false);
          if (carve.length) {
            setSliced(true);
            const restSet = new Set(byItem[rest?.id] || []);
            setRestMembers(restSet);
            setItems(carve.map((it) => ({ id: ++idRef.current, label: it.label || "", amount: String(it.amount), members: new Set(byItem[it.id] || []) })));
            setWhosIn(new Set([...restSet, ...carve.flatMap((it) => byItem[it.id] || [])]));
          } else {
            setSplitIds(new Set(byItem[rest?.id] || (self ? [self.id] : [])));
          }
          return;
        }

        // ── new expense: smart defaults from the live/forced recording ──
        // Phase 1 — profile + recording
        const [profRes, recsRes] = await Promise.all([
          supabase.from("profiles").select("home_currency").maybeSingle(),
          forceRecordingId
            ? supabase.from("recordings").select("*").eq("id", forceRecordingId).limit(1)
            : supabase.from("recordings").select("*").eq("is_active", true).limit(1),
        ]);
        const hc = profRes.data?.home_currency || "THB";
        const rec = recsRes.data?.[0] || null;
        let memberIds = [];
        if (rec) {
          // Phase 2 — recording members
          const { data: rm } = await supabase.from("recording_members").select("person_id").eq("recording_id", rec.id);
          memberIds = [...new Set((rm || []).map((r) => resolveAlias(r.person_id, aliasMap)))];
        }
        // in a recording → its currency (or its era, if it has no own currency);
        // loose → the user's home currency (not a hardcoded THB, which would ask
        // a non-THB user for a rate on every loose log)
        const newEra = eraFor(rec, hc);
        const newCur = rec ? rec.base_currency || newEra : hc;
        if (profRes.data?.home_currency) setHomeCurrency(profRes.data.home_currency);
        setRecording(rec);
        setCurrency(newCur);
        setRate(defaultRate(newCur, newEra, rec));
        setMembers(memberIds);
        setSplitIds(new Set(memberIds.length ? memberIds : self ? [self.id] : []));
        setPaidBy(self?.id || null);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [self?.id, editExpenseId]);

  // For a loose expense (no recording) the split pickers show "From last time" /
  // "Often" suggestion chips instead of "Everyone" — there's no defined group.
  useEffect(() => {
    let live = true;
    if (recording) { setSuggestions([]); return; }
    (async () => {
      const sugg = await computePeopleSuggestions(self?.id);
      if (live) setSuggestions(sugg);
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [self?.id, recording]);

  // Who's in must always CONTAIN everyone in a bucket (rest / item). The effect only
  // ADDS, never removes — so leaving a bucket never drops you from Who's in.
  useEffect(() => {
    const bucketed = new Set([...restMembers, ...items.flatMap((it) => [...it.members])]);
    setWhosIn((prev) => {
      let changed = false;
      const n = new Set(prev);
      bucketed.forEach((id) => { if (!n.has(id)) { n.add(id); changed = true; } });
      return changed ? n : prev;
    });
  }, [restMembers, items]);

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
  // Service & VAT sits OUTSIDE the split: the items still add up to `total` (the
  // subtotal), and the fee is spread over them proportionally when balances are
  // derived. The percentage is what's typed; the amount is only ever displayed.
  const feeAmount = total * ((parseFloat(feePct) || 0) / 100);
  // Every per-person figure PREVIEWED on this screen must be fee-inclusive, or
  // the form shows a number nobody is ever charged. Both come from the money
  // core's own helpers, fed a synthetic expense, so the preview cannot drift
  // from what buildContributions actually charges once this is saved.
  const feeShape = { total_amount: total, service_charge: feeAmount };
  const charged = grandTotal(feeShape);
  const feeScale = feeFactor(feeShape);
  const perHead = splitIds.size ? charged / splitIds.size : 0;
  // This expense's ERA: inherited from the recording it's filed in, so a record
  // started under THB keeps logging in THB even after the user switches home.
  // A loose expense pins the user's current home currency.
  const era = eraFor(recording, homeCurrency);
  const eraDiffers = era !== homeCurrency;
  const baseCurrency = recording?.base_currency || era;
  // The rate the user enters is ALWAYS this expense's own rate to its era — the
  // recording's rate is never multiplied in. So the card shows whenever the
  // expense's currency differs from the era, including the ordinary case of a
  // KRW expense in a KRW record: that expense still needs its own pin.
  const needsRate = currency !== era;
  const rateNum = parseFloat(rate);
  const converted = needsRate && rateNum > 0 ? total * rateNum : null;

  // ── unsaved-work guard ────────────────────────────────────────────────────
  // Backing out of this screen throws away everything typed, and there is no
  // draft to come back to — so it has to ask first. "Dirty" is measured against
  // a snapshot taken once the form has finished loading, which is what makes it
  // work in EDIT mode too (where every field starts pre-filled and a "did the
  // user type anything" flag would always say yes).
  const formSig = () => JSON.stringify({
    amount, title, currency, rate, feePct, paidBy, sliced,
    split: [...splitIds].sort(),
    rest: [...restMembers].sort(),
    who: [...whosIn].sort(),
    items: items.map((i) => ({ l: i.label, a: i.amount, m: [...i.members].sort() })),
  });
  const cleanSig = useRef(null);
  useEffect(() => {
    if (!loading && cleanSig.current === null) cleanSig.current = formSig();
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = cleanSig.current !== null && formSig() !== cleanSig.current;
  const goBack = () => (dirty ? setConfirmBack(true) : onClose(false));

  const carveTotal = items.reduce((s, it) => s + (parseFloat(it.amount) || 0), 0);
  const restAmount = total - carveTotal;
  const balanced = restAmount >= -0.001;
  const slicedValid =
    balanced &&
    (restAmount <= 0.001 || restMembers.size > 0) &&
    items.every((it) => { const a = parseFloat(it.amount) || 0; return a <= 0 || it.members.size > 0; });
  const canSave = total > 0 && paidBy && !saving && (sliced ? slicedValid : splitIds.size > 0);

  const shares = (() => {
    const m = {};
    const add = (id, amt) => { m[id] = (m[id] || 0) + amt; };
    // Scaled by feeScale for the same reason perHead is: these are what each
    // person will actually owe, and the saved expense spreads the service
    // charge across every item in exactly this proportion.
    if (sliced) {
      if (restMembers.size && restAmount > 0) {
        const per = (restAmount * feeScale) / restMembers.size;
        restMembers.forEach((id) => add(id, per));
      }
      items.forEach((it) => {
        const a = parseFloat(it.amount) || 0;
        if (it.members.size && a > 0) {
          const per = (a * feeScale) / it.members.size;
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

  function toggleWhosIn(p) {
    if (whosIn.has(p.id)) {
      setWhosIn((s) => { const n = new Set(s); n.delete(p.id); return n; });
      setRestMembers((s) => { const n = new Set(s); n.delete(p.id); return n; });
      setItems((l) => l.map((it) => { const n = new Set(it.members); n.delete(p.id); return { ...it, members: n }; }));
    } else {
      setWhosIn((s) => new Set(s).add(p.id));
      setRestMembers((s) => new Set(s).add(p.id)); // new joiners default into the rest
    }
  }

  async function createPersonWhosIn(name) {
    const owner_id = self?.owner_id;
    const { data: p } = await supabase.from("people").insert({ owner_id, display_name: name, is_token: true }).select().single();
    if (p) { setLocalPeople((l) => [...l, p]); setWhosIn((s) => new Set(s).add(p.id)); setRestMembers((s) => new Set(s).add(p.id)); }
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

  // in-place identity fix: merge one or more people into a real person. Remaps
  // every selection (split / the rest / items / paid-by / members) to the target.
  async function mergePeople(ids, targetId) {
    for (const id of ids) await mergePerson(id, targetId);
    const remap = (set) => {
      const n = new Set();
      set.forEach((x) => n.add(ids.includes(x) ? targetId : x));
      return n;
    };
    setSplitIds(remap);
    setRestMembers(remap);
    setWhosIn(remap);
    setItems((l) => l.map((it) => ({ ...it, members: remap(it.members) })));
    setPaidBy((pb) => (ids.includes(pb) ? targetId : pb));
    setMembers((m) => [...new Set(m.map((x) => (ids.includes(x) ? targetId : x)))]);
    setLocalPeople((l) => l.filter((p) => !ids.includes(p.id)));
  }

  function enterSliced() {
    setSliced(true);
    setKeypadOpen(false);
    setRestMembers(new Set(splitIds));
    setWhosIn(new Set(splitIds));
  }
  function addItem() {
    setItems((l) => [...l, { id: ++idRef.current, label: "", amount: "", members: new Set() }]);
  }
  // chain: a second item for the same people (mixers for the whisky drinkers).
  // Copies the member set only — label and amount start empty.
  function chainItem(from) {
    const src = from === "rest" ? restMembers : items.find((it) => it.id === from)?.members;
    if (!src) return;
    setItems((l) => [...l, { id: ++idRef.current, label: "", amount: "", members: new Set(src) }]);
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
  // In sliced mode "Everyone" means everyone in THIS EXPENSE (Who's in), not the
  // whole recording — if four of the eight on a trip are at this dinner, the wine
  // item is chosen from those four. Who's in always exists here (entering sliced
  // mode seeds it), so the chip works on a loose expense too.
  function setTargetAll(target, on) {
    const set = new Set(on ? whosIn : []);
    if (target === "rest") setRestMembers(set);
    else setItems((l) => l.map((it) => (it.id === target ? { ...it, members: new Set(set) } : it)));
  }
  // Suggestion chips assemble the roster, so on a loose expense they live on the
  // Who's in picker (item pickers pare that roster down instead). New joiners
  // default into the rest, same as tapping them in one at a time.
  function addWhosInPeople(ids) {
    setWhosIn((s) => new Set([...s, ...ids]));
    setRestMembers((s) => new Set([...s, ...ids]));
  }
  function addSplitPeople(ids) {
    setSplitIds((s) => new Set([...s, ...ids]));
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
    if (needsRate && rateNum > 0) localStorage.setItem(`papaya:rate:${currency}:${era}`, rate);
    // Pin this expense's own native→era rate AND the era that rate points at.
    // Once saved both are frozen: they are what every balance reads, so neither
    // the recording's currency nor a later home-currency change can move this
    // debt. Editing re-pins at the current rate.
    const homeRate = needsRate && rateNum > 0 ? rateNum : 1;
    // expenses.exchange_rate (expense → recording base) is now DERIVED, not
    // entered — it survives only as toHome's fallback for unpinned rows and as
    // an edit-mode default. Exactly 1 when the expense is already in the
    // recording's currency, so there's no float round-trip.
    const recToEra = baseCurrency !== era ? Number(recording?.exchange_rate) || 1 : 1;
    const expToBase = currency === baseCurrency ? 1 : homeRate / recToEra;
    const fields = { recording_id: recording?.id || null, paid_by: paidBy, title: title.trim() || ts, total_amount: total, service_charge: feeAmount > 0 ? feeAmount : null, currency, exchange_rate: expToBase, home_rate: homeRate, home_currency: era };
    let exp;
    if (editExpenseId) {
      // editing: update the row and rebuild its split (old items + members cascade-delete)
      await supabase.from("expenses").update(fields).eq("id", editExpenseId);
      await supabase.from("expense_items").delete().eq("expense_id", editExpenseId);
      exp = { id: editExpenseId };
    } else {
      const { data } = await supabase.from("expenses").insert({ owner_id, ...fields }).select().single();
      exp = data;
    }
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
        <button onClick={goBack} style={{ width: 40, height: 40, fontSize: 20, borderRadius: "50%" }}>←</button>
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

      {/* body — gated so the form appears in one pass once loaded */}
      {loading ? (
        <div style={{ flex: 1 }} />
      ) : (
      <div style={{ flex: 1, overflowY: "auto", animation: "fadeIn 160ms var(--ease)" }}>
        {/* currency + this expense's own rate to home — shown whenever they differ */}
        {needsRate && (
          <div style={{ margin: "10px 20px 6px", background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: "var(--r-card)", overflow: "hidden" }}>
            <div onClick={() => { setKeypadOpen(false); setCurrencyOpen(true); }} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", cursor: "pointer" }}>
              <span style={{ fontSize: 15 }}>Currency</span>
              <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span className="mono" style={{ fontSize: 12, letterSpacing: "0.08em", color: "var(--text)" }}>{currency}</span>
                <span className="mono" style={{ fontSize: 9, color: "var(--text-4)" }}>⌄</span>
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderTop: "1px solid var(--hairline-3)" }}>
              <span style={{ fontSize: 15 }}>Rate to {era}</span>
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
                <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>{era}</span>
              </span>
            </div>
            <div style={{ padding: "0 16px 14px" }}>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>
                {converted != null
                  ? `${currencySymbol(currency)}${total.toLocaleString("en-US", { maximumFractionDigits: 2 })} ≈ ${currencySymbol(era)}${converted.toLocaleString("en-US", { maximumFractionDigits: 2 })} in ${era}`
                  : `this expense's value in ${era} — pinned when you save`}
              </span>
              {/* the record keeps the currency it was started in, so say so —
                  otherwise being asked for a THB rate on a USD home reads as a bug */}
              {eraDiffers && (
                <div className="mono" style={{ fontSize: 10.5, color: "var(--text-4)", marginTop: 5 }}>
                  this record logs in {era} · your home currency is {homeCurrency}
                </div>
              )}
            </div>
          </div>
        )}

        {/* service & VAT — charged on top of the subtotal, never inside the items */}
        <div style={{ margin: "10px 20px 6px", background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: "var(--r-card)", overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px" }}>
            <span style={{ fontSize: 15 }}>Service &amp; VAT</span>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                value={feePct}
                onChange={(e) => setFeePct(e.target.value.replace(/[^0-9.]/g, ""))}
                onFocus={() => setKeypadOpen(false)}
                inputMode="decimal"
                placeholder="0"
                style={{ width: 76, height: 30, textAlign: "right", background: "var(--bg)", border: "1px solid var(--hairline)", borderRadius: 8, fontFamily: "var(--font-mono)", fontSize: 13, outline: "none", padding: "0 8px" }}
              />
              <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>%</span>
            </span>
          </div>
          <div style={{ padding: "0 16px 14px" }}>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>
              {feeAmount > 0
                ? `${currencySymbol(currency)}${total.toLocaleString("en-US", { maximumFractionDigits: 2 })} + ${currencySymbol(currency)}${feeAmount.toLocaleString("en-US", { maximumFractionDigits: 2 })} = ${currencySymbol(currency)}${(total + feeAmount).toLocaleString("en-US", { maximumFractionDigits: 2 })} charged`
                : "added on top of the total, split in proportion to what each person ordered"}
            </span>
          </div>
        </div>

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

            {/* who's in — independent roster; bucket membership (the rest + items) is a subset */}
            <div style={row} onClick={() => { setKeypadOpen(false); setPicker("whosin"); }}>
              <span style={{ ...label, color: "var(--text-2)" }}>Who's in</span>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Cluster ids={[...whosIn]} people={localPeople} />
                <span className="legend">{String(whosIn.size).padStart(2, "0")} people</span>
              </span>
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
              <div onClick={() => setItemPicker("rest")} style={{ marginTop: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <Cluster ids={[...restMembers]} people={localPeople} />
                  <span className="legend">{restMembers.size} in</span>
                </span>
                {restMembers.size > 0 && <ChainBtn onClick={(e) => { e.stopPropagation(); chainItem("rest"); }} />}
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
                <div onClick={() => setItemPicker(it.id)} style={{ marginTop: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    {it.members.size ? (
                      <>
                        <Cluster ids={[...it.members]} people={localPeople} />
                        <span className="legend">{it.members.size} in</span>
                      </>
                    ) : (
                      <span className="legend" style={{ color: "var(--text-3)" }}>+ who's in?</span>
                    )}
                  </span>
                  {it.members.size > 0 && <ChainBtn onClick={(e) => { e.stopPropagation(); chainItem(it.id); }} />}
                </div>
              </div>
            ))}

            <button onClick={addItem} style={{ width: "100%", height: 44, border: "1px dashed var(--hairline)", borderRadius: 12, fontSize: 14, fontWeight: 500, color: "var(--text-2)", marginTop: 4 }}>+ Add item</button>

            {/* checks out */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--hairline)" }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: balanced ? "var(--text)" : danger }}>{balanced ? "✓ Checks out" : "Items exceed total"}</span>
              {/* the CHARGED total, so this agrees with the per-person rows below
                  and with what the expense reads as everywhere else. The balance
                  check itself still runs on the subtotal (items must add up to
                  it) — that's what the label asserts, not this figure. */}
              <span style={{ display: "flex", alignItems: "baseline", gap: 2 }}>
                <span style={{ fontSize: 12, color: "var(--text-2)" }}>{currencySymbol(currency)}</span>
                <span className="money" style={{ fontSize: 15 }}>{charged.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>
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
      )}

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
              <button key={c} onClick={() => { setCurrency(c); setCurrencyOpen(false); setRate(defaultRate(c, era, recording)); }} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderTop: "1px solid var(--hairline-3)" }}>
                <span style={{ fontSize: 15 }}>{c}</span>
                <span style={{ fontSize: 16, color: "var(--text-2)" }}>{currencySymbol(c)}{c === currency ? "  ✓" : ""}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* people picker */}
      {(picker === "paid" || picker === "split") && (
        <PeoplePicker
          people={localPeople}
          selectedIds={picker === "paid" ? new Set(paidBy ? [paidBy] : []) : splitIds}
          multi={picker === "split"}
          memberIds={members}
          title={picker === "paid" ? "Paid by" : "Who's in"}
          onToggle={(p) => (picker === "paid" ? (setPaidBy(p.id), setPicker(null)) : toggleSplit(p))}
          onClose={() => setPicker(null)}
          onCreate={createPerson}
          onEveryone={picker === "split" && recording ? () => setSplitIds(new Set(members)) : undefined}
          onClear={picker === "split" && recording ? () => setSplitIds(new Set()) : undefined}
          suggestions={picker === "split" && !recording ? suggestions : []}
          onAddPeople={picker === "split" && !recording ? addSplitPeople : undefined}
          onMergePeople={picker === "split" && editExpenseId ? mergePeople : undefined}
        />
      )}

      {/* who's in picker (sliced mode) — independent roster; new joiners land in the rest */}
      {picker === "whosin" && (
        <PeoplePicker
          people={localPeople}
          selectedIds={whosIn}
          multi
          memberIds={members}
          title="Who's in"
          onToggle={toggleWhosIn}
          onEveryone={recording ? () => addWhosInPeople(members) : undefined}
          suggestions={!recording ? suggestions : []}
          onAddPeople={!recording ? addWhosInPeople : undefined}
          onClose={() => setPicker(null)}
          onCreate={createPersonWhosIn}
          onMergePeople={editExpenseId ? mergePeople : undefined}
        />
      )}

      {/* item / rest people picker */}
      {itemPicker && (() => {
        const isRest = itemPicker === "rest";
        const cur = isRest ? restMembers : (items.find((it) => it.id === itemPicker)?.members || new Set());
        return (
          <PeoplePicker
            people={localPeople}
            selectedIds={cur}
            multi
            /* the group to pare down is this expense's roster, not the record's.
               Assembling the roster happens in the Who's in picker above — which
               is why the suggestion chips live there and not here. */
            memberIds={[...whosIn]}
            memberLabel="In this expense"
            title={isRest ? "Who splits the rest?" : "Who's in?"}
            onToggle={(p) => toggleItemMember(itemPicker, p)}
            onEveryone={() => setTargetAll(itemPicker, true)}
            onClear={() => setTargetAll(itemPicker, false)}
            onClose={() => setItemPicker(null)}
            onCreate={createPersonForItem}
            onMergePeople={editExpenseId ? mergePeople : undefined}
          />
        );
      })()}

      {/* leaving with unsaved work — nothing is drafted anywhere, so ask */}
      {confirmBack && (
        <div onClick={() => setConfirmBack(false)} style={{ position: "absolute", inset: 0, background: "var(--scrim)", display: "flex", alignItems: "center", justifyContent: "center", padding: 32, zIndex: 60, animation: "fadeIn 140ms ease" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: "var(--r-card)", padding: "22px 20px", width: "100%", animation: "popIn 160ms var(--ease)" }}>
            <div className="legend" style={{ color: "var(--text-2)" }}>{editExpenseId ? "Discard changes?" : "Discard this expense?"}</div>
            <div style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.55, marginTop: 12 }}>
              {editExpenseId
                ? "Your edits haven’t been saved. Going back keeps the expense as it was."
                : "Nothing has been saved yet. Going back throws away what you’ve entered."}
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <div onClick={() => setConfirmBack(false)} style={{ flex: 1, height: 40, border: "1px solid var(--hairline)", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Keep editing</div>
              <div onClick={() => onClose(false)} style={{ flex: 1, height: 40, background: "var(--danger)", color: "#fff", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Discard</div>
            </div>
          </div>
        </div>
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
