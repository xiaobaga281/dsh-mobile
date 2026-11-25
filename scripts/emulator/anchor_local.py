#!/usr/bin/env python3
"""本机模型 + 模拟器：对话流「不甩底 / 不重写 / 断线接得上」动态回归。

子命令共用一套环境（装 debug 包 → 起 App → CDP → 打封条或逐帧采样）：

  scroll  交付卡插入那一轮：逐帧量「距底」，断言不甩开底部、不出现回退
  sealed  给回合开始前已在流的节点打封条，断言这一轮里它们 0 重写（不闪）
  rect    不信 scrollTop：按矩形量用户看到的距底距离，并标定「贴底」时的基准值
  tail    思考行是否跟着输出往前钉（逐帧量行内左偏移）
  resume  流式途中重载页面：内核轮次要重新认领，已流出的字要补回来（用 mock 的「慢慢写」档）
  kill    进程真被杀掉：切后台要同步落盘、重开要标出「这一轮没跑完」
  stop    中途停掉再切走、回来：不能误标「这一轮没跑完」（那是用户自己停的）
  team    团队端到端：Lead 建任务派队友 → 队友干活/认领/汇报 → 交付；含杀进程重开
  member  成员视图与主对话同形（过程组、工具行、来回进出）
  memberexit  从成员会话回 Lead 会话：列表点回 / 退出按钮 / 挤过 10 场别的会话再点回 ——
              三条路都要接回运行中的那一轮，且离开期间跑出来的工具行也要在
  tools   工具行的实时状态（跑完的行、收尾、嵌套）
  sessions 会话列表这个屏幕：一条会话只出现一次、置顶不重复、搜索与空态说对话
  i18n    切到英文模式后扫全部屏幕：静态外壳的文案与无障碍名不许留中文
  dark    深色开关：主题属性、body/令牌颜色、系统栏三样一起动，且能还原
  entry   每个入口按下去要么有动静、要么说清为什么没有（结构/条数/勾选/焦点/toast/浮层都比）
  sessops 会话行左滑出的四个动作（置顶/移动/改名/删除）+ 长按消息「从这里分叉」，逐个看结果
  teamops 团队面照抄桌面的四条：中断不写终态 / 进度＝打开队友会话 / 并发命中落 failed+红点 / 成员正文只有快照一条通道

前置：模拟器已启动、`mock_anchor.py` 监听 8899（脚本会 adb reverse）。
  模拟器：D:\\1\\tools\\android-sdk 下 dsh36；APK：app/build/outputs/apk/standard/debug/...

用法：
  python scripts/emulator/anchor_local.py scroll [apk]
  python scripts/emulator/anchor_local.py sealed
  python scripts/emulator/anchor_local.py rect
"""
import json
import os
import re
import tempfile
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from cdp import Cdp  # noqa: E402

ADB = os.environ.get("DSH_ADB", r"D:\1\tools\android-sdk\platform-tools\adb.exe")
SERIAL = os.environ.get("DSH_SERIAL", "emulator-5554")
PORT = int(os.environ.get("DSH_CDP_PORT", "9222"))
MOCK = 8899
PKG = "ai.deepseek.harness.mobile"
DEFAULT_APK = ROOT / "app/build/outputs/apk/standard/debug/app-standard-x86_64-debug.apk"
PROMPT = "写一个 notes/anchor-check.md 然后交付给我（交付）"


def adb(*args, timeout=600):
    # 显式 utf-8 + errors="replace"：adb 输出的是 UTF-8 字节，Windows 上 text=True 会按
    # 本机码（这台机器是 gbk）解，读设备日志里的中文直接 UnicodeDecodeError ——
    # subprocess 的读取线程崩掉后 stdout 变成 None，症状是探针「拿到 0 字节」，
    # 看着像设备上没有这个文件。
    return subprocess.run(
        [ADB, "-s", SERIAL, *args],
        capture_output=True, text=True, timeout=timeout,
        encoding="utf-8", errors="replace",
    ).stdout.strip()


def focus_window():
    return adb("shell", "dumpsys window 2>/dev/null | grep mCurrentFocus")


def clear_system_dialog(pkg=PKG, tries=10):
    """把系统弹框（ANR / 权限框）点掉，并把我们的 Activity 拉回前台。

    为什么要有这一步：ANR 对话框占住焦点时，WebView 主线程不再跑 JS，CDP 每次 eval
    都要等满超时才报 WebSocketTimeout —— 症状长得和「页面坏了」一模一样，但它不是产品的红。
    焦点是 `null` 不算卡住：Activity 切换的那半秒本来就没有焦点，后面还有就绪轮询兜。
    """
    last = ""
    for _ in range(tries):
        last = focus_window()
        if pkg in last:
            return True
        if "Not Responding" in last or "ANR" in last:
            adb("shell", "input", "keyevent", "KEYCODE_ESCAPE")
            time.sleep(2)
        else:
            adb("shell", "am", "start", "-n", f"{pkg}/.MainActivity")
            time.sleep(3)
    return "Not Responding" not in last and "ANR" not in last


def device_busy_pct():
    """瞬时占用（0~100）。/proc/loadavg 是衰减平均：装完 85MB APK 后的 dexopt 风暴过去
    好几分钟，1 分钟平均还挂着 2.7 —— 拿它当闸会把每条探针白等四分种，还照样误报「忙」。"""
    out = adb("shell", "top -b -n 1 | grep '%cpu'")
    total = idle = None
    for tok in out.replace("\n", " ").split():
        t = tok.strip()
        if t.endswith("%cpu"):
            try:
                total = float(t[:-4])
            except ValueError:
                total = None
        elif t.endswith("%idle"):
            try:
                idle = float(t[:-5])
            except ValueError:
                idle = None
    if not total or idle is None:
        raw = adb("shell", "cat", "/proc/loadavg")
        try:
            return max(0.0, min(100.0, float(raw.split()[0]) * 25))
        except (ValueError, IndexError):
            return 0.0
    return max(0.0, min(100.0, (total - idle) / total * 100))


def idle_settle(max_wait=180, want_busy=25.0):
    """等设备安装 / 后台服务那阵风暴过去再开跑。返回 False 只作提醒，不改判定口径。"""
    waited = 0
    busy = 100.0
    while waited < max_wait:
        busy = device_busy_pct()
        if busy <= want_busy and "Not Responding" not in focus_window():
            if waited:
                print(f"设备闲下来了（占用 {busy:.0f}%，多等了 {waited}s）")
            return True
        time.sleep(6)
        waited += 6
    print(f"警告：设备仍忙（占用 {busy:.0f}%，焦点={focus_window() or '(空)'}）—— 这条探针可能偏慢")
    return False


def bundle_stamp(apk):
    """把「报绿的那一份」写进日志：APK 里的 app.js 指纹必须等于仓库产物。

    release 增量缓存坏过一次 —— APK 是旧的但版本号是新的，只看 install: Success 会被骗。
    """
    try:
        import hashlib
        import zipfile
        inapk = zipfile.ZipFile(str(apk)).read("assets/web/app.js")
        ours = (ROOT / "app/src/main/assets/web/app.js").read_bytes()
        ha = hashlib.sha256(inapk).hexdigest()[:10]
        hb = hashlib.sha256(ours).hexdigest()[:10]
        print(f"bundle: APK {len(inapk)}B {ha} / 产物 {hb} {'一致' if ha == hb else '【不一致：装的是过期产物】'}")
    except Exception as exc:  # noqa: BLE001
        print("bundle: 读不出来（", exc, "）")


def boot(apk=None, quiet=False):
    # 不指名 APK 时也要装：`anchor_local.py tools` 以前会跑「设备上恰好装着的那一版」，
    # 报出来的绿和红都不是当前代码的（实测过一次：改完没重装，探针仍按上一份 bundle 判）。
    if apk is None and os.path.exists(DEFAULT_APK):
        apk = DEFAULT_APK
    if not adb("shell", "getprop", "sys.boot_completed") == "1":
        sys.exit("模拟器没起来")
    # 刚开完机的 1~2 分钟里 system_server 还在忙首页与后台服务，那阵子连上去只会拿到
    # 「Application Not Responding: system」占住焦点，之后每条 eval 都要等满两次 30 秒超时。
    # 冷启后第一条探针因此整批作废过；先等它闲下来，比事后猜「页面坏了」便宜。
    if not quiet:
        idle_settle()
    adb("reverse", f"tcp:{MOCK}", f"tcp:{MOCK}")
    if apk:
        print("install:", (adb("install", "-r", "-d", str(apk)) or "(none)").splitlines()[-1])
        bundle_stamp(apk)
    adb("shell", "am", "force-stop", PKG)
    adb("shell", "am", "start", "-n", f"{PKG}/.MainActivity")
    if not clear_system_dialog():
        sys.exit(f"环境问题：系统弹框关不掉，焦点还在 {focus_window() or '(空)'} —— 探针结果不可信")
    # 装完新包的首启要 12~16 秒才挂出 window.__dsh；硬睡 7 秒会对着没就绪的页发指令，
    # 症状是「队友没起来 / __dsh is not defined」，其实是探针跑在页面前面
    c = None
    for _ in range(20):
        time.sleep(2)
        pids = adb("shell", "pidof", PKG).split()
        if not pids:
            continue
        adb("forward", f"tcp:{PORT}", f"localabstract:webview_devtools_remote_{pids[0]}")
        try:
            c = Cdp(port=PORT)
            if "undefined" not in str(c.eval("typeof window.__dsh")):
                return c
        except Exception:
            continue
    sys.exit("页面没就绪（window.__dsh 一直没挂出来）")


SEND_JS = """(() => {
  const i = document.querySelector('#input');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(i, %s);
  i.dispatchEvent(new Event('input', {bubbles:true}));
  document.querySelector('#btnSend').click();
  return 1;
})()"""


def send(ev, text):
    ev(SEND_JS % json.dumps(text))


def thread_len(ev):
    return json.loads(ev("JSON.stringify(__dsh.thread.length)"))


# 本轮已显示的字数 = 本轮已封进节点的正文 + 还在流的那口气泡。
# 两处都要小心：
#  · 只读 Live.text 会少算一个数量级 —— 思考每开一个新过程组它就归零；
#  · 正在流的那个节点**已经在 thread 里**（每次绘制把 text 同步进去），只在还在流的时候
#    跳过它、改加 Live.text；回合结束后 Live.textNode 会被清掉而 Live.text 还留着，
#    这时候再叠加一次就虚高（实测虚高 125~492 字）。
ROUND_CHARS = """(() => {
  const live = (__dsh.Live && __dsh.Live.id) ? (__dsh.Live.textNode || null) : null;
  let sum = 0;
  for (let i = __dsh.thread.length - 1; i >= 0; i--) {
    const n = __dsh.thread[i];
    if (n.kind === 'user') break;
    if (n.kind === 'text' && n !== live) sum += (n.text || '').length;
  }
  return sum + (live ? String(__dsh.Live.text || '').length : 0);
})()"""


def send_and_wait(ev, text):
    before, prev, grew, still = thread_len(ev), thread_len(ev), False, 0
    send(ev, text)
    for _ in range(160):
        time.sleep(0.5)
        now = thread_len(ev)
        grew = grew or now > before
        still = 0 if now != prev else still + 1
        prev = now
        if grew and still >= 4:
            break
    return grew


def prune_local(ev, keep=40):
    """本地库先去同 id 的多条，再只留最新 keep 场。返回 {before, dupRemoved, removed, after}。

    为什么探针要管这件事：
    · 每跑一次就新建一场会话，几百次之后库里 688 场全是残渣 —— 冷启动要解析整个索引，
      WebView 主线程忙到 CDP 求值等满超时，报出来的红其实是设备被自己的残渣拖慢了
      （实测「设备占用 100%」那几条都发生在这之后）。
    · id 只拼时间的年代（`uid()` 之前）在这台机器上留下过**同 id 多条**的旧数据。
      `sessions` 探针量的是「一条会话只出现一次」，旧残渣会让它一直红、看不出新回归，
      所以先把撞 id 的整批清掉（`remove(id)` 是按 id 过滤，一次就全清了）。
    """
    return ev("""(() => {
      const L = window.__dsh.LocalDB;
      const before = L.all().length;
      const seen = new Set(); const dup = new Set();
      for (const s of L.all()) { if (seen.has(s.id)) dup.add(s.id); seen.add(s.id); }
      for (const id of dup) { try { L.remove(id); } catch (_) {} }
      const rest = L.all().slice().sort((a, b) => (b.at || 0) - (a.at || 0));
      const gone = rest.slice(%d).map((s) => { try { L.remove(s.id); } catch (_) {} return 1; });
      return JSON.stringify({
        before: before, dupRemoved: dup.size, removed: gone.length, after: L.all().length,
      });
    })()""" % keep)


def setup(ev):
    ev("""
      localStorage.setItem('dsh.models', JSON.stringify([
        {id:'mock-a', name:'MockA', desc:'锚定回归', upstream:'deepseek-chat',
         url:'http://127.0.0.1:8899/v1', key:'x', efforts:['off']}
      ]));
      localStorage.setItem('dsh.model','mock-a');
      localStorage.setItem('dsh.mode','local');
      localStorage.setItem('dsh.kernelTools','1');
      localStorage.setItem('dsh.permission','full');
      localStorage.setItem('dsh.companion','0');
      location.reload(); 1
    """)
    time.sleep(4)
    d = jval(prune_local(ev))
    print(f"  本地库清残渣：{d['before']} → {d['after']}"
          f"（撞 id 的 {d['dupRemoved']} 个 id 整批清掉、历史探针会话删 {d['removed']} 场）")
    ev("document.querySelector('#btnNewSession').click(); 1")
    time.sleep(0.8)


def pad(ev, turns=3):
    for i in range(turns):
        send_and_wait(ev, f"再讲一段（{i}）")
    time.sleep(0.8)


def cmd_scroll(c):
    ev = c.eval
    setup(ev)
    pad(ev)
    ev("""
      window.__s = [];
      const sc = document.querySelector('#chatScroll');
      window.__t0 = Date.now();
      window.__iv = setInterval(() => {
        window.__s.push([Date.now()-window.__t0, Math.round(sc.scrollTop), sc.scrollHeight, sc.clientHeight, __dsh.follow?1:0]);
      }, 100);
      1
    """)
    sid = ev("JSON.stringify(__dsh.state.sessionId)")
    send_and_wait(ev, PROMPT)
    time.sleep(2)
    ev("clearInterval(window.__iv); 1")
    series = json.loads(ev("JSON.stringify(window.__s)"))
    kinds = json.loads(ev("JSON.stringify(__dsh.thread.map(n=>n.kind))"))
    sync = json.loads(ev("JSON.stringify({r: __dsh.renderTailFrom, n: __dsh.thread.length})"))
    fails = []
    if sync["r"] != sync["n"]:
        # 指针与线程差 1 = 下一次流式 paint 会整表重建（中段插入没同步尾部队指针）
        fails.append(f"尾部队指针脱节 renderTailFrom={sync['r']} thread={sync['n']}")
    print("  尾部队指针：", sync)
    print("  会话没换：", ev("JSON.stringify(__dsh.state.sessionId)") == sid)
    if "deliverable" not in kinds:
        fails.append("本轮没产出交付卡")
    gaps = [(t, h - st - ch) for (t, st, h, ch, _f) in series if ch]
    flips = [t for (t, _a, _b, _c, f) in series if _c and f == 0]
    worst = max((g for _, g in gaps), default=0)
    back = max([series[i - 1][1] - series[i][1] for i in range(1, len(series))] or [0])
    print(f"  采样 {len(series)}；最大距底 {round(worst)}px；向上回退 {round(back)}px；follow 关闭 {len(flips)} 次")
    big = [[t, round(h - st - ch), f] for (t, st, h, ch, f) in series if ch and h - st - ch > 40]
    if big:
        print("  距底>40 的采样 [t,gap,follow]：", big[:18])
    # 「甩底」= 视口落在内容后面**并且停在那儿**。逐帧贴底是 rAF 写的，采样是 100ms 一次：
    # 采样正好落在「内容刚长高、下一帧还没写」那一格，就会看到一次 45px 的孤立读数，
    # 下一格已经归零 —— 这不是缺陷，是采样粒度比写入粒度粗。
    # 判据因此是：连续两格还 >40px（真的停住了），或者任何一格 follow 已经关了却仍 >40px
    # （跟随被误判关掉 —— 实测过的那次 111px 就是这个形状，会一直停到用户碰屏幕）。
    stuck = None
    for i in range(1, len(series)):
        t0, s0, h0, c0, f0 = series[i - 1]
        t1, s1, h1, c1, f1 = series[i]
        if not c0 or not c1:
            continue
        g0, g1 = h0 - c0 - s0, h1 - c1 - s1
        if g0 > 40 and g1 > 40:
            stuck = (t0, round(g0), round(g1))
            break
    lost = [g for g, f in ((x[2] - x[3] - x[1], x[4]) for x in series) if f == 0 and g > 40]
    if stuck:
        fails.append(f"甩开底部并停住：{stuck[1]}px → {stuck[2]}px（t={stuck[0]}）")
    elif lost:
        fails.append(f"跟随已关却仍距底 {round(max(lost))}px（用户没上滑，是跟随被误判关掉了）")
    if back > 20:
        fails.append(f"向上回退 {round(back)}px")
    print("\n" + ("全部通过" if not fails else f"未通过：{fails}"))
    return 0 if not fails else 1


SEAL_ON = """(() => {
  const box = document.querySelector('#messages');
  window.__hit = {removed: 0, attrs: 0, text: 0, child: 0, names: []};
  [...box.children].forEach((el, i) => { el.dataset.sealed = 's' + i; });
  const sealed = new Set([...box.children]);
  const owner = (n) => {
    let e = n && (n.nodeType === 1 ? n : n.parentElement);
    while (e && e !== box) { if (sealed.has(e)) return e; e = e.parentElement; }
    return null;
  };
  window.__obs = new MutationObserver((ms) => {
    for (const m of ms) {
      if (m.type === 'childList') {
        for (const n of m.removedNodes) {
          const o = owner(n.nodeType === 1 ? n : m.target);
          if (o) { window.__hit.removed++; window.__hit.names.push('rm:' + o.dataset.sealed); }
        }
        for (const n of m.addedNodes) {
          if (!owner(m.target)) continue;
          window.__hit.child++; window.__hit.names.push('add:' + m.target.className);
        }
      } else if (m.type === 'attributes') {
        if (!owner(m.target) || m.attributeName === 'data-sealed') continue;
        // 思考行摘要的滚动开关（class / --mq / --mq-dur）是它自己的记账，不算重写内容
        if ((m.attributeName === 'class' || m.attributeName === 'style')
            && m.target.matches && m.target.matches('.pg-sum, .pc-think-brief')) continue;
        window.__hit.attrs++; window.__hit.names.push('attr:' + m.attributeName + ':' + m.target.className);
      } else if (owner(m.target)) {
        window.__hit.text++; window.__hit.names.push('text:' + (m.target.parentElement||{}).className);
      }
    }
  });
  window.__obs.observe(box, {childList: true, subtree: true, attributes: true, characterData: true});
  return JSON.stringify({sealed: sealed.size});
})()"""

