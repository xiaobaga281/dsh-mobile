/**
 * 对话内搜索回归：防 rc.159 / rc.160 / rc.161 三个已修 bug 复发。
 *
 * 1) 搜索范围只到正文（`.assistant-text` / `.bubble-user`）——rc.160 之前扫整条
 *    `.msg`，「已完成，用时」「思考」摘要、「复制·朗读·tokens」都算命中；
 * 2) 关闭态硬兜底 `sheetHideHard()` 必须擦掉内联位移与状态类 ——rc.160 之前
 *    下拉关闭手势在面板已关时直接 return，面板冻在屏底露出顶边；
 * 3) 拖拽 onEnd 必须走 sheetHideHard 收尾（漏口堵住）；
 * 4) `.hl` 必须无色、红色只在 `.hl-on` ——rc.161 之前命中整片红；
 *    且 UA `<mark>` 默认黄底必须被 `background:none` 覆盖（rc.159 的浅绿底）。
 * 5) `syncCurMark()` 只给当前这一处搬 `hl-on`，切换时旧的立刻褪色。
 *
 * 运行：node scripts/regress/search-highlight.test.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WEB = join(ROOT, "app/src/main/assets/web");
const src = readFileSync(join(WEB, "app.js"), "utf8");
const css = readFileSync(join(WEB, "styles.css"), "utf8");

let failed = 0;
const ok = (msg) => console.log(`  PASS ${msg}`);
const bad = (msg) => { console.error(`  FAIL ${msg}`); failed += 1; };

function pick(startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error(`找不到片段起点: ${startMarker}`);
  const j = src.indexOf(endMarker, i);
  if (j < 0) throw new Error(`找不到片段终点: ${endMarker}`);
  return src.slice(i, j);
}

// ---- 1) applySearch 只收集正文命中 ----
const applySrc = pick("    applySearch() {", "\n    wrapMatches(");
const nodes = {
  ".assistant-text": [
    { textContent: "你好！有什么我可以帮你的吗？" },
    { textContent: "这一条没有那个词" },
  ],
  ".bubble-user": [{ textContent: "你好" }],
};
let requested = null;
const $ = () => ({ value: "你好" });
const $$ = (sel) => {
  requested = sel;
  return Object.keys(nodes).filter((k) => sel.includes(k)).flatMap((k) => nodes[k]);
};
const SearchMode = { on: false, query: "" };
const syncModeBar = () => {};

const ChatExtras = new Function(
  "$", "$$", "SearchMode", "syncModeBar",
  "return {" + applySrc + "};",
)($, $$, SearchMode, syncModeBar);
ChatExtras.hits = [];
ChatExtras.hitIndex = -1;
ChatExtras.clearMarks = function () { this.marks = []; };
ChatExtras.wrapMatches = () => [];
ChatExtras.syncCurMark = () => {};
ChatExtras.applySearch();

if (!/\.assistant-text/.test(requested) || !/\.bubble-user/.test(requested)) {
  bad(`搜索范围没收窄到正文，选择器=${requested}`);
} else if (/\.msg\b/.test(requested)) {
  bad("仍在扫整条 .msg（界面文字会被算进命中）");
} else if (ChatExtras.hits.length !== 2) {
  bad(`命中数应为 2，实际 ${ChatExtras.hits.length}`);
} else {
  ok("搜索只扫正文（assistant-text + bubble-user）");
}

// ---- 2) sheetHideHard 擦干净状态 ----
const hideSrc = pick("  function sheetHideHard() {", "\n  }") + "\n  }";
const cls = new Set(["is-on"]);
const sheetEl = {
  classList: {
    remove: (...ns) => ns.forEach((n) => cls.delete(n)),
    contains: (n) => cls.has(n),
  },
  style: { pointerEvents: "none" },
};
const cleared = [];
const hide = new Function(
  "$", "window", "sheetHideHardState",
  "let sheetOpen = sheetHideHardState.sheetOpen, sheetClosing = sheetHideHardState.sheetClosing;" +
  hideSrc +
  "\n return () => { sheetHideHard(); return { sheetOpen, sheetClosing }; };",
);
const after = hide(() => sheetEl, { Motion: { clear: (el) => cleared.push(el) } },
  { sheetOpen: true, sheetClosing: true })();

if (cleared.length !== 2) bad(`内联样式没被 Motion.clear 擦掉（${cleared.length}）`);
else if (cls.size) bad(`状态类没摘干净: ${[...cls].join(",")}`);
else if (sheetEl.style.pointerEvents !== "") bad("pointerEvents 没复位");
else if (after.sheetOpen || after.sheetClosing) bad("状态位没复位");
else ok("关闭态硬兜底擦干净内联位移 / 状态类");

// ---- 3) 拖拽 onEnd 的漏口已堵 ----
if (/if \(!sheetOpen \|\| sheetClosing\) \{ sheetHideHard\(\); return; \}/.test(src)) {
  ok("拖拽 onEnd 改走 sheetHideHard 收尾");
} else {
  bad("拖拽 onEnd 仍会在面板已关时直接 return（面板会冻在屏底露顶边）");
}

// ---- 4) CSS：关闭态不可见 + 只有当前命中变红 ----
if (!/\.sheet:not\(\.is-on\):not\(\.is-closing\)\s*\{\s*visibility:\s*hidden/.test(css)) {
  bad("缺少关闭态 visibility:hidden 兜底");
} else if (/\.hl\s*\{[^}]*color:\s*#(?!inherit)/.test(css)) {
  bad(".hl 仍然自带颜色，命中会整片红");
} else if (!/\.hl\s*\{[^}]*color:\s*inherit/.test(css)) {
  bad(".hl 没有继承文字色");
} else if (!/\.hl\s*\{[^}]*background:\s*none/.test(css)) {
  bad(".hl 缺 background:none（<mark> 的 UA 黄底会漏出来）");
} else if (!/\.hl-on\s*\{[^}]*#d13a30/.test(css)) {
  bad(".hl-on 不是红色");
} else if (/hl-cur/.test(css)) {
  bad("styles.css 还留着已废弃的 .hl-cur");
} else {
  ok("关闭态不画 + 只有当前命中是红色（.hl 无色 / .hl-on 红）");
}

// ---- 5) syncCurMark 只给当前这一处搬 hl-on ----
const syncSrc = pick("    syncCurMark() {", "\n    }") + "\n    }";
const marks = [0, 0, 1, 1, 2].map((midx) => {
  const set = new Set(["hl"]);
  return {
    __midx: midx,
    classList: {
      toggle: (c, on) => (on ? set.add(c) : set.delete(c)),
      has: (c) => set.has(c),
    },
    set,
  };
});
const sync = new Function("marks", "return {" + syncSrc + "};")(marks);
sync.marks = marks;
sync.hitIndex = 1;
sync.syncCurMark();
const on = marks.filter((m) => m.set.has("hl-on"));
if (on.length !== 2 || on.some((m) => m.__midx !== 1)) {
  bad(`上色集合不对（应只有 __midx=1 的两处），实际 ${on.map((m) => m.__midx).join(",")}`);
} else {
  sync.hitIndex = 2;
  sync.syncCurMark();
  if (marks.filter((m) => m.set.has("hl-on")).length !== 1) bad("切换后旧命中没褪色");
  else if (!/wrapMatches\(el, q\)/.test(src)) bad("wrapMatches 仍带 isCur 参数");
  else ok("切换命中时只有当前这一处变红，旧的立刻褪色");
}

if (failed) { console.error(`search-highlight: ${failed} 项失败`); process.exit(1); }
console.log("search-highlight: 全部通过");
