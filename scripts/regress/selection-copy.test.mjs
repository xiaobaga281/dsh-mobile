// 回归：用户圈选了部分文字，复制就必须只给那部分，不能给整条消息 / 整块 DOM。
//
// 用户实测（2026-11-08）：「长按选中一段，复制出来竟然是全部」。
// 根因：长按消息弹出的动作面板里「复制文字」无条件 copyText(node.text)（整条消息）；
// 取不到模型节点时的兜底更狠 —— `(bodyEl || el).textContent` 把整块 .msg
// （思考行 / 工具行 / 时间戳）全塞进剪贴板；整条链路上没有一处读 window.getSelection()。
// 而且 480ms 的自定义长按面板会与系统选择手势同时发生，用户看到的「复制」
// 很可能是面板按钮而不是系统菜单。
//
// 规矩：**复制什么由选区说了算**；系统选择手势期间不许弹自定义面板。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const js = readFileSync(join(root, "app/src/main/assets/web/app.js"), "utf8");

function check(name, cond, hint) {
  if (!cond) throw new Error(`FAIL: ${name} —— ${hint}`);
}

// 1) 必须有「只读当前选区」的公共 helper，且限定在消息容器内
{
  const start = js.indexOf("function selectedTextIn(");
  const body = js.slice(start, js.indexOf("function copyText(", start));
  check("存在 selectedTextIn()", start > 0 && body.length < 1200,
    "选区读取被删了 —— 复制入口又会退化成「按钮自己猜内容」");
  check("选区 helper 排除折叠选区与容器内判断",
    /isCollapsed/.test(body) && /root\.contains/.test(body),
    "空选区 / 输入框里的选区会被当成「用户圈了正文」，复制出无关内容");
}

// 2) 长按面板的「复制」必须选区优先
{
  const start = js.indexOf('e.target.closest("[data-msg-copy]")');
  const body = js.slice(start, js.indexOf('e.target.closest("[data-msg-fork]")', start));
  check("能定位长按面板的复制分支", start > 0 && body.length < 900,
    "复制分支被改名或移动，需要重新确认选区优先是否还在");
  check("复制内容是「选区 || 整条」而不是无条件整条",
    /selectedTextIn\(/.test(body) && /copyDecision\(/.test(body) && /copyText\(decision\.text, decision\.label\)/.test(body),
    "又变成无条件 copyText(node.text) —— 用户选中的部分会被丢弃，复制成整条");
  check("两种结果给人看的提示不一样",
    /copyText\(decision\.text, decision\.label\)/.test(body)
      && js.includes('"已复制选中内容"') && js.includes('"已复制整条消息"'),
    "复制了整条却提示「已复制」，用户分不清到底复制了什么");
}

// 3) 复制本轮的图标按钮同样遵守
{
  const start = js.indexOf('e.target.closest("[data-copy-turn]")');
  const body = js.slice(start, start + 700);
  check("复制本轮也选区优先",
    start > 0 && /selectedTextIn\(/.test(body) && /copyDecision\(/.test(body),
    "「复制本轮」会把用户圈中的半句换成整轮");
}

// 4) 系统选择手势期间不能弹自定义动作面板
{
  const start = js.indexOf("bindLongPress(host)");
  const body = js.slice(start, js.indexOf("bindSearch()", start));
  check("长按计时器到点先检查选区",
    /if \(selectedTextIn\(host\)\) return;/.test(body),
    "480ms 面板会在用户圈字时弹出，系统复制菜单被盖住 / 选区被清掉，重新出现「选部分复制全部」");
  check("长按兜底不再取整块 .msg 的 textContent",
    !/\|\| el\)\.textContent/.test(body),
    "取不到模型节点时又把思考行、工具行、时间戳一起复制出去了");
  check("长按阈值晚于系统选词（>=600ms）",
    /\}, 6[0-9]{2}\);/.test(body) || /\}, [7-9][0-9]{2}\);/.test(body),
    "面板又抢在系统选词之前弹出，到点时选区还是空，选区检查形同虚设");
}

// 5) 面板文案要说清复制范围，不能再用含糊的「复制文字」
check("长按面板按钮文案明确是整条",
  js.includes("复制整条消息") && !js.includes(">复制文字</button>"),
  "「复制文字」含糊不清，用户会以为它复制的是自己圈中的那部分");

// 6) copyText 的 execCommand 兜底不能把用户选区清掉
{
  const start = js.indexOf("function copyText(");
  const body = js.slice(start, js.indexOf("function shareSession(", start));
  check("兜底路径保存并恢复选区",
    /cloneRange\(\)/.test(body) && /addRange\(r\)/.test(body),
    "临时 textarea 的 select() 会清掉选区，用户想再选一次时手柄已经没了");
  check("copyText 支持自定义提示", /function copyText\(text, label\)/.test(body),
    "无法区分「选中部分」和「整条消息」的复制结果");
}

// 7) 行为断言：直接跑真实源码里的 @pure 决策块，静态守卫防不住「逻辑写反」
{
  const begin = js.indexOf("/* @pure:begin selection-copy */");
  const end = js.indexOf("/* @pure:end selection-copy */");
  check("存在可执行的 copyDecision 纯函数块", begin > 0 && end > begin,
    "决策块被删/改名，没法在 Node 里验证「选什么复制什么」");
  const { copyDecision } = new Function(
    `${js.slice(begin, end)}\nreturn { copyDecision };`,
  )();

  const whole = "第一段很长很长\n第二段也很长\n第三段结束";

  const picked = copyDecision("第二段也很长", whole);
  check("圈中半句时只复制半句", picked.text === "第二段也很长",
    `复制成了「${picked.text}」—— 用户明确选的不是这个`);
  check("圈中时提示说清是选中内容", picked.label === "已复制选中内容",
    "复制对了但提示含糊，用户仍不知道剪贴板里是什么");

  const longerWhole = copyDecision("第二段也很长", whole.repeat(50));
  check("整条再长也不能盖过选区", longerWhole.text === "第二段也很长",
    "选区被整条覆盖了 —— 正是用户报的「选了部分却复制全部」");

  const none = copyDecision("", whole);
  check("没圈时才复制整条", none.text === whole && none.label === "已复制整条消息",
    "没有选区却没给整条，或提示与行为不一致");

  const blank = copyDecision("   \n  ", whole);
  check("只有空白的选区按「没选」处理", blank.text === whole,
    "空白选区会把剪贴板写成空，用户以为复制成功了");

  const trimmed = copyDecision("  第二段也很长  ", whole);
  check("选区首尾空白被去掉", trimmed.text === "第二段也很长",
    "复制内容带着选区两端多余空白");
}

console.log("✔ selection-copy: 选区优先 / 选择手势不弹面板 / 兜底不吞整块 DOM / 文案明确 / 6 条行为断言 都在");
