// =============================================================
// READING ACADEMY — /api/provision-self  (M12-B2)
//
// Idempotently provisions a user_profiles row for the calling auth
// user. The product role is decided server-side via env-var
// allowlists — clients never pick their own role.
//
// Provisioning policy:
//   - email in ADMIN_EMAIL_ALLOWLIST   → role 'admin'
//   - email in TEACHER_EMAIL_ALLOWLIST → role 'teacher'  (also creates a `teachers` row)
//   - everyone else                    → role 'student'
//
// Upgrade-only: subsequent calls will UPGRADE a profile's role
// (e.g. student → teacher, teacher → admin) but never silently
// downgrade. A manually-set higher role (admin set by SQL, or by a
// future admin UI) is preserved across sign-ins; revoking privilege
// requires a deliberate update.
//
// The first sign-in for a known teacher email lands them in the
// pilot org and creates both the user_profiles + teachers rows in
// the same call. Students are created as profile rows only —
// they're "awaiting roster assignment" until a teacher invites them.
//
// Architecture rules upheld (M12-B + LLM-boundary):
//   - JWT validated server-side via supabase.auth.getUser(jwt).
//   - service-role key never leaves the function.
//   - role assignment is server-controlled. Clients cannot pick role.
//   - no LLM in this code path.
// =============================================================

import { createClient } from "@supabase/supabase-js";

const CONTRACT_VERSION = "1.0";
const PILOT_ORG_SLUG = "vpa-pilot";

