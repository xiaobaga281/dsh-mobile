// 回归：proot guest 的「基础环境三件套」不能只挂在某一个工具分支上。
//
// 用户实测报告（2026-11-08）里三条归因被证伪、两条属实：
//   · PROOT_LOADER 自 M1 起就在 prootHostEnv() 里显式给，没接好是误报；
//   · rootfs 里没有 /dev 节点是**有意设计**（数据目录 mknod 必被拒），
//     运行时靠 prootArgs() 的 `-b /dev` 绑定宿主 devtmpfs，"git 因 /dev 空而崩" 归因错误；
//   · 真缺陷是 /etc/resolv.conf：写注入函数只被 `pkg manager=apk` 调用，
//     且排在 guestExec 解包之前（冷启动首次 .dsh-ready 还不存在，直接跳过），
//     于是 pip / npm / node fetch / 终端里的联网全是 EAI_AGAIN。
//   · npm 确实没装（node 是单二进制），而缺失提示又让用户「用 pkg 联网装 npm」——
//     pkg manager=npm 指向的正是那个不存在的入口，自举死循环。
//
// 这条守卫抽真实源码断言「唯一入口」不被绕过，不许 skip。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const rt = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/KernelRuntime.kt");
const plugin = read("app/src/main/java/ai/deepseek/harness/mobile/kernel/plugin/builtin/fs/RuntimePlugin.kt");

function check(name, cond, hint) {
  if (!cond) throw new Error(`FAIL: ${name} —— ${hint}`);
}

// 1) DNS 注入必须在 rootfs 就绪之后、所有 guest 路径共用的 prepareProotRootfs 里
{
  const start = rt.indexOf("fun prepareProotRootfs(");
  const end = rt.indexOf("fun exec(", start);
  check("能定位 prepareProotRootfs 的唯一实现", start > 0 && end > start,
    "唯一入口被改名/移动，DNS 注入的挂载点需要重新确认");
  const body = rt.slice(start, end);
  check("guest DNS 写在 rootfs 就绪之后（.dsh-ready 已生成）",
    /writeGuestResolv\(ready\)/.test(body) && body.indexOf("writeGuestResolv(ready)") < body.indexOf("return ready"),
    "注入又被挪到解包之前或删掉了 —— 冷启动首次 pkg/终端/node fetch 会重新变成 EAI_AGAIN");
  check("注入不依赖 .dsh-ready 之外的窄条件",
    !/if \(manager ==/.test(body),
    "prepareProotRootfs 不该出现工具分支判断 —— 那是当年只覆盖 apk 的写法");
}

// 2) 工具层不许再按 manager 分支补一次（会掩盖顺序问题，也容易漏 pip/npm）
check("RuntimePlugin 不再单独调 ensureGuestResolv",
  !/rt\.ensureGuestResolv\(/.test(plugin),
  "DNS 又被收窄到 pkg 的某条分支 —— 终端 / node fetch / pip 会重新拿不到 resolv.conf");

// 3) 注入失败必须有出口，不能静默（项目里已经栽过两次 runCatching 吞异常）
check("resolv.conf 写入失败有日志出口",
  /writeGuestResolv[\s\S]{0,600}onFailure\s*\{[\s\S]{0,200}android\.util\.Log\.w/.test(rt),
  "写失败被吞掉 —— 用户只会看到「网络全废」且没有任何诊断线索");

// 4) 纯函数不能写出「只有换行」的假配置（会被 length()>0 判成已配置、永不补齐）
check("空 DNS 列表生成空串而不是换行",
  /resolvConfText[\s\S]{0,400}usable\.isEmpty\(\)\) ""/.test(rt),
  "空配置会写出只有换行的 resolv.conf，之后每次补齐都被跳过，联网永久失效");

// 5) 两个 loader 变量都要显式给（二进制里是 PROOT_LOADER / PROOT_LOADER_32）
{
  const start = rt.indexOf("private fun prootHostEnv(");
  const body = rt.slice(start, rt.indexOf("private fun spawn(", start));
  check("PROOT_LOADER 显式给且来自 ProotEnv（真实 .so 路径，见 proot-loader 守卫）",
    /"PROOT_LOADER" to loader\.absolutePath/.test(body) && /val loader = env\.loader/.test(body),
    "proot 会回退到 Termux 硬编码路径并报 'the loader was not found'");
  check("PROOT_LOADER_32 也显式给",
    body.includes('"PROOT_LOADER_32"'),
    "32 位 guest / 未来扩 ABI 时会重演默认路径找不到 loader");
  check("prootEnv 缺失时给可读错误而不是空串",
    /throw KernelError\(needRuntime\("proot"\)\)/.test(body),
    "空 PROOT_LOADER 会让报错退化成 proot 的英文 'loader was not found'");
}

// 6) /dev 绑定不能按「rootfs 里 dev 是空的」这个误报删掉
{
  const start = rt.indexOf("private fun prootArgs(");
  const body = rt.slice(start, rt.indexOf("private fun prootHostEnv(", start));
  check("prootArgs 仍绑定宿主 /dev 与 /proc",
    body.includes('"-b", "/dev"') && body.includes('"-b", "/proc"'),
    "删掉 -b /dev 之后 guest 里 null/zero/urandom 真的会全空 —— 那才会让 git 等程序启动失败");
}

// 7) 缺失提示不许把用户指回缺失的入口
{
  const start = rt.indexOf("fun needRuntime(");
  const body = rt.slice(start, rt.indexOf("fun exec(", start));
  check("缺失提示不再说「pip/npm 生态同理」",
    !body.includes("pip/npm 生态同理"),
    "npm 缺失时又会把用户指回 pkg manager=npm（该入口正是缺失的那个），自举死循环复发");
  check("npm 有专属提示：由增量补丁内置、不需要联网安装",
    /missingInGuest && name == "npm"/.test(body) && /libdshnpm\.so/.test(body) && /不需要联网安装/.test(body),
    "npm 已由 libdshnpm.so 内置，还在提示「去联网装」会把模型引向不存在的路径");
  check("其它缺失仍指向 apk 并给出 DNS/代理前提",
    /manager=apk/.test(body) && /EAI_AGAIN/.test(body),
    "没说清唯一可行路径与 DNS/代理前提，模型会反复重试无效命令");
}

console.log("✔ guest-base-env: DNS 注入在唯一入口 / loader 双变量 / -b /dev 绑定 / npm 由补丁内置 都在");
