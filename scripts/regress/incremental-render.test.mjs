/**
 * 对话流「只做增量」回归（用户明确要求：已经生成的内容不能再被整表重绘，否则就是闪）。
 *
 * 症状：发一条消息 / 起一轮目标 / 电脑会话报错恢复，都会把整张对话清空重灌
 * （renderThread = host.textContent="" 后重灌）。已经渲染好的正文、工具行、思考行
 * 全部销毁重建 → 已生成内容闪一下，同时 scrollHeight 塌成 0、视口被钳到顶部，
 * 贴底再拉回来 = 「一发消息就跳回历史上方」。
 *
 * 断言对象是 app.js 里的真实源码片段。运行：node scripts/regress/incremental-render.test.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const src = readFileSync(join(ROOT, "app/src/main/assets/web/app.js"), "utf8");

const fails = [];
const ok = (name) => console.log(`  ✔ ${name}`);
const bad = (name) => { console.log(`  ✘ ${name}`); fails.push(name); };
const check = (name, cond) => (cond ? ok(name) : bad(name));

/** 取某个函数体的源码片段（从声明行到下一个顶层声明之前） */
function fnBody(head) {
  const at = src.indexOf(head);
  if (at < 0) return "";
  const rest = src.slice(at + head.length);
  const m = rest.search(/\n  (?:async )?function /);
  return m < 0 ? rest.slice(0, 4000) : rest.slice(0, m);
}

