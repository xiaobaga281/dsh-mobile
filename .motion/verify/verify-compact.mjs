// 上下文压缩整链验收（真机）—— 一条命令跑完
//
//   node .motion/verify/verify-compact.mjs
//
// 前置：debug 包已装，且
//   adb forward tcp:9227 localabstract:webview_devtools_remote_<pid>
//
// 套路（与 verify-exit-code.mjs 同一桩模型打法）：本地 OpenAI 兼容桩 + 小窗口模型，
// 第一轮让桩回超长文本把历史撑过预算，第二轮发消息触发轮首压缩，断言：
//   1) 对话流出现「已压缩上下文 · 摘要 N 条较早消息为检查点」
//   2) 展开检查点：账目行（压缩 N 条消息 · 约 X → Y tokens · 省 Z%）跟着正文一起渲染
//   3) 轮末「用量」面板出现「上下文压缩」行
// 桩会覆盖模拟器的模型配置，脚本退出前恢复。
import http from "node:http";
import { writeFileSync } from "node:fs";

const PORT = +(process.env.CDP_PORT || 9227);
const STUB_PORT = +(process.env.STUB_PORT || 8899);
const STUB_URL = process.env.STUB_URL || `http://10.0.2.2:${STUB_PORT}/v1`;

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); setTimeout(() => rej(new Error("ws-timeout")), 8000); });
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  const t = setTimeout(() => { pend.delete(i); rej(new Error("timeout " + method)); }, 60000);
  pend.set(i, (m) => { clearTimeout(t); m.error ? rej(new Error(m.error.message)) : res(m.result); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (cond, label, extra = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  | " + extra : ""}`);
};

/* ---------------- 桩：长文撑历史 / 检查点 / 收尾 ---------------- */
// 压缩请求没有 tools 字段（summarize 只发 model/messages/stream），据此分流。
let toolReqs = 0;
const LONG = "重要" + "上下文内容很长。".repeat(700); // ≈ 4900 CJK 字，稳超 4k 窗口的预算
const CHECKPOINT = [
  "## 主要请求与意图", "- 验证上下文压缩整链路", "",
  "## 关键技术概念", "- 轮首压缩、检查点、预算", "",
  "## 下一步", "- 继续验收用量面板",
].join("\n");

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method !== "POST") { res.writeHead(404).end(); return; }
    let j = {};
    try { j = JSON.parse(body); } catch (_) {}
    const msgs = Array.isArray(j.messages) ? j.messages : [];
    const isCompactReq = !(Array.isArray(j.tools) && j.tools.length > 0);
    // 正式请求的 user 恒为两条（runtimeCtx + 用户输入），不能按条数判断轮次，按顺序数
    if (!isCompactReq) toolReqs++;

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const base = { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1, model: "stub" };
    const chunk = (delta, finish = null) =>
      res.write("data: " + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n");

    chunk({ role: "assistant", content: "" });
    let text = "";
    if (isCompactReq) text = CHECKPOINT;   // 摘要请求 → 检查点正文
    else if (toolReqs === 1) text = LONG;  // 第一个正式轮 → 撑爆历史
    else text = "已从检查点继续。";          // 压缩后的正式轮 → 收尾
    for (let i = 0; i < text.length; i += 512) chunk({ content: text.slice(i, i + 512) });
    chunk({}, "stop");
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => server.listen(STUB_PORT, "127.0.0.1", r));

const backup = JSON.parse(await ev(`JSON.stringify({ models: localStorage.getItem("dsh.models"), model: localStorage.getItem("dsh.model") })`));
// ctx: 4096 —— 窗口压到下限，预算 ≈ 2k tokens，桩的 4.9k 字长文必然超
const stub = [{ id: "stub", name: "Stub", desc: "本地桩（压缩验收）", url: STUB_URL, key: "stub", upstream: "stub", ctx: 4096, efforts: [], builtin: false }];
await ev(`localStorage.setItem("dsh.models", ${JSON.stringify(JSON.stringify(stub))}); localStorage.setItem("dsh.model", "stub"); 1`);
await send("Page.reload", {});
await sleep(7000);

const sendText = async (text) => {
  await ev(`(() => {
    const i = document.getElementById("input");
    i.value = ${JSON.stringify(text)};
    i.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("btnSend").click();
    return 1;
  })()`);
};
const busy = async () => {
  const label = await ev(`document.getElementById("btnSend")?.getAttribute("aria-label")`);
  return label === "停止生成" || label === "加入发送队列";
};
const waitIdle = async (timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (!(await busy())) return true; await sleep(500); }
  return false;
};

