/**
 * 「思考那一行」与「团队角标」的会话归属回归。
 *
 * 两个用户连着报过第二次的缺陷，根因都不在样式层：
 * 1) 收起时那一行只剩「思考」两个字 —— thinkSummary 取的是「末段」，而模型每段都以空行收尾，
 *    于是每个段落边界（和整段结束时）末段是空的，摘要被清空；
 * 2) 新建会话后顶栏团队角标还挂着旧数字 —— 队友在后台每步都推 team 快照，
 *    页面不看快照属于哪场会话就 state.team = ev.team。
 *
 * 这里既断言「代码接线」，也真的把产物里的 thinkSummary 取出来跑（复制一份逻辑通过了
 * 说明不了线上对）。运行：node scripts/regress/think-line-summary.test.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const src = readFileSync(join(ROOT, "app/src/main/assets/web/app.js"), "utf8");

let failed = 0;
const ok = (m) => console.log(`  PASS ${m}`);
const bad = (m) => { console.error(`  FAIL ${m}`); failed += 1; };

/** 从产物里抠出一个真实函数体并执行（不复制逻辑） */
function realFn(name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`${name} 不在产物里`);
  let i = src.indexOf("{", at), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0) throw new Error(`${name} 函数体没闭合`);
  return new Function(`"use strict"; return (${src.slice(at, end)});`)();
}

// ---- 1) thinkSummary：段落边界不许把这一行清空 ----
const thinkSummary = realFn("thinkSummary");
const cases = [
  { name: "跑到一半正落在空行上", m: { status: "run", text: "先看目录。\n\n" }, want: "先看目录。" },
  { name: "整段思考以空行收尾", m: { status: "run", text: "甲。\n\n乙。\n\n" }, want: "乙。" },
  { name: "多段取最新那段", m: { status: "run", text: "甲。\n\n乙。\n\n丙。\n" }, want: "丙。" },
  { name: "跑完也停在最新内容", m: { status: "done", text: "甲。\n\n乙。\n\n" }, want: "乙。" },
  { name: "单行（没有空行）照旧", m: { status: "run", text: "只有一句。" }, want: "只有一句。" },
  { name: "还没有字时就是空", m: { status: "run", text: "\n\n" }, want: "" },
];
for (const c of cases) {
  const got = thinkSummary(c.m);
  if (got === c.want) ok(`thinkSummary · ${c.name} → ${JSON.stringify(got)}`);
  else bad(`thinkSummary · ${c.name}：得到 ${JSON.stringify(got)}，应为 ${JSON.stringify(c.want)}`);
}
if (thinkSummary({ status: "run", text: "甲。\n\n" }) === "") {
  bad("thinkSummary 在段落边界仍会清空 —— 用户报的「只剩『思考』」没修掉");
}

// ---- 2) 摘要节点不存在时必须补一次单行重绘（否则那一行永远只剩标题）----
const thinkFn = src.slice(src.indexOf("    think(text) {"), src.indexOf("只重画组体"));
if (!/\.pg-sum[\s\S]{0,400}?patchGroupRow\(g, m\)/.test(thinkFn)) {
  bad("Flow.think 展开态找不到 .pg-sum 就静默什么都不做 —— 摘要节点缺失时这一行永不更新");
} else {
  ok("Flow.think 在 .pg-sum 缺失时会 patchGroupRow 补出摘要");
}

// ---- 3) 团队快照事件必须按会话过滤后才能落到 state.team ----
const at = src.indexOf('if (ev.t === "team")');
if (at < 0) {
  bad("产物里找不到 team 快照事件的处理分支");
} else {
  const handler = src.slice(at, src.indexOf("if (ev.t ===", at + 10) > 0 ? src.indexOf("if (ev.t ===", at + 10) : at + 1200);
  const assign = handler.indexOf("state.team =");
  const gate = handler.search(/session[^;\n]*teamSid\(\)/);
  if (gate < 0 || assign < 0 || gate > assign) {
    bad("team 事件没在 state.team 赋值前按 teamSid() 过滤 —— 别的会话会把角标点回来");
  } else {
    ok(`team 事件先过会话归属再写 state.team（gate@${gate} < assign@${assign}）`);
  }
}

// ---- 4) 快照视图按 scope 取，不跟着「最后谁查过」走 ----
const kt = readFileSync(join(ROOT, "app/src/main/java/ai/deepseek/harness/mobile/kernel/team/TeamRuntime.kt"), "utf8");
const snapForAt = kt.indexOf("fun snapshotFor(");
const snapForBody = snapForAt < 0 ? "" : kt.slice(snapForAt, kt.indexOf("\n    }", snapForAt) + 5);
if (snapForAt < 0) {
  bad("TeamRuntime 里没有 snapshotFor 了");
} else if (/attach\(/.test(snapForBody) || !/viewOf\(\s*scopeFor\(/.test(snapForBody)) {
  bad("snapshotFor 仍在 attach —— 任何一次读快照都会把团队 current 换到别的会话");
} else {
  ok("snapshotFor 是纯读（viewOf(scopeFor(sid))，不再翻转 current）");
}
if (/private fun pushSnapshot\(scope: Scope\? = null\)/.test(kt) && /bump\(scope: Scope\)[\s\S]{0,220}pushSnapshot\(scope\)/.test(kt)) {
  ok("pushSnapshot 推的是变化发生的那支团队（bump 传 scope）");
} else {
  bad("pushSnapshot 还在读全局 current —— 后台队友的快照会挂着别的会话 id");
}

process.exit(failed ? 1 : 0);
