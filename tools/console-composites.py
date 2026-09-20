#!/usr/bin/env python3
"""Compose task-89 comparison images: reference page LEFT, our face RIGHT.

Reference shots are the 1600x1000 captures taken in task 87 (apps/velum-web/
docs/screenshots/) — the tool reads them, the lane never opened the dashboard
source. Output: docs/console/compare-89-<face>.png.

Usage: python3 tools/console-composites.py <reference-shots-dir>
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw

MAP = [
    ("rounds", "87-warroom-unchanged.png"),
    ("agents", "87-operators-unchanged.png"),
    ("memory", "87-selfimprove-unchanged.png"),
    ("lab", "87-terminal-unchanged.png"),
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
    out_dir = Path(__file__).resolve().parent.parent / "docs" / "console"
    out_dir.mkdir(parents=True, exist_ok=True)

    for face, ref_name in MAP:
        ours_path = out_dir / "shots" / f"89-{face}-1600.png"
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
        out = out_dir / f"compare-89-{face}.png"
        canvas.save(out)
        print(out, canvas.size, out.stat().st_size, "B")


if __name__ == "__main__":
    main()
