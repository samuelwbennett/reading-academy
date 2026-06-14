// =============================================================
// READING ACADEMY — /api/class-set-code  (M16-L3)
//
// Teacher-only endpoint. Generates and assigns a unique class_code
// to a teacher_classes row the caller owns. Used both to mint a
// fresh code on class creation and to rotate a leaked code.
//
// POST { classId } → { ok: true, classCode }
// =============================================================

import { createClient } from "@supabase/supabase-js";
import { generateClassCode } from "./_lib/student-auth.js";

const CONTRACT_VERSION = "1.0";
const MAX_ATTEMPTS = 8;

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
  const classId = String(body?.classId || "").trim();
  if (!classId) return res.status(400).json({ error: "classId required" });

  try {
    const userClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
      { global: { headers: { Authorization: `Bearer ${jwt}` } } },
    );
    // Identify the calling teacher — RLS-bound select.
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user) return res.status(401).json({ error: "invalid_jwt" });

    const adminClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    );

    // Verify the caller owns this class.
    const { data: cls, error: ownErr } = await adminClient
      .from("teacher_classes")
      .select("id, teacher_user_id")
      .eq("id", classId)
      .maybeSingle();
    if (ownErr || !cls) {
      return res.status(404).json({ error: "class_not_found" });
    }
    if (cls.teacher_user_id !== user.id) {
      return res.status(403).json({ error: "not_class_owner" });
    }

    // Try a few candidates against the unique index.
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const candidate = generateClassCode();
      const { error: updErr } = await adminClient
        .from("teacher_classes")
        .update({ class_code: candidate, updated_at: new Date().toISOString() })
        .eq("id", classId);
      if (!updErr) {
        return res.status(200).json({ ok: true, classCode: candidate });
      }
      // 23505 = unique violation. Anything else is fatal.
      if (updErr.code !== "23505") {
        console.warn("[class-set-code] update failed", updErr);
        return res.status(500).json({ error: "update_failed" });
      }
    }
    return res
      .status(500)
      .json({ error: "code_collision", details: "tried 8 candidates" });
  } catch (err) {
    console.warn("[class-set-code] unexpected", err);
    return res.status(500).json({ error: "internal_error" });
  }
}