try {
  await ev(`(()=>{ document.querySelector('.tab[data-tab="chat"]')?.click(); document.getElementById("btnNewSession")?.click(); return 1 })()`);
  await sleep(1500);

  // 第一轮：桩回 4.9k 字长文，历史稳超 4k 窗口下的预算
  await sendText("给我讲一段很长的内容");
  check(await waitIdle(90_000), "第一轮结束");
  await sleep(800);

  // 第二轮：轮首压缩应触发（修复后 prefix = 全部历史）
  await sendText("继续");
  const deadline = Date.now() + 90_000;
  let row = null;
  while (Date.now() < deadline) {
    row = await ev(`(() => {
      const el = document.querySelector(".turn-note.is-compact");
      return el ? el.textContent.trim() : null;
    })()`);
    if (row) break;
    if (!(await busy()) && !row) { /* 收尾轮也可能太快没压 */ }
    await sleep(500);
  }
  check(!!row && row.includes("摘要"), "对话流出现「已压缩上下文 · 摘要 N 条」", JSON.stringify(row));
  check(!!row && /→/.test(row), "压缩行带 token 账目（约 X → Y）", JSON.stringify(row));

  // 展开检查点：账目行（blockquote）要跟正文一起在
  await ev(`document.querySelector('.turn-note.is-compact[data-compact-toggle]')?.click(); 1`);
  await sleep(400);
  const detail = await ev(`(() => {
    const d = document.querySelector(".compact-detail");
    if (!d) return null;
    const q = d.querySelector("blockquote");
    return { visible: !d.hidden, quote: q ? q.textContent.trim() : "", len: d.textContent.length };
  })()`);
  check(!!detail && detail.visible, "检查点展开可见", JSON.stringify(detail));
  check(!!detail && /压缩 \d+ 条消息/.test(detail.quote || ""), "展开后账目行在（压缩 N 条消息）", JSON.stringify(detail?.quote));
  check(!!detail && /省 \d+%/.test(detail.quote || ""), "账目行带省下百分比", JSON.stringify(detail?.quote));

  // 用量面板：footer 上的用量按钮点开要有「上下文压缩」行
  await waitIdle(90_000);
  await sleep(800);
  const usage = await ev(`(() => {
    const btns = [...document.querySelectorAll("[data-turn-usage]")];
    const btn = btns[btns.length - 1]; // 最后一个 = 第二轮的 footer（第一轮没有压缩）
    if (!btn) return null;
    btn.click();
    return { n: btns.length, uid: btn.dataset.turnUsage };
  })()`);
  await sleep(300);
  const sheetProbe = await ev(`(() => {
    const ks = [...document.querySelectorAll("#sheetBody .usage-grid .k")];
    const k = ks.find((e) => e.textContent.includes("上下文压缩"));
    return {
      rows: ks.map((e) => e.textContent.trim()),
      hit: k ? k.nextElementSibling?.textContent.trim() : null,
      sheetOpen: !document.getElementById("sheet")?.hidden,
      dump: document.getElementById("sheetBody").textContent.replace(/\\s+/g, " ").slice(0, 300),
    };
  })()`);
  console.log("click:", JSON.stringify(usage), "sheet:", JSON.stringify(sheetProbe));
  const sheetRow = sheetProbe?.hit;
  check(!!usage && !!sheetRow, "用量面板出现「上下文压缩」行", JSON.stringify(sheetRow));
  check(!!sheetRow && /摘要 \d+ 条/.test(sheetRow), "面板行写明摘要条数", JSON.stringify(sheetRow));

  const png = await send("Page.captureScreenshot", { format: "png" }).then((r) => r.data).catch(() => null);
  if (png) {
    writeFileSync(".motion/verify/compact-sheet.png", Buffer.from(png, "base64"));
    console.log("shot: .motion/verify/compact-sheet.png");
  }
} finally {
  await ev(backup.models == null
    ? `localStorage.removeItem("dsh.models")`
    : `localStorage.setItem("dsh.models", ${JSON.stringify(backup.models)})`).catch(() => {});
  await ev(backup.model == null
    ? `localStorage.removeItem("dsh.model")`
    : `localStorage.setItem("dsh.model", ${JSON.stringify(backup.model)})`).catch(() => {});
  await send("Page.reload", {}).catch(() => {});
  server.close();
  ws.close();
}

console.log(fails === 0 ? "ALL PASS" : `FAILURES=${fails}`);
process.exit(fails === 0 ? 0 : 1);
