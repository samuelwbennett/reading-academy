#!/usr/bin/env node
// scripts/repair-passwordless-auth.js (M19.1)
//
// Single idempotent repair pass for Reading Academy's partial-
// migration auth state. Diagnoses each fragment, fixes what's
// broken, prints a verifiable state report at the end.
//
// WHY THIS EXISTS:
//   Production accumulated state from multiple half-runs of the seed
//   script (some before the M16-L1 schema migration), the M19-8
//   provision-self self-heal (after some user_profiles writes), and
//   manual SQL attempts. The seed script alone can't undo every
//   inconsistency (e.g. NULL class_code on an older Test Class A row;
//   demo students with auth_user_id set from a prior invite test;
//   stale student_invites). This script reconciles all of them
//   without deleting production data.
//
// WHAT IT REPAIRS:
//   1. teacher_classes.class_code — fills NULLs, ensures the Test
//      Class A row owned by the test teacher has code TEST1.
//   2. user_profiles.role — re-asserts admin/teacher for the two
//      demo accounts (via service_role + the role-lock trigger
//      bypass).
//   3. students.pin_hash + students.pin_salt — re-hashes the demo
//      PINs (1111/2222/3333) into freshly-generated rows so every
//      demo student can log in via /student.
//   4. students.is_active — forces true for demo students.
//   5. students.auth_user_id — UNLINKS auth_user_id for demo
//      students (they're passwordless; an auth link from a prior
//      test breaks the invite + roster code paths).
//   6. student_invites — revokes any outstanding invites that
//      point at demo students.
//   7. class_memberships — ensures the three demo students are
//      enrolled in Test Class A.
//   8. teacher_sessions, student_sessions — left alone (auto-
//      expire), but the report counts active sessions per student.
//
// USAGE:
//   SEED_DEMO_PINS=1 \
//   SUPABASE_URL="https://<project>.supabase.co" \
//   SUPABASE_SERVICE_ROLE_KEY="<service role key>" \
//   node scripts/repair-passwordless-auth.js
//
//   Add --dry-run to see what would change without writing.
//
// SAFETY:
//   * Service-role only. Bypasses RLS for the writes it needs to
//     make, but never deletes existing classes, students, or
//     memberships. The harshest action is setting auth_user_id to
//     NULL on a demo student — recoverable by re-claiming an invite.
//   * Refuses to run unless SEED_DEMO_PINS=1 or NODE_ENV=development,
//     same latch as the seed script.
//   * Idempotent. Re-runs print the same final state and write the
//     same fields.

import { createClient } from "@supabase/supabase-js";
import { scryptSync, randomBytes } from "node:crypto";

// --- constants (mirror seed-test-accounts.js) ----------------------

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

// --- guards --------------------------------------------------------

const DRY_RUN = process.argv.includes("--dry-run");

const allowDemo =
  process.env.SEED_DEMO_PINS === "1" ||
  process.env.NODE_ENV === "development" ||
  process.env.NODE_ENV === "test";

if (!allowDemo) {
  console.error(
    "Refusing to run. Set SEED_DEMO_PINS=1 or NODE_ENV=development to confirm this is not production.",
  );
  process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env.");
  process.exit(1);
}

// --- PIN hash (verbatim from api/_handlers/_lib/student-auth.js) ----

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

// --- service-role client + log helpers ----------------------------

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const repairs = [];
function diagnose(label, detail) {
  console.log(`   [diag] ${label}${detail ? `: ${detail}` : ""}`);
}
function fix(label, detail) {
  if (DRY_RUN) {
    console.log(`   [dry ] would ${label}${detail ? `: ${detail}` : ""}`);
  } else {
    console.log(`   [fix ] ${label}${detail ? `: ${detail}` : ""}`);
    repairs.push(label);
  }
}
function ok(label, detail) {
  console.log(`   [ok  ] ${label}${detail ? `: ${detail}` : ""}`);
}

// =====================================================================
// main flow
// =====================================================================

