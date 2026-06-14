import React from "react";

// Single-purpose mic button: idle / listening / retry states.
// The parent owns the recognition lifecycle; this component just
// renders the affordance.
//
// M16-E2: short, child-friendly button copy + calm pulse while
// listening. Default label is "Say it"; the parent can pass
// `label="Read"` (passages), `label="Try again"` (after a wrong
// attempt), or `label="Start"` (drill kickoff).

export default function MicButton({
  listening,
  disabled,
  onTap,
  label = "Say it",
  hint = "Say the word when you're ready",
}) {
  const click = () => {
    if (!disabled && !listening) onTap?.();
  };
  return (
    <button
      type="button"
      className={`ra-mic ${listening ? "listening" : ""}`}
      onClick={click}
      disabled={disabled || listening}
      aria-label={listening ? "Listening" : label}
      aria-live="polite"
    >
      <span className="ra-mic-icon" aria-hidden="true">🎤</span>
      <span className="ra-mic-label">{listening ? "Listening…" : label}</span>
      {listening && hint && (
        <span
          className="ra-mic-hint"
          style={{
            display: "block",
            fontSize: 12,
            marginTop: 4,
            opacity: 0.85,
          }}
        >
          {hint}
        </span>
      )}
    </button>
  );
}
