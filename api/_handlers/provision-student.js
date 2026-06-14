// =============================================================
// READING ACADEMY — /api/provision-student
//
// Teacher-only endpoint that creates a `students` row. Optionally
// enrolls the new student into a class the calling teacher owns,
// in one round trip.
//
// The students table is service-role-managed because RLS doesn't
// grant general INSERT (we don't want any client to be able to
// invent students). This endpoint is the controlled path.
//
// Body:
//   {
//     displayName: string,                  // required
//     gradeLevel?: "K" | "1".."12",         // optional
//     classId?: uuid                         // if set, enroll immediately
//   }
//
// Response:
//   { ok: true, studentId, enrolledIn?: classId }
//
// Architecture rules upheld:
//   - JWT validated server-side. Caller's role checked against
//     user_profiles before any insert.
//   - service-role key never sent to the client.
//   - classId, if provided, must be a class the caller owns.
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

  const displayName = (body?.displayName || "").trim();
  const gradeLevel = normalizeGrade(body?.gradeLevel);
  const classId = typeof body?.classId === "string" ? body.classId : null;

  if (!displayName) return res.status(400).json({ error: "displayName required" });
  if (displayName.length > 80) {
    return res.status(400).json({ error: "displayName too long (max 80)" });
  }

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

    // 2. Caller must have a teacher (or admin) profile.
    const { data: callerProfile } = await supabase
      .from("user_profiles")
      .select("role")
      .eq("auth_user_id", authUser.id)
      .maybeSingle();
    if (!callerProfile) {
      return res.status(403).json({
        error: "caller has no profile",
        hint: "POST /api/provision-self first",
      });
    }
    if (callerProfile.role !== "teacher" && callerProfile.role !== "admin") {
      return res.status(403).json({ error: "teacher role required" });
    }

    // 3. If a classId was provided, verify the caller owns it.
    if (classId) {
      const { data: cls, error: cErr } = await supabase
        .from("teacher_classes")
        .select("id, teacher_user_id, archived")
        .eq("id", classId)
        .maybeSingle();
      if (cErr) {
        return res.status(500).json({ error: "class lookup failed", details: cErr.message });
      }
      if (!cls || cls.teacher_user_id !== authUser.id) {
        return res.status(403).json({ error: "class not owned by caller" });
      }
      if (cls.archived) {
        return res.status(400).json({ error: "class is archived" });
      }
    }

    // 4. Insert the student. auth_user_id stays null until the student
    //    is invited to sign in (M13). Grade is written to both columns —
    //    grade_level (base schema) and grade (passwordless login).
    const { data: student, error: insertErr } = await supabase
      .from("students")
      .insert({
        display_name: displayName,
        grade_level: gradeLevel,
        grade: gradeLevel,
      })
      .select("id, display_name, grade_level")
      .single();
    if (insertErr) {
      return res.status(500).json({
        error: "student create failed",
        details: insertErr.message,
      });
    }

    // 5. If classId was provided, enroll the student.
    let enrolledIn = null;
    if (classId) {
      const { error: enrollErr } = await supabase
        .from("class_memberships")
        .insert({ class_id: classId, student_id: student.id });
      if (enrollErr) {
        // Don't fail the whole call — student was created. Surface
        // the partial success so the UI can prompt for retry.
        return res.status(207).json({
          ok: true,
          studentId: student.id,
          student,
          enrolledIn: null,
          enrollWarning: enrollErr.message,
        });
      }
      enrolledIn = classId;
    }

    return res.status(200).json({
      ok: true,
      studentId: student.id,
      student,
      enrolledIn,
    });
  } catch (err) {
    return res.status(500).json({
      error: "provision-student failed",
      details: err?.message || String(err),
    });
  }
}
