// =============================================================
// READING ACADEMY — /api/student-login  (M16-L3)
//
// PUBLIC endpoint. Validates a passwordless student login and mints
// a session token. Caller posts:
//
//   POST /api/student-login
//   { code: "VAIL5", studentId: "<uuid>", pin: "1234", deviceLabel?: "iPad-A" }
//
// → 200 { ok: true, sessionToken, expiresAt, student: {...} }
// → 401 { error: "bad_credentials" }   // pin wrong OR student/class mismatch
// → 404 { error: "unknown_class_code" }
// → 403 { error: "student_inactive" }
//
// Security:
//   - PIN compared via constant-time scrypt (verifyPin).
//   - Session token: 256-bit random; only its sha256 hash is stored.
//   - We deliberately collapse "wrong PIN", "wrong studentId", and
//     "studentId not in this class" into a single 401 so a wrong
//     guess can't enumerate the roster.
//   - Service-role only — SPA never sees pin_hash.
//   - No rate-limit here yet; add Vercel Edge Middleware before
//     opening to public traffic.
// =============================================================

import { createClient } from "@supabase/supabase-js";
import {
  hashSessionToken,
  generateSessionToken,
  verifyPin,
  isValidPinFormat,
} from "./_lib/student-auth.js";

const CONTRACT_VERSION = "1.0";
const SESSION_LIFETIME_DAYS = 30;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("X-VPA-Contract-Version", CONTRACT_VERSION);
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "supabase env not configured" });
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch {
    return res.status(400).json({ error: "invalid JSON body" });
  }

  const code = String(body?.code || "").trim().toUpperCase();
  const studentId = String(body?.studentId || "").trim();
  const pin = String(body?.pin || "").trim();
  const deviceLabel =
    typeof body?.deviceLabel === "string"
      ? body.deviceLabel.slice(0, 64)
      : null;

  if (!/^[A-Z0-9]{4,8}$/.test(code)) {
    return res.status(400).json({ error: "invalid_class_code_format" });
  }
  if (!studentId || studentId.length < 8) {
    return res.status(400).json({ error: "invalid_student_id" });
  }
  if (!isValidPinFormat(pin)) {
    return res.status(400).json({ error: "invalid_pin_format" });
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    );

    // 1. Look up class by code.
    const { data: cls, error: classErr } = await supabase
      .from("teacher_classes")
      .select("id, name, archived")
      .eq("class_code", code)
      .maybeSingle();
    if (classErr) {
      console.warn("[student-login] class lookup failed", classErr);
      return res.status(500).json({ error: "lookup_failed" });
    }
    if (!cls || cls.archived) {
      return res.status(404).json({ error: "unknown_class_code" });
    }

    // 2. Verify student is in that class.
    const { data: membership, error: memErr } = await supabase
      .from("class_memberships")
      .select("student_id")
      .eq("class_id", cls.id)
      .eq("student_id", studentId)
      .maybeSingle();
    if (memErr) {
      console.warn("[student-login] membership lookup failed", memErr);
      return res.status(500).json({ error: "lookup_failed" });
    }
    if (!membership) {
      // Don't leak whether the student exists vs is in a different
      // class — same response as a wrong PIN.
      return res.status(401).json({ error: "bad_credentials" });
    }

    // 3. Pull student row (includes pin_hash + pin_salt + is_active).
    const { data: student, error: studentErr } = await supabase
      .from("students")
      .select(
        "id, first_name, last_initial, grade, avatar_emoji, pin_hash, pin_salt, is_active",
      )
      .eq("id", studentId)
      .maybeSingle();
    if (studentErr) {
      console.warn("[student-login] student lookup failed", studentErr);
      return res.status(500).json({ error: "lookup_failed" });
    }
    if (!student) {
      return res.status(401).json({ error: "bad_credentials" });
    }
    if (student.is_active === false) {
      return res.status(403).json({ error: "student_inactive" });
    }
    if (!student.pin_hash || !student.pin_salt) {
      // Teacher hasn't set a PIN yet. Block login until they do.
      return res.status(403).json({ error: "pin_not_set" });
    }

    // 4. Verify PIN.
    if (!verifyPin(pin, student.pin_hash, student.pin_salt)) {
      return res.status(401).json({ error: "bad_credentials" });
    }

    // 5. Mint session token + persist hash.
    const { token, hash } = generateSessionToken();
    const expiresAt = new Date(
      Date.now() + SESSION_LIFETIME_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { error: insErr } = await supabase
      .from("student_sessions")
      .insert({
        student_id: student.id,
        token_hash: hash,
        device_label: deviceLabel,
        expires_at: expiresAt,
      });
    if (insErr) {
      console.warn("[student-login] session insert failed", insErr);
      return res.status(500).json({ error: "session_create_failed" });
    }

    // 6. Best-effort last_login_at bump (non-fatal).
    await supabase
      .from("students")
      .update({ last_login_at: new Date().toISOString() })
      .eq("id", student.id);

    return res.status(200).json({
      ok: true,
      sessionToken: token,
      expiresAt,
      student: {
        id: student.id,
        firstName: student.first_name,
        lastInitial: student.last_initial,
        grade: student.grade,
        avatarEmoji: student.avatar_emoji,
        classId: cls.id,
        className: cls.name,
      },
    });
  } catch (err) {
    console.warn("[student-login] unexpected", err);
    return res.status(500).json({ error: "internal_error" });
  }
}
