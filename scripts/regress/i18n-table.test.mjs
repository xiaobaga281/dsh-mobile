/**
 * i18n 表自检：一个中文串只能有一个说法。
 *
 * 为什么要这条：表是 JS 字面量，同一个键写两次就是**后者覆盖前者**，不报错。
 * 曾经有 8 个键各带着两个不同译文（模型 / 附件 / 新建任务 / 连接电脑 / 会话记忆 /
 * 计划 / 原生通透面板 / 创建失败：），等于一部分界面拿到的是当初为别处写的那个词
 * —— 英文界面上「文件页签」显示成 "Attach"（按钮的说法），「新建任务」的面板标题
 * 显示成 "New job"。现在八个都统一成一处，本条守卫防止再被写回两份。
 *
 * 只判「同键不同译文」：同键同译文的重复条目无害（后者与前相同），不当失败，
 * 免得为了绿去动用户可见文案。
 *
 * 运行：node scripts/regress/i18n-table.test.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = readFileSync(join(ROOT, "web/src/00-app.js"), "utf8");

const start = src.indexOf("const I18N = {");
const end = src.indexOf("const I18N_RX");
if (start < 0 || end < 0) throw new Error("FAIL: 找不到 I18N 表的边界（改名了？先把这条守卫改对再来）");
const body = src.slice(start, end);

const pairs = [...body.matchAll(/"([^"]{1,400})"\s*:\s*"([^"]{1,400})"/g)].map((m) => [m[1], m[2]]);
const byKey = new Map();
for (const [k, v] of pairs) {
  if (!byKey.has(k)) byKey.set(k, new Set());
  byKey.get(k).add(v);
}
const conflict = [...byKey.entries()].filter(([, vs]) => vs.size > 1);

let fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { console.log("  ✓ " + msg); return; }
  console.log("  ✗ " + msg + (extra ? "  ← " + JSON.stringify(extra) : ""));
  fail++;
};

ok(pairs.length > 500, `词条读到了（${pairs.length} 对 / ${byKey.size} 个键）`);
ok(conflict.length === 0, "没有「同一个中文串两个英文说法」的键",
  conflict.slice(0, 6).map(([k, vs]) => k + "→" + [...vs].join("|")));

// 这八个是本轮统一过的，写死期望值：谁再顺手加一份别的译文，立刻红
const CANON = {
  "计划": "Plan", "模型": "Models", "连接电脑": "Connect computer", "原生通透面板": "Native glass panel",
  "新建任务": "New task", "附件": "Attachments", "会话记忆": "Chat memory", "创建失败：": "Create failed: ",
};
for (const [k, v] of Object.entries(CANON)) {
  const got = byKey.get(k);
  ok(got && got.size === 1 && got.has(v), `「${k}」= "${v}"`, got ? [...got] : "缺词条");
}

// 文件页签与输入框那颗按钮不再抢同一个中文串：按钮的无障碍名是「添加附件」
const html = readFileSync(join(ROOT, "app/src/main/assets/web/index.html"), "utf8");
ok(/id="btnAttach"[^>]*aria-label="添加附件"/.test(html),
  "＋ 按钮的无障碍名用「添加附件」（「附件」留给文件页签，一处一名）");
ok(/"添加附件": "Add attachment"/.test(src), "「添加附件」有词条");

console.log(`\n结果：i18n 表 ${byKey.size} 个键，冲突 ${conflict.length} 个${fail ? " / 有失败" : " / 全绿"}\n`);
process.exit(fail ? 1 : 0);
