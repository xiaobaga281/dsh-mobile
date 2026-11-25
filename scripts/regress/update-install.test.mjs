// 回归：预编译 APK 的自升级闭环不能被「下载完装不上」卡死。
//
// 用户实测：手机端点更新能检查、能下载，但装不上，不像电脑端能自己升级。
// 断点不在检查/下载/安装 Intent（那三段 rc.146~148 就写全了），而在
// **Android 8+ 的「安装未知应用」是逐应用授权**：侧载时用户给浏览器/文件管理器
// 开过开关，不等于给 DSH Mobile 开过。清单里的 REQUEST_INSTALL_PACKAGES 只是
// 第一步，缺 canRequestPackageInstalls() 检查时 ACTION_VIEW 被系统静默拦掉；
// 更糟的是旧代码 startActivity 之后立刻清掉了「下载完成·点此安装」通知，
// 连兜底入口都没了。AppInstallPlugin 里早有同一判断，自升级漏了。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const center = read("app/src/main/java/ai/deepseek/harness/mobile/update/UpdateCenter.kt");
const service = read("app/src/main/java/ai/deepseek/harness/mobile/update/UpdateService.kt");
const bridge = read("app/src/main/java/ai/deepseek/harness/mobile/bridge/UpdateBridge.kt");
const ui = read("web/src/20-ui.js");
const manifest = read("app/src/main/AndroidManifest.xml");
const paths = read("app/src/main/res/xml/file_paths.xml");

function check(name, cond, hint) {
  if (!cond) throw new Error(`FAIL: ${name} —— ${hint}`);
}

// 1) 安装门禁 + 引导（断点所在）
{
  check("UpdateCenter 检查 canRequestPackageInstalls",
    /canRequestPackageInstalls\(\)/.test(center),
    "没查逐应用授权 —— ACTION_VIEW 会被系统静默拦掉，用户看到「点安装没反应」");
  check("UpdateCenter 有 ACTION_MANAGE_UNKNOWN_APP_SOURCES 引导",
    /ACTION_MANAGE_UNKNOWN_APP_SOURCES/.test(center) && UriPackage(center),
    "没引导用户去设置页，他不知道该开哪个开关");
  check("install() 门禁失败返回 false 而不是硬跳安装器",
    /fun install\(file: File\): Boolean/.test(center) && /if \(!canInstall\(\)\) \{[\s\S]{0,160}return false/.test(center),
    "门禁只是摆设，仍会 startActivity 被系统拦下");
}
function UriPackage(s) {
  return /Uri\.parse\("package:\$\{context\.packageName\}"\)/.test(s);
}

// 2) 通知兜底也过同一道门禁
{
  const body = service.slice(service.indexOf("private fun notifyDone("));
  check("notifyDone 检查安装权限",
    /canRequestPackageInstalls\(\)/.test(body) && /ACTION_MANAGE_UNKNOWN_APP_SOURCES/.test(body),
    "后台点通知照样白跳一次安装器，且通知被 setAutoCancel 吃掉");
  check("通知文案区分「下载完成」与「还差一步授权」",
    /还差一步授权/.test(body) && /需要先允许|允许本应用安装应用/.test(body),
    "用户点通知仍不知道该做什么");
}

// 3) 门禁失败不清通知，并给前端一个可回到的状态
{
  const start = bridge.indexOf("fun updateInstall()");
  const body = bridge.slice(start, bridge.indexOf("fun updatePermission()", start));
  check("updateInstall 识别权限缺失并 push permission 状态",
    /state\("permission"\)/.test(body) && /needPermission/.test(body),
    "权限没开时静默失败，面板还停在 ready，用户反复点安装");
  check("权限缺失时不清通知",
    !/clearNotification/.test(body),
    "清掉了「下载完成·点此安装」—— 用户开完权限回来没有任何入口");
  check("安装成功也不抢着清通知",
    !/clearNotification/.test(bridge.slice(start, bridge.indexOf("fun updateCancel()", start))),
    "安装器可能被签名/存储/用户取消拦下，通知是唯一兜底");
}

// 4) 进程重启后仍能找到已下载的包
check("downloadedFile 扫缓存目录而不是依赖内存 lastCheck",
  /dir\.listFiles/.test(bridge) && /maxByOrNull \{ it\.lastModified\(\) \}/.test(bridge),
  "回到 App 时 lastCheck 为 null，包明明在缓存里却报「安装包不在了，请重新下载」");

// 5) 挑包：rc.220 起资产名不带 complete，旧逻辑会挑错通道/ABI
{
  const start = center.indexOf("private fun pickAsset(");
  const body = center.slice(start, center.indexOf("fun download(", start));
  check("按 -standard- 判通道", /contains\("-standard-"\)/.test(body),
    "rc.220 产物名无 complete 字样，旧 contains(\"complete\") 会退化到 firstOrNull 装错通道");
  check("按 SUPPORTED_ABIS 过滤", /Build\.SUPPORTED_ABIS/.test(body),
    "complete 的 rootfs 按 ABI 拆，装错架构直接崩");
  check("没有适配包时不硬挑一个", /pool\.firstOrNull\(\) \?: return null/.test(body),
    "挑了不适配的包，下载几百 MB 后才发现装不上");
  check("check() 对无适配包给出明确错误",
    /没有适配当前版本/.test(center), "检查更新时只说「有新版」，点下载才失败");
}

// 6) 前端有授权状态与「开完继续装」入口
check("前端渲染 permission 状态", /st === "permission"/.test(ui),
  "门禁失败后前端没地方显示原因");
check("前端有去设置按钮并绑定桥", /id="upPermission"/.test(ui) && /Native\.updatePermission\(\)/.test(ui),
  "用户没法从面板跳到系统设置页");
check("permission 态保留继续安装按钮", /已打开，继续安装/.test(ui),
  "开完权限回来还得重新检查/下载一遍");

// 7) 清单与 FileProvider 基建
check("清单声明 REQUEST_INSTALL_PACKAGES", /REQUEST_INSTALL_PACKAGES/.test(manifest),
  "Android 8+ 连申请资格都没有");
check("FileProvider 与 updates cache-path 都在",
  /FileProvider/.test(manifest) && /cache-path name="updates"/.test(paths),
  "Android 7+ 用 file:// 会抛 FileUriExposedException");

console.log("✔ update-install: 安装门禁 / 设置引导 / 通知兜底 / 缓存复用 / 精确挑包 / 授权面板 都在");
