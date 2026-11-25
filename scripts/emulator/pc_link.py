#!/usr/bin/env python3
"""电脑会话（真链路）动态回归：连上本机 harness → 跑真实电脑回合 → 量交付卡与滚动。

  state  只读：当前是否在电脑会话、线程节点构成
  pair   走手机端真实 UI 配对（需要桌面 harness 在跑）
         pair relay（默认）：填「中继地址 + 房间号 + 口令」，模拟器只够得着 10.0.2.2，就靠这条
         pair tunnel：用 ~/.dsh/mobile-link.json 的现隧道地址拼配对串 —— 手机必须能出网，真机才跑得动
  run    在电脑会话里发一条消息并逐帧采样：封条节点 0 重写 + 距底不甩开
  image  只发一张图（不带文字）：手机内压缩 → 中继 → 电脑事件里出现 image part
  card   重进电脑会话（历史重放），核对交付卡的 DOM 顺序与线程顺序一致

前置：桌面 harness 在跑（插件 dsh-mobile-link 已注册、联动已开）；模拟器已启动。
用法：
  python scripts/emulator/pc_link.py state
  python scripts/emulator/pc_link.py pair [relay|tunnel]
  python scripts/emulator/pc_link.py run ["提示词"]
  python scripts/emulator/pc_link.py image
  python scripts/emulator/pc_link.py card
"""
import json
import os
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
PKG = "ai.deepseek.harness.mobile"
PLUGIN = Path(os.environ.get("DSH_PLUGIN_DIR", r"D:\1\dsh-mobile-link"))
DEFAULT_PROMPT = "请在当前工作区新建文件 notes/pc-anchor-check.md，写三行内容，然后 present 交付给我"


def adb(*args, timeout=600):
    return subprocess.run([ADB, "-s", SERIAL, *args], capture_output=True, text=True, timeout=timeout).stdout.strip()


def connect():
    pid = adb("shell", "pidof", PKG)
    if not pid:
        sys.exit("App 没在跑：先启动模拟器与 App")
    adb("forward", f"tcp:{PORT}", f"localabstract:webview_devtools_remote_{pid.split()[0]}")
    c = Cdp(port=PORT)
    for _ in range(20):
        try:
            if json.loads(c.eval("JSON.stringify(!!window.__dsh)")):
                return c
        except Exception:
            pass
        time.sleep(1.5)
    sys.exit("WebView 没准备好")


def cmd_state(c):
    ev = c.eval
    print(ev("""JSON.stringify({
      screen: __dsh.state.screen,
      pc: __dsh.state.pcSession || null,
      thread: __dsh.thread.length,
      tailSync: { r: __dsh.renderTailFrom, n: __dsh.thread.length },
      kinds: __dsh.thread.slice(-8).map(n => n.kind),
      cards: __dsh.thread.filter(n => n.kind === 'deliverable').length,
    })"""))
    sync = json.loads(ev("JSON.stringify({r: __dsh.renderTailFrom, n: __dsh.thread.length})"))
    return 0 if sync["r"] == sync["n"] else 1


def in_pc_session(ev):
    return json.loads(ev("JSON.stringify(!!__dsh.state.pcSession)"))


def pair_relay(ev, port):
    """内置中继（同一局域网）那条路：填三项 + 点「连接」，成功会自动进电脑会话。

    为什么默认走这里：模拟器的 SLIRP 只把 10.0.2.2 映射到宿主，DNS 与出网全封
    （实测：隧道配对串贴进去 10 秒后报「解析不了这个地址，检查手机网络」）。
    隧道/直连那条要用真机测，不在这里假装跑过。
    """
    st = json.loads(Path(os.environ.get("DSH_LINK_STATE", str(Path.home() / ".dsh" / "mobile-link.json"))).read_text(encoding="utf-8"))
    relay = "http://10.0.2.2:%d" % port

    def setv(sel, val):
        ev(
            """(() => { const i = document.querySelector(%s); if (!i) return 0;
              const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
              set.call(i, %s); i.dispatchEvent(new Event('input', {bubbles:true})); return 1; })()"""
            % (json.dumps(sel), json.dumps(val))
        )

    setv("#linkRelay", relay)
    setv("#linkRoom", st["room"])
    setv("#linkKey", st["key"])
    ev("document.querySelector('#linkConnectBtn').click(); 1")
    for _ in range(40):
        time.sleep(1.5)
        if in_pc_session(ev):
            print("已连上（中继）：", ev("JSON.stringify(__dsh.state.pcSession)"))
            return 0
    print("没连上（看手机端诊断：点「探测」能看到 TCP / 应答 哪一步）")
    return 1


