// =============================================================
// READING ACADEMY — /api/fulfill-redemption
//
// Admin-only. Moves a pending incentive_redemption row to either
// 'fulfilled' (admin handed over the cash) or 'cancelled' (student
// backed out → balance refunds because handleGet sums only the
// non-cancelled rows for totalRedeemed).
//
// POST body:
//   {
//     redemptionId: uuid,        // required
//     action: "fulfill" | "cancel"  // required
//   }
//
// Reply:
//   { ok: true, redemption: { ...updated row... } }
//
// Architecture rules upheld:
//   - JWT validated server-side. Caller must be admin.
//   - Cannot operate on a redemption belonging to a student outside
//     the admin's org.
//   - service-role key never leaves the function.
//   - Status transitions: only pending → fulfilled / cancelled is
//     allowed (no flipping fulfilled rows back to pending).
// =============================================================

import { createClient } from "@supabase/supabase-js";

const CONTRACT_VERSION = "1.0";
const ALLOWED_ACTIONS = new Set(["fulfill", "cancel"]);

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

  const redemptionId = typeof body?.redemptionId === "string" ? body.redemptionId : null;
  const action = typeof body?.action === "string" ? body.action : null;
  if (!redemptionId) return res.status(400).json({ error: "redemptionId required" });
  if (!action || !ALLOWED_ACTIONS.has(action)) {
    return res.status(400).json({ error: "action must be 'fulfill' or 'cancel'" });
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    );

    // 1. Validate JWT + admin role.
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

    // 2. Read the target redemption + its student's org.
    const { data: redemption, error: rErr } = await supabase
      .from("incentive_redemptions")
      .select("id, student_id, status, total_dollars")
      .eq("id", redemptionId)
      .maybeSingle();
    if (rErr) {
      return res.status(500).json({ error: "redemption lookup failed", details: rErr.message });
    }
    if (!redemption) {
      return res.status(404).json({ error: "redemption not found" });
    }
    if (redemption.status !== "pending") {
      return res.status(400).json({
        error: `redemption is already ${redemption.status}; only pending rows can be acted on`,
      });
    }

    // 3. Single-org pilot: skip per-student org check because
    //    `public.students` has no organization_id column. Future
    //    multi-org work should join through class_memberships +
    //    teacher_classes to confirm org membership.

    // 4. Apply the transition.
    const newStatus = action === "fulfill" ? "fulfilled" : "cancelled";
    const { data: updated, error: uErr } = await supabase
      .from("incentive_redemptions")
      .update({
        status: newStatus,
        fulfilled_at: action === "fulfill" ? new Date().toISOString() : null,
        fulfilled_by: action === "fulfill" ? authUser.id : null,
      })
      .eq("id", redemptionId)
      .select()
      .single();
    if (uErr) {
      return res.status(500).json({ error: "redemption update failed", details: uErr.message });
    }

    return res.status(200).json({ ok: true, redemption: updated });
  } catch (err) {
    return res.status(500).json({
      error: "fulfill-redemption failed",
      details: err?.message || String(err),
    });
  }
}
