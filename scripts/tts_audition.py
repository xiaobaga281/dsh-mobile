# 霸总候选试听:用 fp32 模型对候选 sid 各合成几句,落 WAV + 统计(峰值/RMS/台阶),供选型
import numpy as np
import sherpa_onnx
import wave, os, sys

D = "D:/tmp/voice/vits-zh-hf-fanchen-C"
MODEL = f"{D}/vits-zh-hf-fanchen-C.onnx"
OUT = "D:/tmp/voice/audition"
os.makedirs(OUT, exist_ok=True)

LINES = [
    "哦？这么晚了，还在等我？",
    "这件事，我说了算。",
    "晚上好呀，今天过得怎么样？要不要一起聊两句？",
]

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

def steps_ratio(x):
    # 量化台阶检测:相邻独特值的最大公差占比(语音应为连续谱,台阶则出现离散跳变)
    v = np.unique(np.round(np.asarray(x, dtype=np.float32) * 32767).astype(np.int32))
    dv = np.diff(v)
    small = dv[dv <= 120]
    return float(len(small) / max(1, len(dv) - 1))

for sid in [124, 119, 136, 69]:
    for i, text in enumerate(LINES):
        a = tts.generate(text, sid=sid, speed=1.0)
        x = np.asarray(a.samples, dtype=np.float32)
        name = f"{OUT}/sid{sid}_line{i}.wav"
        with wave.open(name, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(a.sample_rate)
            w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())
        peak = float(np.max(np.abs(x)))
        rms = float(np.sqrt(np.mean(x ** 2)))
        print(f"sid={sid} line{i} peak={peak:.3f} rms={rms:.3f} step-cont={steps_ratio(x):.2f} -> {name}", flush=True)
print("done")
