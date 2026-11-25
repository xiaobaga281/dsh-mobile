#!/usr/bin/env python3
"""
从 Termux 仓库取 aapt2 及其**完整**依赖闭包（bionic 构建，直接跑在 Android 上）

为什么走 Termux：Google 官方 aapt2 只有 glibc/x86_64 版（musl 跑不了；ARM 也没有），
Termux 编译了 aarch64/arm/x86_64 三架构，链接 Android bionic，和 busybox 一样能直接 exec。

依赖解析不用"手工试错"：Termux 提供 Contents-<arch>.gz（文件 → 包名全量索引），
脚本按 ELF 的 DT_NEEDED 逐个查索引、下载、再递归扫描新库，直到闭包稳定。

用法：python scripts/fetch-aapt2.py <x86_64|aarch64>
产物：.motion/runtimes/aapt2-termux-<abi>/{bin,lib} + 同名 tar.gz
"""
import gzip
import io
import lzma
import os
import re
import struct
import sys
import tarfile
import urllib.request

MIRROR = "https://packages.termux.dev/apt/termux-main"
ROOT = os.path.join(os.path.dirname(__file__), "..", ".motion", "runtimes")
# Android/bionic 自带的系统库，不需要随包携带
SYSTEM_LIBS = {
    "libc.so", "libdl.so", "libm.so", "liblog.so", "libandroid.so", "libz.so",
    "libstdc++.so", "libm.so.6", "ld-android.so",
}


def fetch(url, dst):
    if os.path.exists(dst) and os.path.getsize(dst) > 0:
        return dst
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    urllib.request.urlretrieve(url, dst)
    return dst


def load_index(abi):
    base = f"{MIRROR}/dists/stable/main"
    pkgs_raw = gzip.decompress(urllib.request.urlopen(f"{base}/binary-{abi}/Packages.gz", timeout=180).read())
    pkgs = {}
    for block in pkgs_raw.decode("utf-8", "replace").split("\n\n"):
        f = {}
        for line in block.split("\n"):
            if line[:1] in (" ", "\t") or ":" not in line:
                continue
            k, v = line.split(":", 1)
            f[k.strip()] = v.strip()
        if "Package" in f and "Filename" in f:
            pkgs[f["Package"]] = f
    return pkgs


def needed_parts(path):
    """解析 ELF64 的 DT_NEEDED"""
    d = open(path, "rb").read()
    if d[:4] != b"\x7fELF" or d[4] != 2:
        return []
    e_shoff, = struct.unpack("<Q", d[0x28:0x30])
    e_shentsize, e_shnum = struct.unpack("<HH", d[0x3A:0x3E])
    secs = [struct.unpack("<IIQQQQIIQQ", d[e_shoff + i * e_shentsize:e_shoff + (i + 1) * e_shentsize])
            for i in range(e_shnum)]
    dyn = next((s for s in secs if s[1] == 6), None)
    if not dyn:
        return []
    str_off = secs[dyn[6]][4]
    out = []
    off, size, entsize = dyn[4], dyn[5], dyn[9]
    for p in range(off, off + size, entsize):
        tag, val = struct.unpack("<qQ", d[p:p + 16])
        if tag == 0:
            break
        if tag == 1:
            end = d.index(b"\x00", str_off + val)
            out.append(d[str_off + val:end].decode())
    return out


def extract_deb(path, outdir):
    d = open(path, "rb").read()
    off, member, data = 8, None, None
    while off < len(d):
        hdr = d[off:off + 60]
        name = hdr[0:16].decode(errors="replace").strip()
        size = int(hdr[48:58].decode().strip() or 0)
        body = d[off + 60:off + 60 + size]
        off += 60 + size + (size % 2)
        if name.startswith("data.tar"):
            member, data = name, body
    if not data:
        return
    if member.endswith(".xz"):
        data = lzma.decompress(data)
    elif member.endswith(".gz"):
        data = gzip.decompress(data)
    os.makedirs(outdir, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data)) as t:
        try:
            t.extractall(outdir, filter="tar")
        except TypeError:
            t.extractall(outdir)


