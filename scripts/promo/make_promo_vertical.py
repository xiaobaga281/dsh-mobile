#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
dsh-mobile 宣传片 · 抖音竖屏版（1080×1920）。

复用 make_promo.py 的素材/贴纸/音频工具，但版面按 9:16 重排：
标题上移、手机居中放大、字幕与按钮避开抖音底栏和右侧操作区。
"""
from __future__ import annotations

import argparse
import math
import random
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw

import make_promo as hp

W, H, FPS = 1080, 1920, 30
OUT = Path("D:/1/dsh-mobile-release/promo")
OUT.mkdir(parents=True, exist_ok=True)

PAPER = hp.PAPER
INK = hp.INK
BLUE = hp.BLUE
RED = hp.RED
GREEN = hp.GREEN
YELLOW = hp.YELLOW
FONT_ST = hp.FONT_ST
FONT_BD = hp.FONT_BD
FONT_KI = hp.FONT_KI
FONT_COMIC = hp.FONT_COMIC


def paper_vertical() -> Image.Image:
    old_w, old_h = hp.W, hp.H
    hp.W, hp.H = W, H
    try:
        return hp.paper_background()
    finally:
        hp.W, hp.H = old_w, old_h


class VAssets:
    def __init__(self):
        self.paper = paper_vertical()
        self.whale = hp.whale_sticker(330)
        self.whale_small = hp.whale_sticker(170)
        chat = hp.annotate(hp.load_screen("02-chat.png"), [
            ((70, 640, 710, 820), (43, 105, 255, 210), 6),
        ])
        chat_bg = hp.annotate(hp.load_screen("02-chat.png"), [
            ((30, 1410, 750, 1625), (43, 105, 255, 210), 6),
        ])
        quick = hp.load_screen("03-quick-actions.png")
        self.phone_chat = hp.phone_sticker(chat, 1050)
        self.phone_chat_bg = hp.phone_sticker(chat_bg, 980)
        self.phone_quick = hp.phone_sticker(quick, 1050)
        self.phone_connect = hp.phone_sticker(hp.load_screen("04-connect.png"), 1000)
        self.phone_sessions = hp.phone_sticker(hp.load_screen("01-sessions.png"), 840)
        self.phone_settings = hp.phone_sticker(hp.load_screen("05-settings.png"), 840)
        self.tape = hp.make_tape(230, 50)
        self.tape_small = hp.make_tape(145, 38, alpha=135)
        self.title_intro = hp.text_sticker(["把 AI", "装进口袋"], hp.F(FONT_ST, 112), INK,
                                           spacing=10, border=13, underline=1)
        self.title_chat = hp.text_sticker(["会想，", "也会动手"], hp.F(FONT_ST, 104), INK,
                                          spacing=6, border=12, underline=1)
        self.title_quick = hp.text_sticker(["计划 · 权限 · 目标"], hp.F(FONT_ST, 82), INK, border=11)
        self.title_connect = hp.text_sticker(["手机一贴", "就连上电脑"], hp.F(FONT_ST, 98), INK,
                                             spacing=6, border=12)
        self.title_bg = hp.text_sticker(["后台继续跑"], hp.F(FONT_ST, 100), INK, border=12)
        self.title_local = hp.text_sticker(["都在你的", "设备上"], hp.F(FONT_ST, 96), INK,
                                           spacing=6, border=12)
        self.sub_intro = hp.label_sticker("DeepSeek Harness · Android", hp.F(FONT_COMIC, 30), INK,
                                          padding=(22, 11), angle=-2)
        self.note_chat = hp.label_sticker("工具调用 · 一行一行看得见", hp.F(FONT_KI, 36), INK,
                                          padding=(22, 11), angle=-2)
        self.note_quick = hp.label_sticker("都贴在同一个浮窗里", hp.F(FONT_KI, 36), INK,
                                           padding=(22, 11), angle=2)
        self.note_connect = hp.label_sticker("同一会话 · 模型 / 任务 / 文件", hp.F(FONT_KI, 32), INK,
                                             padding=(20, 10), angle=-2)
        self.note_bg = hp.label_sticker("完成后，它自己接着干", hp.F(FONT_KI, 34), INK,
                                        padding=(20, 10), angle=-2)
        self.bubble = hp.label_sticker("今天也替你干活！", hp.F(FONT_KI, 34), INK, padding=(22, 12), angle=4)
        self.pill_plan = hp.label_sticker("计划模式", hp.F(FONT_BD, 26), INK, bg=(236, 240, 255, 245))
        self.pill_goal = hp.label_sticker("目标模式", hp.F(FONT_BD, 26), INK, bg=(255, 243, 220, 245))
        self.pill_perm = hp.label_sticker("默认权限", hp.F(FONT_BD, 26), INK, bg=(232, 255, 240, 245))
        self.pill_mem = hp.label_sticker("会话记忆", hp.F(FONT_BD, 26), INK, bg=(236, 240, 255, 245))
        self.pill_persona = hp.label_sticker("角色设定", hp.F(FONT_BD, 26), INK, bg=(255, 236, 244, 245))
        self.pill_secure = hp.label_sticker("端到端加密", hp.F(FONT_BD, 26), INK, bg=(232, 255, 240, 245))
        self.tag_version = hp.label_sticker("rc.176 · Android · 开源", hp.F(FONT_BD, 24), INK,
                                            bg=(255, 255, 255, 230))
        self.btn_github = hp.label_sticker("GitHub Releases 免费下载", hp.F(FONT_BD, 28),
                                           (255, 255, 255, 255), bg=(43, 105, 255, 255))
        self.qr = hp.make_qr("https://github.com/xiaobaga281/dsh-mobile/releases/latest", 320)
        self.qr_label = hp.label_sticker("扫码下载", hp.F(FONT_KI, 30), INK, padding=(18, 9))
        self.laptop = hp.draw_laptop(380, 264)
        self.lock = hp.draw_lock(120)
        self.bell = hp.draw_bell(66)
        self.queue = [
            hp.draw_queue_card(275, 68, "排队中", YELLOW),
            hp.draw_queue_card(275, 68, "生成中", BLUE),
            hp.draw_queue_card(275, 68, "已完成", GREEN),
        ]


# ---------------- 竖屏场景 ----------------
def v_intro(c, a, t, dur):
    for i, (x, y, s, col) in enumerate([(120, 330, 13, BLUE), (960, 300, 11, RED),
                                        (930, 1320, 12, GREEN), (140, 1450, 10, YELLOW)]):
        hp.sparkle(c, x + hp.floaty(t, 6, 0.7, i), y, s, col, 120, 3)
    p, al = hp.pop(t, 0.35, 0.55)
    hp.paste(c, a.title_intro, (520, 610 + hp.floaty(t, 6, 0.8)), angle=-3, scale=p, alpha=al)
    hp.paste(c, a.tape, (520, 815), angle=-5, scale=0.85, alpha=al * 0.9)
    p2, al2 = hp.pop(t, 0.8, 0.5)
    hp.paste(c, a.sub_intro, (520, 865), angle=-2, scale=p2, alpha=al2)
    p3, al3 = hp.pop(t, 0.55, 0.6)
    hp.paste(c, a.whale, (760, 1210 + hp.floaty(t, 10, 0.9)), angle=5, scale=p3, alpha=al3)
    p4, al4 = hp.pop(t, 1.2, 0.45)
    hp.paste(c, a.bubble, (540, 1490), angle=3, scale=p4, alpha=al4)
    hp.doodle_arrow(c, [(790, 810), (700, 960), (650, 1050)], (43, 105, 255, 210), 5,
                    hp.clamp((t - 0.7) / 0.5))


def v_chat(c, a, t, dur):
    slide = hp.ease_out_cubic(hp.clamp((t - 0.05) / 0.55))
    x = 540 + (1 - slide) * 180
    hp.paste(c, a.phone_chat, (x, 930 + hp.floaty(t, 4, 0.8)), angle=-2.5 + hp.floaty(t, 0.7, 0.6),
             scale=1.0, alpha=hp.clamp(t * 5))
    hp.paste(c, a.tape, (x - 80, 440), angle=-12, scale=0.9, alpha=hp.clamp((t - 0.35) * 4))
    p, al = hp.pop(t, 0.2, 0.55)
    hp.paste(c, a.title_chat, (540, 235), angle=-2, scale=p, alpha=al)
    p2, al2 = hp.pop(t, 0.65, 0.45)
    hp.paste(c, a.note_chat, (540, 1530 + hp.floaty(t, 3, 0.8)), angle=-2, scale=p2, alpha=al2)
    hp.doodle_circle(c, (540, 810), 205, 105, (43, 105, 255, 200), 5,
                     hp.clamp((t - 1.0) / 0.5), angle=-0.3)
    if t > 1.35:
        p3, al3 = hp.pop(t, 1.35, 0.4)
        hp.paste(c, hp.label_sticker("看得见", hp.F(FONT_KI, 30), BLUE, padding=(16, 8)),
                 (860, 690), angle=-6, scale=p3, alpha=al3)
    cp = hp.clamp((t - 1.15) / 0.7)
    cx = 900 + (660 - 900) * hp.ease_out_cubic(cp)
    cy = 1430 + (830 - 1430) * hp.ease_out_cubic(cp)
    if t > 1.0:
        hp.draw_cursor(c, (cx, cy), hp.clamp((t - 1.9) / 0.35))


def v_quick(c, a, t, dur):
    p, al = hp.pop(t, 0.1, 0.55)
    hp.paste(c, a.phone_quick, (540, 940 + hp.floaty(t, 4, 0.7)), angle=2 + hp.floaty(t, 0.7, 0.6),
             scale=p, alpha=al)
    hp.paste(c, a.tape, (540, 430), angle=9, scale=0.9, alpha=hp.clamp((t - 0.4) * 4))
    p1, a1 = hp.pop(t, 0.25, 0.55)
    hp.paste(c, a.title_quick, (540, 235), angle=-2, scale=p1, alpha=a1)
    p2, a2 = hp.pop(t, 0.6, 0.45)
    hp.paste(c, a.note_quick, (540, 1530 + hp.floaty(t, 3, 0.8)), angle=2, scale=p2, alpha=a2)
    for i, (img, pos, rot, st) in enumerate([
        (a.pill_plan, (165, 650), -4, 0.85),
        (a.pill_goal, (900, 560), 3, 1.05),
        (a.pill_perm, (170, 1250), -2, 1.25),
    ]):
        pp, aa = hp.pop(t, st, 0.4)
        hp.paste(c, img, (pos[0], pos[1] + hp.floaty(t, 4, 0.9, i)), angle=rot, scale=pp, alpha=aa)
    hp.doodle_circle(c, (540, 1300), 205, 64, (255, 86, 72, 200), 5,
                     hp.clamp((t - 1.35) / 0.5), angle=0.1)
    cp = hp.clamp((t - 1.5) / 0.6)
    cx = 930 + (650 - 930) * hp.ease_out_cubic(cp)
    cy = 1470 + (1300 - 1470) * hp.ease_out_cubic(cp)
    if t > 1.35:
        hp.draw_cursor(c, (cx, cy), hp.clamp((t - 2.15) / 0.35))


def v_connect(c, a, t, dur):
    p, al = hp.pop(t, 0.1, 0.5)
    hp.paste(c, a.phone_connect, (350, 930 + hp.floaty(t, 4, 0.8)), angle=-3, scale=p, alpha=al)
    p2, al2 = hp.pop(t, 0.45, 0.55)
    hp.paste(c, a.laptop, (790, 1370 + hp.floaty(t, 5, 0.7)), angle=2, scale=p2, alpha=al2)
    hp.doodle_arrow(c, [(640, 1030), (720, 1010), (760, 1060)], (43, 105, 255, 220), 5,
                    hp.clamp((t - 0.7) / 0.5))
    if t > 1.0:
        for k in range(3):
            pos = ((t * 0.55 + k / 3) % 1.0)
            hp.ImageDraw.Draw(c).ellipse((640 + 120 * pos - 5, 1000 - math.sin(pos * math.pi) * 20 - 5,
                                          640 + 120 * pos + 5, 1000 - math.sin(pos * math.pi) * 20 + 5),
                                          fill=(43, 105, 255, 220))
    p3, al3 = hp.pop(t, 0.2, 0.5)
    hp.paste(c, a.title_connect, (540, 235), angle=-2, scale=p3, alpha=al3)
    p4, al4 = hp.pop(t, 1.1, 0.45)
    hp.paste(c, a.note_connect, (540, 1550), angle=-2, scale=p4, alpha=al4)


def v_bg(c, a, t, dur):
    p, al = hp.pop(t, 0.1, 0.5)
    hp.paste(c, a.phone_chat_bg, (650, 1000 + hp.floaty(t, 4, 0.7)), angle=2, scale=p, alpha=al)
    clock = hp.draw_clock(250, max(0, t - 0.5))
    p2, al2 = hp.pop(t, 0.35, 0.5)
    hp.paste(c, clock, (220, 720 + hp.floaty(t, 6, 0.8)), angle=-4, scale=p2 * 0.92, alpha=al2)
    p3, al3 = hp.pop(t, 0.2, 0.5)
    hp.paste(c, a.title_bg, (540, 235), angle=-2, scale=p3, alpha=al3)
    p4, al4 = hp.pop(t, 1.25, 0.4)
    hp.paste(c, a.bell, (330, 400), angle=-8, scale=p4, alpha=al4)
    hp.paste(c, hp.label_sticker("后台任务完成", hp.F(FONT_BD, 27), INK, bg=(255, 250, 235, 245)),
             (555, 405), angle=-2, scale=p4, alpha=al4)
    for i, card in enumerate(a.queue):
        pp, aa = hp.pop(t, 0.9 + i * 0.18, 0.4)
        hp.paste(c, card, (275, 1500 - i * 70 + hp.floaty(t, 3, 0.8, i)),
                 angle=-4 + i * 3, scale=pp, alpha=aa)
    hp.paste(c, a.note_bg, (650, 1585), angle=-2, scale=p4, alpha=al4)
    hp.doodle_arrow(c, [(350, 760), (470, 820), (520, 900)], (43, 105, 255, 220), 5,
                    hp.clamp((t - 1.0) / 0.5))


def v_local(c, a, t, dur):
    p1, a1 = hp.pop(t, 0.1, 0.55)
    hp.paste(c, a.phone_sessions, (250, 1080 + hp.floaty(t, 3, 0.7)), angle=-4, scale=p1, alpha=a1)
    p2, a2 = hp.pop(t, 0.3, 0.55)
    hp.paste(c, a.phone_settings, (710, 1080 + hp.floaty(t, 3, 0.8)), angle=4, scale=p2, alpha=a2)
    hp.paste(c, a.tape_small, (290, 750), angle=-12, scale=0.9, alpha=hp.clamp((t - 0.5) * 4))
    hp.paste(c, a.tape_small, (750, 750), angle=10, scale=0.9, alpha=hp.clamp((t - 0.6) * 4))
    p3, a3 = hp.pop(t, 0.2, 0.5)
    hp.paste(c, a.title_local, (540, 260), angle=-2, scale=p3, alpha=a3)
    p4, a4 = hp.pop(t, 0.9, 0.45)
    hp.paste(c, a.lock, (930, 520 + hp.floaty(t, 5, 0.9)), angle=5, scale=p4, alpha=a4)
    for i, (img, pos, st) in enumerate([
        (a.pill_mem, (155, 1580), 0.8),
        (a.pill_persona, (500, 1600), 1.0),
        (a.pill_secure, (840, 1580), 1.2),
    ]):
        pp, aa = hp.pop(t, st, 0.4)
        hp.paste(c, img, (pos[0], pos[1] + hp.floaty(t, 3, 0.9, i)), angle=-2 + i * 2, scale=pp, alpha=aa)


def v_outro(c, a, t, dur):
    if t > 0.5:
        rng = random.Random(5)
        d = ImageDraw.Draw(c)
        for i in range(30):
            ang = rng.random() * math.tau
            rr = 300 + rng.random() * 260
            x = 540 + math.cos(ang) * rr * (0.6 + 0.4 * rng.random())
            y = 1000 + math.sin(ang) * rr * 0.55
            prog = hp.clamp((t - 0.5) / 1.2)
            x = x + (x - 540) * prog * 0.4
            y = y + (y - 1000) * prog * 0.4
            col = [BLUE, RED, GREEN, YELLOW][i % 4]
            sz = 7 + rng.random() * 9
            d.rectangle((x, y, x + sz, y + sz), fill=col + (150,))
    p1, a1 = hp.pop(t, 0.15, 0.55)
    hp.paste(c, a.whale, (195, 620 + hp.floaty(t, 7, 0.8)), angle=-3, scale=0.79, alpha=a1)
    p2, a2 = hp.pop(t, 0.3, 0.55)
    hp.paste(c, hp.text_sticker(["DSH Mobile"], hp.F(FONT_COMIC, 88), INK, border=13),
             (650, 500), angle=-2, scale=p2, alpha=a2)
    p3, a3 = hp.pop(t, 0.55, 0.45)
    hp.paste(c, hp.label_sticker("装进口袋的 DeepSeek Harness", hp.F(FONT_KI, 34), INK,
                                 padding=(22, 12)), (650, 655), angle=-1, scale=p3, alpha=a3)
    p4, a4 = hp.pop(t, 0.75, 0.4)
    hp.paste(c, a.tag_version, (620, 735), angle=1, scale=p4, alpha=a4)
    p5, a5 = hp.pop(t, 1.15, 0.4)
    hp.paste(c, a.btn_github, (540, 1045), angle=-2, scale=p5, alpha=a5)
    p6, a6 = hp.pop(t, 0.95, 0.45)
    hp.paste(c, a.qr, (540, 1310), angle=2, scale=p6, alpha=a6)
    hp.paste(c, a.qr_label, (540, 1535), angle=-2, scale=p6, alpha=a6)


def vchapter(text: str) -> Image.Image:
    return hp.chapter_tab(text)


def vsubtitle(text: str) -> Image.Image:
    return hp.label_sticker(text, hp.F(FONT_BD, 30), INK, bg=(255, 255, 255, 235),
                            padding=(28, 13), border=8)


def render_frame(t, a, starts, durs, chapters, subs):
    img = a.paper.copy()
    idx = 0
    for i, st in enumerate(starts):
        if t >= st:
            idx = i
    local = t - starts[idx]
    fn = [v_intro, v_chat, v_quick, v_connect, v_bg, v_local, v_outro][idx]
    fn(img, a, local, durs[idx])
    pp, aa = hp.pop(local, 0.05, 0.4)
    hp.paste(img, chapters[idx], (205, 130), angle=-2, scale=pp, alpha=aa)
    sa = hp.clamp(local / 0.3) * hp.clamp((durs[idx] - local) / 0.3)
    if sa > 0:
        hp.paste(img, subs[idx], (540, 1695), angle=0, alpha=sa * 0.96)
    for st in starts[1:]:
        d = t - st
        if abs(d) < 0.20:
            k = (1 - abs(d) / 0.20) ** 2
            img.alpha_composite(Image.new("RGBA", (W, H), (246, 241, 231, int(235 * k))))
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stills", action="store_true")
    ap.add_argument("--render", action="store_true")
    args = ap.parse_args()
    a = VAssets()
    chapters = [vchapter(ch) for ch in hp.CHAPTERS]
    subs = [vsubtitle(line[1]) for line in hp.VO_LINES]
    vo_paths, starts, durs, total = hp.build_timeline()
    print("timeline", [round(x, 2) for x in starts], "total", round(total, 2))
    still_dir = OUT / "stills-vertical"
    if args.stills or not args.render:
        still_dir.mkdir(parents=True, exist_ok=True)
        for i, st in enumerate(starts):
            t = st + min(2.0, durs[i] * 0.55)
            img = render_frame(t, a, starts, durs, chapters, subs)
            img.convert("RGB").save(still_dir / f"v{i+1}.jpg", quality=92)
            print("still", i + 1, f"{t:.1f}s")
    if args.render:
        audio = hp.build_audio(starts, durs, total, vo_paths)
        out = OUT / "dsh-mobile-promo-rc176-douyin.mp4"
        cmd = [
            hp.FFMPEG, "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
            "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
            "-i", str(audio),
            "-c:v", "libx264", "-preset", "medium", "-crf", "20",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            "-c:a", "aac", "-b:a", "192k", "-shortest", str(out),
        ]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        frames = int(total * FPS)
        for i in range(frames):
            t = i / FPS
            img = render_frame(t, a, starts, durs, chapters, subs)
            proc.stdin.write(img.convert("RGB").tobytes())
            if i % 60 == 0:
                print(f"frame {i}/{frames} ({t:.1f}s)", flush=True)
        proc.stdin.close()
        proc.wait()
        print("wrote", out, out.stat().st_size if out.exists() else "FAILED")


if __name__ == "__main__":
    main()
