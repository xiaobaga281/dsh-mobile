#!/usr/bin/env node
/**
 * 本地链接检查：README.md 与 docs/*.md 里指向仓库内文件的相对链接，目标必须存在。
 *
 * 为什么要这条：门禁里 md-links 一直引用一个不存在的脚本，于是永远输出
 * 「SKIP（尚未实现）」= 一条假装在跑的绿灯（项目纪律里这叫门禁假绿，不许留）。
 * 只查本地相对链接；http(s) 与 mailto 一律不碰（外链会因网络/镜像状态抖动，
 * 把它做成门禁只会让人学会忽略门禁）。
 *
 * 用法：node scripts/verify-md-links.mjs [--quiet]
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, join, relative } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const quiet = process.argv.includes("--quiet");

function mdFiles() {
  const out = [join(ROOT, "README.md")];
  const docs = join(ROOT, "docs");
  if (existsSync(docs)) {
    for (const name of readdirSync(docs)) {
      const p = join(docs, name);
      if (name.endsWith(".md") && statSync(p).isFile()) out.push(p);
    }
  }
  return out.filter((p) => existsSync(p));
}

/** 抓出 markdown 链接目标：[text](target)，跳过代码块与行内代码里的示例（那是语法本身，不是链接） */
function linksOf(text) {
  const found = [];
  let inFence = false;
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    const scan = line.replace(/`[^`]*`/g, "");
    for (const m of scan.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      found.push({ line: i + 1, target: m[1] });
    }
  });
  return found;
}

const SKIP = /^(https?:|mailto:|tel:|data:|#)/i;
let checked = 0;
const broken = [];

for (const file of mdFiles()) {
  const text = readFileSync(file, "utf8");
  for (const { line, target } of linksOf(text)) {
    if (SKIP.test(target)) continue;
    const clean = decodeURIComponent(target.split("#")[0].split("?")[0]).trim();
    if (!clean) continue;
    checked += 1;
    const abs = clean.startsWith("/") ? resolve(ROOT, "." + clean) : resolve(dirname(file), clean);
    if (!existsSync(abs)) {
      broken.push(`${relative(ROOT, file)}:${line} → ${target}`);
    }
  }
}

if (broken.length) {
  console.error(`verify-md-links: ${broken.length} 个本地链接指向不存在的文件`);
  broken.slice(0, 40).forEach((b) => console.error("  · " + b));
  if (broken.length > 40) console.error(`  …另外 ${broken.length - 40} 个`);
  process.exit(1);
}
if (!quiet) console.log(`verify-md-links: ok（${mdFiles().length} 个文件，${checked} 条本地链接全部有落点）`);
