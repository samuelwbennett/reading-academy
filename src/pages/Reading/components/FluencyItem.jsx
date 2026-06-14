import React from "react";
import MicButton from "./MicButton.jsx";

// One in-flight Reading Facts item. Minimal feedback — drill must keep
// moving. Shows the prompt, mic state (listening/idle), and a tiny
// last-result indicator. Adult override is one tap further down (kept
// available per spec).
//
// Props:
//   prompt          string — the word to read
//   listening       boolean — mic is currently capturing
//   lastVerdict     "correct" | "incorrect" | null — flashes briefly per item
//   speechSupported boolean
//   onMicTap        () => void — used only on initial Start in continuous mode
//   onAdultScore    (correct: boolean) => void

export default function FluencyItem({
  prompt,
  listening,
  lastVerdict,
  speechSupported,
  onMicTap,
  onAdultScore,
}) {
  return (
    <div className="ra-fluency-item">
      <div
        className={`ra-fluency-prompt ${lastVerdict ? `flash-${lastVerdict}` : ""}`}
        aria-label={`Read the word: ${prompt}`}
      >
        {prompt}
      </div>

      {speechSupported ? (
        <div className="ra-fluency-mic-row">
          <MicButton
            listening={listening}
            onTap={onMicTap}
            label="Tap to start"
          />
        </div>
      ) : (
        <div className="ra-drill-fallback-note">
          Mic recognition needs Chrome, Edge, or Safari. Use the buttons below to score by hand.
        </div>
      )}

      <div className="ra-fluency-override">
        <div className="ra-actions">
          <button
            type="button"
            className="ra-btn ra-btn-incorrect"
            onClick={() => onAdultScore?.(false)}
          >
            Mark Incorrect
          </button>
          <button
            type="button"
            className="ra-btn ra-btn-correct"
            onClick={() => onAdultScore?.(true)}
          >
            Mark Correct
          </button>
        </div>
      </div>
    </div>
  );
}
