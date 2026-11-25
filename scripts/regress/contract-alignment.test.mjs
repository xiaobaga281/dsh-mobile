/*
 * 两端契约对齐守卫：把「接线断了但线头还在」变成 CI 红灯。
 *
 * 三张对照表，全部按真源取，不靠注释、不靠记忆：
 *   ① @JavascriptInterface 暴露的桥方法 —— 必须被 assets/web 或仓内别处引用；
 *   ② Kotlin 发的事件名 ↔ DSHHost 处理器键（两个方向都要齐）；
 *   ③ app.js 里的静态 `#id` 选择器 —— 必须能在 index.html、模板串或动态 id 赋值里找到。
 *
 * 为什么值得单开一条：这个仓库的残留从来不是「大段注释掉的旧实现」，而是删了 DOM /
 * 改了通道之后留下来的半个调用点。没有机制检查两端，人就记不住。
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

const fails = [];
const ok = (name, cond, detail) => {
  if (cond) console.log(`  ✔ ${name}`);
  else { console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ""}`); fails.push(name); }
};

const rel = (abs) => abs.slice(root.length + 1).replace(/\\/g, "/");
const webFiles = walk(join(root, "app/src/main/assets/web")).filter((p) => /\.(js|html|css)$/.test(p));
const webText = webFiles.map((p) => readFileSync(p, "utf8")).join("\n");
const ktFiles = walk(join(root, "app/src/main/java")).filter((p) => p.endsWith(".kt"));
const ktText = ktFiles.map((p) => readFileSync(p, "utf8")).join("\n");
// 全仓文本：桥方法既可能被前端调，也可能被内核里的 JS 垫片调（PTC 运行时就在自己文件里
// 给模型注入 `DshPtc.fsRead(...)`），所以判定「有人调」要看得见所有语言。
const repoText = [
  ...webFiles, ...ktFiles,
  ...walk(join(root, "scripts")), ...walk(join(root, ".motion")), ...walk(join(root, "app/src/test")),
].filter((p) => /\.(mjs|js|py|sh|kt|html|css|md)$/.test(p)).map((p) => readFileSync(p, "utf8")).join("\n");

/* ---------------- ① 桥方法 ---------------- */
const bridge = [];
for (const p of ktFiles) {
  const src = readFileSync(p, "utf8");
  for (const m of src.matchAll(/@JavascriptInterface\s+(?:@\w+[^\n]*\n\s+)*fun ([A-Za-z][A-Za-z0-9]*)/g)) {
    bridge.push({ name: m[1], file: rel(p) });
  }
}
// 「有人调」只看 JS 侧的文本：assets/web + 开发探针（.motion / scripts，CDP 脚本会直接写
// Native.x(...)）。判定用「点 + 名字」，覆盖 `(Native.missionCancel || fn)(id)` 这种带兜底的写法。
// 例外：内核自己注入的 JS 垫片（PTC 运行时在 PtcRuntime.kt 里写 `DshPtc.fsRead(...)`）也算调用。
const jsFacing = [
  ...walk(join(root, "app/src/main/assets/web")),
  ...walk(join(root, ".motion")),
  ...walk(join(root, "scripts")),
].filter((p) => /\.(js|mjs|html|css|py)$/.test(p) && !/\.test\.mjs$/.test(p))
  .map((p) => readFileSync(p, "utf8")).join("\n");
const declared = new Map();
for (const p of ktFiles) declared.set(rel(p), readFileSync(p, "utf8"));
const uncalled = bridge.filter((b) => {
  const call = new RegExp(`\\.\\s*${b.name}\\b`);
  if (call.test(jsFacing)) return false;
  // 同文件里的引用只有「那行本身是在拼 JS」（DshPtc. / window.）才算调用点，
  // 否则 Kotlin 里 `activity.kernel.missionEvidence.view(...)` 这种同名属性会把它蒙过去
  const ownLines = (declared.get(b.file) || "").split(/\r?\n/).filter((l) => {
    const noComment = !/^\s*(\*|\/\/)/.test(l);
    return noComment && call.test(l) && /(DshPtc\.|window\.)/.test(l);
  });
  return ownLines.length === 0;
});
ok(`桥方法都被调用（共 ${bridge.length} 个）`,
  uncalled.length === 0,
  uncalled.map((b) => `${b.name}@${b.file}`).join(", "));