def pair_tunnel(ev):
    """跨网：用 ~/.dsh/mobile-link.json 的现隧道地址拼配对串（手机要能出网，真机才测得动）"""
    out = subprocess.run(
        ["node", "--input-type=module", "-e",
         "import{readFileSync}from'node:fs';import{homedir,hostname}from'node:os';"
         "import{pairingString}from'./rpc.mjs';"
         "const s=JSON.parse(readFileSync(homedir()+'/.dsh/mobile-link.json','utf8'));"
         "console.log(pairingString({mode:'tunnel',url:s.crossTunnelUrl,key:s.key,host:hostname()}))"],
        capture_output=True, text=True, timeout=60, cwd=str(PLUGIN))
    pairing = out.stdout.strip()
    if not pairing.startswith("dshlink1:"):
        print("配对串生成失败（桌面 harness 没跑？）：" + out.stderr[-300:])
        return 1
    ev("""(() => {
      const i = document.querySelector('#linkPairing');
      if (!i) return 0;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(i, %s);
      i.dispatchEvent(new Event('input', {bubbles:true}));
      document.querySelector('#linkPasteBtn').click();
      return 1;
    })()""" % json.dumps(pairing))
    for _ in range(40):
        time.sleep(1.5)
        if in_pc_session(ev):
            print("已连上（隧道）：", ev("JSON.stringify(__dsh.state.pcSession)"))
            return 0
    print("没连上（看手机端诊断）")
    return 1


def cmd_pair(c):
    ev = c.eval
    # 已经连着就不用再配一次（重复配对会把电脑会话清空重放）
    if in_pc_session(ev):
        print("已在电脑会话里：", ev("JSON.stringify(__dsh.state.pcSession)"))
        return 0
    ev("document.querySelector('#rowHost').click(); 1")
    time.sleep(1.5)
    # 配对还在（重装/重启都不掉），面板直接给会话列表：那就只补一步「进去」
    if not json.loads(ev("JSON.stringify(!!document.querySelector('#linkRelay'))")):
        got = enter_first_pc(c)
        print("用已存配对进入电脑会话：", got)
        return 0 if (got or {}).get("thread") else 1
    mode = sys.argv[2] if len(sys.argv) > 2 else "relay"
    st = json.loads(Path(os.environ.get("DSH_LINK_STATE", str(Path.home() / ".dsh" / "mobile-link.json"))).read_text(encoding="utf-8"))
    if mode == "tunnel":
        return pair_tunnel(ev)
    port = int(str(st.get("relay", "")).rsplit(":", 1)[-1])
    return pair_relay(ev, port)


def enter_first_pc(c):
    ev = c.eval
    ev("document.querySelector('#pcList .session-item').click(); 1")
    time.sleep(8)
    return json.loads(ev("JSON.stringify({pc: __dsh.state.pcSession && __dsh.state.pcSession.title, thread: __dsh.thread.length})"))


