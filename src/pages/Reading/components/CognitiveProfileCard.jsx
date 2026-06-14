// src/pages/Reading/components/CognitiveProfileCard.jsx
//
// Reads two things from Supabase:
//   1. student_cognitive_profiles — the unified profile owned by the
//      orchestration layer
//   2. learning_apps + student_app_accounts — every VPA app this
//      student has data on, with mastered count + last activity
//
// Read-only. The merge math lives in the orchestration layer, not
// here. This is a pane of glass.

import React, { useEffect, useState } from "react";
import { supabase } from "../../../services/supabase.js";

const DIM_LABELS = {
  automaticity: "Automaticity",
  workingPace: "Working pace",
  persistence: "Persistence",
  forgettingSlope: "Forgetting slope",
  decodingEfficiency: "Decoding efficiency",
  mathFluency: "Math fluency",
  interventionResponsiveness: "Intervention responsiveness",
  masteryVelocity: "Mastery velocity",
};

const DIM_ORDER = [
  "decodingEfficiency",
  "automaticity",
  "masteryVelocity",
  "forgettingSlope",
  "workingPace",
  "persistence",
  "interventionResponsiveness",
  "mathFluency",
];

export default function CognitiveProfileCard({ studentId }) {
  const [profile, setProfile] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!studentId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [{ data: prof, error: pErr }, { data: apps }] = await Promise.all([
          supabase
            .from("student_cognitive_profiles")
            .select("dimensions, contributors, total_samples, updated_at, schema_version")
            .eq("student_id", studentId)
            .maybeSingle(),
          supabase.from("learning_apps").select("id, slug, display_name, version"),
        ]);

        if (pErr && pErr.code !== "PGRST116") throw pErr;
        const { data: rows, error: aErr } = await supabase
          .from("student_app_accounts")
          .select("app_id, state, updated_at")
          .eq("student_id", studentId);
        if (aErr) throw aErr;

        const appById = new Map((apps || []).map((a) => [a.id, a]));
        const merged = (rows || []).map((r) => {
          const app = appById.get(r.app_id) || { slug: r.app_id, display_name: r.app_id };
          const state = r.state || {};
          const nodes = state?.modelV2?.nodes || state?.nodes || {};
          let mastered = 0;
          for (const k of Object.keys(nodes)) {
            const status = nodes[k]?.status;
            if (
              status === "mastered" ||
              status === "mastered_for_acquisition" ||
              status === "in_automaticity_zone" ||
              status === "automatic"
            ) mastered += 1;
          }
          return {
            slug: app.slug,
            display_name: app.display_name,
            version: app.version,
            mastered,
            updated_at: r.updated_at,
          };
        });

        if (!cancelled) {
          setProfile(prof || null);
          setAccounts(merged);
        }
      } catch (e) {
        if (!cancelled) setError(e?.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [studentId]);

  if (!studentId) {
    return (
      <div style={{ color: "#999", fontStyle: "italic" }}>
        sign in to load the unified cognitive profile
      </div>
    );
  }
  if (loading) return <div style={{ color: "#888" }}>Loading…</div>;
  if (error) {
    return (
      <div style={{ color: "#c33" }}>
        Failed: {error}
        {error.includes("does not exist") && (
          <div style={{ marginTop: 6, color: "#666", fontSize: 12 }}>
            The cognitive-profile schema migration (M10-H) hasn't been applied yet. See
            {" "}<code>supabase/migrations/0002_cognitive_profile.sql</code>.
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <h3 style={{ fontSize: 13, margin: "0 0 8px", color: "#666", textTransform: "uppercase", letterSpacing: 0.5 }}>
        Connected apps
      </h3>
      {accounts.length === 0 && (
        <div style={{ color: "#999", fontStyle: "italic", marginBottom: 14 }}>
          no apps yet
        </div>
      )}
      {accounts.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8, marginBottom: 16 }}>
          {accounts.map((a) => (
            <div
              key={a.slug}
              style={{
                border: "1px solid #eee",
                borderRadius: 6,
                padding: "8px 10px",
                background: a.slug === "reading_academy" ? "#f3f7fb" : "#fafafa",
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 13 }}>{a.display_name || a.slug}</div>
              <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>
                {a.mastered} mastered &middot; {a.updated_at ? new Date(a.updated_at).toISOString().slice(0, 10) : "—"}
              </div>
            </div>
          ))}
        </div>
      )}

      <h3 style={{ fontSize: 13, margin: "0 0 8px", color: "#666", textTransform: "uppercase", letterSpacing: 0.5 }}>
        Cognitive profile (unified)
      </h3>
      {!profile && (
        <div style={{ color: "#999", fontStyle: "italic" }}>
          The orchestration layer hasn't merged a profile for you yet. It will populate after the launcher
          calls /api/cognitive-contribution and writes to <code>student_cognitive_profiles</code>.
        </div>
      )}
      {profile && (
        <>
          <div style={{ fontSize: 11, color: "#888", marginBottom: 8 }}>
            schema {profile.schema_version} &middot; {profile.total_samples} samples &middot; updated {profile.updated_at ? new Date(profile.updated_at).toISOString().slice(0, 16).replace("T", " ") : "—"}
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            {DIM_ORDER.map((k) => {
              const d = profile.dimensions?.[k];
              return <DimensionRow key={k} label={DIM_LABELS[k]} dim={d} />;
            })}
          </div>
          {profile.contributors && (
            <div style={{ marginTop: 14, fontSize: 11, color: "#888" }}>
              Contributors: {Object.keys(profile.contributors).join(" &middot; ") || "(none)"}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DimensionRow({ label, dim }) {
  const value = dim?.value;
  const conf = dim?.confidence ?? 0;
  const samples = dim?.samples ?? 0;
  const pct = value == null ? null : Math.round(value * 100);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "180px 1fr 70px 70px",
        gap: 10,
        alignItems: "center",
        fontSize: 13,
        borderBottom: "1px solid #f3f3f3",
        padding: "6px 0",
      }}
    >
      <div>{label}</div>
      <div style={{ background: "#f1f1f3", borderRadius: 999, height: 8, overflow: "hidden" }}>
        {value != null && (
          <div
            style={{
              width: `${pct}%`,
              height: "100%",
              background: "linear-gradient(90deg, #27a, #52d)",
              opacity: 0.4 + 0.6 * conf,
            }}
          />
        )}
      </div>
      <div style={{ textAlign: "right", color: "#444" }}>
        {value == null ? <span style={{ color: "#bbb" }}>—</span> : `${pct}%`}
      </div>
      <div style={{ textAlign: "right", color: "#888", fontSize: 11 }}>
        conf {Math.round(conf * 100)}% &middot; n {samples}
      </div>
    </div>
  );
}
