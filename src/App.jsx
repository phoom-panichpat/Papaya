import { useState, useEffect, useCallback } from "react";
import { supabase } from "./lib/supabase";
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
    <div style={{ height: "100dvh", display: "grid", placeItems: "center", background: "var(--bg)" }}>
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
    <div style={{ minHeight: "100dvh", display: "flex", flexDirection: "column", justifyContent: "center", padding: "40px 24px", gap: 20 }}>
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
  const [people, setPeople] = useState([]);
  const [stack, setStack] = useState([]); // overlay stack: full-screen pushed screens
  const [stub, setStub] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

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

  if (loading) return <Splash />;
  if (!session) return <AuthScreen />;

  const push = (o) => setStack((s) => [...s, o]);
  const openExpense = (id) => push({ type: "expenseDetail", id });
  function popOverlay(changed) {
    setStack((s) => s.slice(0, -1));
    if (changed) {
      setRefreshKey((k) => k + 1);
      loadPeople();
    }
  }

  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {tab === "home" && (
          <Home
            people={people}
            refreshKey={refreshKey}
            onNewExpense={() => push({ type: "expense" })}
            onOpenExpense={openExpense}
            onOpenRecording={(id) => push({ type: "recordingDetail", id })}
            onNewRecording={() => push({ type: "createRecording" })}
            onOpenSettings={() => push({ type: "settings" })}
          />
        )}
        {tab === "people" && (
          <People
            people={people}
            refreshKey={refreshKey}
            onChanged={() => { loadPeople(); setRefreshKey((k) => k + 1); }}
            onOpenPerson={(id) => push({ type: "personDetail", id })}
          />
        )}
        {tab === "settlement" && <Settlement people={people} refreshKey={refreshKey} onOpenExpense={openExpense} onOpenRecording={(id) => push({ type: "recordingDetail", id })} />}
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
              onClose={() => popOverlay(false)}
            />
          );
        else if (o.type === "expenseDetail")
          el = (
            <ExpenseDetail
              expenseId={o.id}
              people={people}
              refreshKey={refreshKey}
              onEdit={(id) => push({ type: "expense", editExpenseId: id })}
              onClose={popOverlay}
            />
          );
        else if (o.type === "recordSettle") el = <RecordSettleSheet recordingId={o.id} people={people} onClose={() => popOverlay(true)} />;
        else if (o.type === "settings") el = <Settings people={people} onClose={popOverlay} />;
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
