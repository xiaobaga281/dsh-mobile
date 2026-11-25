// 自造插件体验验证：phone_list_apps 是否能看到全部应用 + plugin_* 工具是否可用
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

await ev(`(() => {
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
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    let r = await ev(`window.__tres[${JSON.stringify(tid)}] || null`);
    if (r) {
      try { r = typeof r === "string" ? JSON.parse(r) : r; } catch (_) { return { ok: false, raw: String(r).slice(0, 120) }; }
      if (r && typeof r.output === "string") { try { return JSON.parse(r.output); } catch (_) { return { ok: false, raw: r.output.slice(0, 120) }; } }
      return r;
    }
  }
  return { ok: false, error: "10s 无结果" };
};

// 1) phone_list_apps：QUERY_ALL_PACKAGES 之后应该能看到全部可启动应用
const apps = await tool("phone_list_apps", { limit: 300 });
ok(apps.ok === true, "phone_list_apps 执行", JSON.stringify(apps).slice(0, 100));
const n = apps.count ?? apps.apps?.length ?? 0;
console.log(`      可启动应用数 = ${n}`);
console.log(`      样例: ${(apps.apps || []).slice(0, 8).map((a) => a.package).join(", ")}`);
ok(n > 10, "能看到全部应用（不止 DeepSeek 自己）", `count=${n}`);

// 2) plugin_* 工具在模型工具表里可用
const spec = await tool("plugin_spec", {});
ok(spec.ok !== false && String(spec).includes("清单"), "plugin_spec 可读（制造规范）", String(spec).slice(0, 80));
const pl = await tool("plugin_list", {});
ok(pl.ok === true, "plugin_list 执行", JSON.stringify(pl).slice(0, 120));
console.log(`      已装配插件: ${(pl.installed || []).map((p) => p.id).join(", ") || "无"}`);

process.exit(0);
