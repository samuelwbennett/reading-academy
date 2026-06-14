import React from "react";
import MicButton from "./MicButton.jsx";

// Render a passage as flowing text — sentences laid out in normal reading
// order, no per-word highlights during reading. The student tracks visually;
// the system listens. After the drill ends, the alignment summary highlights
// per-word verdicts.
//
// M18: optional illustration banner above the passage. The image is a
// thematic, generic scene (sunrise, garden, pond, etc.) — never a depiction
// of the passage's specific story words. Rationale: pictures support
// engagement and reading stamina without revealing the answer. The Drill /
// Diagnostic / Fluency surfaces stay text-only; M18 ONLY adds art to the
// passage reader. See docs/architecture for the full pedagogical rule.
//
// Props:
//   passage         passage object with paragraphs[].sentences[].text and
//                    optional imageUrl + imageAlt
//   aligned         array of { expected, transcript, match } if available
//                    (post-drill); otherwise null
//   listening       boolean — mic currently capturing
//   speechSupported boolean
//   onMicTap        () => void — manual mic re-arm during drill

// Static aspect — set in CSS via the explicit width/height attributes on
// the <img> so the browser reserves the box and we get zero layout shift
// while the SVG/WebP loads.
const ILLUSTRATION_W = 800;
const ILLUSTRATION_H = 400;

function PassageIllustration({ src, alt }) {
  if (!src) return null;
  return (
    <figure
      className="ra-passage-illustration"
      style={{
        margin: "0 0 18px",
        // Reserve the 2:1 box so text below doesn't reflow when the
        // image lands. width: 100% + aspect-ratio is the modern
        // shift-free pattern; we ALSO pass explicit width/height
        // attributes so older Safari respects the ratio.
        width: "100%",
        aspectRatio: `${ILLUSTRATION_W} / ${ILLUSTRATION_H}`,
        borderRadius: 16,
        overflow: "hidden",
        boxShadow: "0 8px 28px rgba(20,30,60,0.08)",
        background: "#f3f5f9",
      }}
    >
      <img
        src={src}
        alt={alt || ""}
        width={ILLUSTRATION_W}
        height={ILLUSTRATION_H}
        loading="lazy"
        decoding="async"
        draggable={false}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          objectFit: "cover",
        }}
      />
    </figure>
  );
}

export default function PassageReader({
  passage,
  aligned,
  listening,
  speechSupported,
  onMicTap,
}) {
  if (aligned) {
    // Post-drill view: highlight per-word matches. No illustration here —
    // the alignment view is pure text feedback so the student's eye stays
    // on the per-word verdict colors.
    const words = aligned.filter((a) => a.expected !== null);
    return (
      <div className="ra-passage-aligned">
        {words.map((a, i) => (
          <span
            key={i}
            className={`ra-passage-word ${a.match ? "match" : "miss"}`}
            title={a.transcript ? `heard: ${a.transcript}` : "missed"}
          >
            {a.expected}{" "}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="ra-passage-body">
      <PassageIllustration src={passage?.imageUrl} alt={passage?.imageAlt} />
      {passage?.paragraphs?.map((para, pi) => (
        <p key={pi} className="ra-passage-para">
          {para.sentences?.map((s, si) => (
            <span key={si} className="ra-passage-sentence">
              {s.text}{" "}
            </span>
          ))}
        </p>
      ))}
      {speechSupported ? (
        <div className="ra-passage-mic">
          <MicButton
            listening={listening}
            onTap={onMicTap}
            label={listening ? "Listening — read the passage" : "Tap to start reading"}
          />
        </div>
      ) : (
        <div className="ra-drill-fallback-note" style={{ marginTop: 12 }}>
          Mic recognition isn't available in this browser. Adult-only scoring is below.
        </div>
      )}
    </div>
  );
}