function bearerJwt(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

function safeName(emailOrFallback) {
  if (!emailOrFallback) return "User";
  const local = String(emailOrFallback).split("@")[0] || "";
  if (!local) return "User";
  return local
    .replace(/[._-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function parseAllowlist(value) {
  if (!value) return new Set();
  return new Set(
    String(value)
      .split(/[,\s]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

function decideRole(email) {
  const lower = (email || "").toLowerCase();
  if (!lower) return "student";
  const adminAllow = parseAllowlist(process.env.ADMIN_EMAIL_ALLOWLIST);
  if (adminAllow.has(lower)) return "admin";
  const teacherAllow = parseAllowlist(process.env.TEACHER_EMAIL_ALLOWLIST);
  if (teacherAllow.has(lower)) return "teacher";
  return "student";
}

async function ensurePilotOrgId(supabase) {
  const { data } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", PILOT_ORG_SLUG)
    .maybeSingle();
  return data?.id ?? null;
}

async function ensureTeacherRow(supabase, authUserId, displayName, orgId) {
  // Idempotent insert via upsert on the auth_user_id PK.
  const { error } = await supabase
    .from("teachers")
    .upsert(
      {
        auth_user_id: authUserId,
        display_name: displayName,
        organization_id: orgId,
      },
      { onConflict: "auth_user_id" },
    );
  if (error) {
    console.warn("[provision-self] teachers upsert failed:", error.message);
  }
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
    body = {};
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    );

    // 1. Validate JWT and resolve the auth user.
    const { data: userData, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return res.status(401).json({ error: "invalid bearer token" });
    }
    const authUser = userData.user;

    // 2. Decide product role.
    //
    //    Two signals are merged, in priority order:
    //      (a) Email in ADMIN_EMAIL_ALLOWLIST → admin
    //      (b) Email in TEACHER_EMAIL_ALLOWLIST → teacher
    //      (c) M19-8 self-heal: a default-state user who already
    //          OWNS at least one row in teacher_classes → teacher
    //          (regardless of env). Skipped when the user has been
    //          manually set to parent or admin, so deliberate role
    //          assignments aren't quietly overruled by class
    //          ownership. (Applied after the profile read below.)
    //      (d) otherwise → student
    //
    //    Server-controlled. Clients never pick role.
    let decidedRole = decideRole(authUser.email);

    // 3. Resolve pilot org id (singleton for v1).
    const orgId = await ensurePilotOrgId(supabase);

    // 4. Idempotent profile lookup / create.
    const { data: existing, error: readErr } = await supabase
      .from("user_profiles")
      .select("auth_user_id, role, display_name, organization_id, created_at, updated_at")
      .eq("auth_user_id", authUser.id)
      .maybeSingle();
    if (readErr) {
      console.warn("[provision-self] read failed:", readErr.message);
      return res.status(500).json({ error: "profile read failed", details: readErr.message });
    }

    // Self-heal: only promote student → teacher when the user has
    // no explicit non-student role on file. A manually-set parent
    // or admin is left alone, so class-ownership doesn't quietly
    // overrule a deliberate role assignment.
    if (decidedRole === "student" && (!existing || existing.role === "student")) {
      const { count: ownedClasses, error: countErr } = await supabase
        .from("teacher_classes")
        .select("id", { count: "exact", head: true })
        .eq("teacher_user_id", authUser.id);
      if (countErr) {
        console.warn(
          "[provision-self] teacher_classes count failed (non-fatal):",
          countErr.message,
        );
      } else if ((ownedClasses ?? 0) > 0) {
        decidedRole = "teacher";
      }
    }

    let profile = existing;
    let isNew = false;
    let roleChanged = false;
    if (!profile) {
      const displayName =
        (typeof body?.displayName === "string" && body.displayName.trim()) ||
        authUser.user_metadata?.full_name ||
        safeName(authUser.email);
      const { data: inserted, error: insertErr } = await supabase
        .from("user_profiles")
        .insert({
          auth_user_id: authUser.id,
          role: decidedRole,
          display_name: displayName,
          organization_id: orgId,
        })
        .select("auth_user_id, role, display_name, organization_id, created_at, updated_at")
        .single();
      if (insertErr) {
        console.warn("[provision-self] insert failed:", insertErr.message);
        return res.status(500).json({
          error: "profile create failed",
          details: insertErr.message,
        });
      }
      profile = inserted;
      isNew = true;
    } else if (profile.role !== decidedRole) {
      // The allowlist or self-heal calculated a different role from
      // what's on file. Upgrade-only: never silently downgrade.
      // A manually-set higher role (e.g. an admin set by SQL or a
      // teacher set by class ownership) is preserved across sign-ins;
      // revoking privilege has to be deliberate (drop from the
      // allowlist AND update user_profiles, or use a future admin UI).
      const RANK = { student: 1, parent: 1, teacher: 2, admin: 3 };
      const decidedRank = RANK[decidedRole] ?? 1;
      const currentRank = RANK[profile.role] ?? 1;

      if (decidedRank > currentRank) {
        const { data: updated, error: updateErr } = await supabase
          .from("user_profiles")
          .update({ role: decidedRole })
          .eq("auth_user_id", authUser.id)
          .select("auth_user_id, role, display_name, organization_id, created_at, updated_at")
          .single();
        if (updateErr) {
          console.warn("[provision-self] role update failed:", updateErr.message);
        } else {
          profile = updated;
          roleChanged = true;
        }
      }
    }

    // 5. If the (now) role is teacher or admin, ensure a `teachers` row.
    if (profile.role === "teacher" || profile.role === "admin") {
      await ensureTeacherRow(
        supabase,
        authUser.id,
        profile.display_name,
        profile.organization_id ?? orgId,
      );
    }

    // 6. Look up linked student row (only meaningful when role=student).
    const { data: student } = await supabase
      .from("students")
      .select("id, display_name, grade_level, auth_user_id")
      .eq("auth_user_id", authUser.id)
      .maybeSingle();

    // 7. Compose status flag the SPA renders directly.
    let status;
    if (profile.role === "admin") {
      status = "admin_ready";
    } else if (profile.role === "teacher") {
      status = "teacher_ready";
    } else if (profile.role === "student" && student) {
      status = "student_synced";
    } else if (profile.role === "student" && !student) {
      status = "awaiting_assignment";
    } else if (profile.role === "parent") {
      status = "parent_ready";
    } else {
      status = "unknown_role";
    }

    return res.status(200).json({
      ok: true,
      isNew,
      roleChanged,
      profile,
      student: student || null,
      status,
    });
  } catch (err) {
    console.warn("[provision-self] threw:", err);
    return res.status(500).json({
      error: "provision-self failed",
      details: err?.message || String(err),
    });
  }
}