def cmd_run(c):
    ev = c.eval
    prompt = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_PROMPT
    if not json.loads(ev("JSON.stringify(!!__dsh.state.pcSession)")):
        enter_first_pc(c)
    ev("""(() => {
      const sc = document.querySelector('#chatScroll'), box = document.querySelector('#messages');
      const raw = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
      window.__hit = {removed: 0, attrs: 0, tailPin: 0, text: 0, child: 0, followFlip: 0, thinkTailFrames: 0, thinkTailPx: 0, names: [], attrNames: []};
      [...box.children].forEach((el, i) => { el.dataset.sealed = 's' + i; });
      const sealed = new Set([...box.children]);
      const owner = (n) => {
        let e = n && (n.nodeType === 1 ? n : n.parentElement);
        while (e && e !== box) { if (sealed.has(e)) return e; e = e.parentElement; }
        return null;
      };
      // class 只在 is-tail 这一个标记上进出 = 钉尾的让位，不是内容重写
      const tailOnly = (a, b) => {
        const A = new Set(String(a || '').split(' ').filter(Boolean));
        const B = new Set(String(b || '').split(' ').filter(Boolean));
        const diff = (x, y) => [...x].filter(k => !y.has(k));
        const d = [...diff(A, B), ...diff(B, A)];
        return d.length === 1 && d[0] === 'is-tail';
      };
      window.__obs = new MutationObserver((ms) => {
        for (const m of ms) {
          if (m.type === 'childList') {
            for (const n of m.removedNodes) { const o = owner(n.nodeType === 1 ? n : m.target);
              if (o) { window.__hit.removed++; if (window.__hit.names.length < 40) window.__hit.names.push('rm:' + o.dataset.sealed); } }
            for (const n of m.addedNodes) { if (!owner(m.target)) continue; window.__hit.child++; }
          } else if (m.type === 'attributes') {
            if (!owner(m.target) || m.attributeName === 'data-sealed') continue;
            // 钉尾只该翻 is-tail 这一个 class：那是「按设计的一次增量写」，不动内容也不重建节点。
            // 上一轮的思考行在新一轮开始时让位，必然挨这一下 —— 除它之外任何属性写都算重写。
            if (m.attributeName === 'class' && tailOnly(m.oldValue, m.target.className)) {
              window.__hit.tailPin++; continue;
            }
            window.__hit.attrs++;
            if (window.__hit.attrNames.length < 20) window.__hit.attrNames.push(m.attributeName + '@' + (m.target.className || m.target.nodeName));
          } else if (owner(m.target)) window.__hit.text++;
        }
      });
      window.__obs.observe(box, {childList: true, subtree: true, attributes: true, attributeOldValue: true, characterData: true});
      window.__r = [];
      let lastFollow = __dsh.follow, lastTop = raw.get.call(sc);
      // scrollHeight 一帧里掉几百 px 时，光是「谁变矮了」就得说清楚：
      // 每 20 帧存一张「直接子元素高度表」（带 uid / 封条号），落差超阈值就和上一张比。
      const heights = () => [...box.children].map(el =>
        (el.dataset.uid || el.dataset.sealed || 'x') + '|' + (el.dataset.sealed || 'new') + ':' + Math.round(el.getBoundingClientRect().height));
      let lastH = heights(), lastSH = sc.scrollHeight, n = 0;
      window.__shDiff = [];
      const tick = () => {
        const top = raw.get.call(sc);
        if (__dsh.follow !== lastFollow) { lastFollow = __dsh.follow; window.__hit.followFlip++; }
        if (Math.abs(top - lastTop) > 40) lastTop = top;
        if (++n % 20 === 0) {
          // 思考行的钉尾有没有真的跟着输出走：滚动距离与「被钉住的帧数」
          const tp = box.querySelector('.is-think .pg-sum.is-tail, .pc-think-brief.is-tail');
          if (tp) {
            window.__hit.thinkTailFrames++;
            window.__hit.thinkTailPx = Math.max(window.__hit.thinkTailPx, Math.round(tp.scrollLeft));
          }
          if (Math.abs(sc.scrollHeight - lastSH) > 200) {
            const now = heights();
            const key = (x) => x.slice(0, x.indexOf(':')), val = (x) => +x.slice(x.indexOf(':') + 1);
            const prev = new Map(lastH.map(x => [key(x), val(x)]));
            const d = now.filter(x => Math.abs((prev.get(key(x)) ?? 0) - val(x)) > 80);
            if (d.length) window.__shDiff.push([lastSH, sc.scrollHeight, d.slice(0, 8)]);
            lastH = now;
          }
          lastSH = sc.scrollHeight;
        }
        window.__r.push([Math.round(sc.scrollHeight - top - sc.clientHeight), Math.round(top), sc.scrollHeight, __dsh.follow ? 1 : 0]);
        if (window.__r.length < 20000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return JSON.stringify({sealed: sealed.size});
    })()""")
    ev("""(() => {
      const i = document.querySelector('#input');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(i, %s);
      i.dispatchEvent(new Event('input', {bubbles:true}));
      document.querySelector('#btnSend').click();
      return 1;
    })()""" % json.dumps(prompt))
    prev, still, grew = json.loads(ev("JSON.stringify(__dsh.thread.length)")), 0, False
    base = prev
    for _ in range(240):
        time.sleep(1.5)
        now = json.loads(ev("JSON.stringify(__dsh.thread.length)"))
        # 节点数不变不代表回合结束：正文还在往最后一个节点里灌。以「电脑说没在跑」为准。
        running = json.loads(ev("JSON.stringify(__dsh.Link ? !!__dsh.Link.running : false)"))
        grew = grew or now > base
        still = 0 if now != prev else still + 1
        prev = now
        if grew and not running and still >= 4:
            break
    time.sleep(3)
    res = json.loads(ev("JSON.stringify(window.__hit)"))
    r = json.loads(ev("JSON.stringify(window.__r)"))
    ev("window.__obs.disconnect(); 1")
    kinds = json.loads(ev("JSON.stringify(__dsh.thread.map(n=>n.kind))"))
    gaps = [x[0] for x in r]
    # 回退分两种，只有前一种才是用户说的「滚回历史」：
    #   硬回退 = 内容没变矮，滚动条却往回走（跟随中丢底）
    #   软回退 = 上面某段塌了（思考组收起/等待行让位），scrollTop 被动跟着变小，底部仍贴着
    def backjumps(pred):
        return sorted(
            [(round(r[i - 1][1] - r[i][1]), i, r[i - 1][1], r[i][1], r[i - 1][2], r[i][2])
             for i in range(1, len(r)) if r[i - 1][1] - r[i][1] > 8 and pred(r[i - 1], r[i])],
            reverse=True,
        )[:4]
    hard = backjumps(lambda a, b: b[2] >= a[2] - 2)
    soft = backjumps(lambda a, b: b[2] < a[2] - 2)
    Path(os.environ.get("DSH_RUN_FRAMES", str(ROOT.parent / "tmp" / "pc_run_frames.json"))).write_text(
        json.dumps(r), encoding="utf-8"
    )
    print("节点种类（末 10）：", kinds[-10:])
    print("有交付卡：", kinds.count("deliverable"), "| 卡贴尾：", kinds[-1] == "deliverable")
    print("封条命中：", {k: v for k, v in res.items() if not isinstance(v, list)}, res.get("names", [])[:5])
    if res.get("attrNames"):
        print("非钉尾的属性写：", res.get("attrNames")[:6])
    print(f"帧 {len(r)}；最大距底 {max(gaps or [0])}px；末帧 {gaps[-1] if gaps else '-'}；follow 翻转 {res.get('followFlip', 0)}")
    print("硬回退（内容没变矮却丢底）：", hard)
    print("软回退（上面某段塌了，底部照旧贴着）：", soft)
    if soft:
        for row in json.loads(ev("JSON.stringify(window.__shDiff)"))[:6]:
            print("  高度突变：", row[0], "→", row[1], "px；变的那几条：", row[2])
    ok = not any(res.get(k, 0) for k in ("removed", "attrs", "text", "child")) and not hard
    print("判定：", "PASS" if ok else "FAIL", "（封条 0 重写 + 无硬回退）")
    return 0 if ok else 1


