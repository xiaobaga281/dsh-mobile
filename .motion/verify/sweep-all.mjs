// 全功能冒烟：分组打真实工具调用，逐项判 PASS / FAIL / SKIP（环境不具备）
const PORT = +(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 9227);
const ONLY = (() => { const i = process.argv.indexOf("--only"); return i > 0 ? process.argv[i + 1].split(",") : null; })();

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page") || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); setTimeout(() => rej(new Error("ws-timeout")), 8000); });
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await ev(`(() => {
  window.__sw = { results: {} };
  window.DSHHost.onToolResult = (id, result) => { window.__sw.results[id] = result; };
  return 'hooked';
})()`);
let seq = 0;
async function call(name, args = {}, timeoutMs = 180000) {
  const callId = `sw-${++seq}`;
  const trig = await ev(`(() => { try { window.DSHNativeKernel.toolCall(${JSON.stringify(callId)}, ${JSON.stringify(name)}, ${JSON.stringify(JSON.stringify(args))}); return "ok"; } catch (e) { return "EXC:" + e; } })()`);
  if (trig !== "ok") return { ok: false, error: trig, code: "TRIGGER" };
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await ev(`window.__sw.results[${JSON.stringify(callId)}] || null`);
    if (r != null) return JSON.parse(r);
    await sleep(200);
  }
  return { ok: false, error: `timeout ${timeoutMs}ms`, code: "TIMEOUT" };
}

const results = [];
const J = (r) => JSON.stringify(r ?? {});
/** 取可见文本（工具结果里的 output/error），避免 JSON 转义干扰断言 */
const U = (r) => String((r && (r.output ?? r.error ?? "") ) + "");
/** 工具输出本身是 JSON 字符串时解一层 */
const P = (r) => { try { return JSON.parse(U(r)); } catch (_) { return null; } };
function rec(group, name, status, detail = "") {
  results.push({ group, name, status, detail: String(detail).replace(/\s+/g, " ").slice(0, 160) });
  console.log(`${status.padEnd(4)} [${group}] ${name}${detail ? "  | " + String(detail).replace(/\s+/g, " ").slice(0, 120) : ""}`);
}
async function test(group, name, fn) {
  if (ONLY && !ONLY.includes(group)) return;
  try {
    const r = await fn();
    if (r === true || r?.ok === true) return rec(group, name, "PASS", r?.note || "");
    if (r?.skip) return rec(group, name, "SKIP", r.skip);
    return rec(group, name, "FAIL", r?.detail || J(r));
  } catch (e) {
    rec(group, name, "FAIL", e?.message || String(e));
  }
}

const T = ".swtest";
const file = (n) => `${T}/${n}`;

/* ---------------- A. 工作区文件能力 ---------------- */
await test("fs", "mkdir", async () => {
  const r = await call("mkdir", { path: T + "/sub" });
  return { ok: r.ok, detail: J(r) };
});
await test("fs", "write", async () => {
  const r = await call("write", { file_path: file("a.txt"), content: "alpha\nbeta\ngamma\n" });
  return { ok: r.ok, detail: J(r) };
});
await test("fs", "read", async () => {
  const r = await call("read", { file_path: file("a.txt") });
  return { ok: r.ok && /beta/.test(J(r)), detail: J(r) };
});
await test("fs", "edit", async () => {
  const r = await call("edit", { file_path: file("a.txt"), old_string: "beta", new_string: "BETA" });
  const rd = await call("read", { file_path: file("a.txt") });
  return { ok: r.ok && /BETA/.test(J(rd)), detail: J(rd).slice(0, 120) };
});
await test("fs", "copy", async () => {
  const r = await call("copy", { from: file("a.txt"), to: file("sub/b.txt") });
  const st = await call("stat", { path: file("sub/b.txt") });
  return { ok: r.ok && /b\.txt/.test(J(st)), detail: J(st) };
});
await test("fs", "move", async () => {
  const r = await call("move", { from: file("sub/b.txt"), to: file("sub/c.txt") });
  const st = await call("stat", { path: file("sub/c.txt") });
  return { ok: r.ok && /c\.txt/.test(J(st)), detail: J(st) };
});
await test("fs", "glob", async () => {
  const r = await call("glob", { pattern: T + "/**/*.txt" });
  return { ok: r.ok && /a\.txt/.test(J(r)), detail: J(r) };
});
await test("fs", "grep", async () => {
  const r = await call("grep", { pattern: "BETA" });
  return { ok: r.ok && /a\.txt/.test(J(r)), detail: J(r) };
});
await test("fs", "list_dir", async () => {
  const r = await call("list_dir", { path: T });
  return { ok: r.ok && /a\.txt/.test(J(r)), detail: J(r) };
});
await test("fs", "stat", async () => {
  const r = await call("stat", { path: file("a.txt") });
  return { ok: r.ok, detail: J(r) };
});
await test("fs", "undo", async () => {
  const r = await call("undo", { action: "list" });
  return { ok: r.ok, detail: U(r).slice(0, 120) };
});
await test("fs", "delete_path", async () => {
  const r = await call("delete_path", { path: T + "/sub" });
  const st = await call("stat", { path: T + "/sub" });
  return { ok: r.ok && !st.ok, detail: J(st) };
});