SEAL_OFF = """(() => {
  window.__obs.disconnect();
  const box = document.querySelector('#messages');
  const still = [...box.querySelectorAll('[data-sealed]')].length;
  delete window.__obs;
  return JSON.stringify({hit: window.__hit, still});
})()"""


def cmd_sealed(c):
    ev = c.eval
    setup(ev)
    pad(ev, 2)
    fails = []
    for name, text in (("普通一轮", "再讲一段"), ("带交付的一轮", PROMPT)):
        sealed = json.loads(ev(SEAL_ON))
        send_and_wait(ev, text)
        time.sleep(1.2)
        res = json.loads(ev(SEAL_OFF))
        hit = {k: v for k, v in res["hit"].items() if k != "names"}
        print(f"  {name}：封条 {sealed['sealed']} 个 → {hit}；样本 {res['hit']['names'][:6]}；仍在 {res['still']}")
        if any(hit.values()) or res["still"] != sealed["sealed"]:
            fails.append(name)
    print("\n" + ("全部通过" if not fails else f"未通过：{fails}"))
    return 0 if not fails else 1


def cmd_rect(c):
    ev = c.eval
    setup(ev)
    pad(ev)
    ev("""(() => {
      const sc = document.querySelector('#chatScroll'), box = document.querySelector('#messages');
      window.__r = [];
      const tick = () => {
        const pb = parseFloat(getComputedStyle(sc).paddingBottom) || 0;
        const last = box.lastElementChild;
        if (last) {
          const sr = sc.getBoundingClientRect(), lr = last.getBoundingClientRect();
          window.__r.push([Math.round(lr.bottom + pb - sr.bottom), sc.scrollHeight, Math.round(sc.scrollTop), __dsh.follow ? 1 : 0]);
        }
        if (__dsh.state.busy || window.__r.length < 5) requestAnimationFrame(tick);
        else if (window.__r.length < 2000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return 1;
    })()""")
    send_and_wait(ev, PROMPT)
    time.sleep(1.5)
    r = json.loads(ev("JSON.stringify(window.__r)"))
    ev("""(() => { const sc = document.querySelector('#chatScroll');
      sc.scrollTo({top: sc.scrollHeight, behavior:'instant'}); return 1; })()""")
    time.sleep(0.5)
    cal = json.loads(ev("""(() => {
      const sc = document.querySelector('#chatScroll'), box = document.querySelector('#messages');
      const pb = parseFloat(getComputedStyle(sc).paddingBottom) || 0;
      const last = box.lastElementChild.getBoundingClientRect(), sr = sc.getBoundingClientRect();
      return JSON.stringify({rect: Math.round(last.bottom + pb - sr.bottom), st: Math.round(sc.scrollTop),
        sh: sc.scrollHeight, ch: sc.clientHeight});
    })()"""))
    d = [x[0] for x in r] or [0]
    print(f"  帧 {len(r)}；矩形距底 最小 {min(d)} 最大 {max(d)}；贴底标定 {cal}")
    return 0


TAIL_JS = r"""(() => {
  // 收起态用户看到的「那一行」是组头（.pg-label）；组被点开时是组内那一行的 .pg-sum。
  // 取样优先看「已经点开的那一组」—— 用户点开哪组就盯哪组，而不是 DOM 里最后那个。
  const d = window.__dsh;
  const groups = [...document.querySelectorAll('#messages [data-pgroup]')];
  const opened = groups.filter((x) => x.classList.contains('is-open')).pop();
  const g = opened || groups[groups.length - 1];
  const lab = g && g.querySelector('.pg-label');
  const rows = g ? [...g.querySelectorAll('.pg-row.is-think')] : [];
  const row = rows[rows.length - 1];
  const body = row ? row.querySelector('.pg-think-text') : null;
  const sum = row ? row.querySelector('.pg-sum') : null;
  const grp = d && d.Flow && d.Flow.group;
  const m = grp ? [...(grp.members || [])].reverse().find((x) => x && x.type === 'think') : null;
  return JSON.stringify({
    n: groups.length, busy: !!(d && d.state.busy),
    gOpen: !!opened,
    isRun: !!g && g.classList.contains('is-run'),
    head: lab ? lab.textContent : null,
    len: (lab && lab.textContent || '').length,
    sl: lab ? Math.round(lab.scrollLeft) : 0,
    tail: lab ? lab.classList.contains('is-tail') : false,
    over: lab ? Math.round(lab.scrollWidth - lab.clientWidth) : 0,
    w: lab ? lab.clientWidth : 0,
    end: (lab && lab.textContent || '').slice(-10),
    thinkLen: m ? String(m.text || "").length : 0,
    bodyLen: body ? String(body.textContent || "").length : 0,
    openIsLast: !!opened && opened === groups[groups.length - 1],
    rowOpen: row ? row.classList.contains('is-open') : false,
    hasRow: !!row,
    sumText: sum ? sum.textContent : null,
  });
})()"""


def run_tail(c, prompt, expand_after=None, seconds=40):
    """跑一轮并持续采样；expand_after 到点替用户点开过程组（展开态走另一条渲染路径）。"""
    ev = c.eval
    send(ev, prompt)
    samples, idle, expanded, t0 = [], 0, False, time.time()
    while time.time() - t0 < seconds:
        time.sleep(0.2)
        st = json.loads(ev(TAIL_JS))
        samples.append(st)
        if expand_after is not None and not expanded and time.time() - t0 >= expand_after:
            ev("(() => { const gs=[...document.querySelectorAll('#messages [data-pgroup]')]);"
               "const h=gs[gs.length-1] && gs[gs.length-1].querySelector('[data-toggle-pgroup]');"
               "if (h) h.click(); return 1; })()")
            expanded = True
        if not st.get("busy") and st.get("n"):
            idle += 1
            if idle >= 3:
                break
    return samples


def tail_verdict(samples, label, expect_open=False):
    """用户盯着的那一行必须一直有内容、一直跟着输出走。

    只判「组还在跑」的窗口：收口后组头本来就要换成结算标题（「已完成分析」），
    拿它跟流式期比长度是自己给自己造的假失败。
    收起态盯组头（.pg-label），展开态盯组内那一行的摘要（.pg-sum）—— 同一个意思的两种落点。
    """
    live = [s for s in samples if s.get("n")]
    run = [s for s in live if s["busy"] and s["isRun"]]
    n_open = len([s for s in run if s["gOpen"]])
    fails = []

    def read_len(s):
        return len((s.get("sumText") or "")) if s["gOpen"] else len(s.get("head") or "")

    lens = [read_len(s) for s in run]
    print(f"  [{label}] 采样 {len(live)} 帧、在跑窗口 {len(run)} 帧（展开态 {n_open} 帧）；"
          f"模型侧思考最长 {max([s['thinkLen'] for s in live] or [0])} 字；"
          f"那一行长度 {lens[:3]}…{lens[-3:]}")
    if len(run) < 4:
        return [f"[{label}] 在跑窗口只有 {len(run)} 帧，看不出跟随（夹具没撑住时间窗？）"]
    if expect_open and not n_open:
        return [f"[{label}] 组根本没被点开（{len(run)} 帧全是收起态）—— 这条路径没测到，别当成通过"]
    if max(lens) < 12:
        fails.append(f"[{label}] 那一行最长只有 {max(lens)} 字，一直没显示出思考内容")
    if len(set(lens)) < 3:
        fails.append(f"[{label}] 那一行没跟着输出变（长度只在 {sorted(set(lens))} 之间）")
    # 核心断言：模型侧已经有思考内容，界面上那一行就不许只剩活动名
    blank_head = [s for s in run if s["thinkLen"] > 4 and not s["gOpen"]
                  and " · " not in (s.get("head") or "")]
    if blank_head:
        fails.append(f"[{label}] {len(blank_head)} 帧：思考有 {blank_head[0]['thinkLen']} 字，"
                     f"组头却只剩「{(blank_head[0].get('head') or '').strip()}」（摘要丢了）")
    # 展开态看的是组内那一行；那一行自己展开时按设计不重复摘要（正文就在下面）
    blank_row = [s for s in run if s["thinkLen"] > 4 and s["gOpen"] and s["openIsLast"]
                 and not s["rowOpen"]
                 and (not s["hasRow"] or not (s.get("sumText") or "").strip())]
    if blank_row:
        fails.append(f"[{label}] {len(blank_row)} 帧：组已展开、思考有 {blank_row[0]['thinkLen']} 字，"
                     f"组内那一行却没有摘要（row={blank_row[0]['hasRow']} sum={blank_row[0]['sumText']!r}）")
    # 钉尾只看收起态（那时组头就是用户在看的那一行），而且只看真的装不下的帧：
    # 一行只有十几个字时本来就无需滚动，要求它「钉住」是探针自己造的假失败。
    pin = [s for s in run if not s["gOpen"] and s.get("w")]
    over_rows = [s for s in pin if s.get("over", 0) > 2]
    if over_rows and not any(s["tail"] and s["sl"] > 0 for s in over_rows):
        fails.append(f"[{label}] 溢出的 {len(over_rows)} 帧里从没钉到文字末尾（全停在开头）")
    last_pin = over_rows[-1] if over_rows else {}
    if last_pin.get("over", 0) > 0 and abs(last_pin.get("sl", 0) - last_pin["over"]) > 2:
        fails.append(f"[{label}] 末帧没钉在文字末尾：scrollLeft={last_pin.get('sl')} 应≈{last_pin['over']}")
    if any(s["sl"] > s["over"] + 2 for s in pin):
        fails.append(f"[{label}] 滚过了头（字会跑出可视区 = 只剩图标看不见）")
    return fails


def cmd_tail(c):
    """思考那一行跟着输出走：收起（组头）与展开（组内行）两条路都要一直显示最新内容。

    夹具必须是「段落之间夹空行、整段以空行收尾」的真实形态（「断行思考」）——
    原来用的「先讲一段」没有空行，摘要永远取到非空段，于是这个 bug 在回归里看不见
    （用户连着报过两次「只显示『思考』两个字」）。
    第二阶段用「组内再想」：先点开组，再让「思考 → 工具 → 又一段思考」都落进同一个组，
    第二段那一行是在还没有字时补进 DOM 的（摘要节点根本没被渲染出来）。
    """
    ev = c.eval
    setup(ev)
    fails = tail_verdict(run_tail(c, "断行思考 讲清楚为什么", seconds=25), "收起态·段落边界")
    tool_tail = json.loads(ev("JSON.stringify(document.querySelectorAll('.pg-row.is-tool .pg-sum.is-tail').length)"))
    if tool_tail:
        fails.append("工具行也被钉了（只该管思考行）")
    fails += tail_verdict(run_tail(c, "组内再想 展开着看", expand_after=1.5, seconds=35),
                          "展开态·组内再想", expect_open=True)
    print("\n" + ("全部通过" if not fails else f"未通过：{fails}"))
    return 0 if not fails else 1


BADGE_JS = r"""(() => {
  const d = window.__dsh, s = d && d.state;
  const b = document.querySelector('#teamBadge');
  return JSON.stringify({
    hidden: b ? !!b.hidden : null,
    text: b ? b.textContent : null,
    sid: s ? s.sessionId : null,
    teamSid: s && s.team ? String(s.team.session || '') : null,
    mates: s && s.team ? (s.team.members || []).filter((m) => m.role !== 'lead').length : -1,
  });
})()"""


def cmd_badge(c):
    """团队角标只属于屏幕上这一场会话。

    复现用户第 2 次报的现象：用过团队 → 点「新建会话」，顶栏团队按钮仍有旧数字。
    上一版只在 startNewSession 里清了一次 state.team，可队友还在后台跑，
    它每一个动作都推一份 team 快照过来，而页面不看快照是哪场会话就照单画上去。
    所以这里必须在「队友仍在跑」的窗口里连续采样，而不是点完新建会话看一眼就走。

    正对照：回到原来那场会话，角标要重新有数字 —— 按会话过滤不能把团队 UI 一并打死。
    """
    ev = c.eval
    setup(ev)
    send(ev, "组建团队 让队友跑久一点")
    time.sleep(6)                      # Lead 已建队、队友正在跑
    in_team = json.loads(ev(BADGE_JS))
    ev("document.querySelector('#btnNewSession').click(); 1")
    time.sleep(1)
    after_new = json.loads(ev(BADGE_JS))
    leaked, still, first_team = [], 0, None
    for _ in range(24):                # 12 秒：队友这段时间一直在推快照
        time.sleep(0.5)
        st = json.loads(ev(BADGE_JS))
        if not st["hidden"]:
            leaked.append(st)
        if st["teamSid"]:
            still += 1
            first_team = first_team or st
    # 回到旧会话：角标必须回来
    team_sid = in_team["sid"]
    ev("document.querySelector('.tab[data-tab=\"sessions\"]').click(); 1")
    time.sleep(1.2)
    # 必须点**这一场**：列表第一行是别的会话时，测到的就是别人的角标
    # （上一版就是点 `[data-open]` 的第一个，回到一场无关的旧会话上报了个假红）
    hit = ev("(() => { const b = document.querySelector('[data-open=\"%s\"]');"
             "if (!b) return 'no-row'; b.click(); return 'ok'; })()" % team_sid)
    time.sleep(2.5)
    back = json.loads(ev(BADGE_JS))
    print(f"  团队会话中 {in_team}")
    print(f"  点新建会话 {after_new}")
    print(f"  新会话静置 12s：角标被点亮的采样 {len(leaked)} 帧" + (f"，首例 {leaked[0]}" if leaked else ""))
    print(f"  回到旧会话 {back}")
    fails = []
    if not in_team["hidden"] is False:
        fails.append(f"前置条件不成立：团队会话里角标本来就该可见（{in_team}）")
    if after_new["hidden"] is not True:
        fails.append("点「新建会话」当下角标就没清（startNewSession 没接线）")
    if leaked:
        fails.append(f"新会话里角标又被旧团队点亮（{len(leaked)}/24 帧，例：{leaked[0]}）")
    if still:
        fails.append(f"新会话里 state.team 又被旧团队填上（{still} 帧，例：{first_team}）")
    # 正对照要证明真的对照上了：回错一场，「角标没恢复」那条断言就是空的
    if hit != "ok":
        fails.append(f"列表里找不到那场团队会话的行（{team_sid}），正对照没跑成")
    elif back["sid"] != team_sid:
        fails.append(f"回来的不是那场团队会话（{back['sid']} ≠ {team_sid}），正对照无效")
    if back["hidden"] or not back["mates"]:
        fails.append(f"回到旧会话角标没恢复 —— 过滤过头了（{back}）")
    print("\n" + ("新会话不再继承旧团队角标，回旧会话仍显示" if not fails else f"未通过：{fails}"))
    return 0 if not fails else 1


def cmd_resume(c):
    """页面被系统回收后重载：内核这一轮还在跑，界面必须**接上**（含已经流出的字）。

    复现用户报的「退出应用再进来 / 息屏再亮屏，对话像被终止了一样」：
    流式途中强制重载页面，然后看气泡有没有把已输出的部分补回来、还在不在长。

    必须用 mock 的「慢慢写」档：默认回合 2 秒就跑完，重载时轮次早结束了，
    测到的是「回合已结算」而不是「断线重连」（第一版就是这么误判的）。
    """
    ev = c.eval
    setup(ev)
    ev("""(() => { const i = document.querySelector('#input');
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
      set.call(i, %s); i.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('#btnSend').click(); return 1; })()"""
       % json.dumps("慢慢写：请连续写一篇长文章，中间不要停，不要调用工具"))
    sid = None
    pre = None
    for _ in range(120):
        time.sleep(0.5)
        # 一次取完：页面字数 + 原生自报的在跑轮次。分开取会跨着回合结束，读到的是
        # 「已经不跑了」的假证据（第一次诊断就是这么错的）。
        pre = json.loads(ev("""JSON.stringify((() => {
          const native = (window.DSHNativeAgent && window.DSHNativeAgent.agentActive)
            ? JSON.parse(window.DSHNativeAgent.agentActive()) : null;
          const runs = (native && native.runs || []);
          return {
            live: (__dsh.Live && __dsh.Live.id) || '',
            page: %s,
            busy: !!(__dsh && __dsh.state.busy),
            sid: __dsh && __dsh.state.sessionId,
            runs: runs.map((r) => ({
              id: r.id, sid: r.sessionId, text: (r.text || '').length, think: (r.reasoning || '').length })),
            nat: runs.reduce((a, r) => a + (r.text || '').length + (r.reasoning || '').length, 0),
          };
        })())""" % ROUND_CHARS))
        if pre["runs"] and pre["nat"] > 900:
            break
    sid = json.dumps(pre["sid"])
    print(f"重载前：页面 {pre['page']} 字 / 原生累计 {pre['nat']} 字，会话 {pre['sid']}，原生在跑 {pre['runs']}")
    if not pre["runs"]:
        print("原生侧没有在跑的轮次（回合已结束或没走内核通道），测不了")
        return 1
    c.send("Page.enable")
    c.send("Page.reload", {"ignoreCache": True})
    time.sleep(5)
    try:
        c.reconnect()
        ev = c.eval
    except Exception as e:  # noqa: BLE000
        print("重载后连不上 WebView：", e)
        return 1
    state = {}
    for _ in range(20):
        time.sleep(1)
        state = json.loads(ev("""JSON.stringify({
          ready: !!window.__dsh, busy: !!__dsh.state.busy,
          live: (__dsh.Live && __dsh.Live.id) || '',
          page: %s,
          sid: __dsh.state.sessionId, same: __dsh.state.sessionId === %s })""" % (ROUND_CHARS, sid)))
        if state.get("ready") and state.get("live"):
            break
    print("重载后：", state)
    after = int(state.get("page") or 0)
    time.sleep(6)
    more = json.loads(ev("JSON.stringify({page: %s, busy: !!__dsh.state.busy})" % ROUND_CHARS))
    print(f"再等 6 秒：{more}（重载时 {after} 字）")
    fails = []
    if not state.get("same"):
        fails.append("没有回到原来那场会话")
    if not state.get("live"):
        fails.append("没认领上内核的轮次（Live.id 是空的）")
    if after < pre["page"] * 0.6:
        fails.append(f"已流出的字没补回来（重载前 {pre['page']}，重载后 {after}）")
    if not more["busy"] and more["page"] <= after:
        fails.append("认领之后既没继续流式也没结束")

    # 收尾同样要验：重连接上之后这一轮**结束**时，界面和落库都得是「一条完整回复」，
    # 而不是半路断掉、重复一段、或者没有轮末行（用户原话就是「跟终止了一样」）。
    end = {}
    for _ in range(60):
        time.sleep(1)
        end = json.loads(ev("""JSON.stringify((() => {
          const th = __dsh.thread;
          const raw = localStorage.getItem('dsh.local.sess.' + __dsh.state.sessionId);
          const msgs = (raw ? (JSON.parse(raw).messages || []) : []);
          const asst = msgs.filter((m) => m.role === 'assistant');
          const all = asst.map((m) => String(m.content || '')).join('\\n');
          return {
            busy: !!__dsh.state.busy, live: (__dsh.Live && __dsh.Live.id) || '',
            users: th.filter((n) => n.kind === 'user').length,
            footers: th.filter((n) => n.kind === 'footer').length,
            page: %s,
            stored: all.length,
            head: all.indexOf('第 1 段') >= 0,
            tail: all.indexOf('第 8') >= 0,
            asstMsgs: asst.length,
          };
        })())""" % ROUND_CHARS))
        if not end.get("busy") and end.get("footers"):
            break
    print("回合结束：", end)
    if end.get("busy"):
        fails.append("等了 60 秒这一轮还没结束")
    if end.get("users") != 1:
        fails.append(f"用户消息在流里出现 {end.get('users')} 次（应为 1）")
    if end.get("footers") != 1:
        fails.append(f"轮末行 {end.get('footers')} 条（应为 1）")
    if end.get("asstMsgs", 0) > 1:
        fails.append(f"落库的助手消息有 {end.get('asstMsgs')} 条（同一轮写了两遍）")
    if end.get("stored", 0) < pre["page"]:
        fails.append(f"落库比页面上还短（页面 {pre['page']} → 重载后 {end.get('page')}，库里只剩 {end.get('stored')}）")
    if end.get("page", 0) > end.get("stored", 0) * 1.05 + 40:
        # 重载前那半截已经落进快照，认领时又把整份快照灌一遍 = 同一句话说两遍
        # （实测虚高 367 字：页面 734 / 库里 367）
        fails.append(f"流里比落库的多出一截（页面 {end.get('page')} vs 库里 {end.get('stored')}）= 这一轮被说了两遍")
    if not end.get("head"):
        fails.append("重载前流出的开头没有进最终回复")
    print(("接上了" if not fails else "未通过：" + str(fails)))
    return 0 if not fails else 1