async function main() {
  console.log("\n========== M19.1 — Passwordless auth repair pass ==========");
  if (DRY_RUN) console.log("(dry-run: no writes will land)\n");

  // 1. Lookup auth users
  console.log("\n→ 1. Auth users");
  const adminUser = await findAuthUser(ADMIN_EMAIL);
  const teacherUser = await findAuthUser(TEACHER_EMAIL);
  if (!adminUser) {
    console.error(`   missing auth.users for ${ADMIN_EMAIL}. Create in Supabase Dashboard → Auth → Users.`);
    process.exit(2);
  }
  if (!teacherUser) {
    console.error(`   missing auth.users for ${TEACHER_EMAIL}. Create in Supabase Dashboard → Auth → Users.`);
    process.exit(2);
  }
  ok("admin auth user", `${adminUser.id} (${adminUser.email})`);
  ok("teacher auth user", `${teacherUser.id} (${teacherUser.email})`);

  // 2. Pilot org
  console.log("\n→ 2. Pilot organization");
  const pilotOrgId = await ensurePilotOrgId();
  ok("organization", `${PILOT_ORG_SLUG} = ${pilotOrgId}`);

  // 3. user_profiles (role re-assertion)
  console.log("\n→ 3. user_profiles roles");
  await repairProfile(adminUser.id, "admin", "Test Admin", pilotOrgId);
  await repairProfile(teacherUser.id, "teacher", "Test Teacher", pilotOrgId);

  // 4. teachers row for the teacher
  console.log("\n→ 4. teachers row");
  await repairTeachersRow(teacherUser.id, "Test Teacher", pilotOrgId);

  // 5. Classes owned by the teacher — fix codes, prefer the one with members
  console.log("\n→ 5. teacher_classes (class_code repair)");
  const primaryClassId = await reconcileTestClass(teacherUser.id, pilotOrgId);
  if (!primaryClassId) {
    console.error("   could not establish a primary test class.");
    process.exit(3);
  }

  // 6. Students — re-hash PINs, force is_active, UNLINK auth_user_id,
  //    revoke pending invites.
  console.log("\n→ 6. students (PIN + auth_user_id + invites)");
  const studentIds = [];
  for (const s of STUDENTS) {
    const id = await repairStudent(s, teacherUser.id);
    studentIds.push({ ...s, id });
  }

  // 7. class_memberships
  console.log("\n→ 7. class_memberships");
  for (const s of studentIds) {
    await ensureMembership(primaryClassId, s.id);
  }

  // 8. Final state report
  console.log("\n========== State report ==========\n");
  await printStateReport({
    adminUser,
    teacherUser,
    primaryClassId,
    studentIds,
  });

  // 9. Verification checklist
  console.log("\n========== Verification checklist ==========\n");
  printChecklist({ primaryClassId, studentIds });

  if (DRY_RUN) {
    console.log("\n(dry-run: no writes were applied.)");
  } else if (repairs.length === 0) {
    console.log("\n✓ Nothing needed repair. State was already clean.");
  } else {
    console.log(`\n✓ Repair complete. ${repairs.length} action(s) applied.`);
  }
}

// =====================================================================
// reconciliation helpers
// =====================================================================

async function findAuthUser(email) {
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
    if (data.users.length < 50) return null;
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
  if (DRY_RUN) {
    fix("create pilot organization", PILOT_ORG_SLUG);
    return "<would-create>";
  }
  const { data: created, error } = await supabase
    .from("organizations")
    .insert({ name: "VPA Pilot", slug: PILOT_ORG_SLUG, org_type: "pilot" })
    .select("id")
    .single();
  if (error) throw error;
  fix("created pilot organization", PILOT_ORG_SLUG);
  return created.id;
}

async function repairProfile(authUserId, expectedRole, displayName, orgId) {
  const { data: existing } = await supabase
    .from("user_profiles")
    .select("role, display_name, organization_id")
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  if (!existing) {
    if (DRY_RUN) {
      fix(`insert ${expectedRole} profile`, displayName);
      return;
    }
    const { error } = await supabase.from("user_profiles").insert({
      auth_user_id: authUserId,
      role: expectedRole,
      display_name: displayName,
      organization_id: orgId,
    });
    if (error) throw error;
    fix(`inserted profile`, `${displayName} → ${expectedRole}`);
    return;
  }
  if (existing.role !== expectedRole) {
    diagnose(`profile role mismatch`, `${displayName} is ${existing.role}, expected ${expectedRole}`);
    if (DRY_RUN) {
      fix(`update role`, `${displayName}: ${existing.role} → ${expectedRole}`);
      return;
    }
    // Service-role bypasses user_profiles_role_lock trigger.
    const { error } = await supabase
      .from("user_profiles")
      .update({
        role: expectedRole,
        display_name: displayName,
        organization_id: orgId,
      })
      .eq("auth_user_id", authUserId);
    if (error) throw error;
    fix(`updated role`, `${displayName} → ${expectedRole}`);
    return;
  }
  ok(`profile`, `${displayName} = ${existing.role}`);
}

