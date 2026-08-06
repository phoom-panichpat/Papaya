import { createContext, useContext, useEffect, useRef, useState } from "react";

/**
 * Hardware / browser back support.
 *
 * Navigation in Papaya is pure React state — App's `tab` + the overlay `stack`,
 * plus every screen's own sheets and pickers. Nothing ever touched browser
 * history, so Android's back button acted on the BROWSER and walked straight out
 * of the installed app, even mid-expense.
 *
 * The model: anything dismissible registers itself as a LAYER while it's open
 * (`useBackLayer(open, onBack)`). One back press closes exactly one layer — the
 * topmost, i.e. the most recently opened.
 *
 * History is kept in step by RECONCILING DEPTH, not by pairing each push with a
 * matching pop: every entry we create records how many layers were open at the
 * time, and an effect pushes or rewinds entries until the browser agrees with us.
 * That self-heals, which matters because a layer is allowed to REFUSE to close —
 * the expense form's discard guard opens a confirm instead — and because a fast
 * double-tap can otherwise leave history permanently out of step.
 *
 * Note the soft keyboard is not a layer: Android dismisses it before the page
 * ever sees a back event. It only felt broken because the whole app was exiting.
 */

const BackCtx = createContext(null);

let seq = 0;
let openSeq = 0;

/**
 * Stacking levels. Within a level, most-recently-opened wins — which is right
 * for sheets inside one screen, since those open in tap order.
 */
export const BACK_LEVEL = {
  TAB: 0,     // a bottom tab other than Home — always the bottom-most layer
  SCREEN: 10, // a pushed overlay screen (default)
  SHEET: 20,  // reserved: a sheet that must outrank its own screen regardless of timing
};

function currentHistoryDepth() {
  return window.history.state?.papayaDepth ?? 0;
}

export function BackStackProvider({ children }) {
  const idsRef = useRef([]); // open layers: { id, level, seq }

  // Topmost = highest level, then most recently opened. Registration order alone
  // is NOT enough: React runs child effects before parent effects, so re-showing
  // a kept-mounted tab re-registers the tab screen's sheet BEFORE App's tab
  // layer — which made one back press close the sheet and leave the tab.
  const topmost = () =>
    idsRef.current.reduce(
      (a, b) => (!a || b.level > a.level || (b.level === a.level && b.seq > a.seq) ? b : a),
      null
    );
  const handlersRef = useRef(new Map()); // id -> () => void (always the latest closure)
  const [depth, setDepth] = useState(0); // mirrors idsRef.current.length; drives the sync effect

  // Stable identity so consumers' effects never re-run just because we rendered.
  const apiRef = useRef(null);
  if (!apiRef.current) {
    apiRef.current = {
      setHandler(id, fn) { handlersRef.current.set(id, fn); },
      dropHandler(id) { handlersRef.current.delete(id); },
      open(id, level) {
        if (idsRef.current.some((l) => l.id === id)) return;
        idsRef.current = [...idsRef.current, { id, level, seq: ++openSeq }];
        setDepth(idsRef.current.length);
      },
      close(id) {
        if (!idsRef.current.some((l) => l.id === id)) return;
        idsRef.current = idsRef.current.filter((l) => l.id !== id);
        setDepth(idsRef.current.length);
      },
    };
  }

  // Baseline entry: the state we're in with nothing open.
  useEffect(() => {
    if (window.history.state?.papayaDepth == null) {
      window.history.replaceState({ ...(window.history.state || {}), papayaDepth: 0 }, "");
    }
  }, []);

  // Keep the browser's depth equal to our layer depth.
  useEffect(() => {
    const cur = currentHistoryDepth();
    if (depth > cur) {
      for (let d = cur + 1; d <= depth; d++) window.history.pushState({ papayaDepth: d }, "");
    } else if (depth < cur) {
      // Strictly negative — history.go(0) would RELOAD the page.
      window.history.go(depth - cur);
    }
  }, [depth]);

  useEffect(() => {
    function onPop(e) {
      const d = e.state?.papayaDepth ?? 0;
      const cur = idsRef.current.length;
      if (d < cur) {
        // One press closes exactly one layer — the topmost.
        const top = topmost();
        const fn = top && handlersRef.current.get(top.id);
        if (fn) fn();
        // If that layer declined to close, the depth effect re-pushes an entry.
      } else if (d > cur) {
        // Drift (a rewind raced a push): rewind to where we actually are.
        window.history.go(cur - d);
      }
      // d === cur: an entry we already accounted for — no-op.
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return <BackCtx.Provider value={apiRef.current}>{children}</BackCtx.Provider>;
}

/**
 * Register a dismissible layer. `open` is whether it's currently showing;
 * `onBack` is what a back press should do — normally the same thing the screen's
 * own back/cancel control does, guards included.
 */
export function useBackLayer(open, onBack, level = BACK_LEVEL.SCREEN) {
  const ctx = useContext(BackCtx);
  const idRef = useRef(null);
  if (idRef.current === null) idRef.current = `layer-${++seq}`;
  const id = idRef.current;

  // Held in a ref so an inline closure doesn't re-register the layer every render.
  const cbRef = useRef(onBack);
  cbRef.current = onBack;

  useEffect(() => {
    if (!ctx) return undefined;
    ctx.setHandler(id, () => cbRef.current?.());
    return () => { ctx.close(id); ctx.dropHandler(id); };
  }, [ctx, id]);

  useEffect(() => {
    if (!ctx) return;
    if (open) ctx.open(id, level);
    else ctx.close(id);
  }, [ctx, id, open, level]);
}
