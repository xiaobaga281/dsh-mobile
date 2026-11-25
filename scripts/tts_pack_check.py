#!/usr/bin/env python3
"""验收一个 TTS 模型包能否直接接进本项目（sherpa-onnx 格式）。

你自己找来音色后跑这个，一眼就知道能不能用、缺什么：

  python scripts/tts_pack_check.py --dir D:/tmp/vits-zh-hf-xxx
  python scripts/tts_pack_check.py --dir D:/tmp/pack --model my.onnx

检查项：
  1. 找到 .onnx 并读 metadata（model_type / language / n_speakers / sample_rate）
  2. lexicon.txt + tokens.txt 是否齐全、能否被 sherpa-onnx 解析
  3. 真跑一次合成（"你好，我是你的助手。"），报采样率、说话人数、时长、RTF
  4. 逐档量基频（带八度校正），判断男女、给出档位建议
  5. 给结论：可直接用 / 需要转换 / 不建议

依赖：pip install onnx sherpa-onnx numpy
"""
from __future__ import annotations

import argparse
import glob
import os
import sys
import time

import numpy as np
import onnx
import sherpa_onnx

# 本项目 TTS 资产目录需要的最小文件集（见 voice/TtsAssets.kt）
REQUIRED = ["lexicon.txt", "tokens.txt"]


def pick_model(d: str, explicit: str | None) -> str:
    if explicit:
        p = explicit if os.path.isabs(explicit) else os.path.join(d, explicit)
        if not os.path.exists(p):
            sys.exit(f"指定的模型不存在：{p}")
        return p
    cands = sorted(glob.glob(os.path.join(d, "*.onnx")))
    if not cands:
        sys.exit(f"{d} 里没有 .onnx 文件")
    if len(cands) > 1:
        print(f"  目录里有 {len(cands)} 个 onnx，用第一个：{os.path.basename(cands[0])}")
        print("  （如果有多个，用 --model 指定）")
    return cands[0]


def read_meta(p: str) -> dict:
    m = onnx.load(p, load_external_data=False)
    meta = {x.key: x.value for x in m.metadata_props}
    print(f"  文件：{os.path.basename(p)}  {os.path.getsize(p) / 1e6:.1f} MB")
    if meta:
        for k in ("model_type", "language", "n_speakers", "sample_rate", "comment", "jieba"):
            if k in meta:
                print(f"    {k:12s} = {meta[k]}")
    else:
        print("    metadata 为空（不是 sherpa-onnx 转换的模型，风险较高）")
    print("  输入：")
    for i in m.graph.input:
        dims = [x.dim_value if x.dim_value else (x.dim_param or "?") for x in i.type.tensor_type.shape.dim]
        print(f"    {i.name:16s} {dims}")
    return meta


