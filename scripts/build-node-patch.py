#!/usr/bin/env python3
"""
生成 libdshnode.so —— 把 proot guest 的 node 从 20 升到 22 LTS 的增量补丁。

为什么用 unofficial-builds 的 musl 构建：
  rootfs 是 Alpine（musl），nodejs.org 官方 linux-x64/arm64 二进制是 **glibc**，
  直接塞进去会报 "No such file or directory"（缺 ld-linux）。Alpine 自带 nodejs 包
  又依赖一整套 libuv/libicu/libbrotli/libcares/nghttp2 等系统库，升级 node 就得
  连带换库，等于重建 100MB+ 的主载荷（设备端 apk 安装 → tar → pull → pack 全链）。
  unofficial-builds 的 *-musl 构建把那些库**静态编进 node 自身**，DT_NEEDED 只剩
  ld-musl-<arch>.so.1 与 libgcc_s.so.1 —— 这两个基础 rootfs 里已经存在。

为什么做成增量补丁：
  主载荷重建成本极高；补丁只增不改，旧安装覆盖 APK 后也直接受益（与 git/npm 同款）。

为什么只取 bin/node：
  官方 tar 里自带 npm/corepack/npx + lib/node_modules，但本项目的 npm 由
  libdshnpm.so 增量补丁提供，两份混在一起会互相覆盖。只取 node 二进制即可；
  它的 shebang 链 `#!/usr/bin/env node` 会走 PATH 命中新 node。

用法：
  python scripts/build-node-patch.py                  # 自动下载两个 ABI 的 tar.xz 并生成
  python scripts/build-node-patch.py --check         # 只校验现有产物

产物：app/src/complete/jniLibs/{arm64-v8a,x86_64}/libdshnode.so
      xz tar（busybox `tar -xJf` 解包），成员 ./usr/bin/node.dsh22
"""
from __future__ import annotations

import argparse
import hashlib
import io
import pathlib
import struct
import tarfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = ROOT / ".motion/runtimes/node22"
VERSION = "v22.23.4"
MIRROR = f"https://unofficial-builds.nodejs.org/download/release/{VERSION}"
# (上游 tar 的 ABI 名, 本地 jniLibs 目录, ELF e_machine)
ABIS = [("x64", "x86_64", 62), ("arm64", "arm64-v8a", 183)]
OUT_NAME = "libdshnode.so"
MEMBER = "./usr/bin/node.dsh22"


def fetch(abi: str) -> pathlib.Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / f"node-{VERSION}-linux-{abi}-musl.tar.xz"
    if f.is_file() and f.stat().st_size > 0:
        return f
    url = f"{MIRROR}/{f.name}"
    print(f"下载 {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "dsh-mobile-build/1.0"})
    with urllib.request.urlopen(req, timeout=600) as r:
        f.write_bytes(r.read())
    print(f"  {f.stat().st_size} 字节")
    return f


def elf_machine(b: bytes) -> int:
    if b[:4] != b"\x7fELF":
        raise SystemExit("node 不是 ELF")
    # ELF64 小端：e_machine 在偏移 18，2 字节
    return struct.unpack_from("<H", b, 18)[0]


def build(tar_path: pathlib.Path, abi_out: str, machine: int) -> bytes:
    with tarfile.open(tar_path, "r:xz") as src:
        names = src.getnames()
        node = next((n for n in names if n.endswith("/bin/node")), None)
        if node is None:
            raise SystemExit(f"{tar_path.name} 里没有 bin/node")
        data = src.extractfile(node).read()
        mode = src.getmember(node).mode

    if elf_machine(data) != machine:
        raise SystemExit(f"{tar_path.name} 的 ELF 架构 {elf_machine(data)} != 期望 {machine}")
    if VERSION.encode() not in data:
        raise SystemExit(f"{tar_path.name} 里找不到版本串 {VERSION}（拿错包了？）")

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:xz", preset=6) as out:
        m = tarfile.TarInfo(MEMBER)
        m.size = len(data)
        m.mode = mode | 0o111
        m.uid = m.gid = 0
        m.uname = m.gname = "root"
        m.mtime = 0
        out.addfile(m, io.BytesIO(data))
    return buf.getvalue()


def verify(path: pathlib.Path, machine: int) -> None:
    with tarfile.open(path, "r:xz") as t:
        m = t.getmember(MEMBER)
        data = t.extractfile(m).read()
        if elf_machine(data) != machine:
            raise SystemExit(f"{path} 架构不符")
        if VERSION.encode() not in data:
            raise SystemExit(f"{path} 版本串不符")
    print(f"  ✓ {path.relative_to(ROOT)} ({path.stat().st_size} 字节, "
          f"sha256 {hashlib.sha256(path.read_bytes()).hexdigest()[:12]})")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只校验现有产物")
    args = ap.parse_args()

    for abi, out_dir, machine in ABIS:
        path = ROOT / "app/src/complete/jniLibs" / out_dir / OUT_NAME
        if args.check:
            if not path.is_file():
                raise SystemExit(f"缺少产物 {path}")
            verify(path, machine)
            continue
        payload = build(fetch(abi), out_dir, machine)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
        print(f"{out_dir}: {len(payload)} 字节，node 版本 {VERSION}")
        verify(path, machine)
    print("完成。" if not args.check else "node 补丁校验通过")


if __name__ == "__main__":
    main()