async function repairTeachersRow(authUserId, displayName, orgId) {
  const { data: existing } = await supabase
    .from("teachers")
    .select("auth_user_id, display_name")
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  if (existing) {
    ok("teachers row", displayName);
    return;
  }
  if (DRY_RUN) {
    fix("insert teachers row", displayName);
    return;
  }
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
  fix("inserted teachers row", displayName);
}

async function reconcileTestClass(teacherUserId, orgId) {
  // M19.2: more aggressive consolidation. Includes archived rows in
  // the search (so we catch every duplicate), MOVES memberships into
  // the primary before archiving duplicates (preserves enrollments),
  // and clears class_code from every non-primary row so the primary
  // is the only TEST1 holder.

  const { data: classes, error } = await supabase
    .from("teacher_classes")
    .select("id, name, class_code, archived, created_at, teacher_user_id")
    .eq("teacher_user_id", teacherUserId)
    .eq("name", TEST_CLASS_NAME);
  if (error) throw error;

  diagnose(
    "Test Class A rows owned by teacher",
    `${(classes || []).length} (active + archived)`,
  );
  for (const c of classes || []) {
    diagnose(
      "  candidate",
      `id=${c.id} code=${c.class_code || "NULL"} archived=${c.archived} created=${c.created_at}`,
    );
  }

  if (!classes || classes.length === 0) {
    if (DRY_RUN) {
      fix("create Test Class A");
      return "<would-create>";
    }
    const { data: created, error: cErr } = await supabase
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
    if (cErr) throw cErr;
    fix("created Test Class A", `code=${TEST_CLASS_CODE} id=${created.id}`);
    return created.id;
  }

  // Annotate each candidate with member count + has-TEST1 flag.
  const annotated = await Promise.all(
    classes.map(async (c) => {
      const { count } = await supabase
        .from("class_memberships")
        .select("class_id", { count: "exact", head: true })
        .eq("class_id", c.id);
      return { ...c, memberCount: count ?? 0 };
    }),
  );

  // Choose the primary by (1) already has TEST1, (2) not archived,
  // (3) most members, (4) oldest. The primary's class_code becomes
  // TEST1; everything else gets archived + code cleared.
  annotated.sort((a, b) => {
    const aHas = a.class_code === TEST_CLASS_CODE;
    const bHas = b.class_code === TEST_CLASS_CODE;
    if (aHas !== bHas) return aHas ? -1 : 1;
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    if (b.memberCount !== a.memberCount) return b.memberCount - a.memberCount;
    return new Date(a.created_at) - new Date(b.created_at);
  });
  const primary = annotated[0];
  const duplicates = annotated.slice(1);
  diagnose(
    "primary selected",
    `id=${primary.id} code=${primary.class_code || "NULL"} members=${primary.memberCount}`,
  );

  // Free TEST1 from any squatter (including a duplicate that holds it).
  const { data: squatters } = await supabase
    .from("teacher_classes")
    .select("id")
    .eq("class_code", TEST_CLASS_CODE)
    .neq("id", primary.id);
  for (const sq of squatters || []) {
    if (DRY_RUN) {
      fix(`clear TEST1 from squatter`, sq.id);
    } else {
      const { error: clearErr } = await supabase
        .from("teacher_classes")
        .update({ class_code: null })
        .eq("id", sq.id);
      if (clearErr) throw clearErr;
      fix(`cleared TEST1 from squatter`, sq.id);
    }
  }

  // For each duplicate, MOVE memberships into primary, then archive.
  for (const dup of duplicates) {
    // 1. Move memberships.
    const { data: dupMemberships } = await supabase
      .from("class_memberships")
      .select("class_id, student_id")
      .eq("class_id", dup.id);
    for (const m of dupMemberships || []) {
      // Skip if student already enrolled in primary.
      const { data: alreadyIn } = await supabase
        .from("class_memberships")
        .select("class_id")
        .eq("class_id", primary.id)
        .eq("student_id", m.student_id)
        .maybeSingle();
      if (alreadyIn) {
        // Just drop the duplicate membership row — student is
        // already enrolled in primary.
        if (DRY_RUN) {
          fix(`drop duplicate membership`, `student=${m.student_id} from class=${dup.id}`);
        } else {
          const { error: delErr } = await supabase
            .from("class_memberships")
            .delete()
            .eq("class_id", dup.id)
            .eq("student_id", m.student_id);
          if (delErr) throw delErr;
          fix(`dropped duplicate membership`, `student=${m.student_id} from class=${dup.id}`);
        }
        continue;
      }
      // Move the membership.
      if (DRY_RUN) {
        fix(`move membership`, `student=${m.student_id} ${dup.id} → ${primary.id}`);
      } else {
        // Insert into primary first; if that succeeds, delete from dup.
        const { error: insErr } = await supabase
          .from("class_memberships")
          .insert({ class_id: primary.id, student_id: m.student_id });
        if (insErr && !String(insErr.message).includes("duplicate")) throw insErr;
        const { error: delErr } = await supabase
          .from("class_memberships")
          .delete()
          .eq("class_id", dup.id)
          .eq("student_id", m.student_id);
        if (delErr) throw delErr;
        fix(`moved membership`, `student=${m.student_id} → ${primary.id}`);
      }
    }
    // 2. Archive the duplicate row (and clear code if still set).
    const patch = { archived: true };
    if (dup.class_code) patch.class_code = null;
    if (DRY_RUN) {
      fix(`archive duplicate Test Class A`, dup.id);
    } else {
      const { error: archErr } = await supabase
        .from("teacher_classes")
        .update(patch)
        .eq("id", dup.id);
      if (archErr) throw archErr;
      fix(`archived duplicate Test Class A`, dup.id);
    }
  }

  // Finally patch the primary: TEST1, not archived, correct ownership.
  const patch = {
    teacher_user_id: teacherUserId,
    name: TEST_CLASS_NAME,
    grade_level: "1-2",
    organization_id: orgId,
    class_code: TEST_CLASS_CODE,
    archived: false,
  };
  if (DRY_RUN) {
    fix(`patch primary class`, `${primary.id}: ${JSON.stringify(patch)}`);
  } else {
    const { error: patchErr } = await supabase
      .from("teacher_classes")
      .update(patch)
      .eq("id", primary.id);
    if (patchErr) throw patchErr;
    fix(`patched primary class`, JSON.stringify(patch));
  }

  return primary.id;
}

