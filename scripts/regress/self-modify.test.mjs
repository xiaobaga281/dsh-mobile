// 回归：前端自改（self-modification）链路不能断，也不能把 App 变成「改一次就白屏」。
//
// 用户要的是 harness 改自己的源码并生效，不是下载官方 APK 的 OTA。
// 桌面能做到是因为源码 + 构建链都在磁盘上；预编译 APK 只有拼接产物 app.js。
// 方案：assets/devsrc 随包带源码 → 展开到 workspace/.dsh-src/parts/（可写）
// → self_modify(rebuild) 按 build.json 重建 app.js → WebView 优先加载 workspace 副本。
//
// 安全边界是硬要求：默认关闭、白名单、产物体检回落、恢复内置版本。
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const raw = (p) => readFileSync(join(root, p));
const main = read("app/src/main/java/ai/deepseek/harness/mobile/MainActivity.kt");
const sm = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/dev/SelfModify.kt");
const plugin = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/plugin/builtin/dev/SelfModifyPlugin.kt");
const bridge = read("app/src/main/java/ai/deepseek/harness/mobile/bridge/DeviceBridge.kt");
const ui = read("web/src/20-ui.js");
const boot = read("web/src/30-bridge.js");
const html = read("app/src/main/assets/web/index.html");
const services = read("app/src/main/resources/META-INF/services/ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin");
const buildJson = JSON.parse(read("web/build.json"));

function check(name, cond, hint) {
  if (!cond) throw new Error(`FAIL: ${name} —— ${hint}`);
}

// 1) 随包源码必须与 web/src 逐字节一致（否则设备拿到的是旧源码，改了也不生效）
check("sync-devsrc 脚本入库", existsSync(join(root, "scripts/sync-devsrc.mjs")),
  "没有可复现的同步脚本，随包源码会悄悄落后");
for (const name of [...buildJson.parts, "build.json"]) {
  const src = name === "build.json" ? raw("web/build.json") : raw(`web/src/${name}`);
  const dst = raw(`app/src/main/assets/devsrc/${name}`);
  check(`assets/devsrc/${name} 与源一致`, src.equals(dst),
    "跑 node scripts/sync-devsrc.mjs —— 设备上的源码和桌面分叉了");
}
check("devsrc 目录没有多余文件",
  readdirSync(join(root, "app/src/main/assets/devsrc")).length === buildJson.parts.length + 1,
  "混进了非源码文件，会被一并展开到 workspace");

// 2) 默认关闭 + 白名单 + 体检回落（改坏了不能白屏变砖）
check("默认关闭，必须显式 enable", /fun isEnabled\(ctx: Context\): Boolean = flag\(ctx\)\.isFile/.test(sm),
  "默认开启等于把全部原生桥交给 workspace 里一个可写文件");
check("覆盖白名单只有 app.js / styles.css",
  /OVERLAY_ALLOW = setOf\("app\.js", "styles\.css"\)/.test(sm),
  "index.html / 桥文件也被允许覆盖，攻击面失控");
check("overlay 对 JS 做体检且失败回落内置",
  /looksValidAppJs\(f\)/.test(sm) && /回落内置版本/.test(sm),
  "写了一半的 app.js 会让 WebView 白屏，用户再也进不去设置页关开关");
check("rebuild 原子写", /tmp\.renameTo\(out\)/.test(sm),
  "直接写 app.js 会在写入中途被 WebView 读到半个文件");
check("拼接规则与 build-web.mjs 一致（LF / 末尾换行 / IIFE / banner）",
  /replace\("\\r\\n", "\\n"\)/.test(sm) && /末尾缺少换行/.test(sm)
    && /IIFE 结尾/.test(sm) && /parts sha256 \$hash/.test(sm)
    && /AUTO-GENERATED — DO NOT EDIT/.test(sm),
  "设备端与桌面两套拼接规则分叉，重建产物不可信");
check("restore 能清覆盖并关开关", /fun restore\(/.test(sm) && /flag\(ctx\)\.delete\(\)/.test(sm),
  "改坏之后没有恢复入口");

// 3) WebView 覆盖加载 + 生命周期
{
  const start = main.indexOf("override fun shouldInterceptRequest(");
  const body = main.slice(start, start + 1600);
  check("shouldInterceptRequest 有 overlay 分支", /SelfModify\.overlay\(/.test(body),
    "重建出来的 app.js 没人加载，自改等于没生效");
  check("只接受单层相对路径（防路径穿越）", /!rel\.contains\("\/"\)/.test(body),
    "任意 assets 路径都可能被 workspace 文件顶掉");
  check("覆盖响应 no-store", /"Cache-Control" to "no-store"/.test(body),
    "reload 后可能仍拿到缓存的旧 app.js");
  check("reloadHook 在 onDestroy 清空", /SelfModify\.reloadHook = null/.test(main),
    "lambda 持有 webView → Activity 泄漏");
}

// 4) 两个入口共用同一对象：Agent 工具 + 设置面板桥
check("self_modify 工具已注册进服务清单", /builtin\.dev\.SelfModifyPlugin/.test(services),
  "Agent 拿不到重建/重载能力，只能靠用户手点");
check("工具声明了 action 枚举", /rebuild/.test(plugin) && /restore/.test(plugin) && /Schemas\.prop/.test(plugin),
  "模型不知道有哪些合法动作，会瞎调");
check("桥与工具都调 SelfModify 而不是各写一套", /SelfModify/.test(bridge) && /SelfModify/.test(plugin),
  "面板和工具状态分叉：工具里 enable、面板里显示关闭");
check("工具描述点明源码路径与风险", /workspace\/\.dsh-src\/parts/.test(plugin) && /全部原生桥/.test(plugin),
  "Agent 不知道该改哪个文件，也不知道覆盖 JS 的权限有多大");

// 5) 前端入口
check("设置页有前端自改行", /id="rowSelfModify"/.test(html),
  "用户没有开关/恢复的物理入口");
check("行点击打开面板且显示状态", /rowSelfModify/.test(boot) && /sheetSelfModify\(\)/.test(boot),
  "入口点了没反应");
check("面板有 enable/rebuild/reload/restore",
  /function sheetSelfModify\(\)/.test(ui)
    && ['enable', 'rebuild', 'reload', 'restore'].every((a) => ui.includes(`data-sm="${a}"`)),
  "改动链路缺步骤，或改坏后无法恢复");
check("data-sm 只在 sheet 委托里认领一次",
  (ui.match(/closest\("\[data-sm\]"\)/g) || []).length === 1,
  "同一节点被两个监听器认领会跑两遍（rc.138/202 同源）");

console.log("✔ self-modify: 源码同步 / 默认关闭 / 体检回落 / 覆盖加载 / 双入口 / 恢复 都在");
