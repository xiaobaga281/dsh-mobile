#!/usr/bin/env node
/**
 * Alpine apk 依赖闭包解析 + 下载（全内置 rootfs 预制管线 R1）
 *
 * 给定种子包名，从 Packages 索引递归解析完整依赖闭包（含 so:/cmd: 虚拟依赖，
 * 按 Provides 字段映射），下载 .apk 到本地，供 guest 内 `apk add --no-network` 离线安装。
 *
 * 用法：node scripts/resolve-apks.mjs <arch> <pkg...>
 *   node scripts/resolve-apks.mjs x86_64 python3 nodejs
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const MIRROR = 'https://dl-cdn.alpinelinux.org/alpine';
// main + community 双仓库：openjdk 等 JDK 在 community，rust/gcc 在 main。
// 同名包 main 优先（apk 的默认仓库顺序语义）。
const REPOS = ['v3.20/main', 'v3.20/community'];
const arch = process.argv[2];
const seeds = process.argv.slice(3).filter((a) => !a.startsWith('--'));
if (!arch || seeds.length === 0) {
  console.error('用法: node scripts/resolve-apks.mjs <x86_64|aarch64> <pkg...>');
  process.exit(1);
}

const outDir = path.resolve('.motion', 'runtimes', `pkgs-${arch}`);
mkdirSync(outDir, { recursive: true });

let indexRaw;
const urlsMode = process.argv.includes('--urls');
const log = urlsMode ? (...a) => console.error(...a) : (...a) => console.log(...a);

/** 逐仓库下载/解 APKINDEX；返回 [{repo, raw}] */
function loadIndexes() {
  const out = [];
  for (const repo of REPOS) {
    const short = repo.split('/')[1];
    const cache = path.resolve('.motion', 'runtimes', `APKINDEX-${arch}-${short}.tar.gz`);
    const url = `${MIRROR}/${repo}/${arch}/APKINDEX.tar.gz`;
    if (!existsSync(cache)) {
      log(`下载索引 ${url}…`);
      execSync(`curl -sL --fail --max-time 120 -o "${cache}" "${url}"`, { stdio: 'inherit' });
    } else {
      log(`索引缓存命中: ${cache}`);
    }
    out.push({ repo: short, raw: extractIndex(cache) });
  }
  return out;
}

/** APKINDEX.tar.gz = tar.gz，唯一成员 APKINDEX（纯文本段落） */
function extractIndex(tgz) {
  return execSync(
    `python -c "import tarfile,sys;t=tarfile.open(sys.argv[1]);sys.stdout.buffer.write(t.extractfile('APKINDEX').read())" "${tgz}"`,
    { maxBuffer: 64 * 1024 * 1024 },
  );
}

// 解析索引（多段落 P:/V:/D:/p: 字段）；跨仓库合并，main 先载入并优先
const pkgs = new Map();        // name -> {deps, provides, version, repo}
const providers = new Map();   // provide 名(name 或 so:xxx) -> [pkgName]
for (const { repo, raw } of loadIndexes()) {
  for (const block of raw.toString('utf8').split('\n\n')) {
    const get = (k) => (block.match(new RegExp(`^${k}:(.*)$`, 'm')) || [])[1];
    const name = get('P');
    if (!name) continue;
    if (pkgs.has(name)) continue;   // main 优先
    const deps = (get('D') || '').split(' ').filter(Boolean);
    const provides = (get('p') || '').split(' ').filter(Boolean);
    const version = get('V');
    const origin = get('o');
    pkgs.set(name, { deps, provides, origin, version, repo });
    for (const p of provides) {
      const key = p.split('=')[0];
      if (!providers.has(key)) providers.set(key, []);
      providers.get(key).push(name);
    }
    // 包自身也是一个 provider（提供 cmd:name 与自身名）
    for (const key of [name, `cmd:${name}`]) {
      if (!providers.has(key)) providers.set(key, []);
      providers.get(key).push(name);
    }
  }
}

// 版本约束剥离：pkg>=1.2 / pkg=1.2 / so:lib.so.1(V)
function depKey(d) {
  return d.replace(/[<>=~].*$/, '').trim();
}

const resolved = new Set();
const order = [];
function visit(name) {
  if (resolved.has(name)) return;
  resolved.add(name);
  const pkg = pkgs.get(name);
  if (!pkg) { log(`⚠ 索引里找不到包 ${name}`); return; }
  order.push(name);
  for (const dep of pkg.deps) {
    const key = depKey(dep);
    // 优先精确名，其次虚拟依赖（so:/cmd:）查 providers；同 key 多 provider 全收（保守）
    if (pkgs.has(key)) { visit(key); continue; }
    const provs = providers.get(key) || [];
    if (provs.length === 0) { log(`⚠ ${name} 的依赖 ${dep} 无 provider`); continue; }
    for (const p of provs) visit(p);
  }
}
for (const s of seeds) visit(s);

// APKINDEX 不带文件名。v3.20 是扁平布局 {repo}/{arch}/{name}-{version}.apk；
// v3.21+ 才改成 pool/main/{lib|首字母}/{origin}/…（需要时按仓库版本切换）
function apkPath(pkg, name) {
  return `${name}-${pkg.version}.apk`;
}

log(`闭包 ${order.length} 个包。开始下载…`);
// 沙箱代理只在交互 shell 生效（node spawn 的 curl 拿不到代理），所以下载由调用方
// 逐行执行本脚本最后输出的 URL 清单（Bash 里 curl 可用），脚本本身只负责解析。
if (process.argv.includes('--urls')) {
  for (const name of order) {
    const pkg = pkgs.get(name);
    console.log(`${MIRROR}/v3.20/${pkg.repo}/${arch}/${apkPath(pkg, name)}\t${name}-${pkg.version}.apk`);
  }
  process.exit(0);
}
let total = 0;
for (const name of order) {
  const pkg = pkgs.get(name);
  const dest = path.join(outDir, `${name}-${pkg.version}.apk`);
  if (existsSync(dest)) { log(`  缓存 ${name}`); continue; }
  execSync(`curl -sL --fail --max-time 180 -o "${dest}" "${MIRROR}/v3.20/${pkg.repo}/${arch}/${apkPath(pkg, name)}"`, { stdio: 'pipe' });
  const sz = execSync(`stat -c %s "${dest}"`).toString().trim();
  total += Number(sz);
  log(`  ✓ ${name}-${pkg.version} (${(sz / 1048576).toFixed(1)}MB)`);
}
log(`完成：${order.length} 包，本次新下 ${(total / 1048576).toFixed(1)}MB → ${outDir}`);
writeFileSync(path.join(outDir, '_closure.txt'), order.join('\n'));
