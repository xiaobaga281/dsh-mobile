// 回归：无障碍读屏不能再退化成「elements: [] + 坐标截图」。
//
// 用户真机实测：screen_read 返回空数组，只能靠截图 + 坐标蒙，慢且错。
// 根因是三处叠加（都已修，别改回去）：
//  1. contentRoots() 在 rootInActiveWindow == null 时直接 return —— 活跃根拿不到时
//     连 windows 都不读；且只合「与活跃根同包」的窗口，输入法置顶时应用窗口全丢；
//  2. walk() 把 isVisibleToUser 当**准入条件** —— WebView/Compose/部分 ROM 整树 false，
//     节点全被丢弃；它只该是输出字段；
//  3. elementSnaps 早就备好了「element 下标 → snap 下标」映射却没人用，
//     Snap 存的是全量节点，index 定位会点到别的控件。
//
// 另外两条性能改造：同屏重复读走 epoch 缓存；批量动作 + 节点 diff 替代逐步往返 / 重截图。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const svc = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/device/PhoneControlService.kt");
const outline = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/device/ScreenOutline.kt");
const plugin = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/plugin/builtin/device/ComputerUsePlugin.kt");
const catalog = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/plugin/ToolCatalog.kt");

function check(name, cond, hint) {
  if (!cond) throw new Error(`FAIL: ${name} —— ${hint}`);
}

/** 去掉行注释/块注释再断言：说明文字里可能出现「以前这里 ?: return out」这类引述 */
const code = (s) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

// 1) 根集合：活跃根为空不能早退；不能按「同包」一刀切；要排除输入法窗口
{
  const start = svc.indexOf("private fun contentRoots(");
  const body = code(svc.slice(start, svc.indexOf("private fun windowsSnapshot(", start)));
  check("活跃根为空不再 return", !/\?:\s*return\s+out/.test(body),
    "rootInActiveWindow 为 null 时又空手而归，windows 一次都不读 —— elements 必然空");
  check("遍历 windows 时不按「与活跃根同包」过滤", !/pkg\s*!=\s*activePkg/.test(body),
    "输入法/系统弹窗置顶时，真正的应用窗口会被整批丢掉");
  check("排除自身悬浮窗与输入法窗口", /pkg\s*==\s*self/.test(body) && /in\s+ime\b/.test(body),
    "自己的灵动岛或输入法整棵树混进来，节点树会被无关内容淹没");
  check("有 IME 包名识别", /fun imePackages\(/.test(svc),
    "没法区分「应用窗口」与「输入法窗口」，两者必有一个被牺牲");
  check("多窗口有上限", /out\.size < 4|take\(4\)/.test(body),
    "收全部窗口会把整台设备的节点树搬进 JSON");
}

// 2) walk：可见性只作字段，不作准入门槛
{
  const start = svc.indexOf("fun walk(node: AccessibilityNodeInfo, depth: Int)");
  const body = code(svc.slice(start, svc.indexOf("var roots = contentRoots()", start)));
  check("可见性不再作为 if 准入", !/if\s*\(onScreen\)\s*\{[\s\S]{0,80}snaps\.add/.test(body),
    "isVisibleToUser 为 false 时又把节点整条丢弃 —— WebView/Compose 场景 elements 恢复全空");
  check("可见性作为字段写进快照", /visible\s*=\s*onScreen/.test(body),
    "节点收进来了却分不清在不在屏上，模型会点屏外元素");
  check("保留 res_id 全名", /resId\s*=\s*fullId/.test(body),
    "resource-id 只剩末段，跨应用同名 id 无法区分，定位仍要蒙");
  check("透传 contentDescription / 包名 / 层级",
    /cd\s*=\s*cd\.take\(200\)/.test(body) && /pkg\s*=\s*pkg/.test(body) && /depth\s*=\s*depth/.test(body),
    "模型拿不到可读描述与来源，多窗口下分不清节点属于哪个应用");
}

// 3) 纯函数层：nodes 输出 + res_id + diff
check("ScreenOutline 输出结构化 nodes",
  /val nodes: JSONArray/.test(outline) && /put\("nodes", outline\.nodes\)/.test(svc),
  "screen_read 没有 nodes 字段，非交互控件（微信输入框这类）就拿不到 id");
check("elements / nodes 都带 res_id", /put\("res_id", s\.resId\)/.test(outline),
  "resource-id 没透传，用户点名要的精准定位又回到坐标蒙");
check("diff 是纯函数（JVM 可测）", /fun diff\(before: Map<String, String>, after: Map<String, String>\)/.test(outline),
  "diff 埋在 service 里，只能真机验证，改错了没人知道");
check("diff 报告增删改 + same", /"added_n"/.test(outline) && /"same"/.test(outline),
  "只说「变了」不给变化内容，模型还是得重截图");

// 4) 缓存：同屏重复读不再全量重走
check("readScreen 有 epoch 缓存命中", /treeCache\?\.takeIf \{ it\.epoch == epochNow/.test(svc),
  "同一屏连读每次都全量 walk，0.5~1s 白花");
check("缓存命中刷新 snapshot token", /put\("snapshot", s\.first\)\.put\("cached", true\)/.test(svc),
  "直接返回旧 token，LRU 挤掉后 index 定位失效");
check("缓存键含 maxElements", /it\.maxElements == maxElements/.test(svc),
  "换了 max_elements 还返回旧密度，模型以为元素变少了");

// 5) index 定位与 elements 对齐（错位 bug）
check("Snap 存的是与 elements 同序的节点",
  /val elementNodes = outline\.elementSnaps\.mapNotNull/.test(svc)
    && /Snap\(elementNodes, uiTracker\.epoch\(\), prints\)/.test(svc),
  "index=0 可能点到列表里第 0 个真实节点（标题），而不是第 0 个可交互元素");
check("elementSnaps 真正被生产代码使用", /outline\.elementSnaps/.test(svc),
  "映射又变成只有测试在用，错误定位逻辑回归");

// 6) 批量动作 + 回执 diff
check("phone_batch 工具存在", /"phone_batch"/.test(plugin),
  "多步操作又得一步一步往返");
check("phone_batch 登记为写操作", /put\("phone_batch", rw\(/.test(catalog),
  "只读档会把批量动作当只读放行，或反过来被拒");
check("批量末尾给整批 diff", /put\("diff", diffFingerprints\(before, after\)\)/.test(svc),
  "批量做完只说成功/失败，模型不知道净效果");
check("批量有步数上限与失败即停",
  /steps\.length\(\) > 8/.test(svc) && /stopOnError/.test(svc),
  "无上限的批量一旦中途跑偏，排查成本远高于省下的往返");
check("点击回执带 diff（动作前取指纹）",
  /beforePrints: Map<String, String>\? = null/.test(svc) && /beforePrints = bp/.test(svc),
  "点完只有 ui_changed:true，模型不知道变成了什么，还得再读一次");
check("diff 只在确实变化时计算", /if \(v\.changed && beforePrints != null\)/.test(svc),
  "没变化也跑一次全树遍历，白加 50ms");

// 7) screen_read 支持 since
check("screen_read 暴露 since 参数并透传",
  /put\("since"/.test(plugin) && /args\.optString\("since"\)/.test(plugin),
  "模型无法主动要 diff，只能盲操作");

console.log("✔ device-tree: 根集合补齐 / 可见性降级为字段 / res_id+cd+pkg / nodes / 缓存 / index 对齐 / 批量+diff 都在");
