/**
 * 会话流分桶回归：防 rc.134 的「串号」bug 复发。
 *
 * 背景：`app.js` 的 `thread` 是「当前会话那一份的引用」，不是全局唯一数组。
 * 旧实现 `saveShot(state.sessionId, shotNode(thread))` 用「当前渲染的全局数组」
 * 写「当前 sessionId 的槽位」，两者任何一瞬间不同步就串号（点 A 看到 B，且不自愈）。
 *
 * 本脚本钉住四件事：
 *   [1] 切会话互不影响，切回原会话内容完好；
 *   [2] persistThread 的身份自检——thread 与 sessionId 不符必须跳过（宁可漏存，绝不写错）；
 *   [3] 淘汰只留最近 8 份，正在跑的（Live 指着）与当前这份永不淘汰；
 *   [4] attachBlank / attachThread / adoptThread 的语义（幂等、__sid 标记、接管即 loaded）。
 *
 * 关键：直接抽取 app.js 里的真实源码片段来跑，不是复制一份逻辑。
 * 运行：node scripts/regress/session-bucket.test.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const src = readFileSync(join(ROOT, "app/src/main/assets/web/app.js"), "utf8");

function cut(from, to) {
  const i = src.indexOf(from);
  if (i < 0) throw new Error("找不到片段起点: " + from.slice(0, 40));
  const j = src.indexOf(to, i);
  if (j < 0) throw new Error("找不到片段终点: " + to.slice(0, 40));
  return src.slice(i, j + to.length);
}

// 分桶设施 + 生命周期 API：const BUCKET_MAX 到 adoptThread 结束
const bucketBlock = cut("const BUCKET_MAX = 8;", "  function adoptThread(key) {\n    const b = attachThread(key);\n    b.loaded = true;\n    return b;\n  }");
// 落盘：persistThread 全文（终点取紧随其后的 schedulePaint 注释块）
const PERSIST_TAIL = "\n  }\n\n  /** 流式绘制：按帧画，另加一个兜底定时器。";
const persistBlock = cut("function persistThread(sync) {", PERSIST_TAIL).replace(PERSIST_TAIL, "\n  }");

// ---- stub 环境 ----
const saved = {};
const sessions = new Set(["A", "B", "C"]);
const state = { sessionId: "A", teamView: null };
const Live = { sessionId: "" };
const LocalDB = {
  get: (id) => (sessions.has(id) ? { id } : null),
  saveShot: (id, shot) => { saved[id] = shot; },
};
const shotNode = (arr) => arr.map((n) => n.text);   // 简化：快照 = 文本数组
const currentMode = () => "local";
const requestIdleCallback = (fn) => fn();           // 同步执行，等价于「立刻跑」
const window = { requestIdleCallback };

const api = new Function(
  "state", "Live", "LocalDB", "shotNode", "currentMode", "requestIdleCallback", "window",
  `${bucketBlock}\n${persistBlock}\n
   return {
     get thread() { return thread; },
     attachThread, attachBlank, adoptThread, bucketOf, buckets, persistThread,
   };`,
)(state, Live, LocalDB, shotNode, currentMode, requestIdleCallback, window);

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass += 1; console.log("  ✓ " + name); }
  else { fail += 1; console.log("  ✗ " + name + (extra !== undefined ? "  →  " + JSON.stringify(extra) : "")); }
};

console.log("\n[1] 切会话互不影响（rc.134 修复的核心）");
api.attachThread("A");
api.thread.push({ text: "A-1" }, { text: "A-2" });
ok(api.thread.length === 2, "A 有 2 条");
api.attachThread("B");
api.thread.push({ text: "B-1" });
ok(api.thread.length === 1, "切到 B 后只剩 B 的 1 条（不继承 A）");
ok(api.bucketOf("A").arr.length === 2, "A 的桶原样保留 2 条", api.bucketOf("A").arr.length);
api.attachThread("A");
ok(api.thread.length === 2 && api.thread[0].text === "A-1", "切回 A 内容完好");

console.log("\n[2] 落盘身份自检：thread 与 sessionId 不符时必须跳过");
{
  api.attachThread("B");
  state.sessionId = "A";
  delete saved.A;
  api.persistThread();
  ok(!saved.A, "身份不符 → 没写 A（宁可漏存，绝不写错）", saved.A);
  state.sessionId = "B";
  api.persistThread();
  ok(Array.isArray(saved.B) && saved.B[0] === "B-1", "身份相符 → 正常落盘 B", saved.B);
}

console.log("\n[3] 淘汰策略：只留最近 8 份，正在跑的与当前这份都不淘汰");
for (let i = 0; i < 12; i += 1) {
  const k = "S" + i;
  sessions.add(k);
  api.attachThread(k);
  api.thread.push({ text: k + "-1" });
  api.bucketOf(k).loaded = true;
}
api.attachThread("A");
ok(api.buckets.size <= 8, "桶数量被限制在 8 以内", api.buckets.size);
ok(api.buckets.has("A"), "当前会话的桶一定在");
state.sessionId = "A";
Live.sessionId = "S11";
api.attachThread("S11");
api.thread.push({ text: "S11-2" });
for (let i = 0; i < 6; i += 1) { sessions.add("T" + i); api.attachThread("T" + i); }
ok(api.buckets.has("S11") || !Live.sessionId, "正在跑的会话桶不被淘汰（Live 还指着它）", [...api.buckets.keys()]);
Live.sessionId = "";

console.log("\n[4] 空桶与 attach 幂等");
api.attachBlank("");
ok(api.thread.__sid === "" && api.thread.length === 0, "attachBlank → 空 key 的空白流（不继承内容）");
api.attachThread("A");
const ref1 = api.thread;
api.attachThread("A");
ok(api.thread === ref1, "重复 attach 同一会话 → 同一个数组引用（幂等）");
ok(ref1.__sid === "A", "桶带身份标记 __sid");

console.log("\n[5] adoptThread：新建会话接管后不需要再从库灌");
const nb = api.adoptThread("NEW");
ok(nb.loaded === true && nb.arr === api.thread, "adoptThread 直接标 loaded 并切过去");

console.log("\n[6] sync=true：页面转隐藏时不等空闲，立刻落盘");
{
  const deferred = [];
  const savedSync = {};
  const apiSync = new Function(
    "state", "Live", "LocalDB", "shotNode", "currentMode", "requestIdleCallback", "window",
    `${bucketBlock}\n${persistBlock}\n return { persistThread, attachThread, get thread() { return thread; } };`,
  )(
    { sessionId: "A", teamView: null }, { sessionId: "" },
    { get: (id) => ({ id }), saveShot: (id, shot) => { savedSync[id] = shot; } },
    (arr) => arr.map((n) => n.text), () => "local",
    (fn) => deferred.push(fn), { requestIdleCallback: (fn) => deferred.push(fn) },
  );
  apiSync.attachThread("A");
  apiSync.thread.push({ text: "A-1" });
  apiSync.persistThread();
  ok(!savedSync.A && deferred.length === 1, "默认路径仍然挪到空闲时段（流式期间不卡主线程）");
  apiSync.persistThread(true);
  ok(!!savedSync.A, "sync=true 立刻落盘（隐藏页里空闲回调可能永不触发）", savedSync.A);
}

/* [5] 页面侧实体 id 必须同毫秒也不撞。
   id 就是 payload 的 key（`dsh.local.sess.<id>`）：撞了以后索引里两条、正文只有一份，
   后写的把前面的盖掉 —— 用户表现为「我明明开了两场，点进去是同一场」。
   实测（探针一次建 9 场）：屏幕 49 行 / 43 个唯一 id。 */