def open_row(c, sid):
    """会话列表里那一行是自定义手势（左滑 + 轻点），合成 click 不认 —— 发真实鼠标事件。

    先切到会话页再找行：这一轮被打断时冷启动会落在对话页，那时 `renderSessions()` 还没跑过，
    `[data-sess-row]` 一个都不在 DOM 里 —— 以前把它报成「会话列表里找不到那一场，测不了」，
    实际索引、正文、屏幕行都在（取证过），是探针没切页。
    """
    ev = c.eval
    ev("(() => { const t = document.querySelector('.tab[data-tab=\"sessions\"]'); if (t) t.click(); return 1; })()")
    time.sleep(1.8)
    rect = json.loads(ev("""JSON.stringify((() => {
      const row = document.querySelector('[data-sess-row="%s"]');
      if (!row) return null;
      const b = row.getBoundingClientRect();
      return { x: b.left + 60, y: b.top + b.height / 2 };
    })())""" % sid))
    if not rect:
        return False
    for t in ("mousePressed", "mouseReleased"):
        c.send("Input.dispatchMouseEvent",
               {"type": t, "x": rect["x"], "y": rect["y"], "button": "left", "clickCount": 1})
        time.sleep(0.15)
    time.sleep(2.5)
    return True


def click_at(c, sel):
    """可信鼠标点击（导航按钮与手势行都只认真事件，合成 click 不触发）。"""
    rect = json.loads(c.eval("""JSON.stringify((() => {
      const el = document.querySelector(%s);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    })())""" % json.dumps(sel)))
    if not rect:
        return False
    for t in ("mousePressed", "mouseReleased"):
        c.send("Input.dispatchMouseEvent",
               {"type": t, "x": rect["x"], "y": rect["y"], "button": "left", "clickCount": 1})
        time.sleep(0.12)
    return True


def cmd_stop(c):
    """中途停掉再切走、回来：**不能**显示「这一轮没跑完」。

    那一轮是用户自己停的（切会话也会就地停），不是进程被杀 —— 判据必须是落盘时
    登记的 `open`，不能用「库里最后一条还是用户那句」（停止路径不 commit assistant 消息）。
    """
    ev = c.eval
    setup(ev)
    ev("""(() => { const i = document.querySelector('#input');
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
      set.call(i, %s); i.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('#btnSend').click(); return 1; })()"""
        % json.dumps("慢慢写：请连续写一篇长文章，中间不要停，不要调用工具"))
    page = 0
    for _ in range(60):
        time.sleep(0.5)
        page = json.loads(ev("JSON.stringify(%s)" % ROUND_CHARS))
        if page > 300:
            break
    sid = json.loads(ev("JSON.stringify(__dsh.state.sessionId)"))
    stored_open = json.loads(ev(
        "JSON.stringify((JSON.parse(localStorage.getItem('dsh.local.sess.%s') || '{}').open) || 0)" % sid))
    print(f"停之前：页面 {page} 字，会话 {sid}，落盘的 open={stored_open}")
    # 清空输入框 → 发送键变「停止」，点它
    ev("""(() => { const i = document.querySelector('#input');
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
      set.call(i, ''); i.dispatchEvent(new Event('input', {bubbles:true})); return 1; })()""")
    time.sleep(0.6)
    click_at(c, "#btnSend")
    time.sleep(2)
    stopped = json.loads(ev("JSON.stringify({busy: !!__dsh.state.busy, live: (__dsh.Live && __dsh.Live.id) || ''})"))
    print("停止后：", stopped)
    # 切到新会话，再点回原来那场
    click_at(c, "#btnNewSession")
    time.sleep(1.2)
    if not open_row(c, sid):
        print("会话列表里找不到那一场，测不了")
        return 1
    tail = json.loads(ev("""JSON.stringify((() => {
      const th = __dsh.thread;
      const last = th[th.length - 1] || {};
      const stored = JSON.parse(localStorage.getItem('dsh.local.sess.%s') || '{}');
      return { n: th.length, tailKind: last.kind || '', marks: th.filter((n) => n.kind === 'interrupted').length,
               open: Number(stored.open) || 0, note: (() => {
                 const el = document.querySelector('#messages .msg:last-child');
                 return el ? el.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40) : ''; })() };
    })())""" % sid))
    print("回来看：", tail)
    fails = []
    if stored_open <= 0:
        fails.append("停止前没登记 open（这轮根本没落过盘，测不到误报）")
    if stopped["busy"] or stopped["live"]:
        fails.append(f"没停下来（busy={stopped['busy']} live={stopped['live']}），后面测的就不是「停止后重开」")
    if tail["tailKind"] == "interrupted" or tail["marks"]:
        fails.append(f"把用户自己停掉的回合标成了「没跑完」（尾巴 {tail['tailKind']} / {tail['marks']} 处标记）")
    if tail["open"]:
        fails.append(f"停止后仍留着 open={tail['open']}")
    print(("没有再误报" if not fails else "未通过：" + str(fails)))
    return 0 if not fails else 1


def cmd_kill(c):
    """进程真被杀掉（划掉任务 / 系统回收）：半截回复要留住，重开要说出「这一轮没跑完」。

    与 resume 的分工：resume 测「进程还活着、渲染进程被回收」→ 轮次能接上；
    这里测更狠的一档 —— 内核一起没了，谁也没法继续跑，那就至少
      ① 切后台那一刻要同步落一次快照（8 秒节流 + 空闲回调在隐藏页里不再跑）；
      ② 重开时界面必须说明这轮被打断，而不是回复停在半路什么都没有。
    """
    ev = c.eval
    setup(ev)
    ev("""(() => { const i = document.querySelector('#input');
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
      set.call(i, %s); i.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('#btnSend').click(); return 1; })()"""
        % json.dumps("慢慢写：请连续写一篇长文章，中间不要停，不要调用工具"))
    page = 0
    sealed = 0
    sid = ""
    for _ in range(60):
        time.sleep(0.5)
        row = json.loads(ev("""JSON.stringify({
          p: %s,
          s: __dsh.thread.filter((n) => n.kind === 'text').reduce((a, n) => a + (n.text || '').length, 0),
          sid: __dsh.state.sessionId })""" % ROUND_CHARS))
        page, sealed, sid = row["p"], row["s"], row["sid"]
        if page > 400:
            break
    # 退到桌面：这就是「进程被杀前最后一次能落盘的机会」
    adb("shell", "input", "keyevent", "KEYCODE_HOME")
    # HOME 之后 visibilitychange 不是立刻到的（实测 0.3 秒时 document.hidden 还是 false），
    # 更关键的是：这一轮在后台还在继续流，所以只认「已经隐藏」之后读到的库
    for _ in range(20):
        time.sleep(0.5)
        if json.loads(ev("JSON.stringify(!!document.hidden)")):
            break
    time.sleep(1.5)
    stored = json.loads(ev("""JSON.stringify((() => {
      const shot = JSON.parse(localStorage.getItem('dsh.local.sess.%s') || '{}').shot || [];
      return shot.filter((n) => n.kind === 'text').reduce((a, n) => a + (n.text || '').length, 0);
    })())""" % sid))
    print(f"切后台：页面 {page} 字（已封进节点 {sealed}）→ 库里 {stored} 字（会话 {sid}）")
    adb("shell", "am", "force-stop", PKG)
    time.sleep(2)
    adb("shell", "am", "start", "-n", f"{PKG}/.MainActivity")
    time.sleep(9)
    pid = adb("shell", "pidof", PKG).split()[0]
    adb("forward", f"tcp:{PORT}", f"localabstract:webview_devtools_remote_{pid}")
    c = Cdp(port=PORT)
    ev = c.eval
    if not open_row(c, sid):
        print("会话列表里找不到那一场，测不了")
        return 1
    tail = json.loads(ev("""JSON.stringify((() => {
      const th = __dsh.thread;
      const last = th[th.length - 1] || {};
      return {
        n: th.length, tailKind: last.kind || '',
        marks: th.filter((n) => n.kind === 'interrupted').length,
        page: %s,
        note: (() => { const el = document.querySelector('#messages .msg:last-child');
          return el ? el.textContent.replace(/\\s+/g, ' ').trim().slice(0, 60) : ''; })(),
      };
    })())""" % ROUND_CHARS))
    print("重开：", tail)
    c.shot(str(Path(r"D:\1\tmp\kill_reopen.png")))
    fails = []
    if stored < sealed * 0.9:
        # 比的是「隐藏那一刻已经封进节点的字数」：还在流的那口气泡要等下一次绘制才同步进
        # 节点（页面隐藏后 rAF 不再跑），拿页面总量去要求库里一致是不成立的
        fails.append(f"切后台时没同步落盘（已封 {sealed} 字，库里只有 {stored} 字）")
    if tail.get("tailKind") != "interrupted":
        fails.append(f"重开没有『这一轮没跑完』标记（尾巴是 {tail.get('tailKind') or '空'}）")
    if tail.get("marks") != 1:
        fails.append(f"中断标记 {tail.get('marks')} 条（应为 1，重复 = 落盘的标记又被补了一次）")
    print(("留住了" if not fails else "未通过：" + str(fails)))
    return 0 if not fails else 1


TOOLS_JS = r"""JSON.stringify((() => {
  const out = { rows: [], tail: "", sl: 0, sw: 0, cw: 0, ioLen: 0, segs: null,
                busy: !!__dsh.state.busy, live: 0, nest: 0, tools: 0 };
  out.nest = document.querySelectorAll('.pg-row .pg-row').length;   // 行里套行 = 行级 patch 用错了 morph
  const pgs = __dsh.thread.filter((n) => n.kind === 'pgroup');
  out.loose = pgs.filter((g) => !g.folded).length;                  // 轮末还不收口的过程组 = 认领时没接上
  // 报红时要能看出「少的是哪一步」：c=closed f=folded o=open，按流里的顺序排
  out.gs = pgs.map((g) => (g.closed ? "c" : "-") + (g.folded ? "f" : "-") + (g.open ? "o" : "-"));
  out.running = pgs.reduce((a, g) => a + (g.members || []).filter((m) => m.status === 'run').length, 0);
  out.tools = __dsh.thread.filter((n) => n.kind === 'pgroup')
    .reduce((a, g) => a + (g.members || []).filter((m) => m.type === 'tool').length, 0);
  document.querySelectorAll('.pg-row.is-tool').forEach((r) => {
    const t = r.querySelector('.pg-title'), s = r.querySelector('.pg-sum');
    out.rows.push({ t: t ? (t.textContent || '').trim() : '',
                    s: s ? (s.textContent || '').trim() : '',
                    run: r.classList.contains('is-run'),
                    live: !!r.querySelector('.pg-sum.is-live') });
  });
  const row = [...document.querySelectorAll('.pg-row.is-tool.is-run')].pop();
  if (row) {
    const sum = row.querySelector('.pg-sum');
    if (sum) {
      out.tail = (sum.textContent || '').trim();
      out.sl = Math.round(sum.scrollLeft); out.sw = Math.round(sum.scrollWidth);
      out.cw = Math.round(sum.clientWidth);
    }
    const io = row.querySelector('.io-text');
    out.ioLen = io ? (io.textContent || '').length : 0;
    const secs = row.querySelectorAll('.io-sec');
    const box = secs.length ? secs[secs.length - 1] : null;
    if (box) {
      out.boxTop = Math.round(box.scrollTop);
      out.boxMax = Math.round(box.scrollHeight - box.clientHeight);
      out.boxH = Math.round(box.clientHeight);
      const lines = (box.textContent || '').split("\n");
      out.boxTail = lines[lines.length - 1].trim();
      out.stick = box.dataset.stick || '';
    }
    out.live = 1;
  }
  const native = (window.DSHNativeAgent && window.DSHNativeAgent.agentActive)
    ? JSON.parse(window.DSHNativeAgent.agentActive()) : null;
  const r0 = ((native && native.runs) || [])[0];
  out.segs = (r0 && Array.isArray(r0.segments))
    ? r0.segments.map((s) => s.t + (s.id ? ":" + String(s.id).slice(-2) : "")) : null;
  return out;
})())"""


def cmd_tools(c):
    """工具行的两条新规矩：① 跑动中就能看到它在打印什么；② 中途重载后已跑过的行不丢。

    一条「慢工具」回合同时给出两个窗口：前 8 秒命令在逐行吐输出（看实时输出），
    中间 12 秒正文在流（这时重载，看工具行补不补得回来）。
    """
    ev = c.eval
    setup(ev)
    send(ev, "慢工具：先看输出再写正文")
    fails = []

    def sample():
        return json.loads(ev(TOOLS_JS))

    # ---- ① 实时输出：运行中那一行的摘要要跟着最新一行走 ----
    first = None
    for _ in range(20):
        time.sleep(0.5)
        s = sample()
        if s.get("live") and "输出" in s.get("tail", ""):
            first = s
            break
    if not first:
        fails.append("命令在跑，但那一行没显示实时输出（tail 里看不到「第N行输出」）")
        print("① 采样：", json.dumps(sample(), ensure_ascii=False))
    else:
        print("① 实时输出首样：", json.dumps(first, ensure_ascii=False)[:400])
        # 点开这一行：实时输出框要和展开的思考正文一样贴底跟随最新一行
        ev(r"""(() => { const r = [...document.querySelectorAll('.pg-row.is-tool.is-run')].pop();
              const m = r ? r.querySelector('.pg-main') : null; if (m) m.click(); return 1; })()""")
        time.sleep(2.0)
        second = sample()
        print("① 实时输出次样：", json.dumps(second, ensure_ascii=False)[:400])
        if second.get("boxH", 0) > 0 and second.get("boxMax", 0) - second.get("boxTop", 0) > 24:
            fails.append(f"实时输出框没贴底（scrollTop={second['boxTop']}，可滚 {second['boxMax']}）")
        if second.get("boxH", 0) > 0 and second.get("boxTail", "") not in second.get("tail", ""):
            fails.append(f"框里最后一行不是摘要那行（框尾「{second.get('boxTail')}」/ 摘要「{second.get('tail')}」）")
        if second.get("tail") == first.get("tail"):
            fails.append(f"摘要停在同一行不动（{first.get('tail')}）")
        if not second.get("live") and "输出" in second.get("tail", ""):
            fails.append("有实时输出却没打 is-live 标记（那一行不会被钉到最新）")
        if second.get("ioLen", 0) <= 0:
            fails.append("展开体里没有实时输出（io-text 是空的）")
        if second.get("sw", 0) > second.get("cw", 0) and second.get("sl", 0) <= 0:
            fails.append(f"摘要溢出 {second.get('sw') - second.get('cw')}px 却没钉尾（scrollLeft={second.get('sl')}）")
        if second.get("nest"):
            fails.append(f"行里套行 {second['nest']} 处（行级 patch 把整行塞进了旧行里）")
        if len(second.get("rows", [])) != second.get("tools"):
            fails.append(f"DOM 里 {len(second.get('rows', []))} 条工具行，组内只有 {second.get('tools')} 个工具成员（画重了）")

    # ---- ② 重载前：内核的有序日志里确实有工具事件 ----
    pre = None
    for _ in range(40):
        time.sleep(0.5)
        pre = sample()
        if pre.get("segs") and any(x.startswith("tool_end") for x in pre["segs"]) \
                and pre.get("busy") and not pre.get("live"):
            break
    print("② 重载前：", json.dumps(pre, ensure_ascii=False)[:500])
    if not pre or not pre.get("segs"):
        fails.append("内核快照里没有 segments（回放日志没生效，测不了重载）")
        return 1
    if not any(x.startswith("tool_end") for x in pre["segs"]):
        fails.append(f"segments 里没有已完成的工具事件：{pre['segs']}")
    rows_before = len(pre["rows"])

    sid = json.loads(ev("JSON.stringify(__dsh.state.sessionId)"))
    c.send("Page.enable")
    c.send("Page.reload", {"ignoreCache": True})
    time.sleep(5)
    try:
        c.reconnect()
        ev = c.eval
    except Exception as e:  # noqa: BLE000
        print("重载后连不上 WebView：", e)
        return 1
    post = json.loads(ev(TOOLS_JS))
    print("② 重载后：", json.dumps(post, ensure_ascii=False)[:500])
    if not post.get("busy"):
        fails.append("重载后没认领上这一轮（busy=false）")
    names = {}
    for r in post.get("rows", []):
        names[r["t"]] = names.get(r["t"], 0) + 1
    dup = {k: v for k, v in names.items() if v > 1}
    if dup:
        fails.append(f"重载后同一工具行画了多遍：{dup}")
    if post.get("nest"):
        fails.append(f"重载后行里套行 {post['nest']} 处")
    if len(post.get("rows", [])) != post.get("tools"):
        fails.append(f"重载后 DOM {len(post.get('rows', []))} 行 vs 组内 {post.get('tools')} 个工具成员（补档重复或漏行）")
    if len(post.get("rows", [])) == 0:
        fails.append(f"重载后工具行全没了（重载前有 {rows_before} 行，现在 0 行）")
    elif len(post.get("rows", [])) < rows_before:
        fails.append(f"重载后工具行变少：重载前 {rows_before} 行，现在 {len(post.get('rows', []))} 行")

    # ---- ③ 跑完：行数与落库都要对 ----
    end = None
    for _ in range(60):
        time.sleep(1)
        end = json.loads(ev(TOOLS_JS))
        if not end.get("busy"):
            break
    print("③ 回合结束：", json.dumps(end, ensure_ascii=False)[:400])
    done_rows = [r for r in end.get("rows", []) if not r.get("run")]
    if len(end.get("rows", [])) < 2:
        fails.append(f"整轮结束只剩 {len(end.get('rows', []))} 条工具行（应有两次命令）")
    if any(r.get("run") for r in end.get("rows", [])):
        fails.append("回合结束了还有工具行停在「运行中」")
    if end.get("loose"):
        fails.append(f"回合结束还剩 {end['loose']} 个过程组没收口（重载时没被 Flow.groups 认领）"
                     f"｜各组状态 c=closed f=folded o=open：{end.get('gs')}")
    if end.get("running"):
        fails.append(f"回合结束还剩 {end['running']} 个成员显示「运行中」")
    stuck = [r for r in end.get("rows", []) if r.get("run")]
    if stuck:
        print("   卡住的行：", json.dumps(stuck, ensure_ascii=False))
    print("   已完成的行数：", len(done_rows))
    print(("工具行两条都过" if not fails else "未通过：" + str(fails)))
    return 0 if not fails else 1


