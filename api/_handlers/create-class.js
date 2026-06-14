// =============================================================
// READING ACADEMY — /api/create-class
//
// Admin-only endpoint that inserts a `teacher_classes` row owned
// by a teacher the admin specifies. Lets the admin set up classes
// from the admin UI without needing to be the teacher themselves
// (the table's RLS only lets you insert classes where
// teacher_user_id = auth.uid()).
//
// Body:
//   {
//     name:           string,                       // required
//     teacherUserId:  uuid,                         // required, must be a teacher/admin in the same org
//     gradeLevel?:    "K" | "1".."12" | range, e.g. "K-2"
//   }
//
// Reply:
//   { ok: true, classId, class }
//
// Architecture rules upheld:
//   - JWT validated server-side. Caller's role read from
//     user_profiles; only admins allowed past the gate.
//   - service-role key never leaves the function.
//   - Target teacher must exist and (if both have orgs) be in the
//     admin's organization.
//   - No LLMs in this code path.
// =============================================================

import { createClient } from "@supabase/supabase-js";
import { normalizeGrade } from "./_lib/grade.js";

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

  const name = (body?.name || "").trim();
  const teacherUserId = typeof body?.teacherUserId === "string" ? body.teacherUserId : null;
  const gradeLevel = normalizeGrade(body?.gradeLevel);

  if (!name) return res.status(400).json({ error: "name required" });
  if (name.length > 80) return res.status(400).json({ error: "name too long (max 80)" });
  if (!teacherUserId) return res.status(400).json({ error: "teacherUserId required" });

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

    // 2. Caller must be admin.
    const { data: callerProfile } = await supabase
      .from("user_profiles")
      .select("role, organization_id")
      .eq("auth_user_id", authUser.id)
      .maybeSingle();
    if (!callerProfile || callerProfile.role !== "admin") {
      return res.status(403).json({ error: "admin role required" });
    }

    // 3. Target teacher must exist and be a teacher/admin in the same org.
    const { data: teacherProfile, error: tErr } = await supabase
      .from("user_profiles")
      .select("role, organization_id")
      .eq("auth_user_id", teacherUserId)
      .maybeSingle();
    if (tErr) {
      return res.status(500).json({ error: "teacher lookup failed", details: tErr.message });
    }
    if (!teacherProfile) {
      return res.status(404).json({ error: "teacher not found" });
    }
    if (teacherProfile.role !== "teacher" && teacherProfile.role !== "admin") {
      return res.status(400).json({
        error: "target user is not a teacher",
        hint: "promote the user to teacher first (allowlist + sign-in, or set user_profiles.role)",
      });
    }
    if (
      callerProfile.organization_id &&
      teacherProfile.organization_id &&
      teacherProfile.organization_id !== callerProfile.organization_id
    ) {
      return res.status(403).json({ error: "teacher is in a different organization" });
    }

    // 4. Insert the class.
    const { data: cls, error: insErr } = await supabase
      .from("teacher_classes")
      .insert({
        teacher_user_id: teacherUserId,
        name,
        grade_level: gradeLevel,
        organization_id: callerProfile.organization_id,
      })
      .select("id, name, grade_level, teacher_user_id, organization_id, created_at")
      .single();
    if (insErr) {
      return res.status(500).json({
        error: "class create failed",
        details: insErr.message,
      });
    }

    return res.status(200).json({
      ok: true,
      classId: cls.id,
      class: cls,
    });
  } catch (err) {
    return res.status(500).json({
      error: "create-class failed",
      details: err?.message || String(err),
    });
  }
}
