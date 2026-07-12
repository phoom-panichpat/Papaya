import { useState, useEffect, useCallback } from "react";
import { supabase } from "./lib/supabase";
import Home from "./screens/Home";
import ExpenseForm from "./screens/ExpenseForm";

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

// ─── Screen placeholder ──────────────────────────────────────────────────────
function Placeholder({ title }) {
  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.01em" }}>{title}</h1>
      <p style={{ color: "var(--text-2)", fontSize: 14, marginTop: 8 }}>Coming next.</p>
    </div>
  );
}

// ─── Bottom nav ──────────────────────────────────────────────────────────────
const TABS = [
  { id: "home", label: "home" },
  { id: "records", label: "records" },
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
  const [overlay, setOverlay] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
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

  function closeOverlay(changed) {
    setOverlay(null);
    if (changed) {
      setRefreshKey((k) => k + 1);
      loadPeople();
    }
  }

  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {tab === "home" && <Home people={people} refreshKey={refreshKey} onNewExpense={() => setOverlay({ type: "expense" })} />}
        {tab === "records" && <Placeholder title="Records" />}
        {tab === "settlement" && <Placeholder title="Settlement" />}
      </div>
      <BottomNav tab={tab} setTab={setTab} />

      {overlay?.type === "expense" && <ExpenseForm people={people} onClose={closeOverlay} />}
    </div>
  );
}
