/*
 * preview/ 必须与 app/src/main/assets/web 逐字节一致。
 *
 * README 一直写着「预览与真机同一份代码」，但没人拦着：这份手抄副本曾经落后生产 1599 行，
 * 于是「照着 preview 改一遍」等于把修好的 bug 再带回来。现在改完 assets 只要跑
 * `node scripts/sync-web.mjs`，忘了就跑红这条。
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FILES = ["index.html", "styles.css", "motion.js", "app.js"];
const fails = [];

for (const f of FILES) {
  const src = join(root, "app/src/main/assets/web", f);
  const dst = join(root, "preview", f);
  if (!existsSync(src)) { fails.push(`${f}（源文件不见了）`); continue; }
  if (!existsSync(dst)) { fails.push(`${f}（preview 里缺失）`); continue; }
  const a = readFileSync(src, "utf8");
  const b = readFileSync(dst, "utf8");
  if (a !== b) {
    const lines = (a.split("\n").length - b.split("\n").length);
    fails.push(`${f} 差 ${Math.abs(lines)} 行${lines > 0 ? "（preview 落后）" : "（preview 超前）"}`);
  }
}

/* 引用一致性：文本里 url() 指到的每个文件都要在 preview/ 里、且与 assets 逐字节一致。
   以前这个守卫只比 4 个文本文件 —— `styles.css` 引用的 `running-whale.png` 从来不在
   preview/ 里，预览页一直是破图而守卫全绿（ png 归不住 = 白名单式同步的固有盲区）。 */
const { readFileSync: rd } = await import("node:fs");
const refFails = [];
for (const f of FILES) {
  let text = "";
  try { text = rd(join(root, "preview", f), "utf8"); } catch (_) { continue; }
  for (const m of text.matchAll(/url\(\s*["']?([^"')]+?)["']?\s*\)/g)) {
    const p = m[1].trim();
    if (/^(https?:|data:|blob:)/i.test(p) || p.startsWith("/")) continue;
    const rel = join(dirname(f), p).replace(/\\/g, "/");
    const inPreview = existsSync(join(root, "preview", rel));
    const inAssets = existsSync(join(root, "app/src/main/assets/web", rel));
    if (!inAssets) { refFails.push(`${rel}（${f} 引用了它，但 assets/web 里没有 = 真机上也是破图）`); continue; }
    if (!inPreview) { refFails.push(`${rel}（preview 里缺，预览页破图）`); continue; }
    const a = rd(join(root, "app/src/main/assets/web", rel));
    const b = rd(join(root, "preview", rel));
    if (!a.equals(b)) refFails.push(`${rel}（preview 与 assets 不一致）`);
  }
}

const all = [...fails, ...refFails];
console.log(all.length
  ? `✘ preview 与真机不同步：${all.join("、")}\n  跑一次：node scripts/sync-web.mjs`
  : `✔ preview 与 assets/web 逐字节一致（${FILES.join("、")} + 其引用的图片）`);
process.exit(all.length ? 1 : 0);