ok(/function uid\(prefix\)/.test(src) && /uidSeq = \(uidSeq \+ 1\)/.test(src),
  "有 uid() 且带自增序号（同毫秒也分得开）");
for (const p of ['id: uid("l")', 'id: uid("j")', 'pid: uid("p")']) {
  ok(src.includes(p), `实体 id 走 uid()：${p}`);
}
for (const bad of [/"l" \+ Date\.now\(\)\.toString\(36\)/, /"j" \+ Date\.now\(\)\.toString\(36\)/, /pid: "p" \+ Date\.now\(\)\.toString\(36\)/]) {
  ok(!bad.test(src), `没有「只拼时间」的实体 id：${bad}`);
}

/* [6] 会话页的「工作区」列表 = 全部未删除的会话。
   rc.210 曾把「最近」当成主列表、从工作区里摘走那 3 条（自造判据「整屏一条只出现一次」）。
   真机实测（退回那份包重跑探针）：库里三场时 最近=3 / 工作区行=0，屏幕上只剩一句
   「还没有归档到工作区的会话」—— 用户以为会话被删了。快捷入口不许搬走任何一条。 */
{
  const at = src.indexOf("function renderSessions(");
  const body = at < 0 ? "" : src.slice(at, src.indexOf("\n  /**", at) > 0 ? src.indexOf("\n  /**", at) : at + 4000);
  ok(at >= 0, "取到 renderSessions 的函数体");
  ok(/for \(const s of matched\) \{/.test(body) && !/inRecent/.test(body),
    "工作区分组遍历全部 matched，没有「最近」排除集");
  ok(!/"还没有归档到工作区的会话"/.test(src),
    "没有「还没有归档到工作区的会话」这句界面文案（产品里没有归档，会话只有直接删除）");
  ok(!/No chats archived to the workspace yet/.test(src), "i18n 表里也没有这句的英文残留");
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
