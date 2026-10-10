"""Generate the Tamkeen app icon in every format from the brand logo. Run once; outputs are committed.

    python packaging/make_icons.py

The logo (packaging/brand/tamkeen-logo.webp) is a wide banner: gold calligraphy "تمكين" on a
plum-to-teal gradient. Icons are square, so the calligraphy is lifted off the banner as a
mask, sharpened at a larger size, and placed on a freshly drawn copy of the same gradient.
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
LOGO = ROOT / "packaging" / "brand" / "tamkeen-logo.webp"
OUT = ROOT / "packaging" / "icons"
WEB = ROOT / "web" / "icons"
ANDROID = ROOT / "mobile" / "android" / "app" / "src" / "main" / "res"
DOCS = ROOT / "docs"

PLUM, MID, TEAL = (54, 0, 50), (27, 82, 109), (11, 134, 147)
GOLD = (241, 207, 123)
S = 1024


def gradient(size: int) -> Image.Image:
    """The logo's background: plum (bottom-left) through deep blue to teal (top-right)."""
    y, x = np.mgrid[0:size, 0:size] / (size - 1)
    t = np.clip(0.62 * x + 0.38 * (1 - y), 0, 1)[..., None]
    lo, mid, hi = (np.array(c, float) for c in (PLUM, MID, TEAL))
    rgb = np.where(t < 0.5, lo + (mid - lo) * (t / 0.5), mid + (hi - mid) * ((t - 0.5) / 0.5))
    return Image.fromarray(rgb.astype(np.uint8), "RGB").convert("RGBA")


def calligraphy(height: int) -> Image.Image:
    """The gold wordmark as a crisp alpha mask, scaled so it is `height` pixels tall."""
    rgb = np.asarray(Image.open(LOGO).convert("RGB")).astype(float)
    # How gold a pixel is: close to GOLD and far from the blue-ish background.
    warmth = np.clip((rgb[..., 0] - rgb[..., 2] - 20) / 90, 0, 1) * np.clip((rgb[..., 0] - 150) / 70, 0, 1)
    ys, xs = np.nonzero(warmth > 0.5)
    pad = 6
    box = (xs.min() - pad, ys.min() - pad, xs.max() + pad + 1, ys.max() + pad + 1)
    mask = Image.fromarray((warmth * 255).astype(np.uint8), "L").crop(box)
    scale = height / mask.height
    big = mask.resize((round(mask.width * scale), height), Image.BICUBIC).filter(ImageFilter.GaussianBlur(scale * 0.55))
    # Steepen the soft edge back into a clean outline.
    return big.point(lambda v: max(0, min(255, int((v - 96) * 4))))


def compose(size: int, word_width: float, rounded: bool = True, background: bool = True) -> Image.Image:
    """Square icon: gradient (optionally with rounded corners) and the wordmark centred on it."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    if background:
        bg = gradient(size)
        if rounded:
            m = Image.new("L", (size, size), 0)
            inset = round(size * 0.04)
            ImageDraw.Draw(m).rounded_rectangle([inset, inset, size - inset, size - inset], radius=round(size * 0.215), fill=255)
            img.paste(bg, (0, 0), m)
        else:
            img = bg
    probe = calligraphy(400)
    target_w = round(size * word_width)
    word = calligraphy(round(400 * target_w / probe.width))
    pos = ((size - word.width) // 2, (size - word.height) // 2)
    shadow = Image.new("L", (size, size), 0)
    shadow.paste(word, (pos[0] + round(size * 0.006), pos[1] + round(size * 0.012)))
    shadow = shadow.filter(ImageFilter.GaussianBlur(size * 0.012)).point(lambda v: int(v * 0.45))
    if background:
        img.paste((20, 0, 30, 255), (0, 0), ImageChops.multiply(shadow, img.getchannel("A")))
    layer = Image.new("RGBA", (size, size), GOLD + (0,))
    full = Image.new("L", (size, size), 0)
    full.paste(word, pos)
    layer.putalpha(full)
    img.alpha_composite(layer)
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    WEB.mkdir(parents=True, exist_ok=True)
    icon = compose(S, 0.74)
    icon.save(OUT / "icon-1024.png")
    for n in (512, 256):
        icon.resize((n, n), Image.LANCZOS).save(OUT / f"icon-{n}.png")
    icon.resize((256, 256), Image.LANCZOS).save(WEB / "icon-256.png")
    icon.resize((64, 64), Image.LANCZOS).save(WEB / "icon-64.png")
    icon.resize((256, 256), Image.LANCZOS).save(DOCS / "icon.png")
    icon.save(OUT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    icon.save(OUT / "icon.icns", sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)])

    # Android: legacy square + round icons, and the adaptive icon's foreground (the wordmark
    # alone, inside the central safe zone; its background is the gradient drawable).
    square = compose(S, 0.74)
    circle_mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(circle_mask).ellipse([0, 0, S, S], fill=255)
    round_icon = compose(S, 0.62, rounded=False)
    round_icon.putalpha(circle_mask)
    foreground = compose(S, 0.46, background=False)
    for density, px in {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}.items():
        d = ANDROID / f"mipmap-{density}"
        if not d.exists():
            continue
        square.resize((px, px), Image.LANCZOS).save(d / "ic_launcher.png")
        round_icon.resize((px, px), Image.LANCZOS).save(d / "ic_launcher_round.png")
        fg = round(px * 108 / 48)
        foreground.resize((fg, fg), Image.LANCZOS).save(d / "ic_launcher_foreground.png")
    print("Icons written.")


if __name__ == "__main__":
    main()
