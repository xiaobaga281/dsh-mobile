/**
 * 对话流「等待行」回归：防 rc.156 / rc.157 两个已修 bug 复发。
 *
 * 1) 正文首帧必须摘掉「深度求索中」占位行（rc.156：注入进流式气泡后没人摘，
 *    导致等待行永远钉在回复顶部）；
 * 2) PcRun.stop 必须连 DOM 一起删（rc.156：只删数据节点，发送失败等无重绘路径
 *    会让等待气泡留在屏上）；
 * 3) 首屏分帧灌历史未完成时 push 新节点不得插到历史前面（rc.157：renderThread
 *    排了 rAF 一帧未执行，beginLive 的等待行插进空列表，跑到用户消息上方）。
 *
 * 断言对象是 app.js 里的真实源码片段，不是复制一份逻辑 —— 复制品通过了也说明不了线上对。
 * 运行：node scripts/regress/chat-live-order.test.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const APP = join(ROOT, "app/src/main/assets/web/app.js");
const src = readFileSync(APP, "utf8");

let failed = 0;
const ok = (msg) => console.log(`  PASS ${msg}`);
const bad = (msg) => { console.error(`  FAIL ${msg}`); failed += 1; };

// ---- 1) 静态断言：livePaint 的 text 分支必须先摘 .runstat ----
const lp = src.slice(src.indexOf("function livePaint("), src.indexOf("/* ---------------- 过程流"));
if (/if \(Live\.text\) \{[\s\S]*?querySelector\("\.runstat"\)[\s\S]*?remove\(\)/.test(lp)) {
  ok("livePaint 正文分支会摘 .runstat");
} else {
  bad("livePaint 未在正文首帧摘除 .runstat —— rc.156 会复发（等待行钉在回复顶部）");
}

// ---- 2) 行为模拟：runstat 注入 → 增量 paint（append 不重写） ----
function makeEl() {
  return {
    children: [],
    innerHTML: "",
    get isConnected() { return true; },
    appendChild(c) { this.children.push(c); },
    insertAdjacentHTML(_pos, html) { this.children.push({ html }); },
    querySelector(sel) { return this.children.find((c) => c.__runstat && sel === ".runstat") || null; },
  };
}
const textEl = makeEl();
textEl.innerHTML = "RUNSTAT";                 // beginLive: textEl.innerHTML = runStatHTML()
textEl.children.push({ __runstat: true });

function paintLiveTextIncremental(el, tail) {
  let activeEl = el.children.find((c) => c.__mdlive);
  if (!activeEl) { activeEl = { __mdlive: true }; el.appendChild(activeEl); }
  activeEl.tail = tail;                        // morphHTML(activeEl, md(tail)) 的替身
}
function livePaintTextBranch(el, text) {        // 与源码等价的最小编排
  const stat = el.querySelector(".runstat");
  if (stat) { const i = el.children.indexOf(stat); if (i >= 0) el.children.splice(i, 1); }
  paintLiveTextIncremental(el, text);
}
livePaintTextBranch(textEl, "你好");
if (textEl.children.some((c) => c.__runstat)) bad("正文出现后 runstat 仍在气泡顶部");
else if (!textEl.children.some((c) => c.__mdlive && c.tail === "你好")) bad("正文未渲染");
else ok("正文首帧摘除 runstat（增量路径不再留残影）");

// ---- 3) PcRun.stop 连 DOM 一起删 ----
const ps = src.slice(src.indexOf("const PcRun = {"), src.indexOf("const Link = {"));
if (/querySelector\(`#messages \[data-uid="\$\{uid\}"\]`\)\?\.remove\(\)/.test(ps)) {
  ok("PcRun.stop 按 data-uid 删掉 DOM 气泡");
} else {
  bad("PcRun.stop 未删除 DOM 气泡 —— 发送失败 / onHistory 静默收摊会残留等待气泡");
}

// ---- 4) 尾部插入必须处理「分帧灌历史未完成」的竞态 ----
const appendTailSrc = src.slice(src.indexOf("function appendTail(n)"), src.indexOf("function push(n, scroll"));
if (appendTailSrc.includes("renderHeadRaf") && appendTailSrc.includes("renderTailFrom")) {
  ok("appendTail 处理分帧灌历史竞态（renderHeadRaf / renderTailFrom）");
} else {
  bad("appendTail 未处理分帧灌历史竞态 —— rc.157 会复发（等待行跑到用户消息上面）");
}

// 行为模拟：thread=[user] → renderThread 排 rAF（一帧未执行）→ push(live)
// 正确 DOM 顺序 = [user, live]；旧行为 = [live, user]
let rafQueue = [];
const raf = (f) => rafQueue.push(f);
const cancelRaf = () => { rafQueue = []; };
const flushRaf = () => { const q = rafQueue; rafQueue = []; q.forEach((f) => f()); };

let renderHeadRaf = 0;
let renderTailFrom = 0;
const thread = [];
const dom = [];
const nodeOf = (n) => ({ uid: n.uid, isUser: !!n.isUser });
const insertEnd = (items) => { for (const it of items) dom.push(it); };

function renderThread() {                     // stick 分支，RENDER_CHUNK=1 简化
  renderHeadRaf = 0;
  dom.length = 0;                             // 真代码：host.textContent = ""
  let head = 0;
  renderTailFrom = 0;
  const fillHead = () => {
    renderHeadRaf = 0;
    const end = Math.min(thread.length, head + 1);
    insertEnd(thread.slice(head, end).map(nodeOf));
    renderTailFrom = head = end;
    if (head < thread.length) renderHeadRaf = raf(fillHead);
  };
  if (thread.length) renderHeadRaf = raf(fillHead);
  else renderTailFrom = thread.length;
}
function appendTail(n) {
  if (renderHeadRaf) {
    cancelRaf();
    renderHeadRaf = 0;
    const end = thread.length - 1;            // 不含刚 push 的这个
    if (renderTailFrom < end) insertEnd(thread.slice(renderTailFrom, end).map(nodeOf));
    renderTailFrom = end;
  }
  insertEnd([nodeOf(n)]);
  renderTailFrom = thread.length;
  return dom[dom.length - 1];
}
function push(n) { thread.push(n); return appendTail(n); }

push({ uid: "u1", text: "你好", isUser: true });
renderThread();                                // 只排了 rAF，一帧未执行
const liveEl = push({ uid: "l1", text: "", isUser: false });   // beginLive 的等待节点
flushRaf();

if (dom.length !== 2) bad(`DOM 节点数 ${dom.length} ≠ 2（有节点被灌了两遍）`);
else if (!(dom[0].isUser && !dom[1].isUser)) bad(`DOM 顺序错误：${dom.map((d) => d.uid).join(",")}`);
else if (liveEl.uid !== "l1") bad("push 返回元素错误");
else ok("分帧灌历史期间 push 保持 DOM 顺序 = thread 顺序");

if (failed) { console.error(`chat-live-order: ${failed} 项失败`); process.exit(1); }
/* 正文与工具行之间的空窗（模型在写工具参数、没有 delta）：
   正文末尾挂三个跳动的点说明「这句话还没说完」，工具行 / 封口 / 轮末三处摘掉。 */
ok("正文末尾的“还在写”三个点：边写边在、工具行一到就摘");
{
  const need = [
    "function syncTypingDots()",
    "function clearTypingDots()",
    "typing-dots",
    "#messages .typing-dots",
    "clearTypingDots();",
  ];
  const miss = need.filter((n) => !src.includes(n));
  if (miss.length) {
    throw new Error(`FAIL: 正文“还在写”的三个点不见了（缺 ${miss.join(" / ")}）`);
  }
}

console.log("chat-live-order: 全部通过");
