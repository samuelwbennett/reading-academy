import React from "react";

// Progress strip for the adaptive placement walk.
//
// The walk has no fixed length — it stops as soon as it finds the
// student's frontier — so there's no honest "Skill 3 of 12" to show.
// Instead we surface the running count of skills checked and the item
// position within the current skill. The bar reflects item progress
// inside the current skill (it resets each skill); that's the only
// segment whose length is actually known.
export default function DiagnosticProgress({
  skillsChecked = 0,
  itemIdx = 0,
  itemsPerNode = 3,
  gradeLabel,
}) {
  const pct = Math.min(
    100,
    Math.round((itemIdx / Math.max(1, itemsPerNode)) * 100),
  );

  return (
    <div className="ra-diag-progress">
      <div className="ra-diag-progress-row">
        <span>
          {gradeLabel ? `${gradeLabel} placement` : "Placement"}
          {skillsChecked > 0
            ? ` · ${skillsChecked} skill${skillsChecked === 1 ? "" : "s"} checked`
            : ""}
        </span>
        <span>
          Question {itemIdx + 1} of {itemsPerNode}
        </span>
      </div>
      <div className="ra-progress-bar">
        <div className="ra-progress-bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
