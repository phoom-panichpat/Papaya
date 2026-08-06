import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./lib/supabase";
import { useBackLayer, BACK_LEVEL } from "./lib/backstack.jsx";
import Home from "./screens/Home";
import ExpenseForm from "./screens/ExpenseForm";
import People from "./screens/People";
import CreateRecording from "./screens/CreateRecording";
import RecordingDetail from "./screens/RecordingDetail";
import ExpenseDetail from "./screens/ExpenseDetail";
import Settlement from "./screens/Settlement";
import RecordSettleSheet from "./screens/RecordSettleSheet";
import Settings from "./screens/Settings";
import PersonDetail from "./screens/PersonDetail";

// ─── Splash ────────────────────────────────────────────────────────────────
function Splash() {
  return (
    <div style={{ height: "100%", display: "grid", placeItems: "center", background: "var(--bg)" }}>
      <span style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.01em" }}>Papaya</span>
    </div>
  );
}

// ─── Minimal auth (styled placeholder; full auth screen comes in phase 2) ────
function AuthScreen() {
  const [mode, setMode] = useState("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setMsg("");
    if (mode === "signin") {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setMsg(error.message || "Sign in failed.");
    } else {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { full_name: name } },
      });
      if (error) setMsg(error.message || "Sign up failed.");
    }
    setBusy(false);
  }

  // dev-only: lets a local agent/tester see the real UI without a password.
  // full_name is required — an anonymous user has no email, and
  // handle_new_user's fallback (split_part(email, '@', 1)) would be null,
  // which profiles.display_name (not null) rejects.
  async function guestSignIn() {
    setBusy(true);
    setMsg("");
    const { error } = await supabase.auth.signInAnonymously({
      options: { data: { full_name: "Guest" } },
    });
    if (error) setMsg(error.message || "Guest sign-in failed. Enable Anonymous Sign-Ins in Supabase → Authentication → Sign In / Providers.");
    setBusy(false);
  }

  const field = {
    width: "100%",
    height: 46,
    padding: "0 14px",
    background: "var(--surface)",
    border: "1px solid var(--hairline)",
    borderRadius: 12,
    fontSize: 15,
    outline: "none",
  };

  return (
    // the shell no longer lets the document scroll, so this one scrolls itself
    // (keyboard open on a short screen would otherwise clip the form)
    <div style={{ minHeight: "100%", maxHeight: "100%", overflowY: "auto", display: "flex", flexDirection: "column", justifyContent: "center", padding: "40px 24px", gap: 20 }}>
      <div style={{ textAlign: "center" }}>
        <h1 style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em" }}>Papaya</h1>
        <p style={{ color: "var(--text-2)", fontSize: 14, marginTop: 4 }}>Split expenses with friends</p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {mode === "signup" && (
          <input style={field} placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
        )}
        <input style={field} type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input
          style={field}
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        {msg && <p style={{ fontSize: 13, color: "var(--accent)" }}>{msg}</p>}
        <button
          onClick={submit}
          disabled={busy}
          style={{
            height: 46,
            background: "var(--text)",
            color: "var(--surface)",
            borderRadius: 12,
            fontSize: 15,
            fontWeight: 600,
            opacity: busy ? 0.5 : 1,
          }}
        >
          {busy ? "…" : mode === "signin" ? "Sign in" : "Create account"}
        </button>
      </div>

      <button
        onClick={() => {
          setMode((m) => (m === "signin" ? "signup" : "signin"));
          setMsg("");
        }}
        style={{ color: "var(--text-2)", fontSize: 14, padding: 8 }}
      >
        {mode === "signin" ? "No account? Create one" : "Have an account? Sign in"}
      </button>

      {import.meta.env.DEV && (
        <button
          onClick={guestSignIn}
          disabled={busy}
          style={{ color: "var(--text-3)", fontSize: 12, padding: 8, border: "1px dashed var(--hairline)", borderRadius: 10 }}
        >
          {busy ? "…" : "Dev: continue as guest"}
        </button>
      )}
    </div>
  );
}

