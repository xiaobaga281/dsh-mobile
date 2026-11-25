// 回归：预览与链接的四条安全边界（2026-10-31 全项目审查，rc.174）。
//   ① DocPreview 生成 HTML 里的文件内数据必须转义（xlsx 表名曾经裸拼进 innerHTML）；
//   ② HTML 预览 iframe 必须主动抹掉 addJavascriptInterface 注入的 DSHNative*
//      （sandbox 只隔离同源，不隔离原生注入对象 —— 预览脚本能直接拿到内核工具）；
//   ③ 宿主导航必须按 origin 精确比对（startsWith 前缀比对会被
//      http://host:3080@evil.com/ 这类 userinfo 伪装绕过）；
//   ④ markdown 链接只放行 http(s)/mailto/页内锚点（javascript: 不触发
//      shouldOverrideUrlLoading，会在应用 origin 里直接执行）。
// 断言全部抽真实源码，不复刻业务逻辑。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const js = readFileSync(join(root, "app/src/main/assets/web/app.js"), "utf8");
const activity = readFileSync(
  join(root, "app/src/main/java/ai/deepseek/harness/mobile/MainActivity.kt"), "utf8");
const docPreview = readFileSync(
  join(root, "app/src/main/java/ai/deepseek/harness/mobile/kernel/preview/DocPreview.kt"), "utf8");
const sanitizer = readFileSync(
  join(root, "app/src/main/java/ai/deepseek/harness/mobile/kernel/preview/HtmlSanitizer.kt"), "utf8");

// ---- ① 生成类预览：兜底净化 + xlsx 表名转义 ----
if (!docPreview.includes("private fun gen(html: String): String = HtmlSanitizer.sanitizeGenerated(html)")) {
  throw new Error("FAIL: DocPreview 没有把生成类 HTML 过 sanitizeGenerated —— 渲染器漏转义会直接进 innerHTML");
}
for (const call of ["gen(renderDocx(f))", "gen(renderPptx(f))", "gen(renderXlsx(f))", "gen(renderPdf(f))", "gen(renderZip(f))"]) {
  if (!docPreview.includes(call)) throw new Error(`FAIL: ${call} 没走兜底净化`);
}
if (!docPreview.includes("esc(sheetNames.firstOrNull()?.first ?: \"Sheet1\")")) {
  throw new Error("FAIL: xlsx 表名没有 esc() —— 恶意工作簿可在应用 origin 执行脚本");
}
if (!sanitizer.includes("fun sanitizeGenerated")) {
  throw new Error("FAIL: HtmlSanitizer 缺少 sanitizeGenerated（生成类预览的第二道闸）");
}

// ---- ② HTML 预览 frame：先抹桥，再渲染 ----
if (!js.includes("PV_BRIDGE_SHIM")) {
  throw new Error("FAIL: 预览 iframe 没有桥隔离 shim —— sandbox 挡不住 DSHNative* 注入");
}
for (const need of [
  "/^DSHNative/.test(names[i])",
  "'DshPtc' in window",
  "Object.getOwnPropertyNames(window)",
  "connect-src 'none'",
]) {
  if (!js.includes(need)) throw new Error(`FAIL: 桥隔离 shim 缺少 ${need}，预览脚本仍能拿到原生接口/对外发请求`);
}
const mount = js.slice(js.indexOf("function mountHtmlPreview()"));
const mountBody = mount.slice(0, mount.indexOf("\n  }"));
if (!mountBody.includes("PV_BRIDGE_SHIM +")) {
  throw new Error("FAIL: mountHtmlPreview 没把 shim 拼进 srcdoc（要同时覆盖有/无 doctype 两条路径）");
}

// ---- ③ 宿主导航：origin 精确比对 ----
if (activity.includes("startsWith(host)")) {
  throw new Error("FAIL: shouldOverrideUrlLoading 又用前缀比对 —— http://host:3080@evil.com/ 会留在 WebView 里");
}
if (!activity.includes("KernelBridgeOrigin.sameOrigin(host, target)")) {
  throw new Error("FAIL: 宿主导航没有走 sameOrigin 精确比对");
}
if (!activity.includes("isLocalOrigin(currentPageUrl)")) {
  throw new Error("FAIL: isLocalPage 只看全局标志，没校验最近提交的文档 URL");
}

// ---- ④ markdown 链接协议白名单 ----
if (!js.includes("/^(?:https?:\\/\\/|mailto:|#)/i.test(href)")) {
  throw new Error("FAIL: md() 链接没有协议白名单 —— javascript: 链接会在应用 origin 执行");
}
if (/\.replace\(\/\\\[\(\[\^\\\]\]\+\)\\\]\\\(\(\[\^\)\\s\]\+\)\\\)\/g, '<a href="\$2"/.test(js)) {
  throw new Error("FAIL: 旧的不限协议链接替换又回来了");
}

console.log("✔ preview-bridge: 预览注入 / 桥隔离 / 宿主导航 / 链接协议 四条边界都在");
