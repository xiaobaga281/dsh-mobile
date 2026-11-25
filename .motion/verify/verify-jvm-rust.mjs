// M4 验收：java 工具（真 jar 端到端）+ rustc 扩展位（NEED_RUNTIME）+ compile/run 回归
const PORT = +(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 9227);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); setTimeout(() => rej(new Error("ws-timeout")), 8000); });
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (m) => m.error ? rej(new Error(m.error.message)) : res(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await ev(`(() => {
  window.__m4 = { results: {} };
  if (window.DSHHost && !window.DSHHost.__m4Hooked) {
    const orig = window.DSHHost.onToolResult?.bind(window.DSHHost);
    window.DSHHost.onToolResult = (id, result) => { window.__m4.results[id] = result; try { orig && orig(id, result); } catch (_) {} };
    window.DSHHost.__m4Hooked = true;
  }
  return 'hooked';
})()`);
let seq = 0;
async function toolCall(name, args, timeoutMs = 240000) {
  const id = `m4-${++seq}`;
  const trig = await ev(`(() => { try { window.DSHNativeKernel.toolCall(${JSON.stringify(id)}, ${JSON.stringify(name)}, ${JSON.stringify(JSON.stringify(args))}); return "ok"; } catch (e) { return "EXC:" + e; } })()`);
  if (trig !== "ok") throw new Error(`toolCall ${name} 触发失败: ${trig}`);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await ev(`window.__m4.results[${JSON.stringify(id)}] || null`);
    if (r != null) return { json: JSON.parse(r), ms: Date.now() - t0 };
    await sleep(250);
  }
  throw new Error(`toolCall ${name} 超时`);
}
const ok = (cond, label, extra = "") => console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  | " + extra : ""}`);

// 1) java：用 python 现场手写 class 文件 → 打成 jar（JRE headless 无 javac）
const PY = `
import struct, zipfile, os
def utf8(s):
    b = s.encode()
    return b'\\x01' + struct.pack('>H', len(b)) + b
def cls(i):
    return b'\\x07' + struct.pack('>H', i)
cp = [utf8('T'), cls(1), utf8('java/lang/Object'), cls(3),
      utf8('main'), utf8('([Ljava/lang/String;)V'), utf8('Code')]
b = b'\\xca\\xfe\\xba\\xbe' + struct.pack('>HH', 0, 52) + struct.pack('>H', len(cp)+1) + b''.join(cp)
b += struct.pack('>HHH', 0x0021, 2, 4) + struct.pack('>H', 0) + struct.pack('>H', 0)
b += struct.pack('>H', 1) + struct.pack('>HHH', 0x0009, 5, 6)
code = b'\\xb1'
attr = struct.pack('>H', 7) + struct.pack('>I', 2+2+4+len(code)+2+2) + struct.pack('>HH', 0, 1) + struct.pack('>I', len(code)) + code + struct.pack('>HH', 0, 0)
b += struct.pack('>H', 1) + attr + struct.pack('>H', 0)
open('T.class', 'wb').write(b)
with zipfile.ZipFile('probe.jar', 'w') as z:
    z.writestr('META-INF/MANIFEST.MF', 'Manifest-Version: 1.0\\r\\nMain-Class: T\\r\\n\\r\\n')
    z.writestr('T.class', b)
print('jar', os.path.getsize('probe.jar'), 'class', len(b))
`;
const p1 = await toolCall("python", { description: "手写 class 打包 jar", code: PY });
ok(/exit=0/.test(JSON.stringify(p1.json)) && /jar \d+ class \d+/.test(JSON.stringify(p1.json)), "生成 probe.jar", JSON.stringify(p1.json).slice(0, 160));

const j1 = await toolCall("java", { description: "运行 probe.jar", file: "probe.jar", flags: ["-Xmx64m"], timeoutMs: 120000 });
ok(/exit=0/.test(JSON.stringify(j1.json)), "java 运行 jar（真字节码）", JSON.stringify(j1.json).slice(0, 200) + ` ${j1.ms}ms`);

const j2 = await toolCall("java", { description: "JVM 版本查询", file: "probe.jar", flags: ["-version"], timeoutMs: 120000 });
ok(/openjdk version "21/.test(JSON.stringify(j2.json)), "java -version → OpenJDK 21", JSON.stringify(j2.json).slice(0, 200));

// 2) rustc 扩展位：应回 NEED_RUNTIME（载荷未含 rust）
await toolCall("bash", { description: "写 rust 源", command: "printf 'fn main(){println!(\"rust-ok\");}' > t.rs && echo ok" });
const r2 = await toolCall("rustc", { description: "编译 rust", file: "t.rs", out: "tbin" });
ok(!r2.json.ok && /NEED_RUNTIME:rustc/.test(r2.json.error || ""), "rustc 扩展位回 NEED_RUNTIME", JSON.stringify(r2.json).slice(0, 200));

// 3) compile/run 回归（确认新载荷没破坏老链路）
await toolCall("bash", { description: "写 C 源", command: "printf '#include <stdio.h>\\nint main(){printf(\"%%d\\\\n\", 7*6);return 0;}' > m4.c && echo ok" });
const c2 = await toolCall("compile", { description: "编译 m4", file: "m4.c", out: "m4" });
ok(/exit=0/.test(JSON.stringify(c2.json)), "compile 回归", JSON.stringify(c2.json).slice(0, 120));
const r3 = await toolCall("run", { description: "运行 m4", file: "m4" });
ok(/42/.test(JSON.stringify(r3.json)), "run 回归 → 42", JSON.stringify(r3.json).slice(0, 120));

process.exit(0);
