// =====================================================
// Session bridge — silent cross-app sign-in.
//
// When the user launches Reading Academy from the VPA orchestration
// layer's "Start Now" button, the orchestration layer appends
// `#vpa_session=<base64>` with the user's Supabase access + refresh
// tokens. This module decodes the fragment, calls
// supabase.auth.setSession() to silently sign in, and strips the
// fragment from the URL so the token doesn't sit in the address
// bar / browser history.
//
// Mirrors math-facts-trainer-react/src/sessionBridge.js. See
// vpa-orchestration-layer/src/utils/launch.js for the producer.
//
// NOTE: Supabase is also configured with detectSessionInUrl: true,
// which handles its OWN auth-callback URLs (#access_token=... from
// magic links). Our fragment uses a different key (#vpa_session)
// so it doesn't collide.
// =====================================================

import { supabase } from "./services/supabase.js";

export async function consumeSessionFragment() {
  if (typeof window === "undefined") return;
  const hash = window.location.hash;
  if (!hash) return;

  const params = new URLSearchParams(hash.slice(1));
  const encoded = params.get("vpa_session");
  if (!encoded) return;

  try {
    const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padBase64(b64));
    const payload = JSON.parse(json);
    if (payload?.access_token && payload?.refresh_token) {
      await supabase.auth.setSession({
        access_token: payload.access_token,
        refresh_token: payload.refresh_token,
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[sessionBridge] failed to consume #vpa_session:", err);
  } finally {
    params.delete("vpa_session");
    const remaining = params.toString();
    const newUrl =
      window.location.pathname +
      window.location.search +
      (remaining ? `#${remaining}` : "");
    window.history.replaceState(null, "", newUrl);
  }
}

function padBase64(s) {
  const pad = s.length % 4;
  return pad ? s + "=".repeat(4 - pad) : s;
}
