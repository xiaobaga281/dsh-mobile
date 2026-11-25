/**
 * 任务页操作面板与「删除这一条」的回归守卫。
 *
 * 症状（用户报「任务界面的任务无法删除」，实测 12 行全打不开）：列表早就改成
 * Mission 账本优先，`openJobSheet` 却还在两份旧注册表里 find —— `jobsList()` 是进程内存、
 * 重启即空，`team:` 这类 kind 干脆没有分支，找不到就什么都不弹；删除那一路又只认
 * `scheduleDelete` + `LocalJobs.remove`，两边都没动账本，toast 还报「已删除记录」。
 *
 * 运行：node scripts/regress/jobs-sheet.test.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const bundle = join(ROOT, "app/src/main/assets/web/app.js");
const bridge = join(ROOT, "app/src/main/java/ai/deepseek/harness/mobile/bridge/KernelBridge.kt");
const src = readFileSync(bundle, "utf8");
const kt = readFileSync(bridge, "utf8");

const fails = [];
const ok = (name) => console.log(`  ✔ ${name}`);
const bad = (name) => { console.log(`  ✘ ${name}`); fails.push(name); };

function slice(text, head, end) {
  const at = text.indexOf(head);
  if (at < 0) return "";
  const stop = end ? text.indexOf(end, at + head.length) : -1;
  return stop < 0 ? text.slice(at, at + 3000) : text.slice(at, stop);
}

// ---- 1) 面板入口只认账本投影
const sheet = slice(src, "const openJobSheet = (el) => {", "\n    attachLongPress");
if (!sheet) bad("取不到 openJobSheet");
else {
  if (/findJobRow\(/.test(sheet)) ok("openJobSheet 从 findJobRow() 取行（与列表同一份账本投影）");
  else bad("openJobSheet 还在自己找行 —— 列表换成账本优先后，这里会永远找不到、面板什么都不弹");
  for (const stale of ["kernelJobs().find", "kernelSchedules().find", "LocalJobs.all().find"]) {
    if (!sheet.includes(stale)) ok(`openJobSheet 不再直接读旧注册表：${stale}`);
    else bad(`openJobSheet 里还留着 ${stale}（进程重启后 jobsList 是空的，行就打不开）`);
  }
}

// ---- 2) 行查找与删除派发各只有一处
if ((src.match(/function findJobRow\(/g) || []).length === 1) ok("findJobRow 只定义一处");
else bad("findJobRow 定义不止一处");
const disp = slice(src, "function deleteMissionRow(row) {", "\n  /**");
if (!disp) bad("取不到 deleteMissionRow");
else {
  if ((src.match(/function deleteMissionRow\(/g) || []).length === 1) ok("「删除这一条」的派发只写一遍");
  else bad("deleteMissionRow 定义不止一处 —— 规则又要分叉了");
  for (const [name, re] of [
    ["定时任务走 scheduleDelete", /scheduleDelete/],
    ["账本历史走 missionRemove", /missionRemove/],
    ["本地记录走 LocalJobs.remove", /LocalJobs\.remove/],
  ]) if (re.test(disp)) ok(name); else bad(`deleteMissionRow 少了这一档：${name}`);
  // 团队任务不在这里拒绝 —— 它压根不给按钮（见第 3 段），权威判据在内核 missionRemove 里
  if (!/toast\(/.test(disp)) ok("派发只回 {ok,msg}，文案交给调用方（不在两处各写一句 toast）");
  else bad("deleteMissionRow 里自己弹 toast —— 调用方就无法决定「删不动时面板要不要留着」");
}
if ((src.match(/data-job-del=/g) || []).length >= 3) ok("任务页与 Mission 抽屉都用同一个删除入口 data-job-del");
else bad("data-job-del 出现次数异常：抽屉与任务页应共用同一个按钮属性（以前抽屉另写一个 data-mission-del）");
if (!/data-mission-del/.test(src)) ok("旧的 data-mission-del 入口已删干净（不留第二套派发）");
else bad("还留着 data-mission-del：删除又有了第二条路");

// ---- 3) 团队任务那一档不给「按了没用」的删除按钮
// 只在 sheetJobActions 里找：`kind === "team"` 这个串在 readMissionLedger 的状态映射里也有，
// 整包里搜会命中那一处，判出来的就不是面板的分支了
const sheetActions = slice(src, "const sheetJobActions = (row) => {", "\n  /**");
const team = slice(sheetActions, '} else if (kind === "team") {', "} else {");
if (!team) bad("取不到 sheetJobActions 的 team 分支");
else {
  if (!/data-job-del/.test(team)) ok("团队任务行不给删除按钮（投影不该能删权威）");
  else bad("团队任务行还挂着删除按钮：这里删了也会被任务板同步加回来 = 按了没用");
  if (/data-team-board/.test(team)) ok("团队任务行给「打开团队面板」的去处");
  else bad("团队任务行没有跳去任务板的入口");
}

// ---- 4) 内核：只删已落定的，团队一律拒绝
if (/fun missionRemove\(/.test(kt)) ok("桥上有 missionRemove");
else bad("桥上没有 missionRemove：页面的删除派发只能删本地记录，账本历史删不掉");
const mr = slice(kt, "fun missionRemove(", "@JavascriptInterface");
if (mr) {
  if (/STATE_SETTLED/.test(mr)) ok("missionRemove 拒绝删还在进行中的（不然记录没了、进程还在跑）");
  else bad("missionRemove 没判 state：一次点击能把在跑的任务从账本抹掉");
  if (/team:/.test(mr)) ok("missionRemove 明确拒绝 team:（权威在任务板）");
  else bad("missionRemove 没挡 team:：删了会被 onTeamTask 同步回来，表现为「删不掉」");
} else bad("取不到 missionRemove 的函数体");
if (!/fun jobKill\(/.test(kt)) ok("随派发收口一起删掉了没人调的 jobKill 桥方法");
else bad("jobKill 还挂在桥上（页面已不再调它 —— 桥方法要么接上要么删）");

console.log(fails.length ? `\n✘ ${fails.length} 项未通过：${fails.join("、")}` : "\n任务页操作守卫全部通过");
process.exit(fails.length ? 1 : 0);
