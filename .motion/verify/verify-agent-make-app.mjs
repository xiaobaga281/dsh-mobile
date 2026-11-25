// Agent 级：自然语言 → 模型自己串 app_new → app_build → app_install → 启动
// 用法：node .motion/verify/verify-agent-make-app.mjs
import { execFileSync } from "node:child_process";
import { openSync } from "node:fs";

const PORT = 9227;
const PKG = "com.dsh.yiyan";
const DIR = "yiyan";
const RELAY = "http://10.0.2.2:8791/v1";
const KEY = "sk-j0txJk1nuwCWOSQVc4PNFoiAUA5opl8bVNkLVM7vbzXMShkz";
// 提示词刻意精简：每一步都是一次请求，免费额度按 token/分钟限流，
// 让模型跳过 todo/列目录这类探索步骤，直接 app_new → app_build → app_install
const PROMPT =
  "做个 App 装到我手机上：名字「今日一言」，包名 " + PKG + "，单页，图标主色 #E8590C，" +
  "工程目录 " + DIR + "。直接按 app_new → app_build → app_install → 启动 的顺序做，不要列目录、不要写 todo，最后三行内汇报。";

const sh = (cmd) => {
  try {
    return execFileSync("adb", ["shell", cmd], { encoding: "utf8", maxBuffer: 16 << 20, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return `${e.stdout || ""}${e.stderr || ""}`;
  }
};
const shot = (name) => execFileSync("adb", ["exec-out", "screencap", "-p"], { stdio: ["ignore", openSync(`.motion/verify/${name}`, "w"), "ignore"] });
const ok = (c, l, d = "") => console.log(`${c ? "PASS" : "FAIL"}  ${l}${d ? "  | " + String(d).replace(/\s+/g, " ").slice(0, 160) : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 免费额度按 token/分钟限流：开工前先探一次小请求，还在 429 就等
for (let i = 0; i < 12; i++) {
  const r = await fetch("http://127.0.0.1:8791/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + KEY },
    body: JSON.stringify({ model: "agnes-3.0-flash", messages: [{ role: "user", content: "ok" }], stream: false, max_tokens: 4 }),
  }).catch(() => null);
  if (r && r.status === 200) break;
  console.log(`  额度未恢复（${r ? r.status : "网络"}），等 20s…`);
  await sleep(20000);
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let id = 0;
const pend = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id;
  pend.set(i, (m) => res(m.result));
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.value;

// 模型配置：只有一个 agnes-3.0-flash，走宿主机中转（模拟器只有 10.0.2.2 可达）
const models = [{
  id: "agnes-3.0-flash", name: "Agnes 3.0 Flash", desc: "API Hub",
  url: RELAY, key: KEY, upstream: "agnes-3.0-flash", efforts: [], builtin: false,
}];
await ev(`localStorage.setItem("dsh.models", ${JSON.stringify(JSON.stringify(models))});
  localStorage.setItem("dsh.model", "agnes-3.0-flash");
  localStorage.setItem("dsh.perm", "full"); 1`);
await send("Page.reload", {});
await sleep(8000);

// 干净起点：卸载旧包、删掉旧工程
sh(`pm uninstall ${PKG} >/dev/null 2>&1; rm -rf /data/data/ai.deepseek.harness.mobile/files/workspace/${DIR}`);
await ev(`(() => { const b = document.querySelector("#btnNewSession"); if (b) b.click(); return 1; })()`);
await sleep(2000);

async function fillAndSend(text) {
  await ev(`(() => {
    const t = document.querySelector("#input");
    if (!t) return "no-input";
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(t, ${JSON.stringify(text)});
    t.dispatchEvent(new Event("input", { bubbles: true }));
    return "ok";
  })()`);
  await sleep(400);
  await ev(`document.querySelector("#btnSend").click(); 1`);
}
await fillAndSend(PROMPT);
console.log(`已发送需求：${PROMPT.slice(0, 40)}…\n`);

// 陪跑：自动确认安装弹窗 + 每 20 秒打印一行进度
const t0 = Date.now();
let transcript = "";
let lastReal = "";
let stable = 0;
let tapped = 0;
let lastPrint = 0;
for (let i = 0; i < 300; i++) {
  await sleep(2000);
  const focus = sh("dumpsys window | grep mCurrentFocus | head -1");
  if (/packageinstaller/i.test(focus)) {
    sh("uiautomator dump /sdcard/ua.xml >/dev/null 2>&1");
    const xml = sh("cat /sdcard/ua.xml");
    const m = [...xml.matchAll(/text="(安装|Install|INSTALL|更新|Update)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)][0];
    if (m) {
      sh(`input tap ${Math.round((+m[2] + +m[4]) / 2)} ${Math.round((+m[3] + +m[5]) / 2)}`);
      tapped++;
      console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] 已点系统安装按钮`);
    }
  }
  const snap = await ev(`(() => {
    const t = [...document.querySelectorAll("#messages .msg.assistant")].map(e => e.textContent || "").join("\\n");
    const stop = document.querySelector("#btnStop");
    return { t, busy: !!stop && getComputedStyle(stop).display !== "none" };
  })()`);
  // 占位文案（"深度求索中"）不是回答：它出现时轮次还没开始，不能当成结束信号
  const real = (snap?.t || "").replace(/深度求索中[^\n]*/g, "").trim();
  if (real) transcript = real;
  if ((Date.now() - t0) / 1000 - lastPrint > 40) {
    lastPrint = (Date.now() - t0) / 1000;
    console.log(`  [${lastPrint.toFixed(0)}s] 模型输出 ${transcript.length} 字 · 进行中=${snap?.busy}`);
  }
  if (real.length > 20) {
    stable = real === lastReal ? stable + 1 : 0;
    lastReal = real;
  }
  if (stable >= 3 && snap && !snap.busy) break;
}

const secs = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\n轮次结束（${secs}s），模型输出末尾：\n${transcript.slice(-700)}\n`);
ok(/app_new/.test(transcript), "模型使用了 app_new", transcript.match(/app_new[^\n]{0,40}/)?.[0] || "");
ok(/app_build/.test(transcript), "模型使用了 app_build", transcript.match(/app_build[^\n]{0,40}/)?.[0] || "");
ok(/app_install|已安装|安装成功/.test(transcript), "模型走到安装", transcript.match(/app_install[^\n]{0,40}/)?.[0] || "");

const listed = sh(`pm list packages ${PKG}`).trim();
ok(listed.includes(PKG), "系统里出现 com.dsh.yiyan", listed || "(未安装)");
if (tapped === 0) console.log("  （本轮没有弹系统安装框，可能模型没走到 app_install）");

if (listed.includes(PKG)) {
  sh(`am force-stop ${PKG}; am start -n ${PKG}/.MainActivity >/dev/null 2>&1`);
  let focus = "";
  for (let i = 0; i < 12; i++) {
    await sleep(1500);
    focus = sh("dumpsys window | grep mCurrentFocus | head -1");
    if (focus.includes(PKG)) break;
  }
  ok(focus.includes(PKG), "造好的 App 能启动", focus.trim());
  shot("screen-agent-app.png");
  console.log("截图：.motion/verify/screen-agent-app.png");
}
process.exit(0);
