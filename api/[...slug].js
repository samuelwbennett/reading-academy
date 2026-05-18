// =============================================================
// READING ACADEMY — single-function API dispatcher
//
// Vercel's Hobby plan caps a project at 12 serverless functions, and
// each .js file under api/ counts. This catch-all routes every
// /api/<name> URL into one deployed function — staying within the
// cap without giving up per-endpoint code organisation.
//
// All previous /api/<name> URLs keep working untouched. Underlying
// handlers live in api/_handlers/ (the leading underscore tells
// Vercel not to deploy them as separate functions).
//
// Resilience policy (M15-G):
//   - Handlers are LAZY-imported on first hit. A broken handler
//     can no longer take down sibling routes at module load.
//   - Each module is cached after first successful import.
//   - Import-time failures surface as JSON 500 with the cause
//     instead of Vercel's generic FUNCTION_INVOCATION_FAILED.
// =============================================================

// Routes → relative module paths. Lazy-loaded.
const ROUTES = {
  "snapshot": () => import("./_handlers/snapshot.js"),
  "mastery": () => import("./_handlers/mastery.js"),
  "recap": () => import("./_handlers/recap.js"),
  "insight-recommendation": () => import("./_handlers/insight-recommendation.js"),
  "today": () => import("./_handlers/today.js"),
  "xp": () => import("./_handlers/xp.js"),
  "cognitive-contribution": () => import("./_handlers/cognitive-contribution.js"),
  "provision-self": () => import("./_handlers/provision-self.js"),
  "provision-student": () => import("./_handlers/provision-student.js"),
  "create-student-invite": () => import("./_handlers/create-student-invite.js"),
  "claim-student-invite": () => import("./_handlers/claim-student-invite.js"),
  "bulk-provision-students": () => import("./_handlers/bulk-provision-students.js"),
  "action-narration": () => import("./_handlers/action-narration.js"),
  "azure-speech-token": () => import("./_handlers/azure-speech-token.js"),
  // M16-L3: passwordless student auth
  "student-roster-by-code": () => import("./_handlers/student-roster-by-code.js"),
  "student-login": () => import("./_handlers/student-login.js"),
  "student-session": () => import("./_handlers/student-session.js"),
  "student-set-pin": () => import("./_handlers/student-set-pin.js"),
  "class-set-code": () => import("./_handlers/class-set-code.js"),
  // Admin endpoint: create a teacher_classes row owned by any
  // teacher in the admin's org (RLS otherwise only lets a user
  // create their own classes).
  "create-class": () => import("./_handlers/create-class.js"),
  // Admin endpoints for the incentive redemption fulfillment flow.
  // Pairs with the attendance economy in math-facts-trainer's
  // /api/incentives — students request, admins distribute.
  "list-pending-redemptions": () => import("./_handlers/list-pending-redemptions.js"),
  "fulfill-redemption": () => import("./_handlers/fulfill-redemption.js"),
  // Admin: link a VPA student to their external system id
  // (today only used for math_academy).
  "link-student-app-account": () => import("./_handlers/link-student-app-account.js"),
};

const handlerCache = new Map();

async function loadHandler(route) {
  if (handlerCache.has(route)) return handlerCache.get(route);
  const importer = ROUTES[route];
  if (!importer) return null;
  const mod = await importer();
  const fn = mod?.default || mod?.handler || mod;
  if (typeof fn !== "function") {
    throw new Error(`handler for "${route}" missing default export`);
  }
  handlerCache.set(route, fn);
  return fn;
}

function pickRoute(req) {
  // /api/<name>?... → "<name>"
  const url = req.url || "/";
  const path = url.split("?")[0];
  const after = path.replace(/^\/?api\/?/, "");
  const segment = after.split("/")[0] || "";
  return segment;
}

function setBaseHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
}

export default async function handler(req, res) {
  const route = pickRoute(req);

  if (!ROUTES[route]) {
    setBaseHeaders(res);
    return res.status(404).json({
      error: "unknown api route",
      route,
      knownRoutes: Object.keys(ROUTES),
    });
  }

  let fn;
  try {
    fn = await loadHandler(route);
  } catch (err) {
    console.warn(`[dispatcher] handler load failed for "${route}":`, err);
    setBaseHeaders(res);
    return res.status(500).json({
      error: "handler_load_failed",
      route,
      details: err?.message || String(err),
    });
  }

  try {
    return await fn(req, res);
  } catch (err) {
    console.warn(`[dispatcher] handler "${route}" threw:`, err);
    if (!res.headersSent) {
      setBaseHeaders(res);
      return res.status(500).json({
        error: "handler_threw",
        route,
        details: err?.message || String(err),
      });
    }
  }
}
