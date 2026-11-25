  function simplifySheetCopy(root) {
    if (!root) return;
    root.querySelectorAll(".sheet-sub").forEach((el) => {
      const raw = (el.textContent || "").trim();
      // 短的已经是精简写法；含数字/URL 的多数是状态行，原样保留
      if (raw.length <= 16 || /https?:|^\d|·/.test(raw)) return;
      let s = raw
        .split(/[。；;]/)[0]
        .replace(/（[^）]*）/g, "")
        .replace(/\([^)]*\)/g, "")
        .trim();
      if (s.length > 18) {
        const cut = s.slice(0, 18);
        const brk = Math.max(cut.lastIndexOf("，"), cut.lastIndexOf(","), cut.lastIndexOf(" "));
        s = (brk >= 8 ? cut.slice(0, brk) : cut).trim();
      }
      if (s && s !== raw) el.textContent = s;
    });
  }

  function openSheet(html) {
    const M = window.Motion;
    const modern = !!(M && !M.legacy);
    const body = $("#sheetBody");
    const parent = body.parentElement;
    const oldFoot = parent ? parent.querySelector(":scope > .sheet-footer") : null;
    if (oldFoot) oldFoot.remove();
    body.innerHTML = html;
    simplifySheetCopy(body);
    // 表单底部按钮固定，不随内容滚动，也不会被系统手势条压住
    const foot = body.querySelector(".sheet-footer");
    if (foot && parent) parent.appendChild(foot);
    if (!body.__fadeBound) {
      body.addEventListener("scroll", syncSheetFade, { passive: true });
      body.__fadeBound = true;
    }
    // 异步填充（电脑会话列表、探测结果…）在 open 之后才改内容，
    // 只靠 scroll 事件 is-scrollable 永远不会亮，底部就成了硬切 —— 内容一变就重算。
    if (!body.__fadeObs) {
      new MutationObserver(syncSheetFade).observe(body, { childList: true, subtree: true });
      body.__fadeObs = true;
    }
    syncSheetFade();
    requestAnimationFrame(syncSheetFade);
    requestAnimationFrame(() => {
      if ($("#mEfforts")) {
        const cur = normalizeEfforts($("#mEfforts").value);
        $$("#mEfforts ~ .effort-tips [data-effort-tip]").forEach((b) =>
          b.classList.toggle("is-on", cur.includes(b.dataset.effortTip)));
      }
      if ($("#effortSeg")) moveEffortInd();
      if ($("#qaSeg")) moveSegInd($("#qaSeg"), $("#qaSegInd"), PERMS.indexOf(PERMS.find((x) => x.id === state.perm)), PERMS.length);
      applyLang();
      mountHtmlPreview();
      // 表情面板的长按排序/删除手势跟着每一次打开重新挂一遍
      if ($("#stickerGrid")) bindStickerGrid();
      // 面板里也可能有本地图片（文件预览、交付缩略图）
      hydrateMedia($("#sheetBody"));
    });
    /* ---- 开合：全部交给 Motion.springTo（不再挂 is-pop / sheetPopIn 关键帧） ---- */
    const sheetEl = $("#sheet");
    const bd = $("#sheetBackdrop");
    const gen = ++sheetGen;
    const wasOpen = sheetOpen && !sheetClosing && sheetEl.classList.contains("is-on");
    const reversing = sheetClosing;      // 收起途中又被打开：从当前位置弹回来，不重放入场
    sheetClosing = false;
    sheetEl.classList.remove("is-closing", "is-pop");
    bd.classList.add("is-on");
    sheetOpen = true;

    if (!modern) {
      // 旧行为（window.Motion 缺失 / ?motion=legacy）：只切类名，位移交给 styles.css 的过渡
      sheetEl.classList.add("is-on");
      haptic("light");
      return;
    }

    p2Own(sheetEl);
    p2Own(bd);
    sheetEl.style.pointerEvents = "";    // 上一轮关到一半时摘掉的点击重新打开

    if (wasOpen) {
      // 已经打开又开一次：只做内容 120ms 淡入，面板本身不动（整块重滑会顿一下）
      M.set(body, { opacity: 0 });
      M.springTo(body, { opacity: 1 }, {
        preset: "gentle",
        max: 200,
        onComplete: () => M.clear(body),
      });
      haptic("light");
      return;
    }

    sheetEl.classList.add("is-on");
    if (reversing) {
      // 关闭动画没走完就再次打开：直接反向（springTo 从当前值和当前速度接管，不先 stop）
      M.springTo(sheetEl, { y: 0 }, { preset: "sheet" });
      M.springTo(bd, { opacity: 1 }, { preset: "gentle", max: 320 });
      haptic("light");
      return;
    }

    // 新开一屏：先量高度落到屏下，再弹到位
    const h = Math.max(1, sheetEl.getBoundingClientRect().height);
    M.stop(sheetEl);
    M.set(sheetEl, { y: h });
    // max 420：sheet 预设自身收敛到 0.3px 要 ~520ms，按验收窗口截到 420ms，
    // 截断时残差 <1.5px（肉眼不可见），但「落位完成」的时间点确定落在 300–420ms 内
    M.springTo(sheetEl, { y: 0 }, { preset: "sheet", max: 420 });
    M.set(bd, { opacity: 0 });
    M.springTo(bd, { opacity: 1 }, { preset: "gentle", max: 320 });
    bindSheetDrag();
    p2SheetHandles();
    p2StaggerContent(gen);
    haptic("light");
  }

  function closeSheet() {
    // 电脑会话的轮询跟着「是否还在这场会话里」走，不跟面板开合：
    // 以前是面板聊天，关面板就该停；现在它在主聊天页，关个模型面板也停掉，
    // 后面 agent 的回复就全丢了（实测踩到）。
    if (!state.pcSession) {
      try { if (Link) Link.stopPoll(); } catch (_) {}
    }
    const stale = $("#sheet > .sheet-footer");
    if (stale) stale.remove();
    const M = window.Motion;
    const modern = !!(M && !M.legacy);
    const sheetEl = $("#sheet");
    const bd = $("#sheetBackdrop");
    const gen = ++sheetGen;
    sheetEl.classList.remove("is-pop");
    bd.classList.remove("is-on");
    sheetOpen = false;

    if (!modern) {
      // 旧行为：is-closing 交给 styles.css 过渡，320ms 后摘类
      sheetEl.classList.add("is-closing");
      sheetEl.classList.remove("is-on");
      setTimeout(() => sheetEl.classList.remove("is-closing"), 320);
      return;
    }

    p2Own(sheetEl);
    p2Own(bd);
    sheetClosing = true;
    sheetEl.style.pointerEvents = "none";    // 出场途中不再吃点击
    // 最新的 onComplete 拥有收尾权；躺着不动的兜底超时防止 rAF 停摆（切后台/元素被换掉）
    const finish = () => {
      if (gen !== sheetGen) return;          // 已经被下一次打开接管
      sheetClosing = false;
      sheetEl.classList.remove("is-on", "is-closing", "is-pop");
      sheetEl.style.pointerEvents = "";
      M.clear(sheetEl);
      M.clear(bd);
    };
    const h = Math.max(1, sheetEl.getBoundingClientRect().height);
    M.springTo(bd, { opacity: 0 }, { preset: "gentle", max: 260 });
    M.springTo(sheetEl, { y: h }, { preset: "exit", max: 420, onComplete: finish });
    // 保险：onComplete 万一没来（帧被挂起 / 元素被换掉）也要把样式收干净
    setTimeout(() => { if (gen === sheetGen && sheetClosing) finish(); }, 700);
  }

  /* 关闭态的硬兜底：面板「不在」时不能只靠 translateY(104%)。
     下拉手势的 onEnd 在 is-on 已被摘掉时会直接返回，手指留在元素上的内联 y 就再也没人清 ——
     面板半开着卡在屏幕底部，只露一条顶边和那把把手（用户实测）。
     styles.css 的 .sheet:not(.is-on):not(.is-closing){visibility:hidden} 是最后一道保险，
     这里负责把内联位移和状态类一并擦干净，别把垃圾状态留给下一轮。 */
  function sheetHideHard() {
    const sheetEl = $("#sheet");
    const bd = $("#sheetBackdrop");
    // 收起动画还在跑（旧动效路径的 is-closing）：交给它自己的定时器收尾，别硬切
    if (!sheetEl || sheetEl.classList.contains("is-closing")) return;
    try { if (window.Motion) { window.Motion.clear(sheetEl); window.Motion.clear(bd); } } catch (_) {}
    sheetEl.classList.remove("is-on", "is-closing", "is-pop");
    sheetEl.style.pointerEvents = "";
    sheetOpen = false;
    sheetClosing = false;
  }

  /**
   * 面板下拉关闭：只有抓 sheet-grab / sheet-title 才拖，内容区滚动完全不受影响。
   * 向下 1:1、向上橡皮筋 -12；遮罩透明度跟着位移联动。
   */
  /**
   * 下拉把手：`touch-action:none` 只写在这两个把手上，取消浏览器对竖直手势的接管
   * （不写的话 WebView 会把下拉当成滚动，直接给 pointercancel，面板纹丝不动）。
   * 只作用于 .sheet-grab / .sheet-title，.sheet-body 的滚动完全不受影响。
   * styles.css 里也会有同一条，这里内联保证手势单独可用。
   */
  function p2SheetHandles() {
    $$("#sheet .sheet-grab, #sheet .sheet-title").forEach((h) => {
      try { h.style.touchAction = "none"; } catch (_) {}
    });
  }

  /**
   * 内容前 6 项错帧入场（14ms / 6px，契约 §4）：面板整体落地的同时内容跟上，
   * 观感是「一叠卡片依次落位」而不是一整张纸硬推上来。
   * 只在全新打开时跑；gen 变了（关/换面板）就立刻落终值，绝不让内容卡在半透明。
   */
  function p2StaggerContent(gen) {
    const M = window.Motion;
    const body = $("#sheetBody");
    if (!M || !body || M.reduced()) return;
    const items = Array.prototype.slice.call(body.children, 0, 6).filter((e) => e && e.nodeType === 1);
    if (items.length < 2) return;
    items.forEach((el, i) => {
      M.set(el, { opacity: 0, y: 6 });
      setTimeout(() => {
        if (gen !== sheetGen) { M.set(el, { opacity: 1, y: 0 }); M.clear(el); return; }
        M.springTo(el, { opacity: 1, y: 0 }, { preset: "gentle", max: 260, onComplete: () => M.clear(el) });
      }, 14 * i);
    });
  }

  function bindSheetDrag() {
    const M = window.Motion;
    const sheetEl = $("#sheet");
    const bd = $("#sheetBackdrop");
    if (!M || M.legacy || !sheetEl || !bd || sheetEl.__sheetDragBound) return;
    sheetEl.__sheetDragBound = true;
    p2Own(sheetEl);
    p2Own(bd);
    p2SheetHandles();
    let g = null;
    M.drag(sheetEl, {
      axis: "y",
      threshold: 6,
      capture: false,                       // 不在面板上抓指针
      filter: (e) => !!e.target.closest(".sheet-grab,.sheet-title"),
      onDown: () => { g = null; },
      onStart: () => {
        if (!sheetOpen || sheetClosing || M.reduced()) return;
        g = { h: Math.max(1, sheetEl.getBoundingClientRect().height) };
        M.stop(sheetEl);                    // 入场弹簧还没落定就抓：先落地，再 1:1 跟手
      },
      onMove: ({ dy }) => {
        if (!g) return;
        // 向下 1:1，向上只给 12px 橡皮筋。这 12px 得有人兜住：styles.css 里
        // .sheet 的 --sheet-skirt（14px）把材质多铺一截到屏外，改这里要一起改。
        const y = Math.max(-12, dy);
        M.set(sheetEl, { y });
        M.set(bd, { opacity: Math.max(0, Math.min(1, 1 - y / g.h)) });
      },
      onEnd: ({ dy, vy }) => {
        const s = g;
        g = null;
        if (!s) return;
        // 收手时面板已经不在开着（关到一半 / 被别的入口收掉）：手指留下的内联 y 必须擦掉，
        // 否则面板停在半空不动 —— 底部「露出浮窗顶部」就是这么来的。
        if (!sheetOpen || sheetClosing) { sheetHideHard(); return; }
        const y = Math.max(-12, dy);
        // 位移过 28% 高度 或 向下快扫 0.35px/ms → 关闭；否则弹回原位
        if (y > s.h * 0.28 || vy > 0.35) { closeSheet(); return; }
        M.springTo(sheetEl, { y: 0 }, { preset: "press", velocity: { y: (vy || 0) * 1000 } });
        M.springTo(bd, { opacity: 1 }, { preset: "gentle", max: 320 });
      },
    });
  }

  /* ---------------- 团队面板 ----------------
     团队是后台在跑的东西：用户不打开面板也应该知道「谁在干活、干到哪」。
     顶栏徽标显示在跑人数；面板只做可观测（成员/任务/预算），判定全在原生侧。
     文案与结构照桌面 client-ui-agent-team 的 locales.ts + TeamAction.tsx：
     状态是 待处理/进行中/已完成，pending 才显示 可开始/被依赖阻塞，
     没主人显示 未分配，任务卡带描述（两行夹 + 展开/收起）与 依赖 / 写入范围。 */
  const TEAM_TASK = { pending: "待处理", in_progress: "进行中", completed: "已完成", deleted: "已删除" };
  // 展开状态跟着「团队 + 任务」记：面板每来一次快照就整块重绘，DOM 上的局部状态活不过一次刷新；
  // 而任务 id 每支团队都从 task-1 开始，只按 id 记会让 A 团队的展开态串到 B 团队
  const teamTaskOpen = new Set();
  const teamTaskKey = (id) => teamSid() + ":" + id;

  function teamSid() {
    const sid = state.sessionId;
    return (sid && sid !== "s1") ? sid : (Live.sessionId || sid || "");
  }

  function teamAvaClass(m) {
    if (m.role === "lead") return "lead";
    if (m.status === "failed") return "failed";
    if (m.status === "provisioning") return "provisioning";
    if (m.status === "inactive") return "idle";
    return "";
  }

  /** 顶栏团队按钮：常显；有队友时带人数徽标（在跑用绿点） */
  function syncTeamBadge() {
    const btn = $("#btnTeam");
    const badge = $("#teamBadge");
    if (!btn || !badge) return;
    btn.hidden = false;
    const mates = ((state.team && state.team.members) || []).filter((m) => m.role !== "lead");
    if (!mates.length) {
      badge.hidden = true;
      btn.setAttribute("aria-label", "团队：还没有队友");
      return;
    }
    const running = mates.filter((m) => m.status === "running").length;
    badge.hidden = false;
    badge.textContent = String(running || mates.length);
    badge.classList.toggle("is-run", running > 0);
    btn.setAttribute("aria-label", `团队：${running} 人在跑 / 共 ${mates.length} 人`);
  }

  function teamMemberHtml(m) {
    const cls = teamAvaClass(m);
    const name = esc(m.target || "?");
    const role = m.role === "lead" ? "Lead" : "Teammate";
    // 上一次出错的原因要说得出：ACTIVE 成员带 error = 「这一轮没跑完，还能再叫醒」，
    // FAILED = 「没建起来，救不回来」。两种以前都只画一个灰点，Lead 看不出该重发还是该重建。
    const errLine = m.error
      ? (m.phase === "failed" ? `创建失败：${esc(String(m.error))}` : `这一轮没跑完：${esc(String(m.error))}`)
      : "";
    const act = errLine || (m.lastAction ? esc(m.lastAction) : (m.status === "inactive" ? "等待唤醒" : ""));
    const tokens = Number(m.tokensIn || 0) + Number(m.tokensOut || 0);
    const meta = [
      `${m.turns || 0} 轮`,
      `${m.toolCalls || 0} 次工具`,
      tokens ? `${Math.round(tokens / 100) / 10}k tok` : "",
      m.model ? esc(String(m.model).split("/").pop()) : "",
    ].filter(Boolean).join(" · ");
    return `
      <div class="tm-member"${m.role === "lead" ? "" : ` data-team-open="${name}"`}>
        <div class="tm-ava ${cls}">${esc(String(m.target || "?").slice(0, 2).toUpperCase())}</div>
        <div class="tm-main">
          <div class="tm-name">${name}<i class="tm-dot ${m.status}"></i><span class="tm-pill">${role}</span></div>
          ${m.description ? `<div class="tm-desc">${esc(m.description)}</div>` : ""}
          ${act ? `<div class="tm-act">${act}</div>` : ""}
          <div class="tm-meta">${meta}</div>
          ${m.role !== "lead" && m.status !== "failed"
            ? `<button class="tm-open" data-team-open="${name}">进入会话</button>` : ""}
          ${m.status === "running" ? `<button class="tm-open" data-team-kill="${name}">中断这一轮</button>` : ""}
        </div>
      </div>`;
  }

  function teamTaskHtml(t) {
    const warnings = (t.writeScopeWarnings || []);
    const blockers = t.blockedBy || [];
    const scopes = t.writeScopes || [];
    const open = teamTaskOpen.has(teamTaskKey(t.id));
    const desc = String(t.description || "");
    return `
      <div class="tm-task">
        <span class="tm-task-id">${esc(t.id)}</span>
        <div class="tm-task-main">
          <div class="tm-task-t"><span class="tm-task-sub">${esc(t.subject)}</span><span class="tm-task-state">${TEAM_TASK[t.status] || t.status}</span></div>
          ${desc ? `<div class="tm-task-desc${open ? "" : " clamp"}">${esc(desc)}</div>` : ""}
          <div class="tm-task-m">
            ${desc ? `<button class="tm-task-x" data-task-x="${esc(t.id)}" aria-expanded="${open ? "true" : "false"}">${open ? "收起" : "展开"}</button>` : ""}
            <span>${esc(t.ownerName ? "Owner: " + t.ownerName : "Owner: 未分配")}</span>
            ${t.status === "pending" ? `<span>${t.ready ? "可开始" : "被依赖阻塞"}</span>` : ""}
            ${blockers.length ? `<span>依赖: ${blockers.map(esc).join(", ")}</span>` : ""}
            ${scopes.length ? `<span>写入范围: ${scopes.map(esc).join(", ")}</span>` : ""}
            <span class="tm-task-rev">r${t.revision}</span>
          </div>
          ${warnings.map((w) => `<div class="tm-task-warn">${esc(w)}</div>`).join("")}
        </div>
      </div>`;
  }

  function teamSheet() {
    const t = state.team;
    if (!t) {
      return `<div class="sheet-title" data-team>团队</div>
        <div class="tm-empty">这个会话还没有团队。<br/>让 Agent「建一个 reviewer 检查这次的改动」，<br/>队友会出现在这里，跑在后台，不占你的对话轮次。</div>`;
    }
    const all = t.members || [];
    const mates = all.filter((m) => m.role !== "lead");
    // 运行中 = 队友在跑 + Lead 本轮在跑（state.busy）。
    // 快照的 running 只数队友：lead 是虚拟成员、不进 roster 运行态，
    // 但面板上 lead 带绿点，计数却是 0 会让人以为面板坏了 —— 两边必须对得上。
    const leadRunning = !!state.busy;
    const running = mates.filter((m) => m.status === "running").length + (leadRunning ? 1 : 0);
    const tasks = t.tasks || [];
    const board = t.board || {};
    const limits = t.limits || {};
    const lead = all.find((m) => m.role === "lead");
    // rc.97 起每个会话一支团队（桌面 TeamId=SessionId 同构）：这里永远显示本会话自己的团队
    // 桌面：投影报告「有持久记录被拒绝」时，面板在最后合法的 roster 上方显示它
    const failNote = t.failure
      ? `<div class="tm-fail">团队记录被拒绝：${esc(t.failure)}。下面的成员与任务停在最后一条合法记录上。</div>`
      : "";
    return `
      <div class="sheet-title" data-team>团队</div>
      ${failNote}
      <div class="sheet-sub">${running} 人在跑 · 并行上限 ${limits.maxConcurrent ?? "—"}</div>
      <div class="tm-hero">
        <div class="tm-stat"><b>${running}</b><span>运行中</span></div>
        <div class="tm-stat"><b>${board.ready ?? 0}</b><span>可开始</span></div>
        <div class="tm-stat"><b>${board.inProgress ?? 0}</b><span>进行中</span></div>
      </div>
      <div class="tm-sec">成员<span class="tm-count">${all.length}</span></div>
      ${(lead ? teamMemberHtml(lead) : "") + mates.map(teamMemberHtml).join("")}
      <div class="tm-sec">共享任务<span class="tm-count">${tasks.length}</span></div>
      ${tasks.length ? tasks.map(teamTaskHtml).join("") : '<div class="tm-empty">暂无共享任务，可以通过对话创建</div>'}
      <div class="tm-meta">并行上限 ${limits.maxConcurrent ?? "—"}</div>`;
  }

  /**
   * 画完之后量一次：描述真的被两行夹住了才留「展开」按钮（桌面 TaskCard 用
   * ResizeObserver 做同一件事，手机端面板是整块 innerHTML 重绘，量一轮就够）。
   * 靠字数猜不行 —— 同样 55 字，中文两行放得下，英文两行放不下，按钮该不该出现正好相反。
   */
  function markTaskClamp() {
    const body = $("#sheetBody");
    if (!body) return;
    body.querySelectorAll(".tm-task").forEach((card) => {
      const d = card.querySelector(".tm-task-desc");
      const btn = card.querySelector("[data-task-x]");
      if (!d || !btn) return;
      const expanded = !d.classList.contains("clamp");
      btn.hidden = !expanded && d.scrollHeight <= d.clientHeight + 1;
    });
  }

  function refreshTeamSheet() {
    const body = $("#sheetBody");
    if (!body || !sheetOpen || !body.querySelector("[data-team]")) return;
    const y = body.scrollTop;
    body.innerHTML = teamSheet();
    body.scrollTop = y;
    markTaskClamp();
  }

  function pullTeam() {
    if (!Native || !Native.teamSnapshot) return;
    try {
      const r = JSON.parse(Native.teamSnapshot(teamSid()) || "{}");
      if (r.ok && r.team) {
        state.team = r.team;
        syncTeamBadge();
        refreshTeamSheet();
      }
    } catch (_) {}
  }

  /* 点成员行 = 打开它自己那场会话（`data-team-open` 那颗按钮），桌面就是这么做的：
     client-ui-agent-team/src/client/mount.ts:38-50 的 openSession({parentSessionId,
     childSessionId, mode:'continuable'})。以前这里先弹一层「只读日志」面板再给一个
     「进入它的会话」按钮 —— 桌面没有那条通道（agent-team README:88「No mailbox timeline」，
     队友进度就是它自己的会话流），多出来的一层是要单独维护的第二套渲染，
     也让「看队友在干什么」白白多一步。 */

  /* ---- 成员会话导航（桌面：点 teammate 打开它的会话，之后人类消息走同一条路径） ---- */

  /** 非空表示正在看某个成员的会话：{parent, name, session, seen} */
  function teamView() { return state.teamView || null; }

  function enterTeamView(name) {
    if (!Native || !Native.teamOpen) return;
    // 成员视图是「看队友在干什么」，不是「离开 Lead 这一轮」：以前这里走的是
    // 「换视图统一收尾」那条路（里面 stopLive），用户实测一进子会话 Lead 就终止。
    // 现在把这一轮交给内核继续跑、页面这只手松开（事件不再进来），退出时按快照接回来。
    persistThread();
    if (queueOf().length) {
      queueOf().length = 0;
      renderQueue();
      toast("已切换视图，排队消息已清空", 2200);
    }
    const sid = teamSid();      // 只求值一次：后面 parent 与 teamOpen 必须指向同一会话
    let r = {};
    try { r = JSON.parse(Native.teamOpen(sid, name) || "{}"); } catch (_) {}
    if (!r.ok) { toast(r.error || "无法进入该成员的会话"); return; }
    // 主对话流是「换出」不是「清空」：切到成员自己那一份桶，主会话的数组原样留在
    // buckets 里（含正在跑的 Live 节点），退出时切回去即可。比 splice 出来再塞回安全，
    // 也不会因为任何一次异步写把两边的消息搞混。
    // parent 取「这条会话真实挂在谁名下」：state.sessionId 是占位 s1 / 空时退回
    // Live.sessionId，再退回当前桶的 key —— 它是退出成员视图时唯一可信的归处。
    const parent = sid || (thread.__sid || "");
    state.teamView = { parent, name: r.name, session: r.session, seenTotal: null };
    // 落一份「我在看谁的会话」：进程被回收后重开，页面至少能回到这场团队自己的 Lead 会话，
    // 而不是凭空一条空白新会话（实测：在成员视图里被杀掉，再开 App 就是新会话，
    // 用户以为团队整场没了）。成员视图本身不带回来 —— 回来时先看 Lead，再点进去更清楚。
    try { localStorage.setItem("dsh.teamView", JSON.stringify({ parent, name: r.name })); } catch (_) {}
    attachBlank("team:" + parent + "#" + r.name);   // 每次进入都从成员日志重灌
    // Flow 也换到这一场：成员视图现在用主对话同一套过程组渲染（Flow.toolStart/ensureGroup），
    // 不清的话 Lead 那一组的计数/索引会漏进成员的流里，退出时 claimRun 会重新认领回来。
    Flow.turnStart();
    // Lead 这一轮还活着：挂到后台。事件不再进来（Live.id 置空），轮次本身在内核里继续；
    // `open` 已经在上面那次 persistThread 里登记过，退出时 resumeBgRun 按快照接回来。
    if (Live.id && (Live.running || state.busy)) {
      state.bgRun = { id: Live.id, sid: Live.sessionId || parent };
      Live.id = null;
      Live.running = false;
      Live.sessionId = null;
      Live.textEl = null;
      Live.textNode = null;
      NativeAgent.active = false;
      NativeAgent.id = null;
      state.busy = false;
      updateSendState();
    }
    closeSheet();
    haptic("medium");
    renderThread();
    go("chat");
    syncTeamViewBar();
    pullTeam();                     // 先拿一次最新状态：进度行要读成员的 running/lastAction
    refreshTeamViewMessages(true);
    startTeamViewPoll();
    toast(`已进入 ${r.name} 的会话，直接输入即可与它对话`, 2600);
  }

  function exitTeamView() {
    const v = teamView();
    if (!v) return;
    // 归处只看 parent（进入时算好的、唯一可信的会话）；成员视图期间
    // state.sessionId 可能被后台轮次/定时任务改掉，不能用它来定位。
    const parent = v.parent || "";
    state.teamView = null;
    try { localStorage.removeItem("dsh.teamView"); } catch (_) {}
    stopTeamViewPoll();
    syncTeamViewBar();
    // 出问题时这条是唯一的现场证据（logcat 里 grep `[team-exit]`）：
    // 「回到 Lead 会话却像没了记录」有三种成因（库里没有 / 桶被挤掉 / 后台那一轮没人认领），
    // 光看界面分不出来，只能看当时到底查到的是什么
    console.warn("[team-exit]", {
      parent, inDb: !!LocalDB.get(parent), held: bucketHas(parent),
      bg: state.bgRun ? state.bgRun.sid : null, sid: state.sessionId,
    });
    // 统一走 openSession：它负责 attach 到该会话自己的桶、必要时从库补齐、
    // 刷新标题与模式栏。手写一半逻辑很容易出现「桶切对了但界面/状态没回来」。
    // 它的 sameRunning 分支现在会在「换了桶」时重绘，不会再残留成员会话的内容。
    if (parent && LocalDB.get(parent)) {
      // 认领后台那一轮归 openSession 管（从会话列表点回来、从别处切回来是同一条路）：
      // 以前这里自己调一次 resumeBgRun，于是「只有退出按钮能接回运行中的这一轮」，
      // 从列表点回原会话就把半截流和运行状态一起丢在后台（用户实测：记录消失，
      // 杀后台重启才恢复）。
      openSession(parent);
      return;
    }
    // 库里查不到这一场（刚被删除、或进入时带的是占位 sid）但页面还握着它的节点：
    // 认回这一场。清空界面等于当着用户的面把记录「弄没」—— 它其实哪儿都没丢，
    // 只有杀后台重启才重新显示，这就是用户报的那个现象。
    if (parent && bucketHas(parent)) {
      state.sessionId = parent;
      attachThread(parent);
      renderThread();
      syncModeBar();
      resumeBgRun(parent);
      go("chat");
      return;
    }
    // 父会话真的不在了（被删，或进入时用的是占位 sid）：回到空态，
    // 别把成员会话的内容留在界面上让人以为那是自己的对话。
    state.bgRun = null;
    state.sessionId = "";
    attachBlank("");
    renderThread();
    syncModeBar();
    go("sessions");
  }

  /** 导航条 + 标题：明确「你在谁的会话里」，别让人把话发给错误的对象 */
  function syncTeamViewBar() {
    const bar = $("#teamViewBar");
    const label = $("#teamViewLabel");
    if (!bar || !label) return;
    const v = teamView();
    bar.hidden = !v;
    if (v) {
      const m = ((state.team && state.team.members) || []).find((x) => x.target === v.name);
      const st = m ? (m.status === "running" ? "在跑" : "待唤醒") : "";
      label.innerHTML = `正在看 teammate <b>${esc(v.name)}</b> 的会话${st ? ` · ${st}` : ""}，输入框的消息会发给它`;
      if ($("#chatTitle")) $("#chatTitle").textContent = v.name + "（teammate）";
      if ($("#chatSub")) $("#chatSub").textContent = "团队成员会话 · 点「退出」回到原会话";
    }
  }

  /** 拉成员会话的新消息并追加进当前线程视图 */
  function refreshTeamViewMessages(force) {
    const v = teamView();
    if (!v || !Native || !Native.teamMemberLog) return;
    // 归属自检：轮询回来时可能已经退出、或切到了别的成员 —— 增量绝不能落进别的流
    if (thread.__sid !== "team:" + v.parent + "#" + v.name) return;
    let r = {};
    try { r = JSON.parse(Native.teamMemberLog(v.parent, v.name) || "{}"); } catch (_) {}
    if (!r.ok) return;
    const msgs = r.messages || [];
    const total = Number(r.total) || msgs.length;
    // 成员会话很长时后端只回尾部一窗（桌面是完整历史 + 滚动加载）。
    // 游标必须按**全局序号**对齐：窗口会随 total 增长向左滑，用数组长度当游标
    // 会让新消息永远落在窗口外（i 从旧长度起，而旧长度 ≥ 新窗口长度 → 一条都不渲染）。
    const offset = Math.max(0, total - msgs.length);
    const from = Math.max(0, (v.seenTotal == null ? offset : v.seenTotal) - offset);
    for (let i = from; i < msgs.length; i++) {
      const m = msgs[i];
      if (!m) continue;
      // 三类都画，但**用主对话同一套节点与同一套行渲染**：连续的工具调用折进同一个
      // 过程组（toolRowHTML / ioHTML 完全共用，点开看输入输出），正文是 text 节点，
      // 用户句是 user 节点。以前每条工具平铺一行、彼此不成组，看着就不是同一个界面。
      if (m.kind === "tool") {
        const id = m.id || ("tm" + (offset + i));
        Flow.toolStart({ id, name: m.name || "工具", args: m.args || "" });
        Flow.toolEnd(id, { ok: m.ok !== false, output: m.out || "", ms: Number(m.ms) || 0 });
        continue;
      }
      // 正文与用户句都是「过程结束」的边界：组就地折成一行，后面的内容另起一段
      Flow.closeGroup();
      if (m.kind === "user") {
        push(NODES.user(m.text), false);
      } else if (v.liveNode) {
        // 正在写的那口气泡已经把这句画出来了：用日志里的权威全文收口，
        // 不另起一个节点（否则同一段话在成员视图里出现两遍）
        v.liveNode.text = m.text || "";
        v.liveNode.live = false;
        patchNode(v.liveNode);
        v.liveNode = null;
      } else if (String(m.text || "").trim()) {
        // 空正文的 assistant 条目（只带 tool_calls 的那种）不建节点：会留一个空消息块
        push(NODES.text(m.text), false);
      }
    }
    const grew = from < msgs.length;
    v.seenTotal = total;
    if (grew || force) {
      // 不再 renderThread() 整表重绘：上面每条新内容都是 appendTail / patchNode，
      // 已经画出来的行保持原样（整表重绘 = 闪，也违反「对话流只做增量刷新」）
      scrollToBottom();
      // 只提示一次：桌面能一直往上翻到第一条，这里确实少了一截，别让人以为成员只干了最后几步
      if (r.hasMore && !v.warned) {
        v.warned = true;
        toast(`这个成员的会话较长，只显示最近 ${msgs.length} 条（共 ${total} 条）`, 3200);
      }
    }
    syncTeamViewPending(v);
    syncTeamViewLive(v);
    syncTeamViewBar();
  }

  /**
   * 成员正在写的正文：和主对话一样逐字长。
   *
   * 内核在 stream 的 onDelta 里攒 `live`（节流 400ms 推进快照），这里只做
   * 「追加一个气泡 + 就地 patch 它」—— 不整表重绘，也不等日志落盘（日志是轮末才写的）。
   */
  function syncTeamViewLive(v) {
    const m = ((state.team && state.team.members) || []).find((x) => x.target === v.name);
    const live = String((m && m.live) || "");
    const seq = Number((m && m.liveSeq) || 0);
    const running = !!m && (m.status === "running" || m.status === "provisioning");
    if (!running || !live) return;
    if (!v.liveNode) {
      v.liveNode = NODES.text(live);
      v.liveNode.live = true;
      v.liveSeq = seq;
      push(v.liveNode, false);
      return;
    }
    // 序号没动 = 没有新内容（快照可能被别的字段变化触发），别白 patch 一次
    if (seq && v.liveSeq && seq === v.liveSeq) return;
    if (v.liveNode.text !== live) {
      v.liveNode.text = live;
      v.liveSeq = seq;
      patchNode(v.liveNode);
    }
  }

  /**
   * 成员在跑时的进度：用主对话的过程组头，不再另起一行带轮数的进度提示。
   *
   * 用户点名要去掉的就是那张轮数卡片 —— 轮数是内核的循环计数，不是「它在干什么」。
   * 内核的 `lastAction` 有两种写法：「<工具名> <目标>」与「第 N 轮推理」；
   * 前者折成「正在运行命令 · ls -1」，后者折成「正在思考…」，与主对话的组头一字不差。
   */
  function syncTeamViewPending(v) {
    const m = ((state.team && state.team.members) || []).find((x) => x.target === v.name);
    const running = !!m && (m.status === "running" || m.status === "provisioning");
    if (!running) { Flow.closeGroup(); return; }      // 停下来：当前组就地折成「已完成…」
    const g = Flow.ensureGroup();
    const act = String(m.lastAction || "").trim();
    const hit = act.match(/^([a-z_][a-z0-9_]*)\s+([\s\S]+)$/);
    g.running = hit
      ? { cat: toolCategory(hit[1]), detail: hit[2].trim(), name: hit[1] }
      : { cat: "thinking", detail: "", name: "" };
    Flow.paintGroupHead(g);
    syncThinkTail();
  }

  let teamViewTimer = 0;
  function startTeamViewPoll() {
    stopTeamViewPoll();
    // 2.2s 轮询成员自己的日志兜底：主通道是运行时推快照（bump → ev.t="team"）时立即刷新，
    // 这条只是「快照丢了/页面刚回来」时的保险。读 jsonl 的开销很小。
    teamViewTimer = setInterval(() => {
      if (!teamView()) { stopTeamViewPoll(); return; }
      pullTeam();                       // 成员状态 / lastAction 跟着刷新（进度行与「在跑」都用它）
      refreshTeamViewMessages(false);
    }, 2200);
  }
  function stopTeamViewPoll() {
    if (teamViewTimer) { clearInterval(teamViewTimer); teamViewTimer = 0; }
  }

  /** 在成员会话里替用户发的一句话：走 send_message 同一条路径（running 收件箱 / inactive 冷恢复） */
  function sendTeamViewMessage(text) {
    const v = teamView();
    if (!v || !Native || !Native.teamUserMessage) return;
    // 队友已经 inactive 时，唤醒它需要端点信息。以前内核只认内存里「最后一次 Lead 配置」，
    // 那份配置不落盘 —— 进程重启后在这里发消息必然 TEAM_NO_LEAD_CONTEXT：模型明明配好了，
    // 却唤不醒队友。现在把这一句本来要用的配置一起交过去（只在调用里过境，不进会话日志）。
    let cfg = "";
    try {
      const m = findModel(state.model), ep = endpointOf(m);
      cfg = JSON.stringify(NativeAgent.payload(text, [], m, ep, [], { sessionId: v.parent }));
    } catch (_) {}
    let r = {};
    try { r = JSON.parse(Native.teamUserMessage(v.parent, v.name, text, cfg) || "{}"); } catch (_) {}
    if (r.ok) {
      // 气泡已经由发送处画进流里（NODES.user）。运行时也会把这条写进成员日志 ——
      // 游标推进一条，刷新时就不会再画第二遍（游标是全局序号，见 refreshTeamViewMessages）；
      // 这一步不能省，否则同一句话在成员视图里出现两次（实测）。
      v.seenTotal = (v.seenTotal || 0) + 1;
      if (r.team) { state.team = r.team; syncTeamBadge(); }
    } else {
      thread.push(NODES.text(`（发送失败：${r.error || "未知错误"}）`));
      renderThread();
      scrollToBottom();
    }
    refreshTeamViewMessages(true);   // 强制渲染：刚写进日志的那句立刻出现
  }

  /* ---- 团队限额（设置页）：拖动即生效，防抖写回原生并落盘 ---- */
  const TEAM_DEFAULTS = { maxConcurrent: 8, maxDepth: 1, maxMembers: 16, maxTasks: 256 };

  function teamLimitValues() {
    try {
      const r = JSON.parse(Native.teamLimits(teamSid()) || "{}");
      if (r.ok && r.limits) return { ...TEAM_DEFAULTS, ...r.limits };
    } catch (_) {}
    return { ...TEAM_DEFAULTS };
  }

  function syncTeamLimitsRow(l) {
    const el = $("#teamLimitsValue");
    if (!el) return;
    const v = l || teamLimitValues();
    el.textContent = `${v.maxConcurrent} 并行 · 深度 ${v.maxDepth ?? 1}`;
  }

  function teamLimitText(input) {
    const unit = input.dataset.fmt || "";
    return `${input.value} ${unit}`.trim();
  }

  function teamLimitsSheet() {
    const l = teamLimitValues();
    const row = (id, label, min, max, step, value, unit) => `
      <div class="tm-set-row">
        <div class="tm-set-h"><span>${label}</span><b id="tv-${id}"></b></div>
        <input type="range" id="ts-${id}" min="${min}" max="${max}" step="${step}" value="${value}" data-fmt="${unit}" />
      </div>`;
    // 与电脑端「设置 → 子智能体 → 运行限制」完全一致：只有最大递归深度与并行上限。
    // 递归深度 0 = 禁用子智能体，1 = 只有主 Agent 能派，2 起才允许嵌套；
    // 并行上限同时是团队池大小与子智能体容量（桌面也只有一个并行数）。
    // 轮次/token/时长都不是用户该调的：成员跑到模型自己停下，和主 Agent 一致。
    return `
      <div class="sheet-title">智能体团队</div>
      <div class="sheet-sub">拖动即生效 · 同时写入配置</div>
      <div class="tm-set">
        ${row("maxConcurrent", "并行上限", 1, 8, 1, l.maxConcurrent, "个")}
        ${row("maxDepth", "最大递归深度", 0, 4, 1, Math.min(4, Math.max(0, l.maxDepth ?? 1)), "层")}
      </div>
      <div class="tm-set-note">并行上限 = 同时跑几个成员，手机建议 2–4。递归深度 0 关闭子智能体，1 只允许主 Agent 派，2 起可再派一层；队友不能再派。</div>`;
  }

  /* ---------------- 灵动岛几何（位置 / 长度 / 上下留白） ----------------
     用户要能自己调这三样。滑块拖动即推原生重建，屏幕顶部直接看到效果；
     参数存在 localStorage，重装 App 也不会丢（除非清数据）。 */
  function islandTuneText(el) {
    const unit = el.dataset.fmt || "";
    const key = el.id.slice(3);
    const n = Number(el.value);
    if (key === "dx") return n === 0 ? "居中" : `${n > 0 ? "右 " : "左 "}${Math.abs(n)} ${unit}`.trim();
    // 垂直同理：0 是「孔心居中」，正数往下，别只给个裸数字
    if (key === "dy") return n === 0 ? "居中" : `${n > 0 ? "下 " : "上 "}${Math.abs(n)} ${unit}`.trim();
    return `${el.value} ${unit}`.trim();
  }

  function islandTuneSheet() {
    const v = islandTuneValue();
    const row = (key, label, hint, min, max, step, value, unit) => `
      <div class="tm-set-row">
        <div class="tm-set-h">
          <span>${label}<span class="desc" style="display:block;font-size:12px;color:var(--label-2);margin-top:2px;font-weight:400">${hint}</span></span>
          <b id="iv-${key}"></b>
        </div>
        <input type="range" id="is-${key}" min="${min}" max="${max}" step="${step}" value="${value}" data-fmt="${unit}" />
      </div>`;
    return `
      <div class="sheet-title">灵动岛</div>
      <div class="sheet-sub">拖动即生效 · 看屏幕顶部</div>
      <div class="tm-set island-set">
        ${row("dx", "水平位置", "以摄像头孔心为 0，正数往右", -200, 200, 2, v.dx, "px")}
        ${row("dy", "垂直位置", "以孔心垂直居中的位置为 0，正数往下", -100, 100, 2, v.dy, "px")}
        ${row("w", "长度", "默认按当前机型算，本机约 378px", 260, 520, 2, v.w || 378, "px")}
        ${row("pad", "上下内边距", "越大胶囊越厚；默认按摄像头孔径比例", 0, 24, 1, v.pad >= 0 ? v.pad : 5, "px")}
      </div>
      <div class="tm-set-note">改完立刻生效并记住。「恢复默认」= 居中、默认长度、留白按孔径自动算。展开成卡片时，形状会从你放的位置平滑回到屏幕中轴，不会左右跳。</div>
      <div class="sheet-footer">
        <button class="btn-ghost" data-island-reset>恢复默认</button>
        <button class="btn-primary" data-close>完成</button>
      </div>`;
  }

  /** 打开面板/重绘后把三个滑块的右侧数值填上（留白是「自动」时不要假装知道像素） */
  function fillIslandLabels() {
    const autoPad = islandTuneValue().pad < 0;
    $$("#sheetBody .island-set input[type=range]").forEach((el) => {
      const out = $("#iv-" + el.id.slice(3));
      if (!out) return;
      out.textContent = (el.id === "is-pad" && autoPad) ? "自动" : islandTuneText(el);
    });
  }

  function openIslandTune() {
    if (!Native || !Native.islandTune) { toast("灵动岛插件未启用"); return; }
    openSheet(islandTuneSheet());
    setTimeout(fillIslandLabels, 30);
  }

  function openTeamLimits() {
    if (!Native || !Native.teamLimits) { toast("团队插件未启用"); return; }
    openSheet(teamLimitsSheet());
    setTimeout(() => {
      $$("#sheetBody .tm-set input[type=range]").forEach((el) => {
        const out = $("#tv-" + el.id.slice(3));
        if (out) out.textContent = teamLimitText(el);
      });
    }, 30);
  }

  let teamLimitTimer = 0;
  function pushTeamLimits() {
    if (!Native || !Native.teamSetLimits) return;
    // 只发画面上真实存在的字段。
    // 以前六个滑块写死在这里，收掉四个之后 `v("maxTokens")` 会拿到 0，
    // 再乘 1000 传给原生 —— 被 clamp 成下限，等于「用户没动，预算被悄悄打到最低」。
    const body = {};
    const put = (key, id, map) => {
      const el = $("#ts-" + id);
      if (el) body[key] = map(Number(el.value));
    };
    put("maxConcurrent", "maxConcurrent", (n) => n);
    put("maxDepth", "maxDepth", (n) => n);
    put("maxMembers", "maxMembers", (n) => n);
    put("maxTasks", "maxTasks", (n) => n);
    clearTimeout(teamLimitTimer);
    teamLimitTimer = setTimeout(() => {
      try {
        const r = JSON.parse(Native.teamSetLimits(teamSid(), JSON.stringify(body)) || "{}");
        if (r.ok) {
          syncTeamLimitsRow(r.limits);
          if (r.warn) toast(r.warn, 2600);
        } else toast(r.error || "保存失败");
      } catch (_) { toast("保存失败"); }
    }, 350);
  }

  const sheetModel = () => `
    <div class="sheet-title">模型</div>
    <div class="sheet-sub">新会话默认</div>
    ${(() => {
      let signed = false;
      try { signed = !!(Native && Native.accountState && JSON.parse(Native.accountState()).signedIn); } catch (_) {}
      if (signed) return "";
      return `<button class="sheet-item plain" id="btnGoAccount">
        <span class="nm">登录 DeepSeek 账号<span class="desc">登录后享受账号额度</span></span>
      </button>`;
    })()}
    <div class="sheet-list">
      ${allModels().map((m) => `
        <div class="sheet-item ${state.model === m.id ? "is-on" : ""}" data-model="${esc(m.id)}" role="button" tabindex="0">
          <span class="nm">${esc(m.name)}<span class="desc">${m.auth === "account"
            ? "账号额度 · 无需密钥"
            : `${esc(m.upstream || m.id)}${m.url ? " · " + esc(hostOf(m.url)) : ""} · ${(m.efforts || []).length} 档`}</span></span>
          <button class="edit" data-edit="${esc(m.id)}">配置</button>
          ${m.builtin ? "" : `<button class="del" data-del="${esc(m.id)}">删除</button>`}
          <svg class="ico check"><use href="#i-check"/></svg>
        </div>`).join("")}
    </div>
    <div class="sheet-list">
      <button class="sheet-item plain" id="btnAddModel">添加模型</button>
    </div>
    <div class="sheet-caption">仅存本机</div>`;

  const sheetModelForm = (id = null, draft = null) => {
    const m = id ? findModel(id) : null;
    state.editingModelId = id;
    const d = draft || {
      name: m ? m.name : "",
      id: m ? m.id : "",
      upstream: m ? (m.upstream || m.id) : "",
      url: m ? (m.url || "") : "",
      key: m ? (m.key || "") : "",
      efforts: m ? (m.efforts || []).join(", ") : DEFAULT_EFFORTS.join(", "),
      ctx: m ? (m.ctx || 0) : 0,
    };
    // 端点自报的上下文长度随表单走：保存时写进模型，之后压缩按它算
    state.editingCtx = Number(d.ctx) || 0;
    return `
    <div class="sheet-title">${m ? "模型配置" : "添加自定义模型"}</div>
    <div class="sheet-sub">端点与模型映射</div>

    <div class="form-section">端点</div>
    <div class="field"><label>显示名称</label><input id="mName" value="${esc(d.name)}" placeholder="例如 Qwen3-235B" autocapitalize="off" /></div>
    <div class="field"><label>API 地址</label><input id="mUrl" value="${esc(d.url)}" placeholder="https://api.example.com/v1" inputmode="url" autocapitalize="off" />
      <div class="field-hint">本机/局域网 http（如 http://192.168.0.99:8090/v1）可直接用；公网 http 会被安全策略拒绝，请改用 https。</div></div>
    ${m && m.auth === "account"
      ? `<div class="field"><label>凭据</label><div class="field-hint" style="margin:0">使用 DeepSeek 账号登录态，不保存密钥；退出登录即失效。</div></div>`
      : `<div class="field"><label>API Key</label><input id="mKey" type="password" value="${esc(d.key)}" placeholder="sk-..." /></div>`}

    <div class="form-section">模型映射</div>
    <div class="field">
      <label>模型（拉取后选择）</label>
      <div class="model-pick">
        <input id="mUpstream" value="${esc(d.upstream)}" placeholder="点击「拉取」选择模型" autocapitalize="off" />
        <button id="btnFetchModels" type="button">拉取</button>
      </div>
      <div class="field-hint">填好 API 地址与 Key，拉取该端点下的全部模型</div>
    </div>
    <div class="field"><label>本地标识（可留空自动生成）</label><input id="mId" value="${esc(d.id)}" placeholder="qwen3" autocapitalize="off" ${m && m.builtin ? "readonly" : ""} /></div>
    <div class="field">
      <label>思考档位（填上游认的标识，逗号分隔；留空 = 不支持）</label>
      <input id="mEfforts" value="${esc(d.efforts)}" placeholder="off, low, high, max（只支持开关的模型写 off, on）" autocapitalize="off" spellcheck="false" />
      <div class="effort-tips">${EFFORT_TOKENS.map((t) => `<button type="button" class="effort-tip" data-effort-tip="${t}">${t}<i>${EFFORT_ZH[t]}</i></button>`).join("")}</div>
      <div class="field-hint">按模型实际支持的档位填写；中文模式只是显示为「关 / 极简 / 低 / 中 / 高 / 很高 / 最高」，发给上游的仍是英文标识。</div>
    </div>
    <div class="sheet-footer">
      <button class="btn-primary" id="btnSaveModel">保存</button>
      <button class="btn-ghost" data-close>取消</button>
    </div>`;
  };
  const sheetAddModel = () => sheetModelForm(null);

  /* ---------------- 额度与用量 ---------------- */

  const balHTML = () => {
    const b = state.balance;
    if (!b) {
      return `<div class="bal-card" id="balBox"><div class="bal-loading">正在查询账户余额…</div></div>`;
    }
    if (!b.ok) {
      // 登录态问题单独给「登录」按钮：余额查不到时用户真正要做的是重新登录，
      // 而不是去平台网页上自己翻账单（后者只是兜底）。
      const needLogin = b.code === "HTTP_401" || b.code === "NOT_SIGNED_IN";
      return `<div class="bal-card" id="balBox">
        <div class="bal-title">账户余额</div>
        <div class="bal-err">${esc(b.error || "查询失败")}</div>
        <div class="bal-sub">${esc(needLogin ? "登录 DeepSeek 账号或填入 API Key 后即可查询" : "可直接到平台查看余额与账单")}</div>
        ${needLogin
          ? `<button class="btn-primary bal-link" id="btnBalLogin">登录 / 重新登录</button>`
          : `<button class="btn-ghost bal-link" id="btnBalRetry">重试</button>`}
        <button class="btn-ghost bal-link" id="btnPlatformUsage">打开平台用量页</button>
      </div>`;
    }
    const list = b.balances || [];
    const main = list.find((x) => x.currency === "CNY") || list[0] || {};
    const sym = main.currency === "USD" ? "$" : "¥";
    const fmt = (v) => {
      const n = Number(v || 0);
      return sym + (Number.isFinite(n) ? n.toFixed(2) : "0.00");
    };
    return `<div class="bal-card" id="balBox">
      <div class="bal-title">账户余额</div>
      <div class="bal-amount">${esc(fmt(main.total))}<i>${esc(main.currency || "CNY")}</i></div>
      <div class="bal-split">
        <span>赠送 ${esc(fmt(main.granted))}</span>
        <span>充值 ${esc(fmt(main.toppedUp))}</span>
      </div>
      ${b.available === false ? `<div class="bal-warn">余额不足，可能无法继续调用</div>` : ""}
    </div>`;
  };

  /** 设置页「额度与用量」行的值：优先账户余额（¥xx.xx），没有余额再退回本机 token 统计。
      rc.108 前这一行的值只在绑定时写一次、且只认本地 token 消耗 ——
      没有本地记录就永远是一条小横杠「—」，即使账号余额明明查得到。 */
  function usageRowText() {
    const b = state.balance;
    if (b && b.ok) {
      const list = b.balances || [];
      const main = list.find((x) => x.currency === "CNY") || list[0] || {};
      const sym = main.currency === "USD" ? "$" : "¥";
      const n = Number(main.total || 0);
      return sym + (Number.isFinite(n) ? n.toFixed(2) : "0.00");
    }
    const t = Usage.totals();
    return t.t ? fmtTokens(t.t) + " tokens" : "—";
  }
  function syncUsageRow() {
    const uv = $("#usageValue");
    if (uv) uv.textContent = usageRowText();
  }

  const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  /** 点选某天后的明细（只读本机账本，不伪造数据） */
  const hmDetailHTML = () => {
    if (!state.heatSel) {
      return `<div class="hm-hint">点任意方块查看当天消耗</div>`;
    }
    const db = Usage.read();
    const day = (db.days || {})[state.heatSel] || null;
    const [y, m, d] = state.heatSel.split("-").map(Number);
    const date = new Date(y, (m || 1) - 1, d || 1);
    const title = `${m}/${d} ${WEEKDAY[date.getDay()]}`;
    const totals = Usage.totals();
    if (!day || !day.t) {
      return `<div class="hm-detail-head"><b>${esc(title)}</b><span class="hm-detail-tag">无记录</span></div>
        <div class="hm-hint">这一天没有调用模型</div>`;
    }
    const share = totals.t ? Math.round((day.t / totals.t) * 1000) / 10 : 0;
    const avg = day.n ? Math.round(day.t / day.n) : 0;
    return `<div class="hm-detail-head"><b>${esc(title)}</b>
        <span class="hm-detail-tag">${fmtTokens(day.t)} tokens</span></div>
      <div class="hm-detail-grid">
        <div><span>输入</span><b>${fmtTokens(day.p || 0)}</b></div>
        <div><span>输出</span><b>${fmtTokens(day.c || 0)}</b></div>
        <div><span>轮次</span><b>${day.n || 0}</b></div>
        <div><span>平均每轮</span><b>${fmtTokens(avg)}</b></div>
      </div>
      <div class="hm-hint">占全部用量 ${share}%${(day.p || 0) && day.c ? ` · 输入输出比 ${Math.round((day.p / Math.max(1, day.c)) * 10) / 10} : 1` : ""}</div>`;
  };

  const heatHTML = () => {
    // 方块尺寸不变（13px + 4px 间距），按面板可用宽度决定排几列 → 铺满整行
    const host = $("#sheetBody");
    const avail = ((host && host.clientWidth) || 360) - 16;
    const cols = Math.max(8, Math.min(30, Math.floor((avail + 4) / 17)));
    const cells = Usage.heat(cols);
    const totals = Usage.totals();
    // 平铺 + CSS 按列排：列数由宽度决定，方块保持 13px；点格子出当天明细
    const cell = (c) => {
      const t = c.date.getMonth() + 1 + "/" + c.date.getDate();
      const sel = state.heatSel === c.k ? " is-sel" : "";
      return `<i class="hm-cell lv${c.level < 0 ? 0 : c.level}${sel}" data-day="${c.k}" title="${t} · ${fmtTokens(c.t)} tokens"></i>`;
    };
    return `<div class="hm-head">
        <span>最近 ${cols} 周</span>
        <span class="hm-sum">${totals.t ? fmtTokens(totals.t) + " tokens" : "暂无记录"}</span>
      </div>
      <div class="hm-wrap"><div class="hm-grid">${cells.map(cell).join("")}</div></div>
      <div class="hm-detail" id="hmDetail">${hmDetailHTML()}</div>
      <div class="hm-legend"><span>少</span><i class="hm-cell lv0"></i><i class="hm-cell lv1"></i><i class="hm-cell lv2"></i><i class="hm-cell lv3"></i><i class="hm-cell lv4"></i><span>多</span></div>
      <div class="hm-meta">${totals.n ? `共 ${totals.n} 轮 · 输入 ${fmtTokens(totals.p)} · 输出 ${fmtTokens(totals.c)} · ${totals.days} 天有记录` : "发一条消息后开始统计；只记 token 数，不记内容"}</div>`;
  };

  const sessionUsageHTML = () => {
    const db = Usage.read();
    const rows = Object.entries(db.sessions || {})
      .map(([id, v]) => ({ id, ...v, title: (LocalDB.get(id) || {}).title || "已删除的会话" }))
      .filter((x) => x.t > 0)
      .sort((a, b) => b.t - a.t)
      .slice(0, 20);
    if (!rows.length) {
      return `<div class="usage-empty">还没有会话消耗记录</div>`;
    }
    const max = rows[0].t || 1;
    return `<div class="usage-list">${rows.map((r) => `
      <div class="usage-row">
        <div class="usage-top">
          <span class="usage-name">${esc(r.title)}</span>
          <span class="usage-num">${fmtTokens(r.t)}</span>
        </div>
        <div class="usage-bar"><i style="width:${Math.max(3, Math.round((r.t / max) * 100))}%"></i></div>
        <div class="usage-sub">${r.n} 轮 · 输入 ${fmtTokens(r.p)} · 输出 ${fmtTokens(r.c)} · ${new Date(r.last || Date.now()).toLocaleDateString("zh-CN")}</div>
      </div>`).join("")}</div>`;
  };

  const sheetUsage = () => {
    const t = Usage.totals();
    return `<div class="sheet-title">额度与用量</div>
      <div class="sheet-sub">账号余额与本机用量</div>
      ${balHTML()}
      <div class="form-section">Token 消耗</div>
      ${heatHTML()}
      <div class="form-section">会话消耗</div>
      ${sessionUsageHTML()}
      <div class="sheet-footer">
        <button class="btn-primary" id="btnRefreshUsage">刷新</button>
        <button class="btn-ghost" data-close>关闭</button>
      </div>`;
  };

  /** 拉余额：账号模式用登录态，API Key 模式用 Bearer；结果异步回填 */
  function refreshBalance() {
    const ep = endpointOf(findModel(state.model));
    if (!Native || !Native.fetchBalance) {
      state.balance = { ok: false, error: "当前环境不支持查询余额" };
      return;
    }
    state.balance = null;
    state.balanceReqId = "bal" + Date.now();
    // reqId 必须在这里捕获：此前超时回调引用了一个不存在的 reqId（全局从未定义），
    // 弱网下 25s 兜底一执行就 ReferenceError，「正在查询账户余额…」永远不换错误卡。
    const reqId = state.balanceReqId;
    try { Native.fetchBalance(state.balanceReqId, ep.url || "", ep.key || ""); } catch (_) {
      state.balance = { ok: false, error: "查询请求发送失败" };
    }
    // 原生侧只有 connectTimeout，管不住 DNS 卡死（弱网/无网时 getaddrinfo 可以挂 30 秒+）。
    // 前端兜底一个总闸：超时把加载态换成错误卡，别让用户对着转圈干等。
    clearTimeout(refreshBalance._timer);
    refreshBalance._timer = setTimeout(() => {
      if (state.balance === null && state.balanceReqId === reqId) {
        state.balance = { ok: false, error: "查询超时（网络不可用或端点无响应）" };
        const box = $("#balBox");
        if (box && sheetOpen) {
          const tmp = document.createElement("div");
          tmp.innerHTML = balHTML();
          box.replaceWith(tmp.firstElementChild);
        }
      }
    }, 25000);
  }

  /** 运行通知：Agent 执行期间的系统通知（不再做厂商胶囊 / 悬浮窗） */
  const sheetNotify = () => {
    let info = null;
    try { info = JSON.parse(Native.notifyInfo()); } catch (_) {}
    if (!info || !info.ok) {
      return `<div class="sheet-title">运行通知</div>
        <div class="sheet-sub">当前环境读不到系统能力（${esc((info && info.error) || "原生桥不可用")}）。</div>
        <button class="btn-ghost" data-close>关闭</button>`;
    }
    const rows = [
      ["通知权限", info.notificationsEnabled ? (info.channelOn ? "已开启" : "渠道已关闭") : "未授权"],
      ["通知渠道", info.channelExists ? "会话运行" : "首次运行时创建"],
      ["前台服务", info.running ? "运行中" : "空闲"],
    ].map(([k, v]) => `<div class="kv-row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("");
    let pw = null;
    try { pw = JSON.parse(Native.powerStatus()); } catch (_) {}
    return `<div class="sheet-title">运行通知</div>
      <div class="sheet-sub">${esc(info.note || "")}</div>
      <div class="kv-list">${rows}</div>
      <div class="capsule-note">
        <b>什么时候会出现</b>
        你在应用里时不打扰（运行态只在界面里显示）。退到桌面或切到别的应用后，通知栏出现进度，
        可随时点「停止」；任务结束会补一条「已完成」，点开直接回到会话。
        需要你确认、或者模型有问题问你时，也会单独提醒一次。
      </div>
      <div class="capsule-note">
        <b>后台运行</b>
        Agent 跑在本应用进程里，退到桌面后要继续执行，需要：前台服务（会话开始即启动）+
        电池优化白名单 + 厂商「应用启动管理」放行。
      </div>
      <div class="kv-list">
        <div class="kv-row"><span>电池优化</span><b>${pw && pw.battery ? "已加入白名单" : "受系统限制"}</b></div>
        <div class="kv-row"><span>前台服务</span><b>${pw && pw.sessionRunning ? "运行中" : "空闲"}</b></div>
      </div>
      <div class="sheet-list">
        <button class="sheet-item plain" id="btnNotifySettings">
          <span class="nm">打开通知设置<span class="desc">可单独开关「会话运行」这个渠道</span></span>
        </button>
        <button class="sheet-item plain" id="btnPowerBattery">
          <span class="nm">加入电池优化白名单<span class="desc">不加入：切后台几分钟后系统会冻结应用</span></span>
        </button>
        <button class="sheet-item plain" id="btnPowerStartup">
          <span class="nm">应用启动管理 → 手动管理<span class="desc">荣耀/华为：允许自启动、关联启动、后台活动</span></span>
        </button>
      </div>
      <button class="btn-ghost" data-close>关闭</button>`;
  };

  /**
   * 设置页「运行通知」那一行的实时状态。
   *
   * 单独抽成函数是因为它必须在**每次页面重新可见时**再读一次：用户按提示跳去
   * 系统通知设置里打开权限，返回 App 时这一行还是旧值（显示「通知已关闭」），
   * 而点进面板又显示已开启 —— 两边对不上，看起来像 bug。notifyInfo 每次都是
   * 实时读系统的，缺的只是刷新时机。
   */
  function syncNotifyRow() {
    const nv = $("#notifyValue");
    if (!nv) return;
    let ni = null;
    try { ni = JSON.parse(Native.notifyInfo()); } catch (_) {}
    const off = !ni || !ni.ok || !ni.notificationsEnabled;
    nv.textContent = !ni || !ni.ok
      ? "—"
      : off ? "通知已关闭"
      : ni.running ? "运行中" : "已开启";
    // 关着的时候给一眼能看出来的颜色，并提示点这行去开
    nv.classList.toggle("is-off", !!off && !!ni && ni.ok);
    const row = $("#rowNotify");
    if (row) row.classList.toggle("is-off", !!off && !!ni && ni.ok);
  }

  const sheetEffort = () => {
    const lv = effortLevel();
    if (!lv) {
      return `<div class="sheet-title">思考强度</div>
        <div class="sheet-sub">${esc(modelLabel())} 未配置思考档位，可在「设置 → 模型 → 配置」中添加。</div>
        <button class="btn-ghost" data-close>关闭</button>`;
    }
    const names = effortsOf();
    const bars = (n) => [1, 2, 3, 4].map((i) => `<i class="${i <= n ? "on" : ""}"></i>`).join("");
    return `
    <div class="sheet-title">思考强度</div>
    <div class="sheet-sub">当前模型 ${esc(modelLabel())} 支持 ${lv.total} 档。</div>

    <div class="effort-head">
      <span class="effort-name" id="effortName">${esc(lv.label)}${EN() ? "" : `<em class="effort-token">${esc(lv.name)}</em>`}</span>
      <span class="effort-step" id="effortStep">档位 ${lv.index + 1} / ${lv.total}</span>
    </div>

    <div class="effort-seg ${lv.total >= 5 ? "dense" : ""}" id="effortSeg" style="grid-template-columns:repeat(${lv.total},1fr)">
      <span class="effort-seg-ind" id="effortSegInd"></span>
      ${names.map((n, i) => `<button data-effort="${i}" class="${i === lv.index ? "on" : ""}">${esc(effortLabel(n))}</button>`).join("")}
    </div>

    <div class="effort-desc" id="effortDesc">
      <b>${esc(lv.label)}</b>${esc(lv.desc)}
      <div class="effort-meta"><span>${esc(lv.est)}</span><span class="effort-bars">${bars(lv.budget)}</span></div>
    </div>`;
  };

  function moveSegInd(seg, ind, index, total) {
    if (!seg || !ind || !total) return;
    if (!MOTION_MODERN) {
      ind.style.width = `calc((100% - 8px) / ${total})`;
      ind.style.left = `calc(4px + (100% - 8px) * ${index} / ${total})`;
      ind.style.transform = "none";
      return;
    }
    // 位移交给 transform：left 固定 4px（padding 内边距），x = 列宽 × 索引（契约 §4 分段控件）
    const w = Math.max(0, (seg.getBoundingClientRect().width - 8) / total);
    ind.style.left = "4px";
    const x = w * index;
    if (!ind.__mPlaced || MOTION_REDUCE()) {   // 首次落位 / 减弱动效：直接写终值
      ind.__mPlaced = true;
      Motion.set(ind, { x, width: w });
      TabHighlight.paint();
      return;
    }
    Motion.springTo(ind, { x, width: w }, { preset: "press", max: 340 });
  }

  function moveEffortInd() {
    const seg = $("#effortSeg");
    const ind = $("#effortSegInd");
    const on = $(".effort-seg button.on");
    if (!seg || !ind || !on) return;
    const sr = seg.getBoundingClientRect();
    const br = on.getBoundingClientRect();
    if (!MOTION_MODERN) {
      // 指示器 CSS 已设 left:4px / 宽度减 8，这里不能再 +4，否则整体右偏
      ind.style.width = Math.max(0, br.width - 8) + "px";
      ind.style.transform = `translateX(${br.left - sr.left}px)`;
      return;
    }
    // CSS 没给 .effort-seg-ind 写 left（绝对定位的静态位置不可靠）→ 这里显式钉 4px，
    // 再按「按钮左边 - container 内边距 4px」算 x，几何上与按钮完全对齐（与上面旧逻辑同一落点）
    ind.style.left = "4px";
    const w = Math.max(0, br.width - 8);
    const x = br.left - sr.left - 4;
    if (!ind.__mPlaced || MOTION_REDUCE()) {
      ind.__mPlaced = true;
      Motion.set(ind, { x, width: w });
      TabHighlight.paint();
      return;
    }
    Motion.springTo(ind, { x, width: w }, { preset: "press", max: 340 });
  }

  function renderEffort() {
    const lv = effortLevel();
    if (!lv) { syncEffortChip(); return; }
    const bars = (n) => [1, 2, 3, 4].map((i) => `<i class="${i <= n ? "on" : ""}"></i>`).join("");
    const name = $("#effortName"); if (name) name.textContent = lv.label;
    const step = $("#effortStep"); if (step) step.textContent = `档位 ${lv.index + 1} / ${lv.total}`;
    const desc = $("#effortDesc");
    if (desc) {
      desc.innerHTML = `<b>${esc(lv.label)}</b>${esc(lv.desc)}
        <div class="effort-meta"><span>${esc(lv.est)}</span><span class="effort-bars">${bars(lv.budget)}</span></div>`;
    }
    $$(".effort-seg button").forEach((b, i) => b.classList.toggle("on", i === lv.index));
    requestAnimationFrame(moveEffortInd);
    syncEffortChip();
  }

  /* ---------------- account ---------------- */
  function persistAccount() {
    if (state.account) localStorage.setItem("dsh.account", JSON.stringify(state.account));
    else localStorage.removeItem("dsh.account");
  }

  const maskKey = (key) => (key ? `sk-••••${key.slice(-4)}` : "");

  function renderAccount() {
    // 有原生 DeepSeek 账号时，顶部账号卡片由 Account.sync() 负责，这里不抢写
    if (Native && Native.accountState) return;
    const a = state.account;
    const name = $("#accName");
    const sub = $("#accSub");
    const action = $("#accAction");
    if (!name) return;
    if (!a) {
      name.textContent = "未登录";
      sub.textContent = "登录后使用 DeepSeek 模型与额度";
      action.textContent = "登录";
    } else {
      name.textContent = a.name || "已登录";
      sub.textContent = a.method === "API Key" && a.masked
        ? `${a.masked} · 仅本机`
        : [a.name, a.method].filter(Boolean).join(" · ");
      action.textContent = "管理";
    }
  }

  const sheetSignIn = () => `
    <div class="sheet-title">登录</div>
    <div class="sheet-sub">仅存本机</div>
    <button class="btn-primary" id="btnOAuthLogin">到 DeepSeek 开放平台获取 API Key</button>
    <button class="btn-ghost" id="btnApiKeyLogin">我已复制，填入 API Key</button>
    <div class="sheet-caption" style="margin-top:10px">粘贴回 App 即可</div>`;

  const sheetApiKey = () => `
    <div class="sheet-title">使用 API Key</div>
    <div class="sheet-sub">兼容网关</div>
    <div class="field"><label>API Key</label><input id="accKey" type="password" placeholder="sk-..." autocapitalize="off" /></div>
    <button class="btn-primary" id="btnSaveKey">保存并启用</button>
    <button class="btn-ghost" data-close>取消</button>`;

  /* 首次启动引导：公开产品的第一个 30 秒。
     只在「本地模型还没就绪（没 key / 没登录态）且用户没选过先逛逛」时出现；
     配好 key 之后这个面板永远不再弹（localReady() 为真即跳过）。 */
  const ONBOARD_KEY = "dsh.onboarded";
  const sheetOnboard = () => `
    <div class="sheet-title">欢迎使用 DSH Mobile</div>
    <div class="sheet-sub">数据留在手机里 · 模型走你自己的端点</div>
    <div class="onboard-step"><b>1</b><span>配置模型：用你的 DeepSeek API Key（或兼容网关），只发给你填的那个地址</span></div>
    <div class="onboard-step"><b>2</b><span>权限按需：语音、通知、无障碍都是在用到对应功能时才申请</span></div>
    <div class="onboard-step"><b>3</b><span>安装包说明：standard（约 76MB）是日常版；complete（约 238MB）内置完整运行环境，进阶用途再选</span></div>
    <button class="btn-primary" id="obKey">去配置 API Key</button>
    <button class="btn-ghost" id="obLater">先逛逛</button>
    <div class="sheet-caption" style="margin-top:10px">数据与权限的完整说明见 PRIVACY.md（仓库）；会话、记忆、工作区全部只存本机</div>`;

  function maybeOnboard() {
    try {
      if (localStorage.getItem(ONBOARD_KEY)) return;
      if (localReady()) { localStorage.setItem(ONBOARD_KEY, "1"); return; }
      openSheet(sheetOnboard());
    } catch (_) { /* localStorage 不可用就不引导，别挡启动 */ }
  }


  const sheetAccountDetail = () => {
    const a = state.account;
    return `
    <div class="sheet-title">账号</div>
    <div class="sheet-sub">${esc(a.name || "已登录")} · ${esc(a.method || "")}</div>
    <div class="sheet-list">
      <div class="sheet-item"><span class="nm">凭据<span class="desc">${esc(a.masked || "浏览器授权")}</span></span></div>
      <div class="sheet-item"><span class="nm">保存位置<span class="desc">仅本机</span></span></div>
    </div>
    <button class="btn-primary" id="btnUsage">查看用量与充值</button>
    <button class="btn-ghost" id="btnSignOut">退出登录</button>
    <div class="sheet-caption" style="margin-top:10px">本地会话保留</div>`;
  };

  const sheetSignOut = () => `
    <div class="sheet-title">退出登录？</div>
    <div class="sheet-sub">本地文件保留</div>
    <button class="btn-primary" id="btnConfirmSignOut" style="background:linear-gradient(170deg,#ff6b60,#ff3b30)">退出登录</button>
    <button class="btn-ghost" data-close>取消</button>`;

  const sheetModelPicker = (models, host) => `
    <div class="sheet-title">选择模型</div>
    <div class="sheet-sub">${esc(host || "")} 返回 ${models.length} 个可用模型</div>
    <div class="sheet-list">
      ${models.map((id) => `
        <button class="sheet-item" data-pick-model="${esc(id)}">
          <span class="nm">${esc(id)}</span>
        </button>`).join("")}
    </div>
    <button class="sheet-item plain" id="btnBackToForm">返回填写</button>`;

  // 下限是硬约束：上下文窗口不低于 128k、单次输出不低于 64k。
  // 低于这个量级时工具 schema + 历史 + 交付物会互相挤占，Agent 会「越跑越傻」，
  // 所以菜单里干脆不提供更小的档位，历史数据也会被下面的 migrate 抬到下限。
  const CONTEXT_FLOOR = 131072;
  const OUT_FLOOR = 65536;
  const CONTEXT_OPTIONS = ["128k", "200k", "1M"];
  const OUT_OPTIONS = ["64k", "128k", "200k"];
  const PERMS = [
    { id: "readonly", name: "只读", desc: "只能读取文件与检索，不写入、不执行" },
    { id: "default", name: "默认权限", desc: "可写工作区；删除与网络需逐次确认" },
    { id: "full", name: "完全访问", desc: "文件可超出工作区读写（仍受系统应用沙箱限制），不再逐条确认" },
  ];
  /* 角色预设。三个字段分工：
       text   结构化设定（角色/输出/语气/禁止）—— 决定"是什么"
       brief  一句话定位 —— 列表副标题 + 轻档注入内容
       sample 示例问答 —— 强档注入，小模型靠模仿比靠理解更有效 */
  const PERSONAS = [
    { id: "", name: "默认", icon: "i-sparkle", tint: "#8e8e95", brief: "严谨、直接的通用助手" },
    {
      id: "sre", name: "SRE 工程师", icon: "i-shield", tint: "linear-gradient(160deg, #ffb055, #f07f00)",
      brief: "先评估影响面与回滚成本，再给动作",
      text: [
        "【角色】你是资深 SRE 工程师，负责线上稳定性。",
        "【关注】故障半径、可观测性、回滚成本、容量与超时。",
        "【输出】先给风险结论（可上线 / 需观察 / 不可上线），再列具体动作，每条动作附回滚方式与验证方法。",
        "【语气】克制、就事论事，不寒暄、不铺垫。",
        "【禁止】不给未经验证的命令；信息不足时直接说缺什么，不要猜。",
      ].join("\n"),
      sample: {
        q: "这个接口超时了怎么办",
        a: [
          "结论：需观察。先定影响面，再动手。",
          "1) 查这个接口的 P99 与错误率，区分「真超时」还是「排队」。验证：对比同集群其他接口。",
          "2) 有熔断就先熔断，回滚方式：恢复上一个版本的超时配置。",
          "3) 缺的信息：最近一次发布时间、变更内容、下游依赖是否同时在抖。",
        ].join("\n"),
      },
    },
    {
      id: "review", name: "代码评审员", icon: "i-term", tint: "linear-gradient(160deg, #7b7bf5, #4a48c8)",
      brief: "先给结论，逐条列问题与改法",
      text: [
        "【角色】你是严格的代码评审员。",
        "【输出】第一行给结论：通过 / 需修改 / 不通过。之后逐条列问题，格式「问题N（严重度）：位置 — 问题 — 改法」，最后给最小改动补丁。",
        "【关注】边界条件、错误处理、并发与资源释放、命名与可读性。",
        "【语气】短句、直说，不复述代码内容。",
        "【禁止】不要泛泛夸奖；确实没问题时明说「无阻塞问题」，再给 1–2 条可选优化。",
      ].join("\n"),
      sample: {
        q: "def add(a, b): return a + b　帮我看看",
        a: [
          "通过。无阻塞问题。",
          "问题1（低）：缺类型标注与边界约定。改法：参数标注类型，并说明 b 不接受 None。",
          "可选：a、b 若可能为字符串，需先做类型校验，否则 1 + \"2\" 会抛 TypeError。",
        ].join("\n"),
      },
    },
    {
      id: "teacher", name: "耐心导师", icon: "i-sparkle", tint: "linear-gradient(160deg, #5fd97f, #21a84a)",
      brief: "一次只讲一层，配最小例子和练习",
      text: [
        "【角色】你是耐心的技术导师。",
        "【方式】先确认对方理解到哪一步，再用一个最小例子推进一层；一次只讲一个新概念。",
        "【输出】先一句话结论，再分步骤解释，最后给一个能立刻动手练的小练习。",
        "【语气】鼓励但准确，不堆术语；必须用术语时当场解释。",
        "【禁止】不要一次倾倒全部知识；不要把练习替对方做完。",
      ].join("\n"),
      sample: {
        q: "什么是闭包",
        a: [
          "一句话：闭包是函数把它出生时所在的那片变量一起带走了。",
          "第 1 步，先看这段：",
          "```python",
          "def outer():",
          "    n = 1",
          "    def inner():",
          "        return n",
          "    return inner",
          "```",
          "第 2 步，inner 被返回之后，n 已经不在视野里了，但 inner 还能读到它 —— 这就是闭包。",
          "练习：把 n 改成 outer 的参数，调用两次 outer(5) 和 outer(9)，猜猜两次结果一样吗。",
        ].join("\n"),
      },
    },
  ];

  const PERSONA_LEVELS = [
    { id: "soft", name: "轻", desc: "只加一句定位，最小改动" },
    { id: "normal", name: "标准", desc: "角色 + 输出格式 + 禁止项" },
    { id: "strong", name: "强", desc: "再加示例对话，小模型也能改口吻" },
  ];

  /** 当前生效的角色正文（预设取 text，自定义取原文） */
  function personaText() {
    const p = PERSONAS.find((x) => x.id === state.persona);
    return p ? p.text : (state.persona || "");
  }

  function personaLabel() {
    const p = PERSONAS.find((x) => x.id === state.persona);
    return p ? p.name : (state.persona ? "自定义" : "默认");
  }

  /**
   * 生成会被注入 system prompt 的角色段落。
   * 三档强度：轻=一句定位；标准=结构化设定；强=设定 + 示例 + 硬性要求。
   * 之前的版本只有「标准」，对 1B 这类小模型约束力弱——它的注意力更吃示例，不吃抽象形容词。
   */
  function personaPrompt() {
    const text = personaText();
    if (!text) return "";
    const p = PERSONAS.find((x) => x.id === state.persona);
    const level = state.personaStrength || "normal";

    if (level === "soft") {
      const one = (p && p.brief) || text.split("\n")[0].replace(/^【[^】]+】/, "");
      return `【角色】${one}\n按这个身份说话，但不要为了扮演而牺牲准确性。`;
    }

    const parts = [
      "【角色设定 · 最高优先级】",
      text,
      "以上设定覆盖默认语气与表达习惯。对话历史里与当前角色不符的旧语气属于旧设定，不要沿用。",
    ];
    if (level === "strong") {
      if (p && p.sample) {
        parts.push("【示例 · 只学口吻与结构，不要复述这个例子】");
        parts.push("用户：" + p.sample.q);
        parts.push("你：" + p.sample.a);
      }
      parts.push(
        "【硬性要求】每条回复都必须是这个角色的口吻：第一句先给该角色的核心判断。" +
        "禁止通用助手开场（如「当然可以」「很高兴为你解答」「这是一个很好的问题」）。",
      );
    }
    return parts.join("\n");
  }

  /** 「1M」不能拿 parseFloat 当数字算（会变成 1k）——统一查真实映射表 */
  const tokenLabel = (o) => {
    const n = TOKEN_LIMIT[o] || 0;
    if (n >= 1048576) return Math.round(n / 1048576 * 10) / 10 + "M";
    return Math.round(n / 1024) + "k";
  };

  const sheetContext = () => `
    <div class="sheet-title">上下文窗口</div>
    <div class="sheet-sub">模型可见的历史上限</div>
    <div class="sheet-list">
      ${CONTEXT_OPTIONS.map((o) => `
        <button class="sheet-item ${state.context === o ? "is-on" : ""}" data-ctx="${o}">
          <span class="nm">${o}<span class="desc">约 ${tokenLabel(o)} tokens 上限</span></span>
          <svg class="ico check"><use href="#i-check"/></svg>
        </button>`).join("")}
    </div>`;

  const sheetMaxOut = () => `
    <div class="sheet-title">最大输出</div>
    <div class="sheet-sub">单次输出上限</div>
    <div class="sheet-list">
      ${OUT_OPTIONS.map((o) => `
        <button class="sheet-item ${state.maxOut === o ? "is-on" : ""}" data-out="${o}">
          <span class="nm">${o}</span>
          <svg class="ico check"><use href="#i-check"/></svg>
        </button>`).join("")}
    </div>`;

  const sheetCompact = () => `
    <div class="sheet-title">上下文压缩</div>
    <div class="sheet-sub">超限时自动省略较早消息</div>
    <div class="sheet-list">
      ${COMPACT_OPTIONS.map((o) => `
        <button class="sheet-item ${state.compactMode === o.id ? "is-on" : ""}" data-compact="${o.id}">
          <span class="nm">${o.name}<span class="desc">${o.desc}</span></span>
          <svg class="ico check"><use href="#i-check"/></svg>
        </button>`).join("")}
    </div>`;

  const sheetPerm = () => `
    <div class="sheet-title">Agent 权限</div>
    <div class="sheet-sub">文件、网络与命令的边界</div>
    <div class="sheet-list">
      ${PERMS.map((o) => `
        <button class="sheet-item ${state.perm === o.id ? "is-on" : ""}" data-perm="${o.id}">
          <span class="nm">${o.name}<span class="desc">${o.desc}</span></span>
          <svg class="ico check"><use href="#i-check"/></svg>
        </button>`).join("")}
    </div>`;

  /* ---------------- 离线语音模型 ---------------- */
  function asrModelInfo() {
    try { return JSON.parse(Native.asrModelStatus()); } catch (_) { return null; }
  }
  const fmtMB = (b) => Math.round((Number(b) || 0) / 1048576) + "MB";
  /** 内置模型随 APK 装机就能用，不占下载、不会被删除 */
  const ASR_BUILTIN_MB = 26;

  /* ---------------- 语音输入插件 ----------------
     两档模型：
       · 标准（内置）26MB 中文流式：装完就能用，边说边出字，这是默认档
       · 增强 SenseVoiceSmall 239MB 中英日韩粤：到插件面板按需下载，录完一次性出字
     开关默认打开（内置模型不占用户流量）；关掉后输入框不出现麦克风按钮。
     增强模型只落在应用私有目录，卸载应用时系统连目录一起删，备份规则也已排除。 */
  const VoicePlugin = {
    KEY: "dsh.voicePlugin",
    _installed: null,
    /** 增强模型是否已下载 */
    installed(force) {
      if (!force && this._installed !== null) return this._installed;
      const info = asrModelInfo();
      this._installed = !!(info && info.installed);
      return this._installed;
    },
    /** 真正可用 = 用户没关掉开关（内置模型始终在包里） */
    on() {
      return localStorage.getItem(this.KEY) !== "0";
    },
    set(v) {
      localStorage.setItem(this.KEY, v ? "1" : "0");
      this._installed = null;
    },
    /** 当前生效的档位文案 */
    label() {
      return this.installed() ? "增强 · SenseVoice" : "标准 · 内置中文";
    },
    apply() {
      const btn = $("#btnMic");
      if (btn) btn.hidden = !this.on();
      const v = $("#pluginValue");
      if (v) v.textContent = Plugins.summary();
    },
  };

  /* ---------------- 语音输出（朗读） ----------------
     什么时候说话，按「像人一样」的直觉定：
       · 日常短回复（没代码、没表格、数字不密集）→ 直接说
       · 用户明确要求（念给我听 / 读出来 / 语音回答）→ 说，哪怕长一点
       · 重要数据、长表格、代码、长篇报告 → 不出声，界面里给一个「朗读」按钮，想听再点
     默认只用设备自带的系统 TTS；也可在「云端语音模型」里填任意厂商的 TTS API。 */
  const SpeechOut = {
    KEY: "dsh.voiceOut",
    RATE_KEY: "dsh.voiceRate",
    on() { return localStorage.getItem(this.KEY) !== "0"; },
    set(v) { localStorage.setItem(this.KEY, v ? "1" : "0"); },
    rate() { return Math.min(2, Math.max(0.6, Number(localStorage.getItem(this.RATE_KEY)) || 1)); },
    setRate(v) { localStorage.setItem(this.RATE_KEY, String(Math.min(2, Math.max(0.6, Number(v) || 1)))); },

    /** 系统 TTS 只有一档「默认」（设备自带音色）；gender 恒为 auto，旧 male/female 偏好归一 */
    GENDER_KEY: "dsh.voiceGender",
    gender() {
      return "auto";
    },
    setGender(v) {
      localStorage.setItem(this.GENDER_KEY, "auto");
      try { if (Native && Native.setVoiceGender) Native.setVoiceGender("auto"); } catch (_) {}
    },
    genderLabel() {
      return this.cloud().usable ? "云端音色" : "默认";
    },

    /**
     * 云端语音模型配置。**唯一真值在原生 SharedPreferences**，前端不另存一份：
     * 以前 localStorage 与原生各记一套偏好，重启后互相覆盖过好几次。
     * 读回来的 JSON 不含密钥明文，只有 hasKey / keyHint。
     */
    cloud() {
      try {
        if (Native && Native.cloudTtsConfig) return JSON.parse(Native.cloudTtsConfig() || "{}");
      } catch (_) {}
      return {};
    },
    cloudSet(cfg) {
      try {
        if (Native && Native.cloudTtsSet) {
          return JSON.parse(Native.cloudTtsSet(JSON.stringify(cfg)) || "{}");
        }
      } catch (_) {}
      return null;
    },
    /** 设置行与面板的文案：当前到底是谁在说话 */
    voiceLabel() {
      const c = this.cloud();
      return c && c.usable ? `云端 ${c.model}` : "系统 TTS";
    },

    /** 原生音色实况：{want, actual, name, fallback, zhCount, cloud} */
    info() {
      try {
        if (Native && Native.voiceInfo) return JSON.parse(Native.voiceInfo() || "{}");
      } catch (_) {}
      return null;
    },
    /** 启动时把「默认」推给原生：老用户存的 male/female 偏好一并归一 */
    syncGender() {
      try {
        if (Native && Native.setVoiceGender) Native.setVoiceGender("auto");
        localStorage.setItem(this.GENDER_KEY, "auto");
      } catch (_) {}
    },
    /** 语音缓存占用（内置模型已移除，不再有随包占用） */
    bytesLabel() {
      const inf = this.info() || {};
      return { cache: fmtMB(inf.cacheBytes || 0) };
    },
    /** 当前五项参数（缺省给中性值） */
    tuning() {
      const inf = this.info() || {};
      return {
        rate: Number(inf.rate) || 1,
        pitch: Number(inf.pitch) || 1,
        volume: inf.volume === undefined ? 1 : Number(inf.volume),
        brightness: inf.brightness === undefined ? 0 : Number(inf.brightness),
        pause: inf.pause === undefined ? 1 : Number(inf.pause),
      };
    },
    /** 只改其中几项，其余保持当前值 —— 五个参数一起传，原生不会把没动的重置掉 */
    applyTuning(patch) {
      const t = Object.assign(this.tuning(), patch || {});
      try {
        if (Native && Native.setVoiceTuning) {
          Native.setVoiceTuning(t.rate, t.pitch, t.volume, t.brightness, t.pause);
        }
      } catch (_) {}
      return t;
    },

    available() { return !!(Native && Native.speak); },
    /** 合成连续失败就自动退回文字：某些机型/模拟器的 TTS 引擎根本不返回音频，
     *  否则每条回复都闪一个失败气泡，比不出声更烦。真机装好语音包后重开开关即可恢复。 */
    degraded: false,
    failStreak: 0,
    stop() { if (this.available()) { try { Native.stopSpeak(); } catch (_) {} } },

    /** Markdown → 适合朗读的纯文本：去代码块/表格/强调/链接/列表符号 */
    plain(markdown) {
      let t = String(markdown || "");
      t = t.replace(/```[\s\S]*?```/g, " ");
      t = t.replace(/`([^`]*)`/g, "$1");
      t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
      t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
      t = t.replace(/^\s*\|.*\|\s*$/gm, " ");
      t = t.replace(/^\s{0,3}#{1,6}\s*/gm, "");
      t = t.replace(/^\s*[-*+]\s+/gm, "");
      t = t.replace(/(\*\*|__|~~|\*|_)/g, "");
      t = t.replace(/\n{3,}/g, "\n\n").trim();
      return t;
    },

    /** 该不该出声（不含用户强制要求的情况） */
    suitable(markdown) {
      const t = this.plain(markdown);
      if (!t) return false;
      if (t.length > 360) return false;                        // 长篇不念，留给人看
      if (/```/.test(String(markdown || ""))) return false;     // 有代码
      if (/^\s*\|/m.test(String(markdown || ""))) return false; // 有表格
      const bullets = (String(markdown || "").match(/\n\s*[-*+]\s+/g) || []).length;
      if (bullets >= 5) return false;                           // 条目太多
      const digits = (t.match(/\d/g) || []).length;
      if (t.length > 40 && digits / t.length > 0.16) return false; // 数字密集＝数据播报
      return true;
    },

    say(text, opts) {
      if (!this.available()) return false;
      const body = this.plain(text).slice(0, 1200);
      if (!body) return false;
      try { Native.speak(body, (opts && opts.rate) || this.rate()); } catch (_) { return false; }
      return true;
    },

    /**
     * 生成一条语音消息气泡（微信式），不自动播放。
     * @param anchorEl 这条回复的气泡元素，语音条插在它下面（footer 之上）
     */
    attachVoiceBubble(markdown, anchorEl, opts) {
      if (!Native || !Native.synthVoice) return;
      const only = !!(opts && opts.only);
      const text = this.plain(markdown);
      if (!text.trim()) return;
      // 气泡先出现（占位），合成完成再补音频：用户感知的是「立刻有反馈」。
      VoiceBubble.spawn({ text, only, anchorEl });
    },

    /**
     * 该用哪种形态回这条消息 —— 这是整套语音输出的核心判断，不用「闲聊就语音」这种一刀切。
     *
     * 判定依据（从强到弱）：
     *  1. 硬性不该出声：代码块、表格、≥5 条清单、数字密集（数据播报）、超过 320 字（长文）、
     *     失败提示、动作执行类回复（要能扫读/复制/照着做）。→ 纯文字
     *  2. 用户明确要求听（"念给我听/语音回答"）：
     *     · 内容适合口述（无上述硬性项）→ 只回语音
     *     · 含数据/步骤（他既想听也要看）→ 文字 + 语音
     *  3. 这条消息本身是语音说的：短、口语、没有数据 → 只回语音（对讲机式，最自然）
     *  4. 其余（键盘打字、普通问答、执行结果）→ 纯文字，底部仍可手动「朗读」
     */
    decide(markdown, ctx) {
      const text = this.plain(markdown);
      const raw = String(markdown || "");
      const forced = !!(ctx && ctx.forced);
      const byVoice = !!(ctx && ctx.byVoice);
      if (!this.on()) return { mode: "text", why: "语音输出已关闭" };
      if (this.degraded && !forced) return { mode: "text", why: "本机语音引擎不出音频，已自动退回文字" };

      // 硬性条件：这些内容只该用眼睛看（放在「正文为空」判断之前，
      // 否则代码块被 plain() 抽掉后正文为空，会误报成「语音输出已关闭」）
      if (/```/.test(raw)) return { mode: "text", why: "含代码，需要照着看" };
      if (/^\s*\|/m.test(raw)) return { mode: "text", why: "含表格" };
      if (!text.trim()) return { mode: "text", why: "没有可朗读的正文" };
      if ((raw.match(/\n\s*[-*+]\s+/g) || []).length >= 5) return { mode: "text", why: "清单太长" };
      if (text.length > 320) return { mode: "text", why: "太长，念出来效率低" };
      if (/失败|错误|异常|超时|无法|失败原因/.test(text.slice(0, 120))) {
        return { mode: "text", why: "失败/异常提示要看清" };
      }
      const digits = (text.match(/\d/g) || []).length;
      const digitHeavy = text.length > 30 && digits / text.length > 0.16;
      if (digitHeavy) {
        return forced
          ? { mode: "both", why: "用户要听，但含较多数字，文字一并保留" }
          : { mode: "text", why: "数字密集，属于数据播报" };
      }

      if (forced) {
        return { mode: byVoice && text.length <= 160 ? "voice" : "both", why: "用户明确要求语音" };
      }
      // 用户是按住语音说的：对讲机式，能说就说（除非内容只适合看）
      if (byVoice && text.length <= 200 && !/\n/.test(text)) {
        return { mode: "voice", why: "对方在用语音说话" };
      }
      // —— 日常交谈的节奏 ——
      // 开着语音输出 ≠ 每句都念。人说话是有来有回的：说完一句，下一句往往就打字了。
      // voiceStreak = 连着用语音回了几轮；只要上一轮出过声，这一轮就让位给文字
      // （除非对方在用语音说、或明确要求念）。这样界面上才会文字/语音交替出现。
      const streak = Number(Live.voiceStreak) || 0;
      if (streak > 0) {
        return { mode: "text", why: "刚说过一句，这条用文字接，像人一样有来有回" };
      }
      const oneLine = !/\n/.test(text);
      const chatty = /[？?！!…]/.test(text) || /你|咱|吧|呢|啊|嘛|啦/.test(text);
      // 没说过话的这一轮，按内容挑形态：极短句必说、短句可说、口语化的一段偶尔说
      if (oneLine && text.length <= 20) {
        return { mode: "voice", why: "一句短话，顺口说出来" };
      }
      if (oneLine && text.length <= 40) {
        return { mode: "voice", why: "短句搭话，说出来更自然" };
      }
      if (oneLine && text.length <= 90 && chatty) {
        return { mode: "voice", why: "口语化的一段，像聊天就说出来" };
      }
      return {
        mode: "text",
        why: streak > 0 ? "刚出过声，这条留文字换换节奏" : "这条更适合看（结构/长度不似闲聊）",
      };
    },

    /**
     * 显式语音输出：合成 wav → 插一条微信式语音条（可重播）。
     * opts.autoPlay：合成好立即播放（陪伴主动开口用 —— 人没看着屏幕也得听见）。
     * 返回语音节点（合成失败也是先有失败气泡），调用方可挂播完回调。
     */
    speakAsVoice(text, rate, opts) {
      if (!Native || !Native.synthVoice) return null;
      const plain = this.plain(text).slice(0, 600);
      if (!plain.trim()) return null;
      const liveMsg = Live.textEl ? Live.textEl.closest(".msg") : null;
      const node = VoiceBubble.spawn({
        text: plain, only: false, anchorEl: liveMsg, rate,
        autoPlay: !!(opts && opts.autoPlay),
      });
      // Agent 主动开口也算「出过声」，下一轮轮末自动语音让位给文字
      Live.voiceStreak = (Number(Live.voiceStreak) || 0) + 1;
      return node || null;
    },

    /** 一轮结束时的自动朗读判定 */
    maybeSay(markdown, force) {
      if (!this.on()) return false;
      if (force) return this.say(markdown);
      if (!this.suitable(markdown)) return false;
      return this.say(markdown);
    },
  };

  /* 语音消息播放：全局只留一个 Audio，点另一条自动切过去 */
  /**
   * 语音条的创建与填充。
   *
   * 关键点：**气泡先出现、音频后到**。合成要 0.5~3 秒（引擎初始化 + 分段合成），
   * 以前这段时间界面上什么都没有，看起来就是「说完话卡住了」。
   * 现在立刻插入一条按时长估宽的占位气泡，合成好再原地换成可播放的。
   */
  const VoiceBubble = {
    /* 异步合成请求表：id -> 回调。原生 synthVoiceAsync 完成时经 DSHHost.onSynth 结算。
       合成在原生后台线程做，JS 线程不再被冻住（页面卡死根因）。 */
    synthWaits: {},
    doSynth(body, rate, cb, attempt) {
      attempt = attempt || 0;
      const finish = (res) => {
        if (res && res.ok === false && res.error === "synth-preparing" && attempt < 45) {
          setTimeout(() => this.doSynth(body, rate, cb, attempt + 1), 220);
          return;
        }
        cb(res || { ok: false });
      };
      if (!Native) { finish({ ok: false, error: "无原生桥" }); return; }
      if (Native.synthVoiceAsync) {
        const id = "sv" + Date.now().toString(36) + Math.random().toString(16).slice(2, 6);
        this.synthWaits[id] = finish;
        try { Native.synthVoiceAsync(id, body.slice(0, 600), rate || 1); }
        catch (e) { delete this.synthWaits[id]; finish({ ok: false, error: String(e) }); }
        return;
      }
      // 旧原生兜底：同步桥（会阻塞 JS 线程，仅在没有异步桥的老包上走）
      let res = { ok: false };
      try { res = JSON.parse(Native.synthVoice(body.slice(0, 600), rate || 1)); } catch (_) {}
      finish(res);
    },
    spawn({ text, only, anchorEl, rate, autoPlay }) {
      const body = String(text || "").trim();
      if (!body || !Native || !Native.synthVoice) return null;
      // 同一轮里同一句话只出一条：Agent 的 speak、轮末自动语音、重试回调
      // 都可能指向同一段文本，全部放行就会出现两条一模一样的语音条。
      const key = body.replace(/\s+/g, "").slice(0, 80);
      if (Live.voiceKeys && Live.voiceKeys.includes(key)) return null;
      Live.voiceKeys = (Live.voiceKeys || []).concat(key);
      Live.voiceShown = true;
      // 时长预估：中文语速约 5 字/秒，只影响占位宽度，合成后以真实时长覆盖
      const estMs = Math.max(1000, Math.round(body.length / 5) * 1000);
      const node = NODES.voice({
        dataUrl: "", durMs: estMs, text: body.slice(0, 2000), only: !!only, pending: true,
      });
      // 纯语音：文字先留着（合成好之后由 applyVoiceOnly 统一折叠）。
      // 先藏后补的做法会让「合成中」和「合成失败」两种状态都变成一片空白。
      node.__anchor = anchorEl || null;
      const tailMsg = currentTurnTail();
      if (anchorEl && anchorEl.parentElement === $("#messages")) {
        anchorEl.insertAdjacentHTML("afterend", nodeHTMLUid(node));
        thread.push(node);
        if (followBottomOn) settleFollow();
      } else if (tailMsg && tailMsg.parentElement === $("#messages")) {
        // 语音条插在尾行之前：插入点在视口上方时视口会被顶走，交给锚定插入器
        insertAnchored(tailMsg, nodeHTMLUid(node));
        thread.push(node);
      } else {
        push(node, true);
      }

      const repaint = () => {
        const el = document.querySelector(`#messages [data-uid="${node.__uid}"]`);
        if (el) el.outerHTML = nodeHTMLUid(node);
      };
      VoiceBubble.doSynth(body, rate || 1, (res) => {
        if (!res || !res.ok) {
          // 真失败：不能悄悄撤掉占位条 —— 用户看到的就是「气泡加载了一下又消失」，
          // 分不清是没开语音、渲染错了还是别的。留下失败态气泡（可点重试）+ 一句明确原因。
          node.pending = false;
          node.expired = true;
          repaint();
          // 记一次失败：连续两次就整体降级成纯文字，别让每条回复都闪一个失败气泡
          SpeechOut.failStreak = (SpeechOut.failStreak || 0) + 1;
          if (SpeechOut.failStreak >= 2) {
            SpeechOut.degraded = true;
            toast("这台设备的语音引擎不出音频，已自动切回文字。装好语音包后重开「语音输出」即可恢复", 4200);
          } else {
            toast("语音合成失败：" + ((res && res.error) || "系统语音引擎没有返回音频") + "，已退回文字", 3200);
          }
          return;
        }
        node.pending = false;
        node.dataUrl = res.dataUrl;
        node.durMs = res.durMs || estMs;
        SpeechOut.failStreak = 0;
        SpeechOut.degraded = false;
        repaint();
        applyVoiceOnly();
        // 陪伴场景要「它说你就听见」：合成好了直接播，不等人点
        if (autoPlay) { try { VoicePlay.playNode(node); } catch (_) {} }
      });
      return node;
    },

    /** 重新生成（快照里没有音频的老语音条，或上次合成失败） */
    regen(node) {
      if (!node || !Native || !Native.synthVoice) return;
      const body = String(node.text || "").trim();
      if (!body) return;
      node.expired = false; node.failed = false; node.pending = true;
      const repaint = () => {
        const el = document.querySelector(`#messages [data-uid="${node.__uid}"]`);
        if (el) el.outerHTML = nodeHTMLUid(node);
      };
      repaint();
      this.doSynth(body, 1, (res) => {
        if (!res || !res.ok) {
          node.pending = false; node.expired = true; repaint(); return;
        }
        node.pending = false; node.dataUrl = res.dataUrl; node.durMs = res.durMs || node.durMs;
        repaint();
        applyVoiceOnly();
      });
    },
  };

  const VoicePlay = {
    audio: null,
    current: null,
    /* 「这一条自然播完了」的一次性回调：陪伴语音回聊用它衔接麦克风。
       只在音频自然 ended 时触发；手动暂停、切换语音条、stopAll 都不算说完。 */
    onEnded: null,
    ensure() {
      if (this.audio) return this.audio;
      this.audio = new Audio();
      this.audio.addEventListener("ended", () => {
        const cb = this.onEnded;
        this.onEnded = null;
        this.reset();
        if (cb) cb();
      });
      this.audio.addEventListener("pause", () => { if (!this.audio.ended) this.mark(false); });
      return this.audio;
    },
    mark(on) {
      const el = this.current;
      if (el) el.closest(".voice-msg")?.classList.toggle("is-playing", !!on);
    },
    reset() {
      this.mark(false);
      this.current = null;
    },
    stopAll() {
      // 手动打断不算「它说完了」：挂起的回聊衔接一并撤销
      this.onEnded = null;
      if (this.audio) { try { this.audio.pause(); } catch (_) {} }
      this.reset();
    },
    /** 程序化播放一条语音气泡（WebView 已关掉自动播放手势限制） */
    playNode(node) {
      if (!node || !node.dataUrl) return;
      const el = document.querySelector(`#messages [data-uid="${node.__uid}"] [data-voice-play]`);
      if (el) this.toggle(node, el);
    },
    toggle(node, el) {
      const a = this.ensure();
      if (this.current === el && !a.paused) { a.pause(); return; }
      if (this.current !== el) {
        this.reset();
        this.current = el;
        a.src = node.dataUrl;
      }
      a.play().then(() => this.mark(true)).catch(() => this.reset());
    },
  };

  /** 用户这句话有没有明确要求「说出来」 */
  function wantsSpeech(text) {
    return /(念给我|读给我|读出来|说出来|说给我听|语音回答|用语音|voice reply|speak (it|this)|read (it|this) aloud)/i
      .test(String(text || ""));
  }

  const sheetPersona = () => {
    const custom = state.persona && !PERSONAS.some((p) => p.id === state.persona);
    const active = PERSONAS.find((p) => p.id === state.persona);
    const lv = state.personaStrength || "normal";
    return `
    <div class="sheet-title">角色设定</div>
    <div class="sheet-sub">${
      state.persona
        ? `当前：${active ? esc(active.name) : "自定义"}，下一条起生效`
        : "未启用，使用默认人格"
    }</div>
    <div class="sheet-list">
      ${PERSONAS.map((o) => `
        <button class="sheet-item ${state.persona === o.id ? "is-on" : ""}" data-persona="${o.id}">
          <span class="mini-ico" style="background:${o.tint}"><svg class="ico"><use href="#${o.icon}"/></svg></span>
          <span class="nm">${o.name}${o.brief ? `<span class="desc">${esc(o.brief)}</span>` : ""}</span>
          <svg class="ico check"><use href="#i-check"/></svg>
        </button>`).join("")}
    </div>
    <div class="group-title" style="margin:12px 2px 6px">生效强度</div>
    <div class="sheet-list">
      ${PERSONA_LEVELS.map((o) => `
        <button class="sheet-item ${lv === o.id ? "is-on" : ""}" data-plv="${o.id}">
          <span class="nm">${o.name}<span class="desc">${esc(o.desc)}</span></span>
          <svg class="ico check"><use href="#i-check"/></svg>
        </button>`).join("")}
    </div>
    <div class="perm-actions">
      <button class="btn-ghost" id="personaPreview">看看模型实际收到什么</button>
    </div>
    <div class="field"><label>自定义角色设定</label><textarea id="personaText" rows="5" placeholder="写清四件事，效果最稳：&#10;1. 你是谁（角色 / 年限 / 领域）&#10;2. 怎么说话（句子长短、是否寒暄、称呼）&#10;3. 输出格式（先给结论还是先解释、要不要列条）&#10;4. 禁止项（不要夸奖、不要猜、不要大段代码…）">${custom ? esc(state.persona) : ""}</textarea></div>
    <button class="btn-primary" id="btnSavePersona">保存</button>`;
  };

  /** 预览：角色段落会占用多少上下文、实际长什么样，都在这里看清楚 */
  const sheetPersonaPreview = () => {
    const ps = personaPrompt();
    const lvName = (PERSONA_LEVELS.find((x) => x.id === (state.personaStrength || "normal")) || PERSONA_LEVELS[1]).name;
    return `
      <div class="sheet-title">注入预览</div>
      <div class="sheet-sub">${esc(personaLabel())} · ${lvName}档 · ${ps.length} 字</div>
      ${ps
        ? `<pre class="mem-preview">${esc(ps)}</pre>`
        : `<div class="mem-empty">当前是默认人格，没有角色段落被注入。</div>`}
      <div class="sheet-caption">拼进 system prompt 的原文，档位越高越费上下文</div>
      <button class="btn-ghost" data-close>关闭</button>`;
  };

  /** 目录里找模型的显示名（电脑会话的面板与 toast 共用） */
  function modelLabelOf(sel) {
    if (!sel || !sel.model) return "电脑上的模型";
    const cat = Link.catalog;
    const hit = cat && (cat.groups || [])
      .flatMap((g) => g.models.map((m) => ({ ...m, provider: g.id })))
      .find((m) => m.id === sel.model && (!sel.provider || m.provider === sel.provider));
    return (hit && hit.name) || sel.model;
  }

  /**
   * 电脑会话的快捷面板。
   *
   * 本机那一套（预设、计划/目标模式、权限档位、附件）在电脑会话里都是无效的，
   * 摆出来只会让人以为能改 —— 所以这里只放真的会打到电脑上的两项：
   * 模型与思考强度（走 controller.selectModel，下一轮请求生效）。
   */
  function sheetPcAgent() {
    const sel = Link.selected || {};
    const cat = Link.catalog;
    const groups = (cat && cat.groups) || [];
    const flat = groups.flatMap((g) => g.models.map((m) => ({ ...m, provider: g.id, providerName: g.name })));
    const current = flat.find((m) => m.id === sel.model && (!sel.provider || m.provider === sel.provider));
    const efforts = (current && current.reasoning && current.reasoning.efforts) || [];
    const head = cat
      ? `<div class="sheet-sub">${esc(modelLabelOf(sel))}${sel.reasoningEffort ? " · " + esc(sel.reasoningEffort) : ""}</div>`
      : `<div class="sheet-sub">正在读取电脑上的模型…</div>`;
    const rows = groups.map((g) => `
      <div class="group-title" style="margin:10px 2px 4px">${esc(g.name)}</div>
      <div class="sheet-list act-group">
        ${g.models.map((m) => `
          <button class="sheet-item ${sel.provider === g.id && sel.model === m.id ? "is-on" : ""}" data-pc-model-set="${esc(g.id)}|${esc(m.id)}">
            <span class="nm">${esc(m.name || m.id)}${m.reasoning ? '<span class="desc">可调思考强度</span>' : ""}</span>
            <svg class="ico check"><use href="#i-check"/></svg>
          </button>`).join("")}
      </div>`).join("");
    const effortBlock = efforts.length
      ? `<div class="group-title" style="margin:14px 2px 4px">思考强度</div>
         <div class="sheet-list act-group">
           <button class="sheet-item ${sel.reasoningEffort ? "" : "is-on"}" data-pc-effort-set="">
             <span class="nm">默认<span class="desc">跟随模型默认档位</span></span>
             <svg class="ico check"><use href="#i-check"/></svg>
           </button>
           ${efforts.map((e) => `
             <button class="sheet-item ${sel.reasoningEffort === e.id ? "is-on" : ""}" data-pc-effort-set="${esc(e.id)}">
               <span class="nm">${esc(e.name || e.id)}${e.description ? `<span class="desc">${esc(e.description)}</span>` : ""}</span>
               <svg class="ico check"><use href="#i-check"/></svg>
             </button>`).join("")}
         </div>`
      : `<div class="sheet-caption" style="margin-top:12px">这个模型没有可调的思考档位</div>`;
    return `
      <div data-pc-model-panel="1">
        <div class="sheet-title">电脑会话</div>
        ${head}
        ${rows || `<div class="sheet-caption">${cat ? "电脑上还没有可用的模型" : "还在读电脑上的模型目录（要逐个 provider 去问，慢十几秒是常态）"}</div>`}
        ${rows ? effortBlock : ""}
        ${rows ? "" : `<button class="btn-ghost" data-pc-model-retry="1">重新读取</button>`}
        <div class="sheet-caption">改完下一轮就生效；这和电脑上那个选择器是同一处设置</div>
        <button class="btn-ghost" data-close>关闭</button>
      </div>`;
  }

  const sheetQuickActions = () => {
    // 电脑会话：这面板里的本机设置对它无效，换成真正能改的那两项
    if (state.pcSession) {
      // 目录回来时用户可能早就关了、或换开了别的 sheet：只有这一块还开着才重画，
      // 否则就是「我明明在看附件面板，屏幕自己跳回模型列表」。
      if (!Link.catalog) Link.models().then(() => {
        if (state.pcSession && document.querySelector("#sheetBody [data-pc-model-panel]")) openSheet(sheetPcAgent());
      });
      return sheetPcAgent();
    }
    const m = Modes.cur();
    const g = m.goal;
    const isMinimal = m.preset === "minimal";
    const goalPhase = !g ? "" : g.phase === "active" ? `进行中 · ${goalRoundLabel(g, (g.rounds || 0) + 1)}`
      : g.phase === "complete" ? "已达成" : g.phase === "blocked" ? "受阻" : "已暂停";
    const presetCard = (pr) => `
      <button class="sheet-item ${m.preset === pr.id ? "is-on" : ""}" data-preset="${pr.id}">
        <span class="nm">${esc(pr.name)}<span class="desc">${esc(pr.desc)}</span></span>
        <span class="row-value" style="margin-left:auto;flex:none">${pr.badge}</span>
        <svg class="ico check"><use href="#i-check"/></svg>
      </button>`;
    return `
    <div class="sheet-title">快捷操作</div>
    <div class="sheet-sub">预设决定工具与工作方式</div>

    <div class="group-title" style="margin:2px 2px 6px">Agent 预设</div>
    <div class="sheet-list act-group">
      ${PRESETS.map(presetCard).join("")}
    </div>
    <div class="sheet-caption" style="margin:-4px 2px 8px">按会话保存，下一轮生效</div>

    <div class="sheet-list act-group">
      <button class="sheet-item ${m.plan && !m.planApproved ? "is-on" : ""}" id="qaPlan" ${isMinimal ? 'data-disabled="1"' : ""}>
        <span class="mini-ico" style="background:rgba(94,92,230,.14)"><svg class="ico" style="color:#5e5ce6"><use href="#i-plan"/></svg></span>
        <span class="nm">计划模式<span class="desc">${isMinimal ? "极简模式不提供计划模式" : "只读探索，提交计划，你批准后才执行"}</span></span>
        <span class="mode-state">${m.plan && !m.planApproved ? "已开启" : ""}</span>
        <svg class="ico check"><use href="#i-check"/></svg>
      </button>
      <button class="sheet-item ${g && g.phase === "active" ? "is-on" : ""}" id="qaGoal" ${isMinimal ? 'data-disabled="1"' : ""}>
        <span class="mini-ico" style="background:rgba(255,149,0,.14)"><svg class="ico" style="color:#ff9500"><use href="#i-goal"/></svg></span>
        <span class="nm">目标模式<span class="desc">${isMinimal ? "极简模式不提供目标模式" : (g ? esc(pageClip(g.objective, 26)) : "设定一个目标，分多轮推进到完成")}</span></span>
        <span class="row-value" style="margin-left:auto">${goalPhase}</span>
      </button>
    </div>

    <div class="effort-seg" id="qaSeg" style="grid-template-columns:repeat(3,1fr)">
      <span class="effort-seg-ind" id="qaSegInd"></span>
      ${PERMS.map((o) => `<button data-quick-perm="${o.id}" class="${state.perm === o.id ? "on" : ""}">${o.name}</button>`).join("")}
    </div>

    <div class="sheet-list" style="margin-top:12px">
      <button class="sheet-item" data-act="sticker">
        <svg class="ico sm" style="color:var(--purple)"><use href="#i-sticker"/></svg>
        <span class="nm">表情包<span class="desc">发送表情 · 从相册图片制作新表情</span></span>
        <span class="row-value" style="margin-left:auto">${Stickers.all().length || ""}</span>
      </button>
      <button class="sheet-item" id="qaAttach">
        <svg class="ico sm" style="color:var(--blue)"><use href="#i-attach"/></svg>
        <span class="nm">上传文件 / 图片</span>
      </button>
      <button class="sheet-item" data-qa-model>
        <svg class="ico sm" style="color:var(--purple)"><use href="#i-cpu"/></svg><span class="nm">模型</span>
        <span class="row-value" style="margin-left:auto">${esc(modelLabel())}</span>
      </button>
      <button class="sheet-item" data-qa-effort>
        <svg class="ico sm" style="color:var(--green)"><use href="#i-level"/></svg><span class="nm">思考强度</span>
        <span class="row-value" style="margin-left:auto">${esc(effortLevel()?.label || "—")}</span>
      </button>
      <button class="sheet-item" data-qa-workspace>
        <svg class="ico sm" style="color:var(--indigo)"><use href="#i-branch"/></svg><span class="nm">工作区</span>
        <span class="row-value" style="margin-left:auto">harness</span>
      </button>
    </div>`;
  };

  /**
   * 快捷面板内的状态就地刷新：权限段、预设勾、计划/目标可用性。
   *
   * 以前这些切换都走 openSheet(sheetQuickActions()) 整块重画 —— 已经打开的面板
   * 会被 openSheet 做一次 120ms 透明度淡入，肉眼就是「点一下整张浮窗闪一下」。
   * 这里只改受影响节点的类名与文案，滑块由 moveSegInd 自然过渡，不重建 DOM。
   */
  function syncQuickActionsUI() {
    const m = Modes.cur();
    const isMinimal = m.preset === "minimal";
    const seg = $("#qaSeg");
    if (seg) {
      $$("#qaSeg [data-quick-perm]").forEach((b) => b.classList.toggle("on", b.dataset.quickPerm === state.perm));
      moveSegInd(seg, $("#qaSegInd"), PERMS.indexOf(PERMS.find((x) => x.id === state.perm)), PERMS.length);
    }
    $$("[data-preset]").forEach((b) => b.classList.toggle("is-on", b.dataset.preset === m.preset));
    const plan = $("#qaPlan");
    if (plan) {
      plan.classList.toggle("is-on", Boolean(m.plan && !m.planApproved));
      if (isMinimal) plan.dataset.disabled = "1"; else delete plan.dataset.disabled;
      const desc = plan.querySelector(".desc");
      if (desc) desc.textContent = isMinimal ? "极简模式不提供计划模式" : "只读探索，提交计划，你批准后才执行";
      const st = plan.querySelector(".mode-state");
      if (st) st.textContent = m.plan && !m.planApproved ? "已开启" : "";
    }
    const goal = $("#qaGoal");
    if (goal) {
      const g = m.goal;
      goal.classList.toggle("is-on", Boolean(g && g.phase === "active"));
      if (isMinimal) goal.dataset.disabled = "1"; else delete goal.dataset.disabled;
      const desc = goal.querySelector(".desc");
      if (desc) desc.textContent = isMinimal ? "极简模式不提供目标模式" : (g ? pageClip(g.objective, 26) : "设定一个目标，分多轮推进到完成");
      const phase = goal.querySelector(".row-value");
      if (phase) {
        phase.textContent = !g ? "" : g.phase === "active" ? `进行中 · ${goalRoundLabel(g, (g.rounds || 0) + 1)}`
          : g.phase === "complete" ? "已达成" : g.phase === "blocked" ? "受阻" : "已暂停";
      }
    }
  }

  /* 目标模式：设定 / 调整 / 结束一个同会话目标 */
  const GOAL_ROUND_OPTS = [
    { v: 0, t: "智能" },
    { v: 3, t: "3 轮" },
    { v: 6, t: "6 轮" },
    { v: 12, t: "12 轮" },
  ];

  const sheetGoal = () => {
    const g = Modes.goal();
    const cap = goalCap(g);
    state.goalRoundsSel = cap;      // 面板打开时的选择，保存时回读
    const custom = cap > 0 && !GOAL_ROUND_OPTS.some((o) => o.v === cap) ? cap : "";
    const phaseText = !g ? "未设置"
      : g.phase === "active" ? "进行中"
      : g.phase === "complete" ? "已达成"
      : g.phase === "blocked" ? "受阻"
      : "已暂停";
    return `
    <div class="sheet-title">目标模式</div>
    <div class="sheet-sub">每轮推进下一步</div>
    <div class="field"><label>目标</label><textarea id="goalText" rows="3" placeholder="例如：把 README 的安装步骤改成可逐步验证的清单，并补一份能跑通的示例">${g ? esc(g.objective) : ""}</textarea></div>

    <div class="group-title" style="margin:12px 2px 6px">追轮方式</div>
    <div class="goal-rounds" id="goalRounds">
      ${GOAL_ROUND_OPTS.map((o) => `<button data-goal-rounds="${o.v}" class="${cap === o.v ? "is-on" : ""}">${o.t}</button>`).join("")}
    </div>
    <div class="field" style="margin-top:10px"><label>自定义轮数（可选）</label><input id="goalRoundsInput" type="number" inputmode="numeric" min="1" max="60" placeholder="例如 20，优先于上面选择" value="${custom}" /></div>
    <div class="sheet-caption" style="margin:-8px 2px 10px">推进到完成为止（上限 ${GOAL_SMART_CAP} 轮）</div>

    <div class="goal-meta">${g ? `状态：${phaseText} · 已推进 ${(g.rounds || 0) + (g.phase === "active" ? 1 : 0)} 轮 · ${cap ? "上限 " + cap + " 轮" : "智能轮数"}${g.summary ? " · " + esc(g.summary) : ""}` : "当前没有目标，写下目标后开始"}</div>
    <button class="btn-primary" id="btnGoalStart">${g ? "保存并继续推进" : "开始目标"}</button>
    ${g ? `
      <button class="btn-ghost" data-goal-act="toggle">${g.phase === "active" ? "暂停目标" : "恢复推进"}</button>
      <button class="btn-ghost" data-goal-act="done">标记已完成</button>
      <button class="btn-ghost" data-goal-act="clear">清除目标</button>` : ""}
    <button class="btn-ghost" data-close>取消</button>`;
  };

  const sheetConfirmFull = () => `
    <div class="sheet-title">开启完全访问？</div>
    <div class="sheet-sub">可能修改或删除数据</div>
    <button class="btn-primary" id="btnConfirmFull" style="background:linear-gradient(170deg,#ff8a3d,#ff6a00)">确认开启</button>
    <button class="btn-ghost" data-close>取消</button>`;

  const sheetLanguage = () => `
    <div class="sheet-title">语言</div>
    <div class="sheet-sub">不改会话内容</div>
    <div class="sheet-list">
      ${LANGS.map((l) => `
        <button class="sheet-item ${state.lang === l.id ? "is-on" : ""}" data-lang="${l.id}">
          <span class="nm">${l.name}</span>
          <svg class="ico check"><use href="#i-check"/></svg>
        </button>`).join("")}
    </div>`;

  /**
   * 新建 / 编辑任务共用的表单。`edit` 传 `{kind:"schedule"|"local", id, ...原记录}`
   * 时进入编辑模式：预填字段、按钮变「保存修改」，保存走 scheduleUpdate / 本地改写。
   * 规则反推：内核规则 JSON → 表单档位（after_seconds→延迟一次，daily→每天，
   * every_seconds→固定间隔，其余/无规则→仅记录）。
   */
  const sheetNewJob = (edit) => {
    const isEdit = !!(edit && edit.id);
    const r = (edit && edit.rule) || null;
    const ruleKey = r
      ? (r.after_seconds ? "once" : r.daily ? "daily" : r.every_seconds ? "every" : "none")
      : (edit ? "none" : "once");
    state.jobRule = ruleKey;
    const dailyTime = r && r.daily && r.daily.time ? String(r.daily.time).replace(/:\d\d$/, "") : "09:00";
    return `
    <div class="sheet-title">${isEdit ? "编辑任务" : "新建任务"}</div>
    <div class="sheet-sub">${isEdit ? "改完即时生效" : "到点发消息"}</div>
    <div class="field"><label>任务名称</label><input id="jobName" value="${esc(edit ? edit.title || "" : "")}" placeholder="例如 每天 9 点生成日报" /></div>
    <div class="field"><label>任务内容（到点发给 Agent 的话）</label><textarea id="jobPrompt" rows="3" placeholder="例如：汇总昨天的工作区改动，生成一份 markdown 日报">${esc(edit ? edit.prompt || "" : "")}</textarea></div>

    <div class="group-title" style="margin:12px 2px 6px">触发方式</div>
    <div class="goal-rounds" id="jobRuleSeg">
      <button data-job-rule="once" class="${ruleKey === "once" ? "is-on" : ""}">延迟一次</button>
      <button data-job-rule="daily" class="${ruleKey === "daily" ? "is-on" : ""}">每天</button>
      <button data-job-rule="every" class="${ruleKey === "every" ? "is-on" : ""}">固定间隔</button>
      ${(!isEdit || edit.kind !== "schedule") ? `<button data-job-rule="none" class="${ruleKey === "none" ? "is-on" : ""}">仅记录</button>` : ""}
    </div>

    <div id="jobRuleFields" style="margin-top:10px">
      <div class="field" data-rule-field="once" style="${ruleKey === "once" ? "" : "display:none"}"><label>多少分钟后触发</label><input id="jobAfterMin" type="number" inputmode="numeric" min="1" value="${r && r.after_seconds ? Math.max(1, Math.round(r.after_seconds / 60)) : 5}" /></div>
      <div class="field" data-rule-field="daily" style="${ruleKey === "daily" ? "" : "display:none"}"><label>每天几点（HH:mm）</label><input id="jobDailyTime" placeholder="09:00" value="${esc(dailyTime)}" /></div>
      <div class="field" data-rule-field="every" style="${ruleKey === "every" ? "" : "display:none"}"><label>间隔分钟数（至少 1）</label><input id="jobEveryMin" type="number" inputmode="numeric" min="1" value="${r && r.every_seconds ? Math.max(1, Math.round(r.every_seconds / 60)) : 60}" /></div>
      <div class="field" data-rule-field="none" style="${ruleKey === "none" ? "" : "display:none"}"><label>说明（可选）</label><input id="jobDesc" value="${esc(edit ? edit.note || "" : "")}" placeholder="范围、标准、注意事项…" /></div>
    </div>

    <button class="btn-primary" id="btnCreateJob">${isEdit ? "保存修改" : "创建任务"}</button>
    <button class="btn-ghost" data-close>取消</button>`;
  };

  // WORKSPACES 在会话列表那段定义：切换默认工作区后，新建会话就落到这个工作区里
  const sheetWorkspace = () => `
    <div class="sheet-title">工作区</div>
    <div class="sheet-sub">仅此目录</div>
    <div class="sheet-list">
      ${WORKSPACES.map((w) => `
        <button class="sheet-item ${state.workspace === w.id ? "is-on" : ""}" data-ws="${w.id}">
          <span class="nm">${w.name}<span class="desc">${w.desc}</span></span>
          <svg class="ico check"><use href="#i-check"/></svg>
        </button>`).join("")}
    </div>`;

  /* ---------------- 存储与落点 ----------------
     工作站得让用户看得见自己占了多少、东西落在哪。数字来自内核现场遍历，
     这里只排版；唯一的删除动作是溢出缓存（可再生），其余都是用户的东西。 */

  const fmtBytes = (n) => {
    const v = Number(n) || 0;
    if (v < 1024) return v + " B";
    const kb = v / 1024;
    if (kb < 1024) return (kb < 10 ? kb.toFixed(1) : Math.round(kb)) + " KB";
    const mb = kb / 1024;
    if (mb < 1024) return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + " MB";
    return (mb / 1024).toFixed(mb / 1024 < 10 ? 2 : 1) + " GB";
  };

  function storageStat() {
    try {
      if (!(Native && Native.storageStat)) return null;
      const s = JSON.parse(Native.storageStat() || "null");
      return s && Array.isArray(s.items) ? s : null;
    } catch (_) { return null; }
  }

  function refreshStorageRow() {
    const el = document.getElementById("storageValue");
    if (!el) return;
    const s = storageStat();
    if (!s) { el.textContent = "内核未就绪"; return; }
    const spill = (s.items || []).find((x) => x.key === "spill");
    el.textContent = fmtBytes(s.free) + " 可用" + (spill && spill.bytes ? " · 溢出缓存 " + fmtBytes(spill.bytes) : "");
  }

  function sheetStorage() {
    const s = storageStat();
    if (!s) {
      return `<div class="sheet-title">存储与落点</div>
        <div class="sheet-sub">内核还没起来，读不到占用数字。</div>
        <button class="btn-ghost" data-close>关闭</button>`;
    }
    const rows = (s.items || []).map((it) => `
      <div class="sheet-item is-plain">
        <span class="nm">${esc(it.label)}<span class="desc">${esc(it.note || "")}</span></span>
        <span class="row-value">${fmtBytes(it.bytes)}${it.cap ? " / " + fmtBytes(it.cap) : ""}</span>
        ${it.cleanable && it.bytes > 0 ? `<button class="edit" data-storage-clear="${esc(it.key)}">清理</button>` : ""}
      </div>
      ${it.warn ? `<div class="sheet-caption" style="color:var(--orange);padding:0 13px 10px">${esc(it.warn)}</div>` : ""}`).join("");
    return `
      <div class="sheet-title">存储与落点</div>
      <div class="sheet-sub">工作区 ${esc(s.root || "")} · 设备剩余 ${fmtBytes(s.free)} / 共 ${fmtBytes(s.total)}</div>
      <div class="sheet-list">${rows}</div>
      <div class="sheet-caption">长输出落在 .dsh/spill，模型能分页读回。没标上限的是你自己的数据，不自动清；要减占用请在会话列表里删。</div>
      <div class="sheet-caption">占用为 0 的项没有清理按钮。</div>
      <button class="btn-ghost" data-storage-clear-all>清理可清理项</button>
      <button class="btn-ghost" data-close>关闭</button>`;
  }

  /* 内核插件面板：工具目录由原生插件注册表决定，关掉插件=它的工具立刻不可用。
     语音输入也挂在这里——它是可选能力，不是一个永远开着的功能。 */
  /* ---------------- 插件面板（声明式） ----------------
     面板长什么样由数据决定，不再由渲染函数决定：
     加一个插件 = 在 PANELS 里加一条声明（或由内核 pluginList 动态产生行），
     图标、间距、文字层级全部复用同一套行模板。
     行类型：
       info     只读一行（label + desc）
       switch   开关（id 或 attr 绑定；on 为当前状态）
       action   右侧按钮（id + act + tone）
       progress 进度条（pct 0..100）
       caption  小字说明（放在列表外）
     tone：primary | danger | plain
  */
  const PLUGIN_ROW = {
    info: (r) => `
      <div class="sheet-item plugin-row">
        <span class="nm" style="padding-left:2px">${esc(r.label)}${r.desc ? `<span class="desc">${esc(r.desc)}</span>` : ""}</span>
      </div>`,
    switch: (r) => `
      <div class="sheet-item plugin-row">
        ${r.icon ? `<span class="mini-ico" style="background:${r.tint || "rgba(0,122,255,.14)"}"><svg class="ico" style="color:${r.fg || "var(--blue)"}"><use href="#${r.icon}"/></svg></span>` : ""}
        <span class="nm" ${r.icon ? "" : 'style="padding-left:2px"'}>${esc(r.label)}${r.desc ? `<span class="desc">${esc(r.desc)}</span>` : ""}</span>
        <label class="switch" style="margin-left:auto"><input type="checkbox" ${r.id ? `id="${esc(r.id)}"` : ""} ${r.attr || ""} ${r.on ? "checked" : ""}/><i></i></label>
      </div>`,
    action: (r) => `
      <div class="sheet-item plugin-row">
        <span class="nm" style="padding-left:2px">${esc(r.label)}${r.desc ? `<span class="desc">${esc(r.desc)}</span>` : ""}</span>
        <button class="mem-act ${r.tone || "plain"}" ${r.id ? `id="${esc(r.id)}"` : ""} style="margin-left:auto">${esc(r.act)}</button>
      </div>`,
    progress: (r) => {
      const pct = Math.max(0, Math.min(100, Number(r.pct) || 0));
      return `
      <div class="sheet-item plugin-row">
        <span class="nm" style="padding-left:2px">${esc(r.label)}${r.desc ? `<span class="desc">${esc(r.desc)}</span>` : ""}</span>
      </div>
      <div style="padding:0 14px 12px"><div class="asr-progress"><i style="width:${pct}%"></i></div></div>`;
    },
  };
  const renderPluginRows = (rows) => (rows || []).map((r) => (PLUGIN_ROW[r.type] || PLUGIN_ROW.info)(r)).join("");

  /** 语音插件的声明：状态全部来自 VoicePlugin + 当前下载进度 */
  function voicePluginPanel() {
    const dl = state.asrDl;
    const info = asrModelInfo() || {};
    const pct = dl && dl.total ? Math.min(100, Math.round((dl.done / dl.total) * 100)) : 0;
    const inst = VoicePlugin.installed(true);
    const on = VoicePlugin.on();

    const rows = [{
      type: "switch", id: "swVoicePlugin", icon: "i-mic",
      tint: "rgba(48,209,88,.14)", fg: "#1f8f3d",
      label: "语音输入",
      desc: `完全离线，不联网 · 当前 ${VoicePlugin.label()}`,
      on,
    }, {
      type: "switch", id: "swVoiceOut", icon: "i-mic",
      tint: "rgba(94,92,230,.14)", fg: "#4b48d6",
      label: "语音消息",
      desc: SpeechOut.on()
        ? "已开启：闲聊回复会是语音消息（点开即播）；代码/表格/数据/长文仍用文字"
        : "已关闭：全部用文字回复（每条回复底部仍可手动朗读）",
      on: SpeechOut.on(),
    }, {
      type: "action", id: "cloudTts",
      label: "云端语音模型",
      desc: SpeechOut.cloud().usable
        ? `已启用 ${SpeechOut.cloud().model} · 请求失败自动回退系统 TTS`
        : "未配置 · 只用设备自带的系统 TTS",
      act: "配置",
    }, {
      type: "action", id: "voiceGender",
      label: "语音音色",
      desc: `当前 ${SpeechOut.voiceLabel()} · 点这里换或微调`,
      act: SpeechOut.genderLabel(),
    }];
    if (inst) {
      rows.push({
        type: "action", id: "asrRemove", tone: "danger", act: "删除",
        label: "增强模型 · SenseVoice",
        desc: `中英日韩粤混说 · 占用 ${fmtMB(info.bytes)} · 卸载应用时随之删除`,
      });
    } else if (dl) {
      rows.push({
        type: "progress", label: "正在下载增强模型",
        desc: `${pct}% · ${fmtMB(dl.done)} / ${fmtMB(dl.total)}`, pct,
      });
    } else {
      rows.push({
        type: "action", id: "asrDownload", tone: "primary", act: "下载",
        label: "增强模型 · SenseVoice",
        desc: `可选 ${fmtMB(info.total)} · 中英日韩粤混说、准确率更高`,
      });
    }

    const caption = on
      ? (inst
        ? "增强模型已启用：点麦克风开始说，再点一下结束，松手后整段识别（非流式，没有边说边出字）。"
        : `内置中文模型 ${ASR_BUILTIN_MB}MB 已随应用安装，边说边出字；说英文术语多的时候建议下增强模型。`)
      : "关闭状态下输入框没有麦克风按钮；两个模型都不会删除，下次开启不用重新准备。";
    return { rows, caption };
  }

  /** 内核插件（含外部清单插件）→ 通用的开关行，不写死任何一种插件 */
  function kernelPluginRows(d) {
    return (d.plugins || []).map((p) => ({
      type: "switch",
      attr: `data-plugin-toggle="${esc(p.id)}"`,
      icon: "i-layers",
      tint: p.builtin ? "rgba(0,122,255,.14)" : "rgba(255,149,0,.14)",
      fg: p.builtin ? "var(--blue)" : "var(--orange)",
      label: p.name,
      desc: `${p.description || ""} · ${(p.tools || []).length ? p.tools.length + " 个工具" : "纯能力插件"}${p.builtin ? "" : " · 外部 v" + (p.version || "")}`,
      on: p.enabled,
    }));
  }

  /**
   * 音色面板：只列这台设备里真实存在的中文音色。
   *
   * 云端音色（云希/晓晓）已经整条移除 —— 它一失败就回落系统女声，
   * 让人以为「选了男声没生效」。现在每一条都能立刻试听，点了就是它。
   */
  /* ---------------- 锚定浮窗 ----------------
     面板（sheet）适合「一屏设置」，但换个音色这种动作只值一个小气泡：
     点哪弹哪、选完就收，不遮住整页。 */
  let popEl = null;

  function closePopover() {
    if (!popEl) return;
    const M = window.Motion;
    const modern = !!(M && !M.legacy);
    const el = popEl;
    popEl = null;   // 先置空防重入：连续关闭时第二次调用直接返回
    document.removeEventListener("pointerdown", popOutside, true);
    window.removeEventListener("resize", closePopover);
    if (!modern) {
      // 旧行为：is-closing 播 160ms 淡出动画，播完再从 DOM 摘掉
      el.classList.add("is-closing");
      setTimeout(() => el.remove(), 170);
      return;
    }
    // 退场：朝落位方向收回去（下方展开就往上收、上方展开就往下收）
    const dir = el.__popDir || -1;
    p2Own(el, true);
    el.style.pointerEvents = "none";
    M.springTo(el, { opacity: 0, scale: 0.97, y: dir * 4 }, {
      preset: "exit",
      max: 220,
      onComplete: () => el.remove(),
    });
    // 保险：弹簧没走完（切后台 / 元素被换掉）也要摘节点，避免快速开关留下残影
    setTimeout(() => { if (el.parentNode) el.remove(); }, 400);
  }

  function popOutside(e) {
    if (popEl && !popEl.contains(e.target)) closePopover();
  }

  function openPopover(anchorEl, html) {
    const M = window.Motion;
    const modern = !!(M && !M.legacy);
    closePopover();
    // 连点/换锚点：上一枚还在退场的节点立刻摘掉，任何时刻只保留一个浮窗
    // （退场只有 220ms，但 30ms 一次的连点能叠出 4~5 个节点；换锚点时旧的也不该继续淡出）
    document.querySelectorAll(".popover").forEach((n) => n.remove());
    const el = document.createElement("div");
    el.className = "popover";
    el.innerHTML = html;
    // 入场由弹簧驱动：先把 CSS 的 pop-in 关键帧摘掉，否则关键帧会盖过内联 transform
    if (modern) p2Own(el, true);
    document.body.appendChild(el);
    popEl = el;

    const r = anchorEl.getBoundingClientRect();
    const w = Math.min(310, window.innerWidth - 24);
    el.style.width = w + "px";
    const left = Math.min(Math.max(12, r.left + r.width / 2 - w / 2), window.innerWidth - w - 12);
    el.style.left = left + "px";

    // 高度上限按可用空间算：状态栏下面到屏幕底部留 12px。
    // 之前固定 76vh，小屏上内容一多，底部的「试听」就被裁在滚动区外。
    const topLimit = 44;
    const avail = window.innerHeight - topLimit - 12;
    el.style.maxHeight = Math.min(avail, 660) + "px";

    // 默认贴在按钮下方；下面放不下就翻到上方（但不要越过状态栏）
    const h = Math.min(el.offsetHeight, avail);
    const below = r.bottom + 8;
    const flipUp = below + h > window.innerHeight - 12;
    if (flipUp) {
      el.style.top = Math.max(topLimit, r.top - 8 - h) + "px";
    } else {
      el.style.top = Math.max(topLimit, below) + "px";
    }
    // 落位：下方展开 = 从顶部往下长（原点 top，起点略偏锚点上方）；
    // 翻到上方展开 = 从底部往上长（原点 bottom，起点略偏锚点下方）。退场按反方向收。
    const dir = flipUp ? 1 : -1;
    el.__popDir = dir;
    if (modern) {
      el.style.transformOrigin = flipUp ? "bottom center" : "top center";
      M.set(el, { opacity: 0, scale: 0.94, y: dir * 6 });
      M.springTo(el, { opacity: 1, scale: 1, y: 0 }, { preset: "bouncy", max: 300 });
    }
    // 点外面关；延迟一帧再挂，否则这次点击会立刻把它关掉
    setTimeout(() => document.addEventListener("pointerdown", popOutside, true), 0);
    window.addEventListener("resize", closePopover);
  }

  /** 音色快选浮窗：系统 TTS 与云端模型两档，点一下立刻切换 */
  function openVoicePopover(anchorEl) {
    const tune = SpeechOut.tuning();
    const c = SpeechOut.cloud();
    const cloudOn = !!c.usable;
    const html = `
      <div class="pop-title">音色</div>
      <button class="pop-item ${cloudOn ? "" : "is-on"}" data-voice-system="1">
        <span class="pop-nm">系统 TTS<i>设备自带 · 离线</i></span>
        <svg class="ico check"><use href="#i-check"/></svg>
      </button>
      <button class="pop-item ${cloudOn ? "is-on" : ""}" data-voice-cloud="1">
        <span class="pop-nm">${esc(c.model || "云端语音模型")}<i>${cloudOn ? "已配置 · 点这里可改" : "未配置 · 点这里配置"}</i></span>
        <svg class="ico check"><use href="#i-check"/></svg>
      </button>
      <div class="pop-sep"></div>
      <div class="pop-tune">
        <span class="pop-tune-k">语速</span>
        <input type="range" id="popRate" min="0.4" max="2.2" step="0.02" value="${tune.rate}" />
        <b class="pop-tune-v" data-for="popRate">${tune.rate.toFixed(2)}</b>
      </div>
      <div class="pop-tune">
        <span class="pop-tune-k">明亮</span>
        <input type="range" id="popBright" min="-1" max="1" step="0.05" value="${tune.brightness}" />
        <b class="pop-tune-v" data-for="popBright">${tune.brightness.toFixed(2)}</b>
      </div>
      <div class="pop-actions">
        <button class="pop-link" id="popVoiceTest">试听</button>
        <button class="pop-link" id="popVoiceAll">更多设置…</button>
      </div>`;
    openPopover(anchorEl, html);
    const el = popEl;
    const speakNow = () => { try { if (Native && Native.speak) Native.speak(VOICE_SAMPLE, 1); } catch (_) {} };

    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-voice-system]")) {
        SpeechOut.cloudSet(Object.assign({}, SpeechOut.cloud(), { enabled: false, apiKey: "" }));
        haptic("light"); openVoicePopover(anchorEl); speakNow(); return;
      }
      if (e.target.closest("[data-voice-cloud]")) {
        if (!SpeechOut.cloud().usable) { closePopover(); openSheet(sheetCloudTts()); return; }
        SpeechOut.cloudSet(Object.assign({}, SpeechOut.cloud(), { enabled: true, apiKey: "" }));
        haptic("light"); openVoicePopover(anchorEl); speakNow(); return;
      }
      if (e.target.closest("#popVoiceTest")) { speakNow(); return; }
      if (e.target.closest("#popVoiceAll")) { closePopover(); openSheet(sheetVoiceGender()); return; }
    });

    el.addEventListener("input", (e) => {
      const hit = e.target.closest("#popRate, #popBright");
      if (!hit) return;
      const label = el.querySelector(`.pop-tune-v[data-for="${hit.id}"]`);
      if (label) label.textContent = Number(hit.value).toFixed(2);
    });
    el.addEventListener("change", (e) => {
      const map = { popRate: "rate", popBright: "brightness" };
      const key = Object.keys(map).find((id) => e.target.closest("#" + id));
      if (!key) return;
      SpeechOut.applyTuning({ [map[key]]: Number(e.target.value) });
      speakNow();
    });
  }

  /* ---------------- 云端语音模型（用户填任意厂商的 TTS API） ----------------
     主配置只有三项：地址 / 密钥 / 模型名，和语言模型一致。
     TTS 接口多一个 voice 参数，各家字段又不一样，所以音色与请求体模板收进「高级」。 */

  const sheetCloudTts = () => {
    const c = SpeechOut.cloud();
    const adv = `
      <div class="field"><label>音色 voice</label><input id="ctVoice" value="${esc(c.voice || "")}" placeholder="alloy" autocapitalize="off" />
        <div class="field-hint">标准 /v1/audio/speech 必填；厂商把音色绑在模型里就留空</div></div>
      <div class="field"><label>请求体模板（可选）</label><textarea id="ctBody" rows="3" spellcheck="false" placeholder='{"model":"$model","input":"$text","voice":"$voice"}'>${esc(c.bodyTemplate || "")}</textarea>
        <div class="field-hint">占位符 $text / $model / $voice / $speed；留空按标准 JSON 发</div></div>
      <div class="field"><label>额外请求头（可选，JSON）</label><textarea id="ctHeaders" rows="2" spellcheck="false" placeholder='{"X-App-Id":"42"}'>${esc(c.extraHeaders || "")}</textarea></div>`;
    return `
    <div class="sheet-title">云端语音模型</div>
    <div class="sheet-sub">没配置或请求失败，都自动用系统 TTS</div>
    <div class="sheet-list">
      <div class="sheet-item is-plain"><span class="nm">启用云端语音</span>
        <label class="switch" style="margin-left:auto"><input type="checkbox" id="ctEnabled" ${c.usable ? "checked" : ""}/><i></i></label>
      </div>
    </div>
    <div class="form-section">接口</div>
    <div class="field"><label>API 地址</label><input id="ctUrl" value="${esc(c.endpoint || "")}" placeholder="https://api.example.com/v1/audio/speech" inputmode="url" autocapitalize="off" /></div>
    <div class="field"><label>API Key</label><input id="ctKey" type="password" value="" placeholder="${c.hasKey ? "已保存 " + esc(c.keyHint || "") + " · 留空不改" : "sk-... · 可留空"}" autocapitalize="off" /></div>
    <div class="field"><label>模型名</label><input id="ctModel" value="${esc(c.model || "")}" placeholder="厂商给的模型名" autocapitalize="off" /></div>
    <details class="cloud-adv"><summary>高级（音色 / 自定义请求体）</summary>${adv}</details>
    ${c.error ? `<div class="sheet-caption" style="color:var(--red)">上次失败：${esc(c.error)}</div>` : ""}
    <div class="sheet-footer">
      <button class="btn-primary" id="btnCloudSave">保存</button>
      <button class="btn-ghost" id="btnCloudTest">保存并试听</button>
      <button class="btn-ghost" id="btnCloudOff">只用系统 TTS</button>
      <button class="btn-ghost" data-close>取消</button>
    </div>`;
  };

  /** 音色面板：系统 TTS（默认一档）+ 云端模型入口 + 微调 */
  const sheetVoiceGender = () => {
    const tune = SpeechOut.tuning();
    const bytes = SpeechOut.bytesLabel();
    const c = SpeechOut.cloud();
    return `
    <div class="sheet-title">语音音色</div>
    <div class="sheet-list">
      <button class="sheet-item ${c.usable ? "" : "is-on"}" data-sheet-voice-system="1">
        <span class="nm">系统 TTS<span class="desc">设备自带音色，离线可用</span></span>
        <svg class="ico check"><use href="#i-check"/></svg>
      </button>
      <button class="sheet-item ${c.usable ? "is-on" : ""}" data-cloud-edit="1">
        <span class="nm">${esc(c.model || "云端语音模型")}<span class="desc">${c.usable ? "已启用，点这里改配置" : "填地址 / 密钥 / 模型名即可用云端声音"}</span></span>
        <svg class="ico check"><use href="#i-check"/></svg>
      </button>
    </div>

    <div class="group-title" style="margin:14px 2px 4px">微调</div>
    <div class="voice-tuning">
      <label><span>语速 <i>慢 ↔ 快</i></span><b id="vtRateVal">${tune.rate.toFixed(2)}×</b>
        <input type="range" id="vtRate" min="0.4" max="2.2" step="0.02" value="${tune.rate}" />
      </label>
      <label><span>明亮度 <i>闷 ↔ 通透，越高字头越清楚</i></span><b id="vtBrightVal">${tune.brightness.toFixed(2)}</b>
        <input type="range" id="vtBright" min="-1" max="1" step="0.05" value="${tune.brightness}" />
      </label>
      <label><span>音量 <i>只影响语音，不改系统音量</i></span><b id="vtVolumeVal">${Math.round(tune.volume * 100)}%</b>
        <input type="range" id="vtVolume" min="0.2" max="1" step="0.02" value="${tune.volume}" />
      </label>
      <label><span>句间停顿 <i>紧凑 ↔ 从容</i></span><b id="vtPauseVal">${tune.pause.toFixed(2)}×</b>
        <input type="range" id="vtPause" min="0.5" max="2" step="0.02" value="${tune.pause}" />
      </label>
    </div>
    <div class="sheet-caption">松手即生效。语音缓存 ${bytes.cache}（上限 20MB，可清空）</div>
    <button class="btn-ghost" id="btnVoiceTest">试听一句</button>
    <button class="btn-ghost" id="btnVoiceCacheClear">清空语音缓存</button>`;
  };

  /** 倍率 → 半音数（0 表示原样，-8 就是低八个半音） */
  const semiOf = (p) => (12 * Math.log2(Math.max(0.05, Number(p) || 1))).toFixed(1);

  /** 试听说什么：短、能听出音色，且带点语气词，比念设备名自然 */
  const VOICE_SAMPLE = "你好呀，我是你的助手。今天的天气不错，要不要一起做点什么？";

  /** 陪伴式畅聊：开关 + 节奏 + 免打扰 + 风格（状态在原生 companion.json，与插件共用一份） */
  const sheetCompanion = () => {
    const c = Companion.cfg();
    const cad = Companion.cad();
    const diag = Companion.diag();
    const rows = [{
      type: "switch", id: "swCompanion", icon: "i-chat",
      tint: "rgba(214,51,108,.12)", fg: "#d6336c",
      label: "陪伴式畅聊",
      desc: c.enabled ? `到点会有机会开口 · ${cad.name}：${cad.desc}` : "关闭时它只在你说话之后回应",
      on: c.enabled,
    }, {
      type: "switch", id: "swCompanionVoice", icon: "i-mic",
      tint: "rgba(214,51,108,.12)", fg: "#d6336c",
      label: "语音回聊",
      desc: c.voiceReply
        ? "它说完自动出声，播完接麦听你回一句（识别完自动发送）"
        : "它说完不出声；想回就长按输入框说话",
      on: !!c.voiceReply,
    }, {
      type: "action", id: "cpTry",
      label: "现在聊一句",
      desc: "手动触发一次心跳，看看它会说什么（不会计入节流）",
      act: "试试",
    }];
    return `
    <div class="sheet-title">陪伴式畅聊</div>
    <div class="sheet-sub">到点才说话</div>
    <div class="sheet-list">${renderPluginRows(rows)}</div>

    <div class="group-title" style="margin:14px 2px 8px">节奏</div>
    <div class="sheet-list">
      ${Object.entries(Companion.CADENCE).map(([id, v]) => `
        <button class="sheet-item ${c.cadence === id ? "is-on" : ""}" data-cp-cadence="${id}">
          <span class="nm">${v.name}<span class="desc">${v.desc} · 每天最多 ${v.cap} 次</span></span>
          <svg class="ico check"><use href="#i-check"/></svg>
        </button>`).join("")}
    </div>

    <div class="group-title" style="margin:14px 2px 8px">免打扰</div>
    <div class="sheet-list">
      ${[["23", "8", "23:00 – 08:00"], ["22", "7", "22:00 – 07:00"], ["0", "0", "不设免打扰"]].map(([s, e, label]) => `
        <button class="sheet-item ${Number(c.quietStart) === Number(s) && Number(c.quietEnd) === Number(e) ? "is-on" : ""}" data-cp-quiet="${s}-${e}">
          <span class="nm">${label}<span class="desc">${s === e ? "任何时间都可能开口（不建议）" : "这段时间它保持安静"}</span></span>
          <svg class="ico check"><use href="#i-check"/></svg>
        </button>`).join("")}
    </div>

    <div class="group-title" style="margin:14px 2px 8px">说话风格</div>
    <div class="sheet-list">
      ${Companion.STYLES.map((s) => `
        <button class="sheet-item ${c.style === s.id ? "is-on" : ""}" data-cp-style="${s.id}">
          <span class="nm">${s.name}<span class="desc">${s.desc}</span></span>
          <svg class="ico check"><use href="#i-check"/></svg>
        </button>`).join("")}
    </div>

    <div class="group-title" style="margin:14px 2px 8px">运行状态</div>
    <div class="sheet-list">
      <div class="sheet-item is-plain"><span class="nm">下次窗口<span class="desc">到点才判断，不保证开口</span></span><span class="row-value">${diag.next}</span></div>
      <div class="sheet-item is-plain"><span class="nm">上次心跳</span><span class="row-value">${diag.lastBeat}</span></div>
      <div class="sheet-item is-plain"><span class="nm">上次开口</span><span class="row-value">${diag.lastSpoke}</span></div>
      <div class="sheet-item is-plain"><span class="nm">上次跳过${diag.skip && diag.skip !== "—" ? `<span class="desc">${esc(diag.skip)}</span>` : ""}</span><span class="row-value">${Companion.todayCount()}/${cad.cap} 次</span></div>
    </div>
    ${Companion.modelReady()
      ? ""
      : `<div class="sheet-caption" style="color:var(--orange)">当前模型不可用，心跳到了也说不出话 —— 先去「模型」里换一个能连通的。</div>`}
    ${(() => {
      let keep = "";
      try {
        const p = JSON.parse(Native && Native.powerStatus ? Native.powerStatus() : "{}");
        if (c.enabled && p && p.ok && !p.battery) {
          keep = `<div class="sheet-caption" style="color:var(--orange)">本应用还没加入电池优化白名单，后台心跳可能被系统冻结 —— 设置 → 后台运行里加一下更稳。</div>`;
        }
      } catch (_) {}
      return keep;
    })()}
    <div class="sheet-caption">间隔 ${cad.min}–${cad.max} 分钟；前台服务保活，后台与锁屏期间也到点开口（通知送达）；被系统强杀后回到应用会自动补拍</div>`;
  };

  const sheetPlugins = () => {
    const d = Plugins.info(true);
    const voice = voicePluginPanel();
    const errs = (d.errors || []);
    return `
    <div class="sheet-title">插件</div>
    <div class="sheet-sub">关闭后工具消失</div>
    <div class="group-title" style="margin:2px 2px 8px">扩展插件</div>
    <div class="sheet-list">${renderPluginRows(voice.rows)}</div>
    <div class="sheet-caption">${voice.caption}</div>
    <div class="group-title" style="margin:14px 2px 8px">内核插件</div>
    <div class="sheet-list">${renderPluginRows(kernelPluginRows(d)) || '<div class="sheet-caption">没有可用插件</div>'}</div>
    ${errs.length ? `<div class="sheet-caption" style="color:var(--orange)">清单问题：${errs.map(esc).join("；")}</div>` : ""}
    <div class="sheet-caption">清单放 <code style="font-family:var(--mono)">kernel/plugins/</code>，重启生效</div>`;
  };

  /* ============ 桌面联动：手填地址配对 + 电脑会话 ============
     手机从不直连电脑：所有请求都发往两端都能访问的中继，由中继转给电脑。
     所以同 WiFi 和手机流量下是同一条路径，配对之后没有「切换网络」这回事。 */
  /**
   * 电脑会话的等待态：发出去之后到第一条输出之前，显示鲸尾 + 「深度求索中」，
   * 超过 2 秒带用时。和本机共用 runStatHTML，外观完全一致。
   */
  const PcRun = {
    node: null,
    timer: 0,
    started: 0,
    start() {
      this.stop();
      this.started = Date.now();
      this.node = { kind: "pcrunning", started: Date.now() };
      // 只接这一个节点：整表重建会把视口清空再贴底，发送后那一下就是「乱滚」
      push(this.node, false);
      streamFollow();
      this.timer = setInterval(() => {
        const el = document.querySelector("#messages .runstat-label");
        if (!el) return;
        const secs = Math.floor((Date.now() - this.started) / 1000);
        el.textContent = secs >= 2 ? `深度求索中，用时 ${secs} 秒 ···` : "深度求索中";
      }, 1000);
    },
    stop() {
      if (this.timer) { clearInterval(this.timer); this.timer = 0; }
      if (!this.node) return;
      const at = thread.indexOf(this.node);
      if (at >= 0) {
        thread.splice(at, 1);
        // 数据摘掉还不够：不是每个调用点后面都跟着 renderThread（发送失败 catch、
        // onHistory 静默收摊），不连 DOM 一起删，「深度求索中」就一直挂在界面上。
        const uid = this.node.__uid;
        if (uid) document.querySelector(`#messages [data-uid="${uid}"]`)?.remove();
        // DOM 与 thread 一起少一个，尾部队的计数跟着退一格，增量追加才不会错位
        if (renderTailFrom > at) renderTailFrom -= 1;
      }
      this.node = null;
    },
  };

  /** 回显配对的键：电脑可能改动空白与换行，按「压掉连续空白」后的文本比 */
  function echoKey(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }
  /* 只发图时没有文字可以拿来对：用这个哨兵占一个位置，电脑回显的空中文消息就把它对掉。
     电脑端把「只有图片、没有文字」的用户消息回显成 "[图片]"（插件 index.js 的历史映射），
     所以这两个字也算同一个哨兵 —— 否则会多出一条写着「[图片]」的气泡。 */
  const IMG_ECHO_KEY = "\u0000image";
  const IMG_ECHO_TEXT = "[图片]";

  const Link = {
    sessionId: null,
    cursor: 0,
    poll: null,
    pollBusy: false,
    running: false,
    failed: 0,
    pendingDeliveries: [],

    state() {
      try { return JSON.parse(Native.linkState() || "{}"); } catch (_) { return {}; }
    },

    /* 入口：已配对直接进会话列表，否则先填电脑面板上那三项 */
    enter() {
      const s = this.state();
      if (s.paired) { this.showSessions(); return; }
      this.form();
    },

    form() {
      openSheet(sheetLinkConnect());
      const btn = $("#linkConnectBtn");
      if (btn) btn.addEventListener("click", () => Link.connect());
      const paste = $("#linkPasteBtn");
      if (paste) paste.addEventListener("click", () => {
        const box = $("#linkPairing");
        Link.pairPaste(box ? box.value : "");
      });
      // WebView 读剪贴板要有手势且可能被系统拦下来；读不了就把焦点交给输入框，
      // 长按粘贴是同一件事的确定性做法（不假装成功）
      const clip = $("#linkClipBtn");
      if (clip) clip.addEventListener("click", async () => {
        const box = $("#linkPairing");
        try {
          const text = await navigator.clipboard.readText();
          if (text && box) { box.value = text.trim(); Link.pairPaste(text); return; }
          toast("剪贴板是空的：粘贴配对串后再点「粘贴并连接」");
        } catch (_) {
          if (box) box.focus();
          toast("这里读不到剪贴板：长按输入框选「粘贴」");
        }
      });
      const probe = $("#linkProbeBtn");
      if (probe) probe.addEventListener("click", () => {
        const pairing = ($("#linkPairing") ? $("#linkPairing").value.trim() : "");
        const relay = ($("#linkRelay") ? $("#linkRelay").value.trim().replace(/\/+$/, "") : "");
        const room = ($("#linkRoom") ? $("#linkRoom").value.trim() : "");
        const box = $("#linkProbeBox");
        // 粘了配对串就直接连一次：跨网这条路本身就是分步可定位的（TCP / TLS / 指纹 / 应答），
        // 再单独探测一遍只是多等一轮，失败原因还是同一份
        if (pairing.indexOf("dshlink1:") === 0) { Link.pairPaste(pairing); return; }
        if (!relay) { toast("先粘贴配对串，或填中继地址"); return; }
        if (!room) { toast("填中继地址和房间号"); return; }
        if (box) box.innerHTML = '<div class="sheet-caption">正在测试…</div>';
        try { Native.linkProbe("probe-" + Date.now(), relay, room); } catch (_) { toast("当前环境不支持"); }
      });
      const drop = $("#linkFormUnpair");
      if (drop) drop.addEventListener("click", () => {
        Link.unpair();
        closeSheet();
        Link.form();
      });
      // 另一件事：局域网里那台电脑的完整 Web UI（地址 + Launch Token）
      const direct = $("#linkHostDirect");
      if (direct) direct.addEventListener("click", () => { closeSheet(); setTimeout(() => openSheet(sheetHostDirect()), 180); });
    },

    /** 一行配对串 → 原生解析并配对。失败原因分步给出（TCP / TLS / 指纹 / 应答）。 */
    pairPaste(text) {
      const raw = String(text || "").trim();
      if (!raw) return toast("先粘贴电脑面板上的配对串");
      if (raw.indexOf("dshlink1:") !== 0) return toast("这不是配对串：应以 dshlink1: 开头");
      toast("正在连接…");
      Native.linkPairPaste("pair-" + Date.now(), raw);
    },

    /* 手填三项：中继地址 + 房间号 + 中继口令。口令对不上电脑会直接拒绝。 */
    connect() {
      const relay = ($("#linkRelay") ? $("#linkRelay").value.trim().replace(/\/+$/, "") : "");
      const room = ($("#linkRoom") ? $("#linkRoom").value.trim() : "");
      const key = ($("#linkKey") ? $("#linkKey").value.trim() : "");
      if (!relay || !room || !key) return toast("中继地址、房间号、口令都要填");
      if (!/^https?:\/\//.test(relay)) return toast("中继地址要带 http:// 或 https://");
      toast("正在连接…");
      Native.linkConnect("connect-" + Date.now(), relay, room, key);
    },

    unpair() {
      this.stopBeat();
      this.beat = { at: 0, ok: false, error: "", host: "" };
      try { Native.linkUnpair(); } catch (_) {}
      toast("已解除配对");
      this.listAt = 0;
      renderPcSessions(null);
      renderMode();
    },

    showSessions() {
      openSheet(sheetLinkSessions());
      $("#linkRefresh").addEventListener("click", () => Link.sessions());
      $("#linkNewSession").addEventListener("click", () => Link.workspaces());
      $("#linkRescan").addEventListener("click", () => { closeSheet(); Link.form(); });
      $("#linkUnpair").addEventListener("click", () => {
        Link.unpair();
        closeSheet();
      });
      $("#linkList").addEventListener("click", (event) => {
        const row = event.target.closest("[data-link-session]");
        if (!row) return;
        this.open(row.dataset.linkSession, row.dataset.linkTitle || "");
      });
      this.sessions();
    },

    sessions() {
      const list = $("#linkList");
      if (list) list.innerHTML = '<div class="sheet-caption">正在读取电脑会话…</div>';
      Native.linkSessions("sessions-" + Date.now());
    },

    /**
     * 新建电脑会话：和电脑端一样先选工作区。
     * 可选项来自已有会话的目录（电脑端同一个 create 入口，传 cwd），
     * 另有「默认工作区」= 让电脑用它配置的默认目录。
     */
    workspaces() {
      openSheet(sheetPcWorkspace());
      this.wsList = null;
      this.loadWorkspaces();
    },
    /** 电脑上的工作区（新建会话前选） */
    loadWorkspaces() {
      try { Native.linkWorkspaces("pc-ws-" + Date.now()); } catch (_) { toast("当前环境不支持"); }
    },

    createWorkspace(path, thenCreate) {
      this.afterWorkspace = thenCreate === true;
      try { Native.linkCreateWorkspace("pc-wsc-" + Date.now(), path); } catch (_) { toast("当前环境不支持"); }
    },

    createSessionIn(workspaceId) {
      toast("正在电脑上新建会话…");
      try { Native.linkCreateSessionIn("create-" + Date.now(), workspaceId || ""); } catch (_) { toast("当前环境不支持"); }
    },

    createSession(cwd) {
      toast("正在电脑上新建会话…");
      try { Native.linkCreateSession("create-" + Date.now(), cwd || ""); }
      catch (_) { toast("当前环境不支持"); }
    },

    /**
     * 主列表里的电脑分区：静默拉一次，不弹任何面板。
     * 5 秒内不重复请求 —— renderSessions 在搜索输入时会被反复调用。
     * from 非空表示这是用户手点的那一下：回来必须说一句（否则刷完还是那一列表，
     * 看着就是按钮坏了；自动那一支保持静默）。
     */
    refreshList(from) {
      const st = this.state();
      if (!st.paired) { renderPcSessions(null); return; }
      const now = Date.now();
      if (now - (this.listAt || 0) < 5000) { renderPcSessions(undefined); return; }
      this.listAt = now;
      // 一次性回执要在真的发得出请求那一刻才立，不然没回调可消费，
      // 下一次自动刷新回来会替这次「手点」说句话。
      if (from) this.refreshAck = true;
      renderPcSessions(undefined);
      try { Native.linkSessions("pc-" + now); } catch (_) {
        this.refreshAck = false;
        renderPcSessions([], true);
        if (from) toast("这台环境发不出请求：请在 App 里连电脑");
      }
    },

    /**
     * 打开电脑上的会话。
     *
     * 用的是和手机本地/宿主机会话同一个聊天页，不是另开一个浮层 ——
     * 同一件事（看会话、发消息）不该有两套长得不一样的界面。
     */
    open(sessionId, title, from) {
      const name = title || "电脑会话";
      // 本地轮次还没结束就切进电脑会话：先结算并落快照，否则 turn_end/工具结果
      // 会按 sid 被丢弃，回来只剩一个永远「运行中」的壳。
      if (state.busy) { try { stopLive(true); } catch (_) {} }
      persistThread();
      this.sessionId = sessionId;
      this.cursor = 0;
      this.running = false;
      this.failed = 0;
      this.openedFrom = from || "";
      this.seen = new Set();
      // 换会话就把「我发过哪几句」清空：否则另一场会话里用户真的重发同一句话会被咽掉
      this.echo = [];
      // 上一场还没落地的交付卡跟着作废（重进时会由历史重放重新生成）
      this.pendingDeliveries = [];
      this.deliveredKeys = new Set();
      this.cancelFlush();
      // 命令按会话不同，换会话就重新问一次
      this.pcCommands = null;
      this.emptyHint = null;
      this.toolByCall = new Map();
      // 上一次会话没回来的轮询作废：迟到的响应靠 pending.id 对账，不能污染新会话
      this.pollBusy = false;
      this.pending = null;
      clearTimeout(this.guard);
      if (sheetOpen) closeSheet();
      // 输入框换装：电脑会话 = 电脑端那套卡片布局（输入在上、控制行在下）
      syncComposerMode();
      syncPcContext();
      // 排队消息属于本地/宿主会话，不能跟着切进电脑会话（对照 openSession 的同一处理）
      if (queueOf().length) {
        queueOf().length = 0;
        renderQueue();
        toast("已切换会话，原来的排队消息已清空", 2200);
      }

      state.pcSession = { id: sessionId, title: name };
      // 电脑会话单独一份桶：本机会话的快照绝不会写到这里，反之亦然。
      // 进门先清空 —— 真相以电脑的历史为准：留着旧节点、又把 cursor 归零，
      // 整段历史会被再灌一遍（真机实锤：退出重进 7 个节点变 14 个）。
      attachBlank("pc:" + sessionId);
      renderThread();
      const t = $("#chatTitle");
      if (t) t.textContent = name;
      this.syncHeader();
      syncComposerMode();
      go("chat");
      this.request();
      this.startPoll();
      // 当前模型取电脑的默认选择；目录 60 秒内复用，不会每开一次都往返
      this.selected = this.selected || null;
      this.models().then((cat) => {
        if (!state.pcSession) return;
        if (!this.selected && cat && cat.default) this.selected = { ...cat.default };
        if ($("#sheetBody") && $("#sheetBody").querySelector("[data-pc-model-panel]")) openSheet(sheetPcAgent());
      });
    },

    /* ---------------- 存活心跳与诊断 ---------------- */
    beat: { at: 0, ok: false, error: "", host: "" },
    beatTimer: 0,

    /** 30 秒一次：让电脑知道这台手机还在，也顺便验证链路通不通 */
    startBeat() {
      this.stopBeat();
      if (!state.pcLinked && !Link.state().paired) return;
      const tick = () => {
        if (document.visibilityState !== "visible") return;
        try { if (Native && Native.linkPing) Native.linkPing("beat-" + Date.now()); } catch (_) {}
      };
      tick();
      this.beatTimer = setInterval(tick, 30_000);
    },

    stopBeat() {
      if (this.beatTimer) { clearInterval(this.beatTimer); this.beatTimer = 0; }
    },

    onBeat(id, json) {
      let d = {};
      try { d = JSON.parse(json || "{}"); } catch (_) {}
      this.beat = { at: Date.now(), ok: !!d.ok, error: d.error || "", host: d.host || "" };
      const box = $("#linkDiag");
      if (box) box.innerHTML = this.diagHTML();
      // 电脑会话面板开着的时候，顺手把标题下的主机名补上
      if (d.ok && d.host) { const sub = $("#chatSub"); if (sub && state.pcSession) this.syncHeader(); }
    },

    /** 连法老实写出来：同一局域网 / 隧道 / 直连 —— 三种的可信边界不一样 */
    modeLabel(st) {
      const s = st || this.state();
      if (s.mode === "tunnel") return "电脑（隧道）";
      if (s.mode === "direct") return "电脑（直连）";
      if (s.mode === "relay" || s.relay) return /^https?:\/\/(127\.|localhost|\[?::1|\d+\.\d+\.\d+\.\d+)/i.test(s.relay || "")
        ? "电脑（局域网）" : "电脑（中继）";
      return "电脑";
    },

    /** 连接面板里的状态行：通不通、最后一次结果、失败原因，一眼能看到 */
    diagHTML() {
      const st = this.state();
      if (!st.paired) {
        return `<div class="sheet-caption" id="linkDiag" style="margin:2px 2px 8px">还没连接：粘贴配对串，或填下面三项。</div>`;
      }
      const b = this.beat || {};
      const ago = b.at ? Math.max(0, Math.round((Date.now() - b.at) / 1000)) : -1;
      const line = b.at === 0
        ? "已配对 · 正在第一次确认…"
        : b.ok
          ? `已连接 ${esc(b.host || st.host || "电脑")} · ${this.modeLabel(st)}${ago >= 0 ? ` · ${ago} 秒前刚通过` : ""}`
          : `连不上：${esc(b.error || "未知原因")}`;
      const tone = b.at === 0 ? '' : b.ok ? ' style="color:var(--green,#34c759)"' : ' style="color:var(--red)"';
      return `<div class="sheet-caption" id="linkDiag"${tone}>${line}</div>`;
    },

    /** 标题下方那行：让「这是电脑上的会话、走的哪条路」一直可见，别和本机会话搞混 */
    syncHeader() {
      const sub = $("#chatSub");
      if (!sub) return;
      if (!state.pcSession) return;
      const host = this.state().host || "电脑";
      sub.textContent = this.modeLabel() + " · " + host + (this.running ? " · 运行中" : "");
    },

    /** 流式：600ms 取一次增量，节流重绘 */
    live: null,

    startLive() {
      // 上一轮还在流：**不能删**（删了就是「正文出现又消失」）。
      // 冻结成一条普通正文留在原位，等它的终稿回来时就地转正。
      this.freezeLive();
      const node = { kind: "pclive", text: "", think: "", started: Date.now() };
      thread.push(node);
      // 第一次只对齐游标：不然会把这一轮之前的全部历史增量当成新输出灌进来，
      // 等待态一进去就被顶掉（实测）。
      // 代际号：每开一轮 +1。上一轮在途的 live 响应迟到回来时，凭它丢掉 ——
      // 否则旧帧会被当成这一轮的增量喂进草稿，正文出现整段重复/拼接（真机实测）。
      this.liveGen = (this.liveGen || 0) + 1;
      this.live = { node, cursor: 0, timer: 0, seeding: true, gen: this.liveGen };
      // 空节点先不画（正文到第一帧才出现），只记账；paintLiveNode 负责落 DOM
      push(node, false);
      // 秒数每秒刷一次（只改那一行文本，不重绘整个对话）
      this.secTimer = setInterval(() => {
        // 只认**这一轮**的秒表：按 [data-live-secs] 在全对话里取第一条会拿到上一轮
        // 已经定稿的那行（旧回合的秒数会跟着涨，还会每秒改写一个封条节点）。
        const liveNode = this.live && this.live.node;
        const el = liveNode
          ? document.querySelector(`#messages [data-uid="${nodeUid(liveNode)}"] [data-live-secs]`)
          : null;
        if (!el || (liveNode && liveNode.text)) return;
        const secs = Math.max(0, Math.floor((Date.now() - node.started) / 1000));
        el.textContent = secs >= 1 ? `深度思考中 · ${secs} 秒` : "深度思考中";
      }, 1000);
      this.liveTimer = setInterval(() => {
        const sid = state.pcSession && state.pcSession.id;
        if (!sid || !this.live) return;
        try { Native.linkLive("live-" + this.live.gen + "-" + Date.now(), sid, this.live.cursor); } catch (_) {}
      }, 600);
    },

    stopLiveTimers() {
      if (this.liveTimer) { clearInterval(this.liveTimer); this.liveTimer = 0; }
      if (this.secTimer) { clearInterval(this.secTimer); this.secTimer = 0; }
      if (this.paintTimer) { clearTimeout(this.paintTimer); this.paintTimer = 0; }
    },

    /**
     * 冻结当前草稿：停计时、把它落成一条普通正文（DOM 原地不动）。
     *
     * 用户在新一轮已经开流的情况下再发一条，上一轮的草稿还在长 ——
     * 以前 startLive() 直接 stopLive() 删掉它，屏幕上的正文先消失，
     * 等电脑的终稿回来又插一遍，读起来像「另一段正文出现又消失」。
     */
    freezeLive() {
      const live = this.live;
      if (!live) return;
      this.stopLiveTimers();
      const node = live.node;
      const at = thread.indexOf(node);
      const text = String(node.text || "");
      if (at >= 0 && text.trim() !== "") {
        const converted = NODES.text(text);
        converted.__uid = node.__uid;
        thread[at] = converted;
        const el = document.querySelector(`#messages [data-uid="${node.__uid}"]`);
        const body = live.textEl || (el && el.querySelector(".assistant-text"));
        if (body) { body.__painted = text; morphHTML(body, md(text)); }
        finalizeLiveHead(el);
      } else if (at >= 0) {
        thread.splice(at, 1);
        const el = node.__uid ? document.querySelector(`#messages [data-uid="${node.__uid}"]`) : null;
        if (el) el.remove();
        if (renderTailFrom > at) renderTailFrom -= 1;
      }
      this.frozen = this.frozen || [];
      if (at >= 0 && text.trim() !== "") this.frozen.push({ node: thread[at], text });
      this.live = null;
    },

    /**
     * 草稿转正：流式那枚气泡就是这条正文时，就地把它变成正式 text 节点。
     *
     * 以前的做法是「删草稿 → 再 push 正式消息」：中间那一刻内容塌了一截，
     * 浏览器把 scrollTop 钳到新的最大值，等正式消息补回来时视口已经在半空，
     * 再被贴底动画拉回底部 —— 这就是「发送后列表先滚走再滚回来」。
     * 同一个节点、同一段文字，高度不变，视口自然不动。
     */
    promoteLive(text) {
      const wanted = String(text || "").trim();
      const frozen = this.frozen || [];
      if (frozen.length) {
        const i = frozen.findIndex((one) => String(one.text || "").trim() === wanted);
        if (i >= 0) {
          const target = frozen[i].node;
          frozen.splice(i, 1);
          const at = thread.indexOf(target);
          if (at >= 0) {
            const converted = NODES.text(text);
            converted.__uid = target.__uid;
            thread[at] = converted;
            patchNode(converted);
            return true;
          }
        }
      }
      const live = this.live && this.live.node;
      if (!live) return false;
      if (String(live.text || "").trim() !== wanted) return false;
      this.stopLiveTimers();
      const at = thread.indexOf(live);
      if (at >= 0) {
        const converted = NODES.text(text);
        converted.__uid = live.__uid;      // 复用 uid：patchNode 才能找到原 DOM
        thread[at] = converted;
        // 正文已经在 DOM 里了：只补一次终稿渲染（对已画过的文本是幂等的），
        // 不删节点、不重新插入 —— 高度不变，视口不动
        const el = document.querySelector(`#messages [data-uid="${live.__uid}"]`);
        const body = (this.live && this.live.textEl) || (el && el.querySelector(".assistant-text"));
        if (body) { body.__painted = text; morphHTML(body, md(text)); }
        else patchNode(converted);
        finalizeLiveHead(el);
      }
      this.live = null;
      return true;
    },

    stopLive() {
      this.stopLiveTimers();
      if (!this.live) return;
      const at = thread.indexOf(this.live.node);
      if (at >= 0) {
        thread.splice(at, 1);
        // 草稿节点可能已经画到流里了：留一块残留正文 + 正式消息 = 重复两遍
        const el = document.querySelector(`#messages [data-uid="${nodeUid(this.live.node)}"]`);
        if (el) el.remove();
        if (renderTailFrom > at) renderTailFrom -= 1;
      }
      this.live = null;
    },

    /** 节流重绘：增量可能几十毫秒一条，不能每条都全量渲染 */
    paintLive() {
      const now = Date.now();
      if (now - (this.paintAt || 0) > 140) {
        this.paintAt = now;
        this.paintLiveNode();
        return;
      }
      if (this.paintTimer) return;
      this.paintTimer = setTimeout(() => {
        this.paintTimer = 0;
        this.paintAt = Date.now();
        this.paintLiveNode();
      }, 140);
    },

    /**
     * 只重画正在流的那一枚气泡。
     *
     * 以前这里每次增量都 renderThread()：整张对话被清空重建，贴底逻辑再把视口
     * 一次次写回底部 —— 发送后消息列表「自己在乱滚」就是这么来的。
     * 现在只对这一枚做 morph，滚动交给 streamFollow（一帧最多写一次）。
     */
    paintLiveNode() {
      const node = this.live && this.live.node;
      if (!node || !this.live) return;
      if (!nodeHTMLUid(node)) return;   // 连正文都还没有：等待态由 pcrunning 那枚负责
      const sel = `#messages [data-uid="${nodeUid(node)}"]`;
      let el = document.querySelector(sel);
      if (!el) {
        // 第一次有内容：把这枚气泡接到流末尾（本机 newText 的同一步），不是重建整表
        if (renderTailFrom !== thread.length || !$("#messages")) { renderThread(); scrollToBottom(); return; }
        appendTail(node);
        el = document.querySelector(sel);
        if (!el) return;
        this.live.el = el;
        this.live.textEl = el.querySelector(".assistant-text");
        this.live.thinkEl = el.querySelector(".pc-think-text");
      }
      // 正文与思考都在同一枚气泡里增量画：本机 paintLiveText 的同一套做法
      const textEl = this.live.textEl || el.querySelector(".assistant-text");
      if (textEl && node.text && textEl.__painted !== node.text) {
        textEl.__painted = node.text;
        morphHTML(textEl, md(node.text));
      }
      const thinkEl = this.live.thinkEl || el.querySelector(".pc-think-text");
      if (thinkEl && node.think && thinkEl.__painted !== node.think) {
        thinkEl.__painted = node.think;
        thinkEl.textContent = node.think;
      }
      // 头部状态（秒数/“思考”标题）偶尔要换字，交给整节点 morph 只处理这一处
      const head = el.querySelector(".pc-think-title");
      if (head && node.text && head.classList.contains("is-shimmer")) patchNode(node);
      streamFollow();
    },

    /**
     * 上一轮的回复迟到（这一轮已经开跑）时，按「本轮用户气泡」插回原位。
     *
     * 以前一律 push 到末尾：那条回复会跑到新消息下面，看起来像「上一轮的回答
     * 跑到这一轮」；退出重进按 seq 重排又恢复正常 —— 就是这里漏了顺序。
     */
    /** 这条内容是否属于「上一轮」（比本轮的提问更早）。序号未知时按上一轮处理。 */
    isLateForTurn(node) {
      const anchor = this.turnAnchor;
      if (!anchor || thread.indexOf(anchor) < 0) return false;
      const anchorSeq = Number(anchor.__seq) || 0;
      const seq = Number(node.__seq) || 0;
      if (anchorSeq === 0) return true;
      return seq > 0 && seq < anchorSeq;
    },

    /**
     * 把节点放到「本轮用户气泡」之前（节点可已在 thread 末尾，会先摘出来）。
     *
     * 上一轮的思考行、工具组、正文迟到时都走这里；本轮自己的内容走普通追加。
     * 以前只有正文判断顺序、思考与工具行一律追加 —— 上一轮的过程就跑到
     * 这一轮的提问下面去了。
     */
    placeBeforeTurn(node) {
      const anchor = this.turnAnchor;
      if (!anchor || thread.indexOf(anchor) < 0) {
        if (thread.indexOf(node) < 0) push(node, false);
        else appendTail(node);
        return;
      }
      let at = thread.indexOf(anchor);
      const had = thread.indexOf(node);
      if (had >= 0) { thread.splice(had, 1); if (had < at) at -= 1; }
      thread.splice(at, 0, node);
      const el = document.querySelector(`#messages [data-uid="${nodeUid(anchor)}"]`);
      if (!el) { this.needRender = true; return; }
      insertAnchored(el, nodeHTMLUid(node));
      keepTailSync(at);
    },

    /** 电脑上的模型目录：选模型时现拉一次，60 秒内复用 */
    models(force) {
      if (!force && this.catalog && Date.now() - (this.catalogAt || 0) < 60000) {
        return Promise.resolve(this.catalog);
      }
      return new Promise((resolve) => {
        this.catalogWaiters = this.catalogWaiters || [];
        this.catalogWaiters.push(resolve);
        try { Native.linkModels("models-" + Date.now()); }
        catch (_) { this.catalogWaiters = []; resolve(null); }
        // 拉不到也要有个结果，否则面板一直转。
        // 12 秒等不起：电脑端 modelCatalog() 要逐个 provider 走网络，冷读实测 ~30 秒
        // —— 以前这里先放弃，面板就渲染成「读取失败」，一行可点的都没有，
        // 用户看到的就是「模型切换点不动」。
        setTimeout(() => {
          const list = this.catalogWaiters || [];
          if (list.length) { this.catalogWaiters = []; resolve(null); }
        }, 40000);
      });
    },

    /** 选中后立刻落到电脑端：下一次请求就用新模型 */
    selectModel(provider, model, effort) {
      const sid = state.pcSession && state.pcSession.id;
      if (!sid) return Promise.reject(new Error("还没进入电脑会话"));
      return new Promise((resolve, reject) => {
        this.modelWaiters = this.modelWaiters || [];
        this.modelWaiters.push({ resolve, reject });
        try {
          Native.linkSelectModel("setmodel-" + Date.now(), sid, provider, model, effort || "");
        } catch (error) { this.modelWaiters = []; reject(error); }
      });
    },

    /** 当前的过程组：连续的工具调用都进这里，正文一出现就封口 */

    toolGroup() {
      const last = thread[thread.length - 1];
      if (last && last.kind === "pctools" && !last.closed) return last;
      const node = NODES.pctools();
      thread.push(node);
      return node;
    },

    /** 退出电脑会话，回到普通（本地 / 宿主机）会话状态 */
    leave() {
      PcRun.stop();
      this.stopLive();
      this.stopPoll();
      // 在途请求作废：它的回包不许再动 cursor / running / 桶
      this.pollBusy = false;
      this.pending = null;
      clearTimeout(this.guard);
      this.sessionId = null;
      this.cursor = 0;
      this.frozen = [];
      this.turnAnchor = null;
      this.pendingDeliveries = [];
      this.deliveredKeys = new Set();
      this.cancelFlush();
      this.running = false;
      state.pcSession = null;
      // 电脑会话的桶留着（再点回来还能复用），但当前对话流要脱离它，
      // 免得离开后的任何异步写落进别人的桶。这里不清空：调用方紧接着会
      // openSession / attachBlank 到目标会话，清一次纯属浪费。
      attachThread("");
      syncComposerMode();
      syncPcContext();
    },

    request() {
      if (this.pollBusy) return;
      this.pollBusy = true;
      // 记下这次请求的 id 和归属会话：回包时对账，迟到的旧会话响应必须丢掉
      const id = "history-" + Date.now();
      this.pending = { id, sid: this.sessionId };
      Native.linkHistory(id, this.sessionId, this.cursor);
      // 一次往返最多等 12 秒；卡住时不能让轮询永久停摆
      clearTimeout(this.guard);
      this.guard = setTimeout(() => { this.pollBusy = false; this.pending = null; }, 12000);
    },

    startPoll() {
      this.stopPoll();
      this.poll = setInterval(() => {
        // 只要还在看这个电脑会话就继续拉，关掉就停（页面在后台时也别空转）
        if (this.pollBusy || !this.sessionId || !state.pcSession) return;
        this.request();
      }, 1200);
    },

    stopPoll() {
      if (this.poll) { clearInterval(this.poll); this.poll = null; }
    },

    syncStop() {
      // #linkStop 那个「停止」按钮从没被渲染过，收口只留发送键的状态机
      try { updateSendState(); } catch (_) {}
    },

    /**
     * 把电脑上的一条消息落进主聊天线程。
     *
     * 桌面端的记录比手机端多得多（思考、工具、结果都算消息），这里只挑
     * 人真正要看的三类：自己说的、agent 说的、工具做完了什么。
     */
    /**
     * 记下「这句是手机刚发的」，等电脑把它回显回来时咽掉一次。
     *
     * 发送时对话流里已经 push 了一枚乐观气泡；电脑那边这条消息落库后带着真实 seq
     * 回传，`seen` 只认 seq、认不出「同一句话」，于是又 push 一遍 ——
     * 用户看到的就是「发一条出两条」。
     */
    expectEcho(text, withImages) {
      this.echo = this.echo || [];
      // 只发图时没有文字能对：用哨兵记一次，回显（text 为空）时对掉
      const key = echoKey(text) || (withImages ? IMG_ECHO_KEY : "");
      if (!key) return;
      this.echo.push(key);
      // 只记最近八句：再久之前的回显早就该到了，留着反而会咽掉用户真的想重发的同一句话
      if (this.echo.length > 8) this.echo.shift();
    },

    takeEcho(text) {
      const list = this.echo || [];
      const key = echoKey(text);
      const index = list.indexOf(!key || key === IMG_ECHO_TEXT ? IMG_ECHO_KEY : key);
      if (index < 0) return false;
      list.splice(index, 1);
      return true;
    },

    append(message) {
      if (!state.pcSession) return;
      // 身份自检：轮询回来时用户可能已经切回本机会话了 —— 这条属于电脑会话，
      // 绝不能落进当前（本机）对话流里
      if (thread.__sid !== "pc:" + state.pcSession.id) return;
      const seq = Number(message.seq) || 0;
      if (seq && this.seen.has(seq)) return;
      if (seq) this.seen.add(seq);

      const role = message.role;
      // 又来了新内容：排队的落卡要让位（它只在本轮真的静下来时才落）
      this.cancelFlush();
      // 翻篇要在最前面判定：用户那条常常被「回显咽掉」直接 return，
      // 把释放放在末尾就会漏掉，上一轮的收尾卡会被后面新内容拖着走。
      if (role === "user") this.releaseTailCards();
      // 只要电脑那边真的吐出东西了，就别再挂着「深度求索中」
      if (role !== "user") PcRun.stop();
      // 正式消息落库了，流式草稿就该让位（否则会重复一遍）；
      // 正文那一条留给 promoteLive 原地转正，这里只处理工具/结果的场景
      if (role === "tool") this.stopLive();
      let touched = null;
      if (role === "reasoning") {
        if (!String(message.text || "").trim()) return;
        const thinkNode = NODES.pcthink({ text: message.text, open: false });
        thinkNode.__seq = seq;
        if (this.isLateForTurn(thinkNode)) { thread.push(thinkNode); this.placeBeforeTurn(thinkNode); }
        else push(thinkNode, false);
      } else if (role === "user") {
        // 电脑端会把「运行时上下文」追加在用户那句话后面（工作目录、时区…），
        // 手机端只显示人真正打的那句 —— 否则一条「你好」能撑满一屏。
        let raw = String(message.text || "").trim();
        // 「你好 + 运行时上下文」这种拼接：只留人打的那句
        const cut = raw.search(/Current runtime context\.|^Time sampled while preparing/im);
        if (cut > 0) raw = raw.slice(0, cut).trim();
        if (isInjectedUserText(raw)) return;
        // 电脑回显的就是手机刚发出去的那句：气泡已经在流里了，再 push 就是两条
        if (this.takeEcho(raw)) {
          // 桌面回显了这句：把真实序号补到乐观气泡上，后面判断「谁更早」才有依据
          if (this.turnAnchor && !this.turnAnchor.__seq && seq) this.turnAnchor.__seq = seq;
          return;
        }
        const echoed = NODES.user(raw);
        echoed.__seq = seq;
        push(echoed, false);
        this.turnAnchor = echoed;
      } else if (role === "assistant") {
        if (!message.text) return;
        const last = thread[thread.length - 1];
        if (last && last.kind === "pctools") last.closed = true;
        // 草稿同一段文字：原地转正；不是这一轮的（上一轮迟到）就插回原位
        if (!this.promoteLive(message.text)) {
          const textNode = NODES.text(message.text);
          textNode.__seq = seq;
          if (this.isLateForTurn(textNode)) this.placeBeforeTurn(textNode);
          else push(textNode, false);
        }
      } else if (role === "tool") {
        // 收进「过程组」：默认只显示一行「N 个工具」，点开才逐条看
        const group = this.toolGroup();
        const item = {
          id: message.id ? String(message.id) : "",
          name: message.name || "工具",
          meta: toolMetaOf(message.args),
          status: "run",
          out: "",
        };
        // present 的交付清单先留在条目上：等它真的跑成功（tool-result 回来）才落卡片
        if (item.name === "present") item.files = presentFilesOf(message.args);
        if (!group.__seq && seq) group.__seq = seq;
        group.items.push(item);
        if (item.id) { this.toolByCall = this.toolByCall || new Map(); this.toolByCall.set(item.id, item); }
        touched = group;
      } else if (role === "tool-result") {
        const key = message.id ? String(message.id) : "";
        const item = key && this.toolByCall ? this.toolByCall.get(key) : null;
        if (item) {
          item.status = message.isError ? "err" : "done";
          item.out = message.text || "";
          if (key) this.toolByCall.delete(key);
        } else {
          const g = this.toolGroup();
          g.items.push({
            id: key,
            name: message.name || "工具",
            meta: pageClip(message.text || "", 40),
            status: message.isError ? "err" : "done",
            out: message.text || "",
          });
          touched = g || touched;
        }
        if (!touched) touched = this.toolGroup();
        // 这一条 present 真的跑成功了：落一张交付卡（与本机同一套画法、同一个落点）
        if (item && !message.isError && item.files && item.files.length) this.deliverable(item.files, seq);
      } else {
        return;
      }
      // 过程组是「同一个节点长出新行」：就地 morph 这一块，别动整张对话。
      // 组节点还没落到 DOM（刚新建）时，交给 onHistory 兜底重建一次。
      if (touched) {
        if (document.querySelector(`#messages [data-uid="${nodeUid(touched)}"]`)) patchNode(touched);
        else if (this.isLateForTurn(touched)) this.placeBeforeTurn(touched);
        else if ($("#messages")) appendTail(touched);
        else this.needRender = true;
      }
      // 一次轮询常带回十几条：以前每条都整表重建 + 平滑贴底，滚动画被反复打断，
      // 看起来就是消息列表自己在乱滚。现在新节点只追加，滚动交给 onHistory 收尾。
      if (role !== "user") this.pinTailCards();
      this.appended = true;
    },

    /**
     * 电脑会话的交付卡：以前电脑上 present 成功了手机端也只是过程组里多一行
     * 「present / 完成」，卡片整块缺失（本机有、电脑没有 = 用户说的「不对齐」）。
     *
     * 落点：**本轮结束之后**。电脑常在 present 之后还补一段收尾正文，
     * 卡片要是此刻就插进去，就卡在「工具行」和「收尾正文」中间 ——
     * 真正的交付物应该排在这一轮所有文字的最后。所以先排队，
     * 等 running 变 false（或重进会话、那一轮已经是完成态）再落。
     */
    deliverable(files, seq) {
      if (!state.pcSession || !files || !files.length) return;
      // 同一条 present 结果被重复下发（重放 / 投影补发）只落一张卡；新一轮换了 seq，
      // 同一份文件再交付一次照样出卡。
      // seq 缺失（老投影/补发）时退到「本轮锚点」，同一轮同一批文件只落一张
      const turn = this.turnAnchor ? (nodeUid(this.turnAnchor) || "") : "";
      const key = (Number(seq) || 0) + "|" + turn + "|" + files.map((f) => f.path).join("|");
      this.deliveredKeys = this.deliveredKeys || new Set();
      if (this.deliveredKeys.has(key)) return;
      this.deliveredKeys.add(key);
      // 记下「卡属于哪一段」：现在的流末尾就是这一轮已经落地的内容，
      // 落卡时以它为界，后面新起的轮次不会被插到前面去。
      this.pendingDeliveries.push({ files, seq: Number(seq) || 0, anchor: thread.length ? thread[thread.length - 1] : null });
      if (!this.running) this.scheduleFlush();
    },

    /** 还在转圈的工具行收口成「完成」：落卡前必须先做，卡片不能压着没跑完的工具行 */
    finishRunningTools() {
      const fixed = [];
      for (const node of thread) {
        let touched = false;
        if (node.kind === "pctools") {
          for (const item of node.items || []) if (item.status === "run") { item.status = "done"; touched = true; }
        } else if (node.kind === "tool" && node.status === "run") {
          node.status = "done"; node.dur = "完成"; touched = true;
        }
        if (touched) fixed.push(node);
      }
      // 只重画这几处「当时还在转圈」的行：整表重建会把视口清零再滚回来（真机乱滚的来源）
      for (const node of fixed) patchNode(node);
    },

    /** 落卡前等一小段静默：投影可能晚一拍才送本轮最后那段正文 */
    scheduleFlush() {
      if (!this.pendingDeliveries.length) return;
      this.cancelFlush();
      this.flushTimer = setTimeout(() => { this.flushTimer = 0; this.flushDeliveries(); }, 900);
    },

    cancelFlush() {
      if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = 0; }
    },

    /** 卡片归属的那一轮之后的下一条用户消息：序号比分片到达的顺序可靠得多 */
    cardNextUser(node) {
      const seq = Number(node.__seq) || 0;
      if (!seq) return null;
      for (const n of thread) {
        if (n === node || n.kind !== "user") continue;
        if ((Number(n.__seq) || 0) > seq) return n;
      }
      return null;
    },

    /**
     * 交付卡落点：它那一轮之后、下一条用户消息之前。
     *
     * DOM 落位必须跟着线程邻居走，不能「找不到就接到末尾」—— 回放是分几批到的，
     * 落卡那一刻下一轮可能还没渲染出来，接到末尾之后再来的内容就把它留在了后面
     * （用户看到的「以前几轮的交付全跑到最新一轮结尾」）。
     * 那一轮本身都还没渲染时返回 false：先留在队列里，等下一批到了再落。
     */
    placeCard(node, anchor) {
      const host = $("#messages");
      if (!host) return false;
      let nextUser = this.cardNextUser(node);
      if (!nextUser && !Number(node.__seq)) {
        // 没有序号可依（乱序投影里的老数据）：退回「入队时的流末尾」这个边界
        const from = anchor ? thread.indexOf(anchor) : -1;
        let at = (from >= 0 ? from : thread.length - 1) + 1;
        while (at < thread.length && thread[at].kind !== "user") at++;
        nextUser = at < thread.length ? thread[at] : null;
      }
      const at = nextUser ? thread.indexOf(nextUser) : thread.length;
      const nextEl = nextUser ? host.querySelector(`[data-uid="${nodeUid(nextUser)}"]`) : null;
      if (nextEl && nextEl.parentElement === host) {
        thread.splice(at, 0, node);
        keepTailSync(at);
        insertAnchored(nextEl, nodeHTMLUid(node));
        return true;
      }
      // 下一条用户消息还没渲染：插在「上一个已经渲染出来的节点」之后
      for (let i = at - 1; i >= 0; i--) {
        const prevEl = host.querySelector(`[data-uid="${nodeUid(thread[i])}"]`);
        if (!prevEl || prevEl.parentElement !== host) continue;
        thread.splice(at, 0, node);
        keepTailSync(at);
        // 锚定补偿写在 #chatScroll 上 —— 曾经写成 setScrollTop(host, …)，而 #messages
        // 不是滚动容器（没有任何 overflow 规则），这行补偿从来没生效过，
        // 表现就是「往正在流式的回复中间插内容，视口跳一下」。
        const sc = $("#chatScroll");
        const keepFromBottom = sc ? sc.scrollHeight - sc.scrollTop : 0;
        prevEl.insertAdjacentHTML("afterend", nodeHTMLUid(node));
        if (sc && followBottomOn) ChatScroll._write(sc, Math.max(0, sc.scrollHeight - keepFromBottom));
        return true;
      }
      return false;
    },

    /** 把排队的交付卡落到各自那一轮的末尾 */
    flushDeliveries() {
      const batch = this.pendingDeliveries.splice(0);
      if (!batch.length) return;
      // 定时器可能在切走之后才响：那时 #messages 已经是别的会话的桶，
      // 落进去就是把电脑会话的交付卡插进本机对话里。重进时会由历史重放重新生成。
      if (!state.pcSession || thread.__sid !== "pc:" + state.pcSession.id) return;
      this.finishRunningTools();
      const again = [];
      for (const item of batch) {
        const node = NODES.deliverable({ files: item.files, pc: true });
        node.__seq = item.seq || 0;
        // 标记「这一轮的收尾卡」：本轮后面要是还来内容（投影常晚一拍送来收尾正文），
        // 它会跟着挪到本轮最后，而不是被新内容压在中间。
        node.__tail = true;
        if (!this.placeCard(node, item.anchor)) again.push(item);   // 那一轮还没渲染，等下一批
      }
      if (again.length) {
        this.pendingDeliveries.unshift(...again);
        this.scheduleFlush();
      }
      this.appended = true;
      if (followBottomOn) settleFollow();
    },

    /** 本轮还在长：收尾卡跟着挪到本轮最后（不越过下一条用户消息） */
    pinTailCards() {
      const host = $("#messages");
      if (!host) return;
      let moved = false;
      for (const card of thread.filter((n) => n.kind === "deliverable" && n.__tail)) {
        const i = thread.indexOf(card);
        if (i < 0) continue;
        const nextUser = this.cardNextUser(card);
        const at = nextUser ? thread.indexOf(nextUser) : thread.length;
        if (at - 1 === i) continue;                    // 已经在本轮最后
        const el = host.querySelector(`[data-uid="${nodeUid(card)}"]`);
        const nextEl = nextUser ? host.querySelector(`[data-uid="${nodeUid(nextUser)}"]`) : null;
        if (!el) continue;
        if (nextEl && nextEl.parentElement === host) {
          host.insertBefore(el, nextEl);               // 挪动的是同一个元素，不重建
        } else if (nextUser) {
          continue;                                    // 下一轮还没渲染：先不动，等它渲染出来再挪
        } else {
          host.appendChild(el);
        }
        thread.splice(i, 1);
        thread.splice(at > i ? at - 1 : at, 0, card);
        moved = true;
      }
      if (moved && followBottomOn) settleFollow();     // 挪位会顶一下内容，贴底的人要立刻回到最底
    },

    /** 下一条用户消息 = 上一轮已经翻篇：收尾卡不再跟着走 */
    releaseTailCards() {
      for (const node of thread) if (node.kind === "deliverable") node.__tail = false;
    },

    /* 历史回来：先补增量，再按新游标继续 */
    onHistory(id, json) {
      // 只认「当前这次请求」的响应：快速切会话时旧响应会迟到，
      // 拿它的消息推进 cursor / 改 running，等于把上一个会话的状态套到当前会话上
      if (!this.pending || id !== this.pending.id) return;
      const sid = this.pending.sid;
      this.pending = null;
      this.pollBusy = false;
      clearTimeout(this.guard);
      if (!state.pcSession || state.pcSession.id !== sid || this.sessionId !== sid) {
        // 请求发出后用户已经切走：这份响应丢掉，立刻为当前会话补拉一次
        if (this.sessionId && state.pcSession) this.request();
        return;
      }
      if (!json.ok) {
        this.failed += 1;
        if (this.failed === 1) toast(json.error || "读取失败");
        // 刚进门就失败时流里是空的：留一句看得见的说明，别让用户对着空白屏猜
        if (this.failed === 1 && thread.length === 0) {
          this.emptyHint = NODES.text("读取电脑会话失败：" + (json.error || "未知原因") + "（会自动重试）");
          push(this.emptyHint, false);
        }
        if (this.failed > 6) {
          // 电脑够不着了：退出电脑会话视图，别留一个还在显示上一段正文、
          // 却再也刷不动的「假连接」。回本地这一场，用户随时能再从列表点回去。
          const why = json.error || "连不上电脑";
          this.leave();
          renderMode();
          toast(why + "（已回到本机会话）");
        }
        return;
      }
      this.failed = 0;
      // 读通了就把「读取失败」那句撤掉
      if (this.emptyHint) {
        const at = thread.indexOf(this.emptyHint);
        if (at >= 0) {
          // 只摘这一条 DOM：整表重绘会让已经渲染好的历史再闪一次
          thread.splice(at, 1);
          const el = document.querySelector(`#messages [data-uid="${nodeUid(this.emptyHint)}"]`);
          if (el) { el.remove(); if (renderTailFrom > thread.length) renderTailFrom = thread.length; }
          else renderThread();
        }
        this.emptyHint = null;
      }
      // 电脑把这场会话当前用的模型放在 selected 里：选择器要靠它标「当前」，
      // 否则面板永远显示默认档，看着像切了没生效。
      // 旧版电脑回的是 { lastUsed, next }，这里也认，免得版本一错就把「当前」丢了。
      const sel0 = json.selected;
      const sel = sel0 && sel0.model ? sel0 : (sel0 && (sel0.next || sel0.lastUsed)) || null;
      if (sel && sel.model) this.selected = sel;
      // 目录先到、模型后到（或反过来）都要落到胶囊上：只在目录回调里刷，
      // 会一直挂着「电脑上的模型」这个占位（真机实测）
      syncComposerMode();
      if (json.context) Link.context = json.context;
      if (json.breakdown) Link.breakdown = json.breakdown;
      syncPcContext();
      const messages = json.messages || [];
      this.appended = false;
      for (const message of messages) this.append(message);
      if (messages.length) {
        this.cursor = Math.max(this.cursor, ...messages.map((m) => m.seq || 0));
      }
      if (this.appended) {
        this.appended = false;
        if (this.needRender) { this.needRender = false; renderThread(); scrollToBottom(); }
        // 新节点已经就地接在流末尾：这里只把视口带到底部（连贴三帧），不重建整张对话
        else settleFollow();
      }
      this.running = Boolean(json.running);
      if (!this.running) {
        // 电脑那边已经跑完了：历史里还挂着「运行中」的都是没收尾的旧调用，
        // 结果事件可能已被截断。收尾成「完成」，不留下永远转圈的假状态。
        // 这一收口必须在落卡之前 —— 卡片是「本轮交付」的落款，不能压在还在转的
        // 工具行前面（用户看到的「工具行还没结束结果就出来了」）。
        this.finishRunningTools();
        // 落卡等一小段静默：running 会短暂为 false（消息刚进队列、agent 还没起来
        // 时也是 false），见到 false 就落会把卡插进本轮中间。
        this.scheduleFlush();
        // 别一看到 running=false 就收等待态：消息刚进队列、agent 还没起来时也是 false，
        // 那一下会把「深度求索中」瞬间抹掉（实测）。等够 8 秒还什么都没有才收。
        if (!PcRun.node || Date.now() - (PcRun.node.started || 0) > 8000) PcRun.stop();
      } else {
        this.cancelFlush();
      }
      this.syncHeader();
      this.syncStop();
    },
  };

  /* 两种连法：
     · 跨网 —— 电脑面板复制一行配对串，粘上就 connect（地址随机、口令 128 bit，都不该手抄）
     · 局域网 —— 照抄中继地址 / 房间号 / 口令三项，同一网络里开箱能用
     没有二维码，也没有五分钟就过期的配对码。 */
  function sheetLinkConnect() {
    const s = Link.state();
    return `
    <div class="sheet-title">连接电脑</div>
    <div class="sheet-sub">粘贴电脑面板上的配对串，或照抄三项</div>
    <div class="field"><label>配对串（跨网推荐）</label><input id="linkPairing" value="" placeholder="dshlink1:… 一行" autocapitalize="off" autocorrect="off" spellcheck="false" /></div>
    <div class="pair-row">
      <button class="btn-primary pair-main" id="linkPasteBtn">粘贴并连接</button>
      <button class="btn-ghost pair-clip" id="linkClipBtn">从剪贴板</button>
    </div>
    <div class="sheet-caption" style="margin:2px 2px 10px">手机不在同一个网络、或电脑在另一个网络时用上面这条。下面三项是同一局域网的老路。</div>
    <div class="field"><label>中继地址</label><input id="linkRelay" value="${esc(s.relay || "")}" placeholder="http://192.168.1.8:8787" inputmode="url" autocapitalize="off" autocorrect="off" /></div>
    <div class="field"><label>房间号</label><input id="linkRoom" value="${esc(s.room || "")}" placeholder="电脑面板上的「房间号」" autocapitalize="off" autocorrect="off" /></div>
    <div class="field"><label>中继口令</label><input id="linkKey" type="password" value="" placeholder="电脑面板上的「中继口令」" autocapitalize="off" autocorrect="off" /></div>
    <button class="btn-primary" id="linkConnectBtn">连接</button>
    <div class="sheet-caption" style="margin:-4px 2px 8px">口令错误将拒绝</div>
    ${Link.diagHTML()}
    <button class="btn-ghost" id="linkProbeBtn">测试连接</button>
    <div id="linkProbeBox"></div>
    <button class="btn-ghost" id="linkHostDirect">同一局域网 · 直连宿主机 Web UI</button>
    ${s.paired ? '<button class="btn-ghost" id="linkFormUnpair">解除配对</button>' : ""}`;
  }

  /** 关掉贴着控件的浮层 */
  function closePcPopover() {
    const el = $("#pcPopover");
    if (el) el.remove();
    document.removeEventListener("click", pcPopoverOutside, true);
  }

  function pcPopoverOutside(e) {
    const el = $("#pcPopover");
    if (el && !el.contains(e.target)) closePcPopover();
  }

  /** 浮层里的点击：权限 / 指令 / 图片 / 选模型（和 sheet 那套共用 data 属性） */
  function pcPopoverClick(e) {
    const el = $("#pcPopover");
    if (!el || !el.contains(e.target)) return;
    const perm = e.target.closest("[data-pc-perm]");
    if (perm) {
      closePcPopover();
      toast("正在切换权限…");
      try { Native.linkCommand("pc-perm-" + Date.now(), state.pcSession.id, "/permission " + perm.dataset.pcPerm); } catch (_) { toast("当前环境不支持"); }
      return;
    }
    const cmd = e.target.closest("[data-pc-cmd]");
    if (cmd) {
      closePcPopover();
      toast("正在执行 " + cmd.dataset.pcCmd + "…");
      try { Native.linkCommand("pc-run-" + Date.now(), state.pcSession.id, cmd.dataset.pcCmd); } catch (_) { toast("当前环境不支持"); }
      return;
    }
    if (e.target.closest("[data-pc-pick=\"image\"]")) { closePcPopover(); pickPcImages(); return; }
    const need = e.target.closest("[data-pc-need]");
    if (need) { closePcPopover(); toast(need.dataset.pcNeed + "：这边还没有通道，请在电脑端操作"); return; }
    const effort = e.target.closest("[data-pc-effort-set]");
    if (effort) {
      const sel = Link.selected || {};
      closePcPopover();
      if (!sel.provider || !sel.model) { toast("先选一个模型"); return; }
      Link.selectModel(sel.provider, sel.model, effort.dataset.pcEffortSet).catch((err) => toast(err.message || "切换失败"));
      return;
    }
    const pick = e.target.closest("[data-pc-model-set]");
    if (pick) {
      const parts = String(pick.dataset.pcModelSet).split("|");
      closePcPopover();
      Link.selectModel(parts[0], parts[1], "").catch((err) => toast(err.message || "切换失败"));
    }
  }

  /** 在 anchor 正上方弹出；宽度夹在视口内，高度自己滚。kind 给异步重画认门用 */
  function openPcPopover(anchorEl, inner, kind) {
    closePcPopover();
    if (!anchorEl) return;
    const wrap = document.createElement("div");
    wrap.id = "pcPopover";
    wrap.className = "pc-pop";
    if (kind) wrap.dataset.pcPop = kind;
    const card = document.createElement("div");
    card.className = "pc-pop-card";
    card.innerHTML = inner;
    wrap.appendChild(card);
    document.body.appendChild(wrap);
    const r = anchorEl.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 24);
    card.style.width = w + "px";
    wrap.style.left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left + r.width / 2 - w / 2)) + "px";
    wrap.style.bottom = Math.max(12, window.innerHeight - r.top + 8) + "px";
    setTimeout(() => document.addEventListener("click", pcPopoverOutside, true), 0);
  }

  /** ＋ 浮层：添加图片 / 权限 / 调用指令（电脑端同一批入口） */
  function pcActionsHtml() {
    const list = Link.pcCommands;
    const cmds = (list || []).map((c) => `<button class="pc-pop-item" data-pc-cmd="/${esc(c.name)}"><span>/${esc(c.name)}<span class="desc">${esc(c.description || "")}</span></span></button>`).join("");
    const loading = list === null || list === undefined;
    return `
      <div class="group-title">添加图片</div>
      <button class="pc-pop-item" data-pc-pick="image">添加图片<span class="desc">从手机选图，随这条消息发给电脑</span></button>
      <div class="group-title">权限</div>
      <button class="pc-pop-item" data-pc-perm="read-only">仅可查看</button>
      <button class="pc-pop-item" data-pc-perm="workspace-write">工作区内修改</button>
      <button class="pc-pop-item" data-pc-perm="danger-full-access">完全权限</button>
      <div class="group-title">调用指令</div>
      ${cmds || `<div style="padding:6px 8px;font-size:12px;color:var(--label-2)">${loading ? "正在读取电脑端的命令…" : "这台电脑上这场会话没有可调用的命令"}</div>`}`;
  }

  /** 模型浮层：按 provider 分组，当前那条标蓝；选中模型能调强度时再挂一组「思考强度」 */
  function pcModelsHtml() {
    const cat = Link.catalog;
    if (!cat) return `<div style="padding:6px 8px;font-size:12px;color:var(--label-2)">正在读取电脑上的模型…</div>`;
    const groups = cat.groups || [];
    const sel = Link.selected || {};
    const list = groups.map((g) => `<div class="group-title">${esc(g.name)}</div>` + (g.models || []).map((m) => {
      const on = sel.provider === g.id && sel.model === m.id;
      return `<button class="pc-pop-item ${on ? "is-on" : ""}" data-pc-model-set="${esc(g.id)}|${esc(m.id)}">${esc(m.name || m.id)}${on ? " ✓" : ""}</button>`;
    }).join("")).join("");
    const flat = groups.flatMap((g) => (g.models || []).map((m) => ({ ...m, provider: g.id })));
    const current = flat.find((m) => m.id === sel.model && (!sel.provider || m.provider === sel.provider));
    const efforts = (current && current.reasoning && current.reasoning.efforts) || [];
    if (!efforts.length) return list;
    // 强度是「这个模型」的属性：和电脑端一样，选了哪个模型就列它自己的档位
    const effort = `<div class="group-title">思考强度</div>` +
      `<button class="pc-pop-item ${sel.reasoningEffort ? "" : "is-on"}" data-pc-effort-set="">默认${sel.reasoningEffort ? "" : " ✓"}</button>` +
      efforts.map((e) => {
        const on = sel.reasoningEffort === e.id;
        return `<button class="pc-pop-item ${on ? "is-on" : ""}" data-pc-effort-set="${esc(e.id)}"><span>${esc(e.name || e.id)}${e.description ? `<span class="desc">${esc(e.description)}</span>` : ""}</span>${on ? " ✓" : ""}</button>`;
      }).join("");
    return list + effort;
  }

  /** 新建电脑会话：先选工作区（真实工作区优先，其次「已有会话所在的目录」） */
  function sheetPcWorkspace() {
    const real = Link.wsList;
    const dirs = Link.workspaceDirs || [];
    const folder = (p) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || p;
    const rowsReal = (real || []).map((w) => `
      <button class="sheet-item" data-pc-ws="${esc(w.workspaceId || "")}">
        <span class="act-ico indigo"><svg class="ico"><use href="#i-branch"/></svg></span>
        <span class="nm">${esc(w.title || w.path || "工作区")}<span class="desc">${esc(w.path || "")}</span></span>
        <span class="row-value">${w.sessions || 0}</span>
      </button>`).join("");
    const rowsDirs = dirs.map((d) => `
      <button class="sheet-item" data-pc-cwd="${esc(d)}">
        <span class="act-ico indigo"><svg class="ico"><use href="#i-files"/></svg></span>
        <span class="nm">${esc(folder(d))}<span class="desc">${esc(d)}</span></span>
      </button>`).join("");
    const rows = rowsReal || rowsDirs;
    const loading = real === null || real === undefined;
    const listBlock = rows || `<div class="sheet-caption" style="margin:2px 4px 10px">${loading ? "正在读取电脑上的工作区…" : "电脑上还没有可选的目录"}</div>`;
    return `
      <div class="sheet-title">新建电脑会话</div>
      <div class="sheet-sub">和电脑端一样：会话跑在一个目录里</div>
      <div class="sheet-list act-group">${listBlock}</div>
      <div class="sheet-list act-group">
        <button class="sheet-item" data-pc-ws-new="1"><span class="act-ico teal"><svg class="ico"><use href="#i-plus"/></svg></span><span class="nm">新目录…<span class="desc">填电脑上一个已存在的目录</span></span></button>
        <button class="sheet-item" data-pc-cwd=""><span class="act-ico blue"><svg class="ico"><use href="#i-cpu"/></svg></span><span class="nm">默认工作区<span class="desc">用电脑端配置的默认目录</span></span></button>
      </div>`;
  }

  /** 新目录：填电脑上的路径，在那里新建会话 */
  function sheetPcWorkspaceNew() {
    return `
      <div class="sheet-title">在电脑上的新目录里新建会话</div>
      <div class="sheet-sub">填一个电脑上**已存在**的目录路径</div>
      <div class="field"><input id="pcWsPath" placeholder="D:\\work\\项目名" autocapitalize="off" autocorrect="off" spellcheck="false" /></div>
      <button class="btn-primary" id="pcWsOk">在该目录新建会话</button>
      <div class="sheet-caption" style="margin:2px 2px 10px">目录要先在电脑上存在。手机这条链路没有「创建工作区」接口，这里按目录直接建会话 —— 它会以这个目录出现在会话页的分组里。</div>`;
  }

  function sheetLinkSessions() {
    const s = Link.state();
    return `
    <div class="sheet-title">电脑会话</div>
    <div class="sheet-sub">${esc(s.host || "已配对电脑")} · 电脑上的真实会话</div>
    <div class="sheet-list" id="linkList"><div class="sheet-caption">正在读取电脑会话…</div></div>
    <div class="sheet-list act-group">
      <button class="sheet-item" id="linkNewSession"><span class="act-ico green"><svg class="ico"><use href="#i-plus"/></svg></span><span class="nm">新建电脑会话<span class="desc">和电脑端一样，先选工作区</span></span></button>
      <button class="sheet-item" id="linkRefresh"><span class="act-ico blue"><svg class="ico"><use href="#i-share"/></svg></span><span class="nm">刷新</span></button>
      <button class="sheet-item" id="linkRescan"><span class="act-ico indigo"><svg class="ico"><use href="#i-link"/></svg></span><span class="nm">连接另一台电脑<span class="desc">重新填地址</span></span></button>
      <button class="sheet-item destructive" id="linkUnpair"><span class="act-ico graphite"><svg class="ico"><use href="#i-unlink"/></svg></span><span class="nm">解除配对</span></button>
    </div>`;
  }

  function startNewSession() {
    if (state.pcSession) Link.leave();
    // 团队快照与成员视图都属于「上一场」：不清就会带进新会话 ——
    // 顶栏团队角标还显示旧会话的成员数（用户实测：新建对话后角标仍有数字），
    // 更糟的是从成员视图里点新建时，输入框的消息会继续发给那个 teammate。
    if (state.teamView) {
      state.teamView = null;
      stopTeamViewPoll();
      syncTeamViewBar();
    }
    // 新建会话 = 换一场：上一场的「我在看哪个队友」不能再被重开时捡回来
    try { localStorage.removeItem("dsh.teamView"); } catch (_) {}
    state.team = null;
    syncTeamBadge();
    // 上一轮还在跑：先停掉并结算，否则新会话的按钮会卡在「终止」态
    if (state.busy) stopLive(true);
    persistThread();
    if (queueOf().length) {
      queueOf().length = 0;
      renderQueue();
      toast("已切换会话，原来的排队消息已清空", 2200);
    }
    if (currentMode() === "local") {
      state.sessionId = "";
      // 不要清空刚切走的那个会话的桶：它已经落库，节点留着下次点回来能直接复用
      // （含思考展开、工具行开合这些纯内存状态）。这里只需要一份空白的新流。
      attachBlank("");
      renderThread();
      $("#chatTitle").textContent = "新会话";
      $("#chatSub").textContent = "本地 · " + modelLabel();
      syncModeBar();
      go("chat");
      return;
    }
    if (!state.host) { toast("先连上宿主机，才能创建会话"); openSheet(sheetHostDirect()); return; }
    Host.call("session/create", {})
      .then((result) => {
        const sid = result?.id || result?.sessionId || ("local-" + Date.now());
        loadSessions().then(() => openSession(sid));
      })
      .catch((e) => toast("创建失败：" + e.message));
  }

  /* ============ 用户提示词（角色设定）查看器 ============
     入口在「设置 → 查看用户提示词」。**只展示用户自己的角色设定**：
     内置的身份句、工具说明、运行时上下文属于内核实现，不在这里暴露 ——
     一是用户真正关心的是"我给模型定的角色有没有生效"，二是把十几段内部规则
     摊在设置页里只会淹没那一小段自己写的东西。
     显示的文本不是速记，而是真正拼进 system prompt 的那一段（personaPrompt()）。 */
  const sheetPromptViewer = () => {
    const p = PERSONAS.find((x) => x.id === state.persona);
    const custom = state.persona && !p;
    const lv = (PERSONA_LEVELS.find((x) => x.id === (state.personaStrength || "normal")) || PERSONA_LEVELS[1]);
    const text = personaPrompt();
    const name = p ? p.name : (custom ? "自定义" : "未设置");
    return `
    <div class="sheet-title">用户提示词</div>
    <div class="sheet-sub">你写的角色设定，会拼进系统提示词一起发给模型</div>
    <div class="pv-meta">
      <span class="pv-chip">${esc(name)}</span>
      ${text ? `<span class="pv-chip">${esc(lv.name)}</span><span class="pv-chip">${text.length} 字</span>` : ""}
    </div>
    ${text
      ? `<pre class="pv-pre" id="pvText">${esc(text)}</pre>
         <div class="sheet-caption">下一条起注入的原文</div>`
      : `<div class="mem-empty">当前是默认人格，没有角色设定被注入。<br/>去「角色设定」选一个，或写一段自己的。</div>`}
    <div class="sheet-list act-group" style="margin-top:10px">
      ${text ? `<button class="sheet-item" id="pvCopy"><span class="act-ico blue"><svg class="ico"><use href="#i-copy"/></svg></span><span class="nm">复制这段设定</span></button>` : ""}
      <button class="sheet-item" id="pvEdit"><span class="act-ico purple"><svg class="ico"><use href="#i-user"/></svg></span><span class="nm">${text ? "修改角色设定" : "去设置角色设定"}</span></button>
      <button class="sheet-item plain" data-close>关闭</button>
    </div>`;
  };

  /* ============ 检查更新 ============
     网络与下载都在原生后台线程跑（几百 MB 占着 JS 线程会卡死 UI），
     状态经 window.DSHHost.onUpdate 推回来，这里只重画 #upBody 一块 ——
     整表 openSheet 会在进度每次变化时闪一下。 */
  const Update = { state: null };

  function upSize(n) {
    if (!n) return "";
    return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  }

  function updateBody(s) {
    const en = EN();
    const st = (s && s.state) || "idle";
    const v = (s && s.name) || "";
    const local = (s && s.local) || "";
    if (st === "checking") {
      return `<div class="up-head">${en ? "Checking…" : "正在检查…"}</div><div class="up-meta">${en ? "Checking GitHub for the latest version" : "向 GitHub 查询最新版本"}</div>`;
    }
    if (st === "latest") {
      return `<div class="up-head">${en ? "Up to date" : "已是最新版"}</div>
        <div class="up-meta">${en ? "Current" : "当前"} ${esc(local)}${v ? (en ? " · Remote " : " · 远端 ") + esc(v) : ""}</div>
        <button class="btn-ghost" data-close>${en ? "OK" : "好的"}</button>`;
    }
    if (st === "available") {
      // 只给「版本号 + 包大小」。Release 正文不在这儿显示 —— 那是一大段 changelog，
      // 塞进一个小浮窗只会把两个按钮挤下去。
      return `<div class="up-head">${en ? "New version found " : "发现新版本 "}${esc(v)}</div>
        <div class="up-meta">${en ? "Current" : "当前"} ${esc(local)}${s.size ? (en ? " · Package " : " · 安装包 ") + upSize(s.size) : ""}</div>
        <button class="btn-primary" id="upGo">${en ? "Update now" : "立即更新"}</button>
        <button class="btn-ghost" data-close>${en ? "Later" : "以后再说"}</button>`;
    }
    if (st === "downloading") {
      const pct = Math.max(0, Math.min(100, Number(s.pct) || 0));
      // 源名称由原生给（center.sourceLabel），前端不再自己猜序号含义
      const where = s.srcName || (en ? "download source" : "下载源");
      return `<div class="up-head">${en ? "Downloading " : "正在下载 "}${pct}%</div>
        <div class="up-meta">${where} · ${en ? "opens the system installer when done" : "下完直接进系统安装界面"}</div>
        <div class="up-bar"><i style="width:${pct}%"></i></div>
        <button class="btn-ghost" id="upCancel">${en ? "Cancel" : "取消"}</button>`;
    }
    if (st === "ready") {
      // onUpdate 推来的 ready 会自动拉起安装器（见 DSHHost.onUpdate）；
      // 重开浮窗看到的是同一个状态，这里给一个手动入口，别什么都不显示
      return `<div class="up-head">${en ? "Download complete" : "下载完成"}</div>
        <div class="up-meta">${en ? "Tap below to open the system installer" : "点下面的按钮进入系统安装界面"}</div>
        <button class="btn-primary" id="upInstall">${en ? "Install" : "安装"}</button>
        <button class="btn-ghost" data-close>${en ? "Later" : "稍后"}</button>`;
    }
    if (st === "permission") {
      // Android 8+ 的「安装未知应用」是逐应用授权：侧载时给浏览器开过的不算本应用的。
      // 这里给一个明确的去设置入口 + 开完回来继续装的按钮，别把用户丢在「点安装没反应」。
      return `<div class="up-head">${en ? "One permission left" : "还差一步授权"}</div>
        <div class="up-meta">${esc(en ? (s.error || "Allow this app to install apps") : (s.error || "请允许本应用安装应用"))}</div>
        <button class="btn-primary" id="upPermission">${en ? "Open settings" : "去设置里打开"}</button>
        <button class="btn-ghost" id="upInstall">${en ? "Enabled, install now" : "已打开，继续安装"}</button>`;
    }
    if (st === "error") {
      return `<div class="up-head">${en ? "Something went wrong" : "没能完成"}</div>
        <div class="up-meta">${esc(en ? (s.error || "Unknown error") : (s.error || "未知错误"))}</div>
        <button class="btn-primary" id="upRetry">${en ? "Retry" : "重试"}</button>
        <button class="btn-ghost" data-close>${en ? "Close" : "关闭"}</button>`;
    }
    return `<div class="up-head">${en ? "Check for updates" : "检查更新"}</div>
      <div class="up-meta">${en ? "Current" : "当前"} ${esc(local)}</div>
      <button class="btn-primary" id="upCheck">${en ? "Check" : "检查"}</button>
      <button class="btn-ghost" data-close>${en ? "Close" : "关闭"}</button>`;
  }

  /** 前端自改：源码在 workspace/.dsh-src/parts/，改完 rebuild + reload 即生效 */
  function sheetSelfModify() {
    let s = {};
    try {
      s = JSON.parse((Native && Native.selfModify ? Native.selfModify("status") : "") || "{}");
    } catch (_) {}
    const en = EN();
    const row = (k, v) => `<div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>`;
    return `
      <div class="sheet-title">${en ? "Self-modify front end" : "前端自改"}</div>
      <div class="sheet-sub">${en ? "Edit this app's own JS, rebuild and reload — no reinstall" : "改本 App 自己的界面与逻辑：改源码 → 重建 → 重载，不用重新装包"}</div>
      <div class="usage-grid">
        ${row(en ? "State" : "状态", s.overlayActive ? (en ? "overlay active" : "覆盖生效中") : (s.enabled ? (en ? "on" : "已开启") : (en ? "off" : "关闭")))}
        ${row(en ? "Sources" : "源码目录", "workspace/.dsh-src/parts/")}
        ${row(en ? "Parts" : "源码份数", String(s.partCount || 0))}
        ${row(en ? "Built" : "重建产物", s.builtBytes ? Math.round(s.builtBytes / 1024) + " KB" : "—")}
      </div>
      <button class="btn-primary" data-sm="enable">${en ? "Enable (extract sources)" : "开启并展开源码"}</button>
      <button class="btn-ghost" data-sm="rebuild">${en ? "Rebuild app.js" : "重建 app.js"}</button>
      <button class="btn-ghost" data-sm="reload">${en ? "Reload page" : "重载页面使改动生效"}</button>
      <button class="btn-ghost" data-sm="disable">${en ? "Pause overlay" : "暂停覆盖"}</button>
      <button class="btn-ghost" data-sm="restore">${en ? "Restore built-in" : "恢复内置版本"}</button>
      <div class="sheet-caption" style="margin-top:10px">${en
        ? "Modified JS can call every native bridge. If the page breaks, use Restore built-in; invalid overlays are ignored automatically."
        : "覆盖的 JS 能调用全部原生桥，改动前请确认来源。改坏时点「恢复内置版本」；产物体检不通过会自动回落内置版本，不会白屏变砖。"}</div>`;
  }

  const sheetUpdate = () => `
    <div class="sheet-title">${EN() ? "Check for updates" : "检查更新"}</div>
    <div class="sheet-sub">${EN() ? "Reinstall keeps all chats, memory and settings" : "覆盖安装会保留全部会话、记忆与设置"}</div>
    <div id="upBody">${updateBody(Update.state)}</div>`;

  function paintUpdate() {
    const box = $("#upBody");
    if (box) box.innerHTML = updateBody(Update.state);
  }

  /** 状态机入口：重开浮窗时先按上次结果还原，没有历史就自动查一次 */
  function openUpdateSheet() {
    if (!Native || !Native.updateState) { toast(EN() ? "Update check isn't supported in this build" : "当前版本不支持检查更新"); return; }
    let st = {};
    try { st = JSON.parse(Native.updateState() || "{}"); } catch (_) {}
    const live = st.last || null;        // 最近一次状态（可能来自后台下载服务）
    if (live && live.state) {
      Update.state = { ...st, ...live };
    } else if (st.downloaded) {
      Update.state = { ...st, state: "ready" };   // 包已下好、还没装
    } else {
      Update.state = { ...st, state: "idle" };
    }
    openSheet(sheetUpdate());
    if (Update.state.state === "idle") {
      Update.state = { ...Update.state, state: "checking" };
      paintUpdate();
      try { Native.updateCheck(); } catch (_) {}
    }
  }

  function openPromptViewer() {
    openSheet(sheetPromptViewer());
  }

  /**
   * 设置页「用户提示词」那一行：有角色显示字数，没有显示「默认」。
   *
   * 以前这段只在启动时算一次（init 里），于是选完角色后这一行仍停在「未设置」——
   * 用户看到的就是「我明明开了角色设定，这里怎么一直未设置」。角色、强度、
   * 自定义正文三处变更后都必须重算。
   * 没角色时也不再用「未设置」这个词：默认人格本来就没有额外段落，
   * 写「未设置」容易让人以为设置没保存。
   */
  function refreshPromptRow() {
    const pv = $("#promptValue");
    if (!pv) return;
    const n = personaPrompt().length;
    pv.textContent = n ? n + " 字" : "默认";
  }

  function sheetMore() {
    // 两个「连电脑」的入口不能并列摆着：默认只给「电脑会话」（中继），
    // 只有真的配过局域网直连地址、且没走中继时，才额外露出宿主机 Web UI。
    const linkState = (() => { try { return JSON.parse(Native.linkState() || "{}"); } catch (_) { return {}; } })();
    const linked = linkState.paired === true;
    const direct = Boolean(state.host);
    return `
    <div class="sheet-list act-group">
      <button class="sheet-item" data-act="share"><span class="act-ico blue"><svg class="ico"><use href="#i-share"/></svg></span><span class="nm">分享会话</span></button>
      <button class="sheet-item" data-act="rename"><span class="act-ico graphite"><svg class="ico"><use href="#i-file"/></svg></span><span class="nm">重命名</span></button>
      <button class="sheet-item" data-act="search"><span class="act-ico teal"><svg class="ico"><use href="#i-search"/></svg></span><span class="nm">在对话中搜索<span class="desc">跳到含关键词的那几条</span></span></button>
      <button class="sheet-item" data-act="link"><span class="act-ico indigo"><svg class="ico"><use href="#i-link"/></svg></span><span class="nm">${linked ? "电脑会话" : "连接电脑"}<span class="desc">${linked ? esc(linkState.host || "手机联动") : "填三项连上电脑"}</span></span></button>
      ${direct ? `<button class="sheet-item" data-act="host"><span class="act-ico teal"><svg class="ico"><use href="#i-link"/></svg></span><span class="nm">宿主机 Web UI<span class="desc">局域网直连</span></span></button>` : ""}
      <button class="sheet-item" data-act="mems"><span class="act-ico indigo"><svg class="ico"><use href="#i-bookmark"/></svg></span><span class="nm">会话记忆</span><span class="row-value" style="margin-left:auto">${LocalDB.mems(state.sessionId).length || "—"}</span></button>
    </div>
    <div class="sheet-list act-group">
      <button class="sheet-item destructive" data-act="archive">删除会话<span class="row-value" style="margin-left:auto">不可恢复</span></button>
    </div>
    <div class="sheet-list act-group">
      <button class="sheet-item plain" data-close>取消</button>
    </div>`;
  }

  /* 一个入口：「连接电脑」= 中继三项（唯一在跨网/流量下都成立的路径）。
     直连宿主机只能同一局域网，且拿到的是电脑的完整 Web UI —— 那是另一件事，
     所以单独放在下面，并且只有在真的填过地址时才在菜单里露出来。 */
  /* 「连接电脑」只有一个面板（sheetLinkConnect：粘贴配对串 / 中继三项）。
     这里剩的是另一件事：直连局域网里那台电脑的完整 Web UI —— 它要的是宿主机地址 +
     Launch Token，拿到的是整台机器的界面，和手机联动不是一条路，不再混在同一个面板里。 */
  const sheetHostDirect = () => `
    <div class="sheet-title">宿主机 Web UI</div>
    <div class="sheet-sub">仅同一局域网 · 直连这台电脑的完整界面</div>
    <div class="field"><label>宿主机地址</label><input id="hostInput" value="${esc(state.host || "")}" placeholder="http://192.168.1.8:3080" inputmode="url" autocapitalize="off" /></div>
    <div class="field"><label>Launch Token</label><input id="tokenInput" type="password" value="${esc(state.launchToken || "")}" placeholder="dsh web 启动时输出的 URL 里的 token 参数" autocapitalize="off" /></div>
    <button class="btn-primary" id="btnHostDirect">${state.host ? "直连并打开 Web UI" : "直连宿主机"}</button>
    ${state.host ? '<button class="btn-ghost" id="btnDisconnect">断开宿主机，回到本地会话</button>' : ""}
    <div class="sheet-caption" style="margin-top:10px">要用手机流量或跨网连电脑，走「设置 → 连接电脑」粘贴配对串，不是这里。</div>`;

  /* ---------------- 运行方式（本地独立 / 连接主机） ---------------- */
  /* 新对话默认档位：只定初始值；对话内的临时切换走输入框旁的模式条 */
  const sheetPresetDefault = () => `
    <div class="sheet-title">新对话默认档位</div>
    <div class="sheet-sub">对话内仍可随时用模式条临时切换</div>
    <div class="sheet-list">
      ${PRESETS.map((p) => `
        <div class="sheet-item ${state.preset === p.id ? "is-on" : ""}" data-dpreset="${p.id}" role="button" tabindex="0">
          <span class="nm">${esc(p.name)}<span class="desc">${esc(p.desc)}</span></span>
          <svg class="ico check"><use href="#i-check"/></svg>
        </div>`).join("")}
    </div>
    <div class="sheet-caption">档位决定对话能用到哪些工具：极简最省 token；PTC 只暴露 run_code 程序化调用；创造模式可写插件改自身</div>`;

  const sheetMode = () => {    const mode = currentMode();
    return `
    <div class="sheet-title">运行方式</div>
    <div class="sheet-sub">本地直连模型；连宿主机可用文件与终端</div>
    <div class="sheet-list">
      <button class="sheet-item ${mode === "local" ? "is-on" : ""}" data-mode="local">
        <span class="nm">本地独立<span class="desc">${localReady() ? "已配置 " + esc(hostOf(endpointOf(findModel(state.model)).url)) : "需要先配置模型 API 与密钥"}</span></span>
        <svg class="ico check"><use href="#i-check"/></svg>
      </button>
      <button class="sheet-item ${mode === "host" ? "is-on" : ""}" data-mode="host">
        <span class="nm">连接主机<span class="desc">${state.host ? esc(state.host) : "未填写宿主机地址"}</span></span>
        <svg class="ico check"><use href="#i-check"/></svg>
      </button>
    </div>
    <button class="btn-ghost" id="btnHostConfig">${state.host ? "修改宿主机地址" : "填写宿主机地址"}</button>
    <div class="sheet-caption" style="margin-top:10px">本地会话存本机，主机会话存宿主</div>`;
  };

  /**
   * 输入框换装：电脑会话用电脑端那一套（卡片 + 控制行），本机会话保持玻璃胶囊。
   *
   * 只切一个 class：布局、尺寸、材质都在 styles.css 的 .composer.is-pc 里，
   * 本机那条路径一个字节都不动。
   */
  function syncComposerMode() {
    const composer = document.querySelector(".composer");
    const chip = $("#btnPcModel");
    const pc = Boolean(state.pcSession);
    if (composer) composer.classList.toggle("is-pc", pc);
    if (chip) {
      chip.hidden = !pc;
      // 和电脑端一样，这里显示「这场会话现在用的模型」
      if (pc) chip.textContent = modelLabelOf(Link.selected || {});
    }
    const mic = $("#btnMic");
    if (mic) {
      // 电脑端没有麦克风：PC 会话里收起来；回到本机会话按语音开关恢复
      if (pc) mic.hidden = true;
      else VoicePlugin.apply();
    }
  }

  /** PC 输入区下面那行上下文占用：和电脑端同一个投影，读不到就不显示 */
  function syncPcContext() {
    const el = $("#pcContext");
    if (!el) return;
    const c = state.pcSession ? Link.context : null;
    if (!c || !c.contextWindow) { el.hidden = true; return; }
    el.hidden = false;
    const pct = Math.max(0, Math.min(100, Number(c.percent) || 0));
    const arc = el.querySelector(".pc-ctx-arc");
    if (arc) {
      const C = 2 * Math.PI * 5.5;
      arc.style.strokeDasharray = C.toFixed(2);
      arc.style.strokeDashoffset = (C * (1 - pct / 100)).toFixed(2);
    }
    const label = $("#pcContextPct");
    if (label) label.textContent = pct + "%";
    el.setAttribute("aria-label", "上下文已用 " + pct + "%，" + kTokens(c.usedTokens) + " / " + kTokens(c.contextWindow));
  }

  const kTokens = (n) => {
    const v = Number(n) || 0;
    if (v >= 1000000) return (Math.round(v / 100000) / 10).toFixed(1).replace(/\.0$/, "") + "M";
    if (v >= 1000) return Math.round(v / 1000) + "k";
    return String(v);
  };

  /** 点圆环：电脑端 ContextMeter 那个浮层的手机版（系统提示词 / 工具 / 对话三段） */
  function pcContextHtml() {
    const c = Link.context || {};
    const b = Link.breakdown || null;
    const pct = Math.max(0, Math.min(100, Number(c.percent) || 0));
    const rows = b ? [
      { name: "系统提示词", value: b.systemTokens, color: "var(--indigo)" },
      { name: "工具", value: b.toolsTokens, color: "var(--teal)" },
      { name: "对话", value: b.messageTokens, color: "var(--blue)" },
    ] : [];
    const total = rows.reduce((sum, r) => sum + (Number(r.value) || 0), 0);
    const bar = total > 0
      ? `<div class="ctx-bar">${rows.filter((r) => r.value > 0).map((r) =>
        `<i style="width:${(r.value / total * 100).toFixed(2)}%;background:${r.color}"></i>`).join("")}</div>`
      : "";
    const list = rows.length
      ? `<div class="ctx-rows">${rows.map((r) => `
          <div class="ctx-row">
            <span class="ctx-dot" style="background:${r.color}"></span>
            <span class="ctx-name">${esc(r.name)}</span>
            <span class="ctx-num">${kTokens(r.value)}</span>
          </div>`).join("")}</div>`
      : "";
    return `
      <div class="group-title">上下文已用 ${pct}%</div>
      <div class="ctx-figures">约 ${kTokens(c.usedTokens)} / ${kTokens(c.contextWindow)} tokens</div>
      ${bar}
      ${list || `<div class="ctx-empty">这台电脑没有上报构成，只能看总量。</div>`}`;
  }

  function renderMode() {
    const v = $("#modeValue");
    if (v) v.textContent = currentMode() === "host" ? "连接主机" : "本地独立";
    const dv = $("#presetValue");
    if (dv) dv.textContent = presetOf(state.preset).name;
    const hv = $("#hostValue");
    if (hv) {
      // 中继配对优先展示：这是「连接电脑」的主路径；局域网直连地址次之
      const ls = (() => { try { return JSON.parse(Native.linkState() || "{}"); } catch (_) { return {}; } })();
      // 「配过对」不等于「现在连得上」：心跳失败时要老实写出来，
      // 不然电脑关机了，设置里还挂着它的名字，像是一直可用
      const b = Link.beat || {};
      hv.textContent = ls.paired
        ? (b.at !== 0 && !b.ok ? "连不上电脑" : (ls.host || "已连接电脑"))
        : (state.host ? state.host.replace(/^https?:\/\//, "") : "未连接");
    }
    syncChatSub();
    renderFiles();
    renderJobs();
  }

  function bindSheet() {
    document.addEventListener("click", pcPopoverClick, true);
    // 底部按钮（.sheet-footer）会被 openSheet 移到 #sheetBody 之外，
    // 监听必须挂在 #sheet 上，否则「保存 / 取消」点了没反应、浮窗也不关。
    $("#sheet").addEventListener("click", async (e) => {
      // 电脑会话：模型 / 思考强度，选中即写给电脑
      const pcModel = e.target.closest("[data-pc-model-set]");
      if (pcModel) {
        const [provider, model] = String(pcModel.dataset.pcModelSet).split("|");
        toast("正在切换…");
        Link.selectModel(provider, model, "").catch((err) => toast(err.message || "切换失败"));
        return;
      }
      // 电脑会话里 ＋ 菜单的三个动作
      const pcCmd = e.target.closest("[data-pc-cmd]");
      if (pcCmd) {
        const line = String(pcCmd.dataset.pcCmd || "");
        closeSheet();
        toast("正在执行 " + line + "…");
        try { Native.linkCommand("pc-run-" + Date.now(), state.pcSession.id, line); } catch (_) { toast("当前环境不支持"); }
        return;
      }
      // 选工作区 → 在该工作区新建会话
      const pcWs = e.target.closest("[data-pc-ws]");
      if (pcWs) {
        closeSheet();
        Link.createSessionIn(pcWs.dataset.pcWs || "");
        return;
      }
      if (e.target.closest("[data-pc-ws-new]")) { openSheet(sheetPcWorkspaceNew()); return; }
      if (e.target.closest("#pcWsOk")) {
        const dir = $("#pcWsPath") ? $("#pcWsPath").value.trim() : "";
        if (!dir) return toast("先填电脑上的目录");
        closeSheet();
        Link.createSession(dir);
        return;
      }
      const pcPerm = e.target.closest("[data-pc-perm]");
      if (pcPerm) {
        const preset = String(pcPerm.dataset.pcPerm || "");
        closeSheet();
        toast("正在切换权限…");
        try { Native.linkCommand("pc-perm-" + Date.now(), state.pcSession.id, "/permission " + preset); } catch (_) { toast("当前环境不支持"); }
        return;
      }
      const pcNeed = e.target.closest("[data-pc-need]");
      if (pcNeed) { closeSheet(); toast(pcNeed.dataset.pcNeed + "：这边还没有通道，请在电脑端操作"); return; }
      // 新建电脑会话：选定工作区后交给电脑的 create（cwd 为空 = 用电脑的默认工作区）
      const pcCwd = e.target.closest("[data-pc-cwd]");
      if (pcCwd) {
        closeSheet();
        Link.createSession(pcCwd.dataset.pcCwd || "");
        return;
      }
      const pcEffort = e.target.closest("[data-pc-effort-set]");
      if (pcEffort) {
        const sel = Link.selected || {};
        if (!sel.provider || !sel.model) { toast("先选一个模型"); return; }
        Link.selectModel(sel.provider, sel.model, pcEffort.dataset.pcEffortSet).catch((err) => toast(err.message || "切换失败"));
        return;
      }
      const pcRetry = e.target.closest("[data-pc-model-retry]");
      if (pcRetry) {
        toast("正在重新读取电脑上的模型…");
        Link.models(true).then((cat) => {
          // 等目录这十几秒里用户可能已经关掉面板：只在这一块还开着时才重画
          if (state.pcSession && document.querySelector("#sheetBody [data-pc-model-panel]")) openSheet(sheetPcAgent());
          if (!cat) toast("电脑上没答出来：确认桌面端在运行，或稍后再试");
        });
        return;
      }
      // 表情包编辑态：点面板里任何格子以外的地方都退出（点 ✕ / 点格子各走自己的分支）
      const stickerGridEl = $("#stickerGrid");
      if (stickerGridEl && stickerGridEl.classList.contains("is-editing") && !e.target.closest("#stickerGrid")) {
        stickerGridEl.classList.remove("is-editing");
        stickerGridEl.style.touchAction = "";
        stickerGridEl.querySelectorAll(".is-dragging").forEach((el) => el.classList.remove("is-dragging"));
      }
      const del = e.target.closest("[data-del]");
      if (del) {
        const id = del.dataset.del;
        state.models = state.models.filter((m) => m.id !== id);
        persistModels();
        if (state.model === id) setModel(state.models[0].id);
        openSheet(sheetModel());
        toast("已删除模型");
        return;
      }
      const edit = e.target.closest("[data-edit]");
      if (edit) { openSheet(sheetModelForm(edit.dataset.edit)); return; }

      /* ---- 用户提示词（角色设定）查看器 ---- */
      /* ---- 检查更新 ---- */
      if (e.target.closest("#upCheck") || e.target.closest("#upRetry")) {
        Update.state = { ...(Update.state || {}), state: "checking" }; paintUpdate();
        try { Native.updateCheck(); } catch (_) {}
        return;
      }
      if (e.target.closest("#upGo")) {
        Update.state = { ...(Update.state || {}), state: "downloading", pct: 0 }; paintUpdate();
        try { Native.updateDownload(); } catch (_) {}
        return;
      }
      if (e.target.closest("#upInstall")) {
        try { Native.updateInstall(); } catch (_) {}
        return;
      }
      if (e.target.closest("#upPermission")) {
        try { Native.updatePermission(); } catch (_) {}
        return;
      }
      /* ---- 前端自改（sheetSelfModify）---- */
      const sm = e.target.closest("[data-sm]");
      if (sm) {
        const act = sm.dataset.sm;
        let r = {};
        try {
          r = JSON.parse((Native && Native.selfModify ? Native.selfModify(act) : "") || "{}");
        } catch (_) {}
        toast(r.message || (r.ok ? "完成" : "操作失败"));
        if (act === "reload") return;              // 页面要重载了，别再画面板
        if (act === "enable" || act === "disable" || act === "restore") {
          closeSheet();
          setTimeout(() => openSheet(sheetSelfModify()), 60);
        }
        return;
      }
      if (e.target.closest("#upCancel")) {
        try { Native.updateCancel(); } catch (_) {}
        closeSheet();
        return;
      }

      if (e.target.closest("#pvCopy")) { copyText(personaPrompt()); return; }
      if (e.target.closest("#pvEdit")) { openSheet(sheetPersona()); haptic("light"); return; }

      const preset = e.target.closest("[data-effort]");
      if (preset) {
        setEffortIndex(+preset.dataset.effort);
        renderEffort();
        haptic("medium");
        return;
      }
      if (e.target.closest("#btnFetchModels")) {
        const urlEl = $("#mUrl");
        const url = urlEl ? urlEl.value.trim() : "";
        const keyEl2 = $("#mKey");
        const key = keyEl2 ? keyEl2.value.trim() : "";
        if (!url) { toast("请先填写 API 地址"); return; }
        state.modelDraft = {
          editingId: state.editingModelId,
          name: $("#mName").value.trim(),
          id: $("#mId").value.trim(),
          upstream: $("#mUpstream").value.trim(),
          url,
          key,
          efforts: $("#mEfforts").value.trim(),
        };
        // 账号额度模型：目录来自平台 `GET /models`（x-dsh-auth-token），不是 OpenAI 的 /v1/models
        const editing = state.editingModelId ? findModel(state.editingModelId) : null;
        if (editing && editing.auth === "account") {
          if (!Native || !Native.accountModels) { toast("当前环境不支持账号模型目录"); return; }
          const res = (() => { try { return JSON.parse(Native.accountModels()); } catch (_) { return null; } })();
          if (!res || !res.ok) { toast("拉取失败：" + ((res && res.error) || "未登录 DeepSeek 账号")); return; }
          openSheet(sheetModelPicker(res.models.map((x) => x.id), url));
          return;
        }
        if (!Native || !Native.fetchModels) { toast("当前环境不支持拉取"); return; }
        state.modelFetchId = "mf" + Date.now();
        toast("正在拉取模型…");
        Native.fetchModels(state.modelFetchId, url, key);
        return;
      }
      const tip = e.target.closest("[data-effort-tip]");
      if (tip) {
        const input = $("#mEfforts");
        if (!input) return;
        const tok = tip.dataset.effortTip;
        const cur = normalizeEfforts(input.value);
        const next = cur.includes(tok) ? cur.filter((x) => x !== tok) : [...cur, tok];
        // 按标准档位顺序排好，避免用户手点出「max, off, low」这种乱序
        next.sort((a, b) => EFFORT_TOKENS.indexOf(a) - EFFORT_TOKENS.indexOf(b));
        input.value = next.join(", ");
        tip.classList.toggle("is-on", next.includes(tok));
        return;
      }
      // 「模型选择」列表 → 回填到模型表单。
      // 这里必须用 data-pick-model 而不是 data-pick：多选删除弹层的会话项也用
      // data-pick，而这段判断在上面的点击分发里**排在它之前** —— 同名属性会让
      // 「点会话勾选」直接打开模型配置浮层（用户实测）。
      const pick = e.target.closest("[data-pick-model]");
      if (pick) {
        const upstream = pick.dataset.pickModel;
        const draft = state.modelDraft || {};
        const pickedCtx = (state.modelCtx || {})[upstream] || 0;
        openSheet(sheetModelForm(draft.editingId || null, {
          ...draft,
          ctx: pickedCtx || draft.ctx || 0,
          upstream,
          name: draft.name || upstream,
          id: draft.id || upstream,
        }));
        return;
      }
      if (e.target.closest("#btnBackToForm")) {
        const draft = state.modelDraft || {};
        openSheet(sheetModelForm(draft.editingId || null, draft));
        return;
      }
      const ctxOpt = e.target.closest("[data-ctx]");
      if (ctxOpt) {
        state.context = ctxOpt.dataset.ctx;
        localStorage.setItem("dsh.context", state.context);
        $("#ctxValue").textContent = state.context;
        syncContextChips();
        closeSheet(); toast("上下文窗口：" + state.context);
        return;
      }
      const outOpt = e.target.closest("[data-out]");
      if (outOpt) {
        state.maxOut = outOpt.dataset.out;
        localStorage.setItem("dsh.maxOut", state.maxOut);
        $("#outValue").textContent = state.maxOut;
        syncContextChips();
        closeSheet(); toast("最大输出：" + state.maxOut);
        return;
      }
      const compactOpt = e.target.closest("[data-compact]");
      if (compactOpt) {
        state.compactMode = compactOpt.dataset.compact;
        localStorage.setItem("dsh.compactMode", state.compactMode);
        $("#compValue").textContent = compactLabel();
        closeSheet(); toast("上下文压缩：" + compactLabel());
        return;
      }
      const permOpt = e.target.closest("[data-perm]");
      if (permOpt) {
        const id = permOpt.dataset.perm;
        if (!applyPermission(id, "settings")) return;   // 同档或已弹确认页
        // 留在这一页重画：勾要立刻挪到新选项上，别让人以为没切过去
        openSheet(sheetPerm());
        toast("Agent 权限：" + (PERMS.find((x) => x.id === id)?.name || id));
        return;
      }
      if (e.target.closest("#btnConfirmFull")) {
        state.perm = "full";
        localStorage.setItem("dsh.perm", state.perm);
        syncPermUI();
        if (state.permOrigin === "quick") openSheet(sheetQuickActions());
        else openSheet(sheetPerm());
        state.permOrigin = null;
        toast("已开启完全访问");
        haptic("heavy");
        return;
      }
      if (e.target.closest("[data-island-reset]")) {
        // 恢复默认：居中 / 默认长度 / 留白按孔径自动。按钮在 footer 里（已被移出 sheetBody），
        // 所以必须挂在 #sheet 这一层才收得到。
        state.islandTune = { dx: 0, dy: 0, w: 0, pad: -1 };
        pushIslandTune();
        openSheet(islandTuneSheet());
        setTimeout(fillIslandLabels, 30);
        toast("灵动岛已恢复默认");
        haptic("light");
        return;
      }
      const personaOpt = e.target.closest("[data-persona]");
      if (personaOpt) {
        const id = personaOpt.dataset.persona;
        const p = PERSONAS.find((x) => x.id === id);
        state.persona = id;
        localStorage.setItem("dsh.persona", id);
        $("#personaValue").textContent = p ? p.name : "自定义";
        refreshPromptRow();
        openSheet(sheetPersona());
        toast(id ? "角色设定：" + (p ? p.name : "自定义") : "已恢复默认人格");
        return;
      }
      const plv = e.target.closest("[data-plv]");
      if (plv) {
        state.personaStrength = plv.dataset.plv;
        localStorage.setItem("dsh.personaStrength", state.personaStrength);
        refreshPromptRow();
        openSheet(sheetPersona());
        haptic("light");
        return;
      }
      if (e.target.closest("#personaPreview")) {
        openSheet(sheetPersonaPreview());
        return;
      }
      if (e.target.closest("#btnSavePersona")) {
        const text = $("#personaText").value.trim();
        state.persona = text || "";
        localStorage.setItem("dsh.persona", text ? text : "");
        $("#personaValue").textContent = text ? "自定义" : "默认";
        refreshPromptRow();
        closeSheet(); toast(text ? "角色设定已保存" : "已恢复默认");
        return;
      }
      const lang = e.target.closest("[data-lang]");
      if (lang) {
        state.lang = lang.dataset.lang;
        localStorage.setItem("dsh.lang", state.lang);
        closeSheet();
        applyLang();
        return;
      }
      if (e.target.closest("#btnCreateJob")) {
        const name = ($("#jobName").value || "").trim();
        if (!name) { toast("请填写任务名称"); return; }
        const prompt = (($("#jobPrompt") || {}).value || "").trim() || name;
        const rule = state.jobRule || "once";
        const editing = state.editingJob || null;
        try {
          if (rule === "none") {
            if (editing && editing.kind === "schedule") throw new Error("定时任务不能改成仅记录；不需要就点删除");
            const desc = ($("#jobDesc") || {}).value || "";
            if (editing) {
              const list = LocalJobs.all();
              const j = list.find((x) => x.id === editing.id);
              if (j) { j.title = name; j.note = desc.trim(); LocalJobs.write(list); }
              toast("已保存");
            } else {
              LocalJobs.create(name, desc.trim());
              toast("已记录（不会自动执行）");
            }
          } else {
            let r = null;
            if (rule === "once") {
              const min = Math.max(1, Math.round(Number(($("#jobAfterMin") || {}).value) || 5));
              r = { after_seconds: min * 60 };
            } else if (rule === "daily") {
              let t = (($("#jobDailyTime") || {}).value || "09:00").trim();
              if (/^\d{1,2}:\d{2}$/.test(t)) t += ":00";
              if (!/^\d{2}:\d{2}:\d{2}$/.test(t)) throw new Error("时间格式要写成 HH:mm");
              r = { daily: { time: t, time_zone: "Asia/Shanghai" } };
            } else if (rule === "every") {
              const min = Math.max(1, Math.round(Number(($("#jobEveryMin") || {}).value) || 60));
              if (min * 60 < 60) throw new Error("间隔至少 1 分钟");
              r = { every_seconds: min * 60 };
            }
            if (editing && editing.kind === "schedule") {
              const res = JSON.parse(Native.scheduleUpdate(editing.id, JSON.stringify({ title: name, prompt, rule: r })));
              if (res && res.error) throw new Error(res.error);
              toast("已保存，下次触发按新设置来");
            } else if (editing) {
              // 本地记录升级成定时任务：先建内核任务，建失败则保留原记录
              const desc = (($("#jobDesc") || {}).value || "").trim();
              const sid = Live.sessionId || state.sessionId || "";
              if (!sid) throw new Error("先打开一条对话再升级定时任务：到点要回到那条对话发起一轮");
              const res = JSON.parse(Native.scheduleCreate(JSON.stringify({
                title: name, prompt, rule: r, sessionId: sid,
              })));
              if (res && res.error) throw new Error(res.error);
              LocalJobs.remove(editing.id);
              toast("已转为定时任务");
            } else {
              const sid = Live.sessionId || state.sessionId || "";
              if (!sid) throw new Error("先打开一条对话再建定时任务：到点要回到那条对话发起一轮");
              const res = JSON.parse(Native.scheduleCreate(JSON.stringify({
                title: name, prompt, rule: r, sessionId: sid,
              })));
              if (res && res.error) throw new Error(res.error);
              toast(rule === "once" ? "已创建：到点自动发起一轮对话" : "已创建定时任务");
            }
          }
          state.editingJob = null;
          renderJobs();
          syncMissions();
          closeSheet();
          haptic("medium");
        } catch (err) {
          toast((editing ? "保存失败：" : "创建失败：") + (err.message || err));
        }
        return;
      }
      const jobRuleBtn = e.target.closest("[data-job-rule]");
      if (jobRuleBtn) {
        state.jobRule = jobRuleBtn.dataset.jobRule;
        $$("#jobRuleSeg button").forEach((b) => b.classList.toggle("is-on", b.dataset.jobRule === state.jobRule));
        $$("[data-rule-field]").forEach((el) => {
          el.style.display = el.dataset.ruleField === state.jobRule ? "" : "none";
        });
        haptic("light");
        return;
      }
      const qaPerm = e.target.closest("[data-quick-perm]");
      if (qaPerm) {
        const next = qaPerm.dataset.quickPerm;
        if (!applyPermission(next, "quick")) {
          if (next === state.perm) haptic("light");
          return;
        }
        syncQuickActionsUI();
        toast("Agent 权限：" + (PERMS.find((x) => x.id === next)?.name || next));
        return;
      }
      const presetPick = e.target.closest("[data-preset]");
      if (presetPick) {
        const id = presetPick.dataset.preset;
        if (id !== Modes.cur().preset) {
          Modes.patch({ preset: id });
          if (id === "minimal") {
            // 桌面极简 preset 不挂 plan-mode / goal 插件：切过去时一并退出这两种模式
            Modes.patch({ plan: false, planApproved: false });
            Modes.clearGoal();
            syncModeBar();
            toast("已切换到极简模式：仅终端与图片读取");
          } else {
            toast(`已切换到${presetOf(id).name}，下一轮对话生效`);
          }
          haptic("medium");
        }
        syncQuickActionsUI();
        return;
      }
      if (e.target.closest("#qaPlan")) {
        haptic("light");
        const m = Modes.cur();
        if (m.preset === "minimal") { toast("极简模式不提供计划模式"); return; }
        if (m.plan && !m.planApproved) {
          Modes.setPlan(false);
          toast("已关闭计划模式");
        } else {
          Modes.setPlan(true);
          toast("计划模式已开启：Agent 会先给计划，等你批准");
        }
        syncQuickActionsUI();
        return;
      }
      if (e.target.closest("#qaGoal")) {
        haptic("light");
        if (Modes.cur().preset === "minimal") { toast("极简模式不提供目标模式"); return; }
        openSheet(sheetGoal());
        return;
      }
      const goalRoundBtn = e.target.closest("[data-goal-rounds]");
      if (goalRoundBtn) {
        state.goalRoundsSel = Number(goalRoundBtn.dataset.goalRounds) || 0;
        $$("#goalRounds button").forEach((b) => {
          b.classList.toggle("is-on", Number(b.dataset.goalRounds) === state.goalRoundsSel);
        });
        const inp = $("#goalRoundsInput");
        if (inp) inp.value = "";       // 选了预设就清掉自定义，避免两个值打架
        haptic("light");
        return;
      }
      if (e.target.closest("#btnGoalStart")) {
        const ta = $("#goalText");
        const text = ((ta && ta.value) || "").trim();
        if (!text) { toast("先写下目标"); return; }
        const inp = $("#goalRoundsInput");
        const customN = Number((((inp && inp.value) || "") + "").trim());
        const cap = customN > 0
          ? Math.max(1, Math.min(60, Math.round(customN)))
          : (Number(state.goalRoundsSel) || 0);
        const old = Modes.goal();
        Modes.setGoal({
          objective: text,
          phase: "active",
          rounds: 0,
          maxRounds: cap,
          createdAt: (old && old.createdAt) || Date.now(),
          updatedAt: Date.now(),
        });
        closeSheet();
        haptic("medium");
        // 保存即开跑：不用再让用户自己补一句话才启动
        const started = await startGoalTurn(true);
        if (started) toast(cap ? `目标已生效：最多 ${cap} 轮，已开始推进` : "目标已生效：智能轮数，已开始推进");
        else toast(cap ? `目标已保存：最多 ${cap} 轮` : "目标已保存：智能轮数");
        return;
      }
      const goalAct = e.target.closest("[data-goal-act]");
      if (goalAct) {
        const g = Modes.goal();
        if (!g) return;
        const act = goalAct.dataset.goalAct;
        haptic("light");
        if (act === "toggle") {
          const resume = g.phase !== "active";
          Modes.setGoal({ ...g, phase: resume ? "active" : "paused", updatedAt: Date.now() });
          // 暂停/恢复都是一次动作，浮层跟着退场（恢复后由会话页的目标 chip 显示状态）
          closeSheet();
          if (resume) {
            toast("目标已恢复推进");
            // 恢复推进 = 立刻续跑，不用再等用户发话
            startGoalTurn(true);
          } else {
            // 桌面端语义：主人暂停目标会中止正在跑的这一轮，模型不能在同一轮里继续动手。
            // 否则本轮的 turn_end 还会带着 goalContinue 把下一轮拉起来。
            const running = state.busy || !!Live.id;
            if (running) stopLive(true);
            Modes.setGoal({ ...Modes.goal(), pausedAt: Date.now(), updatedAt: Date.now() });
            toast(running ? "目标已暂停 · 当前这一轮已停止" : "目标已暂停");
          }
        } else if (act === "done") {
          Modes.setGoal({ ...g, phase: "complete", summary: g.summary || "用户手动标记完成", updatedAt: Date.now() });
          toast("目标已完成");
          closeSheet();
        } else if (act === "clear") {
          Modes.clearGoal();
          toast("已清除目标");
          closeSheet();
        }
        return;
      }
      if (e.target.closest("#qaAttach")) {
        closeSheet();
        $("#fileInput").click();
        return;
      }
      if (e.target.closest("[data-qa-model]")) { closeSheet(); openSheet(sheetModel()); return; }
      if (e.target.closest("[data-qa-effort]")) { closeSheet(); openSheet(sheetEffort()); return; }
      if (e.target.closest("[data-qa-workspace]")) { closeSheet(); openSheet(sheetWorkspace()); return; }
      if (e.target.closest("#btnOAuthLogin")) {
        const url = "https://platform.deepseek.com/api_keys";
        if (Native && Native.openExternal) Native.openExternal(url);
        else window.open(url, "_blank");
        return;
      }
      if (e.target.closest("#btnApiKeyLogin")) { openSheet(sheetApiKey()); return; }
      // 首启引导的两个出口：去配 key（记住已引导，跳到 key 表单）/ 先逛逛（记住，直接关）
      if (e.target.closest("#obKey")) { try { localStorage.setItem(ONBOARD_KEY, "1"); } catch (_) {} openSheet(sheetApiKey()); return; }
      if (e.target.closest("#obLater")) { try { localStorage.setItem(ONBOARD_KEY, "1"); } catch (_) {} closeSheet(); return; }
      if (e.target.closest("#btnSaveKey")) {
        const key = $("#accKey").value.trim();
        if (key.length < 8) { toast("请输入有效的 API Key"); return; }
        state.account = { name: "API Key", method: "API Key", masked: maskKey(key), key };
        persistAccount();
        renderAccount();
        // 当前模型没有单独配置密钥时，直接复用这把 Key
        const m = findModel(state.model);
        if (m && !m.key) { m.key = ""; persistModels(); }
        closeSheet();
        renderSessions($("#searchSessions") ? $("#searchSessions").value : "");
        toast(localReady() ? "已启用，可直接对话" : "已保存，再填一下模型 API 地址");
        if (!localReady()) openSheet(sheetModelForm(state.model));
        return;
      }
      if (e.target.closest("#btnUsage")) {
        const url = "https://platform.deepseek.com/usage";
        if (Native && Native.openExternal) Native.openExternal(url);
        else window.open(url, "_blank");
        return;
      }
      if (e.target.closest("#btnSignOut")) { openSheet(sheetSignOut()); return; }
      if (e.target.closest("#btnConfirmSignOut")) {
        state.account = null;
        persistAccount();
        renderAccount();
    applyQuickChips();
    syncContextChips();
    syncPermUI();
        const sm = $("#swSessMem"); if (sm) sm.checked = state.sessMem;
    const sg = $("#swGlobalMem"); if (sg) sg.checked = state.globalMem;
    const pv2 = $("#personaValue"); if (pv2) pv2.textContent = PERSONAS.find((p) => p.id === state.persona)?.name || (state.persona ? "自定义" : "默认");
        closeSheet();
        toast("已退出登录");
        return;
      }
      if (e.target.closest("#btnAddModel")) { openSheet(sheetModelForm()); return; }
      if (e.target.closest("#btnGoAccount")) { Account.open(); return; }
      const hmCell = e.target.closest(".hm-cell[data-day]");
      if (hmCell) {
        const k = hmCell.dataset.day;
        state.heatSel = state.heatSel === k ? null : k;
        $$(".hm-cell[data-day]").forEach((el) => el.classList.toggle("is-sel", el.dataset.day === state.heatSel));
        const box = $("#hmDetail");
        if (box) box.innerHTML = hmDetailHTML();
        haptic("light");
        return;
      }
      if (e.target.closest("#btnRefreshUsage")) {
        refreshBalance();
        openSheet(sheetUsage());
        toast("正在刷新");
        return;
      }
      if (e.target.closest("#btnBalLogin")) {
        openSheet(Account.sheet());
        haptic("light");
        return;
      }
      if (e.target.closest("#btnBalRetry")) {
        refreshBalance();
        openSheet(sheetUsage());
        toast("正在重试");
        return;
      }
      if (e.target.closest("#btnPlatformUsage")) {
        const url = "https://platform.deepseek.com/usage";
        if (Native && Native.openExternal) Native.openExternal(url);
        else window.open(url, "_blank");
        return;
      }
      if (e.target.closest("#btnNotifySettings")) {
        if (Native && Native.notifyOpenSettings) Native.notifyOpenSettings();
        else toast("当前环境不支持跳转");
        haptic("light");
        return;
      }
      if (e.target.closest("#btnPowerBattery")) {
        if (Native && Native.requestIgnoreBattery) Native.requestIgnoreBattery();
        else toast("当前环境不支持跳转");
        haptic("light");
        return;
      }
      if (e.target.closest("#btnPowerStartup")) {
        if (Native && Native.openStartupSettings) Native.openStartupSettings();
        else toast("当前环境不支持跳转");
        haptic("light");
        return;
      }
      if (e.target.closest("#btnSaveModel")) {
        const name = $("#mName").value.trim();
        const upstream = ($("#mUpstream") ? $("#mUpstream").value.trim() : "").trim();
        const typedId = $("#mId").value.trim();
        const id = typedId || upstream.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
        const url = $("#mUrl").value.trim();
        // 账号额度模型没有 key 输入框（凭据由登录态提供），这里不能硬取
        const keyEl = $("#mKey");
        const key = keyEl ? keyEl.value.trim() : "";
        const efforts = normalizeEfforts($("#mEfforts").value);
        if (!upstream) { toast("先填「模型」：可点「拉取」选，也可直接手填上游模型名"); $("#mUpstream").focus(); return; }
        if (!id) { toast("请填写名称或本地标识"); return; }
        const editingId = state.editingModelId;
        if (!editingId && state.models.some((m) => m.id === id)) { toast("模型 ID 已存在"); return; }
        if (editingId) {
          const m = state.models.find((x) => x.id === editingId);
          if (m) {
            m.name = name;
            m.url = url;
            m.key = key;
            m.efforts = efforts;
            m.upstream = upstream;
            m.ctx = Number(state.editingCtx) || 0;
            if (!m.builtin) { m.id = id; m.desc = url || "自定义端点"; }
          }
        } else {
          state.models.push({ id, name: name || upstream, desc: url || "自定义端点", url, key, efforts, upstream, builtin: false, ctx: Number(state.editingCtx) || 0 });
        }
        persistModels();
        // 只是改配置时不要偷偷切换当前模型；新增模型才切过去
        if (!editingId) setModel(id);
        else if (state.model === editingId) setModel(editingId);
        state.editingModelId = null;
        closeSheet();
        toast("已保存");
        return;
      }
      const model = e.target.closest("[data-model]");      if (model) {
        setModel(model.dataset.model);
        closeSheet(); toast("已切换模型"); return;
      }
      const dpick = e.target.closest("[data-dpreset]");
      if (dpick) {
        const id = dpick.dataset.dpreset;
        if (id !== state.preset) {
          state.preset = id;
          localStorage.setItem("dsh.preset", id);
          // 草稿里存过的旧 preset 一并清掉：否则「新对话」读 __draft 时
          // 还是上一次临时切的档位，这个默认值永远不生效
          try {
            const all = Modes.all();
            if (all.__draft && all.__draft.preset) { delete all.__draft.preset; localStorage.setItem(Modes.KEY, JSON.stringify(all)); }
          } catch (_) {}
          const pv = $("#presetValue"); if (pv) pv.textContent = presetOf(id).name;
          toast(`新对话将默认使用${presetOf(id).name}（当前对话不变）`);
        }
        closeSheet(); return;
      }
      if (e.target.closest("[data-close]")) { closeSheet(); return; }

      const act = e.target.closest("[data-act]");
      if (act) {
        const id = act.dataset.act;
        closeSheet();
        if (id === "sticker") { openSheet(sheetStickers()); return; }
        if (id === "share") shareSession();
        if (id === "rename") {
          const s = LocalDB.get(state.sessionId);
          if (s) openSheet(sheetRename(s));
          else toast("宿主机会话请在宿主机侧重命名");
        }
        if (id === "host") openHostUI();
        if (id === "link") { Link.enter(); return; }
        if (id === "mems") { state.memEdit = null; openSheet(sheetSessionMem()); }
        if (id === "archive") {
          const s = LocalDB.get(state.sessionId);
          if (!s) { toast("宿主机会话请在宿主机那边删除"); return; }
          // 运行中的会话要删除：先停止、结算并落快照，否则按钮状态会漏到下一个会话
          if (state.busy) stopLive(true);
          persistThread();
          // 会话只有「直接删除」这一种处置：没有归档区，删掉就从本机移除，不可恢复
          purgeSession(s.id);
          state.sessionId = "";
          attachBlank("");
          renderThread();
          renderSessions();
          go("sessions");
          toast("已删除：会话与过程记录已从本机移除");
        }
      }
      const ws = e.target.closest("[data-ws]");
      if (ws) {
        state.workspace = ws.dataset.ws;
        localStorage.setItem("dsh.workspace", state.workspace);
        const wv = $("#wsValue"); if (wv) wv.textContent = state.workspace;
        closeSheet();
        toast("工作区已切换：" + state.workspace);
      }

      /* ---- 任务操作 ---- */
      const jobDone = e.target.closest("[data-job-done]");
      if (jobDone) {
        const list = LocalJobs.all();
        const j = list.find((x) => x.id === jobDone.dataset.jobDone);
        if (j) { j.status = "done"; LocalJobs.write(list); renderJobs(); }
        closeSheet();
        toast("已标记完成");
        return;
      }
      const jobRun = e.target.closest("[data-job-run]");
      if (jobRun) {
        // 立即触发一次：把 prompt 当作新一轮输入发出（与到点触发同一条路径）。
        // 以前无条件 scheduleDelete —— 周期任务按一下就没了，这就是「任务记录会消失」
        // 的另一条路。现在只有一次性任务（after/at）触发后移除，周期任务保留。
        const s = kernelSchedules().find((x) => x.id === jobRun.dataset.jobRun);
        if (!s) { toast("任务已不存在"); return; }
        const periodic = ["every", "daily", "weekly", "cron"].includes(s.kind);
        if (!periodic) Native.scheduleDelete(s.id);
        renderJobs();
        closeSheet();
        const input = $("#input");
        if (input) {
          input.value = s.prompt || s.title || "";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          go("chat");
          handleSend();
        }
        return;
      }
      const jobEdit = e.target.closest("[data-job-edit]");
      if (jobEdit) {
        const id = jobEdit.dataset.jobEdit;
        // 两种来源：内核定时任务（表单可改规则）与本机纯记录（只能改标题/说明）
        const s = kernelSchedules().find((x) => x.id === id);
        if (s) {
          state.editingJob = { kind: "schedule", id };
          openSheet(sheetNewJob({ kind: "schedule", id, title: s.title, prompt: s.prompt, rule: s.rule }));
        } else {
          const j = LocalJobs.all().find((x) => x.id === id);
          if (!j) { toast("任务已不存在"); return; }
          state.editingJob = { kind: "local", id };
          openSheet(sheetNewJob({ kind: "local", id, title: j.title, prompt: j.note, note: j.note, rule: null }));
        }
        return;
      }
      const jobDel = e.target.closest("[data-job-del]");
      if (jobDel) {
        // 派发只有一处（deleteMissionRow）：定时任务走内核 scheduleDelete、
        // 已结束的历史记录走 missionRemove、本机纯记录走 LocalJobs.remove，
        // 团队任务明确说去哪儿删。以前这里无条件 scheduleDelete + LocalJobs.remove，
        // 两边都没动账本，于是「按了删除、行还在原地」，toast 还报「已删除记录」。
        const r = deleteMissionRow(findJobRow(jobDel.dataset.jobDel));
        haptic("medium");
        toast(r.msg);
        if (r.ok) { renderJobs(); syncMissions(); closeSheet(); }
        return;
      }
      const board = e.target.closest("[data-team-board]");
      if (board) { closeSheet(); const b = $("#btnTeam"); if (b) b.click(); return; }

      /* ---- 会话操作 ----
         重命名 / 移动 / 删除这三类**统一由下面那个监听器认领**（它会先 closeSwipedRow
         再开对应的面板）。这里曾经各留了一份旧实现：`#sheet` 上挂了 4 个并列监听器，
         同一节点被两处 closest 命中就会各跑一遍 —— 删除那一份更狠，先 LocalDB.remove
         直接删掉，后面那份再弹「确认删除」框，确认形同虚设（rc.138「点 A 弹 B」同源）。
         保留的 `data-sess-ws` 只有这里认领，不动。 */
      const sessWs = e.target.closest("[data-sess-ws]");
      if (sessWs) {
        const id = sessWs.dataset.sessId;
        const target = sessWs.dataset.sessWs;
        LocalDB.setWs(id, target);
        WsState.set(target, true);        // 挪完直接把目标工作区摊开，看得见结果
        closeSheet();
        renderSessions();
        haptic("light");
        toast(`已移到「${wsEntry(target).name}」`);
        return;
      }
      if (e.target.closest("#btnConfirmDelSession")) {
        const id = e.target.closest("#btnConfirmDelSession").dataset.renameId;
        purgeSession(id);
        if (state.sessionId === id) { state.sessionId = ""; attachBlank(""); renderThread(); }
        closeSheet();
        renderSessions();
        haptic("heavy");
        toast("已删除会话");
        return;
      }
      const doRename = e.target.closest("#btnDoRename");
      if (doRename) {
        const id = doRename.dataset.renameId;
        const title = $("#renameInput").value.trim();
        if (!title) { toast("标题不能为空"); return; }
        LocalDB.rename(id, title);
        closeSheet();
        renderSessions();
        if (state.sessionId === id) $("#chatTitle").textContent = title;
        toast("已重命名");
        return;
      }

      /* ---- 多选删除 ---- */
      // 只处理会话项：模型选择项用 data-pick-model，不会再走到这里
      const pickEl = e.target.closest("[data-pick]");
      if (pickEl) {
        pickEl.classList.toggle("is-on");
        return;
      }
      if (e.target.closest("#btnDeletePicked")) {
        const ids = $$(".sheet-item.is-on[data-pick]").map((x) => x.dataset.pick);
        if (!ids.length) { toast("先勾选要删除的会话"); return; }
        ids.forEach((id) => purgeSession(id));
        if (ids.includes(state.sessionId)) { state.sessionId = ""; attachBlank(""); renderThread(); }
        closeSheet();
        renderSessions();
        toast(`已删除 ${ids.length} 个会话`);
        return;
      }
    });



    // 底部按钮（.sheet-footer）会被 openSheet 移到 #sheetBody 之外，
    // 监听必须挂在 #sheet 上，否则「保存 / 取消」点了没反应、浮窗也不关。
    $("#sheet").addEventListener("click", (e) => {
      const md = e.target.closest("[data-mode]");
      if (md) {
        const m = md.dataset.mode;
        if (m === "host" && !state.host) { closeSheet(); openSheet(sheetHostDirect()); return; }
        state.mode = m;
        localStorage.setItem("dsh.mode", m);
        closeSheet();
        toast(m === "host" ? "已切换到主机模式" : "已切换到本地独立模式");
        renderSessions($("#searchSessions") ? $("#searchSessions").value : "");
        if (m === "host") loadSessions();
        return;
      }
      if (e.target.closest("#btnHostConfig")) { closeSheet(); openSheet(sheetHostDirect()); return; }
      // 直连宿主机（局域网，完整 Web UI）
      if (e.target.id === "btnHostDirect") {
        const url = $("#hostInput") ? $("#hostInput").value.trim().replace(/\/+$/, "") : "";
        if (!/^https?:\/\//.test(url)) return toast("请输入 http(s):// 开头的宿主机地址");
        state.host = url;
        state.mode = "host";
        state.launchToken = $("#tokenInput") ? $("#tokenInput").value.trim() : "";
        localStorage.setItem("dsh.host", url);
        localStorage.setItem("dsh.mode", "host");
        if (state.launchToken) localStorage.setItem("dsh.launchToken", state.launchToken);
        closeSheet();
        if (Native && Native.connectHost) {
          Native.connectHost(url);
          toast("正在连接宿主机…");
        } else {
          toast("浏览器预览无法直连，请在 App 内使用");
        }
        renderMode();
        loadSessions();
      }
      if (e.target.id === "btnDisconnect") {
        state.host = "";
        state.mode = "local";
        localStorage.removeItem("dsh.host");
        localStorage.setItem("dsh.mode", "local");
        if (Native && Native.clearHost) Native.clearHost();
        closeSheet();
        toast("已回到本地独立模式");
        renderSessions($("#searchSessions") ? $("#searchSessions").value : "");
      }
    });
  }

  /* ---------------- native actions ---------------- */
