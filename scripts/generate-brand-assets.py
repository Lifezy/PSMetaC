from __future__ import annotations

from pathlib import Path
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parent.parent
RENDERER_ASSETS = ROOT / "src" / "desktop" / "renderer" / "assets"
BUILD_ASSETS = ROOT / "build"
SIZE = 1024


def rounded_line(draw: ImageDraw.ImageDraw, points, fill, width):
    draw.line(points, fill=fill, width=width, joint="curve")
    radius = width // 2
    for x, y in (points[0], points[-1]):
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=fill)


def cubic(p0, p1, p2, p3, steps=28):
    values = []
    for index in range(steps + 1):
        t = index / steps
        u = 1 - t
        values.append(
            (
                round(u**3 * p0[0] + 3 * u**2 * t * p1[0] + 3 * u * t**2 * p2[0] + t**3 * p3[0]),
                round(u**3 * p0[1] + 3 * u**2 * t * p1[1] + 3 * u * t**2 * p2[1] + t**3 * p3[1]),
            )
        )
    return values


def gradient(size, top, bottom):
    image = Image.new("RGBA", (size, size))
    pixels = image.load()
    for y in range(size):
        t = y / max(1, size - 1)
        color = tuple(round(top[i] * (1 - t) + bottom[i] * t) for i in range(4))
        for x in range(size):
            pixels[x, y] = color
    return image


def build_icon():
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    tile_mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(tile_mask).rounded_rectangle((54, 54, 970, 970), radius=226, fill=255)
    tile = gradient(SIZE, (116, 117, 243, 255), (52, 56, 143, 255))
    canvas.alpha_composite(Image.composite(tile, Image.new("RGBA", tile.size), tile_mask))

    draw = ImageDraw.Draw(canvas, "RGBA")
    draw.rounded_rectangle((452, 149, 870, 771), radius=142, fill=(42, 191, 165, 235))
    draw.rounded_rectangle((212, 196, 842, 874), radius=170, fill=(174, 177, 255, 190))
    draw.rounded_rectangle((180, 278, 758, 850), radius=142, fill=(27, 34, 85, 40))
    draw.rounded_rectangle((164, 247, 746, 829), radius=142, fill=(255, 255, 255, 255))

    ink = (63, 67, 170, 255)
    rounded_line(draw, [(278, 684), (278, 390)], ink, 66)
    p_curve = (
        cubic((278, 390), (410, 390), (478, 420), (478, 490))
        + cubic((478, 490), (478, 560), (410, 590), (350, 590))[1:]
    )
    rounded_line(draw, p_curve, ink, 66)

    s_curve = (
        cubic((650, 424), (620, 393), (588, 385), (554, 385))
        + cubic((554, 385), (496, 385), (460, 412), (460, 451))[1:]
        + cubic((460, 451), (460, 490), (490, 508), (554, 520))[1:]
        + cubic((554, 520), (622, 535), (652, 558), (652, 599))[1:]
        + cubic((652, 599), (652, 649), (607, 681), (544, 681))[1:]
        + cubic((544, 681), (499, 681), (458, 665), (432, 635))[1:]
    )
    rounded_line(draw, s_curve, ink, 55)

    draw.polygon(
        [(785, 170), (809, 232), (871, 256), (809, 280), (785, 342), (761, 280), (699, 256), (761, 232)],
        fill=(255, 255, 255, 255),
    )
    draw.polygon(
        [(856, 329), (866, 356), (893, 366), (866, 376), (856, 403), (846, 376), (819, 366), (846, 356)],
        fill=(184, 255, 240, 255),
    )
    draw.ellipse((772, 744, 808, 780), fill=(56, 203, 180, 255))
    draw.ellipse((828, 707, 852, 731), fill=(114, 226, 207, 255))
    draw.ellipse((865, 663, 879, 677), fill=(184, 255, 240, 255))
    return canvas


def build_tray_icon(icon: Image.Image, state: str):
    canvas = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    compact = icon.resize((27, 27), Image.Resampling.LANCZOS)
    canvas.alpha_composite(compact, (1, 1))
    draw = ImageDraw.Draw(canvas, "RGBA")
    badge_colors = {
        "idle": (56, 203, 180, 255),
        "running": (34, 160, 107, 255),
        "paused": (217, 139, 25, 255),
        "attention": (217, 54, 79, 255),
    }
    draw.ellipse((20, 20, 31, 31), fill=(255, 255, 255, 255))
    draw.ellipse((21, 21, 30, 30), fill=badge_colors[state])
    if state == "paused":
        draw.rounded_rectangle((24, 23, 25, 28), radius=1, fill="white")
        draw.rounded_rectangle((27, 23, 28, 28), radius=1, fill="white")
    elif state == "attention":
        draw.rounded_rectangle((25, 23, 26, 26), radius=1, fill="white")
        draw.ellipse((25, 28, 26, 29), fill="white")
    elif state == "running":
        draw.polygon([(24, 23), (24, 28), (28, 25.5)], fill="white")
    else:
        draw.ellipse((24, 24, 27, 27), fill="white")
    return canvas


def main():
    RENDERER_ASSETS.mkdir(parents=True, exist_ok=True)
    BUILD_ASSETS.mkdir(parents=True, exist_ok=True)
    icon = build_icon()
    icon.save(RENDERER_ASSETS / "psmetac-icon-1024.png")
    icon.resize((256, 256), Image.Resampling.LANCZOS).save(
        RENDERER_ASSETS / "psmetac-icon-256.png"
    )
    for state in ("idle", "running", "paused", "attention"):
        build_tray_icon(icon, state).save(
            RENDERER_ASSETS / f"psmetac-tray-{state}.png"
        )
    icon.save(
        BUILD_ASSETS / "psmetac.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(RENDERER_ASSETS / "psmetac-icon-256.png")
    print(BUILD_ASSETS / "psmetac.ico")


if __name__ == "__main__":
    main()