MEMBER_JS = r"""JSON.stringify((() => {
  const txt = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
  const rows = [...document.querySelectorAll('#messages .pg-row.is-tool')].map((r) => ({
    sum: txt(r.querySelector('.pg-sum')),
    io: [...r.querySelectorAll('.io-sec')].map((s) => (s.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)),
    run: r.classList.contains('is-run') }));
  return {
    inView: !!__dsh.state.teamView,
    groups: document.querySelectorAll('#messages .pgroup').length,
    groupHeads: [...document.querySelectorAll('#messages .pgroup > .pgroup-head')].map(txt),
    rows,
    notes: [...document.querySelectorAll('#messages .turn-note')].map(txt),
    ring: document.querySelectorAll('.pg-ring').length,
    roundText: [...document.querySelectorAll('#messages *')]
      .filter((e) => e.children.length === 0 && /第\s*\d+\s*(\/\d+)?\s*轮/.test(e.textContent || '')).length,
    subrows: [...document.querySelectorAll('#messages [data-subrow]')].map(txt),
    users: [...document.querySelectorAll('#messages .msg.user')].length,
    texts: [...document.querySelectorAll('#messages .assistant-text')].length,
    // MOCKSLOW 夹具那口气的字数与句子数：进出成员视图要验证「半截正文跟得回来、且不重复」
    flowChars: [...document.querySelectorAll('#messages .assistant-text')].map((e) => (e.textContent || '')).join('').length,
    sents: ((document.querySelector('#messages') || {}).textContent || '').match(/慢流第 \d+ 句/g) || [],
    busy: !!__dsh.state.busy,
    // 在跑那一口气：气泡模型上的字数 vs 屏上同一节点的字数。
    // 两者拉开 = 快照在长、界面没跟上（实测过 liveSeq 65→830 而屏上钉在 65 字：
    // nodeHTMLUid 的缓存把「成员视图的在跑节点」也缓存住了，morph 拿到旧 HTML 判无变化）。
    live: (() => {
      const ln = ((__dsh.state.teamView || {}).liveNode) || null;
      if (!ln) return null;
      const el = document.querySelector('#messages [data-uid="' + ln.__uid + '"]');
      return { model: String(ln.text || '').length,
               dom: el ? (el.textContent || '').replace(/\s+/g, ' ').trim().length : -1 };
    })(),
    // 内核快照里这一口气的字数与序号：判「有没有新内容」的权威来源
    mate: (() => {
      const tv = __dsh.state.teamView || {};
      const ms = (((( (__dsh.state.team || {}).members) || [])).find((x) => x.target === tv.name)) || null;
      return ms ? { st: ms.status, chars: String(ms.live || '').length, seq: ms.liveSeq || 0 } : null;
    })(),
  };
})())"""


def cmd_member(c):
    """成员（子对话）界面的对话流必须和 Lead 界面同一套形状。

    验五件事：① 工具过程折进过程组（.pgroup + .pg-row.is-tool），行里有输入/输出且非空；
    ② 没有那条自造的轮数进度行（.turn-note / 「第 N 轮」字样 / 进度环）；
    ③ 一条子代理只有一行（以前内核用注册表 id 发进度事件，和 tool_start 的调用 id 对不上，
       同一个子代理会留下两行，其中一行永远「启动中」）；
    ④ 正文/用户句是 text / user 节点；
    ⑤ 队友正在流式时「退出成员视图 → 再进去」，那口气的半截正文要跟着回来、不重复、
       继续跟着长 —— 成员侧没有 claimRun，靠的是快照里的 live 重新起气泡（实测过才敢这么说）。
    """
    ev = c.eval
    setup(ev)
    send(ev, "RELOADDEMO 建一个长时间流式的队友")
    name = None
    for _ in range(30):
        time.sleep(1)
        r = jval(ev(r"""JSON.stringify((() => {
          const o = JSON.parse(window.DSHNativeTeam.teamSnapshot(__dsh.state.sessionId)).team;
          return (o.members || []).filter((m) => m.role === 'teammate')
            .map((m) => ({ n: m.target, s: m.status, act: m.lastAction }));
        })())"""))
        if r:
            print("   roster:", json.dumps(r, ensure_ascii=False))
            name = r[0]["n"]
            if any(x["s"] == "running" for x in r):
                break
    if not name:
        print("没有成员起来，测不了")
        return 1
    # 进入它的会话：先开团队面板（导航按钮认可信事件，用 click_at），再点面板里的「进入会话」
    click_at(c, "#btnTeam")
    time.sleep(0.8)
    ev(r"""(() => {
      const b = document.querySelector('[data-team-open="%s"]');
      if (b) b.click();
      return 1;
    })()""" % name)
    time.sleep(1.5)
    state = jval(ev("JSON.stringify({inView: !!__dsh.state.teamView, name: (__dsh.state.teamView||{}).name})"))
    if not state["inView"]:
        print("点按钮没进成员视图（可能要可信事件）：", state)
        return 1
    snaps = []
    for _ in range(14):
        time.sleep(1.2)
        snaps.append(jval(ev(MEMBER_JS)))
    d = snaps[-1]
    for i, s in enumerate(snaps):
        print("  样%02d 组=%s 行=%s 头=%s note=%s 轮字样=%s 子代理行=%s 正文=%s 用户句=%s" % (
            i, s["groups"], len(s["rows"]), s["groupHeads"][:2], s["notes"], s["roundText"],
            len(s["subrows"]), s["texts"], s["users"]))
    c.shot(str(Path(r"D:\1\tmp\member_view.png")))
    fails = []
    if not d["groups"]:
        fails.append("成员视图里没有过程组（工具没折进组 = 还是平铺的旧样子）")
    if not d["rows"]:
        fails.append("成员视图里没有工具行")
    empty = [r for r in d["rows"] if not r["sum"] or not any(x.strip() for x in r["io"])]
    if empty:
        fails.append(f"{len(empty)} 条工具行是空的（摘要或输入/输出没内容）")
    if d["notes"]:
        fails.append(f"还有自造的进度行：{d['notes']}")
    if d["roundText"]:
        fails.append(f"界面上还有 {d['roundText']} 处「第 N 轮」字样")
    if d["ring"]:
        fails.append(f"还有 {d['ring']} 个进度环（轮数卡片已撤）")

    # 在跑那口气：模型字数（快照里的 live）与屏上字数（同一个节点渲染出来的 DOM）必须一起长。
    # 这条是「快照这一条通道够不够」的正面对账：以前只比 flowChars 前后两次，
    # 界面钉死在第一段也照样绿（实测 bug：liveSeq 65→830，屏上一直 65 字）。
    series = [(s["live"]["model"], s["live"]["dom"], (s.get("mate") or {}).get("chars"),
               (s.get("mate") or {}).get("st")) for s in snaps if s.get("live")]
    for i, (mo, dm, kc, st) in enumerate(series):
        print("  流%02d %s 模型=%s 屏上=%s 快照=%s" % (i, st, mo, dm, kc))
    run = [(mo, dm) for mo, dm, kc, st in series if st in ("running", "provisioning") and dm >= 0]
    long_ = [(mo, dm) for mo, dm in run if mo >= 120]
    if not run:
        print("   ⚠ 这一轮没采到「在跑的气泡」，逐字增长这条没跑到（不算通过，也不算失败）")
    else:
        if len({dm for _, dm in run}) < 2:
            fails.append(f"成员在流式，屏上那口气 14 次采样钉在 {run[0][1]} 字（模型字数在长 = 界面没跟上）")
        if not long_:
            print(f"   ⚠ 模型字数没越过 120（最高 {max([mo for mo, _ in run]) }），对账这条只看了增长")
        else:
            mo, dm = long_[-1]
            if dm < mo * 0.6:
                fails.append(f"屏上字数追不上快照：模型 {mo} 字 / 屏上 {dm} 字（差距 {mo - dm} 字没画出来）")

    # 进出成员视图：队友这一口气还没落日志，界面只能靠快照里的 live 把气泡重新起来 ——
    # 这就是 Lead 那边 claimRun 在成员侧的等价物。断言三件事：不丢、不重、继续跟着长。
    before = d["flowChars"]
    ev("(() => { const b=document.querySelector('#teamViewExit'); if (b) b.click(); return 1; })()")
    time.sleep(2)
    if jval(ev(MEMBER_JS)).get("inView"):
        fails.append("退出按钮没退出成员视图")
    ev("(() => { document.querySelector('#btnTeam').click(); return 1; })()")
    time.sleep(1)
    ev('(() => { const b=document.querySelector(\'[data-team-open="%s"]\'); if (b) b.click(); return 1; })()' % name)
    time.sleep(2.5)
    re = jval(ev(MEMBER_JS))
    print("  重进成员视图：字数=%s 句=%s 组=%s 工具行=%s" % (re.get("flowChars"), len(re.get("sents") or []),
          re.get("groups"), len(re.get("rows") or [])))
    if not re.get("inView"):
        fails.append("退出后重不进成员视图")
    else:
        if re["flowChars"] < before:
            fails.append(f"重进后正文比退出前还短：{before} → {re['flowChars']}（那口气的半截没跟回来）")
        uniq = len(set(re.get("sents") or []))
        if len(re.get("sents") or []) > uniq:
            fails.append(f"同一段话在成员视图里出现两遍（{len(re['sents'])} 次 / 独立 {uniq} 句）")
        if not re.get("rows"):
            fails.append("重进后工具行没了（过程组没从成员日志重灌出来）")

    print(("成员视图与主对话同形" if not fails else "未通过：" + str(fails)))
    return 0 if not fails else 1


TEAM_FLOW = r"""(() => {
  const d=window.__dsh, s=d&&d.state; if(!s) return '{}';
  const th=d.thread||[];
  const b=document.querySelector('#teamBadge');
  return JSON.stringify({
    sid: s.sessionId, busy: !!s.busy, tv: s.teamView? s.teamView.name : null,
    n: th.length, kinds: th.map(x=>x.kind).join(','),
    deliver: th.filter(x=>x.kind==='deliverable').length,
    toolRows: document.querySelectorAll('#messages .pg-row.is-tool').length,
    emptySums: [...document.querySelectorAll('#messages .pg-row .pg-sum')].filter(e=>!(e.textContent||'').trim()).length,
    nest: document.querySelectorAll('#messages .pg-row .pg-row').length,
    badge: b? (b.hidden? '隐藏' : b.textContent) : null,
    mates: (((s.team||{}).members)||[]).filter(m=>m.role!=='lead').map(m=>m.target+':'+m.status),
    // lead 那一行也在 roster 里（TeamRoster 的伪成员）：被拒的自中断不该把它写成 inactive
    leadRow: (((s.team||{}).members)||[]).filter(m=>m.role==='lead').map(m=>m.target+':'+m.status).join(','),
    tasks: (((s.team||{}).tasks)||[]).map(t=>t.id+':'+(t.ownerName||'-')+':'+t.status),
  });
})()"""

# 团队面板里的任务卡（对齐桌面 TaskCard）：描述、两行夹、展开按钮、Owner/依赖/写范围
TASK_CARD = r"""(() => {
  const body = document.querySelector('#sheetBody');
  if (!body) return JSON.stringify({ err: 'no-sheet' });
  const cards = [...body.querySelectorAll('.tm-task')].map((card) => {
    const d = card.querySelector('.tm-task-desc');
    const x = card.querySelector('[data-task-x]');
    return {
      id: (card.querySelector('.tm-task-id') || {}).textContent || '',
      desc: d ? (d.textContent || '').replace(/\s+/g, ' ').slice(0, 40) : '',
      clamped: d ? d.classList.contains('clamp') : null,
      hasX: !!x,
      xHidden: x ? x.hidden : null,
      labels: x ? [x.textContent] : [],
      meta: [...card.querySelectorAll('.tm-task-m span')].map((s) => (s.textContent || '').trim()),
      warn: card.querySelectorAll('.tm-task-warn').length,
    };
  });
  return JSON.stringify({ cards });
})()"""

TEAM_LOG = r"""((parent, name) => {
  let r = {};
  try { r = JSON.parse(DSHNativeTeam.teamMemberLog(parent, name) || '{}'); } catch (e) { r = { err: String(e) }; }
  const ms = r.messages || [];
  return JSON.stringify({ ok: r.ok, err: r.error, total: r.total,
    tools: ms.filter((x) => x.kind === 'tool').map((t) => ({ n: t.name, ok: t.ok,
      out: String(t.out || '').replace(/\s+/g, ' ').slice(0, 60) })),
    hasText: ms.some((x) => x.kind === 'assistant' && String(x.text || '').trim()) });
})"""


def jval(x):
    """CDP 有时已经把 JSON 解析成 dict，有时原样给字符串：两种都接住。"""
    return x if isinstance(x, (dict, list)) else json.loads(x)


