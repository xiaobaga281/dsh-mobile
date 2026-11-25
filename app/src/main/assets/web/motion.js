/* =========================================================
   DSH Mobile — motion runtime (v1)
   弹簧 / 跟手 / 可打断 的统一驱动层。无依赖，加载于 app.js 之前。

   API（window.Motion）：
     Motion.presets                     预设表 {press,sheet,gentle,bouncy,exit,settle}
     Motion.reduced()                   是否应禁用位移类动效（系统设置 / ?motion=reduce）
     Motion.legacy                      是否处于旧行为模式（?motion=legacy）
     Motion.springTo(el, props, opts)   弹簧驱动 transform/opacity/width/height
        props: {x,y,scale,scaleX,scaleY,skew,opacity,width,height}
        opts:  {preset, velocity:{prop:valuePerSecond}, max(ms), onUpdate, onComplete}
        return {el, stop(), retarget(props, velocity)}
     Motion.set(el, props)              立即写入（拖动跟手用，不做补间）
     Motion.stop(el)                    停掉该元素上的弹簧并立刻收尾到目标
     Motion.kill(el)                    无声打断（不写终值、不触发 onComplete）
     Motion.clear(el)                   清掉本运行时写过的内联样式
     Motion.drag(el, opts)              手势跟随（1:1 + 橡皮筋 + 速度采样）
        opts: {axis:'x'|'y'|'xy', threshold, rubber:{min,max,factor}|{x:{...},y:{...}},
               filter(e), onDown, onStart, onMove, onEnd, onCancel}
        onMove/onEnd 收到 {dx,dy,vx,vy}（v 单位 px/ms，取最近 ~80ms）
        return {detach()}
     Motion.hud(on)                     调试 HUD（?motionDebug=1 自动开）
     Motion.stats                       帧统计（{frames,long,worst,fps,springs}）

   约定：
   - 只有本运行时会写 transform/opacity/width/height；CSS 不得给这些属性留过渡
     （见 .motion/CONTRACT.md），否则会与逐帧写入互相打架。
   - 同一元素再次 springTo 会「从当前值 + 当前速度」接管，不重置。
   - 异常一律降级为直接落位，绝不让 UI 卡在半路。
   ========================================================= */
