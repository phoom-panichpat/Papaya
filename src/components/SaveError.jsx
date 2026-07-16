import { useEffect } from "react";

// Transient notice shown when a background settle write failed and the screen
// re-synced from the server (optimistic UI's failure path). Rendered inside a
// positioned screen/sheet container; auto-dismisses.
export default function SaveError({ onDone }) {
  useEffect(() => {
    const t = setTimeout(onDone, 4000);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div style={{ position: "absolute", left: 16, right: 16, bottom: 20, background: "var(--text)", color: "var(--bg)", borderRadius: 14, padding: "13px 16px", fontSize: 13.5, zIndex: 70, animation: "sheetIn 220ms var(--ease)" }}>
      Couldn’t save — showing the latest saved state.
    </div>
  );
}