// ─── Stub sheet (for screens not built yet: Settings) ────────────────────────
function StubSheet({ title, onClose }) {
  return (
    <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "var(--scrim-sheet)", zIndex: 60, animation: "fadeIn 140ms ease" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", left: 0, right: 0, bottom: 0, background: "var(--surface)", borderTop: "1px solid var(--hairline)", borderRadius: "var(--r-sheet) var(--r-sheet) 0 0", padding: "20px 24px 28px", animation: "sheetIn 240ms var(--ease)" }}>
        <div style={{ width: 36, height: 3, borderRadius: 2, background: "#DCD6C6", margin: "0 auto 18px" }} />
        <div className="legend" style={{ color: "var(--text-3)" }}>stub</div>
        <div style={{ fontSize: 18, fontWeight: 600, marginTop: 6, letterSpacing: "-0.01em" }}>{title}</div>
        <div style={{ fontSize: 12.5, color: "var(--text-2)", marginTop: 6, lineHeight: 1.55 }}>Coming in a later build phase.</div>
        <div onClick={onClose} style={{ height: 40, border: "1px solid var(--hairline)", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, cursor: "pointer", marginTop: 20 }}>Close</div>
      </div>
    </div>
  );
}

// ─── Bottom nav ──────────────────────────────────────────────────────────────
const TABS = [
  { id: "home", label: "home" },
  { id: "people", label: "people" },
  { id: "settlement", label: "settlement" },
];

function BottomNav({ tab, setTab }) {
  return (
    <div style={{ height: 64, borderTop: "1px solid var(--hairline)", background: "var(--bg)", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", flex: "none" }}>
      {TABS.map((t) => {
        const active = t.id === tab;
        return (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4 }}
          >
            <span style={{ fontSize: 14, fontWeight: active ? 600 : 400, color: active ? "var(--text)" : "var(--text-3)" }}>{t.label}</span>
            {active && <span style={{ width: 16, height: 2, background: "var(--text)", borderRadius: 1 }} />}
          </button>
        );
      })}
    </div>
  );
}