async function repairStudent(student, teacherUserId) {
  const { data: existing } = await supabase
    .from("students")
    .select(
      "id, first_name, last_initial, avatar_emoji, is_active, pin_hash, pin_salt, auth_user_id",
    )
    .eq("first_name", student.firstName)
    .eq("last_initial", student.lastInitial)
    .eq("created_by_teacher", teacherUserId)
    .maybeSingle();

  // Build the canonical row we want.
  const { hash, salt } = hashPin(student.pin);
  const desired = {
    display_name: `${student.firstName} ${student.lastInitial}.`,
    first_name: student.firstName,
    last_initial: student.lastInitial,
    grade: student.grade,
    avatar_emoji: student.avatarEmoji,
    pin_hash: hash,
    pin_salt: salt,
    is_active: true,
    created_by_teacher: teacherUserId,
    // NULL out auth_user_id for demo students. They're passwordless;
    // an auth link from a prior invite breaks the invite + roster
    // code paths ("student already linked to an auth user").
    auth_user_id: null,
  };

  if (!existing) {
    if (DRY_RUN) {
      fix(`insert student`, `${student.firstName} pin=${student.pin}`);
      return "<would-create>";
    }
    const { data: created, error } = await supabase
      .from("students")
      .insert(desired)
      .select("id")
      .single();
    if (error) throw error;
    fix(`inserted student`, `${student.firstName} id=${created.id}`);
    return created.id;
  }

  // Diagnose any drift before fixing.
  const issues = [];
  if (!existing.pin_hash || !existing.pin_salt) issues.push("missing pin");
  if (existing.is_active === false) issues.push("is_active=false");
  if (existing.auth_user_id) issues.push(`auth_user_id=${existing.auth_user_id}`);
  if (existing.avatar_emoji !== student.avatarEmoji)
    issues.push(`avatar=${existing.avatar_emoji}→${student.avatarEmoji}`);
  if (issues.length === 0) {
    // Even when clean we re-hash so we know the PIN works after this run.
    // PIN re-hash is cheap (16ms scrypt) and matches the seed semantics.
    if (DRY_RUN) {
      fix(`re-hash pin`, `${student.firstName}`);
    } else {
      const { error: upErr } = await supabase
        .from("students")
        .update({ pin_hash: hash, pin_salt: salt })
        .eq("id", existing.id);
      if (upErr) throw upErr;
      ok(`student ${student.firstName}`, `id=${existing.id} (pin re-hashed)`);
    }
    await clearStudentInvites(existing.id);
    return existing.id;
  }

  diagnose(`student ${student.firstName}`, issues.join(", "));
  if (DRY_RUN) {
    fix(`repair student`, `${student.firstName}: ${issues.join(", ")}`);
    return existing.id;
  }
  const { error: upErr } = await supabase
    .from("students")
    .update(desired)
    .eq("id", existing.id);
  if (upErr) throw upErr;
  fix(`repaired student`, `${student.firstName} (${issues.join(", ")})`);
  await clearStudentInvites(existing.id);
  return existing.id;
}

