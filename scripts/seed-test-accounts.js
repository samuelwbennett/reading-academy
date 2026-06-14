#!/usr/bin/env node
// scripts/seed-test-accounts.js (M19-2)
//
// Idempotent test-account seeder for Reading Academy role testing.
//
// What this does:
//   1. Looks up two existing Supabase Auth users by email
//        - admin@test.readingacademy.local
//        - teacher@test.readingacademy.local
//      (These must be created FIRST via the Supabase dashboard —
//      Auth → Users → Add user → Create user. This script will NOT
//      create them because doing so requires a separate Admin API
//      grant and is brittle for re-runs.)
//   2. Upserts user_profiles rows with roles `admin` and `teacher`.
//   3. Upserts a `teachers` row + organization for the teacher.
//   4. Upserts a class "Test Class A" with fixed class_code "TEST1".
//   5. Upserts three students — Ava A, Ben B, Mia M — each with a
//      fixed avatar, demo PIN, and class membership.
//
// Demo PINs (development only):
//   Ava A — 1111
//   Ben B — 2222
//   Mia M — 3333
// These ARE NOT safe for production. The seed script refuses to run
// unless you opt in via SEED_DEMO_PINS=1 or NODE_ENV=development.
//
// Usage:
//   1. Create the two test users in Supabase Dashboard → Auth → Users.
//      Pick any password — the script doesn't touch passwords.
//   2. Make sure these env vars are set:
//        SUPABASE_URL
//        SUPABASE_SERVICE_ROLE_KEY
//        SEED_DEMO_PINS=1   (or NODE_ENV=development)
//   3. Run: node scripts/seed-test-accounts.js
//
// Re-running is safe — every write is upsert or conflict-aware.

import { createClient } from "@supabase/supabase-js";
import { scryptSync, randomBytes } from "node:crypto";

const ADMIN_EMAIL = "admin@test.readingacademy.local";
const TEACHER_EMAIL = "teacher@test.readingacademy.local";
const TEST_CLASS_NAME = "Test Class A";
const TEST_CLASS_CODE = "TEST1";
const PILOT_ORG_SLUG = "vpa-pilot";

const STUDENTS = [
  { firstName: "Ava A.", lastInitial: "A", grade: "1", avatarEmoji: "🦊", pin: "1111" },
  { firstName: "Ben B.", lastInitial: "B", grade: "1", avatarEmoji: "🐶", pin: "2222" },
  { firstName: "Mia M.", lastInitial: "M", grade: "2", avatarEmoji: "🌟", pin: "3333" },
];

// --- guards ---------------------------------------------------------

const allowDemo =
  process.env.SEED_DEMO_PINS === "1" ||
  process.env.NODE_ENV === "development" ||
  process.env.NODE_ENV === "test";

if (!allowDemo) {
  console.error(
    "Refusing to seed weak demo PINs. Set SEED_DEMO_PINS=1 or NODE_ENV=development to confirm this is not production.",
  );
  process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env. Pull them from your Vercel project or local .env.local and re-run.",
  );
  process.exit(1);
}

// --- PIN hash helper (mirrors api/_handlers/_lib/student-auth.js) ----
// Kept verbatim so the seeded hashes verify against the live runtime.

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384;
const SALT_BYTES = 16;

function hashPin(pin) {
  const salt = randomBytes(SALT_BYTES).toString("hex");
  const hash = scryptSync(String(pin), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_COST,
  }).toString("hex");
  return { hash, salt };
}

// --- service-role client -------------------------------------------

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- main flow ------------------------------------------------------

