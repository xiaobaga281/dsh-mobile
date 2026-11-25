// 回归：对话流滚动的「意图」必须由一层纯决策说了算（rc.202）。
// 背景：近 10 个版本里 rc.192 / 194 / 195 / 200 四次复发同一个病根 ——
//   写入 scrollTop 的路径各有各的时钟，而「这次滚动是不是用户滑的」靠 240ms 时间窗猜；
//   工具行改成实时输出（每 120ms 长一次）之后，程序写入连续不断，时间窗几乎永真，
//   于是「用户上滑被拽回」「视口被甩开再滚回来」反复出现。
// 本用例跑的是 web/src/00-app.js 里 @pure 标记的决策块（真实源码，不是复制品），
// 用脚本化时间线断言四件事，不需要 DOM、不需要设备。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// 前端源已按 web/build.json 切成多个 part：按拼接顺序读全量（与产物逐字节一致）
const src = JSON.parse(readFileSync(join(root, "web/build.json"), "utf8")).parts
  .map((p) => readFileSync(join(root, "web/src", p), "utf8"))
  .join("");

const begin = src.indexOf("/* @pure:begin scroll-intent */");
const end = src.indexOf("/* @pure:end scroll-intent */");
if (begin < 0 || end < 0) {
  throw new Error("FAIL: 找不到 @pure scroll-intent 决策块 —— 滚动意图没有可测的纯函数层");
}
const block = src.slice(begin, end);

// @pure 块是刻意的契约：这五个名字必须由块**自己**声明，不依赖块外的任何东西。
// 清单在本用例里 = 改名要同步两处，所以缺谁直接报谁 —— 以前只靠 new Function 抛裸
// ReferenceError，那种报错分不出是「函数改名了」还是「被搬出块了」。
const NEED = ["SCROLL_INTENT", "scrollProbe", "classifyScroll", "decideScroll", "anchorCompensate"];
const declared = NEED.filter((n) => new RegExp(`(?:^|\\s)(?:function|const|let) ${n}\\b`).test(block));
if (declared.length !== NEED.length) {
  const missing = NEED.filter((n) => !declared.includes(n));
  throw new Error(`FAIL: @pure scroll-intent 块里没有声明 ${missing.join(", ")} —— `
    + "改名就把本用例的 NEED 清单一起改，搬出块就把标记区间扩到它");
}

const api = new Function(`${block}
  return { ${NEED.join(", ")} };`)();
const { SCROLL_INTENT, scrollProbe, classifyScroll, decideScroll, anchorCompensate } = api;

function check(name, cond, hint) {
  if (!cond) throw new Error(`FAIL: ${name} —— ${hint}`);
}

// ---- 1) 流式 60 帧：每帧都贴底，且只往后不往回（rc.192 甩底 / rc.194 回退）
{
  const state = { intent: SCROLL_INTENT.FOLLOW, pointer: false, lastWritten: -1 };
  let top = 0, content = 800, viewport = 600;
  for (let frame = 0; frame < 60; frame += 1) {
    content += 3;                                   // 每帧长 3px（流式正文的典型速度）
    const plan = decideScroll(state, scrollProbe({ scrollTop: top, scrollHeight: content, clientHeight: viewport }));
    if (!plan.write) continue;
    check(`第 ${frame} 帧应当继续跟底`, plan.top >= top, "目标位置回退了，视口会被拽回上方");
    top = plan.top;
    state.lastWritten = top;
  }
  const dist = content - top - viewport;
  check("60 帧后仍贴底", dist <= 1, `距底 ${dist}px —— 跟手丢帧，rc.192「内容跑掉」会复发`);
}

// ---- 2) 用户把视口滑走（AWAY）：一帧都不许写（rc.200 手势被抢）
{
  const state = { intent: SCROLL_INTENT.AWAY, pointer: false, lastWritten: -1 };
  const plan = decideScroll(state, scrollProbe({ scrollTop: 400, scrollHeight: 3000, clientHeight: 600 }));
  check("AWAY 时不许写 scrollTop", plan.write === false, "用户在看历史，程序又把他拽回底部");
}

// ---- 3) 插中间：补偿后视口不动（rc.195 插卡甩视口）
{
  const state = { intent: SCROLL_INTENT.AWAY, pointer: false, lastWritten: -1 };
  const before = scrollProbe({ scrollTop: 800, scrollHeight: 3000, clientHeight: 600 });
  const after = anchorCompensate(state, before, 240);   // 上方插入 240px 高的交付卡
  check("插中间要补回同等高度", after.top === 1040, `补了 ${after.top - before.top}px，视口会跳`);
  check("插中间不改变意图", after.intent === SCROLL_INTENT.AWAY, "插卡把用户从「看历史」拽回跟随");
}

