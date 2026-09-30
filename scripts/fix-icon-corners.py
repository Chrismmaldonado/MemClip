"""Convert MemClip neon-on-black icons to clean transparent neon."""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
# Always rebuild from the known baked-on-black original when present.
ORIGINAL = ROOT / "icons" / "icon128-original-black.png"
SRC = ORIGINAL if ORIGINAL.exists() else ROOT / "icons" / "icon128.png"

NEON = (51, 255, 119)


def decontaminate(src: Image.Image) -> Image.Image:
    src = src.convert("RGBA")
    w, h = src.size
    px = src.load()
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    op = out.load()

    cx = (w - 1) / 2.0
    cy = (h - 1) / 2.0
    # Keep glow inside a soft circle so square-file corners are always empty.
    radius = min(w, h) * 0.48
    feather = min(w, h) * 0.06

    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 4:
                continue

            # Circular mask first (kills the boxed corners).
            dist = math.hypot(x - cx, y - cy)
            if dist >= radius + feather:
                continue
            if dist <= radius:
                circle = 1.0
            else:
                circle = 1.0 - (dist - radius) / feather

            if g < 20 or g + 8 < r or g + 8 < b:
                continue

            strength = max(int(g * 1.2), r, b)
            if strength < 28:
                continue

            inv = 255.0 / strength
            nr = min(255, int(r * inv))
            ng = min(255, int(g * inv))
            nb = min(255, int(b * inv))
            nr = min(255, int(nr * 0.2 + NEON[0] * 0.8))
            ng = min(255, int(ng * 0.3 + NEON[1] * 0.7))
            nb = min(255, int(nb * 0.2 + NEON[2] * 0.8))

            na = min(255, int(strength * 1.08 * circle))
            if na < 12:
                continue
            op[x, y] = (nr, ng, nb, na)

    return out


def main() -> None:
    # Ensure we have a stable original to rebuild from.
    if not ORIGINAL.exists():
        # Caller should have checked out / copied the black original here.
        pass

    cleaned = decontaminate(Image.open(SRC))

    for pt in [(0, 0), (2, 2), (10, 10), (64, 30), (90, 90), (127, 127)]:
        print("pixel", pt, cleaned.getpixel(pt))

    icons = ROOT / "icons"
    cleaned.save(icons / "icon128.png", optimize=True)
    cleaned.save(ROOT / "docs" / "logo.png", optimize=True)

    for size in (16, 32, 48, 64):
        resized = cleaned.resize((size, size), Image.Resampling.LANCZOS)
        path = (
            ROOT / "store-assets" / "icon64.png"
            if size == 64
            else icons / f"icon{size}.png"
        )
        resized.save(path, optimize=True)
        print("wrote", size)

    for name, color in (
        ("_preview-on-github-gray.png", (13, 17, 23, 255)),
        ("_preview-on-light.png", (210, 210, 210, 255)),
    ):
        bg = Image.new("RGBA", (200, 200), color)
        bg.paste(cleaned, (36, 36), cleaned)
        bg.convert("RGB").save(icons / name)
    print("done")


if __name__ == "__main__":
    main()
