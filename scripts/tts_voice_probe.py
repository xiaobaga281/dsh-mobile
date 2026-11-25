"""内置 TTS 音色探针：把每个 speaker 真合成一遍，量「中位基频 + 频谱重心」，再按档位分桶。

为什么要在桌面跑而不是在手机上跑：选型要扫上百个说话人，手机上得一个个等模型加载、
走 JS 桥、落 WAV 再拉回来；桌面上 sherpa-onnx 的 Python 包直接推理，187 个音色几分钟跑完，
而且结果可复现（同一模型同一句话，任何人跑出来数字一致）。

用法：
  python scripts/tts_voice_probe.py --model-dir D:/tmp/vits-zh-hf-fanchen-C \
      --model-file vits-zh-hf-fanchen-C.onnx --out .tmp/voices.json
  python scripts/tts_voice_probe.py --model-dir ... --sids 0-186 --text "晚上好呀"

输出：
  - 每个 sid 的 f0 / 频谱重心 / 时长
  - 四档建议：霸总（最低最暗的男声）、奶狗（偏高的男声）、甜妹（最高最亮的女声）、
    御姐（中低女声）。分档只看客观量，最终仍以人耳确认。

依赖：pip install sherpa-onnx numpy
"""
import argparse
import json
import sys

import numpy as np
import sherpa_onnx


def f0_median(samples, sr):
    """自相关估基频：只看有声帧，返回中位数（Hz）。"""
    x = np.asarray(samples, dtype=np.float32)
    if x.size == 0:
        return 0.0
    x = x - x.mean()
    frame, hop = max(1, int(sr * 0.04)), max(1, int(sr * 0.02))
    lo, hi = int(sr / 400), int(sr / 60)  # 60–400Hz
    rms_all = float(np.sqrt(np.mean(x ** 2)) + 1e-9)
    vals = []
    for i in range(0, len(x) - frame, hop):
        seg = x[i:i + frame]
        if float(np.sqrt(np.mean(seg ** 2))) < rms_all * 0.35:
            continue  # 静音/轻辅音跳过
        seg = seg - seg.mean()
        ac = np.correlate(seg, seg, mode="full")[frame - 1:]
        if ac[0] <= 1e-9:
            continue
        ac /= ac[0]
        window = ac[lo:hi]
        if window.size == 0:
            continue
        k = int(np.argmax(window)) + lo
        if ac[k] > 0.35:  # 周期性够强才算有声
            vals.append(sr / k)
    return float(np.median(vals)) if vals else 0.0


def centroid(samples, sr):
    """频谱重心：越大越亮（"甜"与"御"的主要区别之一）。"""
    x = np.asarray(samples, dtype=np.float32)
    if x.size == 0:
        return 0.0
    spec = np.abs(np.fft.rfft(x * np.hanning(len(x))))
    freqs = np.fft.rfftfreq(len(x), 1 / sr)
    energy = spec ** 2
    return float((freqs * energy).sum() / max(energy.sum(), 1e-9))


def parse_sids(spec, total):
    if not spec:
        return list(range(total))
    out = []
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-")
            out.extend(range(max(0, int(a)), min(total - 1, int(b)) + 1))
        elif part:
            out.append(int(part))
    return [s for s in out if 0 <= s < total]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--model-file", required=True)
    ap.add_argument("--text", default="晚上好呀，今天过得怎么样？要不要一起聊两句？")
    ap.add_argument("--sids", default="", help="如 0-186 或 3,15,69；留空=全部")
    ap.add_argument("--rules", default="phone,date,number")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    d = args.model_dir.rstrip("/\\")
    rules = ",".join(f"{d}/{r.strip()}.fst" for r in args.rules.split(",") if r.strip())
    cfg = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                model=f"{d}/{args.model_file}",
                lexicon=f"{d}/lexicon.txt",
                tokens=f"{d}/tokens.txt",
                dict_dir=f"{d}/dict",
            ),
            num_threads=args.threads,
            debug=False,
            provider="cpu",
        ),
        rule_fsts=rules,
        max_num_sentences=1,
    )
    tts = sherpa_onnx.OfflineTts(cfg)
    print(f"model={args.model_file} sr={tts.sample_rate} speakers={tts.num_speakers}", flush=True)

    rows = []
    for sid in parse_sids(args.sids, tts.num_speakers):
        try:
            a = tts.generate(args.text, sid=sid, speed=1.0)
            rows.append({
                "sid": sid,
                "f0": round(f0_median(a.samples, a.sample_rate)),
                "centroid": round(centroid(a.samples, a.sample_rate)),
                "dur": round(len(a.samples) / a.sample_rate, 2),
            })
            r = rows[-1]
            print(f"sid={sid:4d} f0={r['f0']:4d} cent={r['centroid']:4d} dur={r['dur']:4.2f}", flush=True)
        except Exception as e:  # 单个 sid 失败不影响整轮
            print(f"sid={sid} 失败：{e}", file=sys.stderr, flush=True)

    ok = [r for r in rows if r["f0"] > 0]
    if not ok:
        print("没有任何可用结果", file=sys.stderr)
        return 1

    male = sorted([r for r in ok if r["f0"] < 165], key=lambda r: r["f0"])
    female = sorted([r for r in ok if r["f0"] >= 165], key=lambda r: r["f0"])
    bright_male = sorted([r for r in male if r["f0"] >= 150], key=lambda r: r["f0"])
    picks = {
        "bazong": male[0] if male else None,
        "naigou": bright_male[-1] if bright_male else (male[-1] if male else None),
        "tianmei": sorted(female, key=lambda r: r["f0"])[-1] if female else None,
        "yujie": female[0] if female else None,
    }
    print("\n建议四档（仍建议人耳复核）：")
    for k, v in picks.items():
        if v:
            print(f"  {k:8s} sid={v['sid']:3d} f0={v['f0']}Hz 亮度={v['centroid']}Hz")

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump({
                "model": args.model_file,
                "sample_rate": tts.sample_rate,
                "speakers": tts.num_speakers,
                "text": args.text,
                "rows": rows,
                "picks": picks,
            }, f, ensure_ascii=False, indent=2)
        print(f"\n已写入 {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