def cmd_team(c):
    """团队端到端：Lead 建任务 + 派两名队友 → alpha 调工具/写文件/认领任务/汇报 → Lead 合成并 present 交付。

    这条探针抓到过一个真 bug（用户报「队友调用工具老是失败」）：TeamRuntime 拿**输出文本**
    再解析一次来判成败，而 bash/write 的成功输出是纯文本，`optBoolean("ok")` 只能给 false，
    于是每条成功命令在成员视图里都显示「执行失败」。所以这里必须逐条断言 `tools[].ok`，
    光看「有没有行」是抓不到的。

    还钉住两件事（都是同一句用户反馈的另外两个成因）：成员手里必须有 send_message /
    team_task_*（小窗口裁剪只豁免了 Lead 那一侧），以及成员认领的任务必须记在成员自己名下
    （任务板以前把所有人都认成 lead）。

    第三条是反向的：队友手里的 spawn_teammate / interrupt_agent 必须被服务层拒
    （TEAM_LEAD_REQUIRED / TEAM_INVALID_TARGET），且被拒的那次不能留下半个 roster。
    同一段日志里 team_task_update / send_message 全绿就是正对照 —— 拒的是身份，不是目录。

    另外两种打断也在这里钉住：中途进成员视图再返回（Lead 的流不许变短或乱序）、
    杀进程重开（交付卡与工具行必须还在，队友仍能从 roster 里看到）。
    """
    ev = c.eval
    setup(ev)
    send(ev, "TEAMDEMO 把这件事做完并交付")

    def snap(label):
        d = jval(ev(TEAM_FLOW))
        print(f"  [{label}] n={d.get('n')} 交付卡={d.get('deliver')} 工具行={d.get('toolRows')} "
              f"空摘要={d.get('emptySums')} 嵌套={d.get('nest')} 角标={d.get('badge')} "
              f"队友={d.get('mates')} 任务={d.get('tasks')} tv={d.get('tv')}\n        流={d.get('kinds','')[:70]}")
        return d

    lead0 = None
    for _ in range(12):
        time.sleep(2)
        d = snap("跑动中")
        if len([x for x in (d.get("mates") or []) if x]) >= 2:
            lead0 = d
            break
    if lead0 is None:
        print("未通过：['团队没建起来（两名队友没出现）']")
        return 1
    sid = lead0["sid"]

    fails = []
    # 等 alpha 真的把 task-1 认领下来：这条既是「成员手里有团队工具」的实锤
    # （≤32k 窗口时它们曾被裁光，成员每次汇报都撞 TOOL_NOT_IN_CATALOG），
    # 也是「任务板认得出是谁在改」的实锤（actor() 以前写死 lead，owner 会记成 lead）。
    tasks = []
    for _ in range(12):
        d = snap("等成员认领")
        tasks = d.get("tasks") or []
        if any(str(t).startswith("task-1:alpha") for t in tasks):
            break
        time.sleep(2)
    ev("document.querySelector('#btnTeam').click(); 1")
    time.sleep(1.2)
    # 任务卡形状（对齐桌面 TaskCard）：描述 + 两行夹 + 展开按钮 + Owner 行 + 依赖/写范围
    panel = jval(ev(TASK_CARD))
    cards = {str(c.get("id")): c for c in (panel.get("cards") or [])}
    print("  任务卡：", json.dumps(list(cards.values()), ensure_ascii=False)[:260])
    c1 = cards.get("task-1")
    if c1 is None:
        fails.append(f"面板里没有 task-1 的任务卡（读到 {list(cards)}）")
    else:
        if not (c1.get("desc") or "").strip():
            fails.append("任务卡里没有描述 —— 队友认领前只能凭一句标题猜要做什么")
        if not c1.get("clamped"):
            fails.append("描述没有被两行夹住（桌面 clamp 同一形状）：长说明会把整块面板撑开")
        if "Owner: alpha" not in " ".join(c1.get("meta") or []):
            fails.append(f"task-1 没写 Owner: alpha（meta={c1.get('meta')}）—— 认领了却看不出是谁在干")
        if not c1.get("hasX"):
            fails.append("task-1 没有展开按钮（描述是长句，一定被两行夹住了）")
        elif c1.get("xHidden"):
            fails.append("task-1 的展开按钮被量成「没夹住」而藏起来了（长描述明明溢出两行）")
        else:
            ev("""(() => { const x=document.querySelector('[data-task-x="task-1"]'); if(x) x.click(); return 1; })()""")
            time.sleep(0.6)
            after = {str(c.get("id")): c for c in (jval(ev(TASK_CARD)).get("cards") or [])}
            a1 = after.get("task-1") or {}
            if a1.get("clamped"):
                fails.append("点了「展开」之后描述仍然是夹着的（展开状态没进 Set 或重绘没读到）")
            if "收起" not in " ".join(a1.get("labels") or []):
                fails.append(f"展开后按钮文案没变成「收起」（{a1.get('labels')}）")
    # 被前置挡住的待办：桌面 pending 才显示「可开始 / 被依赖阻塞」，并把依赖列出来
    c2 = cards.get("task-2")
    if c2 is None:
        fails.append(f"面板里没有 task-2（夹具建的被阻塞任务，读到 {list(cards)}）")
    else:
        m2 = " ".join(c2.get("meta") or [])
        if "被依赖阻塞" not in m2:
            fails.append(f"task-2 的前置没完成却不报「被依赖阻塞」（meta={m2}）")
        if "依赖: task-1" not in m2:
            fails.append(f"task-2 没列出依赖是谁（meta={m2}）")
        if "Owner: 未分配" not in m2:
            fails.append(f"没人认领的任务没显示「Owner: 未分配」（meta={m2}）")
        if c2.get("hasX") and not c2.get("xHidden"):
            fails.append("task-2 只有一句短描述，展开按钮却露出来了（量夹这一刀没起作用）")
        if "写入范围: notes" not in m2:
            fails.append(f"task-2 没列出写范围（meta={m2}）—— Lead 分工时看不见别人要改哪儿")
    entered = ev("(() => { const o=document.querySelector('[data-team-open=\"alpha\"]');"
                 "if(!o) return 'no-entry'; o.click(); return 'ok'; })()")
    if entered != "ok":
        fails.append(f"团队面板里点不进 alpha（{entered}）")
    time.sleep(5)
    alpha = jval(ev(f"({TEAM_LOG})({json.dumps(sid)}, 'alpha')"))
    for _ in range(8):
        # 6 条：bash / write / claim / 两条被拒的 Lead 专属操作 / send_message
        if len(alpha.get("tools") or []) >= 6:
            break
        time.sleep(2)
        alpha = jval(ev(f"({TEAM_LOG})({json.dumps(sid)}, 'alpha')"))
    print("  alpha 日志：", json.dumps(alpha, ensure_ascii=False)[:300])
    beta = jval(ev(f"({TEAM_LOG})({json.dumps(sid)}, 'beta')"))
    print("  beta 日志： ", json.dumps(beta, ensure_ascii=False)[:300])
    ev("(() => { const b=document.querySelector('#teamViewExit'); if (b) b.click(); })()")
    time.sleep(2.5)
    back = snap("从成员视图返回后")

    pre = snap("杀进程之前")
    adb("shell", "am", "force-stop", PKG)
    time.sleep(2)
    adb("shell", "am", "start", "-n", f"{PKG}/.MainActivity")
    time.sleep(9)
    pid = adb("shell", "pidof", PKG).split()[0]
    adb("forward", f"tcp:{PORT}", f"localabstract:webview_devtools_remote_{pid}")
    c2 = Cdp(port=PORT)
    time.sleep(2)
    ev2 = c2.eval
    reopened = jval(ev2(TEAM_FLOW))
    if reopened.get("sid") != sid:
        # 重开默认落在新会话；从列表点开那场团队会话才算回到原位（恢复逻辑自己会带路）
        ev2("document.querySelector('.tab[data-tab=\"sessions\"]').click(); 1")
        time.sleep(1.5)
        ev2(f"(() => {{ const b=document.querySelector('[data-open=\"{sid}\"]'); if (b) b.click(); }})()")
        time.sleep(2.5)
        reopened = jval(ev2(TEAM_FLOW))
    print(f"  [重开后] n={reopened.get('n')} 交付卡={reopened.get('deliver')} "
          f"工具行={reopened.get('toolRows')} 队友={reopened.get('mates')} lead行={reopened.get('leadRow')}")

    for name, d in (("alpha", alpha), ("beta", beta)):
        if not d.get("ok"):
            fails.append(f"读不到 {name} 的日志：{d.get('err')}")
            continue
        if not d.get("tools") and not d.get("hasText"):
            fails.append(f"{name} 既没有工具痕迹也没有正文")
        for t in d["tools"]:
            # spawn_teammate / interrupt_agent 是「期望被服务层拒」的夹具，见下方单独断言
            if t["n"] in ("spawn_teammate", "interrupt_agent"):
                continue
            if t["ok"] is not True:
                fails.append(f"{name} 的工具 {t['n']} 被记成失败（输出：{t['out'][:40]}）—— "
                             f"成败必须来自流水线 Outcome，不是回读输出文本")
    # 队友手里那两条 Lead 专属操作必须在服务层被拒（对齐桌面 roster.ts:189/192）。
    # 正对照就在同一份日志里：alpha 的 team_task_update / send_message 全部 ok=True，
    # 所以「被拒」不是目录没豁免、也不是身份没带上，而是 role 判定生效。
    by_name = {t["n"]: t for t in (alpha.get("tools") or [])}
    denied = {
        # 队友调用 Lead 专属操作：桌面 interrupt 的第一刀就是 role 判定（roster.ts:189）。
        # 「不能中断自己」那条 TEAM_INVALID_TARGET 是给 Lead 自己发的（roster.ts:192），
        # 所以这里两条都该是 TEAM_LEAD_REQUIRED —— 自中断在下面用 Lead 的日志单独验。
        # 只判输出里的码，不判 tools[].ok：那一列是**流水线**的成败（工具跑没跑起来），
        # 服务层拒绝是「跑起来了但被拒」，ok 仍是 true，载荷才是 ok:false。
        "spawn_teammate": "TEAM_LEAD_REQUIRED",
        "interrupt_agent": "TEAM_LEAD_REQUIRED",
    }
    for tool_name, code in denied.items():
        t = by_name.get(tool_name)
        if t is None:
            fails.append(f"alpha 没走出 {tool_name}（成员工具行={list(by_name)}）—— 夹具没跑到位，这条断言等于没测")
        elif code not in t["out"] or '"ok":false' not in t["out"]:
            fails.append(f"队友的 {tool_name} 没被服务层按身份拒掉（输出：{t['out']}）—— "
                         f'期望载荷是 {{"ok":false,"code":"{code}"}}；只在 schema/提示词里挡不算挡住')
    # Lead 自中断：验的是「Lead 不能中断自己」这一刀，而不是「查无此人」。
    # 界面看不到这条（面板只对队友给按钮），所以直接读 Lead 自己的会话日志。
    fname = re.sub(r"[^\w.\-]", "_", sid or "")
    lead_log = adb("exec-out", "run-as", PKG, "cat", f"files/kernel/sessions/{fname}.v2.jsonl")
    if "TEAM_INVALID_TARGET" not in lead_log:
        fails.append("Lead 的 interrupt_agent(target=\"lead\") 没拿到 TEAM_INVALID_TARGET —— "
                     f"读的是 files/kernel/sessions/{fname}.v2.jsonl（拿到 {len(lead_log)} 字节）；"
                     "roster 里 lead 是真实一行，少了这一刀就会把 Lead 自己写成 inactive")
    if '"member-interrupted"' in lead_log and '"target":"lead"' in lead_log.replace(" ", ""):
        fails.append("被拒的自中断仍然留下了「lead 被中断」的活动记录")
    # 假阴性的最后一道防线：lead 行如果压根不在快照里，上面两条永远判不到东西
    if not (reopened.get("leadRow") or "").strip():
        fails.append("团队快照里没有 lead 行（leadRow 空）—— 自中断那两条断言没被真正检验")
    elif not str(reopened.get("leadRow", "")).startswith("lead:"):
        fails.append(f"lead 行的名字不对（leadRow={reopened.get('leadRow')}）")
    if any(str(m).startswith("gamma:") for m in (reopened.get("mates") or [])):
        fails.append("被拒的那次 spawn 仍然把 gamma 建出来了（roster=" + str(reopened.get("mates")) + "）")
    # 成员手里的团队工具真的能用吗：这两条在 ≤32k 窗口下曾被目录裁掉，
    # 夹具又只让 alpha 走 bash/write，就永远测不到（用户报的「队友调用工具失败」有一半是这个形状）
    anames = [t["n"] for t in (alpha.get("tools") or [])]
    for need in ("team_task_update", "send_message"):
        if need not in anames:
            fails.append(f"alpha 没走出 {need}（成员工具行={anames}）—— "
                         "成员目录没豁免团队工具，身份提示词却在让它用它们")
    if not any(str(t).startswith("task-1:alpha") for t in tasks):
        fails.append(f"task-1 的 owner 不是 alpha（任务板快照={tasks}）—— "
                     "任务板没认出调用者，成员认领的活全记在 lead 名下")
    if not pre["deliver"]:
        fails.append("Lead 流里没有交付卡（present 之后应该有一张）")
    if reopened.get("deliver", 0) < pre["deliver"]:
        fails.append(f"重开后交付卡少了：{pre['deliver']} → {reopened.get('deliver')}")
    if reopened.get("n", 0) < pre["n"]:
        fails.append(f"重开后 Lead 的流变短了：{pre['n']} → {reopened.get('n')}")
    if reopened.get("toolRows", 0) < 1:
        fails.append("重开后一条工具行都没有（过程细节丢了）")
    if reopened.get("nest"):
        fails.append(f"重开后行套行（nest={reopened['nest']}）")
    if reopened.get("emptySums"):
        fails.append(f"重开后有 {reopened['emptySums']} 条空摘要行")
    if back["n"] < lead0["n"]:
        fails.append(f"从成员视图返回后节点变少：{lead0['n']} → {back['n']}")
    if not str(back.get("kinds", "")).startswith(str(lead0.get("kinds", ""))[:12]):
        fails.append(f"返回后前缀变了（顺序被打乱）：{lead0['kinds'][:20]} → {back['kinds'][:20]}")
    print("\n" + ("团队端到端通过" if not fails else "未通过：\n  - " + "\n  - ".join(fails)))
    return 0 if not fails else 1


LEAD_STATE = r"""(() => {
  const s = window.__dsh.state, th = window.__dsh.thread || [];
  const txt = (document.querySelector('#messages') || {}).innerText || '';
  return JSON.stringify({
    sid: s.sessionId, busy: !!s.busy, tv: s.teamView ? s.teamView.name : null,
    n: th.length, key: th.__sid || '',
    footer: th.filter((x) => x && x.kind === 'footer').length,
    tail: txt.replace(/\s+/g, ' ').slice(-48),
  });
})()"""


def cmd_memberexit(c):
    """从成员会话回 Lead 会话：两条回去的路都必须把「还在后台跑的这一轮」接回来。

    这条是为用户报的「成员会话返回 lead 会话，聊天记录消失不见，连运行状态都没了，
    只有杀后台重启才恢复」而加的。根因不在退出按钮那条路（它一直是对的），而在
    **从会话列表点回原会话**那条路：`openSession` 只清了 teamView，没人认领
    `state.bgRun`，于是界面停在离开那一刻的半截、busy 变 false，而内核那一轮
    还在跑、跑完也没人把结论落进这一份视图 —— 只有重启才会从库里重灌。

    所以这里两条路都验，并且验的是「回来之后还会继续长」而不是「回来有没有字」：
      A. 成员视图 → 会话 tab → 点 Lead 会话行
      B. 成员视图 → 面板的「退出」按钮
      C. 成员视图 → 顺手点开 10 场别的会话（把 Lead 那份桶挤出 LRU）→ 再点回 Lead
         C 是用户实机报的那个形状：重用户会话多，内存只留 8 份桶。
         断言两件事：Lead 的桶不许被挤掉；真被挤掉了也要从内核日志把正文对回来。
    """
    ev = c.eval
    setup(ev)
    fails = []

    def restart():
        """重起 App 并接回 CDP：两条路各要一次干净的「Lead 正在跑 + 已有队友」。

        必须再走一遍 setup()：不重开新会话的话，这一 way 接着上一次的会话跑 ——
        夹具按「历史里有几条 tool 消息」分档（done），旧会话里残留的工具会让它直接
        跳到最后一档（只说话不调工具），断言看到的「工具行没回来」其实是夹具没产工具。
        """
        adb("shell", "am", "force-stop", PKG)
        time.sleep(2)
        adb("shell", "am", "start", "-n", f"{PKG}/.MainActivity")
        for _ in range(12):
            time.sleep(2)
            pids = adb("shell", "pidof", PKG).split()
            if not pids:
                continue
            adb("forward", f"tcp:{PORT}", f"localabstract:webview_devtools_remote_{pids[0]}")
            try:
                nc = Cdp(port=PORT)
                if "undefined" not in str(nc.eval("typeof window.__dsh")):
                    e = nc.eval
                    setup(e)      # 新会话 + mock 模型：每一路都从干净的一场开始
                    return e
            except Exception:
                continue
        raise SystemExit("重启后页面没就绪（window.__dsh 一直挂不出来）")

    def st():
        return jval(ev(LEAD_STATE))

    def enter_member():
        ev("document.querySelector('#btnTeam').click(); 1")
        time.sleep(1.5)
        got = ev("(() => { const o=document.querySelector('[data-team-open]');"
                 "if(!o) return 'no-entry'; o.click(); return 'ok'; })()")
        time.sleep(3)
        return got

    for way in ("列表点回", "退出按钮", "挤桶回来"):
        lead0 = None
        # 装完包 / 刚开机那一跳真的会慢（解析整包 + 首个 mock 回合），等不到队友就重开
        # 一场再来一次 —— 三条路用的是同一份夹具，只有一路红的时候多半是没跑起来，不是产品坏。
        for attempt in (1, 2):
            ev = restart()
            send(ev, "RELOADDEMO 起一个慢队友")
            for _ in range(30):
                time.sleep(2)
                d = jval(ev(TEAM_FLOW))
                if len([x for x in (d.get("mates") or []) if x]) >= 1:
                    lead0 = st()
                    break
            if lead0 and lead0.get("busy"):
                break
            if attempt == 1:
                print(f"  [{way}] 前置没到位，重开一场再来一次")
        if lead0 is None or not lead0.get("busy"):
            print(f"  [{way}] 前置没到位（Lead 没在跑）：{lead0}")
            fails.append(f"{way}：夹具没能造出「Lead 正在跑 + 已有队友」的前置")
            continue
        print(f"  [{way}] 进之前：{lead0}")
        if enter_member() != "ok":
            fails.append(f"{way}：进不去成员会话（面板里没有 data-team-open）")
            continue
        inside = st()
        if inside.get("tv") is None:
            fails.append(f"{way}：没进成成员视图（tv={inside.get('tv')}）")
            continue
        time.sleep(6)      # 让 Lead 在后台多跑几秒，差出来的尾巴才看得见

        def back_via_row():
            ev("document.querySelector('.tab[data-tab=\"sessions\"]').click(); 1")
            time.sleep(1.5)
            sid = inside.get("sid")
            return ev("(() => { const b=document.querySelector('[data-open=\"" + str(sid) + "\"]');"
                      "if(!b) return 'no-row'; b.click(); return 'ok'; })()")

        if way == "列表点回":
            if back_via_row() != "ok":
                fails.append(f"{way}：会话列表里点不到原来那场 Lead 会话")
                continue
        elif way == "挤桶回来":
            # 重用户的真实形状：在成员视图里顺手点开几别的会话。内存只留 8 份桶
            # （BUCKET_MAX），而看队友时 Lead 那份既不是当前 thread、busy/Live 也让到后台了。
            # 关键是要在「Lead 这一轮已经在后台跑完」之后再挤 —— 这时切会话不会取消它，
            # 页面最后一次快照停在进成员视图那一刻，唯一能把正文对回来的就是
            # 「后台那一轮的账还在」+「回来跟内核日志补一次账」。实测把这两条拆掉，
            # 回到 Lead 只剩 132/680 字（19%），就是用户报的「记录不见了」。
            seeded = jval(ev("JSON.stringify((() => {"
                             " const L=window.__dsh.LocalDB;"
                             " return Array.from({length:10},(_,i)=>L.create('探针挤位'+i).id);})())"))
            time.sleep(16)     # 夹具这一轮约 15 秒：等它在后台跑完
            for oid in seeded:
                ev("document.querySelector('.tab[data-tab=\"sessions\"]').click(); 1")
                time.sleep(0.6)
                ev("(() => { const b=document.querySelector('[data-open=\"" + str(oid) + "\"]');"
                   "if(b) b.click(); return 1; })()")
                time.sleep(0.8)
            left = jval(ev("JSON.stringify([...window.__dsh.buckets.keys()])"))
            print(f"  [{way}] 挤过 {len(seeded)} 场后，内存里的桶：{left}")
            if inside.get("sid") not in left:
                print(f"  [{way}] 注：Lead 那份桶已被挤出 LRU（只剩「回来跟内核日志补账」这条兜底）")
            if back_via_row() != "ok":
                fails.append(f"{way}：会话列表里点不到原来那场 Lead 会话")
            ev("(() => { const L=window.__dsh.LocalDB;" + json.dumps(seeded) +
               ".forEach((x) => L.remove(x)); return 1; })()")
        else:
            ev("(() => { const b=document.querySelector('#teamViewExit'); if(b) b.click(); return 1; })()")
        time.sleep(2)
        back = st()
        print(f"  [{way}] 刚回来：{back}")
        if back.get("tv"):
            fails.append(f"{way}：回来了但还挂在成员视图（tv={back.get('tv')}）")
        if back.get("n", 0) < lead0.get("n", 0):
            fails.append(f"{way}：回来后节点比进去时还少：{lead0.get('n')} → {back.get('n')}")
        if back.get("key") != inside.get("sid"):
            fails.append(f"{way}：回来后不在 Lead 那一份桶上（key={back.get('key')}）")
        # 回来时这一轮可能还在跑，也可能已经在后台跑完 —— 两种都要接得住：
        #   还在跑 → busy 必须回到 true，界面还要继续往前长，最后要有收尾行；
        #   已跑完 → 必须把最后一段与收尾行补上（内核日志里有完整回复，页面不能停在最后一次快照）。
        # 以前「从会话列表点回来」这条两条都不成立：没人认领、也没人补尾巴，
        # 于是界面就冻结在离开那一刻的半截 —— 用户报的「记录与运行状态一起消失」。
        if back.get("footer", 0) > 0:
            if back.get("busy"):
                fails.append(f"{way}：这一轮已经收尾（有 footer），busy 却还是 true —— 按钮卡在终止态")
            if "第 29 段" not in (back.get("tail") or ""):
                fails.append(f"{way}：回来时这一轮已跑完，但尾巴没补齐（tail={back.get('tail')}）"
                             "—— 内核有完整回复，页面停在离开前最后一次快照")
        else:
            if not back.get("busy"):
                fails.append(f"{way}：回来后运行状态没接上（busy=false 且没有收尾行）—— "
                             "内核那一轮还在跑，界面却不再认领，用户看到的就是「运行状态消失」")
            grew = False
            for _ in range(10):
                time.sleep(2)
                now = st()
                if now.get("n", 0) > back.get("n", 0):
                    grew = True
                    break
            done = st()
            print(f"  [{way}] 收尾：{done}")
            if not grew:
                fails.append(f"{way}：回来后流不再往前长（节点数停在 {back.get('n')}）—— "
                             "这一轮的尾巴没接上，用户看到的就是一份冻结的半截对话")
            elif not done.get("footer"):
                fails.append(f"{way}：等到最后也没有收尾行（n={done.get('n')}）—— 认领上了却没结算")
    # 第四条：离开期间 Lead 还在产工具 —— 回到 Lead 时过程里那几行工具必须也在。
    # 只补正文尾巴的话，屏幕会比实际发生的「扁」一格（用户报的「形状变粗」）。
    # 夹具 TRACEDEMO 把两条工具刻意排在「进入成员视图之后」，探针才量得到这条差异。
    ev = restart()
    send(ev, "TRACEDEMO 离开期间还在产工具")
    ready = None
    for _ in range(12):
        time.sleep(2)
        d = jval(ev(TEAM_FLOW))
        if [x for x in (d.get("mates") or []) if x]:
            ready = d
            break
    if ready is None:
        fails.append("工具行回来：夹具没造出「Lead 在跑 + 已有队友」的前置")
    elif enter_member() != "ok":
        fails.append("工具行回来：进不去成员视图")
    else:
        print(f"  [工具行回来] 进之前：工具行={ready['toolRows']} n={ready['n']} kinds={ready['kinds']}")
        time.sleep(26)   # 8 秒 + 6 秒两次工具 + 正文：全部发生在离开期间
        ev("(() => { const b=document.querySelector('#teamViewExit'); if(b) b.click(); return 1; })()")
        time.sleep(3)
        a = jval(ev(TEAM_FLOW))
        text = ev("document.querySelector('#messages').innerText.replace(/\\s+/g,' ').slice(-60)")
        print(f"  [工具行回来] 回来后：工具行={a['toolRows']} n={a['n']} kinds={a['kinds']}")
        print(f"  [工具行回来] 屏上末尾：…{text}")
        # spawn 那一行进成员视图前就在；bash + write 是离开期间跑的 → 回来至少 3 行
        if a["toolRows"] < 3:
            fails.append(f"工具行回来：回来只剩 {a['toolRows']} 行工具，离开期间跑的两条没重放"
                         "（应在 3 行以上：spawn + bash + write）")
        if "footer" not in (a.get("kinds") or ""):
            fails.append(f"工具行回来：回来后没有收尾行（kinds={a.get('kinds')}）")
        if "离开期间跑完了" not in (text or ""):
            fails.append(f"工具行回来：回来的屏幕上没有这一轮的正文尾巴（…{text}）")
    print("\n" + ("成员会话返回 Lead：三条路都接回运行中的一轮，离开期间的工具行也重放回来了" if not fails
                  else "未通过：\n  - " + "\n  - ".join(fails)))
    return 0 if not fails else 1


