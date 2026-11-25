#!/usr/bin/env python3
"""
生成 libdshnpm.so —— 仿 libdshgit.so 的 rootfs 增量补丁（gzip tar 伪装成 .so）。

为什么是增量补丁而不是打进 rootfs 主载荷：
  主载荷是 100MB+ 的 xz，重建一次要重走设备端 apk 安装 → tar → pull → pack 全链；
  npm 包只有 ~8MB（未压缩），内容只增不改，做成增量载荷后旧安装也能直接受益。
  详见 .motion/harness-plan-ondevice.md M11（git 补丁同款理由）。

为什么仍是 libdshnpm.so 且按 ABI 放两份：
  jniLibs 里的 lib*.so 才会被 AGP 解压进 nativeLibraryDir（build.gradle.kts 的
  useLegacyPackaging + ABI splits）。npm 是**纯 JS、双 ABI 逐字节相同**，两份内容一样；
  这样放是为了与 libdshgit.so 完全共用一条装配链路，不为省 2MB 再引入第二条
  assets 落盘链。将来若要将多个纯 JS 补丁合并，再统一改成 assets 一份。

用法：
  python scripts/build-npm-patch.py                    # 自动下载 .apk 并生成
  python scripts/build-npm-patch.py --apk PATH        # 用本地 .apk 离线生成
  python scripts/build-npm-patch.py --check           # 只校验现有产物，不重新生成

输入：Alpine v3.20 community x86_64 的 npm-10.9.1-r0.apk（与主 rootfs 同版本）
输出：app/src/complete/jniLibs/{arm64-v8a,x86_64}/libdshnpm.so
      成员以 ./ 开头、相对 rootfs 根（解包用 busybox tar -xzf -C <rootfs>）
"""
from __future__ import annotations

import argparse
import hashlib
import io
import posixpath
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".motion/runtimes/npm-patch"
APK = CACHE / "npm.apk"
APK_URL = "https://dl-cdn.alpinelinux.org/alpine/v3.20/community/x86_64/npm-10.9.1-r0.apk"
OUT_DIRS = [
    ROOT / "app/src/complete/jniLibs/arm64-v8a",
    ROOT / "app/src/complete/jniLibs/x86_64",
]
OUT_NAME = "libdshnpm.so"

# npm 入口是相对 symlink，目标必须一起进包，否则宿主侧 File.exists() 会断链
REQUIRED = [
    "usr/bin/npm",
    "usr/bin/npx",
    "usr/lib/node_modules/npm/bin/npm-cli.js",
    "usr/lib/node_modules/npm/bin/npx-cli.js",
    "usr/lib/node_modules/npm/package.json",
]
SKIP_PREFIXES = (".SIGN.", ".PKGINFO", ".pre-install", ".post-install", ".pre-upgrade", ".post-upgrade", ".trigger")


def fetch_apk() -> Path:
    if APK.is_file() and APK.stat().st_size > 0:
        print(f"使用缓存 {APK.relative_to(ROOT)}")
        return APK
    CACHE.mkdir(parents=True, exist_ok=True)
    print(f"下载 {APK_URL}")
    req = urllib.request.Request(APK_URL, headers={"User-Agent": "dsh-mobile-build/1.0"})
    with urllib.request.urlopen(req, timeout=180) as r:
        data = r.read()
    APK.write_bytes(data)
    print(f"  {len(data)} 字节")
    return APK


def build(apk_path: Path) -> bytes:
    with tarfile.open(apk_path, "r:gz") as src:
        members = src.getmembers()

        names = {m.name.lstrip("./") for m in members}
        missing = [n for n in REQUIRED if n not in names]
        if missing:
            raise SystemExit(f"npm .apk 缺少必需成员：{missing}")

        elf = 0
        for m in members:
            if not m.isfile() or m.size < 4:
                continue
            f = src.extractfile(m)
            if f and f.read(4) == b"\x7fELF":
                elf += 1
        if elf:
            raise SystemExit(f"npm 载荷里出现 {elf} 个 ELF —— 说明不能再双 ABI 共用同一份，须重新设计")

        buf = io.BytesIO()
        # gzip（不是 xz）：宿主 busybox 的 -z 是内置 applet，-J 要额外 relink xz
        with tarfile.open(fileobj=buf, mode="w:gz", compresslevel=9) as out:
            # HOME=/root，npm 要写 ~/.npm / ~/.npmrc；基础 rootfs 可能没有这个目录。
            # 目录成员放最前面，且解包不会删已有内容，与 git 补丁同款处理。
            root_dir = tarfile.TarInfo("./root")
            root_dir.type = tarfile.DIRTYPE
            root_dir.mode = 0o777
            out.addfile(root_dir)

            kept = 0
            for m in members:
                name = m.name.lstrip("./")
                if not name or any(name.startswith(p) for p in SKIP_PREFIXES):
                    continue
                if not name.startswith("usr/"):
                    continue
                # 归一化到 ./ 前缀（对齐 libdshgit.so 的成员布局）
                clone = tarfile.TarInfo("./" + name)
                clone.type = m.type
                clone.mode = m.mode
                clone.uid = clone.gid = 0
                clone.uname = clone.gname = "root"
                clone.mtime = 0
                clone.linkname = m.linkname
                clone.size = m.size
                if m.issym() or m.isdir() or m.islnk() or m.size == 0:
                    out.addfile(clone)
                else:
                    f = src.extractfile(m)
                    if f is None:
                        raise SystemExit(f"读不出成员 {m.name}")
                    out.addfile(clone, f)
                kept += 1

        payload = buf.getvalue()
    print(f"载荷：{kept} 个成员，{len(payload)} 字节，sha256 {hashlib.sha256(payload).hexdigest()[:12]}")
    return payload


def verify(path: Path) -> None:
    with tarfile.open(path, "r:gz") as t:
        names = {m.name.lstrip("./") for m in t.getmembers()}
        missing = [n for n in REQUIRED if n not in names]
        if missing:
            raise SystemExit(f"{path} 缺少必需成员 {missing}")
        links = {m.name.lstrip("./"): m.linkname for m in t.getmembers() if m.issym()}
        for link, target in links.items():
            # 相对链接按 usr/bin/.. 解析回包内路径（posixpath 才会消掉 ..）
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(link), target))
            if not target.startswith("/") and resolved not in names:
                raise SystemExit(f"悬空链接 {link} -> {target}（{resolved} 不在包里）")
    print(f"  ✓ {path.relative_to(ROOT)} ({path.stat().st_size} 字节)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apk", type=Path, help="本地 npm .apk（离线构建）")
    ap.add_argument("--check", action="store_true", help="只校验现有产物")
    args = ap.parse_args()

    if args.check:
        for d in OUT_DIRS:
            p = d / OUT_NAME
            if not p.is_file():
                raise SystemExit(f"缺少产物 {p}")
            verify(p)
        print("npm 补丁校验通过")
        return

    apk = args.apk or fetch_apk()
    if not apk.is_file():
        raise SystemExit(f"找不到 {apk}")
    payload = build(apk)
    for d in OUT_DIRS:
        d.mkdir(parents=True, exist_ok=True)
        p = d / OUT_NAME
        p.write_bytes(payload)
        verify(p)
    print("完成。记得跑 node scripts/gen-facts.mjs 并出包验证。")


if __name__ == "__main__":
    main()
