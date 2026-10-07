"""Generate the app icon in all formats (PNG, ICO, ICNS). Run once; outputs are committed."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "packaging" / "icons"
WEB = ROOT / "web" / "icons"
S = 1024


def font(size: int) -> ImageFont.FreeTypeFont:
    for name in ("C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/arial.ttf"):
        if Path(name).exists():
            return ImageFont.truetype(name, size)
    raise SystemExit("No suitable font found")


def draw() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    # Background: rounded square with a vertical teal gradient.
    grad = Image.new("RGBA", (S, S))
    gd = ImageDraw.Draw(grad)
    top, bottom = (20, 184, 166), (15, 94, 89)
    for y in range(S):
        t = y / (S - 1)
        gd.line([(0, y), (S, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([40, 40, S - 40, S - 40], radius=220, fill=255)
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    # Sound-wave bars along the bottom.
    heights = [40, 80, 130, 95, 60, 115, 150, 100, 55, 85, 40]
    bw, gap = 44, 22
    x0 = (S - (len(heights) * bw + (len(heights) - 1) * gap)) // 2
    base = 880
    for i, hgt in enumerate(heights):
        x = x0 + i * (bw + gap)
        d.rounded_rectangle([x, base - hgt, x + bw, base], radius=bw // 2, fill=(255, 255, 255, 110))
    # Arabic letter ain (ع), the first letter of عربي.
    f = font(470)
    letter = "ع"
    bbox = d.textbbox((0, 0), letter, font=f)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    pos = ((S - w) // 2 - bbox[0], 110 - bbox[1] + (560 - h) // 2)
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).text((pos[0] + 8, pos[1] + 14), letter, font=f, fill=(0, 40, 36, 120))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(12)))
    d.text(pos, letter, font=f, fill=(255, 255, 255, 255))
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    WEB.mkdir(parents=True, exist_ok=True)
    img = draw()
    img.save(OUT / "icon-1024.png")
    img.resize((512, 512), Image.LANCZOS).save(OUT / "icon-512.png")
    img.resize((256, 256), Image.LANCZOS).save(OUT / "icon-256.png")
    img.save(OUT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    img.save(OUT / "icon.icns")
    for size in (64, 256):
        img.resize((size, size), Image.LANCZOS).save(WEB / f"icon-{size}.png")
    print("icons written to", OUT, "and", WEB)


if __name__ == "__main__":
    main()
