import { supabase } from "./supabase";

// ── Share links ─────────────────────────────────────────────────────────────
// A read-only public view of ONE record, unlocked by a random token stored on
// recordings.share_token.
//
// 🔑 There is no public WRITE path and no new RLS policy. Creating and revoking
// a link are ordinary owner-scoped updates (existing RLS already allows them);
// the public read goes through one security-definer function that only SELECTs.
// See migrations/2026-08-10-share-links.sql — that function is the entire
// surface a stranger with a link can reach.

// 128 bits from the platform CSPRNG. Guessing one is not a threat model.
function newToken() {
  return crypto.randomUUID().replace(/-/g, "");
}

export function shareUrl(token) {
  return `${window.location.origin}/s/${token}`;
}

// Regenerating simply overwrites: every previously-sent link stops working.
export async function createShareLink(recordingId) {
  const share_token = newToken();
  const { error } = await supabase
    .from("recordings")
    .update({ share_token, share_created_at: new Date().toISOString() })
    .eq("id", recordingId);
  if (error) throw error;
  return share_token;
}

export async function revokeShareLink(recordingId) {
  const { error } = await supabase
    .from("recordings")
    .update({ share_token: null, share_created_at: null })
    .eq("id", recordingId);
  if (error) throw error;
}

// The public read. No session required — the anon key plus the token IS the
// credential. Returns null for an unknown or revoked link (deliberately
// indistinguishable: a visitor can't tell "expired" from "never existed").
//
// The payload comes back in exactly the shape balances-core already eats, so
// the shared page runs the SAME buildContributions / planSummary as the app.
// Its numbers cannot drift from Phoom's — the discipline that makes the export
// trustworthy, applied to a live page.
export async function loadSharedRecord(token) {
  const { data, error } = await supabase.rpc("get_shared_record", { token });
  if (error) throw error;
  if (!data || !data.recording) return null;
  return {
    ...data,
    // buildContributions wants recordings as a list; the payload has the one.
    recordings: [data.recording],
  };
}
