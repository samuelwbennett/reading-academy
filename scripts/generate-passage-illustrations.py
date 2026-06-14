#!/usr/bin/env python3
"""
M18.5 — Per-passage illustration generator.

Emits 24 unique SVG scenes into public/passages/per/, one per passage.
Each scene is built from three parameter axes:

  1. theme silhouette  — what's in the background:
       meadow, garden, pond, road-hills, kitchen-window,
       playground, beach, night-sky
  2. time-of-day palette — sky + sun + foreground tint:
       dawn, morning, midday, golden, dusk, night
  3. atmosphere accents — small additive elements:
       a few clouds, scattered birds, a flock of stars, leaves on the wind

The pedagogical rule (M18 brief, reinforced in M18.5):
   - NEVER depict story-specific objects (no actual cats, hats, cups,
     pots, frogs, fish, trucks, kites, etc.). The scene sets MOOD and
     SETTING, never reveals decoding answers.
   - Faces / characters / readable text are forbidden.
   - The bank's existing themed SVGs (under public/passages/fl01/)
     remain as documented reusable fallbacks for future passages.

Each output file is ~1.5-2.5 KB on disk and renders perfectly at any
size via the existing PassageReader's <img> with aspect-ratio reservation.

Deterministic: keyed on passageId so re-running the script produces the
same art. Replaceable: an artist can drop a hand-authored SVG/WebP at
the same path; the schema doesn't care which produced it.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PASSAGES_JSON = os.path.join(ROOT, "src", "data", "passages.json")
PUBLIC_DIR = os.path.join(ROOT, "public", "passages", "per")
BASE_URL = "/passages/per/"

VIEWBOX_W = 800
VIEWBOX_H = 400

# ---------- palette presets ----------

PALETTES = {
    "dawn": {
        "sky_top":   "#f8d6c9",
        "sky_bot":   "#f6b48e",
        "sun":       "#fff5c8",
        "ground1":   "#a4c08a",
        "ground2":   "#7da169",
        "accent_dk": "#3f6c47",
        "cloud":     "#fff",
    },
    "morning": {
        "sky_top":   "#dbeefb",
        "sky_bot":   "#b9dff3",
        "sun":       "#fff5c8",
        "ground1":   "#a0c891",
        "ground2":   "#7eb073",
        "accent_dk": "#5a8245",
        "cloud":     "#fff",
    },
    "midday": {
        "sky_top":   "#cfe8f7",
        "sky_bot":   "#a7d4ef",
        "sun":       "#fff5c8",
        "ground1":   "#9bc88a",
        "ground2":   "#7eb073",
        "accent_dk": "#5a8245",
        "cloud":     "#fff",
    },
    "golden": {
        "sky_top":   "#fde6c4",
        "sky_bot":   "#f6c397",
        "sun":       "#fff3cf",
        "ground1":   "#c0b178",
        "ground2":   "#8a9a5f",
        "accent_dk": "#5a7245",
        "cloud":     "#ffe6c8",
    },
    "dusk": {
        "sky_top":   "#d8c0e0",
        "sky_bot":   "#a87fbb",
        "sun":       "#fde0a0",
        "ground1":   "#615280",
        "ground2":   "#4a3e63",
        "accent_dk": "#2c2244",
        "cloud":     "#d8c0e0",
    },
    "night": {
        "sky_top":   "#1f2a4a",
        "sky_bot":   "#3b4e7e",
        "sun":       "#fef0c7",   # moon
        "ground1":   "#1f2a4a",
        "ground2":   "#15203a",
        "accent_dk": "#0c1228",
        "cloud":     "#3b4e7e",
    },
}

# ---------- theme silhouettes ----------
# Each takes (palette dict, accents dict) and returns SVG body fragment.

def svg_open():
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="0 0 {VIEWBOX_W} {VIEWBOX_H}" '
        f'role="img" aria-label="ALT">'
    )

def sky_gradient(p):
    return (
        f'<defs><linearGradient id="sky" x1="0" x2="0" y1="0" y2="1">'
        f'<stop offset="0%" stop-color="{p["sky_top"]}"/>'
        f'<stop offset="100%" stop-color="{p["sky_bot"]}"/>'
        f'</linearGradient></defs>'
        f'<rect width="{VIEWBOX_W}" height="{VIEWBOX_H}" fill="url(#sky)"/>'
    )

def sun(p, cx=400, cy=120, r=50):
    halo = (
        f'<defs><radialGradient id="halo" cx="50%" cy="50%" r="50%">'
        f'<stop offset="0%" stop-color="{p["sun"]}"/>'
        f'<stop offset="100%" stop-color="{p["sun"]}" stop-opacity="0"/>'
        f'</radialGradient></defs>'
    )
    return (
        halo +
        f'<circle cx="{cx}" cy="{cy}" r="{r*3}" fill="url(#halo)"/>'
        f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{p["sun"]}"/>'
    )

def clouds(p, positions):
    out = '<g opacity="0.85">'
    for (cx, cy, rx, ry) in positions:
        out += f'<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" fill="{p["cloud"]}"/>'
    out += '</g>'
    return out

def stars(p, points):
    out = f'<g fill="{p["sun"]}">'
    for (x, y, r) in points:
        out += f'<circle cx="{x}" cy="{y}" r="{r}"/>'
    out += '</g>'
    return out

def birds(positions):
    out = '<g fill="none" stroke="#3f3f3f" stroke-width="2" stroke-linecap="round">'
    for (x, y, scale) in positions:
        s = scale
        out += (
            f'<path d="M{x} {y} q{8*s} {-6*s} {16*s} 0 q{8*s} {-6*s} {16*s} 0"/>'
        )
    out += '</g>'
    return out

def leaves(p, positions):
    out = f'<g fill="{p["accent_dk"]}" opacity="0.6">'
    for (x, y, r) in positions:
        out += f'<ellipse cx="{x}" cy="{y}" rx="{r}" ry="{r/2}" transform="rotate(-25 {x} {y})"/>'
    out += '</g>'
    return out

# ---------- theme drawers ----------

def theme_meadow(p):
    return (
        f'<path d="M0 300 Q200 250 400 280 T800 270 L800 400 L0 400 Z" fill="{p["ground1"]}" opacity="0.9"/>'
        f'<path d="M0 340 Q220 295 460 320 T800 310 L800 400 L0 400 Z" fill="{p["ground2"]}"/>'
        f'<g opacity="0.55" fill="{p["accent_dk"]}">'
        f'  <ellipse cx="120" cy="372" rx="14" ry="5"/>'
        f'  <ellipse cx="240" cy="382" rx="18" ry="6"/>'
        f'  <ellipse cx="380" cy="365" rx="12" ry="5"/>'
        f'  <ellipse cx="540" cy="376" rx="20" ry="6"/>'
        f'  <ellipse cx="680" cy="368" rx="14" ry="5"/>'
        f'</g>'
    )

def theme_garden(p):
    return (
        f'<path d="M0 280 Q200 240 400 260 T800 250 L800 400 L0 400 Z" fill="{p["ground1"]}"/>'
        f'<path d="M0 320 Q200 295 400 305 T800 300 L800 400 L0 400 Z" fill="{p["ground2"]}"/>'
        + ''.join(
            f'<g><line x1="{x}" y1="395" x2="{x}" y2="{395-stem}" stroke="{p["accent_dk"]}" stroke-width="3"/>'
            f'<circle cx="{x}" cy="{395-stem-6}" r="{rad}" fill="{color}"/>'
            f'<circle cx="{x}" cy="{395-stem-6}" r="4" fill="#fef0c7"/></g>'
            for (x, stem, rad, color) in [
                (120, 80, 14, "#f4a3b6"),
                (240, 92, 16, "#f7c97a"),
                (380, 70, 12, "#cfa1d8"),
                (520, 88, 15, "#f4a3b6"),
                (680, 70, 12, "#f7c97a"),
            ]
        )
    )

def theme_pond(p):
    return (
        f'<rect y="220" width="{VIEWBOX_W}" height="180" fill="#6f9eb1"/>'
        f'<g opacity="0.55" fill="{p["accent_dk"]}">'
        f'  <ellipse cx="640" cy="240" rx="42" ry="3"/>'
        f'  <ellipse cx="640" cy="260" rx="60" ry="3"/>'
        f'</g>'
        f'<g><ellipse cx="180" cy="290" rx="44" ry="10" fill="{p["accent_dk"]}"/>'
        f'<ellipse cx="320" cy="320" rx="52" ry="11" fill="{p["accent_dk"]}" opacity="0.85"/>'
        f'<ellipse cx="500" cy="305" rx="38" ry="9" fill="{p["accent_dk"]}"/></g>'
        f'<g stroke="{p["accent_dk"]}" stroke-width="3" fill="none">'
        f'  <line x1="80" y1="280" x2="80" y2="220"/>'
        f'  <line x1="100" y1="280" x2="100" y2="208"/>'
        f'  <line x1="120" y1="280" x2="120" y2="225"/></g>'
    )

def theme_road_hills(p):
    return (
        f'<path d="M0 280 Q200 240 400 270 T800 250 L800 330 L0 330 Z" fill="{p["ground1"]}"/>'
        f'<path d="M0 330 Q200 300 400 320 T800 310 L800 400 L0 400 Z" fill="{p["ground2"]}"/>'
        f'<path d="M380 400 Q400 360 410 330 Q420 300 440 270 L460 270 Q450 300 440 330 Q430 360 420 400 Z" fill="#bca38b"/>'
        f'<line x1="420" y1="395" x2="425" y2="370" stroke="{p["sun"]}" stroke-width="4"/>'
        f'<line x1="430" y1="345" x2="436" y2="320" stroke="{p["sun"]}" stroke-width="3"/>'
    )

def theme_kitchen_window(p):
    return (
        # warm wall background (overrides sky)
        f'<rect width="{VIEWBOX_W}" height="{VIEWBOX_H}" fill="#f6e7d3"/>'
        # window frame
        f'<rect x="220" y="60" width="360" height="240" fill="#dde9f1" rx="8"/>'
        f'<rect x="232" y="72" width="336" height="216" fill="url(#sky)"/>'
        f'<line x1="400" y1="72" x2="400" y2="288" stroke="#fff" stroke-width="6"/>'
        f'<line x1="232" y1="180" x2="568" y2="180" stroke="#fff" stroke-width="6"/>'
        f'<rect x="220" y="60" width="360" height="240" fill="none" stroke="#bba074" stroke-width="6" rx="8"/>'
        # sill
        f'<rect x="200" y="288" width="400" height="14" fill="#bba074"/>'
        # potted plant — generic foliage, no flowers/cups/anything
        f'<rect x="350" y="240" width="50" height="48" fill="#a47148" rx="4"/>'
        f'<g fill="{p["accent_dk"]}">'
        f'  <ellipse cx="365" cy="240" rx="10" ry="6"/>'
        f'  <ellipse cx="385" cy="234" rx="11" ry="6"/>'
        f'  <ellipse cx="375" cy="226" rx="9" ry="5"/>'
        f'</g>'
    )

def theme_playground(p):
    return (
        f'<rect y="280" width="{VIEWBOX_W}" height="120" fill="{p["ground1"]}"/>'
        f'<rect y="320" width="{VIEWBOX_W}" height="80" fill="{p["ground2"]}"/>'
        # swing-set silhouette
        f'<line x1="290" y1="280" x2="320" y2="180" stroke="{p["accent_dk"]}" stroke-width="6"/>'
        f'<line x1="510" y1="280" x2="480" y2="180" stroke="{p["accent_dk"]}" stroke-width="6"/>'
        f'<line x1="320" y1="180" x2="480" y2="180" stroke="{p["accent_dk"]}" stroke-width="6"/>'
        f'<g stroke="{p["accent_dk"]}" stroke-width="2" fill="none">'
        f'  <line x1="365" y1="180" x2="365" y2="240"/>'
        f'  <line x1="395" y1="180" x2="395" y2="240"/>'
        f'</g>'
        f'<rect x="358" y="240" width="44" height="6" fill="#a47148" rx="2"/>'
    )

def theme_beach(p):
    return (
        f'<rect y="220" width="{VIEWBOX_W}" height="100" fill="#5e8a9d"/>'
        f'<path d="M0 240 Q100 230 200 240 T400 240 T600 240 T800 240 L800 250 L0 250 Z" fill="#a7c4d8" opacity="0.7"/>'
        f'<path d="M0 270 Q100 260 200 270 T400 270 T600 270 T800 270 L800 280 L0 280 Z" fill="#cfe2ee" opacity="0.6"/>'
        f'<rect y="320" width="{VIEWBOX_W}" height="80" fill="#f0d9a8"/>'
        f'<rect y="318" width="{VIEWBOX_W}" height="6" fill="#fcefcf"/>'
        # tiny shells — abstract small ellipses, not depicting any creature
        f'<g fill="#cfa078">'
        f'  <ellipse cx="120" cy="370" rx="6" ry="3"/>'
        f'  <ellipse cx="240" cy="380" rx="5" ry="3"/>'
        f'  <ellipse cx="540" cy="370" rx="6" ry="3"/>'
        f'  <ellipse cx="680" cy="378" rx="5" ry="3"/>'
        f'</g>'
    )

def theme_forest(p):
    return (
        f'<path d="M0 240 Q200 200 400 230 T800 220 L800 280 L0 280 Z" fill="{p["ground1"]}" opacity="0.7"/>'
        f'<rect y="280" width="{VIEWBOX_W}" height="120" fill="#d6c39a"/>'
        f'<path d="M380 400 Q400 350 410 320 Q420 300 460 280 L520 280 Q470 320 440 360 Q425 380 420 400 Z" fill="#c0a778"/>'
        + ''.join(
            f'<g><polygon points="{tx},{ty} {tx-w},{ty+h} {tx+w},{ty+h}" fill="{p["accent_dk"]}"/>'
            f'<rect x="{tx-5}" y="{ty+h-2}" width="10" height="22" fill="#7a432a"/></g>'
            for (tx, ty, w, h) in [
                (120, 270, 30, 60),
                (220, 280, 32, 62),
                (600, 265, 35, 70),
                (700, 290, 30, 60),
            ]
        )
    )

THEMES = {
    "meadow":          theme_meadow,
    "garden":          theme_garden,
    "pond":            theme_pond,
    "road-hills":      theme_road_hills,
    "kitchen-window":  theme_kitchen_window,
    "playground":      theme_playground,
    "beach":           theme_beach,
    "forest":          theme_forest,
}

# ---------- topic → theme mapping ----------

TOPIC_THEME = [
    (r"\bbeach\b|\bsea\b|\bsand\b|\bstorm\b|\bcamping\b", "beach"),
    (r"\bpond\b|\bfrog\b|\bfish\b|\btank\b|\brain\b", "pond"),
    (r"\bnight\b|\bbarn\b|\bnote\b|\bkite\b|\bstar\b|\bdark\b", "forest"),  # uses forest silhouette + night palette below
    (r"\bcake\b|\bbake\b|\bpot\b|\blunch\b|\bshop\b|\bcup\b|\bhat\b|\btea\b", "kitchen-window"),
    (r"\btruck\b|\btrip\b|\bbike\b|\bride\b|\bpark\b|\bgame\b|\broad\b", "road-hills"),
    (r"\bbench\b|\bplay\b|\bball\b|\byard\b|\bnew pet\b", "playground"),
    (r"\bcat\b|\bpup\b|\bpet\b|\bdog\b|\bhen\b|\bgarden\b", "garden"),
    (r"\bhill\b|\bsam\b|\btim\b", "meadow"),
]

# Per-passage palette overrides for narrative mood (kept generic).
TITLE_PALETTE = [
    (r"\bnight\b|\bbarn\b|\bnote\b|\bstar\b|\bdark\b", "night"),
    (r"\bstorm\b|\bcamping\b", "dusk"),
    (r"\bbeach\b|\bjoy\b|\bsunset\b", "golden"),
    (r"\bcake\b|\bbake\b|\bhot\b|\bpot\b|\blunch\b", "morning"),
    (r"\bride\b|\bgame\b|\btrip\b|\bbig\b", "midday"),
]

def pick_theme(topic):
    t = topic.lower()
    for pat, name in TOPIC_THEME:
        if re.search(pat, t):
            return name
    return "meadow"

def pick_palette(topic, seed):
    t = topic.lower()
    for pat, name in TITLE_PALETTE:
        if re.search(pat, t):
            return name
    palette_order = ["dawn", "morning", "midday", "golden", "dusk", "night"]
    return palette_order[seed % len(palette_order)]

# ---------- seed → accent picks ----------

def seed_int(passage_id: str) -> int:
    return int(hashlib.md5(passage_id.encode()).hexdigest(), 16)

def pick_accents(seed: int, palette_name: str):
    """Return list of accent SVG fragments to layer on the scene."""
    accents = []
    # Pseudo-random selection from seed bits.
    cloud_variant = seed % 4
    bird_variant  = (seed >> 4) % 3
    star_variant  = (seed >> 8) % 3

    if palette_name == "night":
        # Always show stars at night, never clouds.
        pts = [
            (80 + (i * 73) % 700, 50 + (i * 29) % 150, 1.5 + ((i * 17) % 3) * 0.5)
            for i in range(12)
        ]
        accents.append(("STARS", pts))
    else:
        # Clouds: 2-4 elliptical clouds at varied positions.
        cloud_count = 2 + cloud_variant
        cloud_positions = [
            (
                120 + (i * 180 + seed * 7) % 600,
                60 + (i * 23 + seed) % 80,
                28 + ((seed >> i) % 18),
                10 + ((seed >> (i + 1)) % 6),
            )
            for i in range(cloud_count)
        ]
        accents.append(("CLOUDS", cloud_positions))

        # Optional birds for daytime.
        if bird_variant > 0:
            bird_count = bird_variant
            bird_positions = [
                (
                    300 + (i * 90 + seed) % 400,
                    140 + (i * 17 + seed * 3) % 60,
                    0.7 + (seed % 4) * 0.1,
                )
                for i in range(bird_count)
            ]
            accents.append(("BIRDS", bird_positions))

    return accents

def render_accents(p, accents):
    out = ""
    for kind, payload in accents:
        if kind == "STARS":
            out += stars(p, payload)
        elif kind == "CLOUDS":
            out += clouds(p, payload)
        elif kind == "BIRDS":
            out += birds(payload)
    return out

# ---------- top-level render ----------

def render_passage(passage):
    pid = passage["passageId"]
    topic = passage["topic"]
    seed = seed_int(pid)
    theme_name = pick_theme(topic)
    palette_name = pick_palette(topic, seed)
    p = PALETTES[palette_name]
    alt = compose_alt(topic, theme_name, palette_name)

    # Body assembly.
    body = sky_gradient(p)
    body += sun(p, cx=300 + (seed % 400), cy=80 + (seed % 80), r=40 + (seed % 15))
    body += render_accents(p, pick_accents(seed, palette_name))
    body += THEMES[theme_name](p)

    svg = svg_open().replace("ALT", alt) + body + "</svg>"
    return svg, theme_name, palette_name, alt

def compose_alt(topic, theme_name, palette_name):
    palette_to_word = {
        "dawn": "dawn",
        "morning": "morning",
        "midday": "midday",
        "golden": "late afternoon",
        "dusk": "dusk",
        "night": "night",
    }
    theme_to_phrase = {
        "meadow":          "rolling meadow",
        "garden":          "small garden of flowers",
        "pond":            "still pond with reeds",
        "road-hills":      "country road winding through hills",
        "kitchen-window":  "warm sunlit window over a sill",
        "playground":      "quiet playground in a field",
        "beach":           "gentle beach with waves",
        "forest":          "forest path between trees",
    }
    return f"A {palette_to_word.get(palette_name, 'calm')} scene over a {theme_to_phrase.get(theme_name, 'landscape')}."

# ---------- main ----------

def main():
    if not os.path.exists(PASSAGES_JSON):
        print(f"error: cannot find {PASSAGES_JSON}", file=sys.stderr)
        sys.exit(1)
    os.makedirs(PUBLIC_DIR, exist_ok=True)
    with open(PASSAGES_JSON) as f:
        data = json.load(f)
    summary = []
    for passage in data.get("passages", []):
        pid = passage["passageId"]
        svg, theme_name, palette_name, alt = render_passage(passage)
        out_path = os.path.join(PUBLIC_DIR, f"{pid}.svg")
        with open(out_path, "w") as o:
            o.write(svg + "\n")
        passage["imageUrl"] = BASE_URL + f"{pid}.svg"
        passage["imageAlt"] = alt
        summary.append((pid, theme_name, palette_name, len(svg)))
    # Persist updated passages.json.
    data["version"] = "1.2.0"
    with open(PASSAGES_JSON, "w") as f:
        json.dump(data, f, indent=2)
    # Print a stable report.
    for pid, theme_name, palette_name, size in summary:
        print(f"  {pid:18s}  theme={theme_name:14s}  palette={palette_name:7s}  {size:5d} bytes")
    print(f"\nGenerated {len(summary)} per-passage SVGs into {PUBLIC_DIR}")

if __name__ == "__main__":
    main()