/* ---------------- B. 执行 / 运行时 ---------------- */
await test("exec", "bash", async () => {
  const r = await call("bash", { description: "冒烟 echo", command: "echo hi && uname -s" });
  return { ok: r.ok && /exit=0/.test(J(r)) && /hi/.test(J(r)), detail: J(r) };
});
await test("exec", "bash 非零退出", async () => {
  const r = await call("bash", { description: "退出码", command: "exit 3" });
  const s = J(r);
  return { ok: /exit=3/.test(s) || r.ok === false, detail: s };
});
await test("exec", "python", async () => {
  const r = await call("python", { description: "py 冒烟", code: "import sys, json; print(json.dumps({'v': sum(range(5)), 'py': sys.version_info[0]}))" });
  return { ok: r.ok && /"v":\s*10/.test(U(r)), detail: U(r) };
});
await test("exec", "node", async () => {
  const r = await call("node", { description: "node 冒烟", code: "console.log(JSON.stringify({v:[1,2,3].map(x=>x*2)}))" });
  return { ok: r.ok && /\[2,4,6\]/.test(U(r)), detail: U(r) };
});
await test("exec", "compile+run C", async () => {
  await call("write", { file_path: file("m.c"), content: '#include <stdio.h>\nint main(){int s=0;for(int i=0;i<5;i++)s+=i;printf("%d\\n",s);return 0;}\n' });
  const c = await call("compile", { description: "编译 m.c", file: file("m.c"), out: file("m") });
  const r = await call("run", { description: "运行 m", file: file("m") });
  return { ok: c.ok && r.ok && /(^|\D)10(\D|$)/.test(U(r)), detail: U(r) };
});
await test("exec", "job 后台", async () => {
  const r = await call("bash", { description: "后台 sleep", command: "sleep 3; echo done-bg", run_in_background: true });
  const jid = (P(r) || {}).job_id || r.job_id;
  if (!jid) return { ok: false, detail: U(r) };
  await sleep(4500);
  const out = await call("job_output", { job_id: jid });
  const lst = await call("job_list", {});
  return { ok: out.ok && /done-bg/.test(U(out)), detail: U(out).slice(0, 120) + " | list-has-job:" + new RegExp(jid).test(U(lst)) };
});
await test("exec", "java（jar）", async () => {
  const py = `import struct, zipfile
def utf8(s):
    b = s.encode(); return b'\\x01' + struct.pack('>H', len(b)) + b
def cls(i): return b'\\x07' + struct.pack('>H', i)
cp=[utf8('T'),cls(1),utf8('java/lang/Object'),cls(3),utf8('main'),utf8('([Ljava/lang/String;)V'),utf8('Code')]
b=b'\\xca\\xfe\\xba\\xbe'+struct.pack('>HH',0,52)+struct.pack('>H',len(cp)+1)+b''.join(cp)
b+=struct.pack('>HHH',0x0021,2,4)+struct.pack('>H',0)+struct.pack('>H',0)
b+=struct.pack('>H',1)+struct.pack('>HHH',0x0009,5,6)
code=b'\\xb1'
b+=struct.pack('>H',1)+struct.pack('>H',7)+struct.pack('>I',2+2+4+len(code)+2+2)+struct.pack('>HH',0,1)+struct.pack('>I',len(code))+code+struct.pack('>HH',0,0)+struct.pack('>H',0)
open('${T}/T.class','wb').write(b)
with zipfile.ZipFile('${T}/probe.jar','w') as z:
    z.writestr('META-INF/MANIFEST.MF','Manifest-Version: 1.0\\r\\nMain-Class: T\\r\\n\\r\\n')
    z.writestr('T.class',b)
print('ok')`;
  await call("python", { description: "造 jar", code: py });
  const r = await call("java", { description: "跑 jar", file: file("probe.jar") });
  return { ok: r.ok && /exit=0/.test(J(r)), detail: J(r) };
});
await test("exec", "pkg（apk 存在）", async () => {
  const r = await call("pkg", { description: "apk 版本", manager: "apk", args: ["--version"] });
  return { ok: r.ok && /apk-tools/.test(J(r)), detail: J(r) };
});
await test("exec", "rustc 未装 → NEED_RUNTIME", async () => {
  await call("write", { file_path: file("x.rs"), content: "fn main(){}" });
  const r = await call("rustc", { description: "rustc 探针", file: file("x.rs"), out: file("x") });
  const s = J(r);
  return { ok: /NEED_RUNTIME:rustc/.test(s) && !/proot error/.test(s), detail: s.slice(0, 140) };
});

