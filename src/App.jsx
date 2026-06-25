import { useState, useEffect, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://hahahpvxkgfvdlonubpz.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhhaGFocHZ4a2dmdmRsb251YnB6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyODgwMTIsImV4cCI6MjA5Nzg2NDAxMn0.m0hGDUwrAQzfSUyoZyA2UAZBUAohbvUS4RyDLL0CHhE";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const CURRENCIES = ["THB", "KRW", "USD", "EUR", "JPY", "LAK", "SGD", "MYR", "GBP"];
const EMOJIS = ["🧑","👩","👨","🧔","👱","🙋","🙍","🧕","👮","🧑‍🎤","🧑‍🍳","🧑‍💻","🐱","🐶","🦊","🐼","🐨","🦁","🐯","🐸"];
const COLORS = ["#FF6B6B","#4ECDC4","#45B7D1","#96CEB4","#FFEAA7","#DDA0DD","#98D8C8","#F7DC6F","#BB8FCE","#F1948A","#82E0AA","#F8C471"];

// ─── Design tokens ───────────────────────────────────────────────────────────
const theme = {
  bg: "#0F0F0F",
  surface: "#1A1A1A",
  surfaceHigh: "#242424",
  border: "#2A2A2A",
  accent: "#FF6B35",
  accentMuted: "#FF6B3520",
  text: "#F0F0F0",
  textMuted: "#888",
  textDim: "#555",
  green: "#4ADE80",
  red: "#FF6B6B",
  yellow: "#FBBF24",
};

const css = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');

  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  
  body {
    background: ${theme.bg};
    color: ${theme.text};
    font-family: 'DM Sans', sans-serif;
    min-height: 100vh;
    max-width: 480px;
    margin: 0 auto;
  }

  input, textarea, select {
    background: ${theme.surfaceHigh};
    border: 1px solid ${theme.border};
    color: ${theme.text};
    border-radius: 10px;
    padding: 12px 14px;
    font-family: 'DM Sans', sans-serif;
    font-size: 15px;
    width: 100%;
    outline: none;
    transition: border-color 0.15s;
  }
  input:focus, textarea:focus, select:focus { border-color: ${theme.accent}; }
  input::placeholder, textarea::placeholder { color: ${theme.textDim}; }
  select option { background: ${theme.surface}; }

  button { cursor: pointer; font-family: 'DM Sans', sans-serif; border: none; transition: all 0.15s; }

  .btn-primary {
    background: ${theme.accent};
    color: white;
    border-radius: 12px;
    padding: 14px 20px;
    font-size: 15px;
    font-weight: 600;
    width: 100%;
  }
  .btn-primary:active { opacity: 0.8; transform: scale(0.98); }
  .btn-primary:disabled { opacity: 0.4; }

  .btn-ghost {
    background: ${theme.surfaceHigh};
    color: ${theme.text};
    border-radius: 10px;
    padding: 10px 16px;
    font-size: 14px;
    font-weight: 500;
    border: 1px solid ${theme.border};
  }
  .btn-ghost:active { opacity: 0.7; }

  .btn-danger {
    background: transparent;
    color: ${theme.red};
    border-radius: 10px;
    padding: 10px 16px;
    font-size: 14px;
    border: 1px solid ${theme.red}40;
  }

  .card {
    background: ${theme.surface};
    border-radius: 16px;
    border: 1px solid ${theme.border};
    padding: 16px;
  }

  .label {
    font-size: 12px;
    font-weight: 500;
    color: ${theme.textMuted};
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 8px;
    display: block;
  }

  .mono { font-family: 'DM Mono', monospace; }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 500;
  }

  ::-webkit-scrollbar { width: 0; }

  .slide-up {
    animation: slideUp 0.25s ease;
  }
  @keyframes slideUp {
    from { transform: translateY(20px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  .fade-in {
    animation: fadeIn 0.2s ease;
  }
  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
`;

const styleEl = document.createElement("style");
styleEl.textContent = css;
document.head.appendChild(styleEl);

// ─── Helpers ─────────────────────────────────────────────────────────────────
function Avatar({ member, size = 36 }) {
  if (member?.avatar_url) {
    return (
      <img
        src={member.avatar_url}
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover" }}
      />
    );
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      background: member?.avatar_color || "#FF6B35",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.45, flexShrink: 0,
      border: member?.is_avatar ? `2px dashed ${member?.avatar_color || "#FF6B35"}80` : "none",
    }}>
      {member?.avatar_emoji || "🧑"}
    </div>
  );
}

function formatAmount(amount, currency) {
  const formatted = Number(amount).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return `${formatted} ${currency}`;
}

function calcSettlements(members, expenses, expenseLines, splits) {
  const balances = {};
  members.forEach(m => balances[m.id] = 0);

  expenses.forEach(exp => {
    const lines = expenseLines.filter(l => l.expense_id === exp.id);
    const rate = exp.exchange_rate || 1;

    if (lines.length === 0) {
      // No line items — split equally among all members
      const share = (exp.total_amount * rate) / members.length;
      members.forEach(m => { balances[m.id] -= share; });
      if (balances[exp.paid_by] !== undefined) balances[exp.paid_by] += exp.total_amount * rate;
    } else {
      lines.forEach(line => {
        const lineSplits = splits.filter(s => s.expense_line_id === line.id);
        if (lineSplits.length === 0) return;
        const share = (line.amount * rate) / lineSplits.length;
        lineSplits.forEach(s => { if (balances[s.trip_member_id] !== undefined) balances[s.trip_member_id] -= share; });
      });
      if (balances[exp.paid_by] !== undefined) balances[exp.paid_by] += exp.total_amount * rate;
    }
  });

  // Minimize transactions
  const settlements = [];
  const bal = { ...balances };
  const eps = 0.01;

  for (let i = 0; i < 50; i++) {
    const maxCreditor = Object.entries(bal).reduce((a, b) => b[1] > a[1] ? b : a);
    const maxDebtor = Object.entries(bal).reduce((a, b) => b[1] < a[1] ? b : a);
    if (maxCreditor[1] < eps || maxDebtor[1] > -eps) break;

    const amount = Math.min(maxCreditor[1], -maxDebtor[1]);
    settlements.push({ from: maxDebtor[0], to: maxCreditor[0], amount });
    bal[maxCreditor[0]] -= amount;
    bal[maxDebtor[0]] += amount;
  }

  return { balances, settlements };
}

// ─── Auth Screen ─────────────────────────────────────────────────────────────
function AuthScreen({ onAuth }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  async function handleSubmit() {
    setLoading(true); setMsg("");
    if (mode === "login") {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setMsg(error.message);
    } else {
      const { error } = await supabase.auth.signUp({
        email, password,
        options: { data: { full_name: name } }
      });
      if (error) setMsg(error.message);
      else setMsg("Check your email to confirm your account!");
    }
    setLoading(false);
  }

  async function handleGoogle() {
    await supabase.auth.signInWithOAuth({ provider: "google" });
  }

  return (
    <div style={{ padding: "40px 24px", display: "flex", flexDirection: "column", gap: 24, minHeight: "100vh", justifyContent: "center" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 52, marginBottom: 8 }}>🍈</div>
        <h1 style={{ fontSize: 32, fontWeight: 600, letterSpacing: "-0.02em" }}>Papaya</h1>
        <p style={{ color: theme.textMuted, fontSize: 15, marginTop: 4 }}>Split trips, not friendships</p>
      </div>

      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {mode === "signup" && (
          <div>
            <span className="label">Your name</span>
            <input placeholder="What should we call you?" value={name} onChange={e => setName(e.target.value)} />
          </div>
        )}
        <div>
          <span className="label">Email</span>
          <input type="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} />
        </div>
        <div>
          <span className="label">Password</span>
          <input type="password" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSubmit()} />
        </div>
        {msg && <p style={{ fontSize: 13, color: msg.includes("Check") ? theme.green : theme.red }}>{msg}</p>}
        <button className="btn-primary" onClick={handleSubmit} disabled={loading}>
          {loading ? "..." : mode === "login" ? "Sign in" : "Create account"}
        </button>
        <button onClick={handleGoogle} style={{
          background: theme.surfaceHigh, border: `1px solid ${theme.border}`, borderRadius: 12,
          padding: "13px 20px", color: theme.text, fontSize: 15, fontWeight: 500,
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
          Continue with Google
        </button>
      </div>

      <button onClick={() => { setMode(m => m === "login" ? "signup" : "login"); setMsg(""); }}
        style={{ background: "none", color: theme.textMuted, fontSize: 14, padding: 8 }}>
        {mode === "login" ? "No account? Sign up" : "Already have one? Sign in"}
      </button>
    </div>
  );
}

// ─── Trip List ────────────────────────────────────────────────────────────────
function TripList({ user, onSelectTrip, onNewTrip }) {
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadTrips();
  }, []);

  async function loadTrips() {
    const { data } = await supabase
      .from("trip_members")
      .select("trip_id, trips(*)")
      .eq("profile_id", user.id);

    const myTrips = (data || []).map(d => d.trips).filter(Boolean);

    const { data: created } = await supabase
      .from("trips")
      .select("*")
      .eq("created_by", user.id);

    const all = [...myTrips, ...(created || [])];
    const unique = Array.from(new Map(all.map(t => [t.id, t])).values());
    unique.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    setTrips(unique);
    setLoading(false);
  }

  async function joinByCode() {
    const code = prompt("Enter invite code:");
    if (!code) return;
    const { data: trip } = await supabase.from("trips").select("*").eq("invite_code", code.trim()).single();
    if (!trip) { alert("Trip not found"); return; }
    onSelectTrip(trip);
  }

  return (
    <div style={{ padding: "24px 20px", display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 600 }}>🍈 Papaya</h1>
          <p style={{ color: theme.textMuted, fontSize: 13, marginTop: 2 }}>Hey {user.user_metadata?.full_name?.split(" ")[0] || "there"} 👋</p>
        </div>
        <button onClick={() => supabase.auth.signOut()} style={{ background: "none", color: theme.textDim, fontSize: 13 }}>Sign out</button>
      </div>

      <button className="btn-primary" onClick={onNewTrip}>+ New trip</button>

      <button onClick={joinByCode} className="btn-ghost" style={{ width: "100%" }}>
        Join with code
      </button>

      {loading ? (
        <p style={{ color: theme.textMuted, textAlign: "center", padding: 40 }}>Loading...</p>
      ) : trips.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 0", color: theme.textMuted }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>✈️</div>
          <p style={{ fontSize: 15 }}>No trips yet</p>
          <p style={{ fontSize: 13, marginTop: 4 }}>Create one to start splitting</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {trips.map(trip => (
            <button key={trip.id} onClick={() => onSelectTrip(trip)} style={{
              background: theme.surface, border: `1px solid ${theme.border}`,
              borderRadius: 16, padding: 16, textAlign: "left", width: "100%",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <p style={{ fontWeight: 600, fontSize: 16 }}>{trip.name}</p>
                  {trip.description && <p style={{ color: theme.textMuted, fontSize: 13, marginTop: 2 }}>{trip.description}</p>}
                  {trip.start_date && (
                    <p style={{ color: theme.textDim, fontSize: 12, marginTop: 6, fontFamily: "DM Mono" }}>
                      {trip.start_date}{trip.end_date ? ` → ${trip.end_date}` : ""}
                    </p>
                  )}
                </div>
                <span style={{ background: theme.accentMuted, color: theme.accent, padding: "4px 8px", borderRadius: 8, fontSize: 12, fontWeight: 600 }}>
                  {trip.base_currency}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── New Trip Form ────────────────────────────────────────────────────────────
function NewTripForm({ user, onCreated, onBack }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [currency, setCurrency] = useState("THB");
  const [loading, setLoading] = useState(false);

  async function create() {
    if (!name.trim()) return;
    setLoading(true);
    const { data: trip, error } = await supabase.from("trips").insert({
      name: name.trim(), description: description.trim() || null,
      start_date: startDate || null, end_date: endDate || null,
      base_currency: currency, created_by: user.id,
    }).select().single();

    if (error) { alert(error.message); setLoading(false); return; }

    // Add creator as member
    const profile = await supabase.from("profiles").select("*").eq("id", user.id).single();
    await supabase.from("trip_members").insert({
      trip_id: trip.id, profile_id: user.id,
      display_name: profile.data?.display_name || user.email,
      avatar_color: COLORS[0], avatar_emoji: "🧑",
      is_avatar: false,
    });

    onCreated(trip);
  }

  return (
    <div style={{ padding: "24px 20px", display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={onBack} style={{ background: "none", color: theme.textMuted, fontSize: 22, padding: 0 }}>←</button>
        <h2 style={{ fontSize: 20, fontWeight: 600 }}>New trip</h2>
      </div>

      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <span className="label">Trip name *</span>
          <input placeholder="Seoul Summer 2026" value={name} onChange={e => setName(e.target.value)} />
        </div>
        <div>
          <span className="label">Description</span>
          <input placeholder="Optional" value={description} onChange={e => setDescription(e.target.value)} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div>
            <span className="label">Start date</span>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
          </div>
          <div>
            <span className="label">End date</span>
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
          </div>
        </div>
        <div>
          <span className="label">Base currency</span>
          <select value={currency} onChange={e => setCurrency(e.target.value)}>
            {CURRENCIES.map(c => <option key={c}>{c}</option>)}
          </select>
        </div>
      </div>

      <button className="btn-primary" onClick={create} disabled={loading || !name.trim()}>
        {loading ? "Creating..." : "Create trip"}
      </button>
    </div>
  );
}

// ─── Trip Detail ──────────────────────────────────────────────────────────────
function TripDetail({ trip, user, onBack }) {
  const [tab, setTab] = useState("expenses");
  const [members, setMembers] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [expenseLines, setExpenseLines] = useState([]);
  const [splits, setSplits] = useState([]);
  const [showAddMember, setShowAddMember] = useState(false);
  const [showAddExpense, setShowAddExpense] = useState(false);

  const load = useCallback(async () => {
    const [{ data: mems }, { data: exps }] = await Promise.all([
      supabase.from("trip_members").select("*").eq("trip_id", trip.id),
      supabase.from("expenses").select("*").eq("trip_id", trip.id).order("created_at", { ascending: false }),
    ]);
    setMembers(mems || []);
    setExpenses(exps || []);

    if (exps?.length) {
      const expIds = exps.map(e => e.id);
      const { data: lines } = await supabase.from("expense_lines").select("*").in("expense_id", expIds);
      setExpenseLines(lines || []);
      if (lines?.length) {
        const lineIds = lines.map(l => l.id);
        const { data: sp } = await supabase.from("expense_line_splits").select("*").in("expense_line_id", lineIds);
        setSplits(sp || []);
      }
    }
  }, [trip.id]);

  useEffect(() => { load(); }, [load]);

  const { balances, settlements } = calcSettlements(members, expenses, expenseLines, splits);

  function getMember(id) { return members.find(m => m.id === id); }

  const tabs = [
    { id: "expenses", label: "Expenses" },
    { id: "settle", label: "Settle up" },
    { id: "members", label: "Members" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      {/* Header */}
      <div style={{ padding: "20px 20px 0", background: theme.bg, position: "sticky", top: 0, zIndex: 10, borderBottom: `1px solid ${theme.border}`, paddingBottom: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <button onClick={onBack} style={{ background: "none", color: theme.textMuted, fontSize: 22, padding: 0 }}>←</button>
          <div style={{ flex: 1 }}>
            <h2 style={{ fontSize: 18, fontWeight: 600 }}>{trip.name}</h2>
            {trip.start_date && <p style={{ color: theme.textDim, fontSize: 12, fontFamily: "DM Mono" }}>{trip.start_date}{trip.end_date ? ` → ${trip.end_date}` : ""}</p>}
          </div>
          <span style={{ background: theme.accentMuted, color: theme.accent, padding: "4px 8px", borderRadius: 8, fontSize: 12, fontWeight: 600 }}>
            {trip.base_currency}
          </span>
        </div>

        {/* Invite code */}
        <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: theme.textDim }}>Invite code:</span>
          <button onClick={() => { navigator.clipboard?.writeText(trip.invite_code); alert("Copied!"); }}
            style={{ background: theme.surfaceHigh, border: `1px solid ${theme.border}`, borderRadius: 8, padding: "4px 10px", color: theme.accent, fontSize: 13, fontFamily: "DM Mono", fontWeight: 600 }}>
            {trip.invite_code} 📋
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 0 }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              flex: 1, padding: "10px 0", background: "none",
              color: tab === t.id ? theme.accent : theme.textMuted,
              fontSize: 13, fontWeight: tab === t.id ? 600 : 400,
              borderBottom: `2px solid ${tab === t.id ? theme.accent : "transparent"}`,
              transition: "all 0.15s",
            }}>{t.label}</button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, padding: "16px 20px", overflow: "auto" }}>

        {/* EXPENSES TAB */}
        {tab === "expenses" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }} className="fade-in">
            <button className="btn-primary" onClick={() => setShowAddExpense(true)}>+ Add expense</button>

            {expenses.length === 0 ? (
              <div style={{ textAlign: "center", padding: "60px 0", color: theme.textMuted }}>
                <div style={{ fontSize: 36, marginBottom: 10 }}>🧾</div>
                <p>No expenses yet</p>
              </div>
            ) : expenses.map(exp => {
              const payer = getMember(exp.paid_by);
              const lines = expenseLines.filter(l => l.expense_id === exp.id);
              return (
                <div key={exp.id} className="card slide-up">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: lines.length ? 12 : 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      {payer && <Avatar member={payer} size={32} />}
                      <div>
                        <p style={{ fontWeight: 600, fontSize: 15 }}>{exp.title}</p>
                        <p style={{ color: theme.textMuted, fontSize: 12 }}>{payer?.display_name}</p>
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <p className="mono" style={{ fontWeight: 600, color: theme.accent, fontSize: 15 }}>
                        {formatAmount(exp.total_amount, exp.currency)}
                      </p>
                      {exp.exchange_rate !== 1 && (
                        <p style={{ color: theme.textDim, fontSize: 11, fontFamily: "DM Mono" }}>×{exp.exchange_rate}</p>
                      )}
                    </div>
                  </div>

                  {lines.length > 0 && (
                    <div style={{ borderTop: `1px solid ${theme.border}`, paddingTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                      {lines.map(line => {
                        const lineSplits = splits.filter(s => s.expense_line_id === line.id);
                        return (
                          <div key={line.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div>
                              <span style={{ fontSize: 13, color: theme.text }}>{line.description}</span>
                              <span style={{ fontSize: 12, color: theme.textDim, marginLeft: 6 }}>÷{lineSplits.length}</span>
                            </div>
                            <span className="mono" style={{ fontSize: 13, color: theme.textMuted }}>
                              {formatAmount(line.amount, exp.currency)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* SETTLE TAB */}
        {tab === "settle" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }} className="fade-in">
            <div className="card">
              <p className="label">Balances</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {members.map(m => {
                  const bal = balances[m.id] || 0;
                  return (
                    <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <Avatar member={m} size={32} />
                      <span style={{ flex: 1, fontSize: 14 }}>{m.display_name}</span>
                      <span className="mono" style={{
                        fontWeight: 600, fontSize: 14,
                        color: bal > 0.01 ? theme.green : bal < -0.01 ? theme.red : theme.textDim
                      }}>
                        {bal > 0.01 ? "+" : ""}{formatAmount(Math.abs(bal), trip.base_currency)}
                        {Math.abs(bal) < 0.01 ? "" : bal > 0 ? " owed" : " owes"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {settlements.length > 0 && (
              <div className="card">
                <p className="label">Who pays who</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {settlements.map((s, i) => {
                    const from = getMember(s.from);
                    const to = getMember(s.to);
                    return (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Avatar member={from} size={28} />
                        <span style={{ fontSize: 13, color: theme.textMuted }}>pays</span>
                        <Avatar member={to} size={28} />
                        <span style={{ flex: 1, fontSize: 13 }}>{to?.display_name}</span>
                        <span className="mono" style={{ fontWeight: 600, color: theme.yellow, fontSize: 14 }}>
                          {formatAmount(s.amount, trip.base_currency)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {settlements.length === 0 && expenses.length > 0 && (
              <div style={{ textAlign: "center", padding: 40, color: theme.green }}>
                <div style={{ fontSize: 36, marginBottom: 8 }}>✅</div>
                <p style={{ fontWeight: 600 }}>All settled up!</p>
              </div>
            )}
          </div>
        )}

        {/* MEMBERS TAB */}
        {tab === "members" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }} className="fade-in">
            <button className="btn-primary" onClick={() => setShowAddMember(true)}>+ Add member</button>
            {members.map(m => (
              <div key={m.id} className="card" style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <Avatar member={m} size={40} />
                <div style={{ flex: 1 }}>
                  <p style={{ fontWeight: 500, fontSize: 15 }}>{m.display_name}</p>
                  <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                    {m.is_avatar && (
                      <span className="chip" style={{ background: theme.surfaceHigh, color: theme.textMuted, border: `1px dashed ${theme.textDim}` }}>
                        👤 Avatar
                      </span>
                    )}
                    {m.profile_id === user.id && (
                      <span className="chip" style={{ background: theme.accentMuted, color: theme.accent }}>You</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Modals */}
      {showAddMember && (
        <AddMemberModal trip={trip} user={user} members={members} onClose={() => setShowAddMember(false)} onAdded={load} />
      )}
      {showAddExpense && (
        <AddExpenseModal trip={trip} members={members} onClose={() => setShowAddExpense(false)} onAdded={load} />
      )}
    </div>
  );
}

// ─── Add Member Modal ─────────────────────────────────────────────────────────
function AddMemberModal({ trip, onClose, onAdded }) {
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("🧑");
  const [color, setColor] = useState(COLORS[Math.floor(Math.random() * COLORS.length)]);
  const [isAvatar, setIsAvatar] = useState(true);
  const [loading, setLoading] = useState(false);

  async function add() {
    if (!name.trim()) return;
    setLoading(true);
    await supabase.from("trip_members").insert({
      trip_id: trip.id,
      display_name: name.trim(),
      avatar_emoji: emoji,
      avatar_color: color,
      is_avatar: isAvatar,
      profile_id: null,
    });
    onAdded(); onClose();
  }

  return (
    <Modal onClose={onClose} title="Add member">
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <div style={{ width: 64, height: 64, borderRadius: "50%", background: color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 32, border: isAvatar ? `3px dashed ${color}80` : "none" }}>
            {emoji}
          </div>
        </div>

        <div>
          <span className="label">Name</span>
          <input placeholder="Friend's name" value={name} onChange={e => setName(e.target.value)} />
        </div>

        <div>
          <span className="label">Emoji</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {EMOJIS.map(e => (
              <button key={e} onClick={() => setEmoji(e)} style={{
                background: e === emoji ? theme.accentMuted : theme.surfaceHigh,
                border: `1px solid ${e === emoji ? theme.accent : theme.border}`,
                borderRadius: 8, padding: "6px 10px", fontSize: 18,
              }}>{e}</button>
            ))}
          </div>
        </div>

        <div>
          <span className="label">Color</span>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {COLORS.map(c => (
              <button key={c} onClick={() => setColor(c)} style={{
                width: 28, height: 28, borderRadius: "50%", background: c,
                border: c === color ? "3px solid white" : "3px solid transparent",
              }} />
            ))}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", background: theme.surfaceHigh, borderRadius: 10 }}>
          <input type="checkbox" id="isAvatar" checked={isAvatar} onChange={e => setIsAvatar(e.target.checked)} style={{ width: 18, height: 18, accentColor: theme.accent }} />
          <label htmlFor="isAvatar" style={{ fontSize: 14, cursor: "pointer" }}>
            <span style={{ fontWeight: 500 }}>Avatar token</span>
            <span style={{ color: theme.textMuted, fontSize: 12, display: "block" }}>Can be claimed by a real account later</span>
          </label>
        </div>

        <button className="btn-primary" onClick={add} disabled={loading || !name.trim()}>
          {loading ? "Adding..." : "Add member"}
        </button>
      </div>
    </Modal>
  );
}

// ─── Add Expense Modal ────────────────────────────────────────────────────────
function AddExpenseModal({ trip, members, onClose, onAdded }) {
  const [title, setTitle] = useState("");
  const [currency, setCurrency] = useState(trip.base_currency);
  const [rate, setRate] = useState("1");
  const [paidBy, setPaidBy] = useState(members[0]?.id || "");
  const [useLines, setUseLines] = useState(false);
  const [totalAmount, setTotalAmount] = useState("");
  const [lines, setLines] = useState([{ desc: "", amount: "", splitAll: true, memberIds: members.map(m => m.id) }]);
  const [loading, setLoading] = useState(false);

  const computedTotal = useLines
    ? lines.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0)
    : parseFloat(totalAmount) || 0;

  function addLine() {
    setLines(l => [...l, { desc: "", amount: "", splitAll: true, memberIds: members.map(m => m.id) }]);
  }

  function updateLine(i, key, val) {
    setLines(l => l.map((line, idx) => idx === i ? { ...line, [key]: val } : line));
  }

  function toggleMember(lineIdx, memberId) {
    setLines(l => l.map((line, i) => {
      if (i !== lineIdx) return line;
      const has = line.memberIds.includes(memberId);
      return { ...line, memberIds: has ? line.memberIds.filter(id => id !== memberId) : [...line.memberIds, memberId] };
    }));
  }

  async function save() {
    if (!title.trim() || !paidBy || computedTotal <= 0) return;
    setLoading(true);

    const { data: exp } = await supabase.from("expenses").insert({
      trip_id: trip.id,
      paid_by: paidBy,
      title: title.trim(),
      total_amount: computedTotal,
      currency,
      exchange_rate: parseFloat(rate) || 1,
    }).select().single();

    if (useLines) {
      for (const line of lines) {
        if (!line.desc.trim() || !parseFloat(line.amount)) continue;
        const { data: el } = await supabase.from("expense_lines").insert({
          expense_id: exp.id,
          description: line.desc,
          amount: parseFloat(line.amount),
        }).select().single();

        const memberIds = line.splitAll ? members.map(m => m.id) : line.memberIds;
        if (memberIds.length > 0) {
          await supabase.from("expense_line_splits").insert(
            memberIds.map(mid => ({ expense_line_id: el.id, trip_member_id: mid }))
          );
        }
      }
    } else {
      // Single line split equally
      const { data: el } = await supabase.from("expense_lines").insert({
        expense_id: exp.id,
        description: title.trim(),
        amount: computedTotal,
      }).select().single();
      await supabase.from("expense_line_splits").insert(
        members.map(m => ({ expense_line_id: el.id, trip_member_id: m.id }))
      );
    }

    onAdded(); onClose();
  }

  return (
    <Modal onClose={onClose} title="Add expense">
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <span className="label">Title</span>
          <input placeholder="Dinner, taxi, hotel..." value={title} onChange={e => setTitle(e.target.value)} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div>
            <span className="label">Currency</span>
            <select value={currency} onChange={e => setCurrency(e.target.value)}>
              {CURRENCIES.map(c => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <span className="label">Rate to {trip.base_currency}</span>
            <input type="number" step="0.0001" value={rate} onChange={e => setRate(e.target.value)} placeholder="1" />
          </div>
        </div>

        <div>
          <span className="label">Paid by</span>
          <select value={paidBy} onChange={e => setPaidBy(e.target.value)}>
            {members.map(m => <option key={m.id} value={m.id}>{m.avatar_emoji} {m.display_name}</option>)}
          </select>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", background: theme.surfaceHigh, borderRadius: 10 }}>
          <input type="checkbox" id="useLines" checked={useLines} onChange={e => setUseLines(e.target.checked)} style={{ width: 18, height: 18, accentColor: theme.accent }} />
          <label htmlFor="useLines" style={{ fontSize: 14, cursor: "pointer" }}>
            <span style={{ fontWeight: 500 }}>Split by line items</span>
            <span style={{ color: theme.textMuted, fontSize: 12, display: "block" }}>e.g. wine for some, food for all</span>
          </label>
        </div>

        {!useLines && (
          <div>
            <span className="label">Total amount</span>
            <input type="number" placeholder="0" value={totalAmount} onChange={e => setTotalAmount(e.target.value)} />
            <p style={{ fontSize: 12, color: theme.textDim, marginTop: 4 }}>Split equally among all {members.length} members</p>
          </div>
        )}

        {useLines && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="label" style={{ margin: 0 }}>Line items</span>
              <span className="mono" style={{ color: theme.accent, fontSize: 13, fontWeight: 600 }}>{formatAmount(computedTotal, currency)}</span>
            </div>
            {lines.map((line, i) => (
              <div key={i} className="card" style={{ padding: 12 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, marginBottom: 10 }}>
                  <input placeholder="Description (e.g. Wine)" value={line.desc} onChange={e => updateLine(i, "desc", e.target.value)} />
                  <input type="number" placeholder="0" value={line.amount} onChange={e => updateLine(i, "amount", e.target.value)} style={{ width: 90 }} />
                </div>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                    <input type="checkbox" checked={line.splitAll} onChange={e => updateLine(i, "splitAll", e.target.checked)} style={{ accentColor: theme.accent }} />
                    <span style={{ fontSize: 12, color: theme.textMuted }}>Split among all</span>
                  </div>
                  {!line.splitAll && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {members.map(m => (
                        <button key={m.id} onClick={() => toggleMember(i, m.id)} style={{
                          background: line.memberIds.includes(m.id) ? theme.accentMuted : theme.surfaceHigh,
                          border: `1px solid ${line.memberIds.includes(m.id) ? theme.accent : theme.border}`,
                          borderRadius: 20, padding: "4px 10px", fontSize: 12, color: theme.text,
                          display: "flex", alignItems: "center", gap: 4,
                        }}>
                          <span>{m.avatar_emoji}</span>{m.display_name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            <button onClick={addLine} className="btn-ghost" style={{ fontSize: 13 }}>+ Add line item</button>
          </div>
        )}

        <button className="btn-primary" onClick={save} disabled={loading || !title.trim() || computedTotal <= 0}>
          {loading ? "Saving..." : `Save — ${formatAmount(computedTotal, currency)}`}
        </button>
      </div>
    </Modal>
  );
}

// ─── Modal Wrapper ────────────────────────────────────────────────────────────
function Modal({ children, onClose, title }) {
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 100,
      background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "flex-end",
    }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{
        background: theme.surface, borderRadius: "20px 20px 0 0",
        padding: "20px", width: "100%", maxHeight: "90vh", overflowY: "auto",
      }} className="slide-up">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h3 style={{ fontSize: 18, fontWeight: 600 }}>{title}</h3>
          <button onClick={onClose} style={{ background: theme.surfaceHigh, border: "none", borderRadius: 8, padding: "6px 12px", color: theme.textMuted, fontSize: 14 }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ─── App Root ─────────────────────────────────────────────────────────────────
export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [screen, setScreen] = useState("trips"); // trips | newTrip | tripDetail
  const [selectedTrip, setSelectedTrip] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: theme.bg }}>
      <div style={{ fontSize: 48 }}>🍈</div>
    </div>
  );

  if (!session) return <AuthScreen onAuth={setSession} />;

  if (screen === "newTrip") return (
    <NewTripForm
      user={session.user}
      onBack={() => setScreen("trips")}
      onCreated={trip => { setSelectedTrip(trip); setScreen("tripDetail"); }}
    />
  );

  if (screen === "tripDetail" && selectedTrip) return (
    <TripDetail
      trip={selectedTrip}
      user={session.user}
      onBack={() => setScreen("trips")}
    />
  );

  return (
    <TripList
      user={session.user}
      onSelectTrip={trip => { setSelectedTrip(trip); setScreen("tripDetail"); }}
      onNewTrip={() => setScreen("newTrip")}
    />
  );
}
