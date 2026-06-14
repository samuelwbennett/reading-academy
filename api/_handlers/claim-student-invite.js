// =============================================================
// READING ACADEMY — /api/claim-student-invite (M13-B)
//
// Called by the SignIn page after the student authenticates with
// an `?invite=<token>` URL parameter. Three things happen in one
// transaction-shaped sequence:
//   1. Validate the JWT and the token.
//   2. Link the auth user to the existing students row (set
//      students.auth_user_id) and convert the user_profiles row
//      to role 'student'.
//   3. Mark the invite as claimed.
//
// Side note: we intentionally re-issue the user_profiles row even
// if /api/provision-self already created it — invites should
// promote a freshly-signed-in 'student-by-default' row to be
// definitively the right student record.
//
// Body:  { token: string }
// Reply: { ok: true, studentId, student }
// =============================================================

import { createClient } from "@supabase/supabase-js";

const CONTRACT_VERSION = "1.0";
const PILOT_ORG_SLUG = "vpa-pilot";

function bearerJwt(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("X-VPA-Contract-Version", CONTRACT_VERSION);
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "supabase env not configured" });
  }
  const jwt = bearerJwt(req);
  if (!jwt) return res.status(401).json({ error: "missing bearer token" });

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch {
    return res.status(400).json({ error: "invalid JSON body" });
  }
  const token = String(body?.token || "").trim();
  if (!token) return res.status(400).json({ error: "token required" });

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    );

    // 1. Validate JWT.
    const { data: userData, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return res.status(401).json({ error: "invalid bearer token" });
    }
    const authUser = userData.user;

    // 2. Look up the invite. Must be unclaimed, unrevoked, unexpired.
    const { data: invite, error: invErr } = await supabase
      .from("student_invites")
      .select("invite_id, token, student_id, expires_at, claimed_at, revoked_at")
      .eq("token", token)
      .maybeSingle();
    if (invErr) {
      return res.status(500).json({ error: "invite lookup failed", details: invErr.message });
    }
    if (!invite) return res.status(404).json({ error: "invite not found" });
    if (invite.claimed_at) return res.status(400).json({ error: "invite already claimed" });
    if (invite.revoked_at) return res.status(400).json({ error: "invite revoked" });
    if (new Date(invite.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: "invite expired" });
    }

    // 3. Look up the target student. Must not already be linked.
    const { data: student, error: stErr } = await supabase
      .from("students")
      .select("id, display_name, grade_level, auth_user_id")
      .eq("id", invite.student_id)
      .maybeSingle();
    if (stErr) {
      return res.status(500).json({ error: "student lookup failed", details: stErr.message });
    }
    if (!student) return res.status(404).json({ error: "student not found" });
    if (student.auth_user_id && student.auth_user_id !== authUser.id) {
      return res.status(409).json({
        error: "student already claimed by a different auth user",
      });
    }

    // 4. Resolve pilot org (mirrors provision-self).
    const { data: org } = await supabase
      .from("organizations")
      .select("id")
      .eq("slug", PILOT_ORG_SLUG)
      .maybeSingle();
    const orgId = org?.id ?? null;

    // 5. Link the auth user to the student row.
    const { error: linkErr } = await supabase
      .from("students")
      .update({ auth_user_id: authUser.id })
      .eq("id", student.id);
    if (linkErr) {
      return res.status(500).json({
        error: "student link failed",
        details: linkErr.message,
      });
    }

    // 6. Upsert the user_profiles row as a 'student'. This intentionally
    //    overrides the default 'teacher/student' decision from
    //    /api/provision-self — accepting an invite is the canonical
    //    signal that this auth user is a student.
    const displayName =
      student.display_name ||
      authUser.user_metadata?.full_name ||
      authUser.email ||
      "Student";
    const { error: upsertErr } = await supabase
      .from("user_profiles")
      .upsert(
        {
          auth_user_id: authUser.id,
          role: "student",
          display_name: displayName,
          organization_id: orgId,
        },
        { onConflict: "auth_user_id" },
      );
    if (upsertErr) {
      // Roll back the student link to keep state consistent.
      await supabase
        .from("students")
        .update({ auth_user_id: null })
        .eq("id", student.id);
      return res.status(500).json({
        error: "profile upsert failed",
        details: upsertErr.message,
      });
    }

    // 7. Mark invite claimed.
    const { error: claimErr } = await supabase
      .from("student_invites")
      .update({
        claimed_at: new Date().toISOString(),
        claimed_by_auth_user_id: authUser.id,
      })
      .eq("invite_id", invite.invite_id);
    if (claimErr) {
      console.warn("[claim-student-invite] mark-claimed failed:", claimErr.message);
      // Not fatal — the link succeeded.
    }

    return res.status(200).json({
      ok: true,
      studentId: student.id,
      student: { ...student, auth_user_id: authUser.id },
    });
  } catch (err) {
    return res.status(500).json({
      error: "claim-student-invite failed",
      details: err?.message || String(err),
    });
  }
}
