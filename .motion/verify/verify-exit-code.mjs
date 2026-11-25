// 前台命令退出码验收（真机）—— 内核信封 + 界面徽标，一条命令跑完
//
//   node .motion/verify/verify-exit-code.mjs
//
// 前置：debug 包已装，且
//   adb forward tcp:9227 localabstract:webview_devtools_remote_<pid>
//
// 两段：
//   1) 信封：直接调内核（DSHNativeKernel.toolCall），断言 exit_code 只在命令类工具、
//      后台回执上出现；非命令工具不许凭空多出字段。
//   2) 徽标：起一个只回三条 bash 调用的 OpenAI 兼容桩 → 指给应用 → 新建会话发一句话
//      → 断言「本轮过程」里 exit 0 灰 / exit 1 红 / exit 7 红。
//      桩模型只是触发器：这里验的是「退出码从内核到徽标」的管道，不受真模型与网络影响。
import http from "node:http";
import { writeFileSync } from "node:fs";

const PORT = +(process.env.CDP_PORT || 9227);
const STUB_PORT = +(process.env.STUB_PORT || 8899);
// 模拟器访问宿主机用 10.0.2.2；真机换成局域网 IP（debug 包只放行了 10.0.2.2/localhost）
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

/* ---------------- 1) 内核信封 ---------------- */
await ev(`(() => {
  window.__ec = {};
  if (!window.DSHHost.__ecHooked) {
    const orig = window.DSHHost.onToolResult?.bind(window.DSHHost);
    window.DSHHost.onToolResult = (cid, result) => { window.__ec[cid] = result; try { orig && orig(cid, result); } catch (_) {} };
    window.DSHHost.__ecHooked = true;
  }
  return 1;
})()`);

let seq = 0;
async function toolCall(name, args, timeoutMs = 60000) {
  const cid = `ec-${++seq}`;
  await ev(`window.DSHNativeKernel.toolCall(${JSON.stringify(cid)}, ${JSON.stringify(name)}, ${JSON.stringify(JSON.stringify(args))}); 1`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await ev(`window.__ec[${JSON.stringify(cid)}] || null`);
    if (r !== null) return JSON.parse(r);
    await sleep(200);
  }
  throw new Error(`toolCall ${name} 超时`);
}

console.log("—— 内核信封 ——");
for (const [label, command, want] of [
  ["true", "true", 0],
  // Android 的 toybox ls 失败退出码是 1（GNU ls 才是 2）——按设备实测写，别照抄桌面
  ["ls /nope", "ls /nope", 1],
  ['sh -c "exit 7"', 'sh -c "exit 7"', 7],
]) {
  const r = await toolCall("bash", { description: label, command });
  check(r.ok === true && r.exit_code === want, `bash ${label} → exit_code=${r.exit_code}（期望 ${want}）`,
    JSON.stringify(String(r.output || "").slice(0, 50)));
}
const rd = await toolCall("read", { file_path: "nope.txt" }).catch(() => null);
check(rd && !("exit_code" in rd), "非命令工具没有 exit_code 字段", JSON.stringify(rd).slice(0, 90));
const bg = await toolCall("bash", { description: "后台", command: "sleep 5", run_in_background: true });
check(bg && !("exit_code" in bg), "后台回执没有 exit_code（回的是 job_id）", JSON.stringify(bg).slice(0, 90));

/* ---------------- 2) 界面徽标 ---------------- */
console.log("—— 界面徽标 ——");

// 只回三条 bash 调用的桩；带 tool 结果再来时回一句收尾文本
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method !== "POST") { res.writeHead(404).end(); return; }
    let j = {};
    try { j = JSON.parse(body); } catch (_) {}
    const msgs = Array.isArray(j.messages) ? j.messages : [];
    const hasTools = Array.isArray(j.tools) && j.tools.length > 0;
    const gotToolResult = msgs.some((m) => m.role === "tool");

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const base = { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1, model: "stub" };
    const chunk = (delta, finish = null) =>
      res.write("data: " + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n");
    if (hasTools && !gotToolResult) {
      chunk({ role: "assistant", content: "" });
      [
        { id: "call_true", args: { description: "空命令看退出码", command: "true" } },
        { id: "call_ls", args: { description: "列不存在的目录", command: "ls /nope" } },
        { id: "call_exit7", args: { description: "指定退出码 7", command: 'sh -c "exit 7"' } },
      ].forEach((c, i) => chunk({
        tool_calls: [{ index: i, id: c.id, type: "function", function: { name: "bash", arguments: JSON.stringify(c.args) } }],
      }));
      chunk({}, "tool_calls");
    } else {
      // 标题生成等旁路请求也走这里：一律回纯文本
      chunk({ role: "assistant", content: "三条命令都跑完了。" });
      chunk({}, "stop");
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => server.listen(STUB_PORT, "127.0.0.1", r));

// 覆盖前先备份，跑完恢复：这个脚本会动模型配置，不能留下桩
const backup = JSON.parse(await ev(`JSON.stringify({ models: localStorage.getItem("dsh.models"), model: localStorage.getItem("dsh.model") })`));
const stub = [{ id: "stub", name: "Stub", desc: "本地桩（退出码验收）", url: STUB_URL, key: "stub", upstream: "stub", efforts: [], builtin: false }];
await ev(`localStorage.setItem("dsh.models", ${JSON.stringify(JSON.stringify(stub))}); localStorage.setItem("dsh.model", "stub"); 1`);
await send("Page.reload", {});
await sleep(7000);

try {
  await ev(`(()=>{ document.querySelector('.tab[data-tab="chat"]')?.click(); document.getElementById("btnNewSession")?.click(); return 1 })()`);
  await sleep(1500);

  const filled = await ev(`(() => {
    const i = document.getElementById("input");
    i.value = "帮我跑三条命令：true、ls /nope、sh -c \\"exit 7\\"";
    i.dispatchEvent(new Event("input", { bubbles: true }));
    return document.getElementById("btnSend").disabled ? "disabled" : "ok";
  })()`);
  check(filled === "ok", "输入框与发送按钮就绪", filled);
  if (filled === "ok") {
    await ev(`document.getElementById("btnSend").click(); 1`);
    // 只数「本轮过程」卡片：历史行里旧的徽标不算
    const deadline = Date.now() + 90_000;
    let badges = [];
    while (Date.now() < deadline) {
      badges = (await ev(`[...document.querySelectorAll(".turnproc.is-turn .pg-exit")].map((e)=>({t:(e.textContent||"").trim(), bad:e.classList.contains("is-bad")}))`)) || [];
      if (badges.length >= 3) break;
      await sleep(600);
    }
    [["exit 0", false], ["exit 1", true], ["exit 7", true]].forEach(([t, bad], i) => {
      const got = badges[i];
      check(got && got.t === t && got.bad === bad, `${t}（${bad ? "红" : "灰"}）`, JSON.stringify(got));
    });
    const png = await send("Page.captureScreenshot", { format: "png" }).then((r) => r.data).catch(() => null);
    if (png) {
      writeFileSync(".motion/verify/exit-badges.png", Buffer.from(png, "base64"));
      console.log("shot: .motion/verify/exit-badges.png");
    }
  }
} finally {
  // 恢复模型配置并重新加载，别把桩留在应用里
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