(() => {
  "use strict";

  const PRESETS = {
    press:   { k: 420, c: 34.0, m: 1 },
    pressIn: { k: 900, c: 48.0, m: 1 },
    sheet:   { k: 240, c: 27.0, m: 1 },
    gentle:  { k: 170, c: 24.0, m: 1 },
    bouncy:  { k: 320, c: 24.0, m: 1 },
    exit:    { k: 520, c: 42.0, m: 1 },
    settle:  { k: 300, c: 34.64, m: 1 },
  };

  const QS = (() => { try { return new URLSearchParams(location.search); } catch (_) { return new URLSearchParams(); } })();
  const MODE = (QS.get("motion") || "").toLowerCase();
  const mq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const legacy = MODE === "legacy";
  let forceReduce = MODE === "reduce";

  const active = new Set();
  const mem = new WeakMap();
  const stats = { frames: 0, long: 0, worst: 0, fps: 0, springs: 0, last: 0 };
  let raf = 0, lastTs = 0, hudEl = null, fpsFrames = 0, fpsT = 0;

  const now = () => performance.now();
  const isThenable = (v) => v && typeof v.then === "function";
  const num = (v, d) => (typeof v === "number" && isFinite(v) ? v : d);

  function reduced() { return forceReduce || legacy || !!(mq && mq.matches); }

  /* ---------------- 读取当前视觉状态 ---------------- */
  function read(el) {
    let cs = null;
    try { cs = getComputedStyle(el); } catch (_) {}
    const t = cs ? cs.transform : "none";
    let x = 0, y = 0, sx = 1, sy = 1;
    if (t && t !== "none") {
      const m2 = t.match(/^matrix\(([^)]+)\)$/);
      const m3 = t.match(/^matrix3d\(([^)]+)\)$/);
      if (m2) {
        const n = m2[1].split(",").map(Number);
        x = n[4] || 0; y = n[5] || 0;
        sx = Math.hypot(n[0], n[1]) || 1;
        sy = Math.hypot(n[2], n[3]) || 1;
      } else if (m3) {
        const n = m3[1].split(",").map(Number);
        x = n[12] || 0; y = n[13] || 0;
        sx = Math.hypot(n[0], n[1]) || 1;
        sy = Math.hypot(n[4], n[5]) || 1;
      }
    }
    return {
      x, y, sx, sy,
      skew: 0,
      o: cs ? num(parseFloat(cs.opacity), 1) : 1,
      width: el.offsetWidth || 0,
      height: el.offsetHeight || 0,
    };
  }

  function norm(props) {
    const p = {};
    for (const k in props) {
      const v = props[k];
      if (!isFinite(v) && typeof v !== "number") continue;
      const n = +v;
      if (k === "scale") { p.sx = n; p.sy = n; }
      else if (k === "scaleX") p.sx = n;
      else if (k === "scaleY") p.sy = n;
      else if (k === "opacity") p.o = Math.max(0, Math.min(1, n));
      else if (["x", "y", "skew", "width", "height"].includes(k)) p[k] = n;
      else p[k] = n;
    }
    return p;
  }

  function memOf(el) {
    let m = mem.get(el);
    if (!m) { m = { cur: read(el), vel: {} }; mem.set(el, m); }
    return m;
  }

  function write(el, cur, keys) {
    const hasT = keys.has("x") || keys.has("y") || keys.has("skew") || keys.has("sx") || keys.has("sy");
    if (hasT) {
      const parts = [];
      const x = cur.x || 0, y = cur.y || 0;
      if (x || y) parts.push(`translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0)`);
      if (cur.skew) parts.push(`skewX(${cur.skew.toFixed(2)}deg)`);
      const sx = cur.sx == null ? 1 : cur.sx, sy = cur.sy == null ? 1 : cur.sy;
      if (sx !== 1 || sy !== 1) parts.push(`scale(${sx.toFixed(4)},${sy.toFixed(4)})`);
      try { el.style.transform = parts.length ? parts.join(" ") : ""; } catch (_) {}
    }
    try {
      if (keys.has("o") && cur.o != null) el.style.opacity = String(Math.max(0, Math.min(1, cur.o)).toFixed(3));
      if (keys.has("width") && cur.width != null) el.style.width = cur.width.toFixed(2) + "px";
      if (keys.has("height") && cur.height != null) el.style.height = cur.height.toFixed(2) + "px";
    } catch (_) {}
  }

  function targetOf(a, k) { return a.to[k] == null ? a.cur[k] : a.to[k]; }

  function settleTol(k) {
    if (k === "sx" || k === "sy" || k === "o") return 0.0015;
    return 0.3;
  }

  function emit(a) {
    try {
      if (!a.onUpdate) return;
      a.onUpdate(a.el ? a.cur : a.cur.v);
    } catch (_) {}
  }

  function finish(a) {
    for (const k of a.keys) { a.cur[k] = targetOf(a, k); a.vel[k] = 0; }
    if (a.el) { write(a.el, a.cur, a.keys); mem.set(a.el, { cur: Object.assign({}, a.cur), vel: {} }); }
    emit(a);
    try { a.onComplete && a.onComplete(); } catch (_) {}
  }

  function ensureTicker() {
    if (raf) return;
    lastTs = 0;
    raf = requestAnimationFrame(tick);
  }

  /* ---------------- 解析解弹簧（rc.124） ----------------
     之前是半隐式欧拉 + 240Hz 子步（60Hz 时每属性每帧积分 4 次），且每帧
     Object.assign 两份快照写 mem —— 并发 8 根弹簧时每秒近千次小对象分配，
     GC 停顿直接表现为切换途中规律的 33/50ms 坏帧。
     阻尼弹簧有闭式解：x(t)/v(t) 一次算出，无积分、无子步、无累积漂移；
     retarget 时用「当前值 + 当前速度」重取初值，打断语义与积分版完全一致。
     预设参数（k 170~520 / c 24~42 / m 1）全部欠阻尼（c² < 4k），统一走
     欠阻尼解并 ζ 钳到 <1（过阻尼观感等价于 ζ≈1，不值得再写一个分支）。 */
  function springConst(preset) {
    const m = Math.max(1e-4, preset.m);
    const w0 = Math.sqrt(Math.max(0, preset.k) / m);
    const zeta = Math.min(0.999, preset.c / (2 * Math.sqrt(Math.max(1e-9, preset.k * m))));
    return { w0, zeta, wd: w0 * Math.sqrt(1 - zeta * zeta) };
  }
  function solveSpring(sc, x0, v0, xt, t) {
    const e = Math.exp(-sc.zeta * sc.w0 * t);
    const A = x0 - xt;
    const B = (v0 + sc.zeta * sc.w0 * A) / sc.wd;
    const c = Math.cos(sc.wd * t), s = Math.sin(sc.wd * t);
    return {
      x: xt + e * (A * c + B * s),
      v: e * ((-sc.zeta * sc.w0 * A + B * sc.wd) * c + (-sc.zeta * sc.w0 * B - A * sc.wd) * s),
    };
  }

  function tick(ts) {
    raf = 0;
    const gap = lastTs ? ts - lastTs : 16.7;
    lastTs = ts;
    // 帧统计：只统计动画期间的帧间隔
    if (stats.last) {
      const d = ts - stats.last;
      if (d > 0) {
        stats.frames++;
        if (d > 25) stats.long++;
        if (d > stats.worst) stats.worst = d;
      }
    }
    stats.last = ts;
    fpsFrames++;
    if (!fpsT) fpsT = ts;
    if (ts - fpsT >= 500) { stats.fps = Math.round(fpsFrames * 1000 / (ts - fpsT)); fpsFrames = 0; fpsT = ts; }

    // 慢帧时弹簧只推进最多 32ms：宁可动画整体拉长，也不要跳帧式前跳（观感更顺）
    const dtMs = Math.max(1, Math.min(32, gap));

    for (const a of Array.from(active)) {
      try {
        a.t += dtMs;
        const ts2 = a.t / 1000;
        for (const k of a.keys) {
          const s = solveSpring(a.sc, a.x0[k], a.v0[k], targetOf(a, k), ts2);
          a.cur[k] = s.x;
          a.vel[k] = s.v;
        }
        let done = a.t >= a.max;
        if (!done) {
          done = true;
          for (const k of a.keys) {
            if (Math.abs(a.cur[k] - targetOf(a, k)) > settleTol(k) || Math.abs(a.vel[k]) > 12) { done = false; break; }
          }
        }
        if (done) { active.delete(a); finish(a); }
        else {
          if (a.el) {
            // 尾段微优化：位移小于可感知阈值就不重写样式（finish 会写精确终值）
            let moved = false;
            const lw = a.live;
            for (const k of a.keys) {
              if (Math.abs(a.cur[k] - (lw.last[k] == null ? 1e9 : lw.last[k])) > (k === "o" || k === "sx" || k === "sy" ? 0.0012 : 0.05)) { moved = true; break; }
            }
            if (moved) {
              write(a.el, a.cur, a.keys);
              for (const k of a.keys) lw.last[k] = a.cur[k];
              mem.set(a.el, lw);          // 复用同一对象，零每帧分配
            }
          }
          emit(a);
        }
      } catch (err) {
        active.delete(a);
        try { finish(a); } catch (_) {}
      }
    }
    stats.springs = active.size;
    updateHud();
    if (active.size) raf = requestAnimationFrame(tick);
    else { stats.last = 0; lastTs = 0; }
  }

  function mergeInto(el, props, opts) {
    for (const a of active) {
      if (a.el !== el) continue;
      const to = norm(props);
      for (const k in to) {
        if (!a.keys.has(k)) {
          a.keys.add(k);
          const m = memOf(el);
          a.cur[k] = m.cur[k] == null ? read(el)[k] : m.cur[k];
          a.vel[k] = (opts.velocity && num(opts.velocity[k], 0)) || 0;
        }
        a.to[k] = to[k];
        if (opts.velocity && num(opts.velocity[k], null) != null) a.vel[k] = opts.velocity[k];
      }
      if (opts.preset) { a.preset = resolvePreset(opts.preset); a.sc = springConst(a.preset); }
      a.t = 0;
      a.max = num(opts.max, 700);
      // 解析解的「重取初值」：以当前值 + 当前速度为新起点（打断语义与积分版一致）
      for (const k of a.keys) { a.x0[k] = a.cur[k]; a.v0[k] = a.vel[k] || 0; }
      // 最新一次调用拥有收尾权：打断后旧的 onComplete 不再执行，避免两套收尾互相打架
      if (opts.onComplete) a.onComplete = opts.onComplete;
      if (opts.onUpdate) a.onUpdate = opts.onUpdate;
      return a;
    }
    return null;
  }

  function resolvePreset(p) {
    if (!p) return PRESETS.press;
    if (typeof p === "string") return PRESETS[p] || PRESETS.press;
    return { k: num(p.k, 420), c: num(p.c, 34), m: num(p.m, 1) };
  }

  function springTo(el, props, opts) {
    opts = opts || {};
    if (!el) return { el, stop() {}, retarget() {} };
    let to;
    try { to = norm(props); } catch (_) { return { el, stop() {}, retarget() {} }; }
    const keys = new Set(Object.keys(to));
    if (!keys.size) return { el, stop() {}, retarget() {} };
    if (reduced()) { applyNow(el, to); try { opts.onComplete && opts.onComplete(); } catch (_) {} return { el, stop() { Motion.clear(el); }, retarget(p, v) { springTo(el, p, Object.assign({}, opts, { velocity: v })); } }; }
    try {
      const merged = mergeInto(el, props, opts);
      if (merged) { ensureTicker(); return handleFor(merged); }
      const cur = read(el);
      const m = memOf(el);
      // 采用内存里的当前值（打断时比 computed 更准），没有才用 computed
      for (const k of keys) {
        if (m.cur && m.cur[k] != null) cur[k] = m.cur[k];
      }
      const anim = {
        el,
        keys,
        cur,
        vel: {},
        to,
        preset: resolvePreset(opts.preset),
        t: 0,
        max: num(opts.max, 700),
        onUpdate: opts.onUpdate,
        onComplete: opts.onComplete,
      };
      for (const k of keys) anim.vel[k] = num(opts.velocity && opts.velocity[k], m.vel && m.vel[k] || 0) || 0;
      // 解析解状态：弹簧常数 + 初值（x0/v0）+ 每帧复用的 live 快照（零每帧分配）
      anim.sc = springConst(anim.preset);
      anim.x0 = {}; anim.v0 = {};
      for (const k of keys) { anim.x0[k] = cur[k]; anim.v0[k] = anim.vel[k]; }
      anim.live = { cur: anim.cur, vel: anim.vel, last: {} };
      active.add(anim);
      ensureTicker();
      return handleFor(anim);
    } catch (_) {
      applyNow(el, to);
      try { opts.onComplete && opts.onComplete(); } catch (_) {}
      return { el, stop() {}, retarget() {} };
    }
  }

  function handleFor(anim) {
    return {
      el: anim.el,
      stop() { active.delete(anim); },
      retarget(props, velocity) {
        try { springTo(anim.el, props, { preset: anim.preset, velocity: velocity || {} }); } catch (_) {}
      },
    };
  }

  function applyNow(el, to, keys) {
    const m = memOf(el);
    const cur = Object.assign({}, m.cur);
    for (const k in to) cur[k] = to[k];
    write(el, cur, new Set(Object.keys(to)));
    mem.set(el, { cur, vel: {} });
  }

  function set(el, props) {
    if (!el) return;
    try { applyNow(el, norm(props)); } catch (_) {}
  }

  function clear(el) {
    if (!el) return;
    try {
      el.style.transform = "";
      el.style.opacity = "";
      el.style.width = "";
      el.style.height = "";
    } catch (_) {}
    mem.delete(el);
  }

  function stop(el) {
    for (const a of Array.from(active)) {
      if (a.el === el) { active.delete(a); try { finish(a); } catch (_) {} }
    }
  }

  /* kill：无声打断 —— 只把弹簧从队列里摘掉，不写终值、不触发 onComplete。
     与 stop 的区别：stop 是「立刻收尾到目标」（go() 收导航条用），
     kill 是「这根弹簧当它没存在过」（重新抓住正在回弹的导航条用：
     若用 stop，旧回弹会在抓取瞬间把导航条 snap 到 y=0 —— 又一次跳跃）。 */
  function kill(el) {
    for (const a of Array.from(active)) {
      if (a.el === el) active.delete(a);
    }
  }

  /* ---------------- 手势跟随 ---------------- */
  function drag(el, opts) {
    const o = Object.assign({
      axis: "xy", threshold: 4, rubber: null, capture: true,
      filter: null, onDown: null, onStart: null, onMove: null, onEnd: null, onCancel: null,
    }, opts || {});
    let st = null;
    const samples = [];

    function pos(e) { return { t: now(), x: e.clientX, y: e.clientY }; }

    function velocity() {
      if (samples.length < 2) return { vx: 0, vy: 0 };
      const last = samples[samples.length - 1];
      let first = samples[0];
      for (let i = samples.length - 1; i >= 0; i--) {
        if (last.t - samples[i].t <= 90) first = samples[i]; else break;
      }
      const dt = last.t - first.t;
      if (dt <= 0) return { vx: 0, vy: 0 };
      return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
    }

    // 分轴橡皮筋：rubber 可以是 {x:{...},y:{...}} 让两轴用不同规则（导航栏横向要夹在一页内、
    // 纵向是纯粹的软性越界）；旧的单一对象写法保持「两轴共用」语义。
    const rub = o.rubber || null;
    const split = !!(rub && (rub.x || rub.y));
    const rx = split ? rub.x || null : rub;
    const ry = split ? rub.y || null : rub;

    function resist(v, rb) {
      if (!rb) return v;
      // maxOver：越界橡皮筋的硬上限（契约 §4「橡皮筋 0.35/最大 10px」）。
      // 之前只做了 0.35 衰减没做上限——衰减是线性的，拖多远就按 35% 继续往外走，
      // 滑块能滑出悬浮容器半个身位以上（rc.106 实测复现）。
      const { min = -Infinity, max = Infinity, factor = 0.35, maxOver = 10 } = rb;
      if (v < min) return Math.max(min - maxOver, min + (v - min) * factor);
      if (v > max) return Math.min(max + maxOver, max + (v - max) * factor);
      return v;
    }

    function onDown(e) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (o.filter && !o.filter(e)) return;
      st = { id: e.pointerId, x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, started: false, dx: 0, dy: 0 };
      samples.length = 0;
      samples.push(pos(e));
      window.addEventListener("pointermove", onMove, { passive: false });
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onCancel, true);
      try { if (o.capture) el.setPointerCapture(e.pointerId); } catch (_) {}
      try { o.onDown && o.onDown(e); } catch (_) {}
    }

    function onMove(e) {
      if (!st || e.pointerId !== st.id) return;
      let dx = e.clientX - st.x0;
      let dy = e.clientY - st.y0;
      if (o.axis === "x") dy = 0;
      if (o.axis === "y") dx = 0;
      if (!st.started) {
        if (Math.hypot(dx, dy) < o.threshold) return;
        st.started = true;
        try { o.onStart && o.onStart(e); } catch (_) {}
      }
      if (e.cancelable) e.preventDefault();
      st.lx = e.clientX; st.ly = e.clientY;
      samples.push(pos(e));
      if (samples.length > 12) samples.shift();
      const v = velocity();
      st.dx = resist(dx, rx); st.dy = resist(dy, ry);
      try { o.onMove && o.onMove({ dx: st.dx, dy: st.dy, vx: v.vx, vy: v.vy, raw: e }); } catch (_) {}
    }

    function cleanup() {
      window.removeEventListener("pointermove", onMove, { passive: false });
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
    }

    function onUp(e) {
      if (!st || e.pointerId !== st.id) { return; }
      const was = st.started;
      const stale = samples.length ? now() - samples[samples.length - 1].t > 80 : true;
      const v = stale ? { vx: 0, vy: 0 } : velocity();
      const out = { dx: st.dx, dy: st.dy, vx: v.vx, vy: v.vy, started: was, cancelled: false };
      st = null;
      cleanup();
      try { if (was) o.onEnd && o.onEnd(out); } catch (_) {}
    }

    function onCancel(e) {
      if (!st) return;
      const was = st.started;
      const v = velocity();
      const out = { dx: st.dx, dy: st.dy, vx: v.vx, vy: v.vy, started: was, cancelled: true };
      st = null;
      cleanup();
      try { if (was) o.onCancel ? o.onCancel(out) : (o.onEnd && o.onEnd(out)); } catch (_) {}
    }

    el.addEventListener("pointerdown", onDown);
    return {
      detach() {
        el.removeEventListener("pointerdown", onDown);
        cleanup();
        st = null;
      },
    };
  }

  /* ---------------- 调试 HUD ---------------- */
  function updateHud() {
    if (!hudEl) return;
    hudEl.textContent = `motion  fps ${stats.fps}  springs ${stats.springs}  long ${stats.long}  worst ${stats.worst.toFixed(0)}ms`;
  }

  function hud(on) {
    if (on && !hudEl) {
      hudEl = document.createElement("div");
      hudEl.id = "__motion_hud";
      hudEl.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:99999;padding:3px 6px;border-radius:6px;" +
        "background:rgba(0,0,0,.62);color:#5f5;font:10px/1.4 ui-monospace,Menlo,monospace;pointer-events:none;white-space:nowrap";
      document.body.appendChild(hudEl);
      updateHud();
    } else if (!on && hudEl) {
      hudEl.remove();
      hudEl = null;
    }
  }

  const Motion = {
    presets: PRESETS,
    legacy,
    reduced,
    springTo,
    set,
    clear,
    stop,
    kill,
    drag,
    hud,
    stats,
  };

  try {
    if (MODE === "reduce") forceReduce = true;
    if (mq && mq.addEventListener) mq.addEventListener("change", () => { /* reduced() 实时读取 */ });
    if (QS.get("motionDebug") === "1") hud(true);
    window.Motion = Motion;
    window.__dsh = window.__dsh || {};
    window.__dsh.motion = Motion;
  } catch (_) {}
})();
