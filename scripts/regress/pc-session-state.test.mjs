// 回归：电脑会话的「离开 / 切换」必须把状态带走（2026-10-31 审查，rc.174）。
//   ⑤ 系统返回键离开聊天页时不调 Link.leave() —— 轮询/运行态/state.pcSession 全留在后台；
//   ⑥ Link.open 清空本地排队队列（否则排队消息会被发进电脑会话，openSession 早就这么做）；
//   ⑦ 轮询回包不校验归属会话 —— 快速切会话时迟到的旧响应会推进新会话的 cursor。
// 断言抽真实源码片段，不复刻逻辑。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const js = readFileSync(join(root, "app/src/main/assets/web/app.js"), "utf8");

function cut(from, to) {
  const i = js.indexOf(from);
  if (i < 0) throw new Error("找不到片段起点: " + from.slice(0, 40));
  const j = js.indexOf(to, i);
  if (j < 0) throw new Error("找不到片段终点: " + to.slice(0, 40));
  return js.slice(i, j);
}

// ---- ⑤ 系统返回键与聊天页返回同一条收尾路径 ----
const back = cut("window.DSHHandleBack = function () {", "/* ---------------- composer");
if (!back.includes("if (state.pcSession) Link.leave();")) {
  throw new Error("FAIL: 系统返回键离开电脑会话没有 Link.leave() —— 轮询和运行态会留在后台");
}

// ---- ⑥ 进电脑会话前清空排队队列 ----
const open = cut("open(sessionId, title, from) {", "/* ---------------- 存活心跳与诊断");
if (!open.includes("queueOf().length = 0")) {
  throw new Error("FAIL: Link.open 没有清空排队队列 —— 本机排队的消息会被发进电脑会话");
}
if (!open.includes("renderQueue()")) {
  throw new Error("FAIL: Link.open 清队列后没有重绘（界面上还留着假队列）");
}

// ---- ⑦ 轮询请求/回包按 id + 会话归属对账 ----
const request = cut("request() {", "startPoll() {");
if (!request.includes("this.pending = { id, sid: this.sessionId }")) {
  throw new Error("FAIL: request() 没有记录本次请求的 id/归属会话，回包无法对账");
}
const history = cut("onHistory(id, json) {", "function sheetLinkConnect()");
if (!history.includes("if (!this.pending || id !== this.pending.id) return;")) {
  throw new Error("FAIL: onHistory 不校验响应 id —— 迟到的旧会话响应会污染当前会话");
}
if (!history.includes("this.sessionId !== sid")) {
  throw new Error("FAIL: onHistory 不校验响应归属会话");
}
if (!js.includes("Link.onHistory(id, d);")) {
  throw new Error("FAIL: onLinkHistory 没把请求 id 传给 Link.onHistory，对账形同虚设");
}
const leave = cut("leave() {", "request() {");
if (!leave.includes("this.pending = null")) {
  throw new Error("FAIL: Link.leave 没有作废在途请求，离开后回包还会改状态");
}

