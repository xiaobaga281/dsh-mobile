// 把 App 内置的 Web UI 同步到 preview/，保证「预览」和「真机」是同一份代码。
// 用法: node scripts/sync-web.mjs
//
// 前置：先确认产物与 web/src 一致（前端源在 web/src，产物 app.js 由 build-web 生成）。
// 这里调用 --check 而不是直接 build，是为了让「改了源忘 build」在同步这一步就暴露，
// 而不是把一份过期产物复制到 preview 再被 preview-sync 回归当成真机版本。
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "app/src/main/assets/web");
const out = resolve(root, "preview");

const built = spawnSync(process.execPath, [resolve(root, "scripts/build-web.mjs"), "--check"], {
  stdio: "inherit",
});
if (built.status !== 0) {
  console.error(
    "\nsync-web: 产物与 web/src 不一致，已停止同步。\n" +
      "  改源：编辑 web/src/*.js，然后 node scripts/build-web.mjs\n" +
      "  误改产物：git checkout -- app/src/main/assets/web/app.js 后重新 build\n",
  );
  process.exit(1);
}

mkdirSync(out, { recursive: true });
const FILES = ["index.html", "styles.css", "motion.js", "app.js"];
for (const f of FILES) {
  copyFileSync(resolve(src, f), resolve(out, f));
  console.log("synced", f);
}

/**
 * 文本里引用的图片也要跟着同步。
 *
 * 白名单原来只有上面 4 个文本文件，于是 `styles.css` 引用的 `running-whale.png`
 * 从来没进过 `preview/` —— 预览页那个「运行中」动画一直是破图，而 preview-sync
 * 守卫照样全绿（它只比那 4 个文件）。引用是从同步后的文本里现扫的，加图片不用改这里。
 */
const refs = new Set();
for (const f of FILES) {
  const text = readFileSync(resolve(out, f), "utf8");
  for (const m of text.matchAll(/url\(\s*["']?([^"')]+?)["']?\s*\)/g)) {
    const p = m[1].trim();
    if (/^(https?:|data:|blob:)/i.test(p) || p.startsWith("/")) continue;
    refs.add(resolve(dirname(resolve(out, f)), p));
  }
}
for (const abs of refs) {
  const rel = relative(out, abs);
  const from = resolve(src, rel);
  if (!existsSync(from)) {
    console.warn(`跳过：assets/web 里没有 ${rel}（引用悬空，preview-sync 会报）`);
    continue;
  }
  mkdirSync(dirname(abs), { recursive: true });
  copyFileSync(from, abs);
  console.log("synced", rel.replace(/\\/g, "/"));
}
