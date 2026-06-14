// =============================================================
// READING ACADEMY — /api/create-student-invite (M13-B)
//
// Mints a single-use invite token tied to an existing students row.
// The teacher shares the resulting URL with the student / parent;
// when the student signs in via that URL, /api/claim-student-invite
// links their fresh auth.users row to the pre-existing students row.
//
// Body:  { studentId: uuid, expiresInHours?: number }
// Reply: { ok: true, token, inviteUrl, expiresAt }
//
// Architecture rules:
//   - JWT validated server-side. Caller must own a class that
//     contains the target student.
//   - Token is generated server-side (cryptographically random).
//   - service-role key never reaches the client.
// =============================================================

import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";

const CONTRACT_VERSION = "1.0";
const DEFAULT_EXPIRES_HOURS = 24 * 14; // 14 days

function bearerJwt(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

function siteOrigin(req) {
  // Best-effort site URL for the invite. Production domain takes
  // precedence; fall back to the request's host.
  if (process.env.PUBLIC_SITE_URL) return process.env.PUBLIC_SITE_URL.replace(/\/+$/, "");
  const proto = (req.headers?.["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = req.headers?.["x-forwarded-host"] || req.headers?.host || "reading-academy.vercel.app";
  return `${proto}://${host}`;
}

function newToken() {
  // 32 bytes → 64-char hex. Plenty of entropy for a single-use token.
  return randomBytes(32).toString("hex");
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
  const studentId = String(body?.studentId || "").trim();
  const expiresInHours = Math.min(
    Math.max(Number(body?.expiresInHours) || DEFAULT_EXPIRES_HOURS, 1),
    24 * 30, // 30-day cap
  );
  if (!studentId) return res.status(400).json({ error: "studentId required" });

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

    // 2. Caller must be teacher/admin.
    const { data: profile } = await supabase
      .from("user_profiles")
      .select("role")
      .eq("auth_user_id", authUser.id)
      .maybeSingle();
    if (!profile || (profile.role !== "teacher" && profile.role !== "admin")) {
      return res.status(403).json({ error: "teacher role required" });
    }

    // 3. Caller must own a class that contains this student.
    const { data: ownership } = await supabase
      .from("class_memberships")
      .select("class_id, teacher_classes!inner(teacher_user_id)")
      .eq("student_id", studentId)
      .eq("teacher_classes.teacher_user_id", authUser.id)
      .limit(1);
    if (!ownership || ownership.length === 0) {
      // Admins can invite any student; non-admin teachers must own a class.
      if (profile.role !== "admin") {
        return res.status(403).json({ error: "student not in any of your classes" });
      }
    }

    // 4. Check student exists + is unclaimed.
    const { data: student } = await supabase
      .from("students")
      .select("id, display_name, auth_user_id")
      .eq("id", studentId)
      .maybeSingle();
    if (!student) {
      return res.status(404).json({ error: "student not found" });
    }
    if (student.auth_user_id) {
      return res.status(400).json({
        error: "student already linked to an auth user",
        hint: "revoke the prior invite or remove the auth_user_id link first",
      });
    }

    // 5. Mint the token + insert. Service-role bypasses RLS.
    const token = newToken();
    const expiresAt = new Date(Date.now() + expiresInHours * 3600_000).toISOString();
    const { error: insertErr } = await supabase
      .from("student_invites")
      .insert({
        token,
        student_id: studentId,
        created_by: authUser.id,
        expires_at: expiresAt,
      });
    if (insertErr) {
      return res.status(500).json({
        error: "invite create failed",
        details: insertErr.message,
      });
    }

    const inviteUrl = `${siteOrigin(req)}/reading/signin?invite=${encodeURIComponent(token)}`;
    return res.status(200).json({
      ok: true,
      token,
      inviteUrl,
      expiresAt,
      student: { id: student.id, display_name: student.display_name },
    });
  } catch (err) {
    return res.status(500).json({
      error: "create-student-invite failed",
      details: err?.message || String(err),
    });
  }
}