// ---- ⑧ 模型选择器：等得起电脑端的慢目录，并且知道「当前用的是哪个」 ----
// 真机实锤：电脑端 modelCatalog() 要逐个 provider 走网络（实测十几秒），
// 手机 12 秒就放弃 → 面板渲染成没有一行可点 → 用户看到的是「模型切换不了」。
const modelsFn = cut("models(force) {", "selectModel(provider, model, effort) {");
if (!/40000/.test(modelsFn)) {
  throw new Error("FAIL: 模型目录的等待时间被改短了 —— 电脑端 provider 逐个问下来要十几秒");
}
if (!modelsFn.includes("Native.linkModels")) {
  throw new Error("FAIL: models() 没有真的去电脑拉目录");
}
if (!js.includes("data-pc-model-retry")) {
  throw new Error("FAIL: 目录没读出来时面板没有重试入口（只剩一句死文案）");
}
// 电脑把这场会话的模型放在 selected 里；不接过来，选择器永远标不出「当前」
if (!js.includes("if (sel && sel.model) this.selected = sel;")) {
  throw new Error("FAIL: 没有从历史应答里接住电脑回传的当前模型");
}
// ---- ⑨ 发一条只能出现一条 ----
// 真机实锤：发送时 push 了乐观气泡，电脑把同一句落库后带真实 seq 回传，
// 而 seen 只认 seq、认不出「同一句话」→ 两条重复消息。
if (!/Link\.expectEcho\(text(, imgAtt\.length > 0)?\)/.test(js)) {
  throw new Error("FAIL: 发送时没有登记「这句是我发的」—— 电脑回显会再叠一条");
}
// 只发图时没有文字可对：必须用哨兵登记，否则回显的空文案会再叠一条
if (!/expectEcho\(text, withImages\)[\s\S]{0,220}IMG_ECHO_KEY/.test(js) || !/takeEcho\(text\)[\s\S]{0,160}IMG_ECHO_KEY/.test(js)) {
  throw new Error("FAIL: 只有图片的那条消息没有回显对账（会「发一条出两条」）");
}
if (!/if \(this\.takeEcho\(raw\)\) \{/.test(js)) {
  throw new Error("FAIL: 电脑回显自己的消息时没有咽掉（重复气泡）");
}
if (!/this\.echo = \[\];/.test(js)) {
  throw new Error("FAIL: 切会话没清空回显登记 —— 会把用户真的重发的同一句咽掉");
}

// ---- ⑩ 重进电脑会话：历史只能出现一遍，失败时要看得见 ----
// 真机实锤：open() 保留了旧桶、又把 cursor 归零，整段历史被再灌一遍（7 → 14 个节点）。
if (!js.includes('attachBlank("pc:" + sessionId)')) {
  throw new Error("FAIL: 进电脑会话没有清空桶 —— 退出重进会把整段历史再追加一遍");
}
if (!js.includes("读取电脑会话失败：")) {
  throw new Error("FAIL: 首次读取失败时流里是空白，用户只能对着空屏猜");
}

// ---- ⑪ 电脑会话的输入框 = 电脑端那套；本机会话不动 ----
const css = readFileSync(join(root, 'app/src/main/assets/web/styles.css'), 'utf8');
const html = readFileSync(join(root, 'app/src/main/assets/web/index.html'), 'utf8');
if (!css.includes('.composer.is-pc') || !/"field field field field"/.test(css)) {
  throw new Error('FAIL: 电脑会话输入框没有换成电脑端布局（输入在上、控制行在下）');
}
if (!css.includes('.composer.is-pc #btnMic { display: none; }')) {
  throw new Error('FAIL: 电脑会话里麦克风没有收起（电脑端没有这个入口）');
}
if (!html.includes('id="btnPcModel"') || !/id="btnPcModel"[^>]*hidden/.test(html)) {
  throw new Error('FAIL: 模型胶囊不存在或默认没藏起来（本机会话会被它污染）');
}
if (!js.includes('function syncComposerMode()') || !js.includes('classList.toggle("is-pc", pc)')) {
  throw new Error('FAIL: 没有按会话类型切换输入框');
}
// ＋ 在电脑会话里必须走「电脑端动作」浮窗（权限 / 调用指令 / 添加图片）。
// rc.196 之前这里还挂着一个没定义的 sheetPcActions()，守卫却按那行死代码在断言 ——
// 现在按真正会执行的分支断言：先判 state.pcSession 并打开 pcActionsHtml。
if (!/if \(state\.pcSession\) \{\s*openPcPopover\(document\.querySelector\("#btnAttach"\), pcActionsHtml\(\), "cmds"\);[\s\S]{0,200}return;/.test(js)) {
  throw new Error('FAIL: 电脑会话里 ＋ 没有走电脑端动作菜单');
}
// 目录/命令异步回来后只能重画「自己那一份」浮层。
// 以前只看 #pcPopover 在不在，模型目录晚到一步就把正开着的指令或上下文面板顶掉 —— 用户点的是 ＋，看到的却是模型列表。
if (!/pop\.dataset\.pcPop === "models"/.test(js) || !/pop\.dataset\.pcPop === "cmds"/.test(js)) {
  throw new Error('FAIL: 异步重画浮层没有认门（会顶掉用户正开着的那一份）');
}
if (!/if \(kind\) wrap\.dataset\.pcPop = kind;/.test(js) || /dataset\.pcCtx/.test(js)) {
  throw new Error('FAIL: 浮层没有按 kind 打标识，或还留着 pcCtx 那套临时标记');
}
// 模型目录晚到后重画 sheet 也要认门：#sheetBody 这个壳子一直在，只判它在不在
// 会把「用户已关掉 / 换开了别的 sheet」也算成还开着，屏幕自己跳回模型列表。
// （824 / 894 两处早就是按面板里的标记在判，2217 那一处是漏网的。）
if (!/querySelector\("#sheetBody \[data-pc-model-panel\]"\)/.test(js)) {
  throw new Error('FAIL: 快速动作面板的异步重画没看还开着的是哪一块');
}
if (/&& state\.pcSession\) openSheet\(sheetPcAgent/.test(js)) {
  throw new Error('FAIL: 又用「壳子在不在」当「这块面板开着」用');
}
if (js.includes('sheetPcActions')) {
  throw new Error('FAIL: 又出现了未定义的 sheetPcActions（点了会抛 ReferenceError）');
}
// 手点「刷新电脑会话」在没配对时必须有话：静默重画一次空列表，用户只能对着空屏猜按钮坏了。
// （自动那一支 renderSessions → refreshList 保持静默是对的，所以断言点在点击分支里。）
if (!/closest\("#btnPcRefresh"\)[\s\S]{0,260}if \(!Link\.state\(\)\.paired\) \{ toast\(/.test(js)) {
  throw new Error('FAIL: 未配对时点刷新电脑会话没有任何反馈');
}
// 手点那一下还要吃到回执：已配对但列表没变时，屏幕本来就不会动，
// 不说「电脑上 N 场会话 / 电脑上还没有会话 / 读不到」就等于按钮坏了。
if (!/refreshList\("手点"\)/.test(js) || !/Link\.refreshAck = false;/.test(js) || !/if \(from\) this\.refreshAck = true;/.test(js)) {
  throw new Error('FAIL: 手点刷新电脑会话没有一次性回执');
}
// 成员会话是**一层视图**：左上角返回与系统返回都必须先退出它。
// 以前两边都不认 teamView，直接 go("sessions")：成员轮询与导航条挂在后台，
// 而列表里点任意一场又被 openSession 顺手清掉 —— 用户看到的就是「按返回却回到了 lead 那场」。
if (!/if \(state\.teamView\) \{ exitTeamView\(\); haptic\("light"\); return; \}/.test(js)) {
  throw new Error('FAIL: 左上角返回没有把成员会话当成一层（先 exitTeamView）');
}
if (!/if \(state\.teamView\) \{ exitTeamView\(\); return true; \}/.test(js)) {
  throw new Error('FAIL: 系统返回键没有先退成员会话（会绕过退出把轮询丢在后台）');
}
console.log("✔ pc-session-state: 返回键收尾 / 队列隔离 / 轮询归属 / 模型目录等得起 / 回显不叠两条 / 重进不重复 都在");
