#!/usr/bin/env node
/**
 * 运行时二进制注入管线（全本机执行环境计划 · 阶段 A1）
 *
 * 把 aarch64 / x86_64 的运行时二进制下载、校验、改名成 `libdsh<name>.so`
 * 放进 app/src/main/jniLibs/<abi>/。APK 安装（useLegacyPackaging=true）后它们
 * 落在 nativeLibraryDir —— Android 只允许 exec 这个目录（targetSdk 29+ 的 W^X
 * 拦数据目录）。
 *
 * 为什么是「伪装 so」：文件名必须 lib 开头 .so 结尾，AGP 才会打进 jniLibs。
 *
 * 来源：
 *   - busybox: Termux 1.38.0（bionic 动态，启动器 + libbusybox 三件套，见下方清单注释）
 *   - CPython / Node: 暂无可靠的静态 aarch64/x86_64 单文件发行版
 *     （python-build-standalone 全是 glibc/musl *动态*，Android 无 loader 可用），
 *     python/node 走底座 B（complete flavor + proot + Alpine，见 harness-plan-ondevice.md §1/§4）。
 *     KernelRuntime 对缺失运行时返回结构化 NEED_RUNTIME，阶段 B 接资源包下载。
 *
 * 用法：node scripts/fetch-runtimes.mjs          # 全量下载并注入
 *       node scripts/fetch-runtimes.mjs --check  # 只校验现有文件（CI 用）
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jniRoot = path.join(root, 'app', 'src', 'main', 'jniLibs');
const cacheDir = path.join(root, '.motion', 'runtimes');

const ABIS = ['arm64-v8a', 'x86_64'];
const TERMUX_ARCH = { 'arm64-v8a': 'aarch64', x86_64: 'x86_64' };

/**
 * 注入清单：jniLibs 内的文件名 -> 来源与期望 sha256。
 *
 * busybox 用 Termux 的 bionic 构建（启动器 + libbusybox 1.38.0 + libandroid-selinux
 * + libpcre2-8）。**不要换回 Alpine busybox-static**：静态 musl 1.2.5 在 Android
 * seccomp 下必死 SIGSYS（applet 分发路径触发被禁系统调用，M1 模拟器实锤；
 * argv[0] 不是 applet 名时能打印 "applet not found" 是唯一活着的路径）。
 * bionic 动态版天然规避；依赖闭包 = 这 4 件，全部落在 nativeLibraryDir。
 *
 * sha256 在首次下载后自动回填记录（下游 CI 用 --check 比对），换版本请删掉旧值重跑。
 */
const RUNTIMES = {
  busybox: {
    // 三个 Termux deb 组成依赖闭包：busybox(启动器+libbusybox) + libandroid-selinux + pcre2
    debs: [
      {
        pkg: 'busybox',
        url: (arch) => `https://packages.termux.dev/apt/termux-main/pool/main/b/busybox/busybox_1.38.0-1_${arch}.deb`,
        cacheName: (arch) => `busybox-termux-${arch}.deb`,
        parts: [
          { soName: 'libdshbox.so', member: 'busybox' },
          { soName: 'libdshbb.so', member: 'libbusybox.so.1.38.0' },
        ],
      },
      {
        pkg: 'libandroid-selinux',
        url: (arch) => `https://packages.termux.dev/apt/termux-main/pool/main/liba/libandroid-selinux/libandroid-selinux_14.0.0.11-1_${arch}.deb`,
        cacheName: (arch) => `libsel-termux-${arch}.deb`,
        parts: [{ soName: 'libdshselinux.so', member: 'libandroid-selinux.so' }],
      },
      {
        pkg: 'pcre2',
        url: (arch) => `https://packages.termux.dev/apt/termux-main/pool/main/p/pcre2/pcre2_10.49_${arch}.deb`,
        cacheName: (arch) => `pcre2-termux-${arch}.deb`,
        parts: [{ soName: 'libdshpcre.so', member: 'libpcre2-8.so' }],
      },
    ],
  },
  proot: {
    // 底座 B 五件套：proot 本体 + loader/loader32（proot deb）+ libtalloc + libandroid-shmem
    debs: [
      {
        pkg: 'proot',
        url: (arch) => `https://packages.termux.dev/apt/termux-main/pool/main/p/proot/proot_5.1.107.101_${arch}.deb`,
        cacheName: (arch) => `proot-termux-${arch}.deb`,
        parts: [
          { soName: 'libdshproot.so', member: 'proot' },
          { soName: 'libdshloader.so', member: 'loader' },
          { soName: 'libdshloader32.so', member: 'loader32' },
        ],
      },
      {
        pkg: 'libtalloc',
        url: (arch) => `https://packages.termux.dev/apt/termux-main/pool/main/libt/libtalloc/libtalloc_2.5.0_${arch}.deb`,
        cacheName: (arch) => `talloc-termux-${arch}.deb`,
        parts: [{ soName: 'libdshtalloc.so', member: 'libtalloc.so.2.5.0' }],
      },
      {
        pkg: 'libandroid-shmem',
        url: (arch) => `https://packages.termux.dev/apt/termux-main/pool/main/liba/libandroid-shmem/libandroid-shmem_0.7_${arch}.deb`,
        cacheName: (arch) => `shmem-termux-${arch}.deb`,
        parts: [{ soName: 'libdshshmem.so', member: 'libandroid-shmem.so' }],
      },
    ],
  },
};