SESSIONS_VIEW = r"""(() => {
  const rowsIn = (sel) => [...document.querySelectorAll(sel + ' [data-open]')].map((x) => x.dataset.open);
  const ws = rowsIn('#wsList'), rec = rowsIn('#recentList'), pin = rowsIn('#pinnedList');
  const cnt = (a) => { const m = {}; a.forEach((x) => { m[x] = (m[x] || 0) + 1; }); return m; };
  const stored = window.__dsh.LocalDB.all();
  const should = stored.filter((s) => !s.pin).map((s) => s.id);      // 置顶单独一块，不参与工作区分组
  return JSON.stringify({
    wsRows: ws.length, wsUniq: new Set(ws).size,
    wsDup: Object.entries(cnt(ws)).filter(([, n]) => n > 1).map(([k, n]) => k + '×' + n),
    recent: rec.length, recentMissing: rec.filter((x) => ws.indexOf(x) < 0),
    pinned: pin.length,
    stored: stored.length, notShown: should.filter((x) => ws.indexOf(x) < 0),
    groups: document.querySelectorAll('#wsList .ws-head').length,
    empty: [...document.querySelectorAll('#recentList .is-empty .s-title, #wsList .is-empty .s-title')]
      .map((e) => e.textContent.trim()),
  });
})()"""


def cmd_sessions(c):
    """会话页的工作区列表：必须列全**全部未删除的会话**，空态与搜索要说对话。

    判据在 rc.211 改过一次方向，记下来免得再翻回去：
      · 曾经的自造判据「整个屏幕一条会话只出现一次」把「最近」当成主列表、从工作区里
        **摘走**了那 3 条 —— 只有三场会话时工作区整块空掉，写着「还没有归档到工作区的会话」。
        用户要看的是「我所有没删的会话都在」，快捷入口不该搬走任何一条。
      · 产品里没有「归档」这个概念：会话只有直接删除。空态文案不许再造一个功能名。
      · 「最近」的 3 条允许与工作区重合：工作区默认堆叠（点开才列出来），不构成找不到哪条是自己的。
    """
    ev = c.eval
    setup(ev)
    fails = []
    # 先把库清空，量「只有三场会话」这个真实形状：这是 rc.210 那条缺陷的现场 ——
    # 「最近」把 3 条全收走、工作区整块空掉，屏幕上只剩一句「还没有归档到工作区的会话」。
    pr = jval(prune_local(ev, keep=0))
    print(f"  清场：库里 {pr['before']} → {pr['after']}")
    ev("""(() => { const st = window.__dsh.state; st.workspace = 'wsC';
      for (let i = 0; i < 3; i++) window.__dsh.LocalDB.create('仅三场形状 ' + i);
      return 1; })()""")
    time.sleep(1)
    ev("document.querySelector('.tab[data-tab=\"sessions\"]').click(); 1")
    time.sleep(1.5)
    few = jval(ev(SESSIONS_VIEW))
    print(f"  仅三场形状：库里={few['stored']} 最近={few['recent']} 工作区行={few['wsRows']} 空态={few['empty']}")
    if few["recent"] != 3:
        print(f"   ⚠ 「最近」没占满 3 条（{few['recent']}），这条形状没测到")
    elif few["wsRows"] < 3:
        fails.append(f"「最近」占满 3 条后，工作区只剩 {few['wsRows']} 行 —— 会话被快捷入口搬走了")
    if few["empty"]:
        fails.append(f"库里明明有三场，工作区却出现空态文案：{few['empty']}")
    # 会话总数少到不足一屏时，「工作区」整块被摘掉也是同一个问题
    if few["groups"] < 1 and few["stored"] >= 1:
        fails.append("有会话却一个工作区分组都没渲染")

    # 造跨两个工作区的样本 + 一条置顶：同时管住「置顶不进分组」「组内不重复」「全部都在」
    ev("""JSON.stringify((() => {
      const L = window.__dsh.LocalDB, st = window.__dsh.state;
      const made = [];
      for (const ws of ['wsA', 'wsB']) {
        st.workspace = ws;
        for (let i = 0; i < 4; i++) made.push(L.create('探针会话 ' + ws + i).id);
      }
      st.workspace = 'wsA';
      const extra = L.create('探针会话 长标题超长超长超长超长超长超长超长超长超长超长').id;
      made.push(extra);
      L.pin(made[2], true);
      return JSON.stringify(made);
    })())""")
    time.sleep(1)
    ev("document.querySelector('.tab[data-tab=\"sessions\"]').click(); 1")
    time.sleep(1.5)
    d = jval(ev(SESSIONS_VIEW))
    print(f"  全量：工作区行={d['wsRows']} 唯一={d['wsUniq']} 组={d['groups']} 最近={d['recent']} "
          f"库里={d['stored']} 工作区空态={d['empty']}")
    if d["wsDup"]:
        fails.append(f"同一场会话在工作区里出现了多次：{d['wsDup'][:6]}")
    if d["wsRows"] != d["wsUniq"]:
        fails.append(f"工作区行数与唯一 id 数不等（{d['wsRows']} vs {d['wsUniq']}）")
    if d["notShown"]:
        fails.append(f"库里 {d['stored']} 场，工作区少 {len(d['notShown'])} 场没列出来：{d['notShown'][:4]}")
    if d["recentMissing"]:
        fails.append(f"「最近」里的会话不在工作区列表里（快捷入口把它搬走了）：{d['recentMissing'][:4]}")
    if not d["groups"]:
        fails.append("一个工作区分组都没有")
    if any("归档" in x for x in d["empty"]):
        fails.append(f"空态文案里有「归档」——产品没有归档功能，只有直接删除：{d['empty']}")
    if d["pinned"] < 1:
        fails.append("置顶没设上（这条样本无效）")

    # 搜索：命中与不命中都不能冒出重复，空态文案要分得清「没匹配」与「没有会话」
    ev("""(() => { const i = document.querySelector('#searchSessions');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(i, 'wsB'); i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()""")
    time.sleep(1)
    hit = jval(ev(SESSIONS_VIEW))
    print(f"  搜索 wsB：工作区行={hit['wsRows']} 唯一={hit['wsUniq']} 空态={hit['empty']}")
    if hit["wsDup"]:
        fails.append(f"搜索态下有重复：{hit['wsDup'][:4]}")
    if hit["wsRows"] == 0:
        fails.append("搜索 wsB 一条都没命中（列表在搜索态被清空了）")
    ev("""(() => { const i = document.querySelector('#searchSessions');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(i, '绝不可能命中的字符串zzz'); i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()""")
    time.sleep(1)
    none = jval(ev(SESSIONS_VIEW))
    print(f"  无命中：工作区行={none['wsRows']} 空态={none['empty']}")
    if none["wsRows"]:
        fails.append(f"无命中的查询还渲染出 {none['wsRows']} 行")
    if not any("没有匹配" in x for x in none["empty"]):
        fails.append(f"无命中时空态没说要「没有匹配」（说的是 {none['empty']}）—— "
                     "用户会以为会话被删了")
    ev("""(() => { const i = document.querySelector('#searchSessions');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()""")
    print("\n" + ("会话列表：工作区列全未删除的会话、搜索与空态说对话" if not fails
                  else "未通过：\n  - " + "\n  - ".join(fails)))
    return 0 if not fails else 1


I18N_SCAN = r"""(() => {
  // 两条口径：
  //  A. 带 id 的静态外壳控件看「自己的文字」—— 会话标题、消息正文里有中文是正常的。
  // B. 任意按钮/输入框的 aria-label / title / placeholder —— 属性是界面词，不是用户内容
  //    （会话行上的「取消置顶」就藏在这里，只看 [id] 会整类漏掉）。
  const DYN = new Set(['toast', 'chatTitle', 'chatSub', 'sheetTitle', 'sheetSub', 'memCount',
                       'voiceText', 'searchHits', 'runPill', 'quickRunText']);
  const bad = [];
  const seenAttr = new Set();
  const han = /[一-鿿]/;
  for (const scr of ['screen-chat', 'screen-sessions', 'screen-jobs', 'screen-files', 'screen-settings']) {
    const root = document.getElementById(scr);
    if (!root) continue;
    for (const e of root.querySelectorAll('[id]')) {
      if (DYN.has(e.id) || !e.offsetParent) continue;
      const own = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
      const attrs = ['placeholder', 'aria-label', 'title'].filter((a) => han.test(e.getAttribute(a) || ''));
      if (han.test(own)) bad.push(scr + '>' + e.id + ' :「' + own.slice(0, 18) + '」');
      if (attrs.length) bad.push(scr + '>' + e.id + ' 属性 ' + attrs.join(',') + ' 还是中文');
    }
    for (const e of root.querySelectorAll('button, input, a, [role="button"]')) {
      if (!e.offsetParent) continue;
      for (const a of ['placeholder', 'aria-label', 'title']) {
        const v = e.getAttribute(a) || '';
        if (!han.test(v)) continue;
        const key = a + '=' + v.slice(0, 24);
        if (seenAttr.has(key)) continue;
        seenAttr.add(key);
        bad.push(scr + ' 属性 ' + key);
      }
    }
  }
  return JSON.stringify({ lang: window.__dsh.state.lang || localStorage.getItem('dsh.lang'), bad: bad });
})()"""


def cmd_i18n(c):
    """英文模式下的中文残留：静态外壳的每一处文案都要跟着语言走。

    这条此前零覆盖（i18n 只有词典本身，没人验证「切到 EN 后屏幕上还有没有中文」）。
    """
    ev = c.eval
    setup(ev)
    fails = []
    zh = jval(ev(I18N_SCAN))
    print(f"  中文模式：lang={zh['lang']} 报点={len(zh['bad'])}（这里非空是正常的，只当基线看）")
    ev("localStorage.setItem('dsh.lang','en'); location.reload(); 1")
    time.sleep(6)
    pids = adb("shell", "pidof", PKG).split()
    if pids:
        adb("forward", f"tcp:{PORT}", f"localabstract:webview_devtools_remote_{pids[0]}")
        c = Cdp(port=PORT)
        ev = c.eval
    for _ in range(10):
        if "undefined" not in str(ev("typeof window.__dsh")):
            break
        time.sleep(2)
    for m in ("chat", "sessions", "jobs", "files", "settings"):
        ev(f"(() => {{ const t=document.querySelector('.tab[data-tab=\"{m}\"]'); if(t) t.click(); }})()")
        time.sleep(0.8)
    en = jval(ev(I18N_SCAN))
    print(f"  英文模式：lang={en['lang']} 残留中文={len(en['bad'])}")
    for x in en["bad"][:24]:
        print("    -", x)
    if en["lang"] != "en":
        fails.append(f"语言没切过去（lang={en['lang']}）—— 这条样本无效")
    elif en["bad"]:
        fails.append(f"英文模式下仍有 {len(en['bad'])} 处静态文案是中文")
    ev("localStorage.setItem('dsh.lang','zh'); location.reload(); 1")
    time.sleep(5)
    print("\n" + ("英文模式没有中文残留" if not fails else "未通过：\n  - " + "\n  - ".join(fails)))
    return 0 if not fails else 1


DARK_SCAN = r"""(() => {
  const gcs = getComputedStyle(document.body);
  const stage = document.querySelector('.stage');
  return JSON.stringify({
    attr: document.documentElement.dataset.theme || '',
    body: gcs.backgroundColor,
    color: gcs.color,
    stage: stage ? getComputedStyle(stage).backgroundColor : '',
    label: getComputedStyle(document.documentElement).getPropertyValue('--label').trim(),
    meta: (document.querySelector('meta[name=\"theme-color\"]') || {}).content || '',
    sw: !!(document.querySelector('#swDark') || {}).checked,
  });
})()"""


def cmd_dark(c):
    """深色开关：切换要真的改到颜色，不能只改一个布尔。

    此前只有 `surface-material` 守材质令牌，没人验证「拨开开关屏幕上真的变黑了」。
    基线必须自己按出来：设备可能停在深色（第一轮就这么误报过 —— 拿深色当浅色基线，
    于是「浅色→深色」比出个「颜色没变」）。
    """
    ev = c.eval
    setup(ev)
    fails = []
    ev("(() => { const t=document.querySelector('.tab[data-tab=\"settings\"]'); if(t) t.click(); })()")
    time.sleep(1)
    origin = jval(ev(DARK_SCAN))       # 只记录、只还原，不当基线用
    print(f"  进场时：attr={origin['attr']} body={origin['body']}")

    def set_dark(on):
        ev("(() => { const sw=document.querySelector('#swDark'); sw.checked=%s;"
           "sw.dispatchEvent(new Event('change', {bubbles:true})); return 1; })()" % ("true" if on else "false"))
        time.sleep(1.4)
        return jval(ev(DARK_SCAN))

    light = set_dark(False)
    dark = set_dark(True)
    print(f"  浅色：{light}")
    print(f"  深色：{dark}")
    if light["attr"] != "light":
        fails.append(f"拨到浅色却没落回 light（attr={light['attr']}）")
    if dark["attr"] != "dark":
        fails.append(f"data-theme 没切过去（{dark['attr']}）")
    if not dark["sw"] or light["sw"]:
        fails.append("开关状态没跟着走（拨了却对不上）")
    for k in ("body", "color", "stage", "label"):
        if light[k] == dark[k]:
            fails.append(f"{k} 没变（浅色 {light[k]} / 深色 {dark[k]} 一样）")
    if dark["meta"] != "#000000" or light["meta"] != "#F2F2F7":
        fails.append(f"系统栏颜色没跟着换（浅 {light['meta']} / 深 {dark['meta']}）")
    # 切回来：不能只黑不白
    back = set_dark(False)
    if back["attr"] != "light" or back["body"] != light["body"] or back["stage"] != light["stage"]:
        fails.append(f"切回浅色没还原（attr={back['attr']} body={back['body']} vs {light['body']}）")
    if origin["attr"] == "dark":       # 还原设备进场时的选择
        set_dark(True)
    print("\n" + ("深色开关：颜色、开关、系统栏一起动" if not fails
                  else "未通过：\n  - " + "\n  - ".join(fails)))
    return 0 if not fails else 1


ENTRY_SEL = "button, a, [data-act], [data-open], [data-ask], [data-sheet], input, [role=\"button\"]"

# 只点「按下去该有动静」的东西。容器（滚动区/列表/分组）不是入口，纯文字值也不是。
ENTRY_SKIP_KEYS = (
    "del", "unpair", "clear", "install", "stop", "send", "submit", "fork", "confirm",
    "logout", "retry", "exit", "run", "connect", "probe", "import", "upload", "pick",
    "image", "camera", "record", "kill", "share", "login", "reset", "backup", "restore",
)

ENTRY_LISTS = r"""(() => {
  const n = (s) => { const e = document.querySelector(s); return e ? e.children.length : -1; };
  return [n('#messages'), n('#recentList'), n('#pinnedList'), n('#wsList'), n('#filesList'), n('#jobsToday')].join(',');
})()"""

ENTRY_SNAP = r"""(() => {
  const vis = (e) => { const cs = getComputedStyle(e); return cs.display !== 'none' && cs.visibility !== 'hidden'; };
  let str = '';
  for (const e of document.body.querySelectorAll('*')) {
    if (!vis(e)) continue;
    str += e.tagName + '.' + String(e.className || '') + '#' + (e.id || '') + '|' +
           (e.getAttribute('aria-pressed') || '') + (e.getAttribute('aria-expanded') || '') + '|' +
           (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24) + ';';
  }
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const checked = {};
  for (const i of document.querySelectorAll('input[type=checkbox]')) if (i.id) checked[i.id] = i.checked;
  const t = document.querySelector('#toast');
  return JSON.stringify({
    h: h,
    lists: %s,
    calls: (window.__calls || []).length,
    checked: JSON.stringify(checked),
    focus: (document.activeElement || {}).id || '',
    toast: t && t.classList.contains('is-on') ? String(t.textContent || '').slice(0, 30) : '',
    over: (() => {
      const bd = document.getElementById('sheetBackdrop');
      const ve = document.getElementById('voiceVeil');
      const po = document.getElementById('pcPopover');
      const dr = document.getElementById('drawer');
      return ['bd', bd && getComputedStyle(bd).display !== 'none' ? 1 : 0,
              've', ve && ve.classList.contains('is-on') ? 1 : 0,
              'po', po ? 1 : 0,
              'dr', dr && getComputedStyle(dr).display !== 'none' ? 1 : 0].join('');
    })(),
    scr: (document.querySelector('.screen.is-active') || {}).id || '',
  });
})()""" % ENTRY_LISTS

ENTRY_HELPERS = r"""(() => {
  const SEL = %s;
  const SKIP = %s;
  const ZH = ["删除", "清空", "解除", "退出", "发送", "提交", "触发", "终止", "登录",
              "连接", "导入", "上传", "拍照", "录音", "更新", "重试", "分享", "还原",
              "恢复", "备份", "重置", "分叉", "配对", "打开"];
  const STATE_CLS = /(^|\s)(is-on|is-open|is-off|is-stacked|active|checked)(\s|$)/g;
  const camel = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ').toLowerCase().split(' ').filter(Boolean);
  const keyNames = (e) => [...e.attributes].map((a) => a.name).filter((n) => n.startsWith('data-')).join(' ');
  const sigOf = (e, scr) => e.id || (scr + '|' + e.tagName + '.' +
    String(e.className || '').replace(STATE_CLS, ' ').trim().split(' ')[0] +
    '|' + keyNames(e).split(' ').sort().join('+'));
  const onish = (e) => (e.classList && e.classList.contains('is-on')) ||
    e.getAttribute('aria-pressed') === 'true' || (e.tagName === 'INPUT' && e.type === 'checkbox' && e.checked);
  const collect = (scr) => {
    const scope = document.querySelector('#screen-' + scr) || document.body;
    const nodes = {}; const skip = {};
    for (const e of scope.querySelectorAll(SEL)) {
      const r = e.getBoundingClientRect();
      if (r.width < 6 || r.height < 6 || e.disabled) continue;
      const sig = sigOf(e, scr);
      const label = (e.textContent || e.value || '').replace(/\s+/g, ' ').trim().slice(0, 14);
      // 副作用/要出网的入口交给各自的专项探针；开关类要点当前没亮的那一个，
      // 点已经亮着的「全部」本来就该没动静，那条样本不算证据。
      const toks = camel(sig).concat(camel(keyNames(e)));
      if (SKIP.some((k) => toks.indexOf(k) >= 0) || ZH.some((z) => label.indexOf(z) >= 0)) { skip[sig] = 1; continue; }
      const cur = nodes[sig];
      if (!cur || (onish(cur) && !onish(e))) nodes[sig] = e;
    }
    return {
      nodes,
      sigs: Object.keys(nodes).map((s) => scr + '/' + s),
      skipped: Object.keys(skip).map((s) => scr + '/' + s),
    };
  };
  window.__dshEntry = {
    collect,
    click: (full) => {
      const i = full.indexOf('/');
      const n = collect(full.slice(0, i)).nodes[full.slice(i + 1)];
      if (!n) return 'GONE';
      // 输入框自己点不出反应是这条测量环境的限制（窗口没激活，默认聚焦不生效），
      // 所以显式 focus：能不能拿到焦点才是这条入口真正要保证的事。
      if (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA') n.focus();
      n.click();
      return 'ok|' + (n.id || '');
    },
  };
  return 1;
})()""" % (json.dumps(ENTRY_SEL), json.dumps(ENTRY_SKIP_KEYS))

