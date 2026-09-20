#!/usr/bin/env python3
"""Compose console comparison images: reference page LEFT, our face RIGHT.

Reference shots are the 1600x1000 captures taken in task 87 (apps/velum-web/
docs/screenshots/) — the tool reads them, the lane never opened the dashboard
source. Output: docs/console/compare-<prefix>-<face>.png.

Usage: python3 tools/console-composites.py <reference-shots-dir> [prefix]
       (prefix defaults to 89 — task 90 passes 90)

Honest-mapping note (task 90): the Receipt face has NO reference page — the
closest grammar carrier is the war-room stat-well layout, so receipt is
mapped there and labeled as such; chat maps to the general channel page.
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw

MAP = [
    # task 89 faces
    ("rounds", "87-warroom-unchanged.png"),
    ("agents", "87-operators-unchanged.png"),
    ("memory", "87-selfimprove-unchanged.png"),
    ("lab", "87-terminal-unchanged.png"),
    # task 90 faces
    ("receipt", "87-warroom-unchanged.png"),      # no direct reference page — stat-well grammar only
    ("chat", "87-general-unchanged.png"),
    ("logs", "87-terminal-unchanged.png"),
    ("maintainer", "87-evidence-unchanged.png"),
    ("engines", "87-arsenal-unchanged.png"),
    ("about", "87-about-unchanged.png"),
]
GAP = 24
LABEL_H = 36
GROUND = (7, 16, 23)
LABEL_FG = (47, 255, 210)


def label_bar(w, left_txt, right_txt):
    bar = Image.new("RGB", (w, LABEL_H), GROUND)
    d = ImageDraw.Draw(bar)
    d.text((12, 11), left_txt, fill=LABEL_FG)
    d.text((w // 2 + 12, 11), right_txt, fill=(160, 200, 220))
    return bar


def main():
    ref_dir = Path(sys.argv[1])
    prefix = sys.argv[2] if len(sys.argv) > 2 else "89"
    out_dir = Path(__file__).resolve().parent.parent / "docs" / "console"
    out_dir.mkdir(parents=True, exist_ok=True)

    for face, ref_name in MAP:
        ours_path = out_dir / "shots" / f"{prefix}-{face}-1600.png"
        if not ours_path.exists():
            print("skip (no shot):", ours_path.name)
            continue
        ref_path = ref_dir / ref_name
        ours = Image.open(ours_path).convert("RGB")
        ref = Image.open(ref_path).convert("RGB")
        h = min(ours.height, ref.height)
        w = ours.width + ref.width + GAP
        canvas = Image.new("RGB", (w, h + LABEL_H), GROUND)
        canvas.paste(ref, (0, LABEL_H))
        canvas.paste(ours, (ref.width + GAP, LABEL_H))
        canvas.paste(
            label_bar(w, f"REFERENCE · {ref_name}", f"OURS · {face} (clean room)"),
            (0, 0),
        )
        out = out_dir / f"compare-{prefix}-{face}.png"
        canvas.save(out)
        print(out, canvas.size, out.stat().st_size, "B")


if __name__ == "__main__":
    main()
