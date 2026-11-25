/**
 * 「删除会话」必须级联到内核的守卫。
 *
 * 症状（用户报）：团队任务所属的会话都删了，任务界面还显示这条任务。
 * 实测：会话索引 12 条 / 账本 8 行指向已不存在的会话 / 内核日志文件 1025 个 / 唤醒 18 条。
 * 根因：删除只有页面侧 `LocalDB.remove`（localStorage 的索引与正文），内核四样东西一样没清
 * —— Mission 账本（任务页读它）、唤醒队列（到点会把这件事叫起来）、会话日志与成员日志。
 *
 * 运行：node scripts/regress/session-purge.test.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const src = readFileSync(join(ROOT, "app/src/main/assets/web/app.js"), "utf8");
const chat = readFileSync(join(ROOT, "web/src/10-chat.js"), "utf8");
const ui = readFileSync(join(ROOT, "web/src/20-ui.js"), "utf8");
const kernel = readFileSync(join(ROOT, "app/src/main/java/ai/deepseek/harness/mobile/kernel/ToolKernel.kt"), "utf8");
const bridge = readFileSync(join(ROOT, "app/src/main/java/ai/deepseek/harness/mobile/bridge/KernelBridge.kt"), "utf8");

const fails = [];
const ok = (name) => console.log(`  ✔ ${name}`);
const bad = (name) => { console.log(`  ✘ ${name}`); fails.push(name); };
const slice = (text, head, end) => {
  const at = text.indexOf(head);
  if (at < 0) return "";
  const stop = end ? text.indexOf(end, at + head.length) : -1;
  return stop < 0 ? text.slice(at, at + 2600) : text.slice(at, stop);
};

// ---- 1) 页面：删除只有一个入口，它同时清两边
const purge = slice(src, "function purgeSession(id) {", "\n  /**");
if (!purge) bad("取不到 purgeSession");
else {
  if (/LocalDB\.remove\(id\)/.test(purge) && /Native\.sessionPurge/.test(purge))
    ok("purgeSession 一次做完两边：页面记录 + 内核级联");
  else bad("purgeSession 少了一半（LocalDB.remove / Native.sessionPurge）");
}
// 三个删除入口（面板 / 滑动确认 / 批量）都不许绕过它直接动 LocalDB.remove
const sites = (ui.match(/LocalDB\.remove\(/g) || []).length;
if (sites === 0) ok("20-ui.js 里没有绕过 purgeSession 的删除点");
else bad(`20-ui.js 还有 ${sites} 处直接 LocalDB.remove —— 删除又不级联了`);
if ((src.match(/LocalDB\.remove\(/g) || []).length === 1) ok("LocalDB.remove 只被 purgeSession 调一次");
else bad("LocalDB.remove 出现了多处调用点（规则要收在一处）");

// ---- 2) 开机清扫：索引没读出来时绝不清
const sweep = slice(src, "function sweepOrphans() {", "\n  /*");
if (!sweep) bad("取不到 sweepOrphans");
else {
  if (/loaded: !LocalDB\._idxBroken/.test(sweep))
    ok("清扫把「索引读没读成功」递给内核（0 场有「干净的空」和「索引读坏了」两种意思）");
  else bad("sweepOrphans 没递 loaded 标记：索引读坏时清扫等于删光用户的东西");
  if (/Native\.sessionSweep/.test(sweep)) ok("清扫走桥 sessionSweep");
  else bad("sweepOrphans 没接上桥");
}
if (/this\._idxBroken = v !== null;/.test(src)) ok("LocalDB 分得清「没有这个 key」与「key 里不是数组」");
else bad("LocalDB 没记索引是否读坏：清扫的安全判据失去依据");
if (/sweepOrphans\(\)/.test(chat)) ok("renderSessions 第一次画列表时触发清扫（那时索引必然已读出）");
else bad("没人调 sweepOrphans：级联落地前攒下的孤儿永远清不掉");

// ---- 3) 内核：级联顺序与清扫判据
const pur = slice(kernel, "fun purgeSession(sid: String): JSONObject {", "\n    /**");
if (!pur) bad("取不到 ToolKernel.purgeSession");
else {
  const atDispose = pur.indexOf("disposeLead");
  const atWakes = pur.indexOf("wakes.dropSession");
  const atMissions = pur.indexOf("missions.dropSession");
  const atFiles = pur.indexOf("sessions.delete");
  if (atDispose >= 0 && atDispose < atWakes && atWakes < atMissions && atMissions < atFiles)
    ok("顺序对：先拆团队（取消在跑的成员）→ 清唤醒 → 清账本 → 删日志");
  else bad(`级联顺序不对（dispose=${atDispose} wakes=${atWakes} missions=${atMissions} files=${atFiles}）`);
  if (/memberSids/.test(pur)) ok("成员会话日志跟着 Lead 一起清（只删 Lead 会留下一堆 #成员 的孤儿文件）");
  else bad("没清成员会话日志");
}
const sweepK = slice(kernel, "fun sweepOrphans(liveIds: List<String>, loaded: Boolean = true): JSONObject {", "\n    /**");
if (!sweepK) bad("取不到 ToolKernel.sweepOrphans");
else {
  if (/会话索引没读成功/.test(sweepK)) ok("内核侧按 loaded 判，不看「列表空不空」下结论");
  else bad("内核 sweepOrphans 没接 loaded 标记");
  if (/substringBefore\('#'\)/.test(sweepK)) ok("成员日志按「Lead 是否还在」决定去留");
  else bad("清扫没处理带 # 的成员会话日志");
}

// ---- 4) 桥：两个接口都在
for (const [name, re] of [["sessionPurge", /fun sessionPurge\(/], ["sessionSweep", /fun sessionSweep\(/]]) {
  if (re.test(bridge)) ok(`桥上有 ${name}`);
  else bad(`桥上缺 ${name}`);
}

console.log(fails.length ? `\n✘ ${fails.length} 项未通过：${fails.join("、")}` : "\n删除会话级联守卫全部通过");
process.exit(fails.length ? 1 : 0);
