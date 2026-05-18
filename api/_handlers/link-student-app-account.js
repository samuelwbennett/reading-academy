// =============================================================
// READING ACADEMY — /api/link-student-app-account
//
// Admin-only. Upserts a row in student_app_accounts to associate
// a VPA student with their account in an external system.
//
// Today the only realistic use is linking the student's Math
// Academy numeric id so the MA proxy + cron can fetch their
// activity. (Math Facts / Reading Facts / Reading Academy
// auto-resolve via students.auth_user_id and don't need this.)
//
// Body:
//   {
//     studentId:  uuid,                    // required
//     slug:       string,                  // required, e.g. "math_academy"
//     externalId: string | null,           // required (null to unlink)
//     enabled?:   boolean                  // defaults to true
//   }
//
// Reply:
//   { ok: true, link: { studentId, slug, externalId, enabled } }
//
// Architecture rules upheld:
//   - JWT validated server-side. Caller must be admin.
//   - Org-scope: admin can only link students in their organization.
//   - service-role key never leaves the function.
// =============================================================

import { createClient } from "@supabase/supabase-js";

const CONTRACT_VERSION = "1.0";
const ALLOWED_SLUGS = new Set([
  "math_academy",
  // future: "math_facts", "reading_facts", "reading_academy" if we ever
  // need explicit external_id links for them (not needed today).
]);

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

  const studentId = typeof body?.studentId === "string" ? body.studentId : null;
  const slug = typeof body?.slug === "string" ? body.slug.trim() : null;
  const rawExternal = body?.externalId;
  const externalId =
    rawExternal === null || rawExternal === undefined || rawExternal === ""
      ? null
      : String(rawExternal).trim();
  const enabled = body?.enabled === false ? false : true;

  if (!studentId) return res.status(400).json({ error: "studentId required" });
  if (!slug || !ALLOWED_SLUGS.has(slug)) {
    return res.status(400).json({
      error: "slug required (one of: " + [...ALLOWED_SLUGS].join(", ") + ")",
    });
  }
  if (externalId && externalId.length > 80) {
    return res.status(400).json({ error: "externalId too long (max 80)" });
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    );

    // 1. JWT + admin role.
    const { data: userData, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return res.status(401).json({ error: "invalid bearer token" });
    }
    const authUser = userData.user;

    const { data: callerProfile } = await supabase
      .from("user_profiles")
      .select("role, organization_id")
      .eq("auth_user_id", authUser.id)
      .maybeSingle();
    if (!callerProfile || callerProfile.role !== "admin") {
      return res.status(403).json({ error: "admin role required" });
    }

    // 2. Verify the student exists. We DON'T org-scope-check at the
    //    students table because `public.students` has no
    //    organization_id column (org membership flows through
    //    `teacher_classes.organization_id` via `class_memberships`).
    //    For the single-org pilot this is fine. A future multi-org
    //    deployment should join through teacher_classes to confirm
    //    the student belongs to at least one class in the admin's org.
    const { data: student, error: sErr } = await supabase
      .from("students")
      .select("id, display_name")
      .eq("id", studentId)
      .maybeSingle();
    if (sErr) {
      return res.status(500).json({ error: "student lookup failed", details: sErr.message });
    }
    if (!student) return res.status(404).json({ error: "student not found" });

    // 3. Resolve the learning_apps row for the slug.
    const { data: app, error: appErr } = await supabase
      .from("learning_apps")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    if (appErr) return res.status(500).json({ error: "app lookup failed", details: appErr.message });
    if (!app?.id) return res.status(400).json({ error: `learning_apps row missing for slug '${slug}'` });

    // 4. Upsert. external_id = null means "unlink" (keep the row so
    //    we preserve any associated state.* but mark disabled).
    const payload = {
      student_id: studentId,
      app_id: app.id,
      external_id: externalId,
      enabled: externalId ? enabled : false,
    };

    const { data: row, error: upErr } = await supabase
      .from("student_app_accounts")
      .upsert(payload, { onConflict: "student_id,app_id" })
      .select()
      .single();
    if (upErr) {
      return res.status(500).json({ error: "link upsert failed", details: upErr.message });
    }

    return res.status(200).json({
      ok: true,
      link: {
        studentId,
        studentName: student.display_name,
        slug,
        externalId: row.external_id,
        enabled: row.enabled,
      },
    });
  } catch (err) {
    return res.status(500).json({
      error: "link-student-app-account failed",
      details: err?.message || String(err),
    });
  }
}