// ─── App root ────────────────────────────────────────────────────────────────
export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("home");
  // Lazy-mount + keep-mounted: a tab mounts on first visit, then stays mounted
  // (hidden via CSS) so revisits are instant with no refetch.
  const [visited, setVisited] = useState({ home: true });
  useEffect(() => { setVisited((v) => (v[tab] ? v : { ...v, [tab]: true })); }, [tab]);
  const [people, setPeople] = useState([]);
  const [homeCurrency, setHomeCurrency] = useState("THB");
  const [stack, setStack] = useState([]); // overlay stack: full-screen pushed screens
  const [stub, setStub] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // Archive pop is deferred: after an archive/unarchive write, we bump refreshKey
  // (underlying screen re-fetches) but keep the detail mounted (showing its busy
  // state) until that screen reports fresh, THEN pop — so the revealed list is
  // already correct (no "item lingers then vanishes" flash). loadedTick ticks
  // each time a tab screen finishes loading; the effect pops if one is pending.
  const pendingPop = useRef(false);
  const [loadedTick, setLoadedTick] = useState(0);
  const handleLoaded = useCallback(() => setLoadedTick((t) => t + 1), []);
  useEffect(() => {
    if (pendingPop.current) {
      pendingPop.current = false;
      setStack((s) => s.slice(0, -1));
    }
  }, [loadedTick]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      if (!s) { setStack([]); setTab("home"); setStub(null); }
    });
    return () => subscription.unsubscribe();
  }, []);

  const loadPeople = useCallback(async () => {
    if (!session) return;
    const { data } = await supabase.from("people").select("*");
    setPeople(data || []);
  }, [session]);

  useEffect(() => { loadPeople(); }, [loadPeople]);

  // Home currency lives here, loaded once, so screens don't each re-fetch the
  // profile row on every open. Reloaded on popOverlay(changed) — Settings is the
  // only writer. (Other screens still fetch it themselves; folding them onto this
  // prop belongs with the currency-invariant work — see CLAUDE.md §8.)
  const loadProfile = useCallback(async () => {
    if (!session) return;
    const { data } = await supabase.from("profiles").select("home_currency").maybeSingle();
    if (data?.home_currency) setHomeCurrency(data.home_currency);
  }, [session]);

  useEffect(() => { loadProfile(); }, [loadProfile]);

  // Hardware back: a bottom tab other than Home is a layer, so back returns to
  // Home and only THEN exits the app (the Android convention). Pushed overlay
  // screens register their own layers — each one owns its back semantics,
  // guards included (see ExpenseForm's discard confirm).
  useBackLayer(tab !== "home", () => setTab("home"), BACK_LEVEL.TAB);
  useBackLayer(!!stub, () => setStub(null));

  if (loading) return <Splash />;
  if (!session) return <AuthScreen />;

  const push = (o) => setStack((s) => [...s, o]);
  const openExpense = (id) => push({ type: "expenseDetail", id });
  function popOverlay(changed) {
    setStack((s) => s.slice(0, -1));
    if (changed) {
      setRefreshKey((k) => k + 1);
      loadPeople();
      loadProfile();
    }
  }
  // Archive/unarchive close: refresh the underlying screen, then pop once it's
  // fresh (see pendingPop above). The detail stays mounted (busy) until then.
  // Safety net: if no screen reports loaded within 1.5s, pop anyway.
  function archiveClose() {
    setRefreshKey((k) => k + 1);
    loadPeople();
    pendingPop.current = true;
    setTimeout(() => {
      if (pendingPop.current) { pendingPop.current = false; setStack((s) => s.slice(0, -1)); }
    }, 1500);
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {visited.home && (
          <div style={{ position: "absolute", inset: 0, display: tab === "home" ? "block" : "none" }}>
            <Home
              people={people}
              refreshKey={refreshKey}
              onLoaded={tab === "home" ? handleLoaded : undefined}
              onNewExpense={() => push({ type: "expense" })}
              onOpenExpense={openExpense}
              onOpenRecording={(id) => push({ type: "recordingDetail", id })}
              onNewRecording={() => push({ type: "createRecording" })}
              onOpenSettings={() => push({ type: "settings" })}
            />
          </div>
        )}
        {visited.people && (
          <div style={{ position: "absolute", inset: 0, display: tab === "people" ? "block" : "none" }}>
            <People
              people={people}
              active={tab === "people"}
              refreshKey={refreshKey}
              onChanged={() => { loadPeople(); setRefreshKey((k) => k + 1); }}
              onOpenPerson={(id) => push({ type: "personDetail", id })}
            />
          </div>
        )}
        {visited.settlement && (
          <div style={{ position: "absolute", inset: 0, display: tab === "settlement" ? "block" : "none" }}>
            <Settlement people={people} active={tab === "settlement"} refreshKey={refreshKey} onLoaded={tab === "settlement" ? handleLoaded : undefined} onOpenExpense={openExpense} onOpenRecording={(id) => push({ type: "recordingDetail", id })} />
          </div>
        )}
      </div>
      <BottomNav tab={tab} setTab={setTab} />

      {/* overlay stack — each pushed screen renders above the previous */}
      {stack.map((o, i) => {
        const key = `${o.type}-${i}`;
        let el = null;
        if (o.type === "expense") el = <ExpenseForm people={people} forceRecordingId={o.recordingId || null} editExpenseId={o.editExpenseId || null} onClose={popOverlay} />;
        else if (o.type === "createRecording") el = <CreateRecording people={people} editRecordingId={o.editRecordingId || null} onClose={popOverlay} />;
        else if (o.type === "recordingDetail")
          el = (
            <RecordingDetail
              recordingId={o.id}
              people={people}
              refreshKey={refreshKey}
              onAddExpense={() => push({ type: "expense", recordingId: o.id })}
              onOpenExpense={openExpense}
              onSettle={() => push({ type: "recordSettle", id: o.id })}
              onEdit={(id) => push({ type: "createRecording", editRecordingId: id })}
              onArchiveClose={archiveClose}
              onClose={popOverlay}
            />
          );
        else if (o.type === "expenseDetail")
          el = (
            <ExpenseDetail
              expenseId={o.id}
              people={people}
              refreshKey={refreshKey}
              onEdit={(id) => push({ type: "expense", editExpenseId: id })}
              onArchiveClose={archiveClose}
              onClose={popOverlay}
            />
          );
        else if (o.type === "recordSettle") el = <RecordSettleSheet recordingId={o.id} people={people} onClose={() => popOverlay(true)} />;
        else if (o.type === "settings") el = <Settings people={people} email={session.user?.email || ""} homeCurrency={homeCurrency} onClose={popOverlay} />;
        else if (o.type === "personDetail")
          el = (
            <PersonDetail
              personId={o.id}
              people={people}
              refreshKey={refreshKey}
              onOpenExpense={openExpense}
              onOpenRecording={(id) => push({ type: "recordingDetail", id })}
              onChanged={() => { loadPeople(); setRefreshKey((k) => k + 1); }}
              onClose={popOverlay}
            />
          );
        if (!el) return null;
        return <div key={key} style={{ position: "absolute", inset: 0, zIndex: 50 + i }}>{el}</div>;
      })}

      {stub && <StubSheet title={stub} onClose={() => setStub(null)} />}
    </div>
  );
}
