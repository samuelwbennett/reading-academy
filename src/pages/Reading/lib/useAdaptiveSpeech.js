// src/pages/Reading/lib/useAdaptiveSpeech.js  (M15-C)
//
// Engine-selecting wrapper around the existing useSpeechRecognition
// (Web Speech API) and the new azureSpeech client. Same call shape
// as the Web hook so existing routes can opt in without a rewrite:
//
//   const { listening, listen, supported, engine, lastResult } =
//     useAdaptiveSpeech({ engine: "auto" });
//   listen({ referenceText: "fish" }, (result) => {
//     // result.transcript           — what we heard
//     // result.accuracyScore?       — Azure pronunciation accuracy 0..100
//     // result.fluencyScore?        — Azure fluency 0..100
//     // result.words?               — per-word breakdown (Azure)
//     // result.phonemes?            — per-phoneme breakdown (Azure)
//     // result.latencyMs            — total recognition time
//     // result.error                — null on success
//     // result.engine               — "azure" | "web"
//   });
//
// Engine selection:
//   - "azure"   force Azure (errors if unavailable)
//   - "web"     force Web Speech (current default behavior)
//   - "auto"    probe Azure once; use it if available, else Web
//
// Per the LLM-boundary discipline applied to ASR: Azure is the
// upgrade engine. Web Speech remains the always-shippable baseline.
// If Azure errors mid-call, the result surfaces with engine:"azure"
// + error set so the caller can decide whether to retry on Web.

import { useCallback, useEffect, useRef, useState } from "react";
import { useSpeechRecognition } from "./useSpeechRecognition.js";
import { isAzureAvailable, recognizeWithPronunciation } from "./azureSpeech.js";

export function useAdaptiveSpeech({
  engine = "auto",
  lang = "en-US",
  patience = "k2",
} = {}) {
  const web = useSpeechRecognition({ lang, patience });
  const [resolvedEngine, setResolvedEngine] = useState(
    engine === "web" ? "web" : null,
  );
  const [listening, setListening] = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const inFlightRef = useRef(false);

  // Probe once on mount when engine is "auto".
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (engine === "azure") {
        if (!cancelled) setResolvedEngine("azure");
        return;
      }
      if (engine === "web") {
        if (!cancelled) setResolvedEngine("web");
        return;
      }
      // auto
      const ok = await isAzureAvailable();
      if (cancelled) return;
      setResolvedEngine(ok ? "azure" : "web");
    })();
    return () => { cancelled = true; };
  }, [engine]);

  const listen = useCallback(
    (opts, onComplete) => {
      // Back-compat: if first arg is a function, treat it as the
      // legacy Web hook signature (just a callback, no referenceText).
      let referenceText = "";
      let cb = onComplete;
      if (typeof opts === "function") {
        cb = opts;
      } else {
        referenceText = String(opts?.referenceText ?? "");
      }

      // Wait for engine probe to settle. If still null, fall back to
      // Web — auto-resolution is best effort.
      const eng = resolvedEngine || "web";

      if (inFlightRef.current) {
        // Another listen in flight — bail rather than stack.
        cb?.({
          transcript: null,
          error: "in-flight",
          latencyMs: 0,
          engine: eng,
        });
        return;
      }

      // M16-H1: always-on entry log so we can prove from the
      // production console which engine fired and with what reference.
      // eslint-disable-next-line no-console
      console.log("[asr.adaptive] listen.dispatch", {
        engine: eng,
        referenceText,
      });

      // Web Speech tail — used both as the primary path AND as the
      // automatic fallback when Azure fast-fails.
      const runWeb = (onDone, fallbackInfo) => {
        // eslint-disable-next-line no-console
        console.log("[asr.adaptive] runWeb", fallbackInfo || {});
        web.listen((webResult) => {
          const result = {
            transcript: webResult?.transcript ?? null,
            alternatives: webResult?.alternatives ?? [],
            confidence: webResult?.confidence ?? null,
            latencyMs: webResult?.latencyMs ?? 0,
            error: webResult?.error ?? null,
            engine: "web",
            azureFallbackFrom: fallbackInfo?.azureError ?? null,
          };
          setLastResult(result);
          onDone(result);
          inFlightRef.current = false;
          setListening(false);
        });
      };

      if (eng === "azure") {
        inFlightRef.current = true;
        setListening(true);
        recognizeWithPronunciation(referenceText, { granularity: "Phoneme" })
          .then((r) => {
            const result = {
              transcript: r.transcript ?? null,
              accuracyScore: r.accuracy ?? null,
              fluencyScore: r.fluency ?? null,
              completenessScore: r.completeness ?? null,
              prosodyScore: r.prosody ?? null,
              words: r.words ?? null,
              phonemes: r.phonemes ?? null,
              latencyMs: r.latencyMs ?? 0,
              error: r.error ?? null,
              engine: "azure",
            };

            // M16-H1: Azure fast-fail fallback. If Azure resolved
            // with an error in less than 1500ms AND captured no
            // transcript AND no Azure score, it almost certainly
            // failed at setup (mic permission denied, WebSocket
            // blocked, token rejected, SDK throwing). Retry on
            // Web Speech instead of leaving the student stranded.
            const azureFastFailed =
              !!result.error &&
              !result.transcript &&
              typeof result.accuracyScore !== "number" &&
              (result.latencyMs ?? 0) < 1500;

            if (azureFastFailed && web.supported) {
              // eslint-disable-next-line no-console
              console.log(
                "[asr.adaptive] azure.fastFail → web fallback",
                {
                  azureError: result.error,
                  durationMs: result.latencyMs,
                },
              );
              // keep inFlightRef.current = true; runWeb resets it
              runWeb(cb, { azureError: result.error });
              return;
            }

            setLastResult(result);
            cb?.(result);
            inFlightRef.current = false;
            setListening(false);
          })
          .catch((err) => {
            // Thrown errors are an even harder fail — always try Web.
            // eslint-disable-next-line no-console
            console.log("[asr.adaptive] azure.throw → web fallback", {
              error: err?.message || String(err),
            });
            if (web.supported) {
              runWeb(cb, {
                azureError: err?.message || String(err),
              });
              return;
            }
            const result = {
              transcript: null,
              error: err?.message || String(err),
              latencyMs: 0,
              engine: "azure",
            };
            setLastResult(result);
            cb?.(result);
            inFlightRef.current = false;
            setListening(false);
          });
        return;
      }

      // Web Speech as the primary path (engine === "web").
      inFlightRef.current = true;
      setListening(true);
      runWeb(cb);
    },
    [resolvedEngine, web],
  );

  // Track web.listening too — when it ticks, propagate.
  useEffect(() => {
    if (resolvedEngine === "web") setListening(web.listening);
  }, [web.listening, resolvedEngine]);

  return {
    supported: resolvedEngine === "azure" || web.supported,
    engine: resolvedEngine,
    listening,
    listen,
    stop: web.stop,
    lastResult,
  };
}