# 桥调用打点：刷新、连接这类动作的正常结果就是「内容没变」（列表本来就是最新的）。
# 不看一眼有没有真的发起调用，这类入口永远会被报成死入口。
ENTRY_HOOK = r"""(() => {
  const N = window.Native;
  if (!N || N.__dshHooked) return 0;
  window.__calls = [];
  const names = new Set();
  for (const k in N) names.add(k);
  try { Object.getOwnPropertyNames(N).forEach((k) => names.add(k)); } catch (_) {}
  try { Object.getPrototypeOf(N) && Object.getOwnPropertyNames(Object.getPrototypeOf(N)).forEach((k) => names.add(k)); } catch (_) {}
  let n = 0;
  for (const k of names) {
    if (typeof N[k] !== 'function' || k === 'toString') continue;
    const f = N[k];
    try {
      N[k] = function () { window.__calls.push(k); return f.apply(N, arguments); };
      n++;
    } catch (_) {}          // 注入对象不可写：打点拿不到，靠采样抓瞬时状态
  }
  N.__dshHooked = 1;
  return n;
})()"""

ENTRY_CLICK = "(() => window.__dshEntry.click(%s))()"

ENTRY_CLEAN = r"""(() => {
  const bd = document.getElementById('sheetBackdrop');
  if (bd && getComputedStyle(bd).display !== 'none') bd.click();
  const veil = document.getElementById('voiceVeil');
  if (veil && veil.classList.contains('is-on')) { const c = document.getElementById('voiceCancel'); if (c) c.click(); }
  const pop = document.getElementById('pcPopover');
  if (pop) document.body.click();          // 走 capture 的外部点击，别把节点直接摘掉（收尾监听还在）
  const inp = document.getElementById('filesSearch');
  if (inp && inp.value) { inp.value = ''; inp.dispatchEvent(new Event('input', { bubbles: true })); }
  return 1;
})()"""


def cmd_entry(c):
    """每个入口按下去要么有动静，要么说清为什么没有 —— 不许「点了什么都没发生」。

    补的是点击冒烟自己错过的那类误判：只比 innerHTML 长度时，切 class / aria / :checked /
    展开收起这些「等长变化」全被当成死入口（v2 报了 26 个，精测后只有 1 个是真问题）。
    这里把可见结构、列表条数、勾选状态、焦点、toast、浮层开合一起比，才算证据。
    每次点完采两跳（120ms / 470ms）：加载态一闪而过也算动了 —— 宁可少报一个死入口，
    也不把「刷完还是那一列表」当成按钮坏了。

    跳过名单里的入口（删除 / 触发任务 / 连网 / 选图…）是有副作用或要出网的，
    由各自的专项探针负责；这里把跳过清单打出来，覆盖口径不含糊。
    """
    ev = c.eval
    setup(ev)
    ev("(() => { window.__errs = []; window.addEventListener('error', (e) => "
       "window.__errs.push(String(e.message || (e.error && e.error.message) || '').slice(0, 120))); return 1; })()")
    ev(ENTRY_HELPERS)
    hooked = ev(ENTRY_HOOK)
    print(f"  桥调用打点：包住 {hooked} 个 Native 方法")
    theme0 = ev("(() => (document.documentElement.dataset.theme || ''))()")
    plan, skipped = [], []
    for scr in ("chat", "sessions", "jobs", "files", "settings"):
        ev(f"(() => {{ const t=document.querySelector('.tab[data-tab=\"{scr}\"]'); if(t) t.click(); return 1; }})()")
        time.sleep(1.2)
        d = jval(ev("(() => { const c = window.__dshEntry.collect(%s);"
                    "return JSON.stringify({ sigs: c.sigs, skipped: c.skipped }); })()" % json.dumps(scr)))
        plan += d["sigs"]
        skipped += d["skipped"]
    skipped = list(dict.fromkeys(skipped))
    print(f"  待点 {len(plan)} 个入口（签名去重、开关取当前没亮的那个），按副作用跳过 {len(skipped)} 类")

    dead, errored = [], []
    for full in plan:
        scr = full.split("/")[0]
        ev(f"(() => {{ const t=document.querySelector('.tab[data-tab=\"{scr}\"]'); if(t) t.click(); return 1; }})()")
        time.sleep(0.35)
        before = jval(ev(ENTRY_SNAP))
        errs0 = int(ev("(() => window.__errs.length)()"))
        got = str(ev(ENTRY_CLICK % json.dumps(full)))
        if got == "GONE":
            dead.append(f"{full}（该屏找不到这个控件）")
            continue
        clicked_id = got.split("|", 1)[1]
        # 采两次：刷新这类动作的动静是「先进加载态、再回到同一份列表」，
        # 只在一跳之后看会正好错过。
        time.sleep(0.12)
        mid = jval(ev(ENTRY_SNAP))
        time.sleep(0.35)
        after = jval(ev(ENTRY_SNAP))
        errs1 = int(ev("(() => window.__errs.length)()"))
        if errs1 > errs0:
            errored.append(f"{full} → {ev('(() => window.__errs.slice(-1)[0])()')}")
        changed = [k for k in ("h", "lists", "calls", "checked", "focus", "toast", "over", "scr")
                   if after[k] != before[k] or mid[k] != before[k]]
        # 点到输入框：拿到自己的焦点就是它该有的反应（前面那条入口可能已经把它聚焦了）
        if not changed and clicked_id and after["focus"] == clicked_id:
            changed = ["focus"]
        if not changed:
            dead.append(f"{full}（焦点 {(after['focus'] or '没动')}，toast「{after['toast'] or '无'}」）")
        ev(ENTRY_CLEAN)
        time.sleep(0.2)

    # 主题可能被遍历开关拨过：还原到进场时的样子
    now = ev("(() => (document.documentElement.dataset.theme || ''))()")
    if now != theme0:
        ev("(() => { const sw=document.getElementById('swDark'); if (sw) {"
           f"sw.checked={'true' if theme0 == 'dark' else 'false'};"
           "sw.dispatchEvent(new Event('change', {bubbles:true})); } return 1; })()")
        time.sleep(1)

    print(f"  跳过（有副作用/要出网，交给专项探针）：{', '.join(skipped[:18])}{' …' if len(skipped) > 18 else ''}")
    if errored:
        print(f"\n① 点了抛错：{len(errored)}")
        for x in errored[:12]:
            print("    ✗", x)
    if dead:
        print(f"\n② 点了毫无动静：{len(dead)}")
        for x in dead[:24]:
            print("    ✗", x)
    ok = not errored and not dead
    print("\n" + (f"入口体检：{len(plan)} 个按下去都有动静或原因" if ok
                  else f"未通过：抛错 {len(errored)} 个、无动静 {len(dead)} 个"))
    return 0 if ok else 1


SESS_STATE = r"""(() => {
  const id = %s;
  const L = window.__dsh.LocalDB;
  const s = L.get(id) || null;
  const rows = document.querySelectorAll('.sess-row[data-sess-row="' + id + '"]').length;
  const inPinned = !!document.querySelector('#pinnedList [data-open="' + id + '"]');
  const inWs = [...document.querySelectorAll('#wsList .ws-group')].filter(
    (g) => g.contains(document.querySelector('[data-open="' + id + '"]')))
    .map((g) => (g.querySelector('[data-ws-toggle]') || {}).dataset || {}).map((d) => d.wsToggle || '');
  const title = (document.querySelector('[data-open="' + id + '"] .s-title') || {}).textContent || '';
  return JSON.stringify({ has: !!s, pin: !!(s && s.pin), ws: (s && s.ws) || '', title: String(title).trim(),
                         rows: rows, inPinned: inPinned, groups: inWs });
})()"""


def sess_state(ev, sid):
    return jval(ev(SESS_STATE % json.dumps(sid)))


def click_sel(ev, sel):
    return ev("(() => { const e = document.querySelector(%s); if (!e) return 'GONE'; e.click(); return 'ok'; })()"
              % json.dumps(sel))


def cmd_sessops(c):
    """会话行左滑出来的四个动作（置顶 / 移动 / 重命名 / 删除）与「从这里分叉」。

    这一片此前零覆盖：`sessions` 只量列表的渲染形状，四动作和分叉只有静态守卫证明
    「每个 data-* 都有归属」，没人按下去看结果对不对。删除尤其要紧 —— 误触就丢整个会话。
    """
    ev = c.eval
    setup(ev)
    fails = []
    ids = jval(ev("""(() => {
      const L = window.__dsh.LocalDB, st = window.__dsh.state;
      st.workspace = "wsOpsA";
      const a = L.create("动作探针 甲").id;
      const b = L.create("动作探针 乙").id;
      st.workspace = "wsOpsA";
      return JSON.stringify([a, b]);
    })()"""))
    a, b = ids
    ev("document.querySelector('.tab[data-tab=\"sessions\"]').click(); 1")
    time.sleep(1.2)

    # ① 置顶 / 取消置顶
    if click_sel(ev, f'[data-sess-pin="{a}"]') != "ok":
        fails.append("找不到置顶按钮（左滑露出的那一排）")
    else:
        time.sleep(0.8)
        d = sess_state(ev, a)
        print(f"  置顶后：pin={d['pin']} 列表行={d['rows']} 置顶区={d['inPinned']}")
        if not d["pin"]:
            fails.append("点了置顶，数据里还是没置上")
        if not d["inPinned"]:
            fails.append("置了顶却没出现在「置顶」区")
        if d["rows"] != 1:
            fails.append(f"置顶后屏幕上这一场有 {d['rows']} 行（应该只在置顶区出现一次）")
        click_sel(ev, f'[data-sess-pin="{a}"]')
        time.sleep(0.8)
        if sess_state(ev, a)["pin"]:
            fails.append("再点一次没能取消置顶")

    # ② 重命名：sheet 里的输入框 + 保存
    if click_sel(ev, f'[data-sess-rename="{a}"]') != "ok":
        fails.append("点不到重命名按钮")
    else:
        time.sleep(0.7)
        sheeted = ev("(() => !!document.querySelector('#renameInput') ? '有' : '无')()")
        if sheeted != "有":
            fails.append("点了重命名却没弹出改名面板")
        else:
            ev("""(() => { const i = document.querySelector('#renameInput');
              const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
              set.call(i, '改名成功的探针甲'); i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()""")
            click_sel(ev, "#btnDoRename")
            time.sleep(0.8)
            d = sess_state(ev, a)
            print(f"  重命名后：库里/屏上标题=「{d['title']}」")
            if "改名成功" not in d["title"]:
                fails.append(f"点了保存，列表标题还是「{d['title']}」")

    # ③ 移动到另一个工作区
    ev("(() => { window.__dsh.state.workspace = 'wsOpsA'; return 1; })()")
    click_sel(ev, f'[data-sess-move="{a}"]')
    time.sleep(0.7)
    opts = ev("(() => [...document.querySelectorAll('#sheetBody [data-sess-ws]')].map(e => e.dataset.sessWs).join(','))()")
    if not opts or "GONE" in str(opts):
        fails.append("点了移动却没列出工作区")
    else:
        print(f"  移动面板给出：{opts}")
        target = next((w for w in str(opts).split(",") if w and w != "wsOpsA"), "")
        if not target:
            fails.append("面板里没有别的工作区可移（样本无效）")
        else:
            click_sel(ev, f'[data-sess-ws="{target}"]')
            time.sleep(0.9)
            d = sess_state(ev, a)
            print(f"  移动后：ws={d['ws']} 落在分组={d['groups']}")
            if target not in str(d["ws"]):
                fails.append(f"点了移到 {target}，库里还写着 {d['ws']}")

    # ④ 删除：必须先问一句，取消不能真删，确认才删
    click_sel(ev, f'[data-sess-del="{b}"]')
    time.sleep(0.7)
    asked = ev("(() => !!document.querySelector('#btnConfirmDelSession') ? '有' : '无')()")
    if asked != "有":
        fails.append("点了删除没有二次确认（直接动手是最坏的一种「点了没反应」的反面）")
    else:
        click_sel(ev, "#sheetBody [data-close]")
        time.sleep(0.6)
        if not sess_state(ev, b)["has"]:
            fails.append("只点了取消，会话却被删了")
        click_sel(ev, f'[data-sess-del="{b}"]')
        time.sleep(0.6)
        click_sel(ev, "#btnConfirmDelSession")
        time.sleep(0.9)
        d = sess_state(ev, b)
        print(f"  确认后：库里={d['has']} 屏幕行={d['rows']}")
        if d["has"] or d["rows"]:
            fails.append("点了确认删除，会话还在（或屏上还留着行）")

    # ⑤ 从这里分叉：长按一条消息 → 面板 → 分叉，新会话要带着分叉点之前的内容
    ev("document.querySelector('.tab[data-tab=\"chat\"]').click(); 1")
    time.sleep(0.8)
    click_sel(ev, f'[data-open="{a}"]')
    time.sleep(1.2)
    send_and_wait(ev, "只回一句：甲")
    before = int(ev("(() => window.__dsh.LocalDB.all().length)()"))
    lp = ev("""(() => {
      const el = document.querySelector('#messages .msg[data-uid]') || document.querySelector('#messages .msg');
      if (!el) return '没有可长按的消息';
      const r = el.getBoundingClientRect();
      const o = { bubbles: true, clientX: r.left + 12, clientY: r.top + Math.min(12, r.height / 2), pointerId: 1 };
      el.dispatchEvent(new PointerEvent('pointerdown', o));
      return 'ok';
    })()""")
    time.sleep(0.9)
    has_fork = ev("(() => !!document.querySelector('[data-msg-fork]') ? '有' : '无')()")
    print(f"  长按 {lp} → 分叉按钮={has_fork}")
    if has_fork != "有":
        fails.append(f"长按消息没有给出「从这里分叉」（长按结果={lp}）")
    else:
        click_sel(ev, "[data-msg-fork]")
        time.sleep(1.6)
        after = int(ev("(() => window.__dsh.LocalDB.all().length)()"))
        onchat = ev("(() => (document.querySelector('.screen.is-active') || {}).id || '')()")
        nodes = int(ev("(() => document.querySelectorAll('#messages > *').length)()") or 0)
        print(f"  分叉后：库里 {before} → {after}，当前屏={onchat}，屏上节点={nodes}")
        if after != before + 1:
            fails.append("点了分叉，没有新会话落库")
        if onchat != "screen-chat":
            fails.append(f"分叉后没停在对话页（停在 {onchat}）")
        if nodes < 1:
            fails.append("分叉出来的会话是空的 —— 分叉点之前的内容没带走")

    for sid in ids:
        ev("(() => { try { window.__dsh.LocalDB.remove('%s'); } catch (_) {} return 1; })()" % sid)
    print("\n" + ("会话四动作与分叉：按下去都办成了，删除先问一句" if not fails
                  else "未通过：\n  - " + "\n  - ".join(fails)))
    return 0 if not fails else 1



TEAM_VIEW_STATE = r"""JSON.stringify((() => {
  const st = window.__dsh.state;
  const t = st.team || null;
  const rows = [...document.querySelectorAll('.tm-member')].map((e) => {
    const open = e.querySelector('[data-team-open]');
    return {
      dot: ((e.querySelector('.tm-dot') || {}).className || ''),
      kill: !!e.querySelector('[data-team-kill]'),
      open: open ? (open.dataset.teamOpen || '') : '',
      rowIsOpen: e.dataset.teamOpen || '',
    };
  });
  return {
    members: (((t && t.members) || [])).map((m) => ({
      name: m.target, status: m.status, phase: m.phase || '', role: m.role || '',
      err: String(m.error || '').slice(0, 70),
      owns: (((t && t.tasks) || []).filter((x) => x.owner === m.target).map((x) => x.id + ':' + x.status)),
    })),
    tasks: (((t && t.tasks) || []).map((x) => x.id + ':' + x.status + ':' + (x.owner || '-'))),
    rows: rows,
    logRows: document.querySelectorAll('[data-team-log]').length,
    tv: st.teamView ? (st.teamView.parent + '#' + st.teamView.name) : null,
    sheet: (() => { const b = document.getElementById('sheetBackdrop');
      return !!(b && getComputedStyle(b).display !== 'none'); })(),
  };
})())"""


def team_view(ev):
    return jval(ev(TEAM_VIEW_STATE))


JOBS_VIEW = r"""JSON.stringify([...document.querySelectorAll('#jobsToday [data-job]')].map(e=>({
  key:e.dataset.job, kind:String(e.dataset.job).split(':')[0], state:e.dataset.state,
  title:((e.querySelector('.job-title-wrap b')||{}).textContent||'').trim().slice(0,20)})))"""

JOB_SHEET = r"""JSON.stringify((()=>{
  const sh=document.querySelector('#sheet'), b=document.querySelector('#sheetBody');
  const txt=b?(b.textContent||'').replace(/\s+/g,' ').trim():'';
  const btn=(sel)=>[...(b?b.querySelectorAll(sel):[])].map(x=>x.textContent.trim());
  // 「面板开着」的判据是 #sheet.is-on（closeSheet 走的是摘类，不是 hidden）：
  // 用 hidden 判会把上一次留下的旧文案当成新弹的面板（负对照里就这么误报过）
  return {open: !!(sh && sh.classList.contains('is-on') && txt),
          text: txt.slice(0,140),
          del: [...(b?b.querySelectorAll('[data-job-del]'):[])].map(x=>x.textContent.trim()+'→'+x.dataset.jobDel),
          cancel: btn('[data-mission-cancel]'), rerun: btn('[data-mission-rerun]'),
          board: btn('[data-team-board]'),
          toast: (document.querySelector('#toast')||{}).textContent||''};
})())"""


