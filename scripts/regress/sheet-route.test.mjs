// 回归：#sheet 的点击委托不能出现「两个监听器认领同一个节点」（rc.202）。
// 病根：`#sheet` 上挂了 4 个并列 click 监听器，每个 emit 都是 `closest("[data-*]")`
// 命中就跑，`return` 只结束自己那一个。于是同一个节点会被两处各处理一遍。
// 历史上两次都是这个结构：
//   · rc.138：`[data-pick]` 前段命中即 return，后段仍跑 → 点会话勾选弹出模型配置；
//   · rc.202：`[data-sess-del]` 前段直接 LocalDB.remove，后段才弹「确认删除」→ 确认形同虚设。
// 这条用例把「选择器归属」变成硬约束：谁认领了，别人就不许再认领。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// 前端源已按 web/build.json 切成多个 part：按拼接顺序读全量（与产物逐字节一致）
const src = JSON.parse(readFileSync(join(root, "web/build.json"), "utf8")).parts
  .map((p) => readFileSync(join(root, "web/src", p), "utf8"))
  .join("");

// 已知的、**有意**双认领的选择器（必须写清为什么）。目前一条都没有，出现就得先想清楚。
const KNOWN_OVERLAPS = new Map([]);

// 扫描范围含 `#sheetBody` 自己的委托：它认领 [data-team-*] / [data-mission-*] / [data-task-x]
// / [data-storage-clear]，只查 `#sheet` 上那几个监听器的话，跨容器的双认领查不出来。
const marks = [...src.matchAll(/\$\("#sheet(?:Body)?"\)\.addEventListener\("click"/g)].map((m) => m.index);
if (marks.length === 0) throw new Error("FAIL: 找不到 #sheet 的点击委托 —— 选择器归属无从校验");

// 每个监听器的边界：下一个监听器起点，或（最后一个）文件末尾前 4000 字符内的收敛点
const bodies = marks.map((at, i) => src.slice(at, marks[i + 1] ?? src.length));
if (bodies.length > 6) {
  throw new Error(`FAIL: 弹层上有 ${bodies.length} 个 click 监听器 —— 每多一个，重复认领的面积就再大一圈`);
}

const sets = bodies.map((b) => new Set([...b.matchAll(/closest\("(\[[^"]+\]|#[^"]+)"\)/g)].map((m) => m[1])));

// 1) 两两交集必须为空
const dups = [];
for (let i = 0; i < sets.length; i += 1) {
  for (let j = i + 1; j < sets.length; j += 1) {
    for (const sel of sets[i]) {
      if (!sets[j].has(sel)) continue;
      if (KNOWN_OVERLAPS.has(sel)) continue;
      dups.push(`${sel}（监听器 ${i + 1} 与 ${j + 1}）`);
    }
  }
}
if (dups.length) {
  throw new Error(
    `FAIL: 同一个节点被多个监听器认领：${dups.join("、")}\n` +
    "  这会让一次点击跑两遍逻辑（rc.138 点 A 弹 B / rc.202 删除绕过确认都是这么来的）。\n" +
    "  修法：只留一处认领，另一处删掉；确实需要双响应的写进 KNOWN_OVERLAPS 并注明理由。",
  );
}

// 2) rc.138 的具体教训：会话多选取消勾选用 [data-pick]，模型选择必须用 [data-pick-model]
const pickClaims = bodies.filter((b) => /closest\("\[data-pick\]"\)/.test(b)).length;
if (pickClaims !== 1) {
  throw new Error(`FAIL: [data-pick] 被 ${pickClaims} 个监听器认领（应恰好 1 个：会话多选）—— rc.138 会复发`);
}
if (/closest\("\[data-pick\]"\)/.test(src) && !/data-pick-model/.test(src)) {
  throw new Error("FAIL: 模型选择列表又用回了 [data-pick] —— 必须用 [data-pick-model]，否则点会话勾选会打开模型配置");
}

// 3) 破坏性动作必须只有一个入口，且不能是「直接删」
const delClaims = bodies.filter((b) => /closest\("\[data-sess-del\]"\)/.test(b)).length;
if (delClaims !== 1) {
  throw new Error(`FAIL: [data-sess-del] 被 ${delClaims} 个监听器认领（应恰好 1 个）—— 删除会跑两遍或绕过确认`);
}
const delBody = bodies.find((b) => /closest\("\[data-sess-del\]"\)/.test(b));
if (/LocalDB\.remove\(id\)/.test(delBody) && !/sheetConfirmDeleteSession/.test(delBody)) {
  throw new Error("FAIL: [data-sess-del] 又变成「点了就删」—— 必须先进确认面板（sheetConfirmDeleteSession）");
}

console.log(`✔ sheet-route: ${sets.length} 个监听器、${new Set(sets.flatMap((s) => [...s])).size} 个选择器，归属互不重叠；删除仍走确认`);