def f0_median(x: np.ndarray, sr: int) -> float:
    """自相关估基频 + 八度校正。不做校正会把女声算低一个八度（踩过）。"""
    x = np.asarray(x, dtype=np.float32)
    if x.size == 0:
        return 0.0
    x = x - x.mean()
    fr, hop = int(sr * 0.04), int(sr * 0.02)
    lo, hi = int(sr / 400), int(sr / 60)
    vals, rms_all = [], float(np.sqrt(np.mean(x ** 2)) + 1e-9)
    for i in range(0, len(x) - fr, hop):
        s = x[i:i + fr]
        if float(np.sqrt(np.mean(s ** 2))) < rms_all * 0.35:
            continue
        s = s - s.mean()
        ac = np.correlate(s, s, mode="full")[fr - 1:]
        if ac[0] <= 1e-9:
            continue
        ac = ac / ac[0]
        w = ac[lo:hi]
        if w.size == 0:
            continue
        k = int(np.argmax(w)) + lo
        if ac[k] <= 0.35:
            continue
        half = max(1, k // 2)
        if half >= lo and ac[half] > 0.75 * ac[k]:
            k = half
        vals.append(sr / k)
    return float(np.median(vals)) if vals else 0.0


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="模型解包后的目录")
    ap.add_argument("--model", default=None, help="onnx 文件名（目录里有多个时需要）")
    ap.add_argument("--text", default="你好，我是你的助手。")
    a = ap.parse_args()

    d = a.dir.rstrip("/\\")
    print(f"== 检查 {d}")
    model = pick_model(d, a.model)
    meta = read_meta(model)

    missing = [f for f in REQUIRED if not os.path.exists(os.path.join(d, f))]
    for f in REQUIRED:
        p = os.path.join(d, f)
        if os.path.exists(p):
            print(f"    {f:14s} {os.path.getsize(p):>9} 字节")
    if missing:
        print(f"\n[✗] 缺文件：{', '.join(missing)} —— sherpa-onnx 的 VITS 必须同时给 lexicon 和 tokens")
        print("    如果你拿到的是 GPT-SoVITS / Bert-VITS2 / Fish-Speech 等格式，不能直接用，需要转换")
        sys.exit(1)

    print("\n== 尝试加载并合成")
    try:
        tts = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(
                vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                    model=model,
                    lexicon=os.path.join(d, "lexicon.txt"),
                    tokens=os.path.join(d, "tokens.txt"),
                    dict_dir=os.path.join(d, "dict") if os.path.isdir(os.path.join(d, "dict")) else "",
                ),
                num_threads=4, provider="cpu"),
            max_num_sentences=1))
    except Exception as e:
        print(f"[✗] 加载失败：{type(e).__name__}: {e}")
        print("    常见原因：不是 VITS 架构（本项目目前只接了 VITS）、onnx 与 lexicon 不配套")
        sys.exit(1)

    sr, n = tts.sample_rate, tts.num_speakers
    print(f"    采样率 {sr}Hz / 说话人 {n}")
    if sr not in (16000, 22050, 24000, 44100):
        print(f"    [!] 采样率 {sr} 不常见，播放链路需要确认")

    print(f"\n== 逐档试合成（最多 8 档）：{a.text}")
    rows = []
    for sid in range(min(n, 8)):
        t0 = time.time()
        audio = tts.generate(a.text, sid=sid, speed=1.0)
        el = time.time() - t0
        s = np.asarray(audio.samples, dtype=np.float32)
        dur = len(s) / sr
        f0 = f0_median(s, sr)
        rtf = el / dur if dur else 0
        gender = "偏男" if f0 < 165 else "偏女"
        rows.append((sid, f0, dur, rtf))
        print(f"    sid {sid:3d}  f0 {f0:5.0f}Hz  {gender}  {dur:.2f}s  RTF {rtf:.2f}x")

    if n > 8:
        print(f"    ...（共 {n} 档，只试了前 8 档；全量扫用 scripts/tts_voice_probe.py）")

    male = [r for r in rows if r[1] < 165]
    print("\n== 结论")
    if not rows:
        print("[✗] 一档都没合成出来")
        sys.exit(1)
    print(f"[✓] 可直接用：sherpa-onnx VITS 中文模型，{n} 档，{sr}Hz")
    if male:
        print(f"    发现 {len(male)} 个偏男档（f0<165Hz）：sid {[r[0] for r in male]}")
    else:
        print("    前 8 档全为女声（要男声请看全部档位，或换模型）")
    print("\n接入步骤：")
    print("  1. python scripts/tts_quantize.py --model-dir <dir> --model-file <onnx> \\")
    print("         --keep <sid,sid,...> --out app/src/main/assets/tts-neural/model.onnx")
    print("  2. 把 lexicon.txt / tokens.txt / *.fst 复制到同目录")
    print("  3. 改 voice/TtsVoiceTable.kt 四行 + voice/TtsAssets.kt 的字节数（脚本会打印）")


if __name__ == "__main__":
    main()
