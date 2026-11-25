#!/usr/bin/env python3
"""把内置 VITS 语音包裁到指定音色 + int8 静态量化。

为什么需要这个脚本：模型体积跟「留几个音色」几乎无关 —— 说话人表 `emb_g.weight`
只有 5KB（0.004%），121MB 全在声学网络（189 个 Conv + decoder 的 ConvTranspose）。
要把 APK 压下来只能动精度，不能只动音色数量。

实测（桌面 x86-64，4 线程）：
  fp32 121MB   RTF 0.26x
  int8  33MB   RTF 0.11x   ← 走 MLAS int8 kernel，反而快 2.3 倍
  五档基频偏差 ≤6Hz；与 fp32 的频谱 L1 距离 0.59–0.64，
  而 fp32 自己跑两次的距离就有 0.59–0.69 —— 差异落在模型自身的随机噪声里。

依赖：pip install onnx onnxruntime numpy sherpa-onnx
用法：
  # 只量化（保留模型里全部说话人）
  python scripts/tts_quantize.py --model-dir /tmp/vits-zh-hf-fanchen-C \
      --model-file vits-zh-hf-fanchen-C.onnx --out .tmp/model-int8.onnx

  # 先裁到 5 档再量化（KEEP 是原模型里的 sid）
  python scripts/tts_quantize.py --model-dir /tmp/vits-zh-hf-fanchen-C \
      --model-file vits-zh-hf-fanchen-C.onnx --keep 69,30,102,43,13 \
      --out app/src/main/assets/tts-neural/model.onnx
"""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np
import onnx
from onnx import numpy_helper
from onnxruntime.quantization import (
    CalibrationDataReader,
    QuantFormat,
    QuantType,
    quantize_static,
)

# 只量化计算大头的算子：Conv/ConvTranspose 是 VITS 的体积与耗时来源。
# 不去碰 Gather/Shape/Slice 这些控制流，量化它们只增节点不省体积。
QUANT_OPS = ["Conv", "ConvTranspose", "MatMul", "Gemm"]


def trim_speakers(src: str, dst: str, keep: list[int]) -> None:
    """把 model.emb_g.weight 从 [N,256] 切到 [len(keep),256]，并同步 metadata 的 n_speakers。

    切了之后其余音色在模型里**物理不存在**，不是 UI 隐藏。
    """
    m = onnx.load(src, load_external_data=False)
    hit = False
    for init in m.graph.initializer:
        if init.name != "model.emb_g.weight":
            continue
        arr = numpy_helper.to_array(init)
        total = arr.shape[0]
        bad = [s for s in keep if s < 0 or s >= total]
        if bad:
            sys.exit(f"KEEP 里有越界 sid {bad}（模型只有 {total} 档）")
        new = arr[keep]
        init.CopyFrom(numpy_helper.from_array(new, init.name))
        hit = True
        print(f"  说话人表 {arr.shape} → {new.shape}")
    if not hit:
        sys.exit("模型里没有 model.emb_g.weight，不是多说话人 VITS？")
    for p in m.metadata_props:
        if p.key == "n_speakers":
            p.value = str(len(keep))
    onnx.save(m, dst)
    print(f"  裁剪完成 {os.path.getsize(dst) / 1e6:.1f} MB")


class RandomPhones(CalibrationDataReader):
    """校准集：随机 token 序列。

    为什么可以用随机 token：QDQ 校准只统计 Conv 激活值的范围，与语义无关；
    真正要覆盖的是「句子长度 × 音色」这两维，因为它们决定中间张量形状。
    """

    def __init__(self, n_tokens: int, n_speakers: int, samples: int, seed: int = 7):
        rng = np.random.default_rng(seed)
        self.items = []
        for i in range(samples):
            length = int(rng.integers(16, 140))
            self.items.append({
                "x": rng.integers(2, n_tokens, size=(1, length)).astype(np.int64),
                "x_length": np.array([length], dtype=np.int64),
                "noise_scale": np.array([0.667], dtype=np.float32),
                "length_scale": np.array([1.0], dtype=np.float32),
                "noise_scale_w": np.array([0.8], dtype=np.float32),
                "sid": np.array([i % n_speakers], dtype=np.int64),
            })
        self.i = 0

    def get_next(self):
        if self.i >= len(self.items):
            return None
        self.i += 1
        return self.items[self.i - 1]

    def rewind(self):
        self.i = 0


def quantize(src: str, dst: str, tokens_file: str, samples: int) -> None:
    n_tokens = sum(1 for _ in open(tokens_file, encoding="utf-8"))
    m = onnx.load(src, load_external_data=False)
    n_speakers = 1
    for p in m.metadata_props:
        if p.key == "n_speakers":
            n_speakers = int(p.value)
    print(f"  词表 {n_tokens} / 音色 {n_speakers} / 校准 {samples} 组")
    quantize_static(
        src, dst, RandomPhones(n_tokens, n_speakers, samples),
        quant_format=QuantFormat.QDQ,
        per_channel=True,
        weight_type=QuantType.QInt8,
        activation_type=QuantType.QUInt8,
        op_types_to_quantize=QUANT_OPS,
    )
    print(f"  量化完成 {os.path.getsize(dst) / 1e6:.1f} MB")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", required=True, help="解包后的模型目录（含 lexicon/tokens）")
    ap.add_argument("--model-file", required=True, help="目录内的 onnx 文件名")
    ap.add_argument("--out", required=True, help="输出 onnx 路径")
    ap.add_argument("--keep", default="", help="要保留的 sid，逗号分隔；留空=不裁剪")
    ap.add_argument("--samples", type=int, default=40, help="校准样本数")
    a = ap.parse_args()

    src = os.path.join(a.model_dir, a.model_file)
    tokens = os.path.join(a.model_dir, "tokens.txt")
    for p in (src, tokens):
        if not os.path.exists(p):
            sys.exit(f"缺少 {p}")

    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)

    step1 = a.out
    if a.keep.strip():
        keep = [int(s) for s in a.keep.split(",") if s.strip()]
        step1 = a.out + ".trim.onnx"
        print("[1/2] 裁说话人")
        trim_speakers(src, step1, keep)
    else:
        print("[1/2] 跳过裁剪")
        step1 = src

    print("[2/2] int8 静态量化（QDQ）")
    quantize(step1, a.out, tokens, a.samples)
    if step1 != src and step1 != a.out:
        os.remove(step1)

    size = os.path.getsize(a.out)
    print(f"\n完成：{a.out}  {size} 字节（{size / 1e6:.1f} MB）")
    print(f"记得同步 voice/TtsAssets.kt 里的 EXPECT[MODEL] = {size}_L")


if __name__ == "__main__":
    main()
