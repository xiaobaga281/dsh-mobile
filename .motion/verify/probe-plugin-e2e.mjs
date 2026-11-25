// 自造插件全链路（真实模型轮次）：让 Agent 自己 plugin_spec → plugin_create →
// 调用 launch_app 打开 Chrome → plugin_uninstall。探针只做两件事：发指令、
// 替用户点审批卡。验证：不碰源码/签名，插件当轮装配当轮可用、能驱动手机。
import { execSync } from "node:child_process";

const PORT = 9227;
let list = [];
for (let i = 0; i < 20 && list.length === 0; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch (_) {}
}
const page = list.find((p) => p.type === "page" && p.url.includes("appassets"));
if (!page) { console.log("FAIL  没找到 appassets 页面目标"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, l, d = "") => console.log(`${c ? "PASS" : "FAIL"}  ${l}${d ? "  | " + String(d).replace(/\s+/g, " ").slice(0, 180) : ""}`);
const sh = (c) => { try { return execSync(c, { maxBuffer: 1 << 22 }).toString(); } catch (_) { return ""; } };
// dumpsys activity activities 全文能超 4MB（execSync maxBuffer 炸掉被吞）——grep 放设备侧
const foreground = () => sh(`adb shell "dumpsys activity activities | grep -m1 ResumedActivity"`);

// 0) 完全授权会话 + 新会话
await ev(`localStorage.setItem("dsh.perm", "full"); 1`);
await send("Page.reload", {});
await sleep(6000);
await ev(`(() => { const b = document.querySelector("#btnNewSession"); if (b) b.click(); return 1; })()`);
await sleep(2500);
const screen = await ev(`(() => { const s = [...document.querySelectorAll(".screen")].filter(x => getComputedStyle(x).display !== "none"); return s.map(x => x.id).join(","); })()`);
ok(/screen-chat/.test(screen), "进入对话页", screen);

// 1) 指令：清单 JSON 一字不改地交给 plugin_create，避免模型转述走样
const CODE = "const k=String(dsh.args.label||'').trim().toLowerCase();if(!k) throw new Error('label 为空');const r=await dsh.callTool('phone_list_apps',{limit:300});const l=JSON.parse(r);const hit=(l.apps||[]).find(a=>a.label.toLowerCase().includes(k)||a.package.toLowerCase().includes(k));if(!hit) throw new Error('没有应用: '+dsh.args.label);await dsh.callTool('phone_open_app',{package:hit.package});return hit.package;";
const manifest = {
  id: "app-launcher", name: "按名字开应用",
  description: "按应用名或包名片段启动应用：组合 phone_list_apps 与 phone_open_app",
  handler: "js", code: CODE,
  tools: [{ name: "launch_app", description: "按应用名或包名片段启动一个应用",
    parameters: { type: "object", properties: { label: { type: "string", description: "应用名或包名片段" } }, required: ["label"] } }],
};
const prompt = "严格按步骤执行，不要提问，不要改任何内容：\n" +
  "1) 调用 plugin_spec 读一遍规范；\n" +
  "2) 调用 plugin_create，整个参数的各字段一字不改：\n" + JSON.stringify(manifest) + "\n" +
  "3) 调用 launch_app，label 填 chrome；\n" +
  "4) 调用 plugin_uninstall，id 填 app-launcher；\n" +
  "5) 最后只回复一行：已完成，启动的是 <当时 launch_app 返回的包名>";

const typed = await ev(`(() => {
  const t = document.querySelector("#input");
  if (!t) return "no-input";
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(t, ${JSON.stringify(prompt)});
  t.dispatchEvent(new Event("input", { bubbles: true }));
  return "ok";
})()`);
await ev(`(() => { document.querySelector("#btnSend").click(); return 1; })()`);
ok(typed === "ok", "指令已发送");

// 2) 轮询：自动点审批卡（模拟用户点「本次允许」），采样前台，等收尾
let chromeSeen = false, chromeAt = "", last = "", stable = 0, approved = 0;
const t0 = Date.now();
for (let i = 0; i < 240 && Date.now() - t0 < 300000; i++) {
  await sleep(1250);
  const clicked = await ev(`(() => {
    const cards = [...document.querySelectorAll("[data-approval]")].filter(c => !c.classList.contains("is-resolved"));
    if (!cards.length) return 0;
    const btn = cards[cards.length - 1].querySelector('[data-approve="once"]') ||
                cards[cards.length - 1].querySelector(".approval-actions button");
    if (!btn) return 0;
    btn.click(); return 1;
  })()`);
  if (clicked) approved++;
  const fg = foreground();
  if (/chrome/i.test(fg) && !chromeSeen) { chromeSeen = true; chromeAt = `${Math.round((Date.now() - t0) / 1000)}s`; }
  const snap = await ev(`(() => {
    const txt = [...document.querySelectorAll("#messages .msg.assistant")].map(e => e.textContent || "").join(" ");
    const stop = !!document.querySelector("#btnStop") && getComputedStyle(document.querySelector("#btnStop")).display !== "none";
    const open = [...document.querySelectorAll("[data-approval]")].some(c => !c.classList.contains("is-resolved"));
    return { tail: txt.slice(-300), stop, open };
  })()`);
  if (snap?.tail === last) stable++; else { stable = 0; last = snap?.tail || ""; }
  // 收尾判定要钝一点：工具执行中途（无流式输出、审批未挂起）也会出现假稳定
  if (!snap?.stop && !snap?.open && stable >= 8 && Date.now() - t0 > 30000 && last.trim().length > 0) break;
}
console.log(`      审批卡自动点了 ${approved} 次；Chrome 到前台: ${chromeSeen}（${chromeAt}）`);
console.log(`      模型收尾: ${last.trim().slice(-160)}`);
ok(approved > 0, "审批闸门工作正常（有卡、点了、放行）", `approvals=${approved}`);
ok(chromeSeen, "launch_app 真把 Chrome 拉到了前台");

// 3) 确认插件已卸载、无残留
const pl = await ev(`window.DSHNativeKernel.toolCall("chk", "plugin_list", "{}"); 1`);
await sleep(1500);
const plRaw = await ev(`window.__tres["chk"] || ""`);
const plObj = (() => { try { return JSON.parse(JSON.parse(plRaw).output); } catch (_) { return null; } })();
const still = (plObj?.installed || []).some((p) => p.id === "app-launcher");
ok(plObj && !still, "plugin_uninstall 已清理（列表里没有 app-launcher）", JSON.stringify(plObj?.installed?.map((p) => p.id) || []).slice(0, 120));

process.exit(0);
