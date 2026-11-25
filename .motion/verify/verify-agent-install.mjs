// 真实场景：让 Agent 自己把工作区里的 APK 装到手机上（模型决策 → app_install → 系统确认 → 回报）
import { execFileSync } from "node:child_process";
const sh = (a) => execFileSync("adb", a, { encoding: "utf8", maxBuffer: 8 << 20 });
const shq = (c) => sh(["shell", c]);
const PORT = 9227;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, (m) => res(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, l, d = "") => console.log(`${c ? "PASS" : "FAIL"}  ${l}${d ? "  | " + String(d).replace(/\s+/g, " ").slice(0, 170) : ""}`);

await shq("am start -n ai.deepseek.harness.mobile/.MainActivity");
await sleep(3000);
await ev(`(() => { const b = document.querySelector("#btnNewSession"); if (b) b.click(); return 1; })()`);
await sleep(2000);
const prompt = "工作区里有个 demo.apk，请用 app_install 工具把它安装到这台手机上，装好告诉我结果。";
await ev(`(() => {
  const t = document.querySelector("#input");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(t, ${JSON.stringify(prompt)});
  t.dispatchEvent(new Event("input", { bubbles: true }));
  return 1;
})()`);
await ev(`document.querySelector("#btnSend").click(); 1`);
console.log("已发送安装请求，等模型调用 app_install…");

function tapConfirm() {
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
        console.log(`  确认安装：点「${text}」`);
        return true;
      }
    }
  } catch (_) {}
  return false;
}

let txt = "", taps = 0;
for (let i = 0; i < 120; i++) {
  await sleep(2000);
  try {
    const focus = shq("dumpsys window | grep mCurrentFocus | head -1");
    if (/packageinstaller|PackageInstaller/i.test(focus) && taps < 3) { if (tapConfirm()) taps++; }
  } catch (_) {}
  const snap = await ev(`(() => {
    const a = [...document.querySelectorAll("#messages .msg.assistant")].map(e => e.textContent || "").join(" · ");
    const stop = document.querySelector("#btnStop");
    const tool = /app_install/.test(document.querySelector("#messages")?.textContent || "");
    return { t: a, tool, stop: !!stop && getComputedStyle(stop).display !== "none" };
  })()`).catch(() => null);
  if (snap?.t) txt = snap.t;
  if (txt && /安装/.test(txt) && !snap?.stop && i > 6) break;
}
console.log("汇报:", JSON.stringify(txt.slice(-260)));
ok(taps >= 1, "系统安装器被拉起并确认", `taps=${taps}`);
ok(/安装|已装|装好/.test(txt), "Agent 汇报了安装结果", txt.slice(-180));
const pkgs = shq("pm list packages com.dsh.demo").trim();
ok(/com\.dsh\.demo/.test(pkgs), "系统里确实装上了", pkgs);
process.exit(0);