def cmd_jobs(c):
    """任务页：每一行都要能打开操作面板，该删的都要删得掉，删不动的要说清为什么。

    这条是补一整块没网的洞：列表早就改成「Mission 账本优先」，操作面板却还在
    两份旧注册表里 find —— `jobsList()` 是进程内存（重启就空），`team:` 干脆没有分支，
    找不到就什么都不弹。实测 12 行（2 个团队任务 + 10 个后台任务）**全打不开**，
    用户报的正是「任务界面的任务无法删除」。
    """
    ev = c.eval
    setup(ev)
    fails = []
    # 本机纯记录只存 localStorage，是「删除任务」最干净的一档，先灌两条
    ev("""(() => {
      const L = JSON.parse(localStorage.getItem('dsh.local.jobs') || '[]');
      const mk = (t) => ({ id: 'jprobe' + Math.random().toString(36).slice(2, 8), title: t,
                           note: '探针造的本地记录', status: 'pending', createdAt: Date.now() });
      localStorage.setItem('dsh.local.jobs', JSON.stringify([mk('探针本地记录 A'), mk('探针本地记录 B')].concat(L)));
      return 1; })()""")
    ev("document.querySelector('.tab[data-tab=\"jobs\"]').click(); 1")
    time.sleep(1.6)

    def rows():
        return jval(ev(JOBS_VIEW))

    def open_sheet(key):
        ev("(() => { if (window.DSHHandleBack) window.DSHHandleBack(); return 1; })()")
        time.sleep(0.5)
        ev("""(() => { const e=document.querySelector('#jobsToday [data-job="%s"]');
          if (e) e.click(); return 1; })()""" % key)
        time.sleep(0.9)
        return jval(ev(JOB_SHEET))

    def click_del():
        """点面板里那个删除按钮，返回 (删后的 toast, 行数)。"""
        n0 = len(rows())
        ev("(() => { const b=document.querySelector('#sheetBody [data-job-del]'); if(b) b.click(); return 1; })()")
        time.sleep(0.7)
        toast = (jval(ev(JOB_SHEET)) or {}).get("toast") or ""
        time.sleep(0.9)
        return toast, n0, len(rows())

    r = rows()
    kinds = {}
    for x in r:
        kinds.setdefault(x["kind"], []).append(x)
    print("  行 %d 条，来源分布：%s" % (len(r), {k: len(v) for k, v in kinds.items()}))
    if not r:
        print("任务页一行都没有，样本无效")
        return 1

    # ① 每一种来源都要「点开面板 → 当场验按钮 → 该删的删掉」，一步一停（不留旧面板干扰下一步）
    for kind in sorted(kinds):
        first = kinds[kind][0]
        s = open_sheet(first["key"])
        print("   [%s] %s → 面板=%s%s" % (kind, first["key"], s["open"],
              "" if not s["open"] else " 按钮=" + str(s["del"] or s["board"] or s["cancel"] or s["rerun"] or [])))
        if not s["open"]:
            fails.append(f"「{kind}」这一行点下去什么都不弹（{first['key']}）—— 面板还在从旧注册表找行")
            continue
        if kind == "team":
            # 团队任务是任务板的投影：这里删不掉（下一次同步又加回来），所以不该给删除按钮，
            # 而该给一个明确的去处
            if s["del"]:
                fails.append(f"团队任务给了一个删不掉的删除按钮（投影不该能删权威）：{s['del']}")
            if not s["board"]:
                fails.append(f"团队任务面板里没有「打开团队面板」：{s['text'][:60]}")
                continue
            ev("(() => { const b=document.querySelector('#sheetBody [data-team-board]'); if(b) b.click(); return 1; })()")
            time.sleep(1.6)
            t = jval(ev("""JSON.stringify((()=>{const b=document.querySelector('#sheetBody');
              const txt=b?(b.textContent||''):' ';
              return {members:document.querySelectorAll('#sheetBody .tm-member').length,
                      looksTeam:/队友|Lead|任务板|成员/.test(txt)};})())"""))
            print("      跳团队面板：成员行=%s 文案像团队面板=%s" % (t["members"], t["looksTeam"]))
            if not t["members"]:
                fails.append("点「打开团队面板」没落到团队面板（成员行 0 条）")
        elif kind in ("job", "local", "schedule"):
            if not s["del"] and kind == "job" and s["cancel"]:
                print("      （这一条还在跑，只给「终止」，不给删除 —— 符合预期）")
                continue
            if not s["del"]:
                fails.append(f"{kind} 这一行没有删除按钮：{s['text'][:70]}")
                continue
            toast, n0, n1 = click_del()
            print("      删除：%d → %d 行（toast「%s」）" % (n0, n1, toast[:26]))
            if n1 >= n0:
                fails.append(f"{kind} 按了删除，行数没变（{n0} → {n1}）")
            if "已删除" not in toast:
                fails.append(f"{kind} 删掉了却没说清（toast「{toast[:24]}」）")

    # ② 至少要覆盖到「账本历史」与「本地记录」两档，否则这条探针等于没跑
    for need in ("job", "local"):
        if need not in kinds:
            print(f"   ⚠ 这一轮没有 {need}: 行，那一档没测到（样本形状问题，不算产品红）")

    print("\n" + ("任务页：每行都打得开、该删的都删得掉" if not fails
                  else "未通过：\n  - " + "\n  - ".join(fails)))
    return 0 if not fails else 1


LEDGER = r"""JSON.stringify((()=>{
  let led=[]; try { led = JSON.parse(window.DSHNativeKernel.missionList("")||"[]"); } catch (e) { return {err:String(e)}; }
  let wakes=-1; try { wakes = JSON.parse(window.DSHNativeKernel.wakeList("")||"[]").length; } catch (e) {}
  return {rows: led.map(m=>({id:m.id, sid:String(m.sessionId||'')})), wakes: wakes,
          jobsRows: document.querySelectorAll('#jobsToday [data-job]').length};
})())"""


def ledger(ev):
    return jval(ev(LEDGER))


def cmd_orphans(c):
    """删会话要级联到内核；级联之前攒下的孤儿由开机清扫收掉。

    用户报的形状：「团队任务所属的会话我都删除了，为什么任务界面还显示这个任务」。
    实测（改前）：会话索引 12 条 / 账本 8 行指向已不存在的会话 / 内核日志文件 1025 个 /
    唤醒 18 条 —— 删除只做了页面侧 `LocalDB.remove`，内核四样一样没清。
    """
    ev = c.eval
    setup(ev)
    pr = jval(prune_local(ev, keep=0))
    print("  清场：库里 %s → %s" % (pr["before"], pr["after"]))
    fails = []

    def sweep(ids):
        return jval(ev("""JSON.stringify(((p) => {
          try { return JSON.parse(window.DSHNativeKernel.sessionSweep(JSON.stringify(p))); }
          catch (e) { return { err: String(e) }; }
        })(%s))""" % json.dumps({"loaded": True, "ids": ids})))

    def bridge_err(d):
        """CDP 求值抛错时回的是 {"error":"Uncaught",...}，清扫自己失败回 {"err":...} ——
        两种都必须算红，不然「没测到」会被当成「测过了」（这条判据就是为防这个）。"""
        return bool(d) and ("error" in d or "err" in d)

    # 先扫一次当基线：级联落地前攒下的孤儿在这一刻被收干净，之后的计数才只说明「这一场」
    base = sweep([])
    print("  基线清扫（loaded=true、活会话 0 场）：", json.dumps(base, ensure_ascii=False)[:160])
    if bridge_err(base):
        print("   ⚠ 基线清扫没跑成，后面的计数不可信")
        return 1

    # ① 真建一场会话（走发送路径，内核会落日志文件），再给它挂一条定时任务
    send_and_wait(ev, "级联取证 说一句话")
    sid = jval(ev("JSON.stringify(__dsh.state.sessionId || '')"))
    if not sid:
        print("没建出会话，样本无效")
        return 1
    created = jval(ev("""JSON.stringify(((sid) => {
      try { return JSON.parse(window.DSHNativeKernel.scheduleCreate(JSON.stringify({
        title: '级联取证定时', prompt: '跑一下', rule: { every_seconds: 3600 }, sessionId: sid }))); }
      catch (e) { return { err: String(e) }; }
    })(%s))""" % json.dumps(sid)))
    print("  建好：会话 %s / 定时任务返回 %s" % (sid[-6:], json.dumps(created, ensure_ascii=False)[:160]))
    if bridge_err(created):
        print("定时任务建不出来（桥或参数问题），样本无效")
        return 1
    time.sleep(1.2)
    d = ledger(ev)
    mine = [r["id"] for r in d["rows"] if r["sid"] == sid]
    ev("document.querySelector('.tab[data-tab=\"jobs\"]').click(); 1")
    time.sleep(1.4)
    d2 = ledger(ev)
    print("  挂上后：账本属于这场的行=%s 任务页行=%s 唤醒=%s" % (mine, d2["jobsRows"], d2["wakes"]))
    if not mine:
        print("定时任务没落到这场会话上，样本无效")
        return 1
    if d2["jobsRows"] < 1:
        fails.append("账本有行，任务页却没列出来（这一档样本没成立）")

    # ② 从会话页删除这一场（滑动 → 确认），级联应当把账本行与唤醒一起带走
    ev("document.querySelector('.tab[data-tab=\"sessions\"]').click(); 1")
    time.sleep(1.2)
    click_sel(ev, '[data-sess-del="%s"]' % sid)
    time.sleep(0.8)
    click_sel(ev, "#btnConfirmDelSession")
    time.sleep(1.4)
    d3 = ledger(ev)
    left = [r["id"] for r in d3["rows"] if r["sid"] == sid]
    print("  删除后：账本还剩这场的行=%s 唤醒=%s" % (left, d3["wakes"]))
    if left:
        fails.append(f"删了会话，账本还留着这场的 {len(left)} 行（任务页会继续显示）：{left}")
    in_idx = jval(ev("""JSON.stringify((window.__dsh.LocalDB.all()||[]).some(s => s.id === %s))""" % json.dumps(sid)))
    if in_idx:
        fails.append("页面侧索引里这一场还在")

    # ③ 清扫必须说「没东西可扫」—— 证明 purge 真的把日志文件删了，而不是只清了内存
    sweep2 = sweep(["keep-me"])
    print("  删完再清扫：", json.dumps(sweep2, ensure_ascii=False)[:160])
    if bridge_err(sweep2):
        fails.append(f"清扫接口没应答：{json.dumps(sweep2, ensure_ascii=False)[:160]}")
    elif sweep2.get("files"):
        fails.append(f"级联说删干净了，清扫却又找到 {sweep2['files']} 个孤儿日志 —— purge 没删文件")
    elif sweep2.get("missions"):
        fails.append(f"清扫却又找到 {sweep2['missions']} 条孤儿账本行 —— purge 没清账本")

    # ④ 级联落地前攒下的孤儿：只能靠开机清扫收掉（造一条不属于任何会话的账本行，重载页面）
    ghost = jval(ev("""JSON.stringify((()=>{
      try { return JSON.parse(window.DSHNativeKernel.scheduleCreate(JSON.stringify({
        title: '幽灵定时', prompt: '没人了', rule: { every_seconds: 3600 }, sessionId: 'sid-that-is-gone' }))); }
      catch (e) { return { err: String(e) }; }
    })())"""))
    time.sleep(1.0)
    before = [r["id"] for r in ledger(ev)["rows"] if r["sid"] == "sid-that-is-gone"]
    print("  造孤儿：", before)
    ev("location.reload(); 1")
    time.sleep(6)
    for _ in range(8):
        if jval(ev("JSON.stringify(!!(window.__dsh && window.__dsh.state))")):
            break
        time.sleep(2)
    after = [r["id"] for r in ledger(ev)["rows"] if r["sid"] == "sid-that-is-gone"]
    print("  重载后（开机清扫跑过）：", after, "任务页行=", ledger(ev)["jobsRows"])
    if not before:
        print("   ⚠ 孤儿没造出来，这条没测到")
    elif after:
        fails.append("开机清扫没把孤儿账本行收掉（重载后还在）")

    print("\n" + ("删会话级联到位：账本、唤醒、日志一起走，孤儿有兜底" if not fails
                  else "未通过：\n  - " + "\n  - ".join(fails)))
    return 0 if not fails else 1


def cmd_teamops(c):
    """团队面照抄桌面后的四条行为，逐条按下去看形状（这些以前一条都没有常驻网）。

    ① 中断队友：桌面的 interrupt 不写 durable 终态、不改 phase、不清 inbox、不释放任务 owner，
       UI 只看到 running→inactive（roster.ts:187-198）。把它写成 failed 就是把活人打死。
    ② 队友进度 = 打开它自己那场会话（mount.ts:38-50），不再多一层只读日志面板。
    ③ 并发命中 = failed 成员 + error 文本 + 面板红点（manager.ts:744 → activation.ts:24-31
       → roster.ts:264-281），不是「安静地挂着等待唤醒」。
    ④ 成员正文只有一条通道：agentTeam 全量投影帧，快照带 live/liveSeq；没有第二条增量事件。
    """
    ev = c.eval
    setup(ev)
    fails = []

    # ---- ① + ②：一个慢队友，先中断，再从面板行进它的会话 ----
    send(ev, "RELOADDEMO 起一个慢队友")
    got = None
    for _ in range(40):
        time.sleep(1)
        got = team_view(ev)
        if any(m["status"] == "running" and m["role"] != "lead" for m in got["members"]):
            break
    mates = [m for m in (got or {"members": []})["members"] if m["role"] != "lead"]
    if not any(m["status"] == "running" for m in mates):
        print(f"  前置没到位（没有在跑的队友，只有 Lead）：{mates}")
        return 1
    running = [m for m in mates if m["status"] == "running"][0]
    owns_before = running["owns"]
    print(f"  在跑的队友：{running['name']} status={running['status']} phase={running['phase']} 认领={owns_before}")

    ev("document.querySelector('#btnTeam').click(); 1")
    time.sleep(1.4)
    panel = team_view(ev)
    row = next((r for r in panel["rows"] if r["kill"]), None)
    if not row:
        fails.append(f"面板里没有「中断这一轮」按钮（running 的成员该有）：{panel['rows']}")
    if not any(r["open"] for r in panel["rows"]):
        fails.append("面板里没有进入队友会话的按钮")
    if not all(r["rowIsOpen"] for r in panel["rows"] if r["open"]):
        fails.append("成员行本身没有 data-team-open（点行不等于进入会话）")

    if row:
        ev("(() => { const b=document.querySelector('[data-team-kill=\"%s\"]');"
           "if (!b) return 'no-btn'; b.click(); return 'ok'; })()" % running["name"])
        time.sleep(2.5)
        after = team_view(ev)
        m = next((x for x in after["members"] if x["name"] == running["name"]), None)
        print(f"  中断后：{m}")
        if m is None:
            fails.append("中断后 roster 里查不到这个成员")
        else:
            if m["phase"] == "failed":
                fails.append("桌面的 interrupt 不写终态：成员被写成 failed 就是把活人打死")
            if m["status"] == "running":
                fails.append("中断后仍显示 running（Lead 与面板都以为它在干活）")
            if m["err"]:
                fails.append(f"中断不该留下 error 文本：{m['err']}")
            if sorted(m["owns"]) != sorted(owns_before):
                fails.append(f"中断不该释放它认领的任务：{owns_before} → {m['owns']}")

    ev("(() => { const r=document.querySelector('.tm-member[data-team-open]'); if(r) r.click(); return 1; })()")
    time.sleep(2.5)
    into = team_view(ev)
    print(f"  点成员行 → teamView={into['tv']} sheet={into['sheet']}")
    if not into["tv"] or not str(into["tv"]).endswith("#" + running["name"]):
        fails.append(f"点成员行没有进入它的会话（teamView={into['tv']}，期望 #{running['name']}）")
    if into.get("logRows"):
        fails.append(f"页面上还有 {into['logRows']} 个 data-team-log 中间层入口（桌面的进度就是它自己的会话）")
    ev("(() => { const x=document.querySelector('#teamViewExit'); if(x) x.click(); return 1; })()")
    time.sleep(1.4)

    # ---- ③ 并发命中：上限压到 1，再派两个 ----
    sid = jval(ev("JSON.stringify(window.__dsh.state.sessionId || 'draft')"))
    ev("(() => { DSHNativeTeam.teamSetLimits(%s, JSON.stringify({ maxConcurrent: 1 })); return 1; })()"
       % json.dumps(sid))
    time.sleep(1.2)
    lim = ev("(() => JSON.parse(DSHNativeTeam.teamLimits(%s)).limits.maxConcurrent)()" % json.dumps(sid))
    print(f"  并行上限设成：{lim}")
    if lim != 1:
        fails.append(f"上限没写进去（读到 {lim}）—— ③ 这条样本无效")
    # 换一场干净会话再派：夹具按「这一场里有几条 tool 消息」分档，
    # 接着上一轮发就跳过了 spawn（第一次跑就是这么假失败的）
    ev("document.querySelector('#btnNewSession').click(); 1")
    time.sleep(1.2)
    send(ev, "TEAMFULL 一次派两个队友")
    hit = None
    for _ in range(55):
        time.sleep(1)
        hit = team_view(ev)
        mates = [m for m in hit["members"] if m["role"] != "lead"]
        if any(m["phase"] == "failed" or m["status"] == "failed" for m in mates):
            break
    members = [m for m in (hit or {}).get("members", []) if m["role"] != "lead"]
    failed = [m for m in members if m["phase"] == "failed" or m["status"] == "failed"]
    print("  两个队友的落点：" + str([(m["name"], m["status"], m["phase"], m["err"][:44]) for m in members]))
    if len(members) < 2:
        fails.append(f"这一场只见到 {len(members)} 个队友，夹具没派出两个（样本无效）")
    if not failed:
        fails.append("抢不到槽位的成员没有落成 failed（桌面是 failed 成员 + error 文本 + 面板红点）")
    else:
        if not failed[0]["err"]:
            fails.append("failed 成员没有 error 文本，Lead 与用户都不知道它为什么没动")
    ev("(() => { DSHNativeTeam.teamSetLimits(%s, JSON.stringify({ maxConcurrent: 8 })); return 1; })()"
       % json.dumps(sid))

    # ---- ④ 快照带 live/liveSeq，且没有第二条增量通道 ----
    live = jval(ev("""JSON.stringify((() => {
      const t = window.__dsh.state.team || {};
      const ms = (t.members) || [];
      return { src: (window.__teamDelta === undefined) ? 'clean' : 'has-counter',
               fields: ms.filter((m) => m.live !== undefined && m.liveSeq !== undefined).length,
               total: ms.length };
    })())"""))
    print(f"  增量通道残留：{live['src']}；快照带 live/liveSeq 的成员：{live['fields']}/{live['total']}")
    if live["src"] != "clean":
        fails.append("页面还留着 team_delta 的计数痕迹")
    if live["total"] and live["fields"] != live["total"]:
        fails.append("快照没带 live/liveSeq —— 删了增量通道又没给快照这条来源，成员视图就没有实时观感")

    print("\n" + ("团队操作照抄到位：中断不写终态、进度即会话、并发命中看得见" if not fails
                  else "未通过：\n  - " + "\n  - ".join(fails)))
    return 0 if not fails else 1


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "scroll"
    apk = sys.argv[2] if len(sys.argv) > 2 else None
    c = boot(apk)
    sys.exit({"scroll": cmd_scroll, "sealed": cmd_sealed, "rect": cmd_rect,
              "tail": cmd_tail, "badge": cmd_badge, "team": cmd_team, "resume": cmd_resume,
              "kill": cmd_kill, "stop": cmd_stop, "memberexit": cmd_memberexit,
              "tools": cmd_tools, "member": cmd_member, "sessions": cmd_sessions,
              "i18n": cmd_i18n, "dark": cmd_dark, "entry": cmd_entry,
              "sessops": cmd_sessops, "teamops": cmd_teamops, "jobs": cmd_jobs, "orphans": cmd_orphans}[cmd](c))
