# 对任意 fanchen 系合集做「霸总筛选」:扫男声 → 能量/低频共鸣/谐波打分 → 出试听样本。
# 用法:
#   python scripts/tts_ceo_score.py --dir D:/tmp/voice/vits-zh-hf-fanchen-unity --tag unity
# 产出:D:/tmp/voice/audition-<tag>/ 下前 N 名的试听 WAV + ranking-<tag>.json
import argparse, json, math, os
import numpy as np
import sherpa_onnx
import wave

ap = argparse.ArgumentParser()
ap.add_argument("--dir", required=True)
ap.add_argument("--tag", required=True)
ap.add_argument("--top", type=int, default=6, help="出试听样本的候选数")
ap.add_argument("--max-f0", type=int, default=142, help="男声 f0 上限")
ap.add_argument("--lines", default="2", help="每个候选合成几句")
args = ap.parse_args()

D = args.dir.rstrip("/\\")
# 目录里只有一个 onnx
onnxes = [f for f in os.listdir(D) if f.endswith(".onnx")]
assert len(onnxes) == 1, f"目录里应有恰好一个 onnx: {onnxes}"
MODEL = f"{D}/{onnxes[0]}"
OUT = f"D:/tmp/voice/audition-{args.tag}"
os.makedirs(OUT, exist_ok=True)
NLINES = max(1, int(args.lines))

LINES = [
    "哦？这么晚了，还在等我？这件事，我说了算。",
    "很好。就按你说的办，天塌下来，我顶着。",
][:NLINES]

cfg = sherpa_onnx.OfflineTtsConfig(
    model=sherpa_onnx.OfflineTtsModelConfig(
        vits=sherpa_onnx.OfflineTtsVitsModelConfig(
            model=MODEL, lexicon=f"{D}/lexicon.txt", tokens=f"{D}/tokens.txt",
        ),
        num_threads=4, debug=False, provider="cpu",
    ),
    rule_fsts=",".join([f"{D}/phone.fst", f"{D}/date.fst", f"{D}/number.fst"]),
    max_num_sentences=1,
)
tts = sherpa_onnx.OfflineTts(cfg)
total = tts.num_speakers
print(f"model={onnxes[0]} sr={tts.sample_rate} speakers={total}", flush=True)

def f0_stats(x, sr):
    xx = x - x.mean()
    frame, hop = int(sr * 0.04), int(sr * 0.02)
    lo, hi = int(sr / 400), int(sr / 60)
    rms_all = float(np.sqrt(np.mean(xx ** 2)) + 1e-9)
    f0s, qual = [], []
    for i in range(0, len(xx) - frame, hop):
        seg = xx[i:i + frame]
        if float(np.sqrt(np.mean(seg ** 2))) < rms_all * 0.35:
            continue
        s = seg - seg.mean()
        ac = np.correlate(s, s, mode="full")[frame - 1:]
        if ac[0] <= 1e-9:
            continue
        ac /= ac[0]
        k = int(np.argmax(ac[lo:hi])) + lo
        if ac[k] > 0.35:
            f0s.append(sr / k)
            qual.append(float(ac[k]))
    if not f0s:
        return 0.0, 0.0, 0.0
    return float(np.median(f0s)), float(np.percentile(f0s, 90)), float(np.median(qual))

def lowband_ratio(x, sr):
    spec = np.abs(np.fft.rfft(x * np.hanning(len(x)))) ** 2
    freqs = np.fft.rfftfreq(len(x), 1 / sr)
    total_e = spec.sum() + 1e-12
    return float(spec[(freqs >= 100) & (freqs <= 500)].sum() / total_e)

# 一轮:只合成 line0,快速筛男声(f0 + 能量)
print("pass1: 扫描男声…", flush=True)
males = []
for sid in range(total):
    try:
        a = tts.generate(LINES[0], sid=sid, speed=1.0)
    except Exception as e:
        continue
    x = np.asarray(a.samples, dtype=np.float32)
    if x.size < a.sample_rate // 2:
        continue
    f0, f90, q = f0_stats(x, a.sample_rate)
    rms = float(np.sqrt(np.mean(x ** 2)))
    if 0 < f0 <= args.max_f0:
        males.append({"sid": sid, "f0": round(f0), "rms": round(rms, 4), "peak": round(float(np.max(np.abs(x))), 3), "hnr": round(q, 3)})
        print(f"  sid={sid:3d} f0={round(f0):3d} rms={rms:.4f}", flush=True)
print(f"男声候选 {len(males)} 个(f0≤{args.max_f0})", flush=True)

# 二轮:候选补 line1,测低频共鸣,打综合分
print("pass2: 打分…", flush=True)
for r in males:
    a = tts.generate(LINES[1] if NLINES > 1 else LINES[0], sid=r["sid"], speed=1.0)
    x = np.asarray(a.samples, dtype=np.float32)
    with wave.open(f"{OUT}/sid{r['sid']}_b.wav", "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(a.sample_rate)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())
    r["lowband"] = round(lowband_ratio(x, a.sample_rate), 3)

def score(r):
    e = math.log10(max(r["rms"], 1e-4))
    return round(e * 2 + r["lowband"] * 2 + r["hnr"] - max(0.0, (r["f0"] - 118)) / 10.0, 3)

for r in males:
    r["score"] = score(r)
males.sort(key=lambda r: -r["score"])
print("\n综合排序(前 12):")
for r in males[:12]:
    print(f"  sid={r['sid']:3d} score={r['score']:6.3f} f0={r['f0']:3d} rms={r['rms']:.4f} "
          f"低频比={r['lowband']:.3f} 谐波={r['hnr']:.3f}")

# 试听样本:前 top 名的 line0(a.wav)+ line1(b.wav)
print(f"\n出前 {args.top} 名试听…", flush=True)
for r in males[: args.top]:
    sid = r["sid"]
    for i, text in enumerate(LINES):
        a = tts.generate(text, sid=sid, speed=1.0)
        x = np.asarray(a.samples, dtype=np.float32)
        with wave.open(f"{OUT}/TOP{males[:args.top].index(r)+1}_sid{sid}_line{i}.wav", "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(a.sample_rate)
            w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())
    print(f"  TOP{males[:args.top].index(r)+1} sid={sid} f0={r['f0']} -> {OUT}")

json.dump(males, open(f"{OUT}/../ranking-{args.tag}.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"\n排名已写 {OUT}/../ranking-{args.tag}.json,试听 WAV 在 {OUT}")