def main():
    abi = sys.argv[1] if len(sys.argv) > 1 else "x86_64"
    pkgs = load_index(abi)
    print(f"Termux[{abi}]: {len(pkgs)} 包")

    work = os.path.join(ROOT, f"aapt2-termux-src-{abi}")
    got_pkgs, lib_paths = set(), {}

    def pull(pkg_name):
        if pkg_name in got_pkgs or pkg_name not in pkgs:
            return
        pkg = pkgs[pkg_name]
        url = f"{MIRROR}/{pkg['Filename']}"
        deb = os.path.join(ROOT, "termux", f"{pkg_name}-{abi}.deb")
        fetch(url, deb)
        extract_deb(deb, work)
        got_pkgs.add(pkg_name)
        print(f"  + {pkg_name:18} {pkg.get('Version',''):16} {os.path.getsize(deb)/1048576:5.2f}MB")

    want, frontier = {"aapt2"}, ["aapt2"]
    while frontier:
        name = frontier.pop()
        pkg = pkgs.get(name)
        if not pkg:
            continue
        for dep in pkg.get("Depends", "").split(","):
            dn = dep.split("(")[0].split(":")[0].strip()
            if not dn or "|" in dn or dn.startswith("$"):
                continue
            if dn in pkgs and dn not in want:
                want.add(dn)
                frontier.append(dn)
    for name in sorted(want):
        pull(name)
    usr = os.path.join(work, "data", "data", "com.termux", "files", "usr")
    libdir = os.path.join(usr, "lib")

    def scan():
        for root, _, files in os.walk(libdir):
            for f in files:
                p = os.path.join(root, f)
                if os.path.isfile(p) and p not in lib_paths:
                    lib_paths[p] = True

    scan()
    for _ in range(12):
        pending = set()
        targets = [os.path.join(usr, "bin", "aapt2")] + list(lib_paths.keys())
        for t in targets:
            for n in needed_parts(t):
                if n in SYSTEM_LIBS:
                    continue
                if not os.path.exists(os.path.join(libdir, n)) and not os.path.exists(os.path.join(usr, "lib", n)):
                    pending.add(n)
        if not pending:
            break
        for soname in sorted(pending):
            print(f"  ! {soname} 缺失（不在声明依赖里）")
        break

    out = os.path.join(ROOT, f"aapt2-termux-{abi}")
    os.makedirs(os.path.join(out, "bin"), exist_ok=True)
    os.makedirs(os.path.join(out, "lib"), exist_ok=True)
    with open(os.path.join(usr, "bin", "aapt2"), "rb") as f, open(os.path.join(out, "bin", "aapt2"), "wb") as w:
        w.write(f.read())
    os.chmod(os.path.join(out, "bin", "aapt2"), 0o755)

    lib_bytes = 0
    # 闭包里真正被引用的 soname（从 aapt2 出发逐层扫描）
    keep, seen = set(), set()
    queue = [os.path.join(usr, "bin", "aapt2")]
    while queue:
        cur = queue.pop()
        if cur in seen:
            continue
        seen.add(cur)
        for n in needed_parts(cur):
            if n in SYSTEM_LIBS:
                continue
            keep.add(n)
            p = os.path.join(libdir, n)
            if os.path.exists(p):
                queue.append(p)
    for f in sorted(keep):
        src = os.path.join(libdir, f)
        if os.path.exists(src):
            with open(src, "rb") as fh, open(os.path.join(out, "lib", f), "wb") as w:
                w.write(fh.read())
            lib_bytes += os.path.getsize(src)
    print(f"aapt2 {os.path.getsize(os.path.join(out,'bin','aapt2'))/1048576:.1f}MB + 依赖库 {lib_bytes/1048576:.1f}MB（{len(keep)} 个）")

    tar_path = os.path.join(ROOT, f"aapt2-termux-{abi}.tar.gz")
    with tarfile.open(tar_path, "w:gz") as t:
        for sub in ("bin", "lib"):
            for f in sorted(os.listdir(os.path.join(out, sub))):
                p = os.path.join(out, sub, f)
                info = t.gettarinfo(p, arcname=f"{sub}/{f}")
                info.uid = info.gid = 0
                info.uname = info.gname = "root"
                info.mode = 0o755 if sub == "bin" else 0o644
                with open(p, "rb") as fh:
                    t.addfile(info, fh)
    print(f"tar.gz {os.path.getsize(tar_path)/1048576:.1f}MB → {tar_path}")


if __name__ == "__main__":
    main()