def session_events(session_id):
    """电脑端会话事件文件（追加写的多帧 zstd），交给 zdump 读成 JSONL 统计。"""
    for p in (Path.home() / ".dsh" / "sessions").glob(f"*/{session_id}/session.v4.jsonl.zstd"):
        out = subprocess.run(
            ["node", str(ROOT / "scripts" / "emulator" / "zdump.mjs"), str(p), "--stats"],
            capture_output=True, text=True, timeout=120,
        )
        if out.returncode == 0:
            try:
                return str(p), json.loads(out.stdout)
            except Exception:
                return str(p), {"error": out.stdout[-200:] + out.stderr[-200:]}
    return "", {}


def cmd_image(c):
    """电脑会话发图（只发图、不带文字）：选图 → 手机内压缩 → 中继 → 电脑收到 image part。"""
    ev = c.eval
    if not in_pc_session(ev):
        enter_first_pc(c)
    # 选图这一步在页面里做：造一张 1200×800 的随机噪声 PNG 塞进 #pcImageInput 再触发 change ——
    # 和用户点选走的是同一个 handler（DOM.setFileInputFiles 在这个 WebView 上不落文件，踩过）
    made = ev("""(() => {
      const cv = document.createElement('canvas');
      cv.width = 1200; cv.height = 800;
      const ctx = cv.getContext('2d');
      const img = ctx.createImageData(cv.width, cv.height);
      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = Math.random() * 255;
        img.data[i + 1] = Math.random() * 255;
        img.data[i + 2] = Math.random() * 255;
        img.data[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      const b64 = cv.toDataURL('image/png').split(',')[1];
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], 'noise.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const el = document.querySelector('#pcImageInput');
      el.files = dt.files;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return JSON.stringify({ bytes: arr.length, files: el.files.length });
    })()""")
    print("测试图（页面内生成）：", made)
    atts = []
    for _ in range(40):
        time.sleep(1)
        atts = json.loads(ev("JSON.stringify(__dsh.state.attachments.map(a=>({name:a.name,type:a.type,size:a.size,b64:(a.dataUrl||'').length})))"))
        if atts:
            break
    print("托盘：", atts)
    fails = []
    if not atts:
        print("没进托盘：压缩或 change 没跑起来")
        return 1
    a = atts[0]
    if a["type"] != "image/jpeg":
        fails.append(f"压缩后的类型不对：{a['type']}")
    if a["b64"] > 900_000:
        fails.append(f"base64 超预算：{a['b64']}")
    can = json.loads(ev("JSON.stringify(!!document.querySelector('#btnSend') && !document.querySelector('#btnSend').disabled)"))
    if not can:
        fails.append("只有图、没有文字时发送键仍是灰的")
    print(f"压缩：{json.loads(made)['bytes']} → {a['size']} 字节；base64 {a['b64']}；发送键可点 {can}")

    before = json.loads(ev("JSON.stringify(__dsh.thread.length)"))
    ev("document.querySelector('#btnSend').click(); 1")
    prev, still = before, 0
    for _ in range(240):
        time.sleep(1.5)
        now = json.loads(ev("JSON.stringify(__dsh.thread.length)"))
        running = json.loads(ev("JSON.stringify(__dsh.Link ? !!__dsh.Link.running : false)"))
        still = 0 if now != prev else still + 1
        prev = now
        if now > before and not running and still >= 3:
            break
    time.sleep(2)
    left = json.loads(ev("JSON.stringify(__dsh.state.attachments.length)"))
    mine = json.loads(ev("""JSON.stringify((() => {
      const n = __dsh.thread.filter(x => x.kind === 'user').slice(-1)[0] || {};
      return { text: n.text || '', atts: (n.atts || []).map(a => a.name) };
    })())"""))
    print("发送后：附件清空 =", left == 0, "| 乐观气泡：", mine)
    if left:
        fails.append("发出去之后附件没清空")
    if not mine.get("atts"):
        fails.append("乐观气泡里没有图（用户看不到自己发的那张）")

    sid = json.loads(ev("JSON.stringify(__dsh.state.pcSession.id)"))
    path, stats = session_events(sid)
    print("电脑端事件：", path or "没找到", {k: stats.get(k) for k in ("lines", "images")})
    if "image/jpeg" not in (stats.get("images") or []):
        fails.append("电脑会话事件里没有 image/jpeg（图片没到电脑）")

    print("\n" + ("图片链路全部通过" if not fails else f"未通过：{fails}"))
    return 0 if not fails else 1


