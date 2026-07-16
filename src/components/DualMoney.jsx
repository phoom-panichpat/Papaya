import { currencySymbol, formatMoney } from "../lib/format";

// DualMoney — stacks a PRIMARY money display with an optional smaller, faded
// HOME-currency equivalent beneath it. DISPLAY ONLY: no conversion happens here.
//
// The primary is passed in as a pre-built node so each screen keeps its existing
// number formatting byte-identical (the two record-scoped screens format the
// primary differently today). The secondary line is rendered here from
// `homeAmount`/`homeCur` using `formatMoney` — it's a new line, so there is no
// "must match the old rendering" constraint on it.
//
// When `homeAmount` is null/undefined (e.g. the record is already in the home
// currency), the primary is rendered alone with no extra wrapper gap — identical
// to how it rendered before this component existed.
export default function DualMoney({ primary, homeAmount, homeCur, strike = false, style = {} }) {
  const dual = homeCur && homeAmount != null;
  if (!dual) return <span style={style}>{primary}</span>;
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", lineHeight: 1.1, ...style }}>
      {primary}
      <span style={{ display: "inline-flex", alignItems: "baseline", gap: 2, marginTop: 2, textDecoration: strike ? "line-through" : "none" }}>
        <span style={{ fontSize: 10, color: "var(--text-4)" }}>{currencySymbol(homeCur)}</span>
        <span className="money" style={{ fontSize: 11, color: "var(--text-3)" }}>{formatMoney(homeAmount, homeCur)}</span>
      </span>
    </span>
  );
}