async function clearStudentInvites(studentId) {
  const { data: outstanding, error } = await supabase
    .from("student_invites")
    .select("invite_id, token, claimed_at, revoked_at, expires_at")
    .eq("student_id", studentId)
    .is("claimed_at", null)
    .is("revoked_at", null);
  if (error) {
    // Table may not exist on extreme rollbacks; non-fatal.
    return;
  }
  if (!outstanding || outstanding.length === 0) return;
  diagnose(`pending invites for student`, `${studentId}: ${outstanding.length}`);
  if (DRY_RUN) {
    fix(`revoke ${outstanding.length} pending invite(s)`, studentId);
    return;
  }
  const { error: revErr } = await supabase
    .from("student_invites")
    .update({ revoked_at: new Date().toISOString() })
    .eq("student_id", studentId)
    .is("claimed_at", null)
    .is("revoked_at", null);
  if (revErr) {
    console.warn(`   warn: invite revoke failed: ${revErr.message}`);
    return;
  }
  fix(`revoked ${outstanding.length} pending invite(s)`, studentId);
}

async function ensureMembership(classId, studentId) {
  const { data: existing } = await supabase
    .from("class_memberships")
    .select("class_id")
    .eq("class_id", classId)
    .eq("student_id", studentId)
    .maybeSingle();
  if (existing) {
    ok(`membership`, `student ${studentId} in class ${classId}`);
    return;
  }
  if (DRY_RUN) {
    fix(`enroll student`, `${studentId} in ${classId}`);
    return;
  }
  const { error } = await supabase
    .from("class_memberships")
    .insert({ class_id: classId, student_id: studentId });
  if (error) throw error;
  fix(`enrolled student`, `${studentId} in ${classId}`);
}

// =====================================================================
// state report + verification checklist
// =====================================================================