async function main() {
  console.log("→ Looking up test Auth users…");
  const adminUser = await findAuthUser(ADMIN_EMAIL);
  const teacherUser = await findAuthUser(TEACHER_EMAIL);
  if (!adminUser || !teacherUser) {
    console.error(
      "\nOne or both test users were not found in Supabase Auth.\n" +
        "Create them in the Supabase dashboard first:\n" +
        `  - ${ADMIN_EMAIL}\n` +
        `  - ${TEACHER_EMAIL}\n` +
        "Set any password you can remember; the script doesn't manage passwords.\n",
    );
    process.exit(1);
  }
  console.log(`   admin    ${ADMIN_EMAIL}    ${adminUser.id}`);
  console.log(`   teacher  ${TEACHER_EMAIL}  ${teacherUser.id}`);

  console.log("→ Ensuring pilot organization…");
  const pilotOrgId = await ensurePilotOrgId();
  console.log(`   org      ${PILOT_ORG_SLUG}  ${pilotOrgId}`);

  console.log("→ Upserting user_profiles…");
  await upsertProfile(adminUser.id, "admin", "Test Admin", pilotOrgId);
  await upsertProfile(teacherUser.id, "teacher", "Test Teacher", pilotOrgId);

  console.log("→ Upserting teachers row…");
  await upsertTeacherRow(teacherUser.id, "Test Teacher", pilotOrgId);

  console.log("→ Upserting test class…");
  const classId = await upsertTestClass(teacherUser.id, pilotOrgId);
  console.log(`   class    ${TEST_CLASS_NAME}  ${classId}  code=${TEST_CLASS_CODE}`);

  console.log("→ Upserting students…");
  const studentIds = [];
  for (const s of STUDENTS) {
    const id = await upsertStudent(s, teacherUser.id);
    studentIds.push({ id, ...s });
    console.log(
      `   student  ${s.firstName} ${s.lastInitial}.  ${id}  pin=${s.pin}`,
    );
  }

  console.log("→ Enrolling students in test class…");
  for (const { id } of studentIds) {
    await enrollIfMissing(classId, id);
  }

  console.log("\n✓ Seed complete.\n");
  console.log("Credentials (development only):");
  console.log(`  Admin login         email: ${ADMIN_EMAIL}    password: (set in Supabase dashboard)`);
  console.log(`  Teacher login       email: ${TEACHER_EMAIL}  password: (set in Supabase dashboard)`);
  console.log(`  Student class code  ${TEST_CLASS_CODE}`);
  for (const s of STUDENTS) {
    console.log(`  Student PIN         ${s.firstName} ${s.lastInitial}. ${s.avatarEmoji}  pin=${s.pin}`);
  }
  console.log("");
  console.log("Reminder: this seed is DEMO ONLY. Production must use the");
  console.log("rotate-PIN flow in the roster UI, never these PINs.\n");
}

// --- helpers --------------------------------------------------------

async function findAuthUser(email) {
  // Iterate listUsers (paginated) until we find the email. The Admin
  // API offers no direct getUserByEmail at this SDK version.
  for (let page = 1; page < 30; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: 50,
    });
    if (error) throw error;
    if (!data?.users?.length) return null;
    const found = data.users.find(
      (u) => (u.email || "").toLowerCase() === email.toLowerCase(),
    );
    if (found) return found;
    if (data.users.length < 50) return null; // last page
  }
  return null;
}

async function ensurePilotOrgId() {
  const { data } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", PILOT_ORG_SLUG)
    .maybeSingle();
  if (data?.id) return data.id;
  const { data: created, error } = await supabase
    .from("organizations")
    .insert({ name: "VPA Pilot", slug: PILOT_ORG_SLUG, org_type: "pilot" })
    .select("id")
    .single();
  if (error) throw error;
  return created.id;
}

async function upsertProfile(authUserId, role, displayName, orgId) {
  const { error } = await supabase
    .from("user_profiles")
    .upsert(
      {
        auth_user_id: authUserId,
        role,
        display_name: displayName,
        organization_id: orgId,
      },
      { onConflict: "auth_user_id" },
    );
  if (error) throw error;
}

async function upsertTeacherRow(authUserId, displayName, orgId) {
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
  if (error) throw error;
}

