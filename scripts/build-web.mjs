#!/usr/bin/env node
/**
 * 把 web/src/*.js 按 web/build.json 的顺序拼成 app/src/main/assets/web/app.js。
 *
 * 为什么要有这一层：前端是「一个 IIFE 里 2 万个函数」的单文件产物，直接改产物
 * 无法保证「源」和「产物」不分叉（历史上 preview/ 落后 1599 行就是这么来的）。
 * 所以源码拆成有序 part，产物由本脚本生成；verify-web-bundle.mjs 逐字节守着。
 *
 * 用法：
 *   node scripts/build-web.mjs            生成产物
 *   node scripts/build-web.mjs --check    只比对，不写盘（不一致时退出码 1）
 *
 * banner 里不含时间戳 —— 同样的源必须生成同样的字节，否则 --check 永远不通过。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "web", "build.json");
const OUT = join(ROOT, "app/src/main/assets/web/app.js");
const SRC = join(ROOT, "web", "src");

const checkOnly = process.argv.includes("--check");

function fail(msg) {
  console.error(`build-web: ${msg}`);
  process.exit(1);
}

if (!existsSync(BUILD)) fail(`找不到 ${BUILD}`);

let config;
try {
  config = JSON.parse(readFileSync(BUILD, "utf8"));
} catch (e) {
  fail(`web/build.json 不是合法 JSON：${e.message}`);
}

const parts = config.parts;
if (!Array.isArray(parts) || parts.length === 0) fail("web/build.json 的 parts 必须是非空数组");

// 读 part 并做基本体检：文件存在、以换行结尾。
// 多 part 时额外禁止任何 part 自带 IIFE 结尾 —— 那说明切分点落在函数体外，拼起来会语法错。
const multi = parts.length > 1;
const loaded = [];
for (const name of parts) {
  const file = join(SRC, name);
  if (!existsSync(file)) fail(`找不到 part：web/src/${name}`);
  const raw = readFileSync(file, "utf8");
  // 统一成 LF：Windows 编辑器 / 工具可能把 part 存成 CRLF，而产物里的 banner 永远是 LF。
  // 不归一化的话，「只有换行不同」会被报成「有人手改了产物」，排查成本极高。
  const text = raw.replace(/\r\n/g, "\n");
  if (text.length === 0) fail(`part 是空文件：web/src/${name}`);
  if (!text.endsWith("\n")) fail(`part 末尾缺少换行：web/src/${name}（拼接会粘成一行）`);
  // 只有「非最后一个 part」出现 IIFE 结尾才说明切分点越过了函数体（与 fail 文案一致）
  if (multi && name !== parts[parts.length - 1] && /^\}\)\(\);\s*$/m.test(text)) {
    fail(`part 里出现了 IIFE 结尾 "})();"：web/src/${name}（切分点越过了函数体，只在最后一个 part 允许）`);
  }
  loaded.push({ name, text });
}

const body = loaded.map((p) => p.text).join("");
const hash = createHash("sha256").update(body).digest("hex").slice(0, 8);

const banner =
  "/* AUTO-GENERATED — DO NOT EDIT.\n" +
  `   Source: web/src/*.js in web/build.json order · ${parts.length} part${parts.length > 1 ? "s" : ""} · parts sha256 ${hash}\n` +
  "   Edit the parts, then run: node scripts/build-web.mjs   (or: node scripts/sync-web.mjs) */\n";

const next = banner + body;

if (!checkOnly) {
  writeFileSync(OUT, next, "utf8");
  console.log(`build-web: 已生成 app/src/main/assets/web/app.js（${parts.length} part，${next.length} 字节，parts ${hash}）`);
  process.exit(0);
}

// --check：逐字节比对，不一致时定位到第一个差异行并指出它属于哪个 part
if (!existsSync(OUT)) fail("产物不存在：app/src/main/assets/web/app.js（先跑 node scripts/build-web.mjs）");

const current = readFileSync(OUT, "utf8");
if (current === next) {
  console.log(`build-web: 产物与源一致（${parts.length} part，parts ${hash}）`);
  process.exit(0);
}

// 只有换行差异时不要报成「手改了产物」——那是 core.autocrlf / 编辑器造成的，报一条针对性提示
if (current.replace(/\r\n/g, "\n") === next) {
  console.error(
    [
      "build-web: 产物内容一致，但换行是 CRLF（期望 LF）。",
      "  多半是 Windows 上 core.autocrlf=true 检出时转换的 —— .gitattributes 已声明这些文件 eol=lf。",
      "  修法：node scripts/build-web.mjs 重写一遍即可；若反复出现，检查 git config core.autocrlf。",
    ].join("\n"),
  );
  process.exit(1);
}

const a = current.split("\n");
const b = next.split("\n");
let at = 0;
while (at < a.length && at < b.length && a[at] === b[at]) at += 1;

// 差异行落在哪个 part：banner 占 3 行，其余按各 part 行数累加
const bannerLines = banner.split("\n").length - 1;
let cursor = bannerLines;
let owner = at < bannerLines ? "banner（头部注释被改过）" : "产物末尾（多出的行）";
if (at >= bannerLines) {
  for (const p of loaded) {
    const lines = p.text.split("\n").length - 1;
    if (at < cursor + lines) { owner = `web/src/${p.name}`; break; }
    cursor += lines;
  }
}

console.error(
  [
    "build-web: 产物与源不一致 —— 有人直接改了产物，或者改了源忘了 build。",
    `  首个差异在第 ${at + 1} 行，属于 ${owner}`,
    `  产物：${JSON.stringify((a[at] ?? "").slice(0, 100))}`,
    `  期望：${JSON.stringify((b[at] ?? "").slice(0, 100))}`,
    "  修法：改 web/src 里的源，然后跑 node scripts/build-web.mjs",
  ].join("\n"),
);
process.exit(1);