/* ---------------- C. 文档产出 ---------------- */
await test("doc", "write_docx", async () => {
  const r = await call("write_docx", { file_path: file("t.docx"), content: "# 标题\n\n这是正文段落。\n\n- 项一\n- 项二\n" });
  return { ok: r.ok, detail: J(r) };
});
await test("doc", "read_doc（docx 回读）", async () => {
  const r = await call("read_doc", { file_path: file("t.docx") });
  return { ok: r.ok && /标题|正文/.test(J(r)), detail: J(r).slice(0, 140) };
});
await test("doc", "write_xlsx", async () => {
  const r = await call("write_xlsx", { file_path: file("t.xlsx"), sheets: [{ name: "S1", rows: [["a", "b"], [1, 2]] }] });
  return { ok: r.ok, detail: J(r) };
});
await test("doc", "write_pptx", async () => {
  const r = await call("write_pptx", { file_path: file("t.pptx"), slides: [{ title: "第一页", bullets: ["要点一", "要点二"] }] });
  return { ok: r.ok, detail: J(r) };
});
await test("doc", "write_pdf", async () => {
  const r = await call("write_pdf", { file_path: file("t.pdf"), content: "# 标题\n\n正文内容。\n" });
  return { ok: r.ok, detail: J(r) };
});
await test("doc", "write_zip", async () => {
  const r = await call("write_zip", { file_path: file("t.zip"), paths: [file("a.txt")] });
  return { ok: r.ok, detail: J(r) };
});

/* ---------------- D. 图表 / SVG ---------------- */
await test("gen", "chart_generate", async () => {
  const r = await call("chart_generate", { type: "bar", title: "冒烟", categories: ["A", "B", "C"], series: [{ name: "s", data: [1, 2, 3] }] });
  return { ok: r.ok, detail: U(r).slice(0, 120) };
});
await test("gen", "qr_generate", async () => {
  const r = await call("qr_generate", { text: "https://example.com" });
  return { ok: r.ok, detail: J(r) };
});
await test("gen", "mindmap_generate", async () => {
  const r = await call("mindmap_generate", { tree: { label: "根", children: [{ label: "A" }, { label: "B" }] } });
  return { ok: r.ok, detail: J(r) };
});
await test("gen", "flowchart_generate", async () => {
  const r = await call("flowchart_generate", { nodes: [{ id: "a", label: "开始" }, { id: "b", label: "结束" }], edges: [{ from: "a", to: "b" }] });
  return { ok: r.ok, detail: J(r) };
});

