# Reading Academy — Passage Illustration Authoring Guide

> **M18 / M18.5 — illustrated decodable passages.** Each passage carries an optional `imageUrl` + `imageAlt`. The Passage reader displays the image above the text. The image is engagement-supporting set dressing — **never** an assessment aid.

## Hard pedagogical rules

These are non-negotiable. The validator is permissive (it doesn't reject art), so authors carry the rule:

1. **Never depict story-specific nouns.** If a passage's title is "The Cat in the Cup," the illustration must NOT show a cat or a cup. The image sets mood and setting; the text is the read-aloud assessment.
2. **No readable text inside the image.** A child decoding the passage cannot get help from words painted into the art.
3. **No faces, no named characters.** Generic silhouettes / landscapes / objects only. Avoids both the COPPA "no public profiles" boundary and the "the picture-Sam looks like me" identification trap that distracts beginning readers.
4. **No story-action depictions.** "Sam ran up the hill" must not be illustrated by a stick figure running up a hill — that gives the child a cue for the verb without decoding.
5. **No autoplay animation, no flashing.** Static SVG / WebP only. Reduced-motion preferences are respected by the renderer.
6. **Calm, modern, decodable-storybook feel.** Soft palettes, simple shapes, generous negative space. Not gamified, not busy.

If you can describe the image as "kitchen window at morning" rather than "Mom holding the hot pot," it passes the rule.

## File spec

| Field | Value |
|---|---|
| Format | `.svg` (preferred for vector scenes) or `.webp` (preferred for photographic/painterly art) |
| Aspect ratio | `2:1` — viewBox `800 × 400` for SVG, `1600 × 800` (or `800 × 400` minimum) for raster |
| Max filesize | 25 KB compressed for SVG, 80 KB compressed for WebP |
| Palette | Soft / warm / nature-inspired. Avoid pure saturated reds, greens, blues. |
| Faces / text | Forbidden (see rules above) |
| Required alt text | Yes — passed via `imageAlt` field, describes scene mood + setting only |

## File path convention

```
public/passages/
  per/                    ← per-passage bespoke art, named by passageId
    P_FL01_001.svg
    P_FL02_004_cold.svg
    ...
  fl01/                   ← reusable theme scenes (fallback / shared)
    garden.svg
    pond.svg
    ...
```

## Wiring an image to a passage

1. Drop the asset at `public/passages/per/<passageId>.svg` (or `.webp`).
2. Update the passage in `docs/passages/bank/<GATE>/passages.json`:
   ```json
   {
     "passageId": "P_FL01_001",
     "topic": "Sam and the Cat",
     "imageUrl": "/passages/per/P_FL01_001.svg",
     "imageAlt": "A morning meadow with a small path and a soft sky"
   }
   ```
3. Run `npm run build-passages` (concatenates the per-gate banks into the runtime bundle `src/data/passages.json`).
4. `npm run validate:strict` then `npm run build`.

Both `imageUrl` and `imageAlt` are **optional**. A passage without art renders perfectly — the `<PassageIllustration>` component no-ops. Easy to ship art incrementally.

## Programmatic per-passage scenes

If a real artist isn't yet available, run:

```bash
python3 scripts/generate-passage-illustrations.py
```

This emits 24 deterministic-by-seed SVG scenes into `public/passages/per/` and rewrites all `imageUrl` fields in `src/data/passages.json` to point at them. Each scene combines:

- **Theme silhouette** — meadow / garden / pond / road-hills / kitchen-window / playground / beach / forest
- **Time-of-day palette** — dawn / morning / midday / golden / dusk / night
- **Atmosphere accents** — clouds, birds, or stars based on per-passage seed

Selection rules in the script (`scripts/generate-passage-illustrations.py`):

- `TOPIC_THEME` regex picks the silhouette from the passage title
- `TITLE_PALETTE` regex picks the palette
- Cloud / bird / star positions are derived from the MD5 of the `passageId`, so re-running the script is idempotent

To replace a generated SVG with bespoke art, simply drop the bespoke file at the same path and omit that `passageId` from the script's regen (or just don't re-run the script). The schema doesn't care which path produced the file.

## Accessibility

- **Alt text is required.** Describe the scene's mood and setting (`"A dusk pond with reeds"`) — never the story content (`"The frog hops into the water"`). Screen-reader users hear the alt while the text-to-speech reads the passage text, and the alt must not preview the passage.
- **Reduced-motion respect.** The `<PassageIllustration>` component does not animate. SVG content must not declare `<animate>` or auto-playing transforms.
- **Keyboard navigation.** Images are `draggable={false}` and are not interactive — `Tab` skips them.
- **Color blindness.** Don't encode meaning in color alone. Scenes are decorative anyway, so this rarely applies, but if a future scene uses color to differentiate elements, ensure shape/position does too.

## Performance

- `loading="lazy"` on every `<img>`. Below-the-fold passages don't fetch until needed.
- `decoding="async"` so the renderer paints text first.
- Explicit `width` + `height` + CSS `aspect-ratio` reserve the layout box → zero CLS (Cumulative Layout Shift).
- SVG is preferred for simple scenes — typically 1-3 KB and infinitely scalable. WebP for photographic / painterly art beyond what vectors can express.

## Where illustrations DO NOT appear

By architectural rule:

- **Drill** (`/reading/drill`) — single-word read-aloud. Text only.
- **Diagnostic / Placement** — text only.
- **Fluency / Reading Facts sprint** — text only.
- **PhonemeAsr items** — text only.
- **DiagnosticItem** — text only.
- **Post-drill passage alignment view** — text only. The per-word verdict colors must own the visual field.

The `<PassageIllustration>` component is only mounted inside `<PassageReader>` during the pre-drill / live-reading view, never in alignment view.

## Future expansion (not built — design intent)

- **Storybook spreads** — multi-illustration passages where each paragraph gets its own art panel. Schema extension: `paragraphs[i].imageUrl`.
- **Narrated story mode** — Azure Neural TTS reads the passage with synchronized highlighting. Lives behind the existing M17 ticket.
- **Student-interest themes** — student profile carries `preferredThemes: ["space", "ocean", "dinosaurs"]`; renderer picks among bespoke art tagged with matching themes when available.
- **AI-generated artwork** — pre-generated, human-reviewed pipeline. Anything live-generated at runtime is forbidden by the no-LLMs-in-assessment rule.

None of these are built. Don't ship them ad-hoc.
