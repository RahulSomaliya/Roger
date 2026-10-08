#!/usr/bin/env python3
"""Draws Roger's app icon and menu bar glyphs into build/ (redesign sweep, decision D3).

Run by hand when the artwork changes; the PNGs and build/icon.icns are committed, so a build needs
neither this script nor Pillow. Needs Pillow (`python3 -c "import PIL"`) and macOS `iconutil`.

The app icon is the static accent dot on the canvas paper in the macOS rounded square. Its colours
are the OKLCH tokens of renderer/src/theme/tokens.css (light block), converted to sRGB below. If a
token changes, change the two tuples and run this again; nothing else follows a token into here.

The menu bar glyphs are template images (black on transparent; macOS tints them): the same rounded
square, OUTLINED when idle and FILLED while recording, with a dot in the middle when all is well and
an exclamation mark when it needs attention. Shape carries the state, not colour.
"""

import math
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

BUILD = Path(__file__).resolve().parent.parent / "build"

# tokens.css, light block: --canvas and --accent.
CANVAS_OKLCH = (0.985, 0.004, 80)
ACCENT_OKLCH = (0.56, 0.17, 42)
# --edge: a hairline so the paper does not vanish into a white Finder window.
EDGE_OKLCH = (0.90, 0.008, 80)


def oklch_to_srgb(lightness: float, chroma: float, hue_deg: float) -> tuple[int, int, int]:
    """OKLCH to 8-bit sRGB (Bjorn Ottosson's matrices), clipped to the gamut."""
    hue = math.radians(hue_deg)
    a, b = chroma * math.cos(hue), chroma * math.sin(hue)
    l_ = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m_ = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s_ = (lightness - 0.0894841775 * a - 1.2914855480 * b) ** 3
    linear = (
        4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
        -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
        -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_,
    )

    def encode(value: float) -> int:
        value = min(1.0, max(0.0, value))
        gamma = 12.92 * value if value <= 0.0031308 else 1.055 * value ** (1 / 2.4) - 0.055
        return round(gamma * 255)

    r, g, b_out = (encode(v) for v in linear)
    return r, g, b_out


def squircle(size: int, inset: float, exponent: float = 5.0) -> Image.Image:
    """A filled superellipse mask (macOS's continuous corner), `inset` px from each side."""
    mask = Image.new("L", (size, size), 0)
    pixels = mask.load()
    half = size / 2 - inset
    centre = size / 2
    for y in range(size):
        for x in range(size):
            u, v = abs(x + 0.5 - centre) / half, abs(y + 0.5 - centre) / half
            if u**exponent + v**exponent <= 1:
                pixels[x, y] = 255
    return mask


def app_icon(size: int = 1024) -> Image.Image:
    """Paper squircle (824 of 1024, Apple's template) with a hairline edge and the accent dot."""
    scale = 2  # draw at 2x, shrink: antialiased edges without a gradient
    big = size * scale
    inset = big * 100 / 1024
    paper = squircle(big, inset)
    edge = squircle(big, inset + 3 * scale)
    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    canvas.paste(Image.new("RGBA", (big, big), (*oklch_to_srgb(*EDGE_OKLCH), 255)), mask=paper)
    canvas.paste(Image.new("RGBA", (big, big), (*oklch_to_srgb(*CANVAS_OKLCH), 255)), mask=edge)
    draw = ImageDraw.Draw(canvas)
    radius = big * 150 / 1024  # a dot a little over a third of the body's width
    c = big / 2
    draw.ellipse((c - radius, c - radius, c + radius, c + radius), fill=(*oklch_to_srgb(*ACCENT_OKLCH), 255))
    return canvas.resize((size, size), Image.LANCZOS)


def glyph(px: int, *, filled: bool, mark: str) -> Image.Image:
    """A template glyph on a px-square canvas; `mark` is 'dot' or 'bang'."""
    scale = 8
    big = px * scale
    unit = big / 18  # all geometry is in 18 px menu bar units
    body = squircle(big, unit * 1.0)
    inner = squircle(big, unit * 2.5)
    ink = Image.new("L", (big, big), 0)
    # Outline: the body minus a slightly smaller body. Filled: the body whole.
    ink.paste(255, mask=body)
    if not filled:
        ink.paste(0, mask=inner)
    cutout = ImageDraw.Draw(ink)
    mark_value = 0 if filled else 255  # knocked out of a filled body, solid in an outlined one
    c = big / 2
    if mark == "dot":
        r = unit * 2.4
        cutout.ellipse((c - r, c - r, c + r, c + r), fill=mark_value)
    else:
        bar_w = unit * 1.7
        cutout.rounded_rectangle(
            (c - bar_w / 2, c - unit * 4.0, c + bar_w / 2, c + unit * 1.2), radius=bar_w / 2, fill=mark_value
        )
        r = unit * 1.0
        dot_y = c + unit * 3.4
        cutout.ellipse((c - r, dot_y - r, c + r, dot_y + r), fill=mark_value)
    ink = ink.resize((px, px), Image.LANCZOS)
    out = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    out.putalpha(ink)
    return out


GLYPHS = {
    "trayTemplate": dict(filled=False, mark="dot"),
    "trayRecordingTemplate": dict(filled=True, mark="dot"),
    "trayWarningTemplate": dict(filled=False, mark="bang"),
    "trayRecordingWarningTemplate": dict(filled=True, mark="bang"),
}

ICONSET_SIZES = [16, 32, 128, 256, 512]


def main() -> None:
    for name, options in GLYPHS.items():
        glyph(18, **options).save(BUILD / f"{name}.png")
        glyph(36, **options).save(BUILD / f"{name}@2x.png")
    master = app_icon(1024)
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "Roger.iconset"
        iconset.mkdir()
        for size in ICONSET_SIZES:
            master.resize((size, size), Image.LANCZOS).save(iconset / f"icon_{size}x{size}.png")
            master.resize((size * 2, size * 2), Image.LANCZOS).save(iconset / f"icon_{size}x{size}@2x.png")
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(BUILD / "icon.icns")], check=True)
    print("accent", oklch_to_srgb(*ACCENT_OKLCH), "canvas", oklch_to_srgb(*CANVAS_OKLCH), "edge", oklch_to_srgb(*EDGE_OKLCH))


if __name__ == "__main__":
    main()
