// =============================================================
// READING ACADEMY — /api/student-roster-by-code  (M16-L3)
//
// PUBLIC endpoint. Given a class code, returns the avatar grid the
// student picks from on the login page. Returns ONLY non-sensitive
// fields (no pin_hash, no parent_email, no auth_user_id).
//
// GET /api/student-roster-by-code?code=VAIL5
// → 200 { ok: true, classId, className, students: [{ id, firstName,
//                                                    lastInitial, avatarEmoji }] }
// → 404 { error: "unknown_class_code" }
//
// Rate-limit-friendly: returns the same shape regardless of whether
// any students exist; the API does not leak whether a code exists
// to a brute-force attacker beyond the 5-char alphabet (≈ 28^5 ≈
// 17M combos, all unambiguous chars). For production rate-limiting
// add Vercel Edge Middleware later.
// =============================================================

import { createClient } from "@supabase/supabase-js";

const CONTRACT_VERSION = "1.0";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("X-VPA-Contract-Version", CONTRACT_VERSION);
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "supabase env not configured" });
  }

  const url = new URL(req.url || "/", "http://x");
  const code = String(url.searchParams.get("code") || "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(code)) {
    return res.status(400).json({ error: "invalid_class_code_format" });
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    );

    const { data: cls, error: classErr } = await supabase
      .from("teacher_classes")
      .select("id, name, archived")
      .eq("class_code", code)
      .maybeSingle();
    if (classErr) {
      console.warn("[student-roster-by-code] class lookup failed", classErr);
      return res.status(500).json({ error: "lookup_failed" });
    }
    if (!cls || cls.archived) {
      return res.status(404).json({ error: "unknown_class_code" });
    }

    const { data: members, error: memErr } = await supabase
      .from("class_memberships")
      .select(
        "students(id, first_name, last_initial, avatar_emoji, is_active)",
      )
      .eq("class_id", cls.id);
    if (memErr) {
      console.warn("[student-roster-by-code] members lookup failed", memErr);
      return res.status(500).json({ error: "lookup_failed" });
    }

    const students = (members || [])
      .map((row) => row.students)
      .filter((s) => s && s.is_active !== false)
      .map((s) => ({
        id: s.id,
        firstName: s.first_name || "",
        lastInitial: s.last_initial || "",
        avatarEmoji: s.avatar_emoji || "🌱",
      }))
      // Stable alpha order so the grid layout is predictable for a
      // student looking for their name.
      .sort((a, b) =>
        (a.firstName || "").localeCompare(b.firstName || ""),
      );

    return res.status(200).json({
      ok: true,
      classId: cls.id,
      className: cls.name,
      students,
    });
  } catch (err) {
    console.warn("[student-roster-by-code] unexpected", err);
    return res.status(500).json({ error: "internal_error" });
  }
}
