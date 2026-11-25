#!/usr/bin/env python3
"""
rootfs 去重打包器（全本机执行环境计划 · 双 ABI 精简）

x86_64 / aarch64 两棵 Alpine rootfs 里，非 ELF 的逐字节相同文件
（Python 标准库、证书、文档……约占 gzip 载荷的 10%）拆成三份载荷：

  rootfs-common.tar.xz   双 ABI 逐字节相同的非 ELF 文件 + 共享目录/符号链接
                         （进 assets，APK 里只存一份）
  rootfs-<abi>.tar.xz    各 ABI 独有/不同的文件：ELF 二进制、双树有差异的非 ELF

实测结论（勿再高估）：这个 payload 是 ELF 主导的（node 单二进制 ~100MB、
gcc/binutils、libstdc++-dev、.a 静态库），common 只有 ~8MB；split 的价值在
结构清晰与增量更新，不在体积。真正的体积杠杆是 xz：比 gzip 小 ~40%
（实测 220MB→132MB）。

分类规则（自研，替代「每 ABI 整树打包」的旧做法）：
  1) 类型/内容一致且非 ELF（\\x7fELF 魔数）→ common
  2) 其余进 abi 载荷（单树独有 → 对应 abi；双树都有 → 各存各的版本）
  3) 符号链接按 (name, linkname) 比较；目录一律 common（单树目录进对应 abi）
  4) TarInfo 原样拷贝（mode/uid/mtime/linkname 全保留）——
     **不要用 adb pull 的目录树做输入**：Windows 文件系统毁掉符号链接与
     exec 位（python3 链接变成 14KB 普通文件、755→644，踩过）。
     输入必须是设备端 busybox tar 打包的 .tar.gz（元数据无损）。

用法：python scripts/pack-rootfs.py
输入：.motion/runtimes/devtar/rootfs-{x86_64,aarch64}.tar.gz
      （apk.static 交叉安装 → 设备 busybox tar -czf → adb pull）
输出：.motion/runtimes/out/rootfs-common.tar.xz + rootfs-{x86_64,aarch64}.tar.xz
"""
import hashlib
import os
import sys
import tarfile

ROOT = os.path.join(os.path.dirname(__file__), "..", ".motion", "runtimes")
IN = os.path.join(ROOT, "devtar")
OUT = os.path.join(ROOT, "out")

INPUTS = {
    "x86_64": os.path.join(IN, "rootfs-x86_64.tar.gz"),
    "aarch64": os.path.join(IN, "rootfs-aarch64.tar.gz"),
}


def is_elf(head):
    return head[:4] == b"\x7fELF"


def scan(tf):
    """成员索引：name -> member；文件成员顺带算 md5。
    设备节点（dev/console 等，apk --initdb 造的）一律剔除：解包侧 mknod 必被拒，
    运行时 /dev 由 proot 绑定挂载提供，rootfs 里不需要。"""
    out = {}
    for m in tf:
        if m.ischr() or m.isblk() or m.isfifo():
            continue
        key = m.name.lstrip("./")
        if not key or key == ".":
            continue
        out[key] = m
    return out


def md5_of(tf, m, index=None):
    """成员内容 (md5, head4)；硬链接成员解引用到同包目标。"""
    src = m
    if m.islnk() and index is not None:
        src = index.get(m.linkname.lstrip("./"))
        if src is None or not src.isfile():
            return None
    h = hashlib.md5()
    f = tf.extractfile(src)
    if f is None:
        return None
    head = f.read(4)
    h.update(head)
    for chunk in iter(lambda: f.read(1 << 20), b""):
        h.update(chunk)
    return h.hexdigest(), head


def clone(dst, m, src_tf, index=None):
    """把成员原样（元数据全保留）写进目标 tar。
    硬链接成员先解引用成真实文件：硬链接对可能被拆进不同载荷（c++→g++ 里
    g++ 是 ELF 进 abi、c++ 链接进 common），跨包链接必然解不开（踩过）；
    解引用后无链接序依赖，内容去重照常生效。"""
    if m.islnk() and index is not None:
        target = index.get(m.linkname.lstrip("./"))
        if target is not None and target.isfile():
            f = src_tf.extractfile(target)
            nm = tarfile.TarInfo(m.name)
            nm.type = tarfile.REGTYPE
            nm.size = target.size
            nm.mode = m.mode or target.mode
            nm.uid = nm.gid = 0
            nm.mtime = m.mtime
            nm.uname = nm.gname = "root"
            dst.addfile(nm, f)
            return
        return  # 目标缺失（跨包硬链接且目标不在本包）：丢弃，解包侧无目标可链
    if m.isfile():
        dst.addfile(m, src_tf.extractfile(m))
    else:
        dst.addfile(m)


def main():
    os.makedirs(OUT, exist_ok=True)
    only_common = "common" in sys.argv[1:]
    tfs = {abi: tarfile.open(p, "r:gz") for abi, p in INPUTS.items()}
    scans = {abi: scan(tf) for abi, tf in tfs.items()}
    all_paths = sorted(set().union(*[set(s) for s in scans.values()]))

    common, buckets = [], {abi: [] for abi in INPUTS}
    n_common = n_abi = 0
    for rel in all_paths:
        present = [(abi, scans[abi][rel]) for abi in INPUTS if rel in scans[abi]]
        if len(present) == 1:
            abi, m = present[0]
            buckets[abi].append(m)
            n_abi += 1
            continue
        (a, ma), (b, mb) = present
        if ma.type != mb.type:
            buckets[a].append(ma); buckets[b].append(mb); n_abi += 1
            continue
        if ma.isfile() or ma.islnk():
            # 硬链接按解引用后的内容参与分类（与写入侧 clone 的解引用一致）
            ha = md5_of(tfs[a], ma, scans[a])
            hb = md5_of(tfs[b], mb, scans[b])
            same = ha is not None and hb is not None and ha == hb
            if same and not is_elf(ha[1]):
                common.append(ma); n_common += 1
            else:
                buckets[a].append(ma); buckets[b].append(mb); n_abi += 1
        elif ma.issym():
            if ma.linkname == mb.linkname:
                common.append(ma); n_common += 1
            else:
                buckets[a].append(ma); buckets[b].append(mb); n_abi += 1
        else:
            # 目录 / 其他特殊成员 → common
            common.append(ma); n_common += 1

    def write(name, members, src_abi):
        path = os.path.join(OUT, name)
        index = scans[src_abi]
        with tarfile.open(path, "w:xz", preset=6) as dst:
            for m in sorted(members, key=lambda x: (x.name.count("/"), x.name)):
                clone(dst, m, tfs[src_abi], index)
        return os.path.getsize(path)

    # 符号链接成员可能两个 ABI 都有：common 成员从任一树拷内容均可（目录/链接无内容流）
    sizes = {"rootfs-common.tar.xz": write("rootfs-common.tar.xz", common, "x86_64")}
    if only_common:
        sizes = {"rootfs-common.tar.xz": sizes["rootfs-common.tar.xz"]}
    else:
        for abi in INPUTS:
            sizes[f"rootfs-{abi}.tar.xz"] = write(f"rootfs-{abi}.tar.xz", buckets[abi], abi)

    for name, size in sizes.items():
        print(f"{name}: {size / 1048576:.1f} MB")
    print(f"合计: {sum(sizes.values()) / 1048576:.1f} MB（common {n_common} 项 / abi 每侧 {n_abi} 项）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
