// 自造插件端到端：plugin_create 装一个「按名字开应用」插件（js 处理器组合
// phone_list_apps + phone_open_app），调用它真把 Chrome 拉起，再卸载。
// 证明：不需要源码、不需要签名，清单插件当轮装配当轮可用。
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
const ok = (c, l, d = "") => console.log(`${c ? "PASS" : "FAIL"}  ${l}${d ? "  | " + String(d).replace(/\s+/g, " ").slice(0, 200) : ""}`);
const foreground = () => execSync("adb shell dumpsys activity activities", { maxBuffer: 1 << 22 }).toString().match(/mResumedActivity[^\n]*/)?.[0] ?? "";
const hook = () => ev(`(() => {
  window.__tres = {};
  const h = window.DSHHost;
  if (h && h.onToolResult) {
    const orig = h.onToolResult.bind(h);
    h.onToolResult = (id, json) => { window.__tres[id] = json; try { orig(id, json); } catch (e) {} };
  }
  return 1;
})()`);
const tool = async (name, args) => {
  const tid = "t" + Math.random().toString(36).slice(2, 7);
  await ev(`window.DSHNativeKernel.toolCall(${JSON.stringify(tid)}, ${JSON.stringify(name)}, ${JSON.stringify(JSON.stringify(args || {}))}); 1`);
  for (let i = 0; i < 150; i++) {
    await sleep(100);
    let r = await ev(`window.__tres[${JSON.stringify(tid)}] || null`);
    if (r) {
      try { r = typeof r === "string" ? JSON.parse(r) : r; } catch (_) { return { ok: false, raw: String(r).slice(0, 150) }; }
      if (r && typeof r.output === "string") {
        try { return JSON.parse(r.output); } catch (_) { return { ok: true, text: r.output }; }
      }
      return r;
    }
  }
  return { ok: false, error: "15s 无结果" };
};

// 0) 完全授权档：plugin_create 免逐次确认（该档位的真实含义，见规范 §1）
await ev(`localStorage.setItem("dsh.perm", "full"); 1`);
await send("Page.reload", {});
await sleep(6000);
ok((await hook()) === 1, "权限档 full + 页面重载 + 结果钩子");

// 1) plugin_create：纯 JS 清单插件，组合既有 phone_* 工具
const CODE = [
  "const label = String(dsh.args.label || '').trim().toLowerCase();",
  "if (!label) throw new Error('label 不能为空');",
  "const r = await dsh.callTool('phone_list_apps', { limit: 300 });",
  "const list = JSON.parse(r);",
  "const hit = (list.apps || []).find(a => a.label.toLowerCase().includes(label) || a.package.toLowerCase().includes(label));",
  "if (!hit) return '没有找到名字或包名含「' + dsh.args.label + '」的应用，共 ' + (list.apps || []).length + ' 个可启动应用';",
  "const o = await dsh.callTool('phone_open_app', { package: hit.package });",
  "return '已启动 ' + hit.label + '（' + hit.package + '）';",
].join("\n");
const created = await tool("plugin_create", {
  id: "app-launcher",
  name: "按名字开应用",
  description: "按应用名或包名片段启动应用：组合 phone_list_apps 与 phone_open_app",
  handler: "js",
  code: CODE,
  prompt: "用户说「打开 Chrome / 开相机」这类按名字启动应用的需求时用 launch_app，label 给应用名或包名片段。",
  tools: [{
    name: "launch_app",
    description: "按应用名或包名片段启动一个应用（如 chrome / 相机）",
    parameters: { type: "object", properties: { label: { type: "string", description: "应用名或包名片段" } }, required: ["label"] },
  }],
});
ok(created.ok === true, "plugin_create 装配成功（无源码/无签名参与）", JSON.stringify(created).slice(0, 150));

// 2) 调用新工具：当轮即可用；验证 Chrome 真的到了前台
const before = foreground();
console.log(`      调用前前台: ${before.slice(0, 90)}`);
const launched = await tool("launch_app", { label: "chrome" });
ok(launched.ok !== false, "launch_app 调用成功", (launched.text || JSON.stringify(launched)).slice(0, 120));
await sleep(3500);
const after = foreground();
console.log(`      调用后前台: ${after.slice(0, 90)}`);
ok(/chrome/i.test(after), "Chrome 已到前台（插件真的驱动了手机）", after.slice(0, 90));

// 3) 收尾：卸载，恢复原状
const un = await tool("plugin_uninstall", { id: "app-launcher" });
ok(un.ok === true, "plugin_uninstall 清理", JSON.stringify(un).slice(0, 100));

process.exit(0);