def cmd_card(c):
    ev = c.eval
    if not in_pc_session(ev):
        enter_first_pc(c)
    time.sleep(2)
    res = json.loads(ev("""JSON.stringify((() => {
      const box = document.querySelector('#messages');
      const dom = [...box.children].filter(e => e.classList.contains('msg'));
      const seq = dom.map(el => el.querySelector('.deliver-card') ? 'D' : el.querySelector('.bubble-user') ? 'U' : '.');
      const posDom = [], cnt = {u: 0};
      seq.forEach(s => { if (s === 'U') cnt.u++; if (s === 'D') posDom.push(cnt.u); });
      const posTh = []; let u = 0;
      __dsh.thread.forEach(n => { if (n.kind === 'user') u++; if (n.kind === 'deliverable') posTh.push(u); });
      return {cards: posTh.length, posDom, posTh, same: JSON.stringify(posDom) === JSON.stringify(posTh),
              tailSync: {r: __dsh.renderTailFrom, n: __dsh.thread.length}};
    })())"""))
    print("交付卡：", res)
    return 0 if res["same"] and res["tailSync"]["r"] == res["tailSync"]["n"] else 1


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "state"
    c = connect()
    sys.exit({"state": cmd_state, "pair": cmd_pair, "run": cmd_run, "card": cmd_card, "image": cmd_image}[cmd](c))