// 1) 发送：同桶只追加新节点；只有「桶换了」（新建/接管会话）才允许整表重绘一次
const send = fnBody("async function handleSend() {");
check("发送只追加新节点，不整表重绘",
  /if \(state\.sessionId === prevSid\) \{\s*\n\s*appendTail\(thread\[thread\.length - 1\]\);/.test(send)
  && (send.match(/renderThread\(\);/g) || []).length === 1
  && /else \{\s*\n\s*renderThread\(\);\s*\n\s*\}/.test(send));

// 2) 宿主机分支：streamText 自己就是增量，收尾不得再重绘
check("宿主机回复分支不再收尾重绘",
  /if \(reply\) await streamText\(reply\);\s*\n\s*else push\(NODES\.text\("宿主机没有返回内容"\)\);/.test(send)
  && !/thread\.push\(NODES\.text\(`\*\*发送失败\*\*/.test(send));

// 3) 目标轮次分隔行：三处都是 push（以前每轮一条 renderThread）
check("目标轮次分隔行走 push",
  (src.match(/push\(NODES\.goalround\(/g) || []).length === 3
  && !/thread\.push\(NODES\.goalround\([\s\S]{0,80}renderThread\(\)/.test(src));

// 4) 陪伴主动开口：落在对话页时只追加
check("陪伴主动消息只追加",
  /if \(state\.screen === "chat"\) \{\s*\n\s*push\(node\);\s*\n\s*persistThread\(\);/.test(src));

// 5) 团队视图发送：只追加
check("团队视图发送只追加",
  /push\(NODES\.user\(text\)\);\s*\n\s*pinBottom\([^)]*\);/.test(src)
  && !/thread\.push\(NODES\.user\(text\)\);[\s\S]{0,60}renderThread\(\)/.test(src));

// 6) 电脑会话「读取失败」提示：加一条 / 撤一条都不重绘
check("电脑会话错误提示增删都是单条操作",
  /push\(this\.emptyHint, false\)/.test(src)
  && /el\.remove\(\); if \(renderTailFrom > thread\.length\) renderTailFrom = thread\.length;/.test(src));

// 7) 上下文压缩检查点插在流中间，必须走锚定插入器（既不能重绘，也不能甩视口）
check("压缩检查点走锚定插入且不重绘（进行中/完成是两个桌面同构状态）",
  // 桌面 CompactionItem 只有一个节点：运行态→完成原地补账目
  /function insertCompactionNode\(node\)/.test(src)
  && /insertAnchored\(anchor, nodeHTMLUid\(node\)\);/.test(src)
  && /compactNode = NODES\.compaction\(\{ running: true \}\)/.test(src)
  && /if \(thread\.indexOf\(node\) >= 0\) patchNode\(node\);/.test(src)
  // 进行中 = 轨迹里的居中一行（桌面 layout.compacting），不能带标题/圆点
  && /class="compact-run"/.test(src) && src.includes("正在压缩上下文…")
  // 运行中带全应用统一的扫光（与工具行/思考行同一套 is-shimmer）
  && /class="is-shimmer"\$\{shimmerAttr\(\)\}>正在压缩上下文…/.test(src)
  // 完成 = 桌面 CompactionItem：「上下文已压缩 · 已压缩 N 条历史记录（约 M tokens）」
  && src.includes("上下文已压缩")
  && /已压缩 \$\{items\} 条历史记录（约 \$\{tokens\} tokens）/.test(src)
  && /class="compact-sep"/.test(src)
  // 手机端自己加的东西不许回来：输入框上方的第二条进度线、tokens 百分比
  && !/compactBar/.test(src));

// 8) 流式与追加的原语本身不得重绘
for (const head of ["function push(n, scroll = true) {", "function appendTail(n) {",
                    "function livePaint(force) {", "function streamFollow() {", "function settleFollow() {"]) {
  const body = fnBody(head);
  check(`${head.slice(9, head.indexOf("("))} 内部不出现整表重绘`,
    !!body && !/[^a-zA-Z]renderThread\(\)/.test(body));
}

// 9) 唯一允许在流式期间重绘的是「DOM 与 thread 已经对不上」的兜底，且必须是条件式
check("paintLiveNode 的重绘兜底仍是条件式",
  /if \(renderTailFrom !== thread\.length \|\| !\$\("#messages"\)\) \{ renderThread\(\); scrollToBottom\(\); return; \}/.test(src));

// 10) 「深度思考中 · N 秒」的秒表只能改本轮那一行。
// 真机实测：选择器写成全局 `[data-live-secs]` 时，取到的是全对话第一条 ——
// 上一轮已经定稿的思考行被每秒改写一次（封条重写），旧回合的秒数还在涨。
check("秒表按本轮 uid 定位，不再改写上一轮定稿的思考行",
  /const liveNode = this\.live && this\.live\.node;[\s\S]{0,320}\[data-uid="\$\{nodeUid\(liveNode\)\}"\] \[data-live-secs\]/.test(src)
  && !/document\.querySelector\("#messages \[data-live-secs\]"\)/.test(src));
check("一轮结束时把活标题收口（「深度思考中 · N 秒」→「思考」，去掉 data-live-secs）",
  /function finalizeLiveHead\(el\)/.test(src)
  && /head\.removeAttribute\("data-live-secs"\)/.test(src)
  && (src.match(/finalizeLiveHead\(el\);/g) || []).length >= 2);

// 11) 「在流里」的节点不许进 HTML 缓存，且判据必须是节点上的 live 标记。
// 真机实测：判据写成 `n !== Live.textNode` 时只豁免主对话那一个对象，成员视图的在跑气泡
// 第一口（65 字）就被按 uid 缓存住，之后每次 patchNode 拿回同一段旧 HTML，
// morph 认为无变化 → 内核 liveSeq 从 65 涨到 830，屏上一字不动。
check("在跑的节点不进 nodeHTMLUid 缓存（按 live 标记豁免，不是按主对话节点身份）",
  /const cacheable = n\.kind === "text" && !n\.live && !!uid;/.test(src)
  && !/cacheable = n\.kind === "text" && n !== Live\.textNode/.test(src));

console.log(fails.length ? `\n✘ ${fails.length} 项未通过：${fails.join("、")}` : "\n增量刷新守卫全部通过");process.exit(fails.length ? 1 : 0);
