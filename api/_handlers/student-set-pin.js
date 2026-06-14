// =============================================================
// READING ACADEMY — /api/student-set-pin  (M16-L3)
//
// Teacher-only endpoint. Sets / rotates the PIN on a student row
// the calling teacher owns (via class membership).
//
// Body:
//   { studentId, pin, avatarEmoji?, firstName?, lastInitial?, grade? }
//
// PIN omitted → server generates one and returns it (never echoes
// the rotated PIN otherwise; it only ever appears at this moment).
//
// Response:
//   { ok: true, studentId, pin? } — pin only present when generated
// =============================================================

import { createClient } from "@supabase/supabase-js";
import {
  hashPin,
  isValidPinFormat,
  generateRandomPin,
} from "./_lib/student-auth.js";

const CONTRACT_VERSION = "1.0";

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
  const studentId = String(body?.studentId || "").trim();
  if (!studentId) return res.status(400).json({ error: "studentId required" });

  let pinToSet = body?.pin == null ? null : String(body.pin).trim();
  let pinWasGenerated = false;
  if (pinToSet === null) {
    pinToSet = generateRandomPin();
    pinWasGenerated = true;
  }
  if (!isValidPinFormat(pinToSet)) {
    return res.status(400).json({ error: "invalid_pin_format" });
  }

  try {
    const userClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
      { global: { headers: { Authorization: `Bearer ${jwt}` } } },
    );
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user) return res.status(401).json({ error: "invalid_jwt" });

    const adminClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    );

    // Confirm the caller can see this student through any of their
    // owned classes. teacher_can_see_student is RLS-friendly but we
    // call it inline via a join here for clarity.
    const { data: visible, error: visErr } = await adminClient
      .from("class_memberships")
      .select("class_id, teacher_classes!inner(teacher_user_id)")
      .eq("student_id", studentId)
      .eq("teacher_classes.teacher_user_id", user.id)
      .limit(1)
      .maybeSingle();
    if (visErr) {
      console.warn("[student-set-pin] visibility check failed", visErr);
      return res.status(500).json({ error: "visibility_check_failed" });
    }
    if (!visible) {
      return res.status(403).json({ error: "student_not_in_caller_classes" });
    }

    const { hash, salt } = hashPin(pinToSet);
    const update = {
      pin_hash: hash,
      pin_salt: salt,
      created_by_teacher: user.id,
    };
    if (typeof body?.avatarEmoji === "string" && body.avatarEmoji.length <= 8) {
      update.avatar_emoji = body.avatarEmoji;
    }
    if (typeof body?.firstName === "string" && body.firstName.length <= 64) {
      update.first_name = body.firstName.trim();
    }
    if (typeof body?.lastInitial === "string" && body.lastInitial.length <= 2) {
      update.last_initial = body.lastInitial.trim();
    }
    if (typeof body?.grade === "string" && body.grade.length <= 8) {
      update.grade = body.grade.trim();
    }

    const { error: updErr } = await adminClient
      .from("students")
      .update(update)
      .eq("id", studentId);
    if (updErr) {
      console.warn("[student-set-pin] update failed", updErr);
      return res.status(500).json({ error: "update_failed" });
    }

    return res.status(200).json({
      ok: true,
      studentId,
      pin: pinWasGenerated ? pinToSet : undefined,
    });
  } catch (err) {
    console.warn("[student-set-pin] unexpected", err);
    return res.status(500).json({ error: "internal_error" });
  }
}
