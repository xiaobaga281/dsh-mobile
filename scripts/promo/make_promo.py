#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
dsh-mobile 宣传片生成器（贴纸拼贴叙事风格）。

纯代码：无头浏览器截的真实界面 + PIL 逐帧合成 + edge-tts 旁白 + numpy 配乐 + ffmpeg 编码。
不依赖任何视频模板/剪辑软件。

用法：
    python scripts/promo/make_promo.py --stills   # 先出 7 张关键帧检查版式
    python scripts/promo/make_promo.py --render   # 全片渲染（约 33s / 1920x1080 / 30fps）

输入：D:/1/tmp/promo/screens/*.png（先跑 capture_screens.mjs）
输出：D:/1/dsh-mobile-release/promo/dsh-mobile-promo-rc176.mp4
"""
from __future__ import annotations

import argparse
import asyncio
import math
import os
import random
import shutil
import subprocess
import wave
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H, FPS = 1920, 1080, 30
SR = 44100
SCREENS = Path("D:/1/tmp/promo/screens")
VO = Path("D:/1/tmp/promo/vo")
OUT = Path("D:/1/dsh-mobile-release/promo")
WHALE = Path("D:/1/dsh-mobile/app/src/main/res/drawable-nodpi/whale_large.png")
FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"

INK = (31, 38, 55)
BLUE = (43, 105, 255)
SKY = (86, 140, 255)
RED = (255, 86, 72)
GREEN = (45, 178, 94)
YELLOW = (255, 190, 60)
PAPER = (246, 241, 231)
TAPE = (232, 214, 178)

FONT_ST = "C:/Windows/Fonts/STXINGKA.TTF"
FONT_BD = "C:/Windows/Fonts/msyhbd.ttc"
FONT_RG = "C:/Windows/Fonts/msyh.ttc"
FONT_KI = "C:/Windows/Fonts/simkai.ttf"
FONT_COMIC = "C:/Windows/Fonts/comicbd.ttf"

OUT.mkdir(parents=True, exist_ok=True)
VO.mkdir(parents=True, exist_ok=True)

_font_cache: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}


def F(path: str, size: int) -> ImageFont.FreeTypeFont:
    key = (path, size)
    if key not in _font_cache:
        _font_cache[key] = ImageFont.truetype(path, size)
    return _font_cache[key]


def clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))


def ease_out_back(p: float, s: float = 1.7) -> float:
    p = clamp(p)
    q = p - 1
    return 1 + (s + 1) * q ** 3 + s * q ** 2


def ease_out_cubic(p: float) -> float:
    p = clamp(p)
    return 1 - (1 - p) ** 3


def pop(t: float, start: float, dur: float = 0.45) -> tuple[float, float]:
    """返回 (scale, alpha)。"""
    p = clamp((t - start) / dur)
    return 0.55 + 0.45 * ease_out_back(p), clamp(p * 3)


def floaty(t: float, amp: float = 6, speed: float = 0.8, phase: float = 0.0) -> float:
    return math.sin(t * speed + phase) * amp


def paste(canvas: Image.Image, img: Image.Image, center: tuple[float, float],
          angle: float = 0.0, scale: float = 1.0, alpha: float = 1.0) -> None:
    if alpha <= 0.01 or scale <= 0.01:
        return
    if abs(scale - 1.0) > 1e-3:
        img = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))),
                         Image.Resampling.LANCZOS)
    if abs(angle) > 0.05:
        img = img.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)
    if alpha < 0.999:
        img = img.copy()
        a = img.getchannel("A").point(lambda v: int(v * alpha))
        img.putalpha(a)
    x = int(center[0] - img.width / 2)
    y = int(center[1] - img.height / 2)
    canvas.alpha_composite(img, (x, y))


def die_cut(img: Image.Image, border: int = 12, shadow: bool = True) -> Image.Image:
    """给任意 RGBA 图形加白色模切边 + 投影。"""
    if border <= 0:
        return img
    alpha = img.getchannel("A")
    grown = alpha.filter(ImageFilter.MaxFilter(border * 2 + 1))
    pad = border + 34
    canvas = Image.new("RGBA", (img.width + pad * 2, img.height + pad * 2), (0, 0, 0, 0))
    if shadow:
        shadow_alpha = grown.filter(ImageFilter.GaussianBlur(12)).point(lambda v: int(v * 88 / 255))
        sh = Image.new("RGBA", img.size, (45, 35, 20, 255))
        sh.putalpha(shadow_alpha)
        canvas.alpha_composite(sh, (pad, pad + 12))
    white = Image.new("RGBA", img.size, (255, 255, 255, 255))
    white.putalpha(grown)
    canvas.alpha_composite(white, (pad, pad))
    canvas.alpha_composite(img, (pad, pad))
    return canvas


def text_block(lines, font, color, spacing: int = 10, padding: int = 8,
               align: str = "center", stroke: int = 0, stroke_fill=(255, 255, 255, 255)) -> Image.Image:
    if isinstance(lines, str):
        lines = [lines]
    dummy = Image.new("RGBA", (8, 8))
    d = ImageDraw.Draw(dummy)
    boxes = [d.textbbox((0, 0), ln, font=font, stroke_width=stroke) for ln in lines]
    widths = [b[2] - b[0] for b in boxes]
    heights = [b[3] - b[1] for b in boxes]
    w = max(widths) + padding * 2
    h = sum(heights) + spacing * (len(lines) - 1) + padding * 2
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    dr = ImageDraw.Draw(img)
    y = padding
    for i, ln in enumerate(lines):
        x = padding if align == "left" else padding + (max(widths) - widths[i]) // 2
        dr.text((x - boxes[i][0], y - boxes[i][1]), ln, font=font, fill=color,
                stroke_width=stroke, stroke_fill=stroke_fill)
        y += heights[i] + spacing
    return img


def text_sticker(lines, font, color, border: int = 12, spacing: int = 10,
                 padding: int = 10, angle: float = 0.0, underline: int | None = None,
                 underline_color=BLUE) -> Image.Image:
    img = text_block(lines, font, color, spacing=spacing, padding=padding)
    if underline is not None:
        d = ImageDraw.Draw(img)
        idx = underline
        # 在指定行下面画一条手绘蓝线
        dummy = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
        boxes = [dummy.textbbox((0, 0), ln, font=font) for ln in lines]
        y = padding + sum((b[3] - b[1]) for b in boxes[:idx]) + spacing * idx + (boxes[idx][3] - boxes[idx][1]) + 10
        x0, x1 = padding + 6, img.width - padding - 6
        pts = []
        for i in range(13):
            x = x0 + (x1 - x0) * i / 12
            pts.append((x, y + math.sin(i * 2.2) * 3))
        d.line(pts, fill=underline_color, width=6, joint="curve")
    return die_cut(img, border=border)


def label_sticker(text, font, fg=INK, bg=(255, 255, 255, 238), padding=(22, 12),
                  radius: int = 16, border: int = 8, angle: float = 0.0) -> Image.Image:
    dummy = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    box = dummy.textbbox((0, 0), text, font=font)
    tw, th = box[2] - box[0], box[3] - box[1]
    w, h = tw + padding[0] * 2, th + padding[1] * 2
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, w - 1, h - 1), radius=radius, fill=bg)
    d.text((padding[0] - box[0], padding[1] - box[1]), text, font=font, fill=fg)
    return die_cut(img, border=border)


def make_tape(w: int, h: int, alpha: int = 150) -> Image.Image:
    img = Image.new("RGBA", (w + 16, h + 8), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    rng = random.Random(7)
    left = [(8 + rng.randint(0, 3), 4 + i * (h - 8) / 12) for i in range(13)]
    right = [(w + 8 - rng.randint(0, 3), 4 + i * (h - 8) / 12) for i in range(12, -1, -1)]
    poly = left + right
    d.polygon(poly, fill=(TAPE[0], TAPE[1], TAPE[2], alpha))
    d.line(poly + [poly[0]], fill=(255, 255, 255, min(alpha + 20, 255)), width=2)
    return img


def paper_background(seed: int = 3) -> Image.Image:
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:H, 0:W]
    base = np.zeros((H, W, 3), dtype=np.float32)
    base[..., 0] = 246 - 8 * yy / H
    base[..., 1] = 241 - 8 * yy / H
    base[..., 2] = 231 - 10 * yy / H
    # 左上暖光、右下冷影
    glow = np.exp(-(((xx - W * 0.2) ** 2 + (yy - H * 0.15) ** 2) / (W * H * 0.22)))
    base += (glow[..., None] * np.array([5, 4, 2], dtype=np.float32))
    sh = np.exp(-(((xx - W * 0.85) ** 2 + (yy - H * 0.9) ** 2) / (W * H * 0.35)))
    base -= (sh[..., None] * np.array([3, 4, 6], dtype=np.float32))
    base += rng.normal(0, 2.2, (H, W, 1))
    img = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8), "RGB").convert("RGBA")
    d = ImageDraw.Draw(img, "RGBA")
    # 点阵
    for y in range(24, H, 34):
        for x in range(24, W, 34):
            d.ellipse((x, y, x + 1, y + 1), fill=(90, 75, 55, 12))
    # 纸纤维
    r2 = random.Random(seed + 1)
    for _ in range(300):
        x, y = r2.randrange(W), r2.randrange(H)
        ln = r2.randint(3, 14)
        a = r2.randint(4, 9)
        d.line((x, y, x + ln, y + r2.randint(-2, 2)),
               fill=(120, 100, 75, a), width=1)
    # 几块很淡的水彩
    for cx, cy, rr, col in [
        (W * 0.86, H * 0.18, 220, (120, 160, 255, 10)),
        (W * 0.1, H * 0.86, 260, (255, 190, 120, 9)),
        (W * 0.55, H * 0.5, 420, (255, 255, 255, 6)),
    ]:
        blob = Image.new("RGBA", (int(rr * 2), int(rr * 2)), (0, 0, 0, 0))
        bd = ImageDraw.Draw(blob)
        bd.ellipse((0, 0, rr * 2, rr * 2), fill=col)
        blob = blob.filter(ImageFilter.GaussianBlur(60))
        img.alpha_composite(blob, (int(cx - rr), int(cy - rr)))
    # 暗角
    v = np.ones((H, W), dtype=np.float32)
    dx = (xx - W / 2) / (W / 2)
    dy = (yy - H / 2) / (H / 2)
    v = np.clip(1.0 - 0.16 * (dx ** 2 + dy ** 2), 0.82, 1.0)
    arr = np.array(img).astype(np.float32)
    arr[..., :3] *= v[..., None]
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGBA")


def load_screen(name: str) -> Image.Image:
    return Image.open(SCREENS / name).convert("RGBA")


def annotate(screen: Image.Image, boxes: list[tuple[tuple[int, int, int, int], tuple, int]]) -> Image.Image:
    img = screen.copy()
    d = ImageDraw.Draw(img)
    r = random.Random(11)
    for (x0, y0, x1, y1), color, width in boxes:
        pts = []
        steps = 48
        for i in range(steps):
            ang = 2 * math.pi * i / steps
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            rx, ry = (x1 - x0) / 2, (y1 - y0) / 2
            px = cx + rx * math.cos(ang) + r.randint(-4, 4)
            py = cy + ry * math.sin(ang) + r.randint(-4, 4)
            pts.append((px, py))
        d.line(pts + [pts[0]], fill=color, width=width, joint="curve")
    return img


def phone_sticker(screen: Image.Image, height: int, border: int = 12) -> Image.Image:
    width = int(height * screen.width / screen.height)
    screen = screen.resize((width, height), Image.Resampling.LANCZOS)
    bezel = max(10, int(width * 0.045))
    radius = int(width * 0.115)
    outer_w, outer_h = width + bezel * 2, height + bezel * 2
    phone = Image.new("RGBA", (outer_w + 24, outer_h + 24), (0, 0, 0, 0))
    d = ImageDraw.Draw(phone)
    # 机身阴影
    d.rounded_rectangle((12, 16, 12 + outer_w, 16 + outer_h), radius=radius + 14,
                        fill=(20, 22, 30, 70))
    d.rounded_rectangle((12, 12, 12 + outer_w, 12 + outer_h), radius=radius + 10,
                        fill=(24, 27, 36, 255))
    d.rounded_rectangle((12, 12, 12 + outer_w, 12 + outer_h), radius=radius + 10,
                        outline=(85, 92, 110, 255), width=2)
    # 屏幕
    mask = Image.new("L", (width, height), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, width - 1, height - 1),
                                           radius=int(radius * 0.75), fill=255)
    phone.paste(screen, (12 + bezel, 12 + bezel), mask)
    # 顶部小黑条
    d.rounded_rectangle((12 + outer_w // 2 - width * 0.16, 12 + bezel - 2,
                         12 + outer_w // 2 + width * 0.16, 12 + bezel + max(6, height // 120)),
                        radius=6, fill=(10, 12, 16, 255))
    # 侧键
    d.rounded_rectangle((12 - 4, 12 + outer_h * 0.22, 12 + 1, 12 + outer_h * 0.34), radius=2,
                        fill=(180, 185, 200, 255))
    d.rounded_rectangle((12 + outer_w - 1, 12 + outer_h * 0.28, 12 + outer_w + 4, 12 + outer_h * 0.42),
                        radius=2, fill=(180, 185, 200, 255))
    return die_cut(phone, border=border)


def whale_sticker(size: int, color=(30, 36, 52)) -> Image.Image:
    src = Image.open(WHALE).convert("RGBA")
    arr = np.array(src).astype(np.float32)
    # 源图是「灰底圆盘 + 黑鲸鱼」，圆盘 alpha 也是不透明的。
    # 按亮度反推鲸鱼遮罩：黑鲸鱼 → 不透明，浅灰底/白色眼睛 → 透明。
    lum = 0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2]
    mask = np.clip((168.0 - lum) / 96.0, 0.0, 1.0) ** 0.75
    alpha = (mask * 255.0).astype(np.uint8)
    rgb = np.zeros_like(arr[..., :3])
    rgb[..., 0], rgb[..., 1], rgb[..., 2] = color
    out = Image.fromarray(np.dstack([rgb, alpha]).astype(np.uint8), "RGBA")
    out = out.resize((size, size), Image.Resampling.LANCZOS)
    return die_cut(out, border=12)


def make_qr(url: str, size: int) -> Image.Image:
    import qrcode
    qr = qrcode.QRCode(box_size=12, border=2)
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(fill_color=(30, 36, 52), back_color="white").convert("RGBA")
    img = img.resize((size, size), Image.Resampling.NEAREST)
    return die_cut(img, border=10)


# ---------------- 动画小件 ----------------
def doodle_arrow(canvas, pts, color, width=7, progress=1.0):
    if progress <= 0:
        return
    d = ImageDraw.Draw(canvas)
    # 按比例截取折线
    full = []
    for i in range(len(pts) - 1):
        (x0, y0), (x1, y1) = pts[i], pts[i + 1]
        seg = math.hypot(x1 - x0, y1 - y0)
        full.append((x0, y0, x1, y1, seg))
    total = sum(s[4] for s in full)
    want = total * progress
    drawn = 0
    last = pts[0]
    for x0, y0, x1, y1, seg in full:
        if drawn >= want:
            break
        k = min(1.0, (want - drawn) / seg) if seg else 1.0
        nx, ny = x0 + (x1 - x0) * k, y0 + (y1 - y0) * k
        d.line((x0, y0, nx, ny), fill=color, width=width, joint="curve")
        last = (nx, ny)
        drawn += seg * k
    # 箭头
    if progress > 0.92:
        ang = math.atan2(last[1] - pts[-2][1], last[0] - pts[-2][0])
        for s in (-0.55, 0.55):
            d.line((last[0], last[1],
                    last[0] + 26 * math.cos(ang + s), last[1] + 26 * math.sin(ang + s)),
                   fill=color, width=width, joint="curve")


def doodle_circle(canvas, center, rx, ry, color, width=7, progress=1.0, angle=-0.2):
    if progress <= 0:
        return
    steps = max(2, int(54 * progress))
    pts = []
    for i in range(steps + 1):
        a = angle + 2 * math.pi * i / steps
        pts.append((center[0] + rx * math.cos(a) + math.sin(i * 1.7) * 3,
                    center[1] + ry * math.sin(a) + math.cos(i * 1.9) * 3))
    ImageDraw.Draw(canvas).line(pts, fill=color, width=width, joint="curve")


def draw_cursor(canvas, pos, click=0.0):
    x, y = pos
    # 点击涟漪
    if 0 < click < 1:
        for k in range(2):
            p = clamp(click * 1.4 - k * 0.25)
            if p <= 0:
                continue
            r = 26 + 54 * p
            d = ImageDraw.Draw(canvas)
            d.ellipse((x - r, y - r, x + r, y + r), outline=(43, 105, 255, int(170 * (1 - p))), width=5)
    d = ImageDraw.Draw(canvas)
    pts = [(x, y), (x, y + 44), (x + 12, y + 33), (x + 22, y + 52),
           (x + 32, y + 47), (x + 22, y + 29), (x + 38, y + 27)]
    d.polygon([(px + 3, py + 4) for px, py in pts], fill=(20, 20, 20, 90))
    d.polygon(pts, fill=(255, 255, 255, 255), outline=(25, 25, 30, 255))


def sparkle(canvas, x, y, size, color=(43, 105, 255), alpha=150, width=4):
    d = ImageDraw.Draw(canvas)
    d.line((x - size, y, x + size, y), fill=color + (alpha,), width=width)
    d.line((x, y - size, x, y + size), fill=color + (alpha,), width=width)
    d.line((x - size * 0.55, y - size * 0.55, x + size * 0.55, y + size * 0.55),
           fill=color + (alpha // 2,), width=max(2, width - 2))
    d.line((x - size * 0.55, y + size * 0.55, x + size * 0.55, y - size * 0.55),
           fill=color + (alpha // 2,), width=max(2, width - 2))


def draw_clock(size: int, t: float) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = size / 2
    r = size * 0.44
    d.ellipse((c - r, c - r, c + r, c + r), fill=(255, 255, 255, 245),
              outline=INK, width=max(5, size // 40))
    for i in range(12):
        a = 2 * math.pi * i / 12
        d.line((c + (r * 0.76) * math.sin(a), c - (r * 0.76) * math.cos(a),
                c + (r * 0.88) * math.sin(a), c - (r * 0.88) * math.cos(a)),
               fill=INK, width=max(3, size // 70))
    ah = a_m = a_s = 0
    if t > 0:
        # 快速转起来：秒针 1.8 圈/秒的视觉速度
        a_s = t * 2 * math.pi * 1.2
        a_m = t * 2 * math.pi * 0.18
        ah = t * 2 * math.pi * 0.03
    d.line((c, c, c + r * 0.42 * math.sin(ah), c - r * 0.42 * math.cos(ah)),
           fill=INK, width=max(5, size // 34))
    d.line((c, c, c + r * 0.62 * math.sin(a_m), c - r * 0.62 * math.cos(a_m)),
           fill=INK, width=max(4, size // 44))
    d.line((c, c, c + r * 0.72 * math.sin(a_s), c - r * 0.72 * math.cos(a_s)),
           fill=RED, width=max(3, size // 60))
    d.ellipse((c - 8, c - 8, c + 8, c + 8), fill=RED)
    return die_cut(img, border=10)


def draw_laptop(w: int, h: int) -> Image.Image:
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # 屏幕
    sx0, sy0, sx1, sy1 = w * 0.12, h * 0.08, w * 0.88, h * 0.66
    d.rounded_rectangle((sx0, sy0, sx1, sy1), radius=16, fill=(28, 34, 50, 255),
                        outline=INK, width=5)
    d.rounded_rectangle((sx0 + 14, sy0 + 14, sx1 - 14, sy1 - 14), radius=8, fill=(35, 45, 72, 255))
    # 代码行
    for i, ln in enumerate([0.62, 0.45, 0.72, 0.35, 0.55]):
        y = sy0 + 40 + i * (sy1 - sy0 - 70) / 5
        d.rounded_rectangle((sx0 + 34, y, sx0 + 34 + (sx1 - sx0 - 70) * ln, y + 9),
                            radius=4, fill=(110, 160, 255, 210 if i % 2 == 0 else 150))
    # 键盘底座
    d.rounded_rectangle((w * 0.05, sy1 - 4, w * 0.95, sy1 + 32), radius=10,
                        fill=(210, 205, 196, 255), outline=INK, width=4)
    d.rounded_rectangle((w * 0.36, sy1 - 2, w * 0.64, sy1 + 26), radius=6,
                        fill=(235, 230, 220, 255))
    return die_cut(img, border=10)


def draw_lock(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, int(size * 1.1)), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    w = size
    body = (w * 0.12, w * 0.42, w * 0.88, w * 1.02)
    d.arc((w * 0.26, w * 0.05, w * 0.74, w * 0.62), 180, 360, fill=INK, width=max(6, w // 14))
    d.rounded_rectangle(body, radius=w // 8, fill=(255, 255, 255, 255), outline=INK, width=max(5, w // 18))
    d.ellipse((w * 0.46, w * 0.62, w * 0.54, w * 0.70), fill=INK)
    d.line((w * 0.50, w * 0.68, w * 0.50, w * 0.82), fill=INK, width=max(4, w // 22))
    return die_cut(img, border=10)


def draw_bell(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.pieslice((size * 0.2, size * 0.18, size * 0.8, size * 0.9), 180, 360, fill=YELLOW, outline=INK, width=5)
    d.rectangle((size * 0.2, size * 0.54, size * 0.8, size * 0.72), fill=YELLOW, outline=INK, width=5)
    d.ellipse((size * 0.42, size * 0.76, size * 0.58, size * 0.92), fill=INK)
    d.ellipse((size * 0.45, size * 0.03, size * 0.55, size * 0.13), fill=INK)
    return die_cut(img, border=8)


def draw_queue_card(w: int, h: int, title: str, color) -> Image.Image:
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, w - 1, h - 1), radius=16, fill=(255, 255, 255, 242),
                        outline=INK, width=4)
    d.rounded_rectangle((16, 16, 16 + 14, h - 16), radius=7, fill=color)
    d.text((46, h // 2 - 16), title, font=F(FONT_BD, 26), fill=INK)
    return die_cut(img, border=6)


# ---------------- 音频 ----------------
def gen_vo() -> list[Path]:
    import edge_tts
    lines = [
        "早上八点，把任务丢进口袋。",
        "它会想，也会动手；工具调用，一行一行看得见。",
        "计划、权限、目标，都贴在同一个浮窗里。",
        "到了工位，手机一贴，就连上电脑。",
        "活儿在后台跑，完成后它自己接着干。",
        "会话、记忆、角色，都留在你自己的设备上。",
        "DSH Mobile，装进口袋的 DeepSeek Harness。",
    ]
    paths = []
    for i, text in enumerate(lines, 1):
        p = VO / f"line{i}.mp3"
        if not p.exists():
            async def one(t=text, path=p):
                c = edge_tts.Communicate(t, "zh-CN-YunxiNeural", rate="+10%", pitch="+2Hz")
                await c.save(str(path))
            asyncio.run(one())
        paths.append(p)
    return paths


def media_duration(path: Path) -> float:
    out = subprocess.check_output([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                                   "-of", "default=nw=1:nk=1", str(path)])
    return float(out.strip())


def decode_audio(path: Path, sr: int = SR) -> np.ndarray:
    out = subprocess.check_output([FFMPEG, "-v", "error", "-i", str(path), "-ac", "1",
                                   "-ar", str(sr), "-f", "f32le", "-"])
    return np.frombuffer(out, dtype=np.float32).copy()


def pluck(freq, dur, sr=SR, amp=0.5, kind="guitar"):
    n = int(dur * sr)
    t = np.arange(n) / sr
    if kind == "bass":
        env = np.exp(-t * 3.0)
        wave_ = np.sin(2 * np.pi * freq * t) * 0.8 + np.sin(2 * np.pi * freq * 2 * t) * 0.18
    else:
        env = np.exp(-t * 5.2)
        wave_ = (np.sin(2 * np.pi * freq * t) * 0.62 +
                 np.sin(2 * np.pi * freq * 2 * t) * 0.22 +
                 np.sin(2 * np.pi * freq * 3 * t) * 0.10)
    attack = np.minimum(1, t / 0.006)
    return (wave_ * env * attack * amp).astype(np.float32)


def synth_bgm(total: float) -> np.ndarray:
    n = int(total * SR) + SR
    mix = np.zeros(n, dtype=np.float32)
    rng = np.random.default_rng(9)
    bpm = 104
    beat = 60 / bpm
    bar = beat * 4
    chords = [
        [60, 64, 67, 72],  # C
        [55, 59, 62, 67],  # G
        [57, 60, 64, 69],  # Am
        [53, 57, 60, 65],  # F
    ]
    def midi_freq(m):
        return 440 * 2 ** ((m - 69) / 12)
    bars = int(total / bar) + 1
    for b in range(bars):
        chord = chords[b % 4]
        start = b * bar
        # 低音
        for beat_i in (0, 2):
            at = start + beat_i * beat
            s = int(at * SR)
            if s < n:
                tone = pluck(midi_freq(chord[0] - 12), 0.9, amp=0.23, kind="bass")
                end = min(n, s + len(tone))
                mix[s:end] += tone[:end - s]
        # 分解和弦
        for e in range(8):
            at = start + e * beat / 2
            s = int(at * SR)
            if s >= n:
                continue
            note = chord[e % len(chord)] + (12 if e % 4 == 3 else 0)
            tone = pluck(midi_freq(note), 0.8, amp=0.13)
            end = min(n, s + len(tone))
            mix[s:end] += tone[:end - s]
        # 底鼓
        for beat_i in (0, 2):
            at = start + beat_i * beat
            s = int(at * SR)
            dur = int(0.16 * SR)
            if s < n:
                tt = np.arange(dur) / SR
                f = 120 * np.exp(-tt * 18) + 45
                k = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 22) * 0.22
                end = min(n, s + dur)
                mix[s:end] += k[:end - s]
        # 沙锤
        for e in range(8):
            at = start + e * beat / 2 + beat * 0.25
            s = int(at * SR)
            dur = int(0.045 * SR)
            if s < n:
                noise = rng.normal(0, 0.11, dur).astype(np.float32)
                noise = np.diff(noise, prepend=0) * 0.5
                env = np.exp(-np.arange(dur) / SR * 55)
                end = min(n, s + dur)
                mix[s:end] += (noise * env)[:end - s]
        # 拍手（2、4 拍）
        for beat_i in (1, 3):
            at = start + beat_i * beat
            s = int(at * SR)
            dur = int(0.09 * SR)
            if s < n:
                noise = rng.normal(0, 0.16, dur).astype(np.float32)
                env = np.exp(-np.arange(dur) / SR * 28)
                end = min(n, s + dur)
                mix[s:end] += (noise * env)[:end - s]
    return mix[: int(total * SR)]


def build_audio(scene_starts: list[float], scene_durs: list[float], total: float, vo_paths: list[Path]) -> Path:
    sr = SR
    n = int(total * sr)
    bgm = synth_bgm(total)[:n]
    bgm *= 0.38
    vo_track = np.zeros(n, dtype=np.float32)
    duck = np.ones(n, dtype=np.float32)
    for i, path in enumerate(vo_paths):
        data = decode_audio(path)
        at = int((scene_starts[i] + 0.28) * sr)
        end = min(n, at + len(data))
        if end > at:
            vo_track[at:end] += data[: end - at] * 0.9
        # 人声闪避
        a0 = max(0, at - int(0.18 * sr))
        a1 = min(n, end + int(0.22 * sr))
        duck[a0:a1] = np.minimum(duck[a0:a1], 0.38)
    # 平滑闪避包络：用线性斜坡，避免对大数组做卷积
    for i, path in enumerate(vo_paths):
        data = decode_audio(path)
        at = int((scene_starts[i] + 0.28) * sr)
        end = min(n, at + len(data))
        if end <= at:
            continue
        ramp = int(0.14 * sr)
        a0, a1 = max(0, at - ramp), min(n, end + ramp)
        if at > a0:
            duck[a0:at] = np.minimum(duck[a0:at], np.linspace(1.0, 0.38, at - a0))
        duck[at:end] = np.minimum(duck[at:end], 0.38)
        if a1 > end:
            duck[end:a1] = np.minimum(duck[end:a1], np.linspace(0.38, 1.0, a1 - end))
    mix = bgm * duck + vo_track
    # SFX：场景起点的“啪”贴纸声 + 点击 + 尾段亮片
    rng = np.random.default_rng(4)
    for i, st in enumerate(scene_starts):
        s = int((st + 0.03) * sr)
        dur = int(0.10 * sr)
        if s >= n:
            continue
        t = np.arange(dur) / sr
        f = 520 * np.exp(-t * 22) + 180
        pop = np.sin(2 * np.pi * np.cumsum(f) / sr) * np.exp(-t * 30) * 0.20
        end = min(n, s + dur)
        mix[s:end] += pop[:end - s]
    # 轻微纸张底噪
    paper = rng.normal(0, 0.004, n).astype(np.float32)
    mix += paper
    mix = np.tanh(mix * 1.15) * 0.92
    peak = float(np.max(np.abs(mix))) or 1.0
    mix = mix / peak * 0.92
    pcm = (np.clip(mix, -1, 1) * 32767).astype(np.int16)
    pcm = np.stack([pcm, pcm], axis=1).reshape(-1)
    out = VO / "master.wav"
    with wave.open(str(out), "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())
    return out


# ---------------- 场景资产 ----------------
class Assets:
    def __init__(self):
        self.paper = paper_background()
        self.whale = whale_sticker(380)
        self.whale_small = whale_sticker(180)
        chat = annotate(load_screen("02-chat.png"), [
            ((70, 640, 710, 820), (43, 105, 255, 210), 6),
        ])
        quick = annotate(load_screen("03-quick-actions.png"), [
            ((40, 1270, 740, 1440), (255, 86, 72, 215), 6),
        ])
        chat_bg = annotate(load_screen("02-chat.png"), [
            ((30, 1410, 750, 1625), (43, 105, 255, 210), 6),
        ])
        connect = load_screen("04-connect.png")
        sessions = load_screen("01-sessions.png")
        settings = load_screen("05-settings.png")
        self.phone_chat = phone_sticker(chat, 740)
        self.phone_quick = phone_sticker(quick, 800)
        self.phone_chat_bg = phone_sticker(chat_bg, 760)
        self.phone_connect = phone_sticker(connect, 720)
        self.phone_sessions = phone_sticker(sessions, 620)
        self.phone_settings = phone_sticker(settings, 620)
        self.tape = make_tape(240, 54)
        self.tape_small = make_tape(150, 40, alpha=135)
        self.title_intro = text_sticker(["把 AI", "装进口袋"], F(FONT_ST, 132), INK,
                                        spacing=8, border=14, underline=1)
        self.title_chat = text_sticker(["会想，", "也会动手"], F(FONT_ST, 112), INK,
                                       spacing=4, border=13, underline=1)
        self.title_quick = text_sticker(["计划 · 权限 · 目标"], F(FONT_ST, 88), INK, border=12)
        self.title_connect = text_sticker(["手机一贴", "就连上电脑"], F(FONT_ST, 108), INK, spacing=4, border=13)
        self.title_bg = text_sticker(["后台继续跑"], F(FONT_ST, 112), INK, border=13)
        self.title_local = text_sticker(["都在你的设备上"], F(FONT_ST, 106), INK, border=13)
        self.sub_intro = label_sticker("DeepSeek Harness · Android", F(FONT_COMIC, 34), INK,
                                       padding=(24, 12), angle=-2)
        self.note_chat = label_sticker("工具调用 · 一行一行看得见", F(FONT_KI, 42), INK,
                                        padding=(24, 12), angle=-3)
        self.note_quick = label_sticker("都贴在同一个浮窗里", F(FONT_KI, 40), INK,
                                        padding=(24, 12), angle=2)
        self.note_bg = label_sticker("完成后，它自己接着干", F(FONT_KI, 42), INK,
                                      padding=(24, 12), angle=-2)
        self.bubble = label_sticker("今天也替你干活！", F(FONT_KI, 38), INK, padding=(24, 14), angle=4)
        self.pill_plan = label_sticker("计划模式", F(FONT_BD, 30), INK, bg=(236, 240, 255, 245))
        self.pill_goal = label_sticker("目标模式", F(FONT_BD, 30), INK, bg=(255, 243, 220, 245))
        self.pill_perm = label_sticker("默认权限", F(FONT_BD, 30), INK, bg=(232, 255, 240, 245))
        self.pill_mem = label_sticker("会话记忆", F(FONT_BD, 28), INK, bg=(236, 240, 255, 245))
        self.pill_persona = label_sticker("角色设定", F(FONT_BD, 28), INK, bg=(255, 236, 244, 245))
        self.pill_secure = label_sticker("端到端加密", F(FONT_BD, 28), INK, bg=(232, 255, 240, 245))
        self.tag_version = label_sticker("rc.176 · Android · 开源", F(FONT_BD, 26), INK,
                                         bg=(255, 255, 255, 230))
        self.btn_github = label_sticker("GitHub Releases 免费下载", F(FONT_BD, 30), (255, 255, 255, 255),
                                        bg=(43, 105, 255, 255))
        self.qr = make_qr("https://github.com/xiaobaga281/dsh-mobile/releases/latest", 300)
        self.qr_label = label_sticker("扫码下载", F(FONT_KI, 32), INK, padding=(18, 10))
        self.clock = None
        self.laptop = draw_laptop(520, 360)
        self.lock = draw_lock(150)
        self.bell = draw_bell(80)
        self.queue = [
            draw_queue_card(300, 74, "排队中", (255, 190, 60)),
            draw_queue_card(300, 74, "生成中", (86, 140, 255)),
            draw_queue_card(300, 74, "已完成", (45, 178, 94)),
        ]


# ---------------- 场景绘制 ----------------
def scene_intro(canvas, a: Assets, t: float, dur: float):
    # 背景小星星
    for i, (x, y, s, col) in enumerate([
        (260, 170, 16, BLUE), (1700, 250, 13, RED), (1560, 940, 14, GREEN), (360, 900, 11, YELLOW),
    ]):
        sparkle(canvas, x + floaty(t, 8, 0.7, i), y, s, col, 120, 3)
    p, al = pop(t, 0.35, 0.55)
    paste(canvas, a.title_intro, (620, 430), angle=-3 + floaty(t, 1.2, 0.9), scale=p, alpha=al)
    # 胶带
    paste(canvas, a.tape, (620, 640), angle=-5, scale=0.8, alpha=al * 0.9)
    p2, al2 = pop(t, 0.8, 0.5)
    paste(canvas, a.sub_intro, (600, 690), angle=-2, scale=p2, alpha=al2)
    # 鲸鱼
    p3, al3 = pop(t, 0.55, 0.6)
    paste(canvas, a.whale, (1450, 520 + floaty(t, 12, 0.9)), angle=5 + floaty(t, 2.2, 0.7),
          scale=p3, alpha=al3)
    p4, al4 = pop(t, 1.2, 0.45)
    paste(canvas, a.bubble, (1500, 790), angle=4, scale=p4, alpha=al4)
    # 手绘箭头
    doodle_arrow(canvas, [(930, 540), (1080, 500), (1200, 540)], (43, 105, 255, 210), 6,
                 clamp((t - 0.7) / 0.5))


def scene_chat(canvas, a: Assets, t: float, dur: float):
    # 手机滑入
    slide = ease_out_cubic(clamp((t - 0.05) / 0.55))
    x = 1290 + (1 - slide) * 280
    paste(canvas, a.phone_chat, (x, 560 + floaty(t, 5, 0.8)), angle=-4 + floaty(t, 0.8, 0.7), scale=1.0, alpha=clamp(t * 5))
    # 胶带
    paste(canvas, a.tape, (x - 40, 210), angle=-12, scale=0.9, alpha=clamp((t - 0.35) * 4))
    p, al = pop(t, 0.2, 0.55)
    paste(canvas, a.title_chat, (470, 300), angle=-2 + floaty(t, 1, 0.8), scale=p, alpha=al)
    p2, al2 = pop(t, 0.65, 0.45)
    paste(canvas, a.note_chat, (450, 600 + floaty(t, 4, 0.8)), angle=-3, scale=p2, alpha=al2)
    doodle_arrow(canvas, [(720, 610), (880, 560), (1040, 570)], (43, 105, 255, 220), 6,
                 clamp((t - 0.8) / 0.5))
    # 批注圈 + 标签
    doodle_circle(canvas, (1300, 520), 190, 108, (43, 105, 255, 200), 6,
                  clamp((t - 1.0) / 0.5), angle=-0.3)
    if t > 1.35:
        p3, al3 = pop(t, 1.35, 0.4)
        paste(canvas, label_sticker("看得见", F(FONT_KI, 34), BLUE, padding=(18, 9)),
              (1545, 445), angle=-6, scale=p3, alpha=al3)
    # 光标
    cp = clamp((t - 1.15) / 0.7)
    cx = 1660 + (1370 - 1660) * ease_out_cubic(cp)
    cy = 920 + (500 - 920) * ease_out_cubic(cp)
    click = clamp((t - 1.9) / 0.35)
    if t > 1.1:
        draw_cursor(canvas, (cx, cy), click)


def scene_quick(canvas, a: Assets, t: float, dur: float):
    p, al = pop(t, 0.1, 0.55)
    paste(canvas, a.phone_quick, (560, 570 + floaty(t, 5, 0.7)), angle=3 + floaty(t, 0.8, 0.6),
          scale=p, alpha=al)
    paste(canvas, a.tape, (600, 175), angle=9, scale=0.9, alpha=clamp((t - 0.4) * 4))
    p1, a1 = pop(t, 0.25, 0.55)
    paste(canvas, a.title_quick, (1290, 270), angle=-2, scale=p1, alpha=a1)
    p2, a2 = pop(t, 0.6, 0.45)
    paste(canvas, a.note_quick, (1330, 430 + floaty(t, 4, 0.8)), angle=2, scale=p2, alpha=a2)
    # 三个小标签
    for i, (img, pos, rot, st) in enumerate([
        (a.pill_plan, (980, 600), -4, 0.85),
        (a.pill_goal, (1230, 690), 3, 1.05),
        (a.pill_perm, (1490, 600), -2, 1.25),
    ]):
        pp, aa = pop(t, st, 0.4)
        paste(canvas, img, (pos[0], pos[1] + floaty(t, 5, 0.9, i)), angle=rot, scale=pp, alpha=aa)
    doodle_arrow(canvas, [(860, 650), (540, 740), (510, 790)], (255, 86, 72, 215), 6,
                 clamp((t - 1.2) / 0.5))
    doodle_circle(canvas, (510, 800), 190, 62, (255, 86, 72, 200), 6,
                  clamp((t - 1.35) / 0.5), angle=0.1)
    # 光标点“完全访问”
    cp = clamp((t - 1.5) / 0.6)
    cx = 1720 + (655 - 1720) * ease_out_cubic(cp)
    cy = 980 + (795 - 980) * ease_out_cubic(cp)
    if t > 1.35:
        draw_cursor(canvas, (cx, cy), clamp((t - 2.15) / 0.35))


def scene_connect(canvas, a: Assets, t: float, dur: float):
    p, al = pop(t, 0.1, 0.5)
    paste(canvas, a.phone_connect, (800, 590 + floaty(t, 5, 0.8)), angle=-3 + floaty(t, 0.7, 0.5),
          scale=p, alpha=al)
    p2, al2 = pop(t, 0.45, 0.55)
    paste(canvas, a.laptop, (1540, 560 + floaty(t, 6, 0.7)), angle=2, scale=p2, alpha=al2)
    doodle_arrow(canvas, [(1110, 520), (1260, 500), (1350, 520)], (43, 105, 255, 220), 6,
                 clamp((t - 0.7) / 0.5))
    # 连线小点
    if t > 1.0:
        for k in range(3):
            pos = ((t * 0.55 + k / 3) % 1.0)
            x = 1110 + 240 * pos
            y = 500 + math.sin(pos * math.pi) * -26
            ImageDraw.Draw(canvas).ellipse((x - 6, y - 6, x + 6, y + 6), fill=(43, 105, 255, 220))
    p3, al3 = pop(t, 0.2, 0.5)
    paste(canvas, a.title_connect, (330, 240), angle=-3, scale=p3, alpha=al3)
    p4, al4 = pop(t, 1.1, 0.45)
    paste(canvas, label_sticker("同一会话 · 模型 / 任务 / 文件", F(FONT_KI, 36), INK, padding=(24, 12)),
          (1300, 860), angle=-3, scale=p4, alpha=al4)


def scene_background(canvas, a: Assets, t: float, dur: float):
    p, al = pop(t, 0.1, 0.5)
    paste(canvas, a.phone_chat_bg, (1360, 590 + floaty(t, 5, 0.7)), angle=4 + floaty(t, 0.7, 0.5),
          scale=p, alpha=al)
    # 时钟
    clock = draw_clock(300, max(0, t - 0.5))
    p2, al2 = pop(t, 0.35, 0.5)
    paste(canvas, clock, (430, 470 + floaty(t, 8, 0.8)), angle=-4, scale=p2 * 0.92, alpha=al2)
    p3, al3 = pop(t, 0.2, 0.5)
    paste(canvas, a.title_bg, (430, 200), angle=-2, scale=p3, alpha=al3)
    p4, al4 = pop(t, 0.8, 0.45)
    paste(canvas, a.note_bg, (430, 760 + floaty(t, 4, 0.9)), angle=-2, scale=p4, alpha=al4)
    # 完成通知贴纸
    p5, al5 = pop(t, 1.25, 0.4)
    paste(canvas, a.bell, (805, 225), angle=-8, scale=p5, alpha=al5)
    paste(canvas, label_sticker("后台任务完成", F(FONT_BD, 30), INK, bg=(255, 250, 235, 245)),
          (990, 230), angle=-3, scale=p5, alpha=al5)
    # 队列卡
    for i, card in enumerate(a.queue):
        pp, aa = pop(t, 0.9 + i * 0.18, 0.4)
        paste(canvas, card, (900 + i * 18, 900 - i * 70 + floaty(t, 4, 0.8, i)),
              angle=-4 + i * 3, scale=pp, alpha=aa)
    doodle_arrow(canvas, [(700, 560), (930, 560), (1120, 600)], (43, 105, 255, 220), 6,
                 clamp((t - 1.0) / 0.5))


def scene_local(canvas, a: Assets, t: float, dur: float):
    p1, a1 = pop(t, 0.1, 0.55)
    paste(canvas, a.phone_sessions, (680, 610 + floaty(t, 4, 0.7)), angle=-5 + floaty(t, 0.6, 0.5),
          scale=p1, alpha=a1)
    p2, a2 = pop(t, 0.3, 0.55)
    paste(canvas, a.phone_settings, (1270, 610 + floaty(t, 4, 0.8)), angle=4 + floaty(t, 0.6, 0.6),
          scale=p2, alpha=a2)
    paste(canvas, a.tape_small, (700, 245), angle=-12, scale=0.9, alpha=clamp((t - 0.5) * 4))
    paste(canvas, a.tape_small, (1240, 250), angle=10, scale=0.9, alpha=clamp((t - 0.6) * 4))
    p3, a3 = pop(t, 0.2, 0.5)
    paste(canvas, a.title_local, (960, 175), angle=-2, scale=p3, alpha=a3)
    p4, a4 = pop(t, 0.9, 0.45)
    paste(canvas, a.lock, (1550, 270 + floaty(t, 6, 0.9)), angle=5, scale=p4, alpha=a4)
    for i, (img, pos, st) in enumerate([
        (a.pill_mem, (470, 930), 0.8),
        (a.pill_persona, (880, 955), 1.0),
        (a.pill_secure, (1320, 930), 1.2),
    ]):
        pp, aa = pop(t, st, 0.4)
        paste(canvas, img, (pos[0], pos[1] + floaty(t, 4, 0.9, i)), angle=-2 + i * 2, scale=pp, alpha=aa)


def scene_outro(canvas, a: Assets, t: float, dur: float):
    p1, a1 = pop(t, 0.15, 0.55)
    paste(canvas, a.whale, (560, 520 + floaty(t, 8, 0.8)), angle=-3 + floaty(t, 2, 0.7), scale=p1, alpha=a1)
    p2, a2 = pop(t, 0.3, 0.55)
    paste(canvas, text_sticker(["DSH Mobile"], F(FONT_COMIC, 118), INK, border=14),
          (1180, 300), angle=-2, scale=p2, alpha=a2)
    p3, a3 = pop(t, 0.55, 0.45)
    paste(canvas, label_sticker("装进口袋的 DeepSeek Harness", F(FONT_KI, 44), INK, padding=(26, 14)),
          (1160, 445), angle=-1, scale=p3, alpha=a3)
    p4, a4 = pop(t, 0.75, 0.4)
    paste(canvas, a.tag_version, (1120, 525), angle=1, scale=p4, alpha=a4)
    p5, a5 = pop(t, 0.95, 0.45)
    paste(canvas, a.qr, (1580, 760), angle=3, scale=p5, alpha=a5)
    paste(canvas, a.qr_label, (1580, 950), angle=-2, scale=p5, alpha=a5)
    p6, a6 = pop(t, 1.15, 0.4)
    paste(canvas, a.btn_github, (1130, 650), angle=-2, scale=p6, alpha=a6)
    # 彩纸
    if t > 0.5:
        rng = random.Random(5)
        d = ImageDraw.Draw(canvas)
        for i in range(42):
            ang = rng.random() * math.tau
            rr = 420 + rng.random() * 320
            x = 960 + math.cos(ang) * rr * (0.6 + 0.4 * rng.random())
            y = 540 + math.sin(ang) * rr * 0.55
            prog = clamp((t - 0.5) / 1.2)
            if prog <= 0:
                continue
            x = x + (x - 960) * prog * 0.6
            y = y + (y - 540) * prog * 0.6
            col = [BLUE, RED, GREEN, YELLOW, SKY][i % 5]
            s = 7 + rng.random() * 10
            d.rectangle((x, y, x + s, y + s), fill=col + (180,))


# ---------------- 时间轴 ----------------
VO_LINES = [
    ("早上八点，把任务丢进口袋。", "早上八点，把任务丢进口袋", 3.6),
    ("它会想，也会动手；工具调用，一行一行看得见。", "会想，也会动手 · 工具一行一行看得见", 5.1),
    ("计划、权限、目标，都贴在同一个浮窗里。", "计划 / 权限 / 目标，同一块浮窗", 4.7),
    ("到了工位，手机一贴，就连上电脑。", "手机一贴，连上电脑", 4.1),
    ("活儿在后台跑，完成后它自己接着干。", "后台继续跑，完成自动续上", 4.1),
    ("会话、记忆、角色，都留在你自己的设备上。", "会话 / 记忆 / 角色，都留在本机", 4.8),
    ("DSH Mobile，装进口袋的 DeepSeek Harness。", "DSH Mobile · 开源 · 免费下载", 4.8),
]
CHAPTERS = ["01 / 口袋", "02 / 会动手", "03 / 随手调", "04 / 连电脑", "05 / 后台跑", "06 / 留在本机", "07 / 下载"]


def build_timeline():
    vo_paths = gen_vo()
    durs = [media_duration(p) for p in vo_paths]
    starts = []
    scene_durs = []
    cursor = 0.45
    for i, (_, _, min_d) in enumerate(VO_LINES):
        d = max(min_d, durs[i] + 0.72)
        starts.append(cursor)
        scene_durs.append(d)
        cursor += d
    total = cursor + 0.35
    return vo_paths, starts, scene_durs, total


def chapter_tab(text: str) -> Image.Image:
    img = Image.new("RGBA", (360, 74), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, 359, 73), radius=14, fill=(255, 255, 255, 238), outline=INK, width=3)
    d.ellipse((18, 24, 42, 48), fill=BLUE)
    d.text((58, 18), text, font=F(FONT_BD, 30), fill=INK)
    return die_cut(img, border=7)


def subtitle_strip(text: str) -> Image.Image:
    return label_sticker(text, F(FONT_BD, 30), INK, bg=(255, 255, 255, 235), padding=(30, 13), angle=0)


def render_frame(t: float, a: Assets, scenes, starts, durs, chapters, subs, bg_variants):
    img = a.paper.copy()
    # 找当前场景
    idx = 0
    for i, st in enumerate(starts):
        if t >= st:
            idx = i
    local = t - starts[idx]
    dur = durs[idx]
    fn = [scene_intro, scene_chat, scene_quick, scene_connect, scene_background, scene_local, scene_outro][idx]
    fn(img, a, local, dur)
    # 章节签
    pp, aa = pop(local, 0.05, 0.4)
    paste(img, chapters[idx], (205, 100), angle=-2, scale=pp, alpha=aa)
    # 字幕
    sa = clamp(local / 0.3) * clamp((dur - local) / 0.3)
    if sa > 0:
        paste(img, subs[idx], (960, 1000), angle=0, scale=1.0, alpha=sa * 0.96)
    # 场景切换：纸张闪白
    for st in starts[1:]:
        d = t - st
        if abs(d) < 0.20:
            k = 1 - abs(d) / 0.20
            k = k * k
            overlay = Image.new("RGBA", (W, H), (246, 241, 231, int(235 * k)))
            img.alpha_composite(overlay)
    return img


def render_stills(a: Assets, scenes, starts, durs, chapters, subs):
    still_dir = OUT / "stills"
    still_dir.mkdir(parents=True, exist_ok=True)
    for i, st in enumerate(starts):
        t = st + min(2.0, durs[i] * 0.55)
        img = render_frame(t, a, None, starts, durs, chapters, subs, None)
        img.convert("RGB").save(still_dir / f"scene{i+1}.jpg", quality=92)
        print("still", i + 1, f"{t:.1f}s")


def render_video(a: Assets, scenes, starts, durs, total, chapters, subs, audio_path: Path):
    out = OUT / "dsh-mobile-promo-rc176.mp4"
    cmd = [
        FFMPEG, "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
        "-i", str(audio_path),
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        "-c:a", "aac", "-b:a", "192k", "-shortest", str(out),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    frames = int(total * FPS)
    for i in range(frames):
        t = i / FPS
        img = render_frame(t, a, None, starts, durs, chapters, subs, None)
        proc.stdin.write(img.convert("RGB").tobytes())
        if i % 60 == 0:
            print(f"frame {i}/{frames} ({t:.1f}s)", flush=True)
    proc.stdin.close()
    proc.wait()
    print("wrote", out, out.stat().st_size if out.exists() else "FAILED")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stills", action="store_true")
    ap.add_argument("--render", action="store_true")
    args = ap.parse_args()
    a = Assets()
    chapters = [chapter_tab(c) for c in CHAPTERS]
    subs = [subtitle_strip(s[1]) for s in VO_LINES]
    vo_paths, starts, durs, total = build_timeline()
    print("timeline", [round(x, 2) for x in starts], "total", round(total, 2))
    if args.stills or not args.render:
        render_stills(a, None, starts, durs, chapters, subs)
    if args.render:
        audio = build_audio(starts, durs, total, vo_paths)
        print("audio", audio)
        render_video(a, None, starts, durs, total, chapters, subs, audio)


if __name__ == "__main__":
    main()
