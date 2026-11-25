#!/usr/bin/env node
/**
 * 把前端**源码**随 APK 带上，供设备内自改（kernel/dev/SelfModify.kt）。
 *
 * 桌面 harness 能改自己，是因为源码就在磁盘上；预编译 APK 里只有拼接产物
 * app.js，Agent 够不着自己的源码。这里把 web/src 的 4 个 part 与 build.json
 * 原样复制进 assets/devsrc/，设备上首次启用时展开到 workspace/.dsh-src/parts/
 * 变成可写副本，之后 Agent 改它 → self_modify(rebuild) → WebView 重载即生效。
 *
 * 产物由本脚本生成，别手改；scripts/regress/self-modify.test.mjs 会比对
 * assets/devsrc 与 web/src 是否逐字节一致（--check 也查）。
 *
 * 用法：
 *   node scripts/sync-devsrc.mjs           同步
 *   node scripts/sync-devsrc.mjs --check  只比对
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "web", "build.json");
const SRC = join(ROOT, "web", "src");
const OUT = join(ROOT, "app/src/main/assets/devsrc");
const checkOnly = process.argv.includes("--check");

function fail(msg) {
  console.error(`sync-devsrc: ${msg}`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(BUILD, "utf8"));
const parts = config.parts;
if (!Array.isArray(parts) || !parts.length) fail("web/build.json 的 parts 必须是非空数组");

const files = [...parts.map((n) => [n, join(SRC, n), join(OUT, n)]),
  ["build.json", BUILD, join(OUT, "build.json")]];

if (checkOnly) {
  for (const [name, src, dst] of files) {
    if (!existsSync(dst)) fail(`缺少随包源码 assets/devsrc/${name}（跑 node scripts/sync-devsrc.mjs）`);
    if (!readFileSync(dst).equals(readFileSync(src))) {
      fail(`assets/devsrc/${name} 与源不一致（跑 node scripts/sync-devsrc.mjs）`);
    }
  }
  // 目录里不该混进别的东西
  const extra = readdirSync(OUT).filter((n) => !files.some((f) => f[0] === n));
  if (extra.length) fail(`assets/devsrc 有额外文件：${extra.join(", ")}`);
  console.log(`sync-devsrc: 一致（${files.length} 个文件）`);
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });
for (const [name, src, dst] of files) {
  if (!existsSync(src)) fail(`找不到源 ${src}`);
  writeFileSync(dst, readFileSync(src));
}
console.log(`sync-devsrc: 已同步 ${files.length} 个文件到 app/src/main/assets/devsrc/`);
