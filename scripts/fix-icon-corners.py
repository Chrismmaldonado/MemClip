"""Remove near-black corner fill from MemClip icons so rounded edges are clean."""
from __future__ import annotations

from collections import deque
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "icons" / "icon128.png"


def is_corner_bg(r: int, g: int, b: int, a: int) -> bool:
    if a < 8:
        return True
    # Near-black rim that currently fills the square outside the rounded plate.
    return r <= 35 and g <= 45 and b <= 35


def clear_corners(src: Image.Image) -> Image.Image:
    src = src.convert("RGBA")
    w, h = src.size
    px = src.load()
    visited = [[False] * w for _ in range(h)]
    mask = Image.new("L", (w, h), 255)
    mp = mask.load()
    q: deque[tuple[int, int]] = deque([(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)])
    while q:
        x, y = q.popleft()
        if x < 0 or y < 0 or x >= w or y >= h or visited[y][x]:
            continue
        r, g, b, a = px[x, y]
        if not is_corner_bg(r, g, b, a):
            continue
        visited[y][x] = True
        mp[x, y] = 0
        for nx, ny in (
            (x + 1, y),
            (x - 1, y),
            (x, y + 1),
            (x, y - 1),
            (x + 1, y + 1),
            (x - 1, y - 1),
            (x + 1, y - 1),
            (x - 1, y + 1),
        ):
            q.append((nx, ny))

    mask = mask.filter(ImageFilter.GaussianBlur(0.6))
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    op = out.load()
    mp = mask.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            m = mp[x, y]
            if m == 0:
                continue
            na = int(a * (m / 255.0))
            if na < 2:
                continue
            op[x, y] = (r, g, b, na)
    return out


def main() -> None:
    cleaned = clear_corners(Image.open(SRC))
    for pt in [(0, 0), (1, 1), (127, 0), (0, 127), (127, 127), (64, 64)]:
        print("pixel", pt, cleaned.getpixel(pt))

    icons = ROOT / "icons"
    cleaned.save(icons / "icon128.png")
    cleaned.save(ROOT / "docs" / "logo.png")
    for size in (16, 32, 48, 64):
        resized = cleaned.resize((size, size), Image.Resampling.LANCZOS)
        if size == 64:
            resized.save(ROOT / "store-assets" / "icon64.png")
        else:
            resized.save(icons / f"icon{size}.png")
        print("wrote", size)
    print("done")


if __name__ == "__main__":
    main()