// ---- 4) 谁滚的：写入记账，而不是时间窗
{
  const state = { intent: SCROLL_INTENT.FOLLOW, pointer: false, lastWritten: 1200 };
  check("自己刚写过的位置算程序滚动",
    classifyScroll(state, { top: 1201 }) === "programmatic",
    "程序写入被当成用户意图，会把自己写的滚动误判成「用户滑走了」并关掉跟随");
  check("别处的位置算用户",
    classifyScroll(state, { top: 900 }) === "user",
    "用户上滑没被识别，下一帧又会被拽回底部");
  check("手指按下期间一律算用户",
    classifyScroll({ ...state, pointer: true }, { top: 1200 }) === "user",
    "手指还按着就被判成程序滚动，跟手时会被程序写入抢走手势");
}

// ---- 5) 静态不变量：对话流滚动条只能经 setScrollTop / ChatScroll 写入
//      （其它容器如 #device、sheet body、思考框各自有直写，不属于这条不变量）
{
  const chatWrites = [...src.matchAll(/\b(sc|chatScroll)\.scrollTop\s*=[^=]/g)];
  check("对话流滚动条没有被绕过 setScrollTop 直写", chatWrites.length === 0,
    `发现 ${chatWrites.length} 处直写 —— 又出现了绕开唯一写入点的路径，记账会失效`);
  const defs = [...src.matchAll(/function setScrollTop\(/g)].length;
  check("setScrollTop 只有一个实现", defs === 1, `发现 ${defs} 个实现，写入语义会分叉`);
  check("ChatScroll._write 存在且是记账+写入的唯一组合",
    /_write\(sc, top\) \{[\s\S]{0,200}lastWritten[\s\S]{0,80}setScrollTop\(sc, top\)/.test(src),
    "唯一写入点被改坏，classifyScroll 的记账会失效");
  const at = src.indexOf("classifyScroll(ChatScroll.state, probe)");
  check("取到了 #chatScroll 的 scroll 监听", at > 0, "监听写法变了，这条判据没在跑");
  const from = at < 0 ? -1 : src.lastIndexOf('sc.addEventListener("scroll"', at);
  const to = at < 0 ? -1 : src.indexOf("}, { passive: true });", at);
  const scrollListener = from < 0 || to < 0 ? "" : src.slice(from, to);
  check("scroll 监听取全了", scrollListener.length > 80, "监听被改了写法，下面的判据没在跑");
  check("scroll 监听不无条件关掉跟随（关掉只归 touchstart / wheel）",
    !/followBottomOn = chatAtBottom\(\);/.test(scrollListener),
    "scroll 事件又在无条件重算跟随 —— 布局钳位会把跟随关掉，最后一段永远贴不上底");
  // rc.217：恢复跟随不许走「距底 90px 就算到底」的宽松判据 ——
  // 用户在底部附近慢滑阅读时每一帧都满足，于是每帧重开跟随、下一帧又被拽回，
  // 手感就是界面跟手指来回夺。恢复必须经过「去抖 + 真贴底」。
  check("scroll 监听不许用宽松判据直接重开跟随",
    !/if \(chatAtBottom\(\)\)/.test(scrollListener),
    "chatAtBottom 的 90px 容差又变成了「是否重新跟随」的判据，慢滑会被反复拽回底部");
  check("scroll 监听在手指按着时只做「停止跟随」，不做重判",
    /if \(ChatScroll\.state\.pointer\) \{[\s\S]{0,200}ChatScroll\.release\(\)/.test(scrollListener),
    "指头还按在列表上就往下判意图 —— 拖动中会被程序写入抢走，或被重新 adopt");
  check("scroll 监听把恢复跟随交给去抖入口",
    /scheduleRestick\(\)/.test(scrollListener),
    "没有去抖就在 scroll 里恢复跟随，惯性滑行会被拦腰 adopt");
  const rsAt = src.indexOf("function scheduleRestick(");
  const rs = rsAt < 0 ? "" : src.slice(rsAt, rsAt + 600);
  check("有去抖的恢复跟随入口", rs.startsWith("function scheduleRestick("), "scheduleRestick 不见了");
  check("恢复跟随看「停手那一刻是否在底部」", /scrollStamp - bottomStamp/.test(rs),
    "拿「等一会儿再量距底」当判据，流式一长就把「滚到底」误判成「停在半空」，跟随再也回不来");
  check("贴底口径是 2px 级而不是 90px", /probe\.dist <= RESTICK_EPS/.test(src) && /const RESTICK_EPS = 2/.test(src),
    "容差被放大回几十像素，等于把 rc.217 的 bug 换个名字放回来");
  check("去抖到期时手指仍按着就不恢复", /state\.pointer\)\s*return/.test(rs),
    "去抖回调没看指针位，长按拖动期间仍会被夺回");
  check("恢复跟随是定时的（等滚动停下），不是当帧决定", /setTimeout\(/.test(rs),
    "当帧恢复 = 惯性滑行中途被 adopt，视口立刻弹回底部");
  const eps = /const RESTICK_EPS = (\d+)/.exec(src);
  check("真贴底的容差足够小（≤4px）", !!eps && Number(eps[1]) <= 4,
    "容差被放大回几十像素，等于把 rc.217 的 bug 换个名字放回来");
  check("touchcancel 与 touchend 同等复位指针",
    /sc\.addEventListener\("touchcancel", letGo/.test(src),
    "只认 touchend 时，返回手势/来电会让 pointer 永久卡 true，此后整场对话不再跟手");
}

// ---- 6) 轮内跟手不能只靠 paint：正文之间的空窗（等工具 / 等下一步）里内容照样在长
//      （实测：#chatScroll 内容高 875→1136 的 200ms 里 #messages 一直是 848，
//       高度观察器一次都没回调，视口停在 0）→ 必须每帧自己量一次。
{
  const pumpAt = src.indexOf("function followPump()");
  const pump = pumpAt < 0 ? "" : src.slice(pumpAt, pumpAt + 600);
  check("有轮内自量的跟手泵", pump.startsWith("function followPump()"), "followPump 不见了");
  check("跟手泵在跟随关掉时不写", /if \(followBottomOn\) ChatScroll\.stick\(/.test(pump),
    "无条件 stick —— 用户上滑会被这一圈每帧拽回底部");
  check("跟手泵随轮次结束自己退", /if \(!state\.busy && !Live\.running\)/.test(pump),
    "不退出就是一个常驻的每帧循环");
  check("新的一轮挂上跟手泵", /followPump\(\)/.test(src.slice(src.indexOf("function beginLive("),
    src.indexOf("function beginLive(") + 2600)), "beginLive 没启动跟手泵（空窗又没人量了）");
  check("跟手泵用定时器，不用 rAF", /setInterval\(/.test(pump) && !/requestAnimationFrame\(tick\)/.test(pump),
    "这台 WebView 空窗里 rAF 只有 ~4 次/秒（实测 1.5 秒 6 次），100~250ms 的卡住正好掉在两帧之间");
}

// ---- 7) 手指按着时一帧都不许写（rc.217 慢滑来回跳）
{
  const state = { intent: SCROLL_INTENT.FOLLOW, pointer: true, lastWritten: -1 };
  const plan = decideScroll(state, scrollProbe({ scrollTop: 400, scrollHeight: 3000, clientHeight: 600 }));
  check("按住列表时跟随泵不许写 scrollTop", plan.write === false,
    "手指还在屏上就被程序拽走 —— 慢滑时视口会来回弹（rc.217 用户实测）");
  // 内容还在长，手指按着不动：一帧都不该动
  let moved = false;
  for (let i = 0; i < 30; i += 1) {
    const p = decideScroll(state, scrollProbe({ scrollTop: 400 + i, scrollHeight: 3000 + i * 3, clientHeight: 600 }));
    if (p.write) moved = true;
  }
  check("按住期间连续 30 帧都不写", !moved, "流式内容增长时仍在写，拖动的手感被程序打断");
}

// ---- 7b) 只读诊断口必须在：探针靠它区分「指针卡住」与「restick 没跑」
{
  check("滚动意图层有只读诊断口",
    /window\.__chatScrollState = \(\) => \(\{/.test(src) && /intent: ChatScroll\.state\.intent/.test(src),
    "诊断口没了，实机排查只能从 scrollTop 轨迹反推意图 —— 「指针卡住」和「restick 没跑」长得一样");
  check("诊断口只读（不写回任何状态）",
    !/__chatScrollState\s*=\s*[^=]/.test(src.replace("window.__chatScrollState = () => ({", "")),
    "诊断口带写入就成了第二决策层");
}

// ---- 8) 「轮次自己推进」不许覆盖用户的阅读位置（rc.217 的另一半）
{
  const pinAt = src.indexOf("function pinBottom(");
  const pin = pinAt < 0 ? "" : src.slice(pinAt, pinAt + 900);
  check("pinBottom 有 force 参数", /function pinBottom\(ms = \d+, force = false\)/.test(pin),
    "没有 force 区分「用户要求贴底」与「内容自己推进」，两者又混成一个行为");
  check("非 force 时尊重用户意图", /!force && \(ChatScroll\.state\.pointer \|\| !ChatScroll\.following\(\)\)\) return/.test(pin),
    "后台轮跑完 / 定时唤醒插消息会把人从正在读的历史里拽回底部");
  const forceCalls = [...src.matchAll(/pinBottom\(\d+, true\)/g)].length;
  check("发送 / 切会话仍显式要求贴底", forceCalls >= 5,
    `只有 ${forceCalls} 处显式 force —— 发送后不贴底会是更明显的回归`);
}

console.log("✔ scroll-timeline: 跟手不甩底不回退 / 用户滚动不被抢（含按住慢滑）/ 插中间补偿 / 记账判定 / 写入收口 / 轮内每帧自量 / 非强制贴底不覆盖阅读位置");