async function upsertTestClass(teacherUserId, orgId) {
  // M19.2: look up by (teacher_user_id, name) instead of by class_code.
  // The old logic searched by class_code, which produced duplicates
  // whenever the existing Test Class A row had a NULL code (e.g. from
  // a pre-M16-L1 seed run). If any row matches by name+teacher, use
  // it and ensure class_code = TEST1; otherwise insert.
  const { data: matches } = await supabase
    .from("teacher_classes")
    .select("id, class_code, archived")
    .eq("teacher_user_id", teacherUserId)
    .eq("name", TEST_CLASS_NAME)
    .order("created_at", { ascending: true });

  if (matches && matches.length > 0) {
    // Prefer one that already has TEST1, else the oldest.
    const primary =
      matches.find((c) => c.class_code === TEST_CLASS_CODE) || matches[0];

    // Free TEST1 from any squatter that isn't the primary.
    const { data: squatter } = await supabase
      .from("teacher_classes")
      .select("id")
      .eq("class_code", TEST_CLASS_CODE)
      .neq("id", primary.id)
      .maybeSingle();
    if (squatter?.id) {
      await supabase
        .from("teacher_classes")
        .update({ class_code: null })
        .eq("id", squatter.id);
    }

    await supabase
      .from("teacher_classes")
      .update({
        teacher_user_id: teacherUserId,
        archived: false,
        name: TEST_CLASS_NAME,
        grade_level: "1-2",
        organization_id: orgId,
        class_code: TEST_CLASS_CODE,
      })
      .eq("id", primary.id);

    // Warn (but don't fail) if multiple Test Class A rows exist —
    // the repair script (repair-passwordless-auth.js) collapses them.
    if (matches.length > 1) {
      console.warn(
        `   warn: ${matches.length} "${TEST_CLASS_NAME}" rows owned by this teacher; ` +
          `kept ${primary.id} as primary. Run scripts/repair-passwordless-auth.js to consolidate.`,
      );
    }
    return primary.id;
  }

  const { data: created, error } = await supabase
    .from("teacher_classes")
    .insert({
      teacher_user_id: teacherUserId,
      organization_id: orgId,
      name: TEST_CLASS_NAME,
      grade_level: "1-2",
      class_code: TEST_CLASS_CODE,
      archived: false,
    })
    .select("id")
    .single();
  if (error) throw error;
  return created.id;
}

async function upsertStudent(student, createdByTeacherId) {
  // Find an existing demo student by the unique combo (first_name +
  // last_initial + created_by_teacher). We deliberately don't reuse
  // students across runs from production data — only ones the seed
  // itself created.
  const { data: existing } = await supabase
    .from("students")
    .select("id, pin_hash")
    .eq("first_name", student.firstName)
    .eq("last_initial", student.lastInitial)
    .eq("created_by_teacher", createdByTeacherId)
    .maybeSingle();

  const { hash, salt } = hashPin(student.pin);
  const row = {
    display_name: `${student.firstName} ${student.lastInitial}.`,
    first_name: student.firstName,
    last_initial: student.lastInitial,
    grade: student.grade,
    avatar_emoji: student.avatarEmoji,
    pin_hash: hash,
    pin_salt: salt,
    is_active: true,
    created_by_teacher: createdByTeacherId,
  };

  if (existing?.id) {
    const { error } = await supabase
      .from("students")
      .update(row)
      .eq("id", existing.id);
    if (error) throw error;
    return existing.id;
  }
  const { data: created, error } = await supabase
    .from("students")
    .insert(row)
    .select("id")
    .single();
  if (error) throw error;
  return created.id;
}

async function enrollIfMissing(classId, studentId) {
  const { data: existing } = await supabase
    .from("class_memberships")
    .select("class_id")
    .eq("class_id", classId)
    .eq("student_id", studentId)
    .maybeSingle();
  if (existing) return;
  const { error } = await supabase
    .from("class_memberships")
    .insert({ class_id: classId, student_id: studentId });
  if (error) throw error;
}

main().catch((err) => {
  console.error("seed failed:", err?.message || err);
  process.exit(1);
});
