// =============================================================
// READING ACADEMY — /api/bulk-provision-students (M14-D)
//
// Bulk version of provision-student + create-student-invite. Takes
// a list of {displayName, gradeLevel?} entries, optionally a target
// classId to enroll them all into, and returns a parallel result
// array with each student's id + sign-in URL.
//
// Designed for "I have a 25-name CSV from the registrar — give me
// 25 invite links to mail-merge."
//
// Body:
//   {
//     classId?: uuid,
//     students: [{ displayName, gradeLevel? }, ... ]   // 1..50 entries
//     expiresInHours?: number                          // optional, per invite
//   }
//
// Reply:
//   {
//     ok: true,
//     classId: uuid|null,
//     results: [
//       { displayName, ok: true, studentId, inviteUrl, expiresAt },
//       { displayName, ok: false, error: "..." },
//       ...
//     ],
//     summary: { total, created, failed, enrolled }
//   }
//
// Architecture rules upheld:
//   - JWT validated server-side. Caller must be teacher/admin.
//   - Class ownership verified before any insert.
//   - Tokens generated server-side (never trusted from client).
//   - Per-row failures don't abort the whole batch — partial success
//     returns 207 so the UI can show what landed and what didn't.
//   - service-role key never reaches the client.
// =============================================================

import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { normalizeGrade } from "./_lib/grade.js";

const CONTRACT_VERSION = "1.0";
const MAX_BATCH = 50;
const DEFAULT_EXPIRES_HOURS = 24 * 14;

function bearerJwt(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

function siteOrigin(req) {
  if (process.env.PUBLIC_SITE_URL) return process.env.PUBLIC_SITE_URL.replace(/\/+$/, "");
  const proto = (req.headers?.["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = req.headers?.["x-forwarded-host"] || req.headers?.host || "reading-academy.vercel.app";
  return `${proto}://${host}`;
}

function newToken() {
  return randomBytes(32).toString("hex");
}

function normalizeName(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 80) return null;
  return trimmed;
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
  const classId = typeof body?.classId === "string" ? body.classId : null;
  const expiresInHours = Math.min(
    Math.max(Number(body?.expiresInHours) || DEFAULT_EXPIRES_HOURS, 1),
    24 * 30,
  );
  const inputs = Array.isArray(body?.students) ? body.students : null;
  if (!inputs || inputs.length === 0) {
    return res.status(400).json({ error: "students[] required" });
  }
  if (inputs.length > MAX_BATCH) {
    return res.status(400).json({
      error: `too many students in one batch (max ${MAX_BATCH})`,
    });
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

    // 2. Caller must be teacher/admin.
    const { data: profile } = await supabase
      .from("user_profiles")
      .select("role, organization_id")
      .eq("auth_user_id", authUser.id)
      .maybeSingle();
    if (!profile || (profile.role !== "teacher" && profile.role !== "admin")) {
      return res.status(403).json({ error: "teacher role required" });
    }

    // 3. If classId provided, verify access. Teachers must own the
    //    class; admins can enroll into any class in their org.
    if (classId) {
      const { data: cls, error: cErr } = await supabase
        .from("teacher_classes")
        .select("id, teacher_user_id, archived, organization_id")
        .eq("id", classId)
        .maybeSingle();
      if (cErr) {
        return res.status(500).json({ error: "class lookup failed", details: cErr.message });
      }
      if (!cls) {
        return res.status(404).json({ error: "class not found" });
      }
      if (cls.teacher_user_id !== authUser.id) {
        if (profile.role !== "admin") {
          return res.status(403).json({ error: "class not owned by caller" });
        }
        if (
          profile.organization_id &&
          cls.organization_id &&
          cls.organization_id !== profile.organization_id
        ) {
          return res.status(403).json({ error: "class is in a different organization" });
        }
      }
      if (cls.archived) {
        return res.status(400).json({ error: "class is archived" });
      }
    }

    const expiresAt = new Date(Date.now() + expiresInHours * 3600_000).toISOString();
    const origin = siteOrigin(req);
    const results = [];
    let created = 0;
    let failed = 0;
    let enrolled = 0;

    // 4. Walk each input. Per-row failure doesn't abort the batch.
    for (const raw of inputs) {
      const displayName = normalizeName(raw?.displayName);
      const gradeLevel = normalizeGrade(raw?.gradeLevel);
      if (!displayName) {
        results.push({
          displayName: raw?.displayName ?? null,
          ok: false,
          error: "invalid displayName (1-80 chars, non-empty)",
        });
        failed += 1;
        continue;
      }

      // 4a. Insert student. Grade is written to both columns —
      //     grade_level (base schema) and grade (passwordless login) —
      //     so the student's grade is consistent everywhere.
      const { data: student, error: insErr } = await supabase
        .from("students")
        .insert({ display_name: displayName, grade_level: gradeLevel, grade: gradeLevel })
        .select("id, display_name, grade_level")
        .single();
      if (insErr) {
        results.push({
          displayName,
          ok: false,
          error: `student create failed: ${insErr.message}`,
        });
        failed += 1;
        continue;
      }
      created += 1;

      // 4b. Optional enrollment. Bulk semantics: a single class fail
      //     does not invalidate the student row.
      let enrollWarning = null;
      if (classId) {
        const { error: enrErr } = await supabase
          .from("class_memberships")
          .insert({ class_id: classId, student_id: student.id });
        if (enrErr) {
          enrollWarning = enrErr.message;
        } else {
          enrolled += 1;
        }
      }

      // 4c. Mint a single-use invite.
      const token = newToken();
      const { error: invErr } = await supabase
        .from("student_invites")
        .insert({
          token,
          student_id: student.id,
          created_by: authUser.id,
          expires_at: expiresAt,
        });
      if (invErr) {
        results.push({
          displayName,
          studentId: student.id,
          ok: false,
          error: `invite mint failed: ${invErr.message}`,
          enrollWarning,
        });
        // student exists but no invite — caller can retry with /api/create-student-invite
        continue;
      }
      const inviteUrl = `${origin}/reading/signin?invite=${encodeURIComponent(token)}`;
      results.push({
        displayName,
        studentId: student.id,
        ok: true,
        inviteUrl,
        expiresAt,
        enrollWarning,
      });
    }

    const status = failed === 0 ? 200 : 207; // partial success → 207
    return res.status(status).json({
      ok: failed === 0,
      classId,
      results,
      summary: {
        total: inputs.length,
        created,
        failed,
        enrolled,
      },
    });
  } catch (err) {
    return res.status(500).json({
      error: "bulk-provision-students failed",
      details: err?.message || String(err),
    });
  }
}
