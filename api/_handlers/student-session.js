// =============================================================
// READING ACADEMY — /api/student-session  (M16-L3)
//
// Bearer-validated endpoint. SPA calls this on app load with the
// stored session token; if the token is still valid we return the
// student profile so the UI can re-hydrate after a refresh.
//
// GET /api/student-session
//   Authorization: Bearer <sessionToken>
//
// → 200 { ok: true, student: {...} }
// → 401 { error: "invalid_session" }
// → 410 { error: "session_expired" }   // token known but past TTL
//
// On every successful validation we bump last_seen_at so teachers
// can see "this kid was on 5 minutes ago" in the dashboard.
// =============================================================

import { createClient } from "@supabase/supabase-js";
import { hashSessionToken } from "./_lib/student-auth.js";

const CONTRACT_VERSION = "1.0";

function bearerToken(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("X-VPA-Contract-Version", CONTRACT_VERSION);
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "GET or POST only" });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "supabase env not configured" });
  }

  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: "invalid_session" });
  const tokenHash = hashSessionToken(token);

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    );

    const { data: session, error: sessionErr } = await supabase
      .from("student_sessions")
      .select(
        "id, student_id, expires_at, revoked_at, students(id, first_name, last_initial, grade, avatar_emoji, is_active)",
      )
      .eq("token_hash", tokenHash)
      .maybeSingle();
    if (sessionErr) {
      console.warn("[student-session] lookup failed", sessionErr);
      return res.status(500).json({ error: "lookup_failed" });
    }
    if (!session) return res.status(401).json({ error: "invalid_session" });
    if (session.revoked_at) return res.status(401).json({ error: "session_revoked" });
    if (new Date(session.expires_at).getTime() < Date.now()) {
      return res.status(410).json({ error: "session_expired" });
    }
    const s = session.students;
    if (!s || s.is_active === false) {
      return res.status(403).json({ error: "student_inactive" });
    }

    // Best-effort last_seen_at bump.
    supabase
      .from("student_sessions")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", session.id)
      .then(() => null, () => null);

    return res.status(200).json({
      ok: true,
      student: {
        id: s.id,
        firstName: s.first_name,
        lastInitial: s.last_initial,
        grade: s.grade,
        avatarEmoji: s.avatar_emoji,
      },
    });
  } catch (err) {
    console.warn("[student-session] unexpected", err);
    return res.status(500).json({ error: "internal_error" });
  }
}