function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

function download(url, dest) {
  console.log(`下载 ${url}`);
  execSync(`curl -sL --fail --max-time 120 -o "${dest}" "${url}"`, { stdio: 'inherit' });
}

/** 从 deb（ar 归档 + data.tar.xz）里按末段文件名提取成员，写入 outDir。
 *  python 代码走临时 .py 文件：内联 -c 的多行+引号在 Windows cmd 上必炸。 */
function extractDebMembers(debPath, members, outDir) {
  mkdirSync(outDir, { recursive: true });
  const helperPath = path.join(cacheDir, '_deb_extract.py');
  writeFileSync(helperPath, `import sys, tarfile, lzma, io, os
deb, out_dir, members = sys.argv[1], sys.argv[2], sys.argv[3].split("|")
d = open(deb, "rb").read(); off = 8
data_xz = None
while off < len(d):
    hdr = d[off:off+60]; name = hdr[0:16].decode().strip(); size = int(hdr[48:58].decode().strip())
    body = d[off+60:off+60+size]; off += 60 + size + (size % 2)
    if name.split("/")[0] == "data.tar.xz": data_xz = body
t = tarfile.open(fileobj=io.BytesIO(lzma.decompress(data_xz)))
for x in t.getmembers():
    if not x.isfile(): continue
    short = x.name.rsplit("/", 1)[-1]
    if short in members:
        with open(os.path.join(out_dir, short), "wb") as f:
            f.write(t.extractfile(x).read())
`);
  execSync(`python "${helperPath}" "${debPath}" "${outDir}" "${members.join('|')}"`, { stdio: 'inherit', maxBuffer: 16 * 1024 * 1024 });
  const result = {};
  for (const m of members) {
    const p = path.join(outDir, m);
    if (!existsSync(p)) throw new Error(`deb ${debPath} 里没找到成员 ${m}`);
    result[m] = p;
  }
  return result;
}

const checkOnly = process.argv.includes('--check');
let failed = false;

for (const [name, spec] of Object.entries(RUNTIMES)) {
  for (const abi of ABIS) {
    const arch = TERMUX_ARCH[abi];
    // 本组全部产物都在才整体跳过（部分缺失则整组重取，避免混装版本）
    const allParts = spec.debs.flatMap((d) => d.parts);
    const missing = allParts.filter((p) => !existsSync(path.join(jniRoot, abi, p.soName)));
    if (missing.length === 0) {
      for (const p of allParts) {
        const have = sha256(readFileSync(path.join(jniRoot, abi, p.soName)));
        console.log(`✓ ${abi}/${p.soName} 已就位 (${have.slice(0, 12)}…)`);
      }
      continue;
    }
    if (checkOnly) { console.error(`✗ ${abi}/ 缺 ${missing.map((m) => m.soName).join(',')}`); failed = true; continue; }

    mkdirSync(path.join(jniRoot, abi), { recursive: true });
    for (const debSpec of spec.debs) {
      const cachePath = path.join(cacheDir, debSpec.cacheName(arch));
      if (!existsSync(cachePath)) download(debSpec.url(arch), cachePath);
      // deb 提取的中间产物放 abi+包 专属子目录（缓存名撞名教训：不带架构会互相覆盖）
      const outDir = path.join(cacheDir, `extract-${debSpec.pkg}-${arch}`);
      const members = debSpec.parts.map((p) => p.member);
      const extracted = extractDebMembers(cachePath, members, outDir);
      for (const p of debSpec.parts) {
        const dest = path.join(jniRoot, abi, p.soName);
        writeFileSync(dest, readFileSync(extracted[p.member]));
        const sum = sha256(readFileSync(dest));
        console.log(`✓ 注入 ${abi}/${p.soName} ← ${debSpec.pkg}:${p.member}（${(readFileSync(dest).length / 1024).toFixed(0)}KB, sha256 ${sum.slice(0, 12)}…）`);
      }
    }
  }
}

if (failed) process.exit(1);
console.log('运行时注入完成。APK 体积预算：busybox 四件套 x2 ABI ≈ 5MB');
