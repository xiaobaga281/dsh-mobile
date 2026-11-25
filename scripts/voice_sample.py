"""抓手机端真实合成的语音，量基频，并生成几个降调候选供人耳挑选。

用法（应用在前台、adb forward tcp:9223 已就绪）:
  python scripts/voice_sample.py --out D:/1/voice-samples
"""
import argparse
import base64
import json
import math
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Cdp  # noqa: E402

TEXT = "嗯，我在呢。今天过得怎么样？"


def read_wav(data):
    assert data[:4] == b"RIFF" and data[8:12] == b"WAVE", "not a wav"
    pos = 12
    fmt = None
    pcm = b""
    while pos + 8 <= len(data):
        cid = data[pos : pos + 4]
        size = struct.unpack("<I", data[pos + 4 : pos + 8])[0]
        body = data[pos + 8 : pos + 8 + size]
        if cid == b"fmt ":
            fmt = struct.unpack("<HHIIHH", body[:16])
        elif cid == b"data":
            pcm = body
        pos += 8 + size + (size & 1)
    # fmt 只有 6 个字段：(wFormatTag, channels, sampleRate, byteRate, blockAlign, bitsPerSample)
    # 下标 0..5。旧写法取了 fmt[6]（越界），任何真实 WAV 都会 IndexError —— 修掉。
    channels, rate, _byte_rate, _align, bits = fmt[1], fmt[2], fmt[3], fmt[4], fmt[5]
    assert bits == 16, f"expected 16-bit pcm, got {bits}"
    count = len(pcm) // 2
    samples = struct.unpack("<%dh" % count, pcm[: count * 2])
    if channels > 1:
        samples = samples[::channels]
    return list(samples), rate


def write_wav(path, samples, rate):
    pcm = struct.pack("<%dh" % len(samples), *[max(-32768, min(32767, int(s))) for s in samples])
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " + struct.pack(
        "<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16
    ) + b"data" + struct.pack("<I", len(pcm))
    with open(path, "wb") as f:
        f.write(header + pcm)


def median_f0(samples, rate):
    """自相关估基频：只统计有声帧，取中位数。"""
    win = int(rate * 0.04)
    hop = win // 2
    lo, hi = int(rate / 400), int(rate / 60)
    found = []
    for start in range(0, len(samples) - win, hop):
        frame = samples[start : start + win]
        energy = sum(s * s for s in frame) / win
        if energy < 3e6:  # 安静帧不参与
            continue
        mean = sum(frame) / win
        frame = [s - mean for s in frame]
        best_lag, best = 0, 0.0
        for lag in range(lo, min(hi, win - 1)):
            acc = 0.0
            for i in range(win - lag):
                acc += frame[i] * frame[i + lag]
            if acc > best:
                best, best_lag = acc, lag
        if best_lag:
            found.append(rate / best_lag)
    if not found:
        return 0.0
    found.sort()
    return found[len(found) // 2]


def resample(samples, ratio):
    """ratio < 1 → 更慢更低（时长变长）；用于试听降调候选。"""
    out = []
    n = len(samples)
    i = 0.0
    while i < n - 1:
        idx = int(i)
        frac = i - idx
        out.append(samples[idx] * (1 - frac) + samples[idx + 1] * frac)
        i += ratio
    return out


def synth(c, gender):
    c.eval(f"window.DSHNativeVoice.setVoiceGender({json.dumps(gender)}); 'ok'")
    raw = c.eval(f"window.DSHNativeVoice.synthVoice({json.dumps(TEXT)}, 1.0)")
    info = c.eval("JSON.stringify(window.DSHNativeVoice.voiceInfo())")
    payload = json.loads(raw) if isinstance(raw, str) else raw
    if not payload or not payload.get("ok"):
        raise SystemExit(f"synth failed for {gender}: {payload}")
    return payload, json.loads(info) if isinstance(info, str) else info


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="D:/1/voice-samples")
    ap.add_argument("--port", type=int, default=9223)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    c = Cdp(args.port)
    for gender in ("male", "female"):
        payload, info = synth(c, gender)
        wav = base64.b64decode(payload["dataUrl"].split(",", 1)[1])
        path = os.path.join(args.out, f"{gender}.wav")
        with open(path, "wb") as f:
            f.write(wav)
        samples, rate = read_wav(wav)
        f0 = median_f0(samples, rate)
        print(
            f"{gender}: {path}  voice={payload.get('voice')} engineGender={payload.get('voiceGender')} "
            f"fallback={payload.get('voiceFallback')} {rate}Hz {len(samples)/rate:.2f}s F0≈{f0:.0f}Hz "
            f"want/actual={info.get('want')}/{info.get('actual')}"
        )

    # 男声降调候选：只改基频，不动文本
    male_path = os.path.join(args.out, "male.wav")
    samples, rate = read_wav(open(male_path, "rb").read())
    for name, ratio in (("male-low-6pct", 0.94), ("male-low-12pct", 0.89), ("male-low-18pct", 0.84)):
        shifted = resample(samples, ratio)
        path = os.path.join(args.out, f"{name}.wav")
        write_wav(path, shifted, rate)
        print(f"{name}: {path}  F0≈{median_f0(shifted, rate):.0f}Hz")


if __name__ == "__main__":
    main()
