import React from "react";

// Compact 60-second countdown, large readable digit + thin progress bar.
// Receives msRemaining and totalMs from the parent — pure presentation.

export default function FluencyTimer({ msRemaining, totalMs }) {
  const seconds = Math.ceil(Math.max(0, msRemaining) / 1000);
  const pct = Math.max(0, Math.min(100, (msRemaining / totalMs) * 100));

  return (
    <div className="ra-fluency-timer">
      <div className="ra-fluency-timer-digit" aria-live="polite">
        {seconds}
      </div>
      <div className="ra-fluency-timer-bar">
        <div
          className="ra-fluency-timer-bar-fill"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
