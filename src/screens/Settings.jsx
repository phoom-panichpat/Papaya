import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase";
import { currencySymbol } from "../lib/format";

// The canonical currency list — kept in sync with ExpenseForm / CreateRecording.
const CURRENCIES = ["THB", "KRW", "USD", "EUR", "JPY", "GBP", "SGD", "MYR", "LAK"];
const EMOJI = ["🙂", "🦊", "🐢", "🐝", "🐙", "🐳", "🦉", "🐼", "🦄", "🐧", "🐰", "🐨", "🦁", "🐸", "🦋", "🌸"];

// Full-screen pushed overlay (same pattern as CreateRecording / RecordingDetail).
// onClose(changed?) — passing true bumps refreshKey so mounted screens re-read
// the home currency / self person.
//
// This screen opens with ZERO network: App already holds the session (email), the
// people roster (self), and the home currency, so everything here is passed in.
// It used to re-fetch the profile row + call auth.getUser() on every open.
export default function Settings({ people, email = "", homeCurrency: homeCurrencyProp = "THB", onClose }) {
  const [homeCurrency, setHomeCurrency] = useState(homeCurrencyProp);
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const [self, setSelf] = useState(() => (people || []).find((p) => p.is_self) || null);
  const [editingSelf, setEditingSelf] = useState(false);
  const [dirty, setDirty] = useState(false); // did anything change that other screens need to re-read?
  const [signingOut, setSigningOut] = useState(false);

  // Local state so a change shows instantly; re-seed if App's value arrives late
  // (only possible if Settings is opened before App's first profile load lands).
  useEffect(() => { setHomeCurrency(homeCurrencyProp); }, [homeCurrencyProp]);

  async function changeHomeCurrency(c) {
    setCurrencyOpen(false);
    if (c === homeCurrency) return;
    const { error } = await supabase.from("profiles").update({ home_currency: c }).neq("home_currency", c);
    if (!error) { setHomeCurrency(c); setDirty(true); }
  }

  async function saveSelf(name, emoji) {
    if (!self) return;
    const { error } = await supabase.from("people").update({ display_name: name, avatar_emoji: emoji }).eq("id", self.id);
    if (!error) {
      setSelf({ ...self, display_name: name, avatar_emoji: emoji });
      setEditingSelf(false);
      setDirty(true);
    }
  }

  async function signOut() {
    setSigningOut(true);
    await supabase.auth.signOut();
    // The auth gate in App.jsx will return the user to the sign-in screen.
  }

  function close() { onClose(dirty); }

  const row = { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderTop: "1px solid var(--hairline)", minHeight: 56 };
  const label = { fontSize: 15 };

  return (
    <div style={{ position: "absolute", inset: 0, background: "var(--bg)", zIndex: 30, display: "flex", flexDirection: "column" }}>
      {/* header */}
      <div style={{ height: 54, flex: "none", display: "flex", alignItems: "center", padding: "0 12px", gap: 8 }}>
        <button onClick={close} style={{ width: 40, height: 40, fontSize: 20, borderRadius: "50%" }}>←</button>
        <div style={{ flex: 1, textAlign: "center" }}>
          <span className="legend">Settings</span>
        </div>
        <span style={{ width: 40 }} />
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "8px 0 40px" }}>
        {/* HOME CURRENCY */}
        <div style={{ padding: "18px 20px 6px" }}>
          <span className="legend">Home currency</span>
          <div className="mono" style={{ fontSize: 10.5, color: "var(--text-4)", marginTop: 8, letterSpacing: "0.04em" }}>
            Your main currency. Foreign expenses show a faded home amount beside the native one.
          </div>
        </div>
        <div style={{ ...row, cursor: "pointer" }} onClick={() => setCurrencyOpen(true)}>
          <span style={label}>{self ? "You" : "Account"}</span>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span className="mono" style={{ fontSize: 12, letterSpacing: "0.08em", color: "var(--text)" }}>{homeCurrency}</span>
            <span style={{ fontSize: 13, color: "var(--text-2)" }}>{currencySymbol(homeCurrency)}</span>
            <span className="mono" style={{ fontSize: 9, color: "var(--text-4)" }}>⌄</span>
          </span>
        </div>

        {/* PROFILE */}
        <div style={{ padding: "26px 20px 6px" }}>
          <span className="legend">Profile</span>
        </div>
        <div style={{ ...row, cursor: "pointer" }} onClick={() => self && setEditingSelf(true)}>
          <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ width: 40, height: 40, borderRadius: "50%", background: self?.avatar_color || "var(--knob-off)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flex: "none" }}>
              {self?.avatar_emoji || "🙂"}
            </span>
            <span style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={{ fontSize: 15.5, fontWeight: 500 }}>{self?.display_name || "You"}</span>
              <span className="mono" style={{ fontSize: 10, letterSpacing: "0.04em", color: "var(--text-3)" }}>{email || "—"}</span>
            </span>
          </span>
          <span className="mono" style={{ fontSize: 12, color: "var(--text-4)" }}>›</span>
        </div>

        {/* ACCOUNT */}
        <div style={{ padding: "26px 20px 6px" }}>
          <span className="legend">Account</span>
        </div>
        <div style={{ ...row, borderTop: "1px solid var(--hairline)" }}>
          <span style={{ ...label, color: "var(--text-2)" }}>{email || "—"}</span>
        </div>
        <div style={{ padding: "16px 20px 0" }}>
          <button
            onClick={signOut}
            disabled={signingOut}
            style={{ width: "100%", height: 46, borderRadius: 12, border: "1px solid var(--hairline)", background: "var(--surface)", fontSize: 15, fontWeight: 600, color: "#B23B2E", opacity: signingOut ? 0.5 : 1 }}
          >
            {signingOut ? "…" : "Sign out"}
          </button>
        </div>
      </div>

      {/* currency dropdown — mirrors CreateRecording's sheet */}
      {currencyOpen && (
        <div onClick={() => setCurrencyOpen(false)} style={{ position: "absolute", inset: 0, background: "var(--scrim-sheet)", zIndex: 40, animation: "fadeIn 140ms ease" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "70%", overflowY: "auto", background: "var(--surface)", borderTop: "1px solid var(--hairline)", borderRadius: "var(--r-sheet) var(--r-sheet) 0 0", padding: "14px 0 24px", animation: "sheetIn 240ms var(--ease)" }}>
            <div style={{ width: 36, height: 3, borderRadius: 2, background: "#DCD6C6", margin: "0 auto 8px" }} />
            <div className="legend" style={{ padding: "6px 20px 4px" }}>Home currency</div>
            {CURRENCIES.map((c) => (
              <button key={c} onClick={() => changeHomeCurrency(c)} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderTop: "1px solid var(--hairline-3)" }}>
                <span style={{ fontSize: 15 }}>{c}</span>
                <span style={{ fontSize: 16, color: "var(--text-2)" }}>{currencySymbol(c)}{c === homeCurrency ? "  ✓" : ""}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* edit self person — mirrors People's EditSheet */}
      {editingSelf && self && (
        <EditSelfSheet
          person={self}
          onSave={saveSelf}
          onClose={() => setEditingSelf(false)}
        />
      )}
    </div>
  );
}

function EditSelfSheet({ person, onSave, onClose }) {
  const [name, setName] = useState(person.display_name || "");
  const [emoji, setEmoji] = useState(person.avatar_emoji || "🙂");
  const canSave = name.trim().length > 0;

  return (
    <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "var(--scrim-sheet)", zIndex: 50, animation: "fadeIn 140ms ease" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", left: 0, right: 0, bottom: 0, background: "var(--surface)", borderTop: "1px solid var(--hairline)", borderRadius: "var(--r-sheet) var(--r-sheet) 0 0", padding: "14px 20px 24px", animation: "sheetIn 240ms var(--ease)" }}>
        <div style={{ width: 36, height: 3, borderRadius: 2, background: "#DCD6C6", margin: "0 auto 14px" }} />
        <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em", marginBottom: 14 }}>Edit your name</div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
          <span style={{ width: 48, height: 48, borderRadius: "50%", background: person.avatar_color || "var(--knob-off)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flex: "none" }}>{emoji}</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" style={{ flex: 1, height: 44, background: "var(--bg)", border: "1px solid var(--hairline)", borderRadius: 12, fontSize: 16, outline: "none", padding: "0 14px" }} />
        </div>

        <div className="legend" style={{ marginBottom: 8 }}>Emoji</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
          {EMOJI.map((e) => (
            <button key={e} onClick={() => setEmoji(e)} style={{ width: 38, height: 38, borderRadius: "50%", fontSize: 18, background: e === emoji ? "var(--bg-press)" : "var(--bg)", border: e === emoji ? "1.5px solid var(--accent)" : "1px solid var(--hairline)" }}>{e}</button>
          ))}
        </div>

        <button onClick={() => canSave && onSave(name.trim(), emoji)} disabled={!canSave} style={{ width: "100%", height: 48, borderRadius: 14, background: "var(--accent)", color: "#fff", fontSize: 15, fontWeight: 600, opacity: canSave ? 1 : 0.4 }}>Save</button>
      </div>
    </div>
  );
}
