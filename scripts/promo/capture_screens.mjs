#!/usr/bin/env node
/**
 * 宣传片素材采集：用无头 Edge + CDP 打开 preview，注入演示数据，
 * 以 390×844@2x 移动视口截取当前版本的真实界面。
 *
 * 输出：D:/1/tmp/promo/screens/*.png
 * 依赖：本机 Edge、Node 22+（内置 WebSocket/fetch）。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const ROOT = "D:/1/dsh-mobile/preview";
const OUT = "D:/1/tmp/promo/screens";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const HTTP_PORT = 8765;
const CDP_PORT = 9333;
mkdirSync(OUT, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".json": "application/json",
};

const server = createServer((req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = normalize(join(ROOT, p));
  if (!file.startsWith(normalize(ROOT)) || !existsSync(file)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(HTTP_PORT, "127.0.0.1", resolve));

const profile = "D:/1/tmp/promo/edge-profile";
const edge = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--no-first-run",
  "--no-default-browser-check",
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitCdp() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) return;
    } catch (_) {}
    await sleep(200);
  }
  throw new Error("Edge CDP 没起来");
}
await waitCdp();

const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("找不到页面 target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
};
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalJs(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "evaluate failed");
  return r.result?.value;
}
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, "base64"));
  console.log("shot", name);
}

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  screenWidth: 390, screenHeight: 844,
});
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await send("Page.navigate", { url: `http://127.0.0.1:${HTTP_PORT}/index.html` });
await sleep(1600);

const now = Date.now();
const sessions = [
  { id: "demo1", title: "给新 App 做一支宣传片", createdAt: now - 86400000, updatedAt: now - 60000, ws: "harness", tokens: 16800, pin: true, lastMsg: { content: "周报已生成，封面图还在后台生成" } },
  { id: "demo2", title: "排查视频端点方言", createdAt: now - 2 * 86400000, updatedAt: now - 3600000, ws: "harness", tokens: 9200, lastMsg: { content: "端点报 invalid mode，先探测一下方言" } },
  { id: "demo3", title: "把 README 改成可验证清单", createdAt: now - 3 * 86400000, updatedAt: now - 7200000, ws: "harness", tokens: 23100, lastMsg: { content: "README 里的数字总是漂，改成可验证清单" } },
  { id: "demo4", title: "周末旅行计划", createdAt: now - 4 * 86400000, updatedAt: now - 86400000, ws: "harness", tokens: 4100, lastMsg: { content: "三天两晚，想找个安静的海边" } },
];
const shotNodes = [
  { kind: "user", text: "帮我把这周的会议纪要整理成周报，再配一张封面图。", atts: [], files: [], voice: null },
  { kind: "text", text: "我先读工作区里的三份纪要，再合并成周报；封面图交给生成端点。" },
  { kind: "toolrow", members: [{ name: "list_dir", cat: "read", title: "查看目录", detail: "notes/", status: "done", ms: 18, out: "2026-10-27.md\n2026-10-29.md\n2026-10-30.md", exitCode: null }] },
  { kind: "toolrow", members: [{ name: "http_request", cat: "webFetch", title: "HTTP 请求", detail: "POST https://api.example.com/v1/images", status: "done", ms: 860, out: "HTTP 200\ncontent-type: application/json\n{\"id\":\"img_7f3\"}", exitCode: null }] },
  { kind: "todo", items: [
    { text: "读取三份会议纪要", state: "done" },
    { text: "合并重复议题", state: "done" },
    { text: "生成周报 docx", state: "active" },
  ] },
  { kind: "text", text: "周报已生成。本周完成 **12 项**，其中 3 项需要你确认；封面图还在后台生成，完成后我会自动继续。" },
  { kind: "notice", title: "后台任务完成", text: "video_generate · 30.0s · 用 job_output(job_id=\"job-3-1206\") 读取输出" },
];
const messagesForList = [{ role: "user", content: "帮我把这周的会议纪要整理成周报，再配一张封面图。" }];
await evalJs(`(() => {
  localStorage.clear();
  const sessions = ${JSON.stringify(sessions)};
  localStorage.setItem("dsh.local.sessions", JSON.stringify(sessions));
  localStorage.setItem("dsh.local.sess.demo1", JSON.stringify(${JSON.stringify({ messages: messagesForList, shot: shotNodes })}));
  localStorage.setItem("dsh.local.sess.demo2", JSON.stringify({ messages: [{ role: "user", content: "端点报 invalid mode，先探测一下方言" }], shot: null }));
  localStorage.setItem("dsh.local.sess.demo3", JSON.stringify({ messages: [{ role: "user", content: "README 里的数字总是漂，改成可验证清单" }], shot: null }));
  localStorage.setItem("dsh.local.sess.demo4", JSON.stringify({ messages: [{ role: "user", content: "三天两晚，想找个安静的海边" }], shot: null }));
})()`);
await send("Page.reload", { ignoreCache: true });
await sleep(1800);

await shot("01-sessions");

// 进第一条会话：点会话行
await evalJs(`(() => {
  const row = document.querySelector('[data-open="demo1"]') || document.querySelector('.session-item');
  row && row.click();
  return !!row;
})()`);
await sleep(900);
await shot("02-chat");

// 快捷操作浮窗
await evalJs(`document.getElementById('btnAttach')?.click()`);
await sleep(600);
await shot("03-quick-actions");
await evalJs(`document.getElementById('sheetBackdrop')?.click()`);
await sleep(500);

// 连接电脑
await evalJs(`document.getElementById('btnChatMore')?.click()`);
await sleep(500);
await evalJs(`document.querySelector('[data-act="link"]')?.click()`);
await sleep(600);
await shot("04-connect");
await evalJs(`document.getElementById('sheetBackdrop')?.click()`);
await sleep(500);

// 设置页
await evalJs(`document.querySelector('.tab[data-tab="settings"]')?.click()`);
await sleep(900);
await shot("05-settings");

// 任务页（后台任务）
await evalJs(`document.querySelector('.tab[data-tab="jobs"]')?.click()`);
await sleep(700);
await shot("06-jobs");

ws.close();
edge.kill();
server.close();
await sleep(300);
console.log("done", OUT);
