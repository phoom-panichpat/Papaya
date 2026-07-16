import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase";
import { currencySymbol } from "../lib/format";
import PeoplePicker from "../components/PeoplePicker";
import { computePeopleSuggestions } from "../lib/suggestions";
import { buildAliasMap, resolveAlias, mergePerson } from "../lib/balances";

const CURRENCIES = ["THB", "KRW", "USD", "EUR", "JPY", "GBP", "SGD", "MYR", "LAK"];

// small avatar cluster (mirrors ExpenseForm)
function Cluster({ ids, people }) {
  const shown = ids.slice(0, 5);
  return (
    <span style={{ display: "flex", alignItems: "center" }}>
      {shown.map((id, i) => {
        const p = people.find((x) => x.id === id);
        return (
          <span key={id} style={{ width: 26, height: 26, borderRadius: "50%", background: p?.avatar_color || "var(--knob-off)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, marginLeft: i ? -7 : 0, border: "1.5px solid var(--surface)" }}>
            {p?.avatar_emoji || "🙂"}
          </span>
        );
      })}
      {ids.length > 5 && <span className="mono" style={{ fontSize: 10, color: "var(--text-4)", marginLeft: 5 }}>+{ids.length - 5}</span>}
    </span>
  );
}

export default function CreateRecording({ people, onClose, editRecordingId = null }) {
  const edit = !!editRecordingId;
  const [localPeople, setLocalPeople] = useState(() => people.filter((p) => !p.merged_into_id));
  const [name, setName] = useState("");
  const [homeCurrency, setHomeCurrency] = useState("THB");
  const [customCurrency, setCustomCurrency] = useState(false);
  const [currency, setCurrency] = useState("THB");
  const [rate, setRate] = useState("");
  const [startNow, setStartNow] = useState(true);
  const [memberIds, setMemberIds] = useState(new Set());
  const [picker, setPicker] = useState(false);
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [suggestions, setSuggestions] = useState([]);

  useEffect(() => { setLocalPeople(people.filter((p) => !p.merged_into_id)); }, [people]);
  const self = localPeople.find((p) => p.is_self);

  useEffect(() => {
    (async () => {
      const { data: prof } = await supabase.from("profiles").select("home_currency").maybeSingle();
      const hc = prof?.home_currency || "THB";
      setHomeCurrency(hc);
      if (editRecordingId) {
        const { data: r } = await supabase.from("recordings").select("*").eq("id", editRecordingId).maybeSingle();
        if (r) {
          setName(r.name || "");
          if (r.base_currency) {
            setCustomCurrency(true);
            setCurrency(r.base_currency);
            if (r.exchange_rate != null) setRate(String(r.exchange_rate));
          } else {
            setCurrency(hc);
          }
          const aliasMap = buildAliasMap(people);
          const { data: rm } = await supabase.from("recording_members").select("person_id").eq("recording_id", editRecordingId);
          setMemberIds(new Set((rm || []).map((x) => resolveAlias(x.person_id, aliasMap))));
        }
      } else {
        setCurrency(hc);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // suggestions for who's in — recency ("from last time") + frequency ("often").
  // See src/lib/suggestions.js — shared with the expense form's loose-expense picker.
  useEffect(() => {
    let live = true;
    (async () => {
      const sugg = await computePeopleSuggestions(self?.id);
      if (live) setSuggestions(sugg);
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [self?.id]);

  const foreign = customCurrency && currency !== homeCurrency;
  const rateNum = parseFloat(rate);
  const canSave = name.trim().length > 0 && !saving;

  function toggleMember(p) {
    setMemberIds((s) => { const n = new Set(s); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; });
  }
  async function createPerson(nameStr) {
    const owner_id = self?.owner_id;
    const { data: p } = await supabase.from("people").insert({ owner_id, display_name: nameStr, is_token: true }).select().single();
    if (p) { setLocalPeople((l) => [...l, p]); setMemberIds((s) => new Set(s).add(p.id)); }
  }

  // in-place identity fix: merge one or more people into a real person. Remaps
  // the member roster to the target so the sheet stays consistent.
  async function mergePeople(ids, targetId) {
    for (const id of ids) await mergePerson(id, targetId);
    setMemberIds((s) => { const n = new Set(); s.forEach((x) => n.add(ids.includes(x) ? targetId : x)); return n; });
    setLocalPeople((l) => l.filter((p) => !ids.includes(p.id)));
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    const owner_id = self.owner_id;
    const ids = [...new Set([...(self ? [self.id] : []), ...memberIds])];
    if (editRecordingId) {
      await supabase.from("recordings").update({
        name: name.trim(),
        base_currency: customCurrency ? currency : null,
        exchange_rate: foreign && rateNum > 0 ? rateNum : null,
      }).eq("id", editRecordingId);
      // reconcile recording_members: add newly-checked, remove unchecked (roster only — never touches expense splits)
      const { data: cur } = await supabase.from("recording_members").select("person_id").eq("recording_id", editRecordingId);
      const curIds = new Set((cur || []).map((x) => x.person_id));
      const toAdd = ids.filter((id) => !curIds.has(id));
      const toRemove = [...curIds].filter((id) => !new Set(ids).has(id));
      if (toAdd.length) await supabase.from("recording_members").insert(toAdd.map((pid) => ({ recording_id: editRecordingId, person_id: pid, owner_id })));
      if (toRemove.length) await supabase.from("recording_members").delete().eq("recording_id", editRecordingId).in("person_id", toRemove);
    } else {
      if (startNow) await supabase.from("recordings").update({ is_active: false }).neq("id", "00000000-0000-0000-0000-000000000000");
      const { data: rec } = await supabase
        .from("recordings")
        .insert({
          owner_id,
          name: name.trim(),
          base_currency: customCurrency ? currency : null,
          exchange_rate: foreign && rateNum > 0 ? rateNum : null,
          is_active: startNow,
        })
        .select()
        .single();
      if (rec && ids.length) {
        await supabase.from("recording_members").insert(ids.map((pid) => ({ recording_id: rec.id, person_id: pid, owner_id })));
      }
    }
    setSaving(false);
    onClose(true);
  }

  const row = { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderTop: "1px solid var(--hairline)", minHeight: 56 };
  const label = { fontSize: 15 };

  return (
    <div style={{ position: "absolute", inset: 0, background: "var(--bg)", zIndex: 30, display: "flex", flexDirection: "column" }}>
      {/* header */}
      <div style={{ height: 54, flex: "none", display: "flex", alignItems: "center", padding: "0 12px", gap: 8 }}>
        <button onClick={() => onClose(false)} style={{ width: 40, height: 40, fontSize: 20, borderRadius: "50%" }}>←</button>
        <div style={{ flex: 1, textAlign: "center" }}>
          <span className="legend">{edit ? "Edit recording" : "New recording"}</span>
        </div>
        <button onClick={save} disabled={!canSave} style={{ height: 32, padding: "0 17px", borderRadius: 999, background: "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 600, opacity: canSave ? 1 : 0.4 }}>{edit ? "Save" : "Create"}</button>
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        {/* name */}
        <div style={{ padding: "20px 20px 8px" }}>
          <div className="legend">Name</div>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Busan weekend, Tuesday dinners…"
            style={{ width: "100%", marginTop: 10, height: 44, background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: 12, fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em", outline: "none", padding: "0 14px" }}
          />
        </div>

        {/* who's in (party) */}
        <div style={{ ...row, cursor: "pointer", marginTop: 12 }} onClick={() => setPicker(true)}>
          <span style={{ ...label, color: "var(--text-2)" }}>Who's in</span>
          <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {memberIds.size ? <Cluster ids={[...memberIds]} people={localPeople} /> : <span style={{ fontSize: 14, color: "var(--text-3)" }}>Just you</span>}
            <span className="mono" style={{ fontSize: 9, color: "var(--text-4)" }}>›</span>
          </span>
        </div>
        <div style={{ padding: "0 20px 6px" }}>
          <span className="mono" style={{ fontSize: 10, color: "var(--text-4)" }}>optional — anyone in an expense here joins automatically</span>
        </div>

        {/* different currency */}
        <div style={{ ...row, cursor: "pointer" }} onClick={() => { if (customCurrency) { setCustomCurrency(false); } else { setCustomCurrency(true); setCurrencyOpen(true); } }}>
          <span style={{ ...label, color: "var(--text-2)" }}>Different currency</span>
          {customCurrency ? (
            <span onClick={(e) => { e.stopPropagation(); setCurrencyOpen(true); }} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span className="mono" style={{ fontSize: 12, letterSpacing: "0.08em", color: "var(--text)" }}>{currency}</span>
              <span className="mono" style={{ fontSize: 9, color: "var(--text-4)" }}>⌄</span>
            </span>
          ) : (
            <span style={{ fontSize: 14, color: "var(--text-3)" }}>Uses {homeCurrency}</span>
          )}
        </div>

        {/* exchange rate for foreign recording */}
        {foreign && (
          <div style={{ ...row }}>
            <span style={{ ...label, color: "var(--text-2)" }}>Exchange rate</span>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>1 {currency} =</span>
              <input
                value={rate}
                onChange={(e) => setRate(e.target.value.replace(/[^0-9.]/g, ""))}
                inputMode="decimal"
                placeholder="0.00"
                style={{ width: 76, height: 30, textAlign: "right", background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: 8, fontFamily: "var(--font-mono)", fontSize: 13, outline: "none", padding: "0 8px" }}
              />
              <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>{homeCurrency}</span>
            </span>
          </div>
        )}

        {/* start recording now (create-only) */}
        {!edit && (
          <div style={{ ...row }}>
            <span>
              <span style={label}>Start recording now</span>
              <div className="mono" style={{ fontSize: 10, color: "var(--text-4)", marginTop: 3 }}>new expenses file into this one</div>
            </span>
            <span
              onClick={() => setStartNow((v) => !v)}
              style={{ display: "flex", alignItems: "center", width: 48, height: 27, border: "1px solid var(--hairline)", borderRadius: "var(--r-toggle)", background: "var(--bg)", padding: "0 3px", cursor: "pointer", flex: "none" }}
            >
              <span style={{ width: 20, height: 20, borderRadius: "50%", background: startNow ? "var(--accent)" : "var(--knob-off)", transform: `translateX(${startNow ? 20 : 0}px)`, transition: "transform 170ms var(--ease), background 170ms ease" }} />
            </span>
          </div>
        )}
      </div>

      {/* currency dropdown */}
      {currencyOpen && (
        <div onClick={() => setCurrencyOpen(false)} style={{ position: "absolute", inset: 0, background: "var(--scrim-sheet)", zIndex: 40, animation: "fadeIn 140ms ease" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "70%", overflowY: "auto", background: "var(--surface)", borderTop: "1px solid var(--hairline)", borderRadius: "var(--r-sheet) var(--r-sheet) 0 0", padding: "14px 0 24px", animation: "sheetIn 240ms var(--ease)" }}>
            <div style={{ width: 36, height: 3, borderRadius: 2, background: "#DCD6C6", margin: "0 auto 8px" }} />
            <div className="legend" style={{ padding: "6px 20px 4px" }}>Recording currency</div>
            {CURRENCIES.map((c) => (
              <button key={c} onClick={() => { setCurrency(c); setCurrencyOpen(false); if (c !== homeCurrency) setRate(localStorage.getItem(`papaya:rate:${c}:${homeCurrency}`) || "1"); }} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderTop: "1px solid var(--hairline-3)" }}>
                <span style={{ fontSize: 15 }}>{c}</span>
                <span style={{ fontSize: 16, color: "var(--text-2)" }}>{currencySymbol(c)}{c === currency ? "  ✓" : ""}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* member picker */}
      {picker && (
        <PeoplePicker
          people={localPeople}
          selectedIds={memberIds}
          multi
          title="Who's in?"
          onToggle={toggleMember}
          suggestions={suggestions}
          onAddPeople={(ids) => setMemberIds((s) => new Set([...s, ...ids]))}
          onClear={() => setMemberIds(new Set())}
          onClose={() => setPicker(false)}
          onCreate={createPerson}
          onMergePeople={editRecordingId ? mergePeople : undefined}
        />
      )}
    </div>
  );
}