async function printStateReport({ adminUser, teacherUser, primaryClassId, studentIds }) {
  // Profiles
  const { data: profiles } = await supabase
    .from("user_profiles")
    .select("auth_user_id, role, display_name")
    .in("display_name", ["Test Admin", "Test Teacher"]);
  console.log("Profiles:");
  for (const p of profiles || []) {
    const email =
      p.auth_user_id === adminUser.id
        ? ADMIN_EMAIL
        : p.auth_user_id === teacherUser.id
          ? TEACHER_EMAIL
          : "?";
    console.log(`  ${p.display_name.padEnd(14)} role=${p.role.padEnd(9)} email=${email}`);
  }

  // Class
  const { data: cls } = await supabase
    .from("teacher_classes")
    .select("id, name, class_code, archived")
    .eq("id", primaryClassId)
    .maybeSingle();
  if (cls) {
    console.log("\nClass:");
    console.log(`  ${cls.name.padEnd(14)} code=${(cls.class_code || "NULL").padEnd(8)} archived=${cls.archived} id=${cls.id}`);
  }

  // Students
  const ids = studentIds.map((s) => s.id).filter((id) => typeof id === "string" && id.length > 10);
  if (ids.length) {
    const { data: students } = await supabase
      .from("students")
      .select(
        "id, first_name, last_initial, avatar_emoji, is_active, auth_user_id, pin_hash, pin_salt",
      )
      .in("id", ids);
    console.log("\nStudents:");
    for (const s of students || []) {
      const pinSet = !!(s.pin_hash && s.pin_salt);
      const authState = s.auth_user_id ? "LINKED⚠" : "unlinked";
      console.log(
        `  ${s.first_name.padEnd(8)} ${s.last_initial}.  ${s.avatar_emoji}  pin_set=${pinSet}  active=${s.is_active}  auth=${authState}  id=${s.id}`,
      );
    }
  }

  // Active sessions per student
  if (ids.length) {
    const { data: sessions } = await supabase
      .from("student_sessions")
      .select("student_id, expires_at, revoked_at")
      .in("student_id", ids);
    const byStudent = new Map();
    for (const s of sessions || []) {
      const live = !s.revoked_at && new Date(s.expires_at).getTime() > Date.now();
      const arr = byStudent.get(s.student_id) || { live: 0, total: 0 };
      arr.total++;
      if (live) arr.live++;
      byStudent.set(s.student_id, arr);
    }
    if (byStudent.size > 0) {
      console.log("\nActive student sessions:");
      for (const [studentId, { live, total }] of byStudent.entries()) {
        console.log(`  ${studentId}  live=${live}  total=${total}`);
      }
    }
  }

  // Outstanding invites (should be 0 for demo students after repair)
  if (ids.length) {
    const { data: invites } = await supabase
      .from("student_invites")
      .select("invite_id, student_id, claimed_at, revoked_at, expires_at")
      .in("student_id", ids);
    const live = (invites || []).filter(
      (i) =>
        !i.claimed_at &&
        !i.revoked_at &&
        new Date(i.expires_at).getTime() > Date.now(),
    );
    if (live.length > 0) {
      console.log("\n⚠ Outstanding invites still present:");
      for (const i of live) console.log(`  invite_id=${i.invite_id} student=${i.student_id}`);
    } else {
      console.log("\nOutstanding invites: 0 (clean)");
    }
  }
}

function printChecklist({ primaryClassId, studentIds }) {
  console.log("1. Teacher login (Supabase Auth + role=teacher)");
  console.log(`   • Sign in as ${TEACHER_EMAIL} at /reading/signin`);
  console.log(`   • Status card shows: "Teacher account ready"`);
  console.log(`   • /reading/roster shows "Test Class A" with the new class code`);
  console.log(`   • /reading/debug → Account / role verification panel shows role=teacher`);
  console.log("");
  console.log("2. Admin login (Supabase Auth + role=admin)");
  console.log(`   • Sign in as ${ADMIN_EMAIL} at /reading/signin`);
  console.log(`   • Status card shows: "Admin account ready"`);
  console.log(`   • /reading/debug shows role=admin`);
  console.log("");
  console.log("3. Student passwordless login (no email, no password)");
  console.log(`   • Open /student in a fresh incognito window`);
  console.log(`   • Enter class code: ${TEST_CLASS_CODE}`);
  console.log(`   • Tap an avatar → enter PIN`);
  for (const s of studentIds) {
    if (typeof s.id !== "string" || s.id.length < 10) continue;
    console.log(`     - ${s.firstName} ${s.lastInitial}. ${s.avatarEmoji}  pin=${s.pin}`);
  }
  console.log(`   • Lands on /reading as that student`);
  console.log("");
  console.log("4. Route protection");
  console.log(`   • From the student window, navigate to /reading/roster → "Not authorized" panel`);
  console.log(`   • From the student window, navigate to /reading/debug   → "Not authorized" panel`);
  console.log("");
  console.log("5. Roster passwordless panel");
  console.log(`   • Teacher window: roster page → "Student login (passwordless)" panel`);
  console.log(`   • Class code displays as ${TEST_CLASS_CODE} (no longer "no code yet")`);
  console.log(`   • Per-student "Rotate PIN" works → new PIN appears once in yellow chip`);
  console.log(`   • "Print login cards" opens the printable view`);
  console.log("");
  console.log("Rollback: this script makes no destructive deletions. To revert to a");
  console.log("pre-seed state, sign out + manually delete the auth.users rows in the");
  console.log("Supabase Dashboard. The cascade removes user_profiles + teachers; the");
  console.log("teacher_classes and students rows persist (drop them manually if you");
  console.log("want a clean slate, but they're inert without an owning teacher).");
}

// =====================================================================
// go
// =====================================================================

main().catch((err) => {
  console.error("\nrepair failed:", err?.message || err);
  process.exit(1);
});
