import { useState } from "react";
import { supabase } from "../lib/supabase";
import { padIndex } from "../lib/format";
import { mergePerson } from "../lib/balances";

const EMOJI = ["🙂", "🦊", "🐢", "🐝", "🐙", "🐳", "🦉", "🐼", "🦄", "🐧", "🐰", "🐨", "🦁", "🐸", "🦋", "🌸"];

// The canonical people roster: accounts vs placeholders, add / rename / remove.
// (Token merge + claim-to-account are a later refinement — noted in CLAUDE.md.)
export default function People({ people, refreshKey, onChanged, onOpenPerson }) {
  const [seg, setSeg] = useState("all"); // all | accounts | placeholders
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [mergeMode, setMergeMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set()); // person ids; persists across tabs
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [merging, setMerging] = useState(false);
  const self = (people || []).find((p) => p.is_self);

  // merged placeholders are hidden from the roster (they still exist in `people`,
  // just filtered out here). Un-merge UI is a later concern.
  const visible = (people || []).filter((p) => !p.merged_into_id);

  const query = q.trim().toLowerCase();
  const list = visible
    .filter((p) => (seg === "accounts" ? !p.is_token : seg === "placeholders" ? p.is_token && !p.is_self : true))
    .filter((p) => !query || p.display_name.toLowerCase().includes(query) || (p.is_self && "you".includes(query)))
    .sort((a, b) => (a.is_self ? -1 : b.is_self ? 1 : a.display_name.localeCompare(b.display_name)));

  const accounts = visible.filter((p) => !p.is_token).length;
  const placeholders = visible.filter((p) => p.is_token && !p.is_self).length;

  async function addPerson(name, emoji) {
    const owner_id = self?.owner_id;
    await supabase.from("people").insert({ owner_id, display_name: name, is_token: true, avatar_emoji: emoji });
    setAdding(false);
    onChanged();
  }

  // --- merge mode helpers ---
  // Merge = "these people are really ONE person; keep this one." Target
  // precedence: self > account > placeholder (user picks if all placeholders).
  const selectedArr = [...selected];
  const selectedPeople = selectedArr
    .map((id) => visible.find((p) => p.id === id))
    .filter(Boolean);
  const selfSelected = selectedPeople.find((p) => p.is_self);
  const accountSelected = selectedPeople.find((p) => !p.is_token && !p.is_self);
  const autoTarget = selfSelected || accountSelected || null;
  const realSelectedCount = selectedPeople.filter((p) => p.is_self || (!p.is_token && !p.is_self)).length;
  const isLegal = realSelectedCount <= 1;
  const mergeEnabled = selectedArr.length >= 2 && isLegal;
  const mergeN = selectedArr.length;

  function toggleSelect(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exitMergeMode() {
    setMergeMode(false);
    setSelected(new Set());
    setConfirmMerge(false);
  }

  async function doMerge(target) {
    if (!target || merging) return;
    setMerging(true);
    const toMerge = selectedArr.filter((id) => id !== target.id);
    for (const pid of toMerge) {
      await mergePerson(pid, target.id);
    }
    setMerging(false);
    exitMergeMode();
    onChanged();
  }

  const segBtn = (id, label, count) => {
    const active = seg === id;
    return (
      <button onClick={() => setSeg(id)} style={{ flex: 1, height: 34, borderRadius: 9, background: active ? "var(--surface)" : "transparent", border: active ? "1px solid var(--hairline)" : "1px solid transparent", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 13.5, fontWeight: active ? 600 : 500, color: active ? "var(--text)" : "var(--text-3)" }}>
        {label}<span className="mono" style={{ fontSize: 10, color: "var(--text-4)" }}>{count}</span>
      </button>
    );
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      <div style={{ padding: "26px 24px 14px", borderBottom: "1px solid var(--hairline)", flex: "none", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.01em" }}>People</div>
        {mergeMode ? (
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={exitMergeMode} className="mono" style={{ fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-3)", border: "1px solid #C9C4B7", borderRadius: 18, padding: "8px 13px", background: "var(--bg)" }}>Cancel</button>
            <button onClick={() => setConfirmMerge(true)} disabled={!mergeEnabled} className="mono" style={{ fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "#fff", border: "1px solid var(--accent)", borderRadius: 18, padding: "8px 13px", background: "var(--accent)", opacity: mergeEnabled ? 1 : 0.4 }}>Merge ({mergeN})</button>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => { setMergeMode(true); setSelected(new Set()); }} className="mono" style={{ fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text)", border: "1px solid #C9C4B7", borderRadius: 18, padding: "8px 13px", background: "var(--bg)" }}>Merge</button>
            <button onClick={() => setAdding(true)} className="mono" style={{ fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text)", border: "1px solid #C9C4B7", borderRadius: 18, padding: "8px 13px", background: "var(--bg)" }}>+ Add person</button>
          </div>
        )}
      </div>

      <div style={{ padding: "14px 20px 12px", borderBottom: "1px solid var(--hairline)", flex: "none", display: "flex", flexDirection: "column", gap: 12 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" style={{ height: 40, padding: "0 14px", background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: 12, fontSize: 15, outline: "none" }} />
        <div style={{ display: "flex", gap: 4, background: "var(--bg)", border: "1px solid var(--hairline)", borderRadius: 12, padding: 3 }}>
          {segBtn("all", "All", padIndex(visible.length))}
          {segBtn("accounts", "Accounts", padIndex(accounts))}
          {segBtn("placeholders", "Placeholders", padIndex(placeholders))}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "8px 12px 120px" }}>
        {list.length === 0 ? (
          <div style={{ textAlign: "center", padding: "60px 0", color: "var(--text-3)", fontSize: 14 }}>No people here.</div>
        ) : list.map((p) => {
          const isSelf = p.is_self;
          const isAccount = !p.is_token && !isSelf;
          const isReal = isSelf || isAccount;
          // at most ONE real identity (self or account) may be checked; once one
          // is checked, other real rows fade + become un-checkable. Placeholders
          // always stay checkable. Self can only be a target, never merged away.
          const checkedRealId = selfSelected ? selfSelected.id : (accountSelected ? accountSelected.id : null);
          const realLocked = mergeMode && !!checkedRealId && isReal && p.id !== checkedRealId;
          const checked = selected.has(p.id);
          const rowOpacity = mergeMode ? (realLocked ? 0.4 : 1) : 1;
          const onRowClick = mergeMode
            ? (!realLocked ? () => toggleSelect(p.id) : undefined)
            : () => onOpenPerson(p.id);
          return (
            <button key={p.id} onClick={onRowClick} style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "12px", textAlign: "left", cursor: onRowClick ? "pointer" : "default", opacity: rowOpacity }}>
              {mergeMode ? (
                <span onClick={onRowClick ? (e) => { e.stopPropagation(); toggleSelect(p.id); } : undefined} style={{ width: 22, height: 22, borderRadius: 6, border: checked ? "1.5px solid var(--accent)" : "1.5px solid var(--hairline)", background: checked ? "var(--accent)" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flex: "none", color: "#fff", fontSize: 14, fontWeight: 700 }}>{checked ? "✓" : ""}</span>
              ) : null}
              <span style={{ width: 40, height: 40, borderRadius: "50%", background: p.avatar_color || "var(--knob-off)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flex: "none" }}>{p.avatar_emoji || "🙂"}</span>
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ fontSize: 15.5, fontWeight: 500 }}>{p.display_name}</span>
                <span className="mono" style={{ fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-3)" }}>{isSelf ? "you" : p.is_token ? "placeholder" : "account"}</span>
              </span>
              {!mergeMode && <span className="mono" style={{ fontSize: 12, color: "var(--text-4)", flex: "none" }}>›</span>}
            </button>
          );
        })}
      </div>

      {adding && <EditSheet title="Add person" onSave={addPerson} onClose={() => setAdding(false)} />}
      {confirmMerge && mergeEnabled && (
        <MergeConfirmSheet
          candidates={selectedPeople}
          autoTarget={autoTarget}
          totalCount={selectedArr.length}
          busy={merging}
          onConfirm={doMerge}
          onClose={() => setConfirmMerge(false)}
        />
      )}
    </div>
  );
}

// merge confirm bottom sheet (reuses the EditSheet sheet pattern)
// When autoTarget is set (self/account checked), shows confirm copy directly.
// When all checked are placeholders, asks "Which name do you want to keep?"
// and lists the checked people as tappable options; confirm is disabled until
// one is picked.
export function MergeConfirmSheet({ candidates, autoTarget, totalCount, busy, onConfirm, onClose }) {
  const [picked, setPicked] = useState(null);
  const target = autoTarget || picked;
  const othersCount = totalCount - 1;
  const canConfirm = !!target && !busy;

  return (
    <div onClick={busy ? undefined : onClose} style={{ position: "absolute", inset: 0, background: "var(--scrim-sheet)", zIndex: 50, animation: "fadeIn 140ms ease" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", left: 0, right: 0, bottom: 0, background: "var(--surface)", borderTop: "1px solid var(--hairline)", borderRadius: "var(--r-sheet) var(--r-sheet) 0 0", padding: "14px 20px 24px", animation: "sheetIn 240ms var(--ease)" }}>
        <div style={{ width: 36, height: 3, borderRadius: 2, background: "#DCD6C6", margin: "0 auto 14px" }} />
        {target ? (
          <>
            <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em", marginBottom: 10 }}>Merge {othersCount} other{othersCount > 1 ? "s" : ""} into {target.display_name}?</div>
            <div style={{ fontSize: 13.5, color: "var(--text-2)", lineHeight: 1.5, marginBottom: 18 }}>
              Their history moves to {target.display_name}. You can undo this later.
            </div>
          </>
        ) : (
          <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em", marginBottom: 14 }}>Which name do you want to keep?</div>
        )}
        {!autoTarget && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 18 }}>
            {candidates.map((p) => {
              const isPicked = picked && picked.id === p.id;
              return (
                <div key={p.id} onClick={busy ? undefined : () => setPicked(p)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 12, background: isPicked ? "var(--bg-press)" : "var(--bg)", border: isPicked ? "1.5px solid var(--accent)" : "1px solid var(--hairline)", cursor: "pointer" }}>
                  <span style={{ width: 36, height: 36, borderRadius: "50%", background: p.avatar_color || "var(--knob-off)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flex: "none" }}>{p.avatar_emoji || "🙂"}</span>
                  <span style={{ flex: 1, fontSize: 15, fontWeight: 500 }}>{p.display_name}</span>
                  {isPicked && <span style={{ color: "var(--accent)", fontSize: 14, fontWeight: 700 }}>✓</span>}
                </div>
              );
            })}
          </div>
        )}
        <div style={{ display: "flex", gap: 10 }}>
          <div onClick={busy ? undefined : onClose} style={{ flex: 1, height: 48, border: "1px solid var(--hairline)", borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 600, cursor: busy ? "default" : "pointer" }}>Cancel</div>
          <div onClick={canConfirm ? () => onConfirm(target) : undefined} style={{ flex: 1, height: 48, background: "var(--accent)", color: "#fff", borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 600, cursor: canConfirm ? "pointer" : "default", opacity: target ? 1 : 0.4 }}>{busy ? "Merging…" : "Merge"}</div>
        </div>
      </div>
    </div>
  );
}

// add / edit bottom sheet
export function EditSheet({ title, person, refCount = 0, onSave, onRemove, onClose }) {
  const [name, setName] = useState(person?.display_name || "");
  const [emoji, setEmoji] = useState(person?.avatar_emoji || "🙂");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const canSave = name.trim().length > 0;

  return (
    <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "var(--scrim-sheet)", zIndex: 50, animation: "fadeIn 140ms ease" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", left: 0, right: 0, bottom: 0, background: "var(--surface)", borderTop: "1px solid var(--hairline)", borderRadius: "var(--r-sheet) var(--r-sheet) 0 0", padding: "14px 20px 24px", animation: "sheetIn 240ms var(--ease)" }}>
        <div style={{ width: 36, height: 3, borderRadius: 2, background: "#DCD6C6", margin: "0 auto 14px" }} />
        <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em", marginBottom: 14 }}>{title}</div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
          <span style={{ width: 48, height: 48, borderRadius: "50%", background: person?.avatar_color || "var(--knob-off)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flex: "none" }}>{emoji}</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" style={{ flex: 1, height: 44, background: "var(--bg)", border: "1px solid var(--hairline)", borderRadius: 12, fontSize: 16, outline: "none", padding: "0 14px" }} />
        </div>

        <div className="legend" style={{ marginBottom: 8 }}>Emoji</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
          {EMOJI.map((e) => (
            <button key={e} onClick={() => setEmoji(e)} style={{ width: 38, height: 38, borderRadius: "50%", fontSize: 18, background: e === emoji ? "var(--bg-press)" : "var(--bg)", border: e === emoji ? "1.5px solid var(--accent)" : "1px solid var(--hairline)" }}>{e}</button>
          ))}
        </div>

        <button onClick={() => canSave && onSave(name.trim(), emoji)} disabled={!canSave} style={{ width: "100%", height: 48, borderRadius: 14, background: "var(--accent)", color: "#fff", fontSize: 15, fontWeight: 600, opacity: canSave ? 1 : 0.4 }}>Save</button>

        {onRemove && (
          confirmRemove ? (
            <div style={{ marginTop: 12, padding: "12px 14px", background: "var(--bg)", border: "1px solid var(--hairline)", borderRadius: 12 }}>
              <div style={{ fontSize: 12.5, color: refCount ? "var(--open)" : "var(--text-2)", lineHeight: 1.5, marginBottom: 10 }}>
                {refCount ? `${person.display_name} is in ${refCount} expense${refCount > 1 ? "s" : ""} — removing isn’t possible while they’re referenced.` : `Remove ${person.display_name}? This can’t be undone.`}
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <div onClick={() => setConfirmRemove(false)} style={{ flex: 1, height: 38, border: "1px solid var(--hairline)", borderRadius: 19, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</div>
                {!refCount && <div onClick={onRemove} style={{ flex: 1, height: 38, background: "#B23B2E", color: "#fff", borderRadius: 19, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Remove</div>}
              </div>
            </div>
          ) : (
            <button onClick={() => setConfirmRemove(true)} style={{ width: "100%", height: 44, marginTop: 10, fontSize: 13.5, color: "#B23B2E", fontWeight: 500 }}>Remove person</button>
          )
        )}
      </div>
    </div>
  );
}