/* ---------------- E. 终端 ---------------- */
await test("term", "open/send/read/close", async () => {
  const o = await call("terminal_open", {});
  const sid = (P(o) || {}).sessionId || o.sessionId;
  if (!sid) return { ok: false, detail: U(o) };
  await call("terminal_send", { sessionId: sid, text: "export FOO=bar; echo term-$FOO" });
  await sleep(1200);
  const rd = await call("terminal_read", { sessionId: sid });
  const ls = await call("terminal_list", {});
  await call("terminal_close", { sessionId: sid });
  const txt = U(rd) + U(ls);
  return { ok: /term-bar/.test(txt), detail: txt.slice(0, 140) };
});

/* ---------------- F. 记忆 / 会话 / 待办 ---------------- */
await test("mem", "memory_save+list", async () => {
  const s = await call("memory_save", { text: "冒烟测试记忆：项目代号 sw-" + Date.now() });
  const l = await call("memory_list", {});
  return { ok: s.ok && l.ok, detail: J(l).slice(0, 120) };
});
await test("mem", "memory_search", async () => {
  const r = await call("memory_search", { query: "冒烟测试记忆" });
  return { ok: r.ok, detail: J(r).slice(0, 120) };
});
// 这两个工具要求「有进行中的会话」，工具直调没有轮次上下文 → 由 UI 端到端覆盖
await test("sess", "session_trace（需活跃会话）", async () => {
  const r = await call("session_trace", {});
  if (!r.ok && /没有事件|没有进行中的会话/.test(U(r))) return { skip: "无活跃会话（UI 端到端覆盖）" };
  return { ok: r.ok, detail: U(r).slice(0, 120) };
});
await test("sess", "todo_write（需活跃会话）", async () => {
  const r = await call("todo_write", { todos: [{ content: "冒烟一", status: "completed" }] });
  if (!r.ok && /没有进行中的会话/.test(U(r))) return { skip: "无活跃会话（UI 端到端覆盖）" };
  return { ok: r.ok, detail: U(r).slice(0, 120) };
});

/* ---------------- G. 团队 / 内核自省 ---------------- */
await test("team", "team_status", async () => {
  const r = await call("team_status", {});
  return { ok: r.ok, detail: J(r).slice(0, 120) };
});
await test("team", "list_agents", async () => {
  const r = await call("list_agents", {});
  return { ok: r.ok, detail: J(r).slice(0, 120) };
});
await test("core", "cordis_inspect_list", async () => {
  const r = await call("cordis_inspect_list", {});
  return { ok: r.ok, detail: J(r).slice(0, 120) };
});
await test("core", "plugin_list", async () => {
  const r = await call("plugin_list", {});
  return { ok: r.ok, detail: J(r).slice(0, 120) };
});

/* ---------------- H. 手机能力（部分需要权限） ---------------- */
await test("phone", "device_info", async () => {
  const r = await call("device_info", {});
  return { ok: r.ok, detail: J(r).slice(0, 120) };
});
await test("phone", "phone_foreground", async () => {
  const r = await call("phone_foreground", {});
  return { ok: r.ok, detail: J(r).slice(0, 120) };
});
await test("phone", "screen_read", async () => {
  const r = await call("screen_read", {});
  if (!r.ok && /无障碍|accessibility|未开启/i.test(J(r))) return { skip: "无障碍服务未开（环境限制）" };
  return { ok: r.ok, detail: J(r).slice(0, 120) };
});
await test("phone", "notify", async () => {
  const r = await call("notify", { title: "冒烟", text: "通知测试" });
  if (!r.ok && /权限|permission|POST_NOTIFICATIONS/i.test(J(r))) return { skip: "通知权限未授予" };
  return { ok: r.ok, detail: J(r).slice(0, 120) };
});

/* ---------------- 汇总 ---------------- */
const sum = results.reduce((m, r) => (m[r.status] = (m[r.status] || 0) + 1, m), {});
console.log("\n=== 汇总 ===", JSON.stringify(sum));
const fails = results.filter((r) => r.status === "FAIL");
if (fails.length) {
  console.log("失败项：");
  for (const f of fails) console.log(` - [${f.group}] ${f.name}: ${f.detail}`);
}
process.exit(0);
