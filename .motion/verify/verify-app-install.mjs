// 端到端验证：app_install 把工作区里的 demo.apk 交给系统安装器，并自动点「安装」确认
import { execFileSync } from "node:child_process";

const PORT = 9227;
const ADB = process.env.ADB || "adb";
const sh = (args) => execFileSync(ADB, args, { encoding: "utf8", maxBuffer: 8 << 20 });
const shq = (cmd) => sh(["shell", cmd]);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const ev = async (expr) => (await new Promise((res) => { const i = ++id; pend.set(i, (m) => res(m.result)); ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } })); })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, l, d = "") => console.log(`${c ? "PASS" : "FAIL"}  ${l}${d ? "  | " + String(d).replace(/\s+/g, " ").slice(0, 160) : ""}`);

await ev(`window.__ins = { r: {} }; window.DSHHost.onToolResult = (id, r) => { window.__ins.r[id] = r; }; 1`);
await ev(`window.DSHNativeKernel.toolCall("ins-1", "app_install", JSON.stringify({ description: "安装演示应用", file: "demo.apk", timeoutMs: 150000 })); 1`);
console.log("已触发 app_install，开始等待系统安装器…");

/** 在当前窗口里找「安装」按钮并点它 */
function tapInstall() {
  try {
    shq("uiautomator dump /sdcard/ui.xml");
    const xml = shq("cat /sdcard/ui.xml");
    const re = /text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
    let m;
    while ((m = re.exec(xml))) {
      const [, text, x1, y1, x2, y2] = m;
      if (/^(安装|Install|INSTALL|更新|Update|继续|Continue)$/i.test(text.trim())) {
        const x = (Number(x1) + Number(x2)) / 2, y = (Number(y1) + Number(y2)) / 2;
        shq(`input tap ${Math.round(x)} ${Math.round(y)}`);
        console.log(`  点击「${text}」@ ${Math.round(x)},${Math.round(y)}`);
        return true;
      }
    }
  } catch (e) {
    console.log("  tap 失败:", String(e.message).slice(0, 80));
  }
  return false;
}

let result = null;
for (let i = 0; i < 60; i++) {
  await sleep(3000);
  const focus = (() => { try { return shq("dumpsys window | grep mCurrentFocus | head -1"); } catch { return ""; } })();
  if (/packageinstaller|PackageInstaller/i.test(focus)) tapInstall();
  const r = await ev(`window.__ins.r["ins-1"] || null`);
  if (r != null) { result = JSON.parse(r); break; }
}
console.log("工具返回:", JSON.stringify(result).slice(0, 240));
ok(!result || result.ok, "app_install 返回成功", JSON.stringify(result).slice(0, 200));

const pkgs = shq("pm list packages com.dsh.demo").trim();
ok(/com\.dsh\.demo/.test(pkgs), "系统里已安装 com.dsh.demo", pkgs);
process.exit(0);
