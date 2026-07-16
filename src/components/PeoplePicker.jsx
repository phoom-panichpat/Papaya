import { useState } from "react";
import { MergeConfirmSheet } from "../screens/People";

function Avatar({ p, selected }) {
  const label = p.is_self ? "You" : p.display_name;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, width: 66 }}>
      <div style={{
        width: 44, height: 44, borderRadius: "50%",
        background: p.avatar_color || "var(--knob-off)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 20, position: "relative",
        boxShadow: selected ? "0 0 0 2px var(--surface), 0 0 0 4px var(--accent)" : "none",
      }}>
        {p.avatar_emoji || "🙂"}
        {selected && (
          <span style={{ position: "absolute", top: -3, right: -3, width: 17, height: 17, borderRadius: "50%", background: "var(--accent)", color: "#fff", fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>✓</span>
        )}
      </div>
      <span style={{ fontSize: 11, color: "var(--text-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 66 }}>{label}</span>
    </div>
  );
}

export default function PeoplePicker({ people, selectedIds, multi = true, memberIds = [], title = "Who's in", onToggle, onClose, onCreate, onEveryone, onClear, suggestions = [], onAddPeople, onMergePeople }) {
  const [q, setQ] = useState("");
  const [mergeMode, setMergeMode] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [confirmMerge, setConfirmMerge] = useState(false);
  const query = q.trim().toLowerCase();
  const match = (p) => p.display_name.toLowerCase().includes(query) || (p.is_self && "you".includes(query));
  const filtered = query ? people.filter(match) : people;
  const exact = people.some((p) => p.display_name.toLowerCase() === query);
  const inRec = filtered.filter((p) => memberIds.includes(p.id));
  const others = filtered.filter((p) => !memberIds.includes(p.id));

  function Group({ label, list }) {
    if (!list.length) return null;
    return (
      <>
        <div className="legend" style={{ margin: "16px 0 8px" }}>{label}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {list.map((p) => (
            <button key={p.id} onClick={() => onToggle(p)} style={{ padding: 0 }}>
              <Avatar p={p} selected={selectedIds.has(p.id)} />
            </button>
          ))}
        </div>
      </>
    );
  }

  // ── merge-mode helpers (mirror People.jsx's rules exactly) ──
  const selectedArr = [...selected];
  const selectedPeople = selectedArr.map((id) => people.find((p) => p.id === id)).filter(Boolean);
  const selfSelected = selectedPeople.find((p) => p.is_self);
  const accountSelected = selectedPeople.find((p) => !p.is_token && !p.is_self);
  const autoTarget = selfSelected || accountSelected || null;
  const realSelectedCount = selectedPeople.filter((p) => p.is_self || (!p.is_token && !p.is_self)).length;
  const isLegal = realSelectedCount <= 1;
  const mergeEnabled = selectedArr.length >= 2 && isLegal;
  const checkedRealId = selfSelected ? selfSelected.id : (accountSelected ? accountSelected.id : null);

  function toggleSelect(id) {
    setSelected((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  async function doMerge(target) {
    await onMergePeople(selectedArr.filter((id) => id !== target.id), target.id);
    setConfirmMerge(false);
    setMergeMode(false);
    setSelected(new Set());
    setQ("");
  }

  const mergeRows = people.filter(match);

  return (
    <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "var(--scrim-sheet)", zIndex: 40, animation: "fadeIn 140ms ease" }}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "84%", background: "var(--surface)", borderTop: "1px solid var(--hairline)", borderRadius: "var(--r-sheet) var(--r-sheet) 0 0", padding: "14px 20px 24px", animation: "sheetIn 240ms var(--ease)", display: "flex", flexDirection: "column" }}
      >
        <div style={{ width: 36, height: 3, borderRadius: 2, background: "#DCD6C6", margin: "0 auto 14px" }} />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>{mergeMode ? "Merge" : title}</span>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {onMergePeople && !mergeMode && (
              <button onClick={() => { setMergeMode(true); setSelected(new Set()); }} className="mono" style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-3)" }}>Merge</button>
            )}
            {multi && (
              <button onClick={mergeMode ? () => { setMergeMode(false); setSelected(new Set()); setQ(""); } : onClose} style={{ color: "var(--accent)", fontSize: 14, fontWeight: 600 }}>{mergeMode ? "Cancel" : "Done"}</button>
            )}
          </div>
        </div>

        {mergeMode ? (
          <>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search"
              style={{ height: 42, padding: "0 14px", background: "var(--bg)", border: "1px solid var(--hairline)", borderRadius: 12, fontSize: 15, outline: "none", flex: "none" }}
            />
            <div style={{ overflowY: "auto", marginTop: 4 }}>
              {mergeRows.map((p) => {
                const isSelf = p.is_self;
                const isAccount = !p.is_token && !isSelf;
                const isReal = isSelf || isAccount;
                const realLocked = !!checkedRealId && isReal && p.id !== checkedRealId;
                const checked = selected.has(p.id);
                const rowOpacity = realLocked ? 0.4 : 1;
                const onRowClick = !realLocked ? () => toggleSelect(p.id) : undefined;
                return (
                  <div key={p.id} onClick={onRowClick} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 4px", borderBottom: "1px solid var(--hairline-3)", cursor: onRowClick ? "pointer" : "default", opacity: rowOpacity }}>
                    <span style={{ width: 22, height: 22, borderRadius: 6, border: checked ? "1.5px solid var(--accent)" : "1.5px solid var(--hairline)", background: checked ? "var(--accent)" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flex: "none", color: "#fff", fontSize: 14, fontWeight: 700 }}>{checked ? "✓" : ""}</span>
                    <span style={{ width: 40, height: 40, borderRadius: "50%", background: p.avatar_color || "var(--knob-off)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flex: "none" }}>{p.avatar_emoji || "🙂"}</span>
                    <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                      <span style={{ fontSize: 15, fontWeight: 500 }}>{p.is_self ? "You" : p.display_name}</span>
                      <span className="mono" style={{ fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-3)" }}>{isSelf ? "you" : p.is_token ? "placeholder" : "account"}</span>
                    </span>
                  </div>
                );
              })}
              {mergeRows.length === 0 && <div style={{ color: "var(--text-3)", fontSize: 14, padding: "20px 0", textAlign: "center" }}>No matches.</div>}
            </div>
            <button onClick={() => setConfirmMerge(true)} disabled={!mergeEnabled} className="mono" style={{ marginTop: 12, height: 44, borderRadius: 14, background: mergeEnabled ? "var(--accent)" : "var(--bg)", color: mergeEnabled ? "#fff" : "var(--text-3)", border: mergeEnabled ? "1px solid var(--accent)" : "1px solid var(--hairline)", fontSize: 13, letterSpacing: "0.06em", textTransform: "uppercase", opacity: mergeEnabled ? 1 : 0.4 }}>Merge ({selectedArr.length})</button>
          </>
        ) : (
          <>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search or type to add"
              style={{ height: 42, padding: "0 14px", background: "var(--bg)", border: "1px solid var(--hairline)", borderRadius: 12, fontSize: 15, outline: "none", flex: "none" }}
            />
            {multi && (onEveryone || onClear) && (
              <div style={{ display: "flex", gap: 8, marginTop: 12, flex: "none" }}>
                {onEveryone && (
                  <button onClick={onEveryone} style={{ height: 32, padding: "0 14px", borderRadius: 999, border: "1px solid var(--hairline)", background: "var(--bg)", fontSize: 13, fontWeight: 500 }}>Everyone</button>
                )}
                {onClear && (
                  <button onClick={onClear} style={{ height: 32, padding: "0 14px", borderRadius: 999, border: "1px solid var(--hairline)", background: "var(--bg)", fontSize: 13, fontWeight: 500, color: "var(--text-2)" }}>Clear</button>
                )}
              </div>
            )}
            {multi && onAddPeople && suggestions.length > 0 && (
              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", flex: "none" }}>
                {suggestions.map((s) => {
                  const done = s.ids.every((id) => selectedIds.has(id));
                  return (
                    <button
                      key={s.label}
                      onClick={() => onAddPeople(s.ids)}
                      disabled={done}
                      style={{ display: "flex", alignItems: "center", gap: 6, height: 32, padding: "0 13px", borderRadius: 999, border: "1px solid var(--hairline)", background: "var(--bg)", fontSize: 13, fontWeight: 500, opacity: done ? 0.4 : 1 }}
                    >
                      <span style={{ color: "var(--text-3)", fontSize: 14, lineHeight: 1 }}>{done ? "✓" : "+"}</span>
                      {s.label}
                      <span className="mono" style={{ fontSize: 10, color: "var(--text-4)" }}>{s.ids.length}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <div style={{ overflowY: "auto", marginTop: 4 }}>
              {query && !exact && onCreate && (
                <button onClick={() => onCreate(q.trim())} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "14px 4px", textAlign: "left" }}>
                  <span style={{ width: 40, height: 40, borderRadius: "50%", border: "1px dashed var(--text-3)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, color: "var(--text-2)" }}>+</span>
                  <span style={{ fontSize: 15 }}>Create “{q.trim()}”</span>
                </button>
              )}
              <Group label="In this recording" list={inRec} />
              <Group label={inRec.length ? "Everyone else" : "People"} list={others} />
            </div>
          </>
        )}
      </div>

      {confirmMerge && mergeEnabled && (
        <MergeConfirmSheet
          candidates={selectedPeople}
          autoTarget={autoTarget}
          totalCount={selectedArr.length}
          busy={false}
          onConfirm={doMerge}
          onClose={() => setConfirmMerge(false)}
        />
      )}
    </div>
  );
}
