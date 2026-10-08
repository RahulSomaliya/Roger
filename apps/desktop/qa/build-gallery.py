#!/usr/bin/env python3
"""Turns the QA run's shots.json (PNGs) into the gallery's manifest: JPEG q55, the 1080 shots about
900 px wide, and every light shot paired with its dark twin in ONE image (light left, dark right), so
the gallery reads "light and dark side by side" whatever the page's column layout does.

usage: build-gallery.py <qa-sweep dir> <out manifest>
"""
import json
import os
import re
import sys

from PIL import Image, ImageDraw

SRC, OUT = sys.argv[1], sys.argv[2]
JPG = os.path.join(SRC, "jpg")
os.makedirs(JPG, exist_ok=True)
GAP = 16
QUALITY = 55
WIDE = 900  # a 1080 shot, and a 1440 stage, are drawn this wide


def load(path):
    image = Image.open(path).convert("RGB")
    if image.width > 1000:
        height = round(image.height * WIDE / image.width)
        image = image.resize((WIDE, height), Image.LANCZOS)
    return image


def compose(light_path, dark_path, name):
    a, b = load(light_path), load(dark_path)
    height = max(a.height, b.height)
    sheet = Image.new("RGB", (a.width + GAP + b.width, height), (128, 128, 128))
    sheet.paste(a, (0, 0))
    sheet.paste(b, (a.width + GAP, 0))
    out = os.path.join(JPG, name + ".jpg")
    sheet.save(out, "JPEG", quality=QUALITY, optimize=True)
    return out


def single(path, name):
    out = os.path.join(JPG, name + ".jpg")
    load(path).save(out, "JPEG", quality=QUALITY, optimize=True)
    return out


def worst(a, b):
    order = {"pass": 0, "warn": 1, "fail": 2}
    return a if order[a] >= order[b] else b


manifest = json.load(open(os.path.join(SRC, "shots.json")))
groups = []
for group in manifest["groups"]:
    by_name = {os.path.basename(s["file"]): s for s in group["shots"]}
    done = set()
    shots = []
    for shot in group["shots"]:
        base = os.path.basename(shot["file"])
        if base in done:
            continue
        # <slug>-<theme>-<width>.png, or the prompt panel's <slug>-<theme>-<backdrop>.png
        match = re.match(r"^(.*)-(light|dark)-(1080|420|dark|light)\.png$", base)
        if match is None:
            shots.append({**shot, "file": single(shot["file"], base[:-4])})
            done.add(base)
            continue
        slug, theme, rest = match.groups()
        twin_theme = "dark" if theme == "light" else "light"
        twin_base = f"{slug}-{twin_theme}-{rest}.png"
        twin = by_name.get(twin_base)
        if twin is None:
            shots.append({**shot, "file": single(shot["file"], base[:-4])})
            done.add(base)
            continue
        light, dark = (shot, twin) if theme == "light" else (twin, shot)
        done.update({base, twin_base})
        name = f"{slug}-{rest}"
        caption = re.sub(r" \((?:light|dark)[^)]*\)$", "", light["caption"])
        size = rest if rest in ("1080", "420") else f"over a {rest} call"
        shots.append(
            {
                "file": compose(light["file"], dark["file"], name),
                "caption": f"{caption} (light | dark, {size})",
                "check": worst(light["check"], dark["check"]),
                **({"note": light["note"]} if light.get("note") else {}),
            }
        )
    groups.append({"name": group["name"], "shots": shots})

manifest["groups"] = groups
manifest["subtitle"] = (
    "Every view, driven in a real browser at the window's two sizes "
    "(1080 x 730 and 420 x 760), light and dark side by side. Each image passed its checks before it "
    "was taken: one primary and the right one, every problem line visible, no raw text outside "
    "Details, no sideways scroll, no console error, nothing animating."
)
json.dump(manifest, open(OUT, "w"), indent=2)
total = sum(os.path.getsize(s["file"]) for g in groups for s in g["shots"])
print(f"{sum(len(g['shots']) for g in groups)} images, {total / 1e6:.1f} MB of JPEG")