/* ---------------- ② 事件两端 ---------------- */
// 注释里的 `window.DSHHost.onLink*` 不算发射点：先剥掉 Kotlin 的注释行
const ktCode = ktText.split("\n").filter((l) => !/^\s*(\*|\/\/)/.test(l)).join("\n");
const emitted = new Map();
for (const p of ktFiles) {
  const src = readFileSync(p, "utf8").split("\n").filter((l) => !/^\s*(\*|\/\/)/.test(l)).join("\n");
  for (const m of src.matchAll(/emit(?:Raw|Object)?\(\s*"([A-Za-z][A-Za-z0-9]*)"/g)) {
    const name = m[1].startsWith("on") ? m[1] : `on${m[1]}`;
    if (!emitted.has(name)) emitted.set(name, rel(p));
  }
  for (const m of src.matchAll(/DSHHost(?:&&window\.DSHHost)?\.on([A-Za-z0-9]+)/g)) {
    const name = "on" + m[1];
    if (!emitted.has(name)) emitted.set(name, rel(p));
  }
}
void ktCode;
const appjs = read("app/src/main/assets/web/app.js");
const hostStart = appjs.indexOf("window.DSHHost = {");
const hostBlock = appjs.slice(hostStart, appjs.indexOf("\n  };", hostStart));
const handlers = new Map();
for (const m of hostBlock.matchAll(/^\s{4}(on[A-Za-z][A-Za-z0-9]*)\s*\(/gm)) handlers.set(m[1], "app.js:DSHHost");
for (const m of appjs.matchAll(/window\.DSHHost\.([A-Za-z][A-Za-z0-9]*)\s*=/g)) handlers.set(m[1], "app.js:赋值挂载");
ok("Kotlin 发的事件都有处理器",
  [...emitted.keys()].every((n) => handlers.has(n)),
  [...emitted].filter(([n]) => !handlers.has(n)).map(([n, f]) => `${n}@${f}`).join(", "));
ok("DSHHost 上的处理器都有发射点",
  [...handlers.keys()].every((n) => emitted.has(n)),
  [...handlers].filter(([n]) => !emitted.has(n)).map(([n, f]) => `${n}@${f}`).join(", "));

/* ---------------- ③ DOM 选择器 ---------------- */
const htmlIds = new Set([...read("app/src/main/assets/web/index.html").matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const jsTemplateIds = new Set([...appjs.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
const jsAssignedIds = new Set([...appjs.matchAll(/\.id\s*=\s*"([\w-]+)"/g)].map((m) => m[1]));
// 行描述器（`{ id: "swCompanion", ... }`）由通用渲染器写成 id="${row.id}"，也算存在
const jsDescriptorIds = new Set([...appjs.matchAll(/\bid:\s*"([\w-]+)"/g)].map((m) => m[1]));
const known = new Set([...htmlIds, ...jsTemplateIds, ...jsAssignedIds, ...jsDescriptorIds]);
const used = new Set();
for (const m of appjs.matchAll(/(?:querySelector(?:All)?\(\s*|[\$(]\s*)"#([\w-]+)"/g)) used.add(m[1]);
// 以 - / _ 结尾的是动态前缀（"#genUrl_" + id），不参与静态比对
const missing = [...used].filter((id) => !known.has(id) && !/[-_]$/.test(id));
ok(`app.js 选的 #id 都存在于页面或模板（共 ${used.size} 个）`,
  missing.length === 0, missing.join(", "));

/* ---------------- ④ HTML 里没人引用的 id / 未用的 symbol ---------------- */
const htmlText = read("app/src/main/assets/web/index.html");
// id 的引用方不只是前端：CDP 回归脚本（scripts/emulator/*.py）与文档也会按 #id 取元素。
// 只数「前端三件套 + 探针脚本 + docs」里的整词出现，>1 次（除了它自己的定义）才算有人用。
const idScope = [
  ...walk(join(root, "app/src/main/assets/web")),
  ...walk(join(root, "scripts")), ...walk(join(root, ".motion")),
  ...walk(join(root, "docs")),
].filter((p) => /\.(js|mjs|html|css|py|md|json)$/.test(p) && !/\.test\.mjs$/.test(p)).map((p) => readFileSync(p, "utf8")).join("\n");
const deadIds = [...new Set(htmlIds)].filter((id) => {
  if (/^i-/.test(id)) return false;              // symbol 由下面那条专门管
  // 每个屏都同时带 `id="screen-x"` 与 `data-screen="x"`：CSS（#screen-files 的头部留白）
  // 与自动化都按 id 挂钩，这是约定不是残留
  if (/^screen-/.test(id)) return false;
  const hits = (idScope.match(new RegExp(`\\b${id}\\b`, "g")) || []).length;
  return hits <= 1;
});
ok("index.html 没有没人引用的 id", deadIds.length === 0, deadIds.join(", "));
void htmlText;
const symbols = [...htmlText.matchAll(/<symbol id="([\w-]+)"/g)].map((m) => m[1]);
// 图标是动态拼的（`href="#i-${name}"`、`icon: "i-term"`），所以按「裸名字有没有被提过」判
const deadSymbols = symbols.filter((s) => {
  const uses = (webText.match(new RegExp(`["'#]${s}["']`, "g")) || []).length;
  return uses === 0;
});
ok("SVG sprite 里没有从未被引用的 symbol", deadSymbols.length === 0, deadSymbols.join(", "));

/* ---------------- ⑤ 类名两端：JS/HTML 用到的 act-ico 变体必须在 CSS 里有定义 ---------------- */
// 浅色模式下「新建电脑会话」的图标看不见就是这个：`.act-ico` 底色靠变类名给，
// 少一个 `.green` 就等于「白图标贴在白弹层上」—— 不报错，只是看不见。
const cssText = read("app/src/main/assets/web/styles.css");
const usedTones = new Set();
for (const m of appjs.matchAll(/act-ico ([a-z]+)/g)) usedTones.add(m[1]);
for (const m of htmlText.matchAll(/act-ico ([a-z]+)/g)) usedTones.add(m[1]);
const missingTones = [...usedTones].filter((t) => !cssText.includes(`.act-ico.${t}`));
ok(`用到的 act-ico 变体都有 CSS 定义（${[...usedTones].join("/")}）`,
  missingTones.length === 0, missingTones.map((t) => `.act-ico.${t} 未定义`).join(", "));

console.log(fails.length ? `\n✘ ${fails.length} 项未通过：${fails.join("、")}` : "\n两端契约对齐守卫全部通过");
process.exit(fails.length ? 1 : 0);
