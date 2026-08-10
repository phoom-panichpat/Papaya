// ═══════════════════════════════════════════════════════════════════════
// Export a record so people WITHOUT the app can read it.
//
// Deliberately text-first, not file-first: on a phone a file is friction
// (save it, find it, attach it), while a message pastes straight into the
// group chat, which is where it actually gets read. CSV is here for the
// person who wants the raw numbers in a spreadsheet.
//
// Pure string building — it takes rows the screen has already resolved and
// returns text. No Supabase, no money math: every figure handed in here was
// derived by balances-core, so an export can never disagree with the app.
// ═══════════════════════════════════════════════════════════════════════
import { currencySymbol, formatMoney } from "./format";

// ⚠️ TWO formatters, matching the two the app already uses — don't collapse them.
// `formatMoney` rounds THB/KRW/JPY/LAK/VND to whole units ("conventionally shown
// without decimals"), which is right for an amount someone TYPED and is what the
// record's expense rows show. A computed share or transfer is genuinely
// fractional, so the settle screens render it with up to 2 decimals via their
// own Money component. Using the rounding one for both would print ₩82,333 where
// the app says ₩82,333.33, and the export would look wrong.
function money(n, cur) {          // typed amounts — matches the expense rows
  return `${currencySymbol(cur)}${formatMoney(n, cur)}`;
}
function computed(n, cur) {       // derived amounts — matches the settle screens
  return `${currencySymbol(cur)}${(Number(n) || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

// ⚠️ No column padding anywhere in here. Chat apps render proportional text,
// so space-aligned columns arrive looking broken. Separators only.
export function buildRecordText({
  name,
  dateRange,
  baseCurrency,
  era,                 // the home currency this record logs in
  transfers = [],      // [{ from, to, amount, home }] — names already resolved
  expenses = [],       // [{ title, payer, amount, currency, settled }]
  settledUp = false,
  working = null,      // optional: { people:[{name,owesTotal,paidTotal,net,count}], directCount }
}) {
  const showHome = era && era !== baseCurrency;
  const L = [];

  L.push(name || "Record");
  const meta = [dateRange, `${expenses.length} expense${expenses.length === 1 ? "" : "s"}`, baseCurrency]
    .filter(Boolean).join(" · ");
  if (meta) L.push(meta);

  L.push("");
  if (settledUp || transfers.length === 0) {
    L.push("ALL SETTLED UP");
  } else {
    L.push("WHO OWES WHO");
    transfers.forEach((t) => {
      // the home equivalent rides only on these lines — they're the actionable
      // numbers, and repeating it on every expense would be noise
      const home = showHome && t.home != null ? `  (≈ ${computed(t.home, era)})` : "";
      L.push(`${t.from} → ${t.to}: ${computed(t.amount, baseCurrency)}${home}`);
    });
  }

  if (expenses.length) {
    L.push("");
    L.push("EXPENSES");
    expenses.forEach((e) => {
      const paid = e.payer ? ` (${e.payer})` : "";
      const done = e.settled ? " · settled" : "";
      L.push(`${e.title} — ${money(e.amount, e.currency || baseCurrency)}${paid}${done}`);
    });
    const total = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    // only meaningful when everything shares one currency; mixed records would
    // be adding different units together, so it's omitted rather than faked
    const oneCurrency = expenses.every((e) => (e.currency || baseCurrency) === (expenses[0].currency || baseCurrency));
    if (oneCurrency) {
      L.push("");
      L.push(`Total: ${money(total, expenses[0].currency || baseCurrency)}`);
    }
  }

  // Optional "show your working". Opt-in, because the person who doubts a
  // number is usually the friend WITHOUT the app — but it roughly doubles the
  // message, so the default stays short.
  if (working?.people?.length) {
    L.push("");
    L.push("HOW THIS WAS WORKED OUT");
    L.push("Everyone's share of every expense is added up. Debts that point both ways cancel out, so the group makes fewer payments. Nobody pays a different amount than they owe — only who they hand it to changes.");
    L.push("");
    working.people.forEach((p) => {
      const verb = p.net > 0.005 ? "pays" : p.net < -0.005 ? "gets back" : "square";
      const amt = Math.abs(p.net) < 0.005 ? "" : ` ${computed(Math.abs(p.net), baseCurrency)}`;
      const share = p.count
        ? `share of ${p.count} expense${p.count === 1 ? "" : "s"} ${computed(p.owesTotal, baseCurrency)}`
        : `no shares of their own`;
      L.push(`${p.name}: ${share} − paid for others ${computed(p.paidTotal, baseCurrency)} → ${verb}${amt}`);
    });
    if (working.directCount) {
      L.push("");
      // only claim a reduction when there was one
      L.push(working.directCount > transfers.length
        ? `That's ${working.directCount} separate debts between people, settled with just ${transfers.length} payment${transfers.length === 1 ? "" : "s"}.`
        : `No two people owe each other here, so this is already the fewest payments possible.`);
    }
  }

  return L.join("\n");
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// One row per expense. Raw numbers, unformatted, so a spreadsheet can total them.
export function buildRecordCsv({ expenses = [], baseCurrency }) {
  const head = ["Date", "Title", "Paid by", "Amount", "Currency", "Settled", "Note"];
  const rows = expenses.map((e) => [
    e.date || "",
    e.title || "",
    e.payer || "",
    Number(e.amount) || 0,
    e.currency || baseCurrency || "",
    e.settled ? "yes" : "no",
    e.note || "",
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
}

// Prefer the OS share sheet (two taps into LINE/WhatsApp from an installed
// PWA). Fall back to the clipboard where it doesn't exist — desktop browsers,
// and anywhere navigator.share is missing. Returns what actually happened so
// the caller can confirm only when there's nothing else to see.
export async function shareText(text, title) {
  if (navigator.share) {
    try {
      await navigator.share({ title, text });
      return "shared";
    } catch (e) {
      if (e?.name === "AbortError") return "cancelled"; // user backed out
      // otherwise fall through and copy — better than doing nothing
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}

export function downloadCsv(csv, filename) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // revoke on the next tick — revoking synchronously can cancel the download
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(s) {
  return (s || "record")
    .replace(/[^\w\- ]+/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")   // collapse runs, so "Seoul 08 - trip" isn't "seoul-08---trip"
    .replace(/^-|-$/g, "")
    .toLowerCase() || "record";
}
