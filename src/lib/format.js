const SYMBOLS = {
  THB: "฿", KRW: "₩", USD: "$", EUR: "€", JPY: "¥",
  GBP: "£", SGD: "S$", MYR: "RM", LAK: "₭", VND: "₫",
};

// Currencies conventionally shown without decimals in casual use.
const ZERO_DECIMAL = new Set(["THB", "KRW", "JPY", "LAK", "VND"]);

export function currencySymbol(code) {
  if (!code) return "฿";
  return SYMBOLS[code] || code + " ";
}

export function formatMoney(amount, code) {
  const n = Number(amount) || 0;
  const dec = ZERO_DECIMAL.has(code) ? 0 : 2;
  return n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

export function padIndex(n) {
  return String(n).padStart(2, "0");
}
