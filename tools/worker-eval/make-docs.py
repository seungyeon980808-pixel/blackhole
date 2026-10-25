"""Builds the synthetic documents and images in documents.json (macOS).

    uv run --with pillow --with openpyxl python tools/worker-eval/make-docs.py --out DIR

Every file is generated from the fake text in documents.json; nothing real is used.
Tools: kordoc (Markdown -> HWPX -> PNG), headless Chrome with a throwaway profile
(HTML -> PDF / screenshot), textutil (HTML -> DOCX), openpyxl (XLSX), Pillow (photo
and scan effects, handwriting-style font). Binary HWP cannot be generated here.
"""

import argparse
import json
import os
import random
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
MODELS = Path(os.environ.get("BLACKHOLE_MODELS_DIR", Path.home() / ".local/share/blackhole-models"))
KORDOC = os.environ.get("BLACKHOLE_KORDOC_BIN", str(MODELS / "kordoc/node_modules/.bin/kordoc"))
CHROME = os.environ.get("BLACKHOLE_EVAL_CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
PEN_FONT = MODELS / "eval-gen/fonts/NanumPenScript-Regular.ttf"
GOTHIC = "/System/Library/Fonts/AppleSDGothicNeo.ttc"

CSS = """
body { font-family: 'Apple SD Gothic Neo', sans-serif; margin: 48px; font-size: 18px; color: #111; }
h1 { font-size: 26px; } table { border-collapse: collapse; } td, th { border: 1px solid #555; padding: 6px 12px; }
.cols { column-count: 2; column-gap: 40px; }
.chat { background: #b2c7da; padding: 24px; min-height: 640px; }
.bubble { max-width: 70%; padding: 12px 16px; border-radius: 14px; margin: 12px 0; font-size: 20px; }
.other { background: #fff; } .me { background: #fef01b; margin-left: auto; }
.app { background: #f2f3f5; padding: 24px; min-height: 640px; }
.card { background: #fff; border-radius: 12px; padding: 20px; font-size: 20px; }
"""


def run(*args, **kw):
    result = subprocess.run(args, capture_output=True, text=True, **kw)
    if result.returncode != 0:
        raise RuntimeError(f"{args[0]} failed: {result.stderr[-400:]}")
    return result


def html_page(body, wrap=None):
    inner = f"<div class='{wrap}'>{body}</div>" if wrap else body
    return f"<!doctype html><html lang='ko'><meta charset='utf-8'><style>{CSS}</style><body>{inner}</body></html>"


def chrome(html_path, *flags):
    with tempfile.TemporaryDirectory() as profile:
        run(CHROME, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
            f"--user-data-dir={profile}", *flags, html_path.as_uri())


def md_to_hwpx(md, work, stem):
    src = work / f"{stem}.md"
    src.write_text(md, encoding="utf-8")
    out = work / f"{stem}.hwpx"
    run(KORDOC, "generate", str(src), "-o", str(out))
    return out


def hwpx_to_png(hwpx, work, stem):
    out = work / f"{stem}.png"
    run(KORDOC, "render", str(hwpx), "--format", "png", "-o", str(out))
    return out


def photo(img, p, seed):
    """Paper on a desk, photographed: perspective, rotation, blur, exposure, sensor noise."""
    rnd = random.Random(seed)
    img = img.convert("RGB")
    w, h = img.size
    k = p.get("perspective", 0)
    if k:
        dx, dy = int(w * k), int(h * k)
        img = img.transform((w, h), Image.QUAD, (dx, 0, 0, h, w, h - dy, w - dx // 2, dy), Image.BICUBIC, fillcolor=(120, 104, 88))
    desk = Image.new("RGB", (int(w * 1.15), int(h * 1.15)), (120, 104, 88))
    desk.paste(img, ((desk.width - w) // 2, (desk.height - h) // 2))
    img = desk.rotate(p.get("rotate", 0), resample=Image.BICUBIC, expand=True, fillcolor=(120, 104, 88))
    if p.get("blur"):
        img = img.filter(ImageFilter.GaussianBlur(p["blur"]))
    img = ImageEnhance.Brightness(img).enhance(p.get("brightness", 1.0))
    if p.get("noise"):
        noise = Image.effect_noise(img.size, p["noise"] * 4).convert("RGB")
        img = Image.blend(img, noise, min(0.25, p["noise"] / 60))
    return img


def handwriting(lines, seed):
    rnd = random.Random(seed)
    font = ImageFont.truetype(str(PEN_FONT), 72)
    page = Image.new("RGB", (1200, 220 + 130 * len(lines)), (250, 246, 232))
    draw = ImageDraw.Draw(page)
    for y in range(120, page.height, 130):
        draw.line([(40, y + 20), (1160, y + 20)], fill=(190, 205, 225), width=2)
    for i, line in enumerate(lines):
        layer = Image.new("RGBA", (1150, 140), (0, 0, 0, 0))
        ImageDraw.Draw(layer).text((10, 20), line, font=font, fill=(30, 40, 90, 255))
        layer = layer.rotate(rnd.uniform(-2.5, 2.5), resample=Image.BICUBIC)
        page.paste(layer, (60 + rnd.randint(-15, 25), 40 + 130 * i), layer)
    return photo(page, {"rotate": rnd.uniform(-3, 3), "blur": 0.6, "brightness": 0.95, "noise": 3}, seed)


def build(doc, out, work):
    stem, fmt, make, body = doc["id"], doc["format"], doc["make"], doc["body"]
    target = out / f"{stem}.{fmt}"
    seed = sum(map(ord, stem))
    if make == "md-hwpx":
        md_to_hwpx(body, work, stem).replace(target)
    elif make == "md-hwpx-png":
        hwpx_to_png(md_to_hwpx(body, work, stem), work, stem).replace(target)
    elif make in ("md-hwpx-png-photo", "md-hwpx-png-scan"):
        png = Image.open(hwpx_to_png(md_to_hwpx(body, work, stem), work, stem))
        img = photo(png, doc.get("photo", {}), seed)
        if make.endswith("scan"):
            img.convert("L").save(target, "PDF", resolution=150)
        elif fmt == "webp":
            img.save(target, "WEBP", quality=70)
        else:
            img.save(target, "JPEG", quality=72)
    elif make in ("html-pdf", "html-pdf-2col"):
        page = work / f"{stem}.html"
        page.write_text(html_page(body), encoding="utf-8")
        chrome(page, f"--print-to-pdf={target}", "--no-pdf-header-footer")
    elif make in ("html-screen-chat", "html-screen-app"):
        page = work / f"{stem}.html"
        page.write_text(html_page(body, "chat" if make.endswith("chat") else "app"), encoding="utf-8")
        chrome(page, f"--screenshot={target}", "--window-size=480,720", "--hide-scrollbars")
    elif make == "html-docx":
        page = work / f"{stem}.html"
        page.write_text(html_page(body), encoding="utf-8")
        run("textutil", "-convert", "docx", str(page), "-output", str(target))
    elif make == "xlsx":
        from openpyxl import Workbook
        book = Workbook()
        sheet = book.active
        sheet.title = "일정"
        for row in body:
            sheet.append(row)
        book.save(target)
    elif make == "handwriting":
        img = handwriting(body, seed)
        img.save(target, "PNG" if fmt == "png" else "JPEG", quality=80)
    else:
        raise ValueError(f"unknown make: {make}")
    return target


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(MODELS / "eval/docs2"))
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    spec = json.loads((HERE / "documents.json").read_text(encoding="utf-8"))
    if not PEN_FONT.exists():
        sys.exit(f"손글씨체 글꼴이 없습니다: {PEN_FONT} (Nanum Pen Script, OFL)")
    with tempfile.TemporaryDirectory() as tmp:
        for doc in spec["documents"]:
            target = out / f"{doc['id']}.{doc['format']}"
            if target.exists() and not args.force:
                continue
            build(doc, out, Path(tmp))
            print(f"{doc['id']} {doc['format']} {target.stat().st_size}B", flush=True)


if __name__ == "__main__":
    main()
