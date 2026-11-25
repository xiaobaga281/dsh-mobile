  /**
   * 用户当前真正选中的文字（只认 root 内的选区）。
   *
   * 为什么要有它：长按消息的动作面板里那个「复制」，实现一直是
   * `copyText(node.text)` —— 也就是整条消息；取不到模型节点时更狠，直接
   * `el.textContent` 把整块 .msg（含思考行、工具行、时间）全塞进剪贴板。
   * 用户明明用系统选择手柄圈了半句，点完却得到「全部」。复制什么必须由
   * 选区说了算，不能由触发复制的那个按钮猜。
   */
  function selectedTextIn(root) {
    try {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return "";
      const anchor = sel.anchorNode;
      const el = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentNode);
      if (root && el && !root.contains(el)) return "";
      return String(sel.toString() || "").trim();
    } catch (_) {
      return "";
    }
  }

  /* @pure:begin selection-copy */
  /** 复制决策：用户圈了字就只给圈中的部分，没圈才给整条。
   *  纯函数，供 scripts/regress/selection-copy.test.mjs 按真实源码跑断言。 */
  function copyDecision(picked, whole) {
    const has = String(picked || "").trim();
    return has
      ? { text: has, label: "已复制选中内容" }
      : { text: String(whole || ""), label: "已复制整条消息" };
  }
  /* @pure:end selection-copy */

  /** label 让调用方能说清复制的是「选中的部分」还是「整条消息」，别再一律「已复制」 */
  function copyText(text, label) {
    const s = String(text || "");
    const tip = label || "已复制";
    if (!s) { toast("没有可复制的内容"); return; }
    try {
      if (Native && Native.copy) {
        // 桥返回 false 说明系统剪贴板拒了（部分 ROM 限制后台写），继续走兜底
        if (Native.copy(s) !== false) { toast(tip); return; }
      }
    } catch (_) {}
    const legacy = () => {
      // execCommand("copy") 要先 select 一个临时 textarea，那会清掉用户选区。
      // 复制完把选区还回去 —— 否则用户接着想再选一次，手柄已经没了。
      let ranges = [];
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount) {
          for (let i = 0; i < sel.rangeCount; i++) ranges.push(sel.getRangeAt(i).cloneRange());
        }
      } catch (_) {}
      const ta = document.createElement("textarea");
      ta.value = s; ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, s.length);
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (_) {}
      ta.remove();
      try {
        if (ranges.length) {
          const sel = window.getSelection();
          sel.removeAllRanges();
          ranges.forEach((r) => sel.addRange(r));
        }
      } catch (_) {}
      toast(ok ? tip : "复制失败");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(s).then(() => toast(tip), legacy);
    } else {
      legacy();
    }
  }

  /** 分享会话：导出成一份可读的 Markdown 记录（标题 + 时间 + 逐条对话） */
  function shareSession() {
    const title = ($("#chatTitle").textContent || "会话").trim();
    const sid = state.sessionId || Live.sessionId;
    const stored = sid ? (LocalDB.get(sid) || {}) : {};
    const raw = (stored.messages || []).slice();
    const lines = [`# ${title}`, "", `> 导出自 DeepSeek Harness · ${new Date().toLocaleString("zh-CN")}`, ""];
    if (raw.length) {
      raw.slice(-60).forEach((m) => {
        const who = m.role === "user" ? "🧑 我" : "🤖 Agent";
        const text = String(m.content || "").trim();
        if (!text) return;
        lines.push(`**${who}**`, "", text, "");
      });
    } else {
      // 没有本地记录（例如远程会话）：至少把当前对话流里的正文带上
      thread.forEach((n) => {
        if (n && n.kind === "text" && String(n.text || "").trim()) {
          lines.push(`**🤖 Agent**`, "", String(n.text).trim(), "");
        }
      });
    }
    if (lines.length <= 4) { toast("这个会话还没有可分享的内容"); return; }
    let text = lines.join("\n");
    if (text.length > 20000) text = text.slice(0, 20000) + "\n\n…（已截断）";
    if (Native && Native.share) Native.share(text);
    else if (navigator.share) navigator.share({ title, text }).catch(() => {});
    else { copyText(text); toast("没有可用的分享目标，已复制到剪贴板"); }
  }

  function openHostUI() {
    if (!state.host) { openSheet(sheetHostDirect()); return; }
    if (Native && Native.connectHost) Native.connectHost(state.host);
    else toast("宿主 UI 需在 App 内打开");
  }


  /* ---------------- 语音输入浮层 ---------------- */
  function voiceOpen(tip) {
    const v = $("#voiceVeil");
    if (!v) return;
    v.classList.add("is-on");
    v.setAttribute("aria-hidden", "false");
    const t = $("#voiceTip");
    if (t) t.textContent = tip || "说完点确认";
    voiceSet("正在聆听…", false);
  }

  function voiceClose() {
    const v = $("#voiceVeil");
    // 面板一关，会话就必须结束：否则引擎留在后台继续收音，
    // 用户随便说句话 partial 又会把面板弹回来（表现为「没人点语音却自动弹出」）。
    if (state.voiceLive === true) {
      state.voiceLive = false;
      state.__cpVoiceReply = false;
      voiceClearWatch();
      if (Native && Native.cancelVoiceInput) Native.cancelVoiceInput();
    }
    if (!v) return;
    v.classList.remove("is-on");
    v.setAttribute("aria-hidden", "true");
  }

  function voiceSet(text, dim) {
    const live = $("#voiceLive");
    if (!live) return;
    live.textContent = text;
    live.classList.toggle("is-dim", !!dim);
  }

  /* 停止收音后等结果的看门狗：原生偶尔会因为「引擎已收尾」而不回任何事件，
     那样面板会一直停在「正在识别…」——点确认看起来就像没反应。这里兜底关闭。 */
  let voiceWatch = 0;
  function voiceClearWatch() {
    if (voiceWatch) { clearTimeout(voiceWatch); voiceWatch = 0; }
  }
  function voiceAwaitResult() {
    voiceClearWatch();
    voiceWatch = setTimeout(() => {
      voiceWatch = 0;
      const v = $("#voiceVeil");
      if (!v || !v.classList.contains("is-on")) return;
      voiceClose();
      toast("没听到内容，再说一次");
    }, 6000);
  }

  /* 后台残留的语音会话：收到「不是用户发起」的 partial/listening 就把它关掉。
     原生每 ~120ms 一条 partial，这里 3 秒去抖，别把 cancel 打爆。 */
  let voiceStrayAt = 0;
  function voiceCancelStray() {
    const now = Date.now();
    if (now - voiceStrayAt < 3000) return;
    voiceStrayAt = now;
    if (Native && Native.cancelVoiceInput) Native.cancelVoiceInput();
  }

  /* ---------------- 表情包 ----------------
     和人在聊天里一样：加号面板里选表情发送；相册图片可以转成表情包（静图压缩到 200px，
     GIF 原样保留动图）；发过的表情自动进仓库，Agent 也能列举 / 发送 / 收藏同一份仓库。 */
  const Stickers = {
    all() {
      if (!(Native && Native.stickerList)) return [];
      try { return JSON.parse(Native.stickerList() || "[]"); } catch (_) { return []; }
    },
    save(entry) {
      if (!(Native && Native.stickerSave)) return null;
      try {
        const r = JSON.parse(Native.stickerSave(
          entry.id || "", entry.name || "表情", entry.kind || "static",
          entry.mime || "image/png", entry.dataUrl, entry.w || 0, entry.h || 0));
        return r && r.ok ? r.id : null;
      } catch (_) { return null; }
    },
    bump(id) { if (Native && Native.stickerBump) { try { Native.stickerBump(id); } catch (_) {} } },
    remove(id) { if (Native && Native.stickerRemove) { try { Native.stickerRemove(id); } catch (_) {} } },
    /** 长按拖完之后落库：ids 是面板里从左到右、从上到下的顺序 */
    reorder(ids) {
      if (!(Native && Native.stickerReorder)) return false;
      try { return !!JSON.parse(Native.stickerReorder(JSON.stringify(ids)) || "{}").ok; } catch (_) { return false; }
    },

    /**
     * 面板里的顺序。
     *
     * 默认按「常用优先」（uses 降序，再按最近使用）；但只要有人手动拖过，
     * 每条就都带上了 order，这时必须按 order 走 —— 否则拖完一刷新又被常用度冲回去。
     */
    ordered() {
      const list = this.all().slice();
      const manual = list.some((st) => Number.isFinite(st.order) && st.order >= 0);
      if (manual) {
        // order = -1 是「还没排过位」的新表情，必须落到末尾；
        // 直接拿 -1 比较会把它顶到第一位（曾经就是这么错的）。
        const pos = (st) => (Number.isFinite(st.order) && st.order >= 0 ? st.order : 1e9);
        return list.sort((a, b) =>
          pos(a) - pos(b) || (b.uses || 0) - (a.uses || 0));
      }
      return list.sort((a, b) =>
        (b.uses || 0) - (a.uses || 0) || (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
    },

    /** 图片 → 表情包：静图走 canvas 压到 200px 以内；GIF 不动（保住动图） */
    toSticker(dataUrl, name) {
      return new Promise((resolve) => {
        const isGif = /image\/gif/i.test(dataUrl) || /\.gif(\?|$)/i.test(name || "");
        if (isGif) { resolve({ dataUrl, kind: "gif", mime: "image/gif", w: 0, h: 0 }); return; }
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, 200 / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const cv = document.createElement("canvas");
          cv.width = w; cv.height = h;
          const c2 = cv.getContext("2d");
          if (!c2) { resolve({ dataUrl, kind: "static", mime: "image/png", w, h }); return; }
          c2.drawImage(img, 0, 0, w, h);
          resolve({ dataUrl: cv.toDataURL("image/png"), kind: "static", mime: "image/png", w, h });
        };
        img.onerror = () => resolve(null);
        img.src = dataUrl;
      });
    },

    /** 发送：气泡里显示表情包本体，同时把图片作为附件发给模型（它看得见） */
    send(entry) {
      const clean = { ...entry, name: entry.name || "表情" };
      Stickers.bump(clean.id);
      state.stickerPending = clean;
      const input = $("#input");
      if (input) {
        // 措辞要给小模型明确的「社交语境」：只写 "[表情包] 名字" 它会脑补成任务
        // （实测 1B 模型会照着交付规则去复读上一轮的文件）。说清「看图回应、别干活」。
        input.value =
          "（我发了一个表情包跟你玩，图片在附件里）表情名：" + clean.name +
          "。看看图里是什么，像朋友一样自然地回应一两句就好——这不是任务，不要调用工具、不要写文件。";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      handleSend();
    },
  };

  /** 全屏媒体查看器：对话里是缩略图，点开才加载完整资源（视频也不在流里偷偷缓冲） */
  const MediaView = {
    el: null,
    ensure() {
      if (this.el && document.body.contains(this.el)) return this.el;
      const d = document.createElement("div");
      d.className = "media-view";
      d.innerHTML = `<div class="mv-stage"></div>
        <button class="mv-close" aria-label="关闭"><svg class="ico"><use href="#i-x"/></svg></button>`;
      d.addEventListener("click", (e) => {
        // 点关闭按钮、点空白处都退出；点图/视频本体保留（看细节、拖进度条）
        if (e.target.closest(".mv-close")) { MediaView.close(); return; }
        if (e.target.classList.contains("mv-stage") || e.target === d) MediaView.close();
      });
      const host = $("#device") || document.body;
      host.appendChild(d);
      this.el = d;
      return d;
    },
    open(node) {
      if (!node || !node.dataUrl) return;
      const d = this.ensure();
      const stage = d.querySelector(".mv-stage");
      stage.innerHTML = (node.mediaKind || (node.kind === "video" ? "video" : "image")) === "video"
        ? `<video class="mv-video" src="${esc(node.dataUrl)}" controls playsinline autoplay></video>`
        : `<img class="mv-img" src="${esc(node.dataUrl)}" alt="${esc(node.name || "")}" />`;
      d.classList.add("is-on");
      haptic("light");
    },
    close() {
      if (!this.el) return;
      this.el.classList.remove("is-on");
      const stage = this.el.querySelector(".mv-stage");
      // 清空 = 停掉视频播放并释放解码器，别让声音在后台继续
      if (stage) stage.innerHTML = "";
    },
  };

  /** 表情包选择面板（加号 → 表情包） */
  /* ---------------- 生成模型（图片 / 视频） ---------------- */
  function genCfg() {
    try { return JSON.parse(Native.genConfig() || "{}"); } catch (_) {
      return { image: {}, video: {} };
    }
  }
  /** 极简状态：只回「未配置 / 部分配置 / 已配置」，不再列图片/视频与对号 */
  function syncGenValue() {
    const el = $("#genValue");
    if (!el) return;
    const c = genCfg();
    const n = (c.image && c.image.configured ? 1 : 0) + (c.video && c.video.configured ? 1 : 0);
    el.textContent = n === 0 ? "未配置" : n === 2 ? "已配置" : "部分配置";
  }
  const genFields = (kind, label, ph) => {
    const c = genCfg()[kind] || {};
    return `
      <div class="group-title">${label}</div>
      <div class="field"><label>接口地址（OpenAI 兼容）</label>
        <input id="genUrl_${kind}" value="${esc(c.url || "")}" placeholder="${ph}" autocapitalize="off" spellcheck="false" /></div>
      <div class="field"><label>API Key</label>
        <input id="genKey_${kind}" value="${esc(c.key || "")}" type="password" autocapitalize="off" spellcheck="false" /></div>
      <div class="field"><label>模型名</label>
        <input id="genModel_${kind}" value="${esc(c.model || "")}" placeholder="${kind === "video" ? "sora-2 / veo-3 / …" : "gpt-image-1 / flux / …"}" autocapitalize="off" spellcheck="false" /></div>`;
  };
  const sheetGenModels = () => `
    <div class="sheet-title">生成模型</div>
    <div class="sheet-sub">兼容接口</div>
    ${genFields("image", "图片模型", "https://api.example.com/v1")}
    ${genFields("video", "视频模型", "https://api.example.com/v1")}
    <button class="btn-primary" id="btnGenSave">保存</button>
    <button class="btn-ghost" data-close>取消</button>`;

  const sheetStickers = () => {
    // 常用优先；拖过一次之后按人手排的位置（见 Stickers.ordered）
    const list = Stickers.ordered();
    const rows = list.map((st) => `
      <button class="sticker-cell" data-sticker-id="${esc(st.id)}" data-sticker-send="${esc(st.id)}">
        <img src="${esc(st.dataUrl)}" alt="${esc(st.name)}" loading="lazy" draggable="false" />
        <span class="sticker-nm">${esc(st.name)}${st.kind === "gif" ? " · 动图" : ""}</span>
        <span class="sticker-del" role="button" aria-label="删除这个表情"><svg class="ico"><use href="#i-x"/></svg></span>
      </button>`).join("");
    return `
      <div class="sheet-title">表情包${list.length ? `<span class="sheet-count">${list.length}</span>` : ""}</div>
      <div class="sheet-sub">长按排序，✕ 删除</div>
      <div class="sticker-grid" id="stickerGrid">${rows || '<div class="sheet-caption">还没有表情包 · 点下面从相册选一张转成表情</div>'}</div>
      <button class="btn-primary" id="btnStickerPick">从相册选图转成表情</button>
      <input type="file" id="stickerFile" accept="image/*" hidden />
      <button class="btn-ghost" data-close>取消</button>`;
  };

  /**
   * 表情包面板的长按手势：长按 → 进入编辑态（每个格子右上角露出 ✕），
   * 继续按住拖动就能换位置，松手落库。
   *
   * 用 pointer 事件而不是 click + 定时器：手指一按就开始计时，移动超过阈值就
   * 判定成「在滚面板」，立刻取消长按 —— 否则一滚动就误触编辑态。
   */
  function bindStickerGrid() {
    const grid = $("#stickerGrid");
    if (!grid) return;
    let timer = null;
    let pressCell = null;
    let startX = 0;
    let startY = 0;
    let editing = false;
    let dragging = false;
    let dirty = false;

    const cancelPress = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      pressCell = null;
    };
    const leaveEdit = () => {
      editing = false;
      dragging = false;
      grid.classList.remove("is-editing");
      grid.style.touchAction = "";  // 交还滚动权，表情多的时候面板才能滚
      grid.querySelectorAll(".is-dragging").forEach((el) => el.classList.remove("is-dragging"));
    };

    grid.addEventListener("pointerdown", (event) => {
      const cell = event.target.closest(".sticker-cell");
      if (!cell) return;
      if (event.target.closest(".sticker-del")) return;  // 删除按钮自己处理
      pressCell = cell;
      startX = event.clientX;
      startY = event.clientY;
      dragging = false;
      cancelPress();
      pressCell = cell;
      timer = setTimeout(() => {
        timer = null;
        editing = true;
        dirty = false;
        grid.classList.add("is-editing");
        // 长按成立之后才关掉滚动接管：手指还没动，此时切换不会打断正在进行的滚动；
        // 反过来若一开始就 none，表情一多面板就滚不动了。
        grid.style.touchAction = "none";
        haptic("medium");
      }, 380);
    });

    grid.addEventListener("pointermove", (event) => {
      if (!pressCell) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!editing) {
        if (Math.hypot(dx, dy) > 10) cancelPress();  // 在滚面板，不是长按
        return;
      }
      event.preventDefault();
      if (!dragging) {
        dragging = true;
        pressCell.classList.add("is-dragging");
      }
      const over = document.elementFromPoint(event.clientX, event.clientY);
      const target = over ? over.closest(".sticker-cell") : null;
      if (!target || target === pressCell || !grid.contains(target)) return;
      // 交换式排序：拖过谁就把自己插到谁的位置，比算坐标更稳
      const cells = Array.from(grid.querySelectorAll(".sticker-cell"));
      const from = cells.indexOf(pressCell);
      const to = cells.indexOf(target);
      if (from < 0 || to < 0) return;
      if (from < to) target.after(pressCell); else target.before(pressCell);
      dirty = true;
      haptic("light");
    });

    const finish = () => {
      const moved = editing && dirty;
      const wasEditing = editing;
      const cell = pressCell;
      cancelPress();
      if (moved) {
        const ids = Array.from(grid.querySelectorAll(".sticker-cell")).map((el) => el.dataset.stickerId);
        Stickers.reorder(ids);
        toast("顺序已保存");
      }
      if (wasEditing) {
        // 长按后松手停在原地：保持编辑态让用户点 ✕（点别处才退出）
        if (cell) cell.classList.remove("is-dragging");
        dragging = false;
        return;
      }
      leaveEdit();
    };

    grid.addEventListener("pointerup", finish);
    grid.addEventListener("pointercancel", finish);
    grid.addEventListener("pointerleave", () => { if (!editing) cancelPress(); });

    // 点空白处退出编辑态
    grid.addEventListener("click", (event) => {
      if (!editing) return;
      if (event.target.closest(".sticker-del")) return;
      if (event.target.closest(".sticker-cell")) return;
      leaveEdit();
    });
  }

  /* ---------------- 运行时权限（分组管理，能申请的全申请） ---------------- */
  const PERM_GROUPS = [
    { id: "mic", name: "麦克风", desc: "语音输入", icon: "i-mic", tint: "blue" },
    { id: "location", name: "位置", desc: "定位与附近", icon: "i-globe", tint: "teal" },
    { id: "contacts", name: "通讯录", desc: "查找联系人", icon: "i-user", tint: "green" },
    { id: "camera", name: "相机", desc: "拍照提问", icon: "i-camera", tint: "orange" },
    { id: "media", name: "照片与媒体", desc: "读取本机媒体", icon: "i-file", tint: "purple" },
    { id: "notifications", name: "通知", desc: "完成与回复提醒", icon: "i-chat", tint: "indigo" },
  ];
  const Perm = {
    map: {},        // id -> {granted, canAsk}
    known: false,
  };

  function permSync() {
    if (!Native || !Native.getPermissionState) return;
    try {
      const s = JSON.parse(Native.getPermissionState() || "{}");
      for (const g of PERM_GROUPS) {
        if (s[g.id]) Perm.map[g.id] = { granted: !!s[g.id].granted, canAsk: !!s[g.id].canAsk };
      }
      Perm.known = true;
    } catch (_) {}
    permPaint();
  }

  const permGrantedCount = () => PERM_GROUPS.filter((g) => Perm.map[g.id] && Perm.map[g.id].granted).length;

  function permPaint() {
    const v = $("#permValue");
    if (v) {
      const n = permGrantedCount();
      v.textContent = !Perm.known ? "—" : (n === PERM_GROUPS.length ? "已全部授权" : `${n}/${PERM_GROUPS.length} 已授权`);
    }
  }

  /** 权限面板：first=true 时是首次启动引导 */
  function sheetPermission(first) {
    if (!Native || !Native.getPermissionState) {
      return `
      <div class="sheet-title">权限</div>
      <div class="sheet-sub">浏览器环境，权限由浏览器管理。</div>`;
    }
    const allGranted = permGrantedCount() === PERM_GROUPS.length;
    const canAskSome = PERM_GROUPS.some((g) => Perm.map[g.id] && Perm.map[g.id].canAsk);
    const blockedSome = PERM_GROUPS.some((g) => Perm.map[g.id] && !Perm.map[g.id].granted && !Perm.map[g.id].canAsk);
    const title = first ? "开启完整能力" : "权限";
    const sub = first
      ? "用于语音、定位、拍照等；只在对应功能中使用。"
      : "点任意一行单独申请；已禁用的去系统设置打开。";
    const rows = PERM_GROUPS.map((g) => {
      const st = Perm.map[g.id] || {};
      const cls = st.granted ? "ok" : (st.canAsk ? "no" : "warn");
      const txt = st.granted ? "已授权" : (st.canAsk ? "未授权" : "已禁用");
      return `
      <button class="perm-row" data-perm-req="${g.id}">
        <span class="perm-row-ico ${g.tint}"><svg class="ico"><use href="#${g.icon}"/></svg></span>
        <span class="perm-row-main">
          <span class="nm">${g.name}</span>
          <span class="desc">${g.desc}</span>
        </span>
        <span class="perm-st ${cls}">${txt}</span>
      </button>`;
    }).join("");
    let act = "";
    if (canAskSome) act += `<button class="btn-primary" id="permAskAll">全部允许</button>`;
    if (blockedSome) act += `<button class="btn-ghost" id="permSettings">去系统设置开启被禁用的权限</button>`;
    if (allGranted) act = `<button class="btn-primary" id="permDone">完成</button>`;
    else if (first) act += `<button class="btn-ghost" id="permLater">稍后再说</button>`;
    return `
    <div class="perm-hero">
      <span class="perm-hero-ico"><svg class="ico"><use href="#i-shield"/></svg></span>
      <div class="sheet-title">${title}</div>
      <div class="sheet-sub">${sub}</div>
    </div>
    <div class="perm-list">${rows}</div>
    <div class="perm-actions">${act}</div>
    <div class="sheet-caption">可随时撤回</div>`;
  }

  function permAskGroup(id) {
    if (!Native || !Native.requestPermission) return;
    haptic("light");
    Native.requestPermission(id);
  }

  /* ---------------- 记忆面板 ---------------- */
  const memTime = (ts) => {
    if (!ts) return "";
    const d = new Date(ts);
    const now = new Date();
    const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  };

  const MEM_BADGE = { fact: "事实", pref: "偏好", decision: "决策", identity: "身份", turn: "对话", "概要": "概要" };

  function memItems(items, scope) {
    if (!items.length) {
      return `<div class="mem-empty">${scope === "global"
        ? "还没有记忆。对话里出现的偏好、决策、事实会被抽成条目自动存进来，也可以手动添加。"
        : "本会话还没有要点。聊几轮后会自动抽取，也可以点下方「重新总结」。"}</div>`;
    }
    const editing = state.memEdit && state.memEdit.scope === scope ? state.memEdit.id : null;
    return items.map((m) => {
      if (editing === m.id) {
        return `<div class="mem-item is-editing">
           <textarea class="mem-input" id="memEditBox" maxlength="300">${esc(m.text)}</textarea>
           <div class="mem-meta">
             <button class="mem-act primary" data-mem-save="${m.id}">保存</button>
             <button class="mem-act" data-mem-cancel="1">取消</button>
           </div>
         </div>`;
      }
      const kind = m.kind || (scope === "session" ? "turn" : "fact");
      const hist = (m.history || []);
      const pin = scope === "global"
        ? `<button class="mem-act" data-mem-pin="${m.id}">${m.pinned ? "取消固定" : "固定"}</button>`
        : "";
      return `<div class="mem-item">
           <div class="mem-head">
             <span class="mem-kind k-${esc(kind)}">${MEM_BADGE[kind] || "事实"}</span>
             <span class="mem-topic">${esc(m.topic || "")}</span>
             ${m.pinned ? `<span class="mem-pinned">已固定</span>` : ""}
           </div>
           <div class="mem-text">${esc(m.text)}</div>
           ${hist.length ? `<div class="mem-hist"><b>旧值</b>${hist.map((h) => `<span>${esc(h.text)}</span>`).join("")}</div>` : ""}
           <div class="mem-meta">
             <span class="mem-src ${m.source === "auto" ? "auto" : ""}">${m.source === "auto" ? "自动抽取" : "手动"}</span>
             <span class="mem-time">${memTime(m.updatedAt || m.createdAt)}</span>
             ${pin}
             <button class="mem-act" data-mem-edit="${m.id}">编辑</button>
             <button class="mem-act danger" data-mem-del="${m.id}">删除</button>
           </div>
         </div>`;
    }).join("");
  }

  function sheetGlobalMem() {
    const items = GlobalMem.all();
    const kinds = items.reduce((a, m) => { a[m.kind || "fact"] = (a[m.kind || "fact"] || 0) + 1; return a; }, {});
    const stat = Object.keys(kinds).map((k) => `${MEM_BADGE[k] || k} ${kinds[k]}`).join(" · ");
    return `
    <div data-mem-scope="global">
      <div class="sheet-title">全局记忆</div>
      <div class="sheet-sub">自动抽取偏好、决策与事实</div>
      <div class="mem-add">
        <input id="memInput" placeholder="例如：回复尽量简短，代码给完整文件" maxlength="200" autocapitalize="off" />
        <button id="memAdd" aria-label="添加">＋</button>
      </div>
      <div class="mem-list">${memItems(items, "global")}</div>
      <div class="perm-actions">
        <button class="btn-ghost" id="memPreview">看看这次会注入哪些</button>
      </div>
      <div class="sheet-caption">共 ${items.length} 条${stat ? " · " + stat : ""}</div>
    </div>`;
  }

  /** 注入预览：用输入框里当前这句话做检索，看模型实际会拿到什么 */
  function sheetMemPreview() {
    const q = ($("#input") && $("#input").value || "").trim();
    const picked = GlobalMem.search(q, { limit: 8, budget: 800 });
    const brief = GlobalMem.briefing(q);
    const body = picked.length
      ? `<pre class="mem-preview">${esc(brief)}</pre>`
      : `<div class="mem-empty">没有条目被选中。随便说一句带关键词的话（比如「项目路径」「部署」）再回来看看。</div>`;
    return `
      <div class="sheet-title">注入预览</div>
      <div class="sheet-sub">${q ? `按当前输入「${esc(pageClip(q, 20))}」检索` : "输入框为空，按最近更新排序"}</div>
      ${body}
      <div class="sheet-caption">拼进 system prompt 的原文</div>
      <button class="btn-ghost" data-close>关闭</button>`;
  }

  function sheetSessionMem() {
    const id = state.sessionId;
    const s = id ? LocalDB.get(id) : null;
    if (!s) {
      return `
      <div class="sheet-title">会话记忆</div>
      <div class="sheet-sub">宿主机会话的记忆由电脑维护</div>`;
    }
    const items = LocalDB.mems(id);
    const facts = items.filter((m) => m.kind && m.kind !== "turn" && m.kind !== "概要").length;
    return `
    <div data-mem-scope="session">
      <div class="sheet-title">会话记忆</div>
      <div class="sheet-sub">只属于「${esc(pageClip(s.title, 16))}」</div>
      <div class="mem-add">
        <input id="memInput" placeholder="补充一条本会话记忆" maxlength="200" autocapitalize="off" />
        <button id="memAdd" aria-label="添加">＋</button>
      </div>
      <div class="mem-list">${memItems(items, "session")}</div>
      <div class="perm-actions"><button class="btn-ghost" id="memResum">重新总结这段会话</button></div>
      <div class="sheet-caption">共 ${items.length} 条 · 要点 ${facts} 条</div>
    </div>`;
  }

  function memScope() {
    const box = $("#sheetBody [data-mem-scope]");
    return box ? box.dataset.memScope : "";
  }

  function memReopen(scope) {
    if (scope === "session") openSheet(sheetSessionMem());
    else openSheet(sheetGlobalMem());
  }

  function refreshMemCount() {
    const v = $("#globalMemValue");
    if (v) v.textContent = `${GlobalMem.all().length} 条`;
  }

  // 供宿主/调试调用（也方便宿主侧将来接管记忆生成）
  window.DSHMemo = Memo;
  // 记忆内部件导出：便于在 WebView 里直接验证「抽取 / 合并 / 检索」三段行为
  window.DSHMem = {
    extract: memExtract,
    store: GlobalMem,
    similar: memSimilar,
    tokens: memTokens,
    kindOf: memKindOf,
    topicOf: memTopicOf,
    persona: () => personaPrompt(),
  };

  /** 启动引导：只弹一次。已全部授权、或之前弹过，都不再打扰 */
  function permPrimerOnce() {
    if (!Native || !Native.getPermissionState) return;
    permSync();
    // 权限齐全：直接记下标记，启动时不再打扰
    if (permGrantedCount() === PERM_GROUPS.length) {
      permMarkPrimed();
      return;
    }
    if (localStorage.getItem("dsh.permPrimed") === "1") return;
    // 已经决定要弹了：先落标记，保证「每次打开应用都弹」不会再发生
    permMarkPrimed();
    setTimeout(() => {
      if (!sheetOpen) openSheet(sheetPermission(true));
    }, 700);
  }

  function permMarkPrimed() {
    try { localStorage.setItem("dsh.permPrimed", "1"); } catch (_) {}
  }

  window.DSHHost = {
    /* ---- 检查更新：原生后台跑，状态推回来 ---- */
    onUpdate(json) {
      let s = {};
      try { s = JSON.parse(json || "{}"); } catch (_) { return; }
      Update.state = s;
      paintUpdate();
      // 下载完成 → 直接拉起安装器（用户点过「立即更新」，不再二次确认）
      if (s.state === "ready" && Native && Native.updateInstall) {
        try { Native.updateInstall(); } catch (_) {}
      }
    },

    /* ---- 桌面联动：原生侧把网络结果按请求 id 送回 ---- */
    onLinkPing(id, json) {
      Link.onBeat(id, json);
    },

    onLinkProbe(id, json) {
      let d = {};
      try { d = JSON.parse(json || "{}"); } catch (_) {}
      const box = $("#linkProbeBox");
      if (!box) return;
      const rows = (d.steps || []).map((st) => `
        <div class="probe-row">
          <span class="probe-dot ${st.ok ? "ok" : "bad"}"></span>
          <span class="probe-name">${esc(st.name)}</span>
          <span class="probe-detail">${esc(st.detail || "")}</span>
        </div>`).join("");
      box.innerHTML =
        (d.ok ? "" : `<div class="probe-head bad">${esc(d.error || "探测失败")}</div>`) +
        (rows || '<div class="sheet-caption">没有可显示的步骤</div>');
    },

    onLinkPair(id, json) {
      let d = {};
      try { d = JSON.parse(json || "{}"); } catch (_) {}
      if (!d.ok) {
        // 直连首连要核对指纹：这是唯一的中间人窗口，不能悄悄信了
        if (d.needFingerprint) {
          const box = $("#linkProbeBox");
          const ask = () => {
            if (box) box.innerHTML = `
              <div class="probe-head bad">第一次连这台电脑，请核对证书指纹是否与电脑面板上的一致</div>
              <div class="fp-code">${esc(d.fingerprint || "")}</div>
              <button class="btn-ghost" id="linkFpOk">指纹一致，固定它</button>`;
            const ok = $("#linkFpOk");
            if (ok) ok.addEventListener("click", () => {
              try { Native.linkConfirmFingerprint("fp-" + Date.now(), d.fingerprint || ""); } catch (_) { toast("当前环境不支持"); }
            });
          };
          ask();
          toast("请核对电脑面板上的证书指纹");
          return;
        }
        toast(d.error || "配对失败");
        if (d.error === "cancelled") return;
        return;
      }
      haptic("light");
      toast("已连接 " + (d.host || "电脑"));
      Link.startBeat();
      Link.listAt = 0;
      renderMode();
      renderSessions($("#searchSessions") ? $("#searchSessions").value : "");
      // 连上了就落到那台电脑上：配对成功后不再多点一次
      Link.autoEnter = true;
      Link.showSessions();
    },
    onLinkSessions(id, json) {
      let d = {};
      try { d = JSON.parse(json || "{}"); } catch (_) {}
      // 主列表的静默请求走单独一条路：不碰面板里的 #linkList
      if (String(id || "").startsWith("pc-")) {
        const ack = !!Link.refreshAck;
        Link.refreshAck = false;         // 一次性的：谁点的谁负责说
        if (d.ok) {
          renderPcSessions(d.sessions || []);
          if (ack) toast((d.sessions || []).length ? `电脑上 ${d.sessions.length} 场会话` : "电脑上还没有会话");
        } else {
          renderPcSessions([], true);
          if (ack) toast("读不到电脑上的会话：" + (d.error || "电脑端没答"));
        }
        return;
      }
      const list = $("#linkList");
      if (!list) return;
      if (!d.ok) {
        list.innerHTML = `<div class="sheet-caption" style="color:var(--orange)">${esc(d.error || "读取失败")}</div>`;
        return;
      }
      const rows = d.sessions || [];
      if (!rows.length) {
        list.innerHTML = '<div class="sheet-caption">电脑上还没有会话</div>';
        Link.autoEnter = false;
        return;
      }
      // 刚配对成功：直接进那台电脑上「正在跑 / 最近用过」的那一场，不再多点一次
      if (Link.autoEnter) {
        Link.autoEnter = false;
        const pick = rows.find((s) => s.running) || rows[0];
        const title = pick.title || (pick.cwd ? String(pick.cwd).split(/[\\/]/).pop() : "未命名会话");
        // 这里必须写 Link：回调住在 DSHHost 上，`this` 是 DSHHost，它没有 open
        Link.open(pick.id, title, "pair");
        return;
      }
      // 按工作区分门别类：电脑上每一场会话都属于一个目录（cwd），手机照同样的分法摆，
      // 不然几十场会话全平铺在一个列表里，找「上次那个项目」只能靠标题猜。
      const groups = [];
      const byCwd = new Map();
      for (const s of rows) {
        const cwd = String(s.cwd || "");
        if (!byCwd.has(cwd)) {
          const g = { cwd, rows: [] };
          byCwd.set(cwd, g);
          groups.push(g);
        }
        byCwd.get(cwd).rows.push(s);
      }
      groups.sort((a, b) => Math.max(...b.rows.map((s) => s.updatedAt || 0)) - Math.max(...a.rows.map((s) => s.updatedAt || 0)));
      // 新建会话时可直接选这些工作区（电脑端同一个 create 入口，传 cwd）
      Link.workspaceDirs = groups.map((g) => g.cwd).filter((cwd) => cwd.length > 0);
      const folderOf = (cwd) => (cwd ? String(cwd).split(/[\\/]/).filter(Boolean).pop() : "默认工作区");
      // 和手机端会话列表同一套行：头像 + 标题/时间 + 副标题（目录），
      // 每个工作区一张卡片；不再用「大标题 + 路径段落 + 稀疏行」那套，间距才和本机一致。
      const whenOf = (s) => (s.updatedAt ? fmtWhen(s.updatedAt) : "");
      const letterOf = (t) => ((String(t || "").trim()[0] || "P").toUpperCase());
      list.innerHTML = groups.map((g) => `
        <div class="pc-sheet-group">
          <div class="pc-sheet-head">
            <span class="pc-sheet-name">${esc(folderOf(g.cwd))}</span>
            <span class="pc-sheet-count">${g.rows.length}</span>
          </div>
          <div class="sheet-list pc-sheet-list">
            ${g.rows.map((s) => {
              const title = s.title || (s.cwd ? String(s.cwd).split(/[\/]/).pop() : "未命名会话");
              const where = s.cwd ? String(s.cwd).split(/[\/]/).filter(Boolean).pop() : "电脑上的会话";
              return `<div class="sess-row"><button class="session-item in-ws" data-link-session="${esc(s.id)}" data-link-title="${esc(title)}">
                <span class="s-avatar-wrap">
                  ${s.running ? '<span class="s-live-dot" aria-label="运行中"></span>' : ""}
                  <span class="s-avatar p2">${esc(letterOf(title))}</span>
                </span>
                <span class="s-main">
                  <span class="s-title-row">
                    <span class="s-title">${esc(title)}</span>
                    <span class="s-time">${esc(whenOf(s))}</span>
                  </span>
                  <span class="s-sub">${s.running ? "电脑上正在运行" : esc(where || "电脑上的会话")}</span>
                </span>
              </button></div>`;
            }).join("")}
          </div>
        </div>
      `).join("");
    },
    onLinkHistory(id, json) {
      let d = {};
      try { d = JSON.parse(json || "{}"); } catch (_) {}
      Link.onHistory(id, d);
    },
    onLinkModels(id, json) {
      let d = {};
      try { d = JSON.parse(json || "{}"); } catch (_) {}
      const waiters = Link.catalogWaiters || [];
      Link.catalogWaiters = [];
      if (d.ok) {
        Link.catalog = d.catalog || null;
        Link.catalogAt = Date.now();
      }
      syncComposerMode();
      for (const done of waiters) done(d.ok ? Link.catalog : null);
      // 面板开着就地刷新
      const body = $("#sheetBody");
      if (body && body.querySelector("[data-pc-model-panel]")) openSheet(sheetPcAgent());
    },
    /** 电脑上新建完会话：直接进去（和电脑端点「新会话」后的落点一致） */
    onLinkCreate(id, json) {
      let d = {};
      try { d = JSON.parse(json || "{}"); } catch (_) {}
      if (!d.ok) { toast(d.error || "新建会话失败"); return; }
      haptic("light");
      Link.listAt = 0;
      Link.open(d.sessionId, d.title || "新会话", "create");
      renderSessions($("#searchSessions") ? $("#searchSessions").value : "");
      Link.sessions();
    },

    /** 电脑上的工作区列表回来了：存一份，面板开着就地重画 */
    onLinkWorkspaces(id, json) {
      let d = {};
      try { d = JSON.parse(json || "{}"); } catch (_) {}
      Link.wsList = d.ok && Array.isArray(d.workspaces) ? d.workspaces : [];
      const title = (document.querySelector("#sheetBody .sheet-title") || {}).textContent;
      if (title === "新建电脑会话") openSheet(sheetPcWorkspace());
    },

    /** 工作区注册好了：紧接着在它里面把会话建出来 */
    onLinkWorkspaceCreated(id, json) {
      let d = {};
      try { d = JSON.parse(json || "{}"); } catch (_) {}
      if (!d.ok) { toast(d.error || "注册工作区失败"); return; }
      const ws = d.workspace || {};
      toast((d.created ? "已新建工作区 " : "已使用已存在的工作区 ") + (ws.title || ws.path || ""));
      Link.createSessionIn(ws.workspaceId || "");
    },

    /** 电脑端可用的命令回来了：存一份，面板开着就地重画 */
    onLinkCommands(id, json) {
      let d = {};
      try { d = JSON.parse(json || "{}"); } catch (_) {}
      Link.pcCommands = d.ok && Array.isArray(d.commands) ? d.commands : [];
      if (!state.pcSession) return;
      // ＋ 那个浮层里正画着「正在读取电脑端的命令…」：结果回来就地重画。
      // （以前只重画 sheet，浮层停在加载态，看起来像永远读不出来）
      // 只重画「＋」那一份：模型/上下文浮层也可能开着，顶掉它们是凭空换内容。
      const pop = document.querySelector("#pcPopover");
      if (pop && pop.dataset.pcPop === "cmds") {
        openPcPopover(document.querySelector("#btnAttach"), pcActionsHtml(), "cmds");
      }
    },

    /** 命令执行的结果：matched=false 表示电脑端不认识这一行 */
    onLinkCommand(id, json) {
      let d = {};
      try { d = JSON.parse(json || "{}"); } catch (_) {}
      if (!d.ok) { toast(d.error || "命令没有执行"); return; }
      toast(d.matched ? "已交给电脑执行" : "电脑端不认识这条命令");
    },

    onLinkModel(id, json) {
      let d = {};
      try { d = JSON.parse(json || "{}"); } catch (_) {}
      const waiters = Link.modelWaiters || [];
      Link.modelWaiters = [];      if (d.ok) {
        Link.selected = d.selected || Link.selected;
        syncComposerMode();
        toast("已切到 " + modelLabelOf(Link.selected));
      } else {
        toast(d.error || "切换失败");
      }
      for (const w of waiters) { if (d.ok) w.resolve(d.selected); else w.reject(new Error(d.error || "切换失败")); }
      // 只有「模型面板」开着才重画它；从 ＋ 旁边的模型胶囊选完，不该再弹一个 sheet 出来
      const body = $("#sheetBody");
      if (body && body.querySelector("[data-pc-model-panel]")) openSheet(sheetPcAgent());
      Link.syncHeader();
    },
    onLinkLive(id, json) {
      let d = {};
      try { d = JSON.parse(json || "{}"); } catch (_) {}
      if (!d.ok || !Link.live) return;
      // 只认本轮发出的请求：上一轮的迟到帧一律丢（见 startLive 的代际号）
      const gen = /^live-(\d+)-/.exec(String(id || ""));
      if (gen !== null && Number(gen[1]) !== Link.live.gen) return;
      if (Link.live.seeding) {
        Link.live.seeding = false;
        // 首帧就是对齐游标：有游标用游标，没有就用最后一条增量的序号
        const last = (d.deltas || []).reduce((max, item) => Math.max(max, Number(item && item.n) || 0), 0);
        Link.live.cursor = Math.max(Number(d.cursor) || 0, last);
        return;
      }
      const deltas = d.deltas || [];
      if (typeof d.cursor === "number" && d.cursor > Link.live.cursor && !deltas.length) {
        Link.live.cursor = d.cursor;
      }
      let grew = false;
      for (const item of deltas) {
        if (item.n && item.n > Link.live.cursor) Link.live.cursor = item.n;
        if (item.kind === "text") { Link.live.node.text += item.text || ""; grew = true; }
        else if (item.kind === "think") { Link.live.node.think += item.text || ""; grew = true; }
      }
      if (!grew) return;
      PcRun.stop();       // 已经有输出，等待态该收
      Link.paintLive();
    },
    onLinkSend(id, json) {
      let d = {};
      try { d = JSON.parse(json || "{}"); } catch (_) {}
      if (!d.ok) toast(d.error || "发送失败");
    },
    /**
     * 识别完成 → 直接发一条**用户语音条**。
     *
     * 以前是把文字回填输入框、让用户再点一次发送；现在「说出来就发出去」：
     * 气泡显示为可回放的语音条，agent 收到的仍然是识别出的文字。
     * 识别结果同时挂成小字放在语音条下面，用户能一眼核对有没有听错。
     */
    onVoice(text, clip, dur) {
      const clean = String(text || "").trim();
      const draft = String(state.voiceDraft || "");
      state.voiceDraft = "";
      if (!clean) return;
      voiceClearWatch();
      const input = $("#input");
      if (!input) return;
      // 输入框里本来有草稿：把识别结果追加到草稿后面，让用户自己确认发送。
      // 不能覆盖草稿，也不能把「草稿+语音」当成一条语音消息发出去（录音对不上文字）。
      if (draft.trim()) {
        const sep = /[\s\n]$/.test(draft) ? "" : " ";
        input.value = draft + sep + clean;
        input.style.height = "auto";
        state.pendingVoice = null;
        state.inputFromVoice = false;
        state.__voiceFill = true;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        state.__voiceFill = false;
        updateSendState();
        input.style.height = Math.min(input.scrollHeight, 116) + "px";
        toast("已追加到输入框");
        return;
      }
      const ms = Number(dur) || 0;
      // 有录音才画语音条；没有（写盘失败/取消）就当普通文字消息发，不丢内容
      state.pendingVoice = clip && ms > 0 ? { clip, dur: ms } : null;
      input.value = clean;
      input.style.height = "auto";
      // 走一次 input 事件：草稿保存、发送按钮状态、字数统计都挂在这个事件上
      state.inputFromVoice = true;
      state.__voiceFill = true;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      state.__voiceFill = false;
      state.inputFromVoice = false;
      updateSendState();
      state.__cpVoiceReply = false;
      // 让「识别中 → 用户气泡」有个呼吸，别啪一下跳出来
      setTimeout(() => {
        try {
          followBottomOn = true;
          // 上一轮还在生成时 handleSend 会因为 state.busy **静默返回** —— 文字发送
          // 在按钮里专门处理了这种情况（入队），语音这里却什么都不做，用户看到的
          // 就是「说了话，agent 一直不回」。识别费时（离线解码几百 ms 起），
          // 说话撞上生成中的概率并不低。现在与按钮同款：入队并明说，绝不无声吞掉。
          if (state.busy) {
            const t = input.value.trim();
            if (t) {
              input.value = "";
              input.style.height = "auto";
              state.pendingVoice = null;   // 队列只存文字：不清会把语音条挂到下一条文字消息上
              updateSendState();
              enqueue(t);
              toast("上一条还在回复，这句话已排队", 2200);
            }
            return;
          }
          handleSend();
        } catch (_) {}
      }, 260);
    },
    /* 语音面板状态：preparing / listening / partial / thinking / result / error / cancelled */
    /**
     * 语音面板状态：preparing / listening / partial / thinking / result / error / cancelled
     *
     * 注意参数叫 phase 而不是 state：以前叫 state 会把全局会话状态对象遮蔽掉，
     * 里面那些 `state.voiceLive = false` 实际是在给字符串赋属性（永远无效），
     * 于是「是否有用户发起的语音会话」这个标记会一直残留。
     */
    onVoiceEvent(phase, text, clip, dur) {
      // 只有用户真的按过（长按输入框 / 点麦克风）的会话才允许驱动面板。
      // 后台残留的引擎一旦收到声音就会发 partial，不设这道闸就会出现
      // 「没人点语音，一说话却弹出语音面板」。
      if (state.voiceLive !== true && (phase === "listening" || phase === "partial" || phase === "thinking")) {
        voiceCancelStray();
        return;
      }
      if (phase === "preparing") {
        voiceOpen("离线识别 · 首次准备模型");
        voiceSet("正在准备离线语音…", true);
      }
      else if (phase === "listening") {
        // 面板可能已由长按/点击先打开，别覆盖当前提示语
        const v = $("#voiceVeil");
        if (!v || !v.classList.contains("is-on")) voiceOpen();
        voiceSet("正在聆听…", false);
      }
      else if (phase === "partial") { voiceOpen(); if (text) voiceSet(text, false); }
      else if (phase === "thinking") voiceSet("正在识别…", true);
      // result 分支不清 __cpVoiceReply：它由 onVoice 消费（识别结果自动发送）
      else if (phase === "result") { state.voiceLive = false; voiceClearWatch(); voiceClose(); this.onVoice(text, clip, dur); }
      else if (phase === "cancelled") { state.voiceLive = false; state.__cpVoiceReply = false; state.voiceDraft = ""; voiceClearWatch(); voiceClose(); }
      else if (phase === "error") {
        state.voiceLive = false;
        state.__cpVoiceReply = false;
        state.voiceDraft = "";
        voiceClearWatch();
        voiceClose();
        const msg = text || "语音识别失败";
        // 端侧识别理论上不会因为网络失败；这里兜底的是「模型起不来」这类环境问题，
        // 那就把键盘送到用户面前，别停在错误提示上。
        const stuck = /模型|不可用|失败|打不开|不支持/.test(msg);
        if (stuck && Native && Native.showKeyboard) {
          const input = $("#input");
          if (input) input.focus();
          try { Native.showKeyboard(); } catch (_) {}
          toast(msg + " · 已弹出键盘，可直接打字或点键盘麦克风", 3600);
        } else {
          toast(msg);
        }
      }
    },
    /* 增强语音模型下载进度：只在百分比变化时重绘，避免每 200ms 抖一次 */
    onAsrModelProgress(done, total, err) {
      const prevPct = state.asrDl && state.asrDl.total
        ? Math.round((state.asrDl.done / state.asrDl.total) * 100) : -1;
      if (err) {
        state.asrDl = null;
        state.voiceWant = false;
        toast(err, 3200);
        if ($("#asrDownload")) openSheet(sheetPlugins());
        return;
      }
      state.asrDl = { done, total };
      const pct = total ? Math.round((done / total) * 100) : 0;
      if (pct !== prevPct && $("#asrDownload")) openSheet(sheetPlugins());
    },

    onAsrModelDone(ok) {
      state.asrDl = null;
      VoicePlugin._installed = null;
      state.voiceWant = false;
      // 下完即生效：原生侧会 reload 引擎，下一句话就走 SenseVoice
      if (ok) toast("增强模型已启用：中英日韩粤混说也能认", 3200);
      else toast("下载未完成，可重试", 3000);
      VoicePlugin.apply();
      if ($("#swVoicePlugin")) openSheet(sheetPlugins());
    },

    onVoiceLevel(level) {
      const card = $("#voiceCard");
      if (card) card.style.setProperty("--lvl", String(Math.max(0, Math.min(1, Number(level) || 0))));
    },
    /* 原生长按聊天输入框 = 语音：有草稿时 WebView 会先走系统文字选择，
       DOM 的长按计时和 pointerup 都可能被吞掉；Activity 在原生层接管并回调这里。 */
    onNativeLongPress() {
      const fn = state.voiceHoldStart;
      if (typeof fn === "function") { try { fn("native"); } catch (_) {} }
    },
    /* 原生补发松手：DOM pointerup 被系统链路吞掉时，靠这条收尾录音 */
    onVoiceHoldRelease() {
      const fn = state.voiceHoldRelease;
      if (typeof fn === "function") { try { fn(); } catch (_) {} }
    },
    /* 内核级事件（没有活跃轮次也会到）：定时任务到期、present 交付物 */
    onKernelEvent(json) {
      let ev = {};
      try { ev = JSON.parse(json || "{}"); } catch (_) { return; }
      // 探针：内核事件到达次数（排查「一次调用渲染出两个表情包」这类重复推送）
      try {
        const lg = (window.__kLog = window.__kLog || []);
        lg.push({ t: ev.t, id: (ev.sticker || {}).id || (ev.files ? ev.files.length : 0), at: Date.now() });
        if (lg.length > 100) lg.shift();
      } catch (_) {}
      if (ev.t === "team") {
        // 团队事件必须按会话过滤：内核推的是「变化发生的那支团队」，而屏幕上可能是另一场。
        // 以前这里无条件覆盖 state.team —— A 的队友还在后台跑、用户点了「新建会话」，
        // A 的人数就重新画到新会话的角标上（用户实测：新建对话后角标仍有旧数字）。
        if (((ev.team || {}).session || "") !== teamSid()) return;
        // 团队快照：成员/任务/预算一次给全。面板开着就地重绘（保留滚动位置）
        state.team = ev.team || null;
        syncTeamBadge();
        refreshTeamSheet();
        // 正在看某个成员的会话：顺带拉它的增量（它汇报/干活时这里就是实时流）
        if (state.teamView) refreshTeamViewMessages(false);
        return;
      }
      if (ev.t === "speak") {
        // Agent 显式调用 speak：出一条微信式语音条（波形+时长，可重播），并立即播一次
        const txt = String(ev.text || "").trim();
        if (txt) SpeechOut.speakAsVoice(txt, ev.rate);
        return;
      }
      if (ev.t === "companion") {
        // 插件心跳到点：前端才知道「人在不在场」，所以要不要开口在这里定
        Companion.onBeat(ev.beat || {});
        return;
      }
      if (ev.t === "media") {
        if (ev.sessionId && ev.sessionId !== state.sessionId) return;
        const md = ev.media || {};
        if (!md.dataUrl) return;
        // 图片也是「动作」：先收口当前这段，再落在流里；后续思考/正文接在它下面
        flowAction(NODES.media(md));
        if (followBottomOn) scrollToBottom();
        haptic("medium");
        return;
      }
      if (ev.t === "sticker") {
        if (ev.sessionId && ev.sessionId !== state.sessionId) return;
        const st = ev.sticker || {};
        if (!st.dataUrl) return;
        flowAction(NODES.sticker({ ...st, by: "agent" }));
        persistThread();
        if (followBottomOn) scrollToBottom();
        haptic("light");
        return;
      }
      if (ev.t === "deliverable") {
        if (ev.sessionId && ev.sessionId !== state.sessionId) return;
        const files = ev.files || [];
        if (!files.length) return;
        // 产物卡片属于「这一轮」：插在本轮尾行（复制/用量）之前，而不是无脑追加到最末尾。
        // 否则异步的语音条、下一轮的开场文字都可能压在它后面，看起来像挂错了轮次。
        const node = NODES.deliverable({ files });
        const tailMsg = currentTurnTail();
        if (tailMsg && tailMsg.parentElement === $("#messages")) {
          const added = insertAnchored(tailMsg, nodeHTMLUid(node));
          // 缩略图是占位（data-thumb-path），不 hydrate 就是一块空白；
          // 这条路径不走 renderThread，得自己补一次
          if (added) hydrateMedia(added);
          // thread 里的位置也要对齐 DOM：插在最后一个 footer 之前，否则下次全量重绘
          // 卡片会掉到尾行后面（和刚插的位置不一致）
          let at = thread.length;
          for (let i = thread.length - 1; i >= 0; i--) if (thread[i].kind === "footer") { at = i; break; }
          thread.splice(at, 0, node);
          // turn_end 时存的快照里还没有这张卡片 —— 不补存，切走会话再回来卡片就没了
          persistThread();
        } else {
          // 没有尾行（本轮没 usage/steps）：直接追加到末尾，同样要补缩略图与快照
          const el = push(node, true);
          if (el) hydrateMedia(el);
          persistThread();
        }
        haptic("medium");
        return;
      }
      if (ev.t === "job_start") {
        // 任务一跑起来就让「进行中」出现；属于别的会话的只刷新任务页，不塞进当前对话
        renderJobs();
        if (!ev.sessionId || ev.sessionId === state.sessionId) syncMissions();
        return;
      }
      if (ev.t === "job_done") {
        const label = ev.status === "done" ? "已完成" : ev.status === "killed" ? "已终止" : "失败";
        const sameSession = !ev.sessionId || ev.sessionId === state.sessionId;
        // 唤醒事实在 wakes 队列里（ToolKernel 在 onDone 先入队）；这里只负责「现在能不能唤醒」。
        // 忙碌/不在对话页/输入框有草稿时不打扰，记录留在队列，等本轮结束或进入会话再补。
        let woke = false;
        if (sameSession && ev.sessionId) {
          try { woke = wakeMissions(state.sessionId); } catch (_) { woke = false; }
        }
        toast(woke ? "后台任务完成，Agent 正在继续"
          : sameSession ? `后台任务「${ev.name}」${label}`
          : `后台任务「${ev.name}」${label}（属于另一个会话）`);
        if (!woke && sameSession) {
          // tail 是 job 的最后一点输出，常常是结构化日志（一行一个 JSON 事件）。
          // 原样塞进卡片会有两个毛病：① 换行在 HTML 里被折叠成空格，读起来是一整段；
          // ② 里面那个长 JSON token 会把文本列的最小宽度顶开，整段跑到卡片外面。
          // 这里压成单行、留末尾一段，完整输出仍然在「后台任务」面板里。
          const tail = String(ev.tail || "").replace(/\s+/g, " ").trim();
          push(NODES.notice({
            title: `后台任务${label}`,
            text: ev.name + (ev.exit_code !== null && ev.exit_code !== undefined ? ` · exit=${ev.exit_code}` : "") +
              (ev.ms ? ` · ${(ev.ms / 1000).toFixed(1)}s` : "") +
              (tail ? " · " + (tail.length > 140 ? "…" + tail.slice(-140) : tail) : ""),
          }), true);
        }
        renderJobs();
        if (!ev.sessionId || ev.sessionId === state.sessionId) syncMissions();
        return;
      }
      if (ev.t === "schedule_due") {
        const title = ev.title || "定时任务";
        const sameSession = !ev.sessionId || ev.sessionId === state.sessionId;
        // 到点后任务行的「下次执行 / 已结束」和 Mission 卡都要跟着变
        renderJobs();
        if (sameSession) { try { syncMissions(); } catch (_) {} }
        // 唤醒事实在 wakes 队列（ToolKernel 在 onDue 里入队）；这里只做提示与卡片对齐。
        // 属于别的会话 / 当前忙碌 / 输入框有草稿：留在队列，进入会话或本轮结束再补。
        if (!sameSession) {
          toast(`${title} 已到期（在另一个会话）`);
          return;
        }
        let woke = false;
        if (ev.sessionId) {
          try { woke = wakeMissions(state.sessionId); } catch (_) { woke = false; }
        }
        toast(woke ? "定时任务已到点，Agent 正在继续" : `${title} 已到期`);
        return;
      }
    },
    /* 系统授权弹窗返回：逐组回报 name → {granted, canAsk} */
    onPermission(name, granted, canAsk) {
      Perm.map[name] = { granted: !!granted, canAsk: !!canAsk };
      Perm.known = true;
      permPaint();
      if (granted) haptic("medium");
      const g = PERM_GROUPS.find((x) => x.id === name);
      const all = permGrantedCount() === PERM_GROUPS.length;
      if (all) {
        // 权限已齐全：引导浮窗自动收起，后续启动也不再弹
        permMarkPrimed();
        if (sheetOpen) closeSheet();
        toast("权限已全部就绪");
        return;
      }
      if (sheetOpen) openSheet(sheetPermission(false));
      if (!granted) {
        toast(g ? `${g.name}${canAsk ? "未授权" : "已禁用，可到系统设置打开"}` : "未授权");
      }
    },
    onHttp(id, payload) { Host.onHttp(id, payload); },
    onBalance(requestId, payload) {
      if (requestId !== state.balanceReqId) return;
      let data = null;
      try { data = JSON.parse(payload); } catch (_) { data = { ok: false, error: "返回格式异常" }; }
      state.balance = data;
      state.balanceAt = Date.now();
      syncUsageRow();     // 设置页「额度与用量」行同步刷成余额（行和面板同一份数据）
      const box = $("#balBox");
      if (box && sheetOpen) {
        const tmp = document.createElement("div");
        tmp.innerHTML = balHTML();
        box.replaceWith(tmp.firstElementChild);
      }
    },
    onModels(requestId, payload) {
      if (requestId !== state.modelFetchId) return;
      let data = null;
      try { data = JSON.parse(payload); } catch (_) { return; }
      if (!data || !data.ok) { toast((data && data.error) || "拉取失败"); return; }
      // 端点自己报的上下文长度（llama.cpp 的 meta.n_ctx）：本地模型窗口很小，
      // 保存模型时带上它，后面按它压缩，不然 8k 的模型会按 128k 去攒上下文。
      state.modelCtx = data.ctx || {};
      openSheet(sheetModelPicker(data.models || [], state.modelDraft?.url || ""));
    },

    /* ---- 本地独立引擎的流式回调 ---- */
    onDelta(id, chunk) {
      const w = Kernel._waits[id];
      if (w && typeof w === "object" && !w.target) { w.text += chunk; return; }
      if (id !== Live.id) return;
      feedStreamChunk(chunk);       // 内联 <think> 分流
      if (!Live.textEl) return;
      schedulePaint();
    },
    onReasoning(id, chunk) {
      const w = Kernel._waits[id];
      if (w && typeof w === "object" && !w.target) { w.reasoning += chunk; return; }
      if (id !== Live.id) return;
      Flow.think(chunk);
    },
    /** 流式 tool_calls：子代理通道存到 once 记录，主代理存到 Agent 待办 */
    onToolCalls(id, json) {
      let arr = [];
      try { arr = JSON.parse(json || "[]"); } catch (_) {}
      const w = Kernel._waits[id];
      if (w && typeof w === "object") { w.toolCalls = arr; return; }
      if (id === Live.id) Agent.pendingCalls = arr;
    },
    onDone(id, usageJson) {
      const w = Kernel._waits[id];
      if (w && typeof w === "object" && w.resolve) {
        delete Kernel._waits[id];
        if (w._timer) clearTimeout(w._timer);
        w.resolve({ text: w.text, reasoning: w.reasoning, toolCalls: w.toolCalls });
        return;
      }
      if (id !== Live.id) return;
      if (Agent.active) { agentAfterRound(); return; }
      let usage = null;
      try { usage = JSON.parse(usageJson || "{}"); } catch (_) {}
      if (goalWantsNext()) { goalAdvance(usage); return; }
      const turnText = liveBody();
      const secs = Math.max(1, Math.round((Date.now() - Live.turnStart) / 1000));
      finishLive(usage);
      // 本地直连通道同样补上轮次尾行（复制 + 用量），和原生内核通道一致
      if (usage && (usage.total || usage.prompt || usage.completion)) {
        push(NODES.footer({
          steps: 0, ms: secs * 1000, text: turnText,
          tokens: usage.total || ((usage.prompt || 0) + (usage.completion || 0)),
          cancelled: false,
        }), true);
        persistThread();
      }
      state.busy = false;
      updateSendState();
    },
    /** 原生 Agent 内核的完整事件流（意图/流式/工具/计划/审批/目标/用量/结束）
        json 兼容两种形态：新原生走对象直发（object），旧页面缓存/旧原生走 JSON 字符串 */
    onAgent(id, json) {
      let ev = null;
      try { ev = typeof json === "string" ? JSON.parse(json || "{}") : (json || {}); } catch (_) { return; }
      // 事件探针：内核推来的每条事件留一条极简记录，
      // 排查「后端说发了、界面没反应」时不用再靠猜（超过 200 条自动丢弃最旧的）
      try {
        const lg = (window.__evLog = window.__evLog || []);
        lg.push({ id, live: Live.id, t: ev.t, files: ev.files ? ev.files.length : 0 });
        if (lg.length > 200) lg.splice(0, lg.length - 200);
      } catch (_) {}
      if (id !== Live.id) return;
      NativeAgent.on(ev);
    },
    /** DeepSeek 账号登录状态（浏览器授权回来后由原生回调） */
    onAccount(id, json) {
      let st = {};
      try { st = JSON.parse(json || "{}"); } catch (_) {}
      Account.onState(st);
    },
    onError(id, payload) {
      const w = Kernel._waits[id];
      if (w && typeof w === "object" && w.reject) {
        delete Kernel._waits[id];
        if (w._timer) clearTimeout(w._timer);
        let m = "连接中断";
        try { m = JSON.parse(payload || "{}").message || m; } catch (_) {}
        w.reject(new Error(m));
        return;
      }
      if (id !== Live.id) return;
      if (Agent.active) agentReset();
      let msg = "连接中断";
      try { msg = JSON.parse(payload || "{}").message || msg; } catch (_) {}
      if (Live.cancelled) {
        finishLive(null);
        state.busy = false;
        updateSendState();
        return;
      }
      failLive(msg);
      state.busy = false;
      updateSendState();
    },
  };

  window.DSHHandleBack = function () {
    // 按显示层级从上到下逐层关：气泡浮层（音色/模型等）在最上，其次全屏查看器，最后面板。
    // 之前漏了 popover 这一层，导致「面板先关、气泡还挂在屏幕上，只能点空白处才消失」。
    if (popEl) { closePopover(); return true; }
    if (MediaView.el && MediaView.el.classList.contains("is-on")) { MediaView.close(); return true; }
    if (sheetOpen) { closeSheet(); return true; }
    if (state.screen === "chat") {
      // 成员会话先退一层（与左上角返回同一动作）：系统返回键不能越过它直接把成员轮询丢在后台
      if (state.teamView) { exitTeamView(); return true; }
      // 与聊天页左上角返回同一动作：离开电脑会话必须走 Link.leave，
      // 否则轮询/心跳/运行态留在后台，state.pcSession 也残着
      if (state.pcSession) Link.leave();
      go("sessions", { dir: "back" });
      return true;
    }
    if (state.screen !== "sessions") { go("sessions", { dir: "back" }); return true; }
    return false;
  };

  /* ---------------- composer ---------------- */
  /** 电脑会话在跑也算忙：按钮要能变成「停止」，不然手机上根本停不下来 */
  function isBusy() {
    return state.busy || Boolean(state.pcSession && typeof Link !== "undefined" && Link.running);
  }

  function updateSendState() {
    const btn = $("#btnSend");
    if (!btn) return;
    // 搜索模式：发送键恒可用（= 下一处），不参与「空则禁用 / 忙则停止」的常规状态机
    if (SearchMode.on) {
      btn.disabled = false;
      btn.classList.remove("is-stop");
      return;
    }
    // 电脑会话允许「只发图」：附件托盘里有图，发送键就该亮（本机那条路仍要求有文字）
    const has = $("#input").value.trim().length > 0 || (!!state.pcSession && state.attachments.length > 0);
    const busy = isBusy();
    // 生成中：输入框空 => 停止；一旦开始打字 => 变回发送（点一下进队列，不打断正在跑的这一轮）
    const stopping = busy && !has;
    btn.classList.toggle("is-stop", stopping);
    btn.disabled = !busy && !has;
    btn.setAttribute("aria-label", stopping ? "停止生成" : busy ? "加入发送队列" : "发送");
  }

  /* ---------------- 发送队列（进行中继续发 = 排队，可插话 / 编辑 / 删除） ---------------- */
  function queueOf() { return state.queue || (state.queue = []); }

  // 队列面板的临时交互态（与桌面端 QueueDock 对齐：多条折叠成计数头，编辑就地展开）
  // collapsed=true：多条时默认堆叠成「N 条排队消息」一行，点开才展开（对齐桌面端，不遮对话）

  const QueueUI = { collapsed: true };

  function renderQueue() {
    const bar = $("#queueBar");
    if (!bar) return;
    const q = queueOf();
    bar.hidden = !q.length;
    // 队列在场 = 输入框要让出上沿圆角并成一块表面（样式见 .composer-dock.has-queue）
    const dock = $("#composerDock");
    if (dock) dock.classList.toggle("has-queue", q.length > 0);
    if (!q.length) { bar.innerHTML = ""; return; }

    const multi = q.length > 1;
    const head = multi ? `
      <button class="queue-head" data-q-collapse aria-expanded="${QueueUI.collapsed ? "false" : "true"}">
        <svg class="ico sm"><use href="#i-queue"/></svg>
        <span class="qh-count">${q.length} 条排队消息</span>
        <svg class="ico sm qh-chev${QueueUI.collapsed ? " is-collapsed" : ""}"><use href="#i-chevron-down"/></svg>
      </button>` : "";

    const showRows = !multi || !QueueUI.collapsed;
    const rows = showRows ? q.map((it, i) => {
      return `
        <div class="queue-item" data-qid="${it.id}">
          ${multi ? `<span class="qi-idx">${i + 1}</span>` : `<svg class="ico sm qi-lead"><use href="#i-queue"/></svg>`}
          <span class="qi-text">${esc(it.text)}</span>
          <span class="qi-actions">
            <button class="qi-act steer" data-q-now="${it.id}" aria-label="插话发送" title="插话发送">
              <svg class="ico sm"><use href="#i-send"/></svg>
            </button>
            <button class="qi-act" data-q-edit="${it.id}" aria-label="编辑排队消息" title="编辑">
              <svg class="ico sm"><use href="#i-edit"/></svg>
            </button>
            <button class="qi-act" data-q-del="${it.id}" aria-label="删除排队消息" title="删除">
              <svg class="ico sm"><use href="#i-trash"/></svg>
            </button>
          </span>
        </div>`;
    }).join("") : "";

    bar.innerHTML = head + rows;
  }

  function enqueue(text) {
    queueOf().push({
      id: "q" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      text,
    });
    renderQueue();
    haptic("light");
  }

  function takeQueued(id) {
    const q = queueOf();
    const i = q.findIndex((x) => x.id === id);
    if (i < 0) return null;
    return q.splice(i, 1)[0];
  }

  function sendQueued(item) {
    const input = $("#input");
    input.value = item.text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    handleSend();
  }

  /** 队列内拖动排序：按住条目上下拖，松手落到新位置（队列里多条时才生效） */
  function bindQueueDrag() {
    const bar = $("#queueBar");
    if (!bar || bar.__dragBound) return;
    bar.__dragBound = true;
    let drag = null;

    bar.addEventListener("pointerdown", (e) => {
      const item = e.target.closest(".queue-item");
      if (!item || e.target.closest("button")) return;
      const q = queueOf();
      const idx = q.findIndex((x) => x.id === item.dataset.qid);
      if (idx < 0 || q.length < 2) return;
      drag = { item, idx, cur: idx, y0: e.clientY, h: item.offsetHeight + 6, active: false, id: item.dataset.qid };
      try { item.setPointerCapture(e.pointerId); } catch (_) {}
    }, { passive: true });

    bar.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dy = e.clientY - drag.y0;
      if (!drag.active) {
        if (Math.abs(dy) < 7) return;
        drag.active = true;
        drag.item.classList.add("is-dragging");
      }
      if (e.cancelable) e.preventDefault();
      drag.item.style.transform = `translateY(${dy}px)`;
      const q = queueOf();
      const target = Math.max(0, Math.min(q.length - 1, drag.idx + Math.round(dy / drag.h)));
      if (target !== drag.cur) {
        drag.cur = target;
        [...bar.querySelectorAll(".queue-item")].forEach((el) => {
          el.classList.toggle("is-drop-target", el.dataset.qid === q[target].id && el !== drag.item);
        });
      }
    }, { passive: false });

    const finish = () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (!d.active) return;
      d.item.classList.remove("is-dragging");
      d.item.style.transform = "";
      [...bar.querySelectorAll(".queue-item")].forEach((el) => el.classList.remove("is-drop-target"));
      if (d.cur === d.idx) return;
      const q = queueOf();
      const [moved] = q.splice(d.idx, 1);
      q.splice(d.cur, 0, moved);
      renderQueue();
      haptic("light");
    };
    bar.addEventListener("pointerup", finish, { passive: true });
    bar.addEventListener("pointercancel", finish, { passive: true });
  }

  /** 本轮结束后自动发队首；目标续轮也要让位给用户排队的消息 */
  function pumpQueue() {
    if (state.busy || !queueOf().length) return;
    const item = queueOf()[0];
    if (!item) return;
    takeQueued(item.id);
    renderQueue();
    setTimeout(() => { if (!state.busy) sendQueued(item); }, 260);
  }

  /** 发送后把焦点还给输入框(仅当键盘本来就开着):
      updateSendState 会 disable 空输入的发送键,而刚点过的按钮正持有焦点 ——
      焦点随 disabled 丢回 body,Android 随即无动画收起键盘,输入框从键盘上沿
      一帧砸回屏底(「发送时弹跳一下」的根因)。重新 focus 后键盘常驻,可连发。 */
  function keepInputFocus() {
    if (!document.documentElement.classList.contains("kb-open")) return;
    const ta = $("#input");
    if (ta && document.activeElement !== ta) {
      try { ta.focus({ preventScroll: true }); } catch (_) { try { ta.focus(); } catch (_) {} }
    }
  }

  async function handleSend() {
    // 搜索模式下发送键 = 跳到下一处（输入框本体被搜索接管）
    if (SearchMode.on) { ChatExtras.jump(1); return; }
    const input = $("#input");
    const text = input.value.trim();
    // 电脑会话可以只发图（桌面端的 prompt 允许 text 为空 + 图片）；本机这条路仍要文字
    if (!text && !(state.pcSession && state.attachments.length)) return;
    const prevSid = state.sessionId;   // 发送途中可能新建/接管会话，用它判断桶有没有换
    // 成员会话视图：这条消息发给 teammate（走 send_message 同一条路径），
    // 不建新会话、不动 state.sessionId —— 桌面 addressed-subagent 的手机端等价物。
    if (state.teamView) {
      input.value = "";
      input.style.height = "auto";
      updateSendState();
      keepInputFocus();
      haptic("medium");
      push(NODES.user(text));
      pinBottom(900, true);   // 发送是用户主动行为，无论之前在读哪里都贴底
      sendTeamViewMessage(text);
      return;
    }
    // 电脑会话：这一条直接发给电脑上的 agent。界面、气泡、滚动都走同一套，
    // 只有传输换成了中继 —— 所以这条分支必须放在所有本机逻辑之前。
    if (state.pcSession) {
      const imgAtt = state.attachments.filter((a) => (a.type || "").startsWith("image/") && a.dataUrl);
      const otherAtt = state.attachments.filter((a) => !((a.type || "").startsWith("image/") && a.dataUrl));
      // 这条链路只带图片（桌面端 prompt 的 images）。文档类附件不能悄悄丢掉，也不能假装发出去了
      if (otherAtt.length) {
        toast("电脑会话只能带图片：" + otherAtt[0].name + " 没发出去");
        return;
      }
      input.value = "";
      input.style.height = "auto";
      updateSendState();
      keepInputFocus();
      haptic("medium");
      const mine = NODES.user({ text, atts: imgAtt.map((a) => ({ name: a.name, dataUrl: a.dataUrl })) });
      push(mine, false);
      Link.turnAnchor = mine;  // 本轮用户气泡：上一轮的迟到回复要插在它前面
      pinBottom(900, true);    // 发送是用户主动行为，无论之前在读哪里都贴底
      Link.running = true;
      Link.syncHeader();
      updateSendState();
      // 发出去就必须有人在拉结果：万一之前被停过，这里补上
      if (!Link.poll) Link.startPoll();
      PcRun.start();
      Link.startLive();
      // 电脑会把这句原样回传（带真实 seq）：登记下来，回显时咽掉一次，
      // 否则和上面那枚乐观气泡叠成两条 —— 用户看到的「发一条出两条」
      Link.expectEcho(text, imgAtt.length > 0);
      try {
        if (imgAtt.length) {
          // 图片内联进 prompt：桌面端只收 base64 本体（前缀已由 dataUrl 里剥掉）
          const images = imgAtt.map((a) => ({ name: a.name, mediaType: a.type || "image/jpeg", data: b64OfDataUrl(a.dataUrl) }));
          Native.linkSend("send-" + Date.now(), state.pcSession.id, text, JSON.stringify(images));
          state.attachments = [];
          renderAttachments();
        } else {
          // 没有图也走同一个入口：桥那边只有一个 linkSend(…, imagesJson)，空数组就是「纯文字」
          Native.linkSend("send-" + Date.now(), state.pcSession.id, text, "[]");
        }
      }
      catch (_) { PcRun.stop(); Link.running = false; toast("发送失败"); updateSendState(); }
      return;
    }
    if (state.busy) return;
    const mode = currentMode();
    if (mode === "host" && !state.host) { toast("先在设置里连接宿主机"); return; }
    if (mode === "local" && !localReady()) {
      // 账号已登录却「未就绪」，说明当前选的是没 key 的模型：直接切到账号额度继续，
      // 不再把用户挡在「请先配置密钥」这一步（桌面就是登录即可用）
      const st = Account.info();
      if (st.signedIn) {
        await Account.applyToModel(true);
        if (!localReady()) { toast("账号模型未就绪，请重新登录"); openSheet(Account.sheet()); return; }
      } else {
        toast("登录 DeepSeek 账号即可直接对话；也可在设置里填第三方 API 密钥");
        openSheet(Account.sheet());
        return;
      }
    }
    input.value = "";
    input.style.height = "auto";
    updateSendState();
    keepInputFocus();
    haptic("medium");
    // 他刚说过话 = 他还在场，陪伴心跳不必凑上来
    try { Native.companionTouch && Native.companionTouch(); } catch (_) {}

    const atts = [...state.attachments];
    // 表情包也作为图片附件发给模型：它看得见这张图，才知道你在发表情
    if (state.stickerPending) {
      atts.push({
        name: (state.stickerPending.name || "sticker") + (state.stickerPending.kind === "gif" ? ".gif" : ".png"),
        size: Math.round((state.stickerPending.dataUrl || "").length * 0.75),
        type: state.stickerPending.mime || "image/png",
        dataUrl: state.stickerPending.dataUrl,
      });
    }
    // 分类按 MIME：图片进气泡网格，其余进文件 chip（chip 也带 dataUrl，点开可预览）
    const isImg = (a) => (a.type || "").startsWith("image/") && !!a.dataUrl;
    const imgAtts = atts.filter(isImg);
    const otherAtts = atts.filter((a) => !isImg(a));

    // 本地模式：首条消息时才落库，避免产生空会话
    if (mode === "local") {
      let s = LocalDB.get(state.sessionId);
      if (!s) {
        s = LocalDB.create(text);
        state.sessionId = s.id;
        // **必须同时把对话流切到新会话那一份**：只改 sessionId 不换桶，后面的
        // push 和 persistThread 还在旧数组上 —— 那就是「发在新会话、内容进旧会话」
        // （或反过来）的会话串号入口。桶里已经是本轮真相，直接标成已加载。
        adoptThread(s.id);
        Modes.adopt(s.id);       // 新会话前设的模式迁到真实会话
      }
      // 用户重新发话 = 目标重新起一轮
      const g = Modes.goal();
      if (g && g.phase === "active") Modes.setGoal({ ...g, rounds: 0, updatedAt: Date.now() });
      // 图片（≤2MB 的 dataUrl）随消息落库，重开会话还能看到；大图只存当轮
      const storableImgs = imgAtts.filter((a) => (a.dataUrl || "").length <= 2 * 1024 * 1024)
        .map((a) => ({ name: a.name, dataUrl: a.dataUrl }));
      // 表情包历史：正文只留短标记，图片同样入 atts —— 和普通图片公平待遇，
      // 重开会话还原成表情气泡、模型也能重新看到这张图（此前它既不进 atts 也还原不出来）。
      const isStk = !!state.stickerPending;
      const stk = state.stickerPending || {};
      const histText = isStk ? "[表情包] " + (stk.name || "表情") : text;
      const histAtts = isStk
        ? ((stk.dataUrl || "").length <= 2 * 1024 * 1024
            ? [{ name: stk.name || "表情", dataUrl: stk.dataUrl, mime: stk.mime || "image/png" }]
            : [])
        : storableImgs;
      LocalDB.push(s.id, { role: "user", content: histText, atts: histAtts });
      const fresh = LocalDB.get(s.id);
      $("#chatTitle").textContent = fresh.title;
      $("#chatSub").textContent = "本地 · " + modelLabel();
      // 立刻把列表里的标题/预览/时间刷新掉，用户随时退回列表看到的都是这一轮
      renderSessions();
    }

    // 表情包消息：气泡里只放表情本体，同时把图片作为附件发给模型（它看得见这张图）
    if (state.stickerPending) {
      const st = state.stickerPending;
      state.stickerPending = null;
      thread.push(NODES.sticker({ ...st, by: "user" }));
      const input2 = $("#input");
      if (input2) { input2.value = ""; input2.style.height = "auto"; }
    } else {
      // 图片直接渲染进用户气泡；非图片类显示为可点击预览的文件 chip
      // 这一条如果是「说」出来的，把录音挂上去 —— 立刻清空，避免下一条文字也带语音条
      const pendVoice = state.pendingVoice || null;
      state.pendingVoice = null;
      thread.push(NODES.user({
        text,
        voice: pendVoice,
        atts: imgAtts.map((a) => ({ name: a.name, dataUrl: a.dataUrl })),
        files: otherAtts.map((a) => ({
          name: a.name, size: a.size,
          // ≤1.5MB 的 dataUrl 随节点保留，chip 点开即预览；大文件只进文件页记录
          dataUrl: (a.dataUrl || "").length <= 1.5 * 1024 * 1024 ? a.dataUrl : "",
        })),
      }));
    }
    if (otherAtts.length) LocalFiles.add(otherAtts);
    state.attachments = [];
    renderAttachments();
    // 发送 = 用户明确要看最新消息。
    // 这里以前是 renderThread()：整张对话清空重灌，已经生成的正文/工具行全部重建，
    // 重灌那一刻 scrollHeight 塌成 0、视口被钳到顶部，贴底再把它拉回来 ——
    // 用户看到的「一发消息就跳回历史上方 / 已有内容闪一下」就是这两件事。
    // 新节点只有一条，追加到尾部即可，其余 DOM 一个字都不动。
    followBottomOn = true;
    // 桶没换 → 屏上这些 DOM 就是这条会话自己的，只把新节点接到尾部，其余一个字不动；
    // 桶换了（首条消息新建、会话被删后重新落库）必须整表重绘一次，
    // 否则会把上一场会话留下的 DOM 当成本场历史留在屏上。
    if (state.sessionId === prevSid) {
      appendTail(thread[thread.length - 1]);
      try { ChatExtras.refresh(); } catch (_) {}
    } else {
      renderThread();
    }
    pinBottom(900, true);   // 本机发送：轮到用户主动看最新

    state.busy = true;
    updateSendState();
    // 新一轮开始：先停掉上一轮还在念的声音，并记住这句有没有点名要「说出来」
    try { SpeechOut.stop(); } catch (_) {}
    Live.speakRequested = wantsSpeech(text);
    Live.askedByVoice = state.inputFromVoice === true;
    state.inputFromVoice = false;

    if (mode === "local") {
      // 流式节点必须落进这条会话自己的桶（前面 create 分支已经切过，这里再确认一次：
      // 引用切换是幂等的，但漏了就是整轮内容写进别人的会话）
      attachThread(state.sessionId);
      beginLive(state.sessionId, modelLabel());
      try { await localSend(text, atts); } catch (e) { failLive(e.message || String(e)); state.busy = false; updateSendState(); }
      return;
    }

    try {
      const result = await Host.call("session/send", {
        sessionId: state.sessionId,
        text,
        attachments: atts.map((a) => ({ name: a.name, size: a.size, type: a.type })),
        workspace: state.workspace,
        permission: state.perm,
        askBeforeDanger: state.askDanger,
        notifyOnDone: state.notifyDone,
      });
      const reply = result?.text || result?.reply || "";
      // streamText 自己就是增量灌（push 一条空正文再逐帧补），收尾不需要整表重绘；
      // 重绘会把这一场已经生成的内容全部重建一遍 = 闪。
      if (reply) await streamText(reply);
      else push(NODES.text("宿主机没有返回内容"));
    } catch (e) {
      push(NODES.text(`**发送失败** · ${e.message}\n\n请确认宿主机在运行、地址与 Launch Token 正确。`));
    }
    state.busy = false;
    updateSendState();
  }

  /* ---------------- wiring ---------------- */
  function init() {
    if (Native) document.documentElement.classList.add("native");
    applyTheme();
    // 首帧：先把列表算完再让它可见（styles.css 的 .pre-boot）。
    // 放在 try/finally 里 —— 万一 renderSessions 抛错，也不能把会话页永久留成空白。
    try {
      renderSessions();
    } finally {
      const ss = $("#screen-sessions");
      if (ss) ss.classList.remove("pre-boot");
    }
    if (currentMode() === "host") loadSessions();
    bindSheet();
    watchMedia();
    setModel(state.model);
    renderEffort();
    renderAccount();
    applyQuickChips();
    syncContextChips();
    syncPermUI();
        const sm = $("#swSessMem"); if (sm) sm.checked = state.sessMem;
    const sg = $("#swGlobalMem"); if (sg) sg.checked = state.globalMem;
    const pv2 = $("#personaValue"); if (pv2) pv2.textContent = PERSONAS.find((p) => p.id === state.persona)?.name || (state.persona ? "自定义" : "默认");
    VoicePlugin.apply();
    SpeechOut.syncGender();   // 音色偏好推给原生，否则首句会用默认音色

    /**
     * 云端语音模型：表单 → 原生（唯一真值）。密钥留空由原生沿用旧值，
     * 试听直接走正常朗读链路 —— 配好了自然会用云端，没配就是系统 TTS。
     */
    const saveCloudTts = (test) => {
      const val = (sel) => (($(sel) && $(sel).value) || "").trim();
      const r = SpeechOut.cloudSet({
        enabled: !!($("#ctEnabled") && $("#ctEnabled").checked),
        endpoint: val("#ctUrl"),
        apiKey: val("#ctKey"),
        model: val("#ctModel"),
        voice: val("#ctVoice"),
        bodyTemplate: val("#ctBody"),
        extraHeaders: val("#ctHeaders"),
      });
      if (!r) { toast("保存失败：原生语音桥不可用"); return; }
      if (test) { try { if (Native && Native.speak) Native.speak(VOICE_SAMPLE, 1); } catch (_) {} }
      toast(r.usable ? "云端语音已启用：" + r.model : "已切回系统 TTS", 2400);
      openSheet(sheetCloudTts());
    };
    // 上次连过电脑：把心跳跑起来，电脑端这才知道手机回来了
    try { if (Link.state().paired) Link.startBeat(); } catch (_) {}
    Companion.syncValue();    // 陪伴开关的当前状态（设置页那一行）
    // 启动即对一次账：应用不在时生成的消息先落盘在原生，这里领回来；
    // 同时把「端点/提示词/最近对话」下发给原生引擎（它之后不依赖界面也能开口）
    try { Companion.drain(); } catch (_) {}
    try { Companion.pushContext(); } catch (_) {}
    applyLang();
    // 之后所有动态插入的界面（面板、列表、工具行）都会自动跟上当前语言
    langObserver.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["placeholder", "aria-label", "title"] });
    initMathObserver();
    const accCard = $("#accountCard");
    if (accCard) {
      accCard.addEventListener("click", () => {
        // 原生 DeepSeek 账号（PKCE + loopback）优先；没有原生能力再走 API Key 面板
        if (Native && Native.accountState) { Account.open(); return; }
        openSheet(state.account ? sheetAccountDetail() : sheetSignIn());
      });
    }

    renderMode();

    $$(".tab").forEach((t) => t.addEventListener("click", () => {
      if (tabJustDragged) return;
      go(t.dataset.tab);
      haptic("light");
    }));
    bindTabDrag();
    bindFollowScroll();
    bindDeviceScroll();
    ChatExtras.bind();
    bindPressDeform();
    // 输入框悬浮：高度变化时同步 --dock-h（内容延伸到底，滚到底不被输入框挡住）
    syncDockHeight();
    const dockEl = document.querySelector(".composer-dock");
    dockRO = (dockEl && window.ResizeObserver) ? new ResizeObserver(() => { syncDockHeight(); }) : null;
    if (dockRO) {
      // 必须 border-box:dock 的长高常来自 padding(--safe-bottom 晚到 24→34px、
      // 键盘打开时 padding-bottom 收窄),content-box 对此**不触发回调**,--dock-h 就停旧值
      dockRO.observe(dockEl, { box: "border-box" });
    } else {
      window.addEventListener("resize", syncDockHeight);
    }
    if (window.visualViewport) window.visualViewport.addEventListener("resize", syncDockHeight);
    // 字体就位后 composer 还会长一截:首帧量到的是字体没加载的矮高度,必须补量一次
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => syncDockHeight());
    bindQueueDrag();
    // 队列泵：任何一条路径把 busy 置回 false，这里都会在 400ms 内把队首发出去
    setInterval(pumpQueue, 400);
    requestAnimationFrame(moveTabIndicator);
    window.addEventListener("resize", moveTabIndicator);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveTabIndicator);
    $("#btnBack").addEventListener("click", () => {
      // 成员会话是**一层视图**：返回先退出它（干净地回到父会话），再按一次才去列表。
      // 以前这里不认 teamView，直接 go("sessions")：成员轮询与导航条全挂着，
      // 列表里点任何一场又会被 openSession 顺手清掉 —— 用户看到的就是「按返回却回到了 lead 那场」。
      if (state.teamView) { exitTeamView(); haptic("light"); return; }
      // 离开电脑会话：停轮询、清标记，再回列表（否则列表刷新时还以为在电脑上）
      if (state.pcSession) Link.leave();
      go("sessions");
      haptic("light");
    });
    // 音色微调滑块：拖动时只改数字，松手才写进引擎（否则每帧都调一次 TTS）
    const sheetEl = $("#sheet");
    if (sheetEl) {
      sheetEl.addEventListener("input", (e) => {
        // 拖动时只更新数字（每次 input 都回调原生会让引擎反复中断）
        const pairs = [["#vtRate", "#vtRateVal", "×"],
                       ["#vtVolume", "#vtVolumeVal", "%"], ["#vtBright", "#vtBrightVal", ""], ["#vtPause", "#vtPauseVal", "×"]];
        for (const [inputSel, valSel, unit] of pairs) {
          if (!e.target.closest(inputSel)) continue;
          const el = $(valSel);
          if (!el) return;
          const v = Number(e.target.value);
          el.textContent = unit === "%" ? Math.round(v * 100) + "%"
            : unit === "semi" ? semiOf(v)
            : v.toFixed(2) + unit;
          return;
        }
      });
      sheetEl.addEventListener("change", (e) => {
        const map = { vtRate: "rate", vtVolume: "volume", vtBright: "brightness", vtPause: "pause" };
        const key = Object.keys(map).find((id) => e.target.closest("#" + id));
        if (!key) return;
        SpeechOut.applyTuning({ [map[key]]: Number(e.target.value) });
        try { if (Native && Native.speak) Native.speak(VOICE_SAMPLE, 1); } catch (_) {}
      });
    }

    $("#btnChatMore").addEventListener("click", () => openSheet(sheetMore()));
    // 加号就是一个动作：新建会话。没有二级菜单，也没有扫码入口。
    $("#btnNewSession").addEventListener("click", () => {
      haptic("light");
      startNewSession();
    });

    // 整页委托：会话行与工作区块头都在这一个监听里处理
    const sessionsScroll = $("#sessionsScroll");
    if (sessionsScroll) sessionsScroll.addEventListener("click", (e) => {
      if (e.target.closest("#btnPcRefresh")) {
        haptic("light");
        // 没配对时 refreshList 只会原地重画一次空列表：用户看着像按钮坏了。
        // 静默是 renderSessions 自动拉那一支的规矩，手点这一下必须说清楚缺什么。
        if (!Link.state().paired) { toast("还没连上电脑：设置 → 连电脑"); return; }
        Link.listAt = 0;
        Link.refreshList("手点");
        return;
      }
      const pcToggle = e.target.closest("[data-pc-toggle]");
      if (pcToggle) {
        haptic("light");
        const open = PcState.toggle();
        const group = pcToggle.closest(".ws-group");
        if (group) {
          group.classList.toggle("is-open", open);
          group.classList.toggle("is-stacked", !open && !group.classList.contains("is-single"));   // 单条会话不画堆叠边
          pcToggle.setAttribute("aria-expanded", String(open));
          wsSetBody(group, open);
          const meta = $(".ws-meta", pcToggle);
          if (meta) meta.textContent = (open ? meta.dataset.openText : meta.dataset.closedText) || "";
        }
        return;
      }
      const wsToggle = e.target.closest("[data-ws-toggle]");
      if (wsToggle) {
        haptic("light");
        const key = wsToggle.dataset.wsToggle;
        const open = WsState.toggle(key);
        // 就地改类名，保留展开动画（重渲染会把过渡打断）
        const group = wsToggle.closest(".ws-group");
        if (group) {
          group.classList.toggle("is-open", open);
          group.classList.toggle("is-stacked", !open && !group.classList.contains("is-single"));   // 单条会话不画堆叠边
          wsToggle.setAttribute("aria-expanded", String(open));
          wsSetBody(group, open);
          const meta = $(".ws-meta", wsToggle);
          if (meta) meta.textContent = (open ? meta.dataset.openText : meta.dataset.closedText) || "";
        }
        return;
      }
      // 左滑露出的四个操作：之前只给面板里的同名按钮绑了处理，列表里点了没反应
      const sPin = e.target.closest("[data-sess-pin]");
      if (sPin) {
        const id = sPin.dataset.sessPin;
        const cur = LocalDB.get(id);
        LocalDB.pin(id, !(cur && cur.pin));
        closeSwipedRow(null);
        renderSessions();
        haptic("light");
        toast(cur && cur.pin ? "已取消置顶" : "已置顶");
        return;
      }
      const sMove = e.target.closest("[data-sess-move]");
      if (sMove) {
        const s = localSessionView().find((x) => x.id === sMove.dataset.sessMove);
        closeSwipedRow(null);
        if (s) openSheet(sheetMoveWs(s));
        return;
      }
      const sRename = e.target.closest("[data-sess-rename]");
      if (sRename) {
        const s = LocalDB.get(sRename.dataset.sessRename);
        closeSwipedRow(null);
        if (s) openSheet(sheetRename(s));
        return;
      }
      const sDel = e.target.closest("[data-sess-del]");
      if (sDel) {
        const s = LocalDB.get(sDel.dataset.sessDel);
        closeSwipedRow(null);
        if (s) openSheet(sheetConfirmDeleteSession(s));
        return;
      }
      const pc = e.target.closest("[data-pc-open]");
      if (pc) {
        // 电脑上的会话：打开中继聊天面板（消息会直接进电脑的 agent）
        haptic("light");
        Link.open(pc.dataset.pcOpen, pc.dataset.pcTitle || "", "list");
        return;
      }
      const b = e.target.closest("[data-open]");
      if (b) {
        // 刚滑过：这次点击只当收尾，不打开会话
        if (Date.now() - lastSwipeAt < 360) return;
        if ($("#sessionsScroll .sess-row.is-swiped")) { closeSwipedRow(null); return; }
        haptic("light"); openSession(b.dataset.open);
      }
    });

    $("#searchSessions").addEventListener("input", (e) => renderSessions(e.target.value));

    const input = $("#input");
    input.addEventListener("input", () => {
      // 键盘打字会覆盖语音标记：这条等于「写」出来的，默认用文字回
      if (!state.__voiceFill) state.inputFromVoice = false;
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 116) + "px";
      updateSendState();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
    });
    $("#btnSend").addEventListener("click", () => {
      followBottomOn = true; // 发送后必须跟随到最新消息
      if (state.pcSession && Link.running && !$("#input").value.trim()) {
        try { Native.linkCancel("cancel-" + Date.now(), state.pcSession.id); } catch (_) {}
        toast("已请求电脑停止");
        return;
      }
      if (state.busy) {
        // 生成中打字后按钮是「发送」：点它只入队，不打断当前这一轮
        const t = $("#input").value.trim();
        if (t) {
          $("#input").value = "";
          $("#input").style.height = "auto";
          enqueue(t);
          updateSendState();
          keepInputFocus();   // 同 handleSend:清空会把按钮 disable,焦点丢了键盘就收了
          return;
        }
        stopLive();
        return;
      }
      handleSend();
    });

    // 队列：插话 / 编辑 / 删除
    const qbar = $("#queueBar");
    if (qbar) qbar.addEventListener("click", (e) => {
      const now = e.target.closest("[data-q-now]");
      if (now) {
        const item = takeQueued(now.dataset.qNow);
        renderQueue();
        if (!item) return;
        // 插话 = 立刻打断当前这一轮，把这条先发出去
        if (state.busy) { stopLive(true); setTimeout(() => sendQueued(item), 260); }
        else sendQueued(item);
        toast("已插话", 1500);
        return;
      }
      const collapse = e.target.closest("[data-q-collapse]");
      if (collapse) {
        QueueUI.collapsed = !QueueUI.collapsed;
        renderQueue();
        return;
      }
      const editBtn = e.target.closest("[data-q-edit]");
      if (editBtn) {
        // 编辑 = 取回输入框改，改完再决定发还是重新入队（不在气泡里就地编辑）
        const item = takeQueued(editBtn.dataset.qEdit);
        renderQueue();
        if (!item) return;
        const input = $("#input");
        input.value = item.text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
        return;
      }
      const del = e.target.closest("[data-q-del]");
      if (del) {
        takeQueued(del.dataset.qDel);
        renderQueue();
        haptic("light");
      }
    });
    $("#btnAttach").addEventListener("click", () => {
      haptic("light");
      // 电脑会话：＋ 是「电脑端动作」菜单（和电脑端一样是命令入口），不是选模型
      if (state.pcSession) {
        openPcPopover(document.querySelector("#btnAttach"), pcActionsHtml(), "cmds");
        // 命令按会话不同：先用缓存顶上，再刷新一次
        try { Native.linkCommands("pc-cmd-" + Date.now(), state.pcSession.id); } catch (_) {}
        return;
      }
      openSheet(sheetQuickActions());
    });
    // 电脑会话控制行里的「模型」胶囊：点了就是原来那个模型/思考强度面板
    $("#btnPcModel").addEventListener("click", () => {
      haptic("light");
      const showModels = () => openPcPopover(document.querySelector("#btnPcModel"), pcModelsHtml(), "models");
      showModels();
      if (!Link.catalog) Link.models().then(() => {
        const pop = $("#pcPopover");
        if (state.pcSession && pop && pop.dataset.pcPop === "models") showModels();
      });
    });
    // 上下文圆环：和电脑端一样，贴着圆环往上一层面板，看构成
    const ctxBtn = $("#pcContext");
    if (ctxBtn) ctxBtn.addEventListener("click", (event) => {
      haptic("light");
      const open = document.querySelector("#pcPopover");
      if (open && open.dataset.pcPop === "ctx") { closePcPopover(); return; }
      openPcPopover(ctxBtn, pcContextHtml(), "ctx");
    });
    $("#btnMic").addEventListener("click", () => {
      if (!VoicePlugin.on()) {
        toast("语音插件未开启：设置 → 插件 → 语音输入");
        return;
      }
      haptic("light");
      // 再点一次结束：说完不必等自动断句
      if (state.voiceLive) {
        state.voiceLive = false;
        voiceSet("正在识别…", true);
        voiceAwaitResult();
        if (Native && Native.stopVoiceInput) Native.stopVoiceInput();
        return;
      }
      const ta = $("#input");
      if (ta) ta.blur();
      state.voiceDraft = ta ? (ta.value || "") : "";
      state.voiceLive = true;
      voiceClearWatch();
      voiceOpen("说完点麦克风结束");
      if (Native && Native.startVoiceInput) Native.startVoiceInput();
      else { state.voiceLive = false; voiceClose(); toast("当前环境不支持语音"); }
    });
    /* 长按输入框说话：按住开始，松手结束（上滑取消） */
    (function bindInputLongPress() {
      const ta = $("#input");
      if (!ta) return;
      let timer = null, armTimer = null, sx = 0, sy = 0, holding = false, cancelIntent = false, graceTimer = null;
      let pressAt = 0, pressType = "", pressActive = false;

      // 产品规则：只有输入框为空时长按才是「按住说话」。
      // 有字时长按保留系统的选词 / 复制 / 粘贴 —— 那是编辑手势，不是语音。
      const canHoldVoice = () => VoicePlugin.on() && !ta.value.trim();

      // 长按判定窗口内临时关掉 user-select，避免系统选择抢走空输入框的长按；
      // 松手/移动/取消时立刻恢复，正常点按定位光标不受影响。
      const clearArm = () => {
        if (armTimer) { clearTimeout(armTimer); armTimer = null; }
        try { ta.classList.remove("is-voice-arming"); } catch (_) {}
      };
      const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } clearArm(); };
      const clearGrace = () => { if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; } };

      const detach = () => {
        clearGrace();
        clearArm();
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointercancel", onCancel);
      };
      const finish = (cancel) => {
        if (!holding) return;
        holding = false;
        state.voiceLive = false;
        try { if (Native && Native.setVoiceHold) Native.setVoiceHold(false); } catch (_) {}
        detach();
        if (cancel) {
          state.voiceDraft = "";
          if (Native && Native.cancelVoiceInput) Native.cancelVoiceInput();
          voiceClose();
        } else {
          voiceSet("正在识别…", true);
          voiceAwaitResult();
          if (Native && Native.stopVoiceInput) Native.stopVoiceInput();
        }
      };
      function onUp() { clearGrace(); finish(cancelIntent); }
      function onCancel() {
        // 系统抢占触摸（收键盘、手势导航、视口 resize、浮层插入）都会发 pointercancel，
        // 它**不代表用户松手**。旧代码在这里直接 finish(true) 退出语音 ——
        // 表现就是「手指还按着，语音面板自己没了」。
        // 现在给一个宽限期：期间来了 pointerup 就正常结束，没来就保持面板，
        // 由用户点「取消 / 完成」收尾，绝不替用户做「他松手了」的判断。
        if (graceTimer) return;
        graceTimer = setTimeout(() => {
          graceTimer = null;
          if (!state.voiceLive) return;
          voiceSet("松手后点完成，或上滑取消", true);
          document.removeEventListener("pointermove", onMove);
          document.removeEventListener("pointerup", onUp);
          document.removeEventListener("pointercancel", onCancel);
        }, 1200);
      }
      function onMove(e) {
        if (!holding) return;
        // 按住后向上滑 >60px 视为取消（微信式）
        if (sy - e.clientY > 60) {
          cancelIntent = true;
          voiceSet("松开取消", true);
        } else if (cancelIntent && sy - e.clientY <= 60) {
          cancelIntent = false;
          voiceSet("正在聆听…", false);
        }
      }

      /* 只在输入框为空时开始「按住说话」。空输入框下，计时器 / contextmenu /
         系统选择 / 原生长按四条路都可能进来；原生那条还会补发松手
         （见 DSHHost.onVoiceHoldRelease）。有字时长按保留系统编辑手势。 */
      const startHold = (why) => {
        if (holding || state.voiceLive) return;   // 已经有一条会话（含点麦克风）就不要再开第二条
        if (ta.value.trim()) return;              // 有字：长按是选词/复制粘贴，不是语音
        if (timer) { clearTimeout(timer); timer = null; }
        clearArm();
        if (!VoicePlugin.on()) return;   // 插件关了：长按只当普通输入
        if (!Native || !Native.startVoiceInput) return;
        // 原生选择可能已经开始：先收掉选择与上下文菜单，再把语音会话立起来
        try {
          const sel = document.getSelection();
          if (sel && sel.rangeCount) sel.removeAllRanges();
        } catch (_) {}
        let started = false;
        try { started = Native.startVoiceInput() !== false; } catch (_) {}
        if (!started) {
          try { if (Native.setVoiceHold) Native.setVoiceHold(false); } catch (_) {}
          return;
        }
        try { if (Native.setVoiceHold) Native.setVoiceHold(true); } catch (_) {}
        state.voiceDraft = "";   // 长按只在空输入时触发；有草稿走麦克风按钮（追加）
        holding = true;
        state.voiceLive = true;
        haptic("light");
        // 收键盘放到下一帧：blur 会触发视口变化 → 系统可能打断这一串触摸事件，
        // 和 pointerdown 同帧执行最容易把刚建立的语音会话一起 cancel 掉。
        voiceClearWatch();
        voiceOpen("松开结束 · 上滑取消");
        requestAnimationFrame(() => { try { ta.blur(); } catch (_) {} });
        document.addEventListener("pointerup", onUp);
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointercancel", onCancel);
      };
      // 原生桥入口：Activity 接管长按 / 补发松手
      state.voiceHoldStart = startHold;
      state.voiceHoldRelease = () => { clearGrace(); finish(cancelIntent); };

      ta.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        sx = e.clientX; sy = e.clientY;
        cancelIntent = false;
        pressAt = Date.now();
        pressType = e.pointerType || "touch";
        pressActive = true;
        const holdVoice = canHoldVoice();
        // 原生长按只接管「空输入框上」的那一次；有字/插件关着时取消接管，
        // 保留系统的选词、复制粘贴与上下文菜单。
        if (Native && Native.setVoicePress) {
          try { Native.setVoicePress(pressType !== "mouse" && holdVoice); } catch (_) {}
        }
        clearTimer();
        if (!holdVoice) return;
        // 120ms 后再关选择：轻点（定位光标）已经完成，长按的选择手柄还没来得及出现
        armTimer = setTimeout(() => {
          armTimer = null;
          if (timer) ta.classList.add("is-voice-arming");
        }, 120);
        timer = setTimeout(() => { timer = null; startHold("timer"); }, 420);
      });

      // 原生上下文菜单（复制/粘贴）：只有空输入框才把它变成语音入口；
      // 有字时保留系统菜单，长按 = 选词/复制粘贴。
      ta.addEventListener("contextmenu", (e) => {
        if (pressType === "mouse") return;
        if (ta.value.trim()) return;
        e.preventDefault();
        if (!holding && !state.voiceLive) startHold("menu");
      });

      // 系统已经先一步选了词（部分机型不派发 contextmenu）：只在空输入框时把选择
      // 当作长按语义；有字时选词就是编辑，不能弹语音。
      // 只认「手指还没抬起来」的那次选择：双击选词 / 键盘输入法选区发生时
      // pressActive 已经是 false，不会把正常编辑打断。
      document.addEventListener("selectionchange", () => {
        if (holding || state.voiceLive || pressType === "mouse" || !pressActive) return;
        if (ta.value.trim()) return;
        if (!pressAt || Date.now() - pressAt < 350 || Date.now() - pressAt > 1500) return;
        let picked = false;
        try { picked = ta.selectionStart !== ta.selectionEnd; } catch (_) {}
        if (picked) startHold("selection");
      });

      // 还没到长按时：手指移动/抬起就取消计时，保证轻点仍是正常打字
      ta.addEventListener("pointermove", (e) => {
        if (!timer) return;
        if (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8) clearTimer();
      });
      // 只认 pointerup：有内容时原生选择会发 pointercancel，若在这里清计时器，
      // 长按语音永远起不来（用户实测的 bug）。移动超过 8px 已经由上面的 pointermove 取消。
      ta.addEventListener("pointerup", clearTimer);
      // 抬手后系统才产生的选区（双击选词 / 输入法）不再当成「按住说话」
      ta.addEventListener("pointerup", () => { pressActive = false; });

      // 用户点「取消」直接退出时，长按流程的 document 监听要一起拆掉，
      // 否则上下文里留着一个 holding=true，下一次松手会再走一遍 finish。
      const cancelBtn = $("#voiceCancel");
      if (cancelBtn) cancelBtn.addEventListener("click", () => {
        holding = false;
        state.voiceDraft = "";
        try { if (Native && Native.setVoiceHold) Native.setVoiceHold(false); } catch (_) {}
        detach();
      });
    })();

    $("#voiceCancel").addEventListener("click", () => {
      haptic("light");
      voiceClearWatch();
      state.voiceLive = false;
      state.voiceDraft = "";
      if (Native && Native.cancelVoiceInput) Native.cancelVoiceInput();
      voiceClose();
    });

    // 回到前台：把原生引擎在后台生成的消息补进对话。
    // 生成已经搬到原生前台服务（不需要 WebView），所以这里只负责「领走 + 渲染」。
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      try { Companion.drain(); } catch (_) {}
      try { Companion.pushContext(); } catch (_) {}
      // 通知权限可能刚在系统设置里被改过：这一行要重新读，否则显示旧状态
      try { syncNotifyRow(); } catch (_) {}
      // 回到前台：补一次 Mission 对齐 + 认领后台期间积攒的唤醒
      setTimeout(() => {
        try { syncMissions(); } catch (_) {}
        try { wakeMissions(); } catch (_) {}
      }, 300);
    });

    // 定时领：应用就在前台时，引擎照样会到点开口（服务一直在跑），
    // 4s 一次的轮询比让用户「等下一次回到前台」更接近聊天软件的体感。
    // 只读一个本地小 JSON，几乎无成本。
    setInterval(() => {
      if (document.visibilityState !== "visible") return;
      try { Companion.drain(); } catch (_) {}
    }, 4000);

    // 页面不可见（切后台/锁屏）：先把上下文快照推给原生（引擎之后靠它当记忆），
    // 再处理麦克风
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "hidden") return;
      // 流式中的这一轮：隐藏前**同步**落一次快照。8 秒节流的那次落盘走空闲时段，
      // 而隐藏之后空闲回调可能再也不跑 —— 用户「息屏再亮屏」看到的就少了最后半截
      // （实测：杀掉前页面已流出 892 字，库里只有 567 字）。
      if (Live.id || state.busy) { try { persistThread(true); } catch (_) {} }
      try { Companion.pushContext(); } catch (_) {}
      if (state.voiceLive !== true) return;
      state.voiceLive = false;
      state.voiceDraft = "";
      voiceClearWatch();
      voiceClose();
      if (Native && Native.cancelVoiceInput) Native.cancelVoiceInput();
    });
    $("#voiceDone").addEventListener("click", () => {
      haptic("light");
      voiceSet("正在识别…", true);
      voiceAwaitResult();
      if (Native && Native.stopVoiceInput) Native.stopVoiceInput();
      else { voiceClose(); toast("当前环境不支持语音"); }
    });

    // 文件页分段切换：内容随之切换
    $$(".seg").forEach((b) => b.addEventListener("click", () => {
      $$(".seg").forEach((x) => x.classList.remove("is-on"));
      b.classList.add("is-on");
      if (b.dataset.fileTab) {
        state.fileTab = b.dataset.fileTab;
        renderFiles();
      }
      haptic("light");
    }));

    // 电脑会话的图片入口：选完就压进托盘（同一张图连选两次也要能触发 change）
    const pcImgInput = $("#pcImageInput");
    if (pcImgInput) pcImgInput.addEventListener("change", async () => {
      const files = [...(pcImgInput.files || [])];
      pcImgInput.value = "";
      await addPcImages(files);
    });
    $("#fileInput").addEventListener("change", async (e) => {
      const files = [...(e.target.files || [])];
      for (const f of files) {
        if (state.attachments.length >= 10) { toast("最多添加 10 个附件"); break; }
        if (f.size > 25 * 1024 * 1024) { toast(f.name + " 超过 25MB"); continue; }
        const a = { name: f.name, size: f.size, type: f.type || "", file: f, thumb: null, dataUrl: "" };
        if (a.type.startsWith("image/")) {
          // 持久 dataUrl：对话气泡渲染、发给模型、会话回放共用一份，不依赖会被 revoke 的 blob URL
          try { a.dataUrl = await readAsDataURL(f); a.thumb = a.dataUrl; } catch (_) {}
        } else if (f.size <= 8 * 1024 * 1024) {
          // 文档/代码/表格等也读 dataUrl：气泡 chip 点开即可应用内预览
          try { a.dataUrl = await readAsDataURL(f); } catch (_) {}
        }
        state.attachments.push(a);
      }
      e.target.value = "";
      renderAttachments();
    });
    $("#attachTray").addEventListener("click", (e) => {
      const x = e.target.closest("[data-attach-x]");
      if (!x) return;
      const i = +x.dataset.attachX;
      state.attachments.splice(i, 1);
      renderAttachments();
      updateSendState();
    });
    // 会话列表读失败时的「重试」：空态里给真实原因，别让用户以为会话被删了
    $("#recentList").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-retry-sessions]");
      if (!btn) return;
      haptic("light");
      btn.disabled = true;
      btn.textContent = "重试中…";
      loadSessions();
    });

    $$("[data-sheet]").forEach((b) => b.addEventListener("click", () => {
      const which = b.dataset.sheet;
      openSheet(which === "model" ? sheetModel() : which === "effort" ? sheetEffort() : sheetWorkspace());
    }));

    $("#rowContext").addEventListener("click", () => openSheet(sheetContext()));
    $("#rowGenModels").addEventListener("click", () => { syncGenValue(); openSheet(sheetGenModels()); });
    $("#rowMaxOut").addEventListener("click", () => openSheet(sheetMaxOut()));
    $("#rowPerm").addEventListener("click", () => openSheet(sheetPerm()));
    $("#rowPersona").addEventListener("click", () => openSheet(sheetPersona()));
    $("#rowCompanion").addEventListener("click", () => openSheet(sheetCompanion()));
    const rowMode = $("#rowMode"); if (rowMode) rowMode.addEventListener("click", () => openSheet(sheetMode()));
    const rowPresetDefault = $("#rowPresetDefault"); if (rowPresetDefault) rowPresetDefault.addEventListener("click", () => openSheet(sheetPresetDefault()));
    const rowHost = $("#rowHost"); if (rowHost) rowHost.addEventListener("click", () => Link.enter());
    $("#rowCompact").addEventListener("click", () => openSheet(sheetCompact()));
    $("#swSessMem").addEventListener("change", (e) => {
      state.sessMem = e.target.checked;
      localStorage.setItem("dsh.sessMem", state.sessMem ? "1" : "0");
    });
    $("#swGlobalMem").addEventListener("change", (e) => {
      state.globalMem = e.target.checked;
      localStorage.setItem("dsh.globalMem", state.globalMem ? "1" : "0");
    });
    $("#rowLanguage").addEventListener("click", () => openSheet(sheetLanguage()));
    $("#rowPermission").addEventListener("click", () => { permSync(); openSheet(sheetPermission(false)); });
    // 全局记忆条目：查看 / 添加 / 编辑 / 删除
    $("#rowGlobalMems").addEventListener("click", () => { state.memEdit = null; openSheet(sheetGlobalMem()); });
    // 底部按钮（.sheet-footer）会被 openSheet 移到 #sheetBody 之外，
    // 监听必须挂在 #sheet 上，否则「保存 / 取消」点了没反应、浮窗也不关。
    $("#sheet").addEventListener("click", (e) => {
      // 语音插件开关：内置模型随包安装，开关只管显不显示麦克风，跟下载无关
      const swVoice = e.target.closest("#swVoicePlugin");
      if (swVoice) {
        if (!swVoice.checked) {
          VoicePlugin.set(false);
          VoicePlugin.apply();
          openSheet(sheetPlugins());
          toast("语音输入已关闭");
          return;
        }
        VoicePlugin.set(true);
        VoicePlugin.apply();
        openSheet(sheetPlugins());
        toast("语音输入已开启：输入框右侧可以说话", 3000);
        return;
      }
      if (e.target.closest("#btnGenSave")) {
        if (!(Native && Native.saveGenConfig)) { toast("当前环境不支持保存"); return; }
        let okCount = 0;
        for (const k of ["image", "video"]) {
          const url = (($("#genUrl_" + k) || {}).value || "").trim();
          const key = (($("#genKey_" + k) || {}).value || "").trim();
          const model = (($("#genModel_" + k) || {}).value || "").trim();
          try {
            const r = JSON.parse(Native.saveGenConfig(k, url, key, model) || "{}");
            if (r && r.ok !== false) okCount += 1;
          } catch (_) {}
        }
            closeSheet();
        toast(okCount ? "生成模型已保存" : "保存失败");
        syncGenValue();
        return;
      }
      // 删除按钮在格子内部，必须先于「发送」判断，否则会被父按钮一起吃掉
      const stickerDel = e.target.closest(".sticker-del");
      if (stickerDel) {
        const cell = stickerDel.closest(".sticker-cell");
        const id = cell ? cell.dataset.stickerId : "";
        if (!id) return;
        Stickers.remove(id);
        if (cell) cell.remove();
        const grid = $("#stickerGrid");
        if (grid && !grid.querySelector(".sticker-cell")) {
          grid.innerHTML = '<div class="sheet-caption">还没有表情包 · 点下面从相册选一张转成表情</div>';
          grid.classList.remove("is-editing");
        }
        const count = $("#sheetBody .sheet-title .sheet-count");
        if (count) {
          const left = Stickers.all().length;
          if (left > 0) count.textContent = String(left); else count.remove();
        }
        haptic("light");
        toast("已删除这个表情");
        return;
      }
      const stickerSend = e.target.closest("[data-sticker-send]");
      if (stickerSend) {
        // 编辑态里点格子不发送、也不退出编辑 —— 否则想点右上角 ✕ 却点到图上，
        // 编辑态就没了，还得重新长按一遍。退出编辑走「点空白 / 取消」。
        const gridEl = $("#stickerGrid");
        if (gridEl && gridEl.classList.contains("is-editing")) return;
        const st = Stickers.all().find((x) => x.id === stickerSend.dataset.stickerSend);
        closeSheet();
        if (st) Stickers.send(st);
        return;
      }
      if (e.target.closest("#btnStickerPick")) {
        const picker = $("#stickerFile");
        if (picker) picker.click();
        return;
      }
      if (e.target.closest("#cloudTts")) { openSheet(sheetCloudTts()); return; }
      if (e.target.closest("#btnCloudSave")) { saveCloudTts(false); return; }
      if (e.target.closest("#btnCloudTest")) { saveCloudTts(true); return; }
      if (e.target.closest("#btnCloudOff")) {
        SpeechOut.cloudSet(Object.assign({}, SpeechOut.cloud(), { enabled: false, apiKey: "" }));
        toast("已切回系统 TTS"); openSheet(sheetCloudTts()); return;
      }
      if (e.target.closest("[data-sheet-voice-system]")) {
        SpeechOut.cloudSet(Object.assign({}, SpeechOut.cloud(), { enabled: false, apiKey: "" }));
        toast("已切回系统 TTS"); openSheet(sheetVoiceGender()); return;
      }
      if (e.target.closest("[data-cloud-edit]")) { openSheet(sheetCloudTts()); return; }
      if (e.target.closest("#btnVoiceCacheClear")) {
        let freed = 0;
        try { if (Native && Native.voiceCacheClear) freed = Number(Native.voiceCacheClear()) || 0; } catch (_) {}
        SpeechOut.applyTuning({});
        openSheet(sheetVoiceGender());
        toast(freed > 0 ? `已清空语音缓存（${Math.round(freed / 1048576)}MB）` : "语音缓存已经是空的", 2400);
        return;
      }
      if (e.target.closest("#btnVoiceTest")) {
        try { if (Native && Native.speak) Native.speak(VOICE_SAMPLE, 1); } catch (_) {}
        return;
      }
      if (e.target.closest("#voiceGender")) {
        const btn = e.target.closest("#voiceGender");
        if (popEl) { closePopover(); return; }
        openVoicePopover(btn);
        return;
      }
      /* ---- 陪伴式畅聊 ---- */
      const swCp = e.target.closest("#swCompanion");
      if (swCp) {
        // 打开即给一次机会：不然刚开完还要空等一个随机窗口，用户会以为没生效
        Companion.save({ enabled: swCp.checked, nextDueAt: 0 });
        openSheet(sheetCompanion());
        toast(swCp.checked ? "陪伴式畅聊已开启，它会挑时候跟你说话" : "已关闭：只在你说话后回应", 2600);
        return;
      }
      const swCpV = e.target.closest("#swCompanionVoice");
      if (swCpV) {
        if (swCpV.checked && !SpeechOut.on()) {
          toast("先开启「语音输出」，它说的话才有声音", 2800);
          swCpV.checked = false;
          return;
        }
        if (swCpV.checked && !VoicePlugin.on()) {
          toast("先开启「语音输入」插件，它才能听你回", 2800);
          swCpV.checked = false;
          return;
        }
        Companion.save({ voiceReply: !!swCpV.checked });
        openSheet(sheetCompanion());
        toast(swCpV.checked ? "语音回聊已开启：它说完会等你接一句" : "语音回聊已关闭", 2400);
        return;
      }
      const cpCad = e.target.closest("[data-cp-cadence]");
      if (cpCad) {
        // 换档位就作废旧窗口：否则切到「话多」也得等上一个「安静」的长窗口走完
        Companion.save({ cadence: cpCad.dataset.cpCadence, nextDueAt: 0 });
        openSheet(sheetCompanion());
        return;
      }
      const cpQuiet = e.target.closest("[data-cp-quiet]");
      if (cpQuiet) {
        const [s, en] = String(cpQuiet.dataset.cpQuiet).split("-").map(Number);
        Companion.save({ quietStart: s, quietEnd: en });
        openSheet(sheetCompanion());
        return;
      }
      const cpStyle = e.target.closest("[data-cp-style]");
      if (cpStyle) {
        Companion.save({ style: cpStyle.dataset.cpStyle });
        openSheet(sheetCompanion());
        return;
      }
      if (e.target.closest("#cpTry")) {
        closeSheet();
        Companion.tryNow();
        return;
      }
      const swOut = e.target.closest("#swVoiceOut");
      if (swOut) {
        if (!SpeechOut.available()) {
          toast("当前环境没有可用的系统语音合成引擎", 2800);
          openSheet(sheetPlugins());
          return;
        }
        SpeechOut.set(!!swOut.checked);
        if (!swOut.checked) SpeechOut.stop();
        openSheet(sheetPlugins());
        toast(swOut.checked
          ? "语音朗读已开启：闲聊会念出来，数据与代码不会"
          : "语音朗读已关闭", 2600);
        return;
      }
      // 增强模型：下载 / 删除
      if (e.target.closest("#asrDownload")) {
        state.voiceWant = true;
        state.asrDl = { done: 0, total: 1 };
        openSheet(sheetPlugins());
        if (Native && Native.asrModelDownload) Native.asrModelDownload();
        else toast("当前环境不支持下载");
        return;
      }
      if (e.target.closest("#asrRemove")) {
        const ok = Native && Native.asrModelRemove ? Native.asrModelRemove() : false;
        state.asrDl = null;
        state.voiceWant = false;
        VoicePlugin._installed = null;
        VoicePlugin.apply();
        openSheet(sheetPlugins());
        toast(ok ? "已删除增强模型，回到内置中文模型" : "删除失败");
        return;
      }
      // 注入预览：不依赖当前 scope，单独处理
      if (e.target.closest("#memPreview")) {
        openSheet(sheetMemPreview());
        return;
      }
      const scope = memScope();
      if (!scope) return;
      if (e.target.closest("#memAdd")) {
        const box = $("#memInput");
        const text = (box && box.value || "").trim();
        if (!text) { toast("先写一条记忆内容"); return; }
        if (scope === "session") {
          const kind = memKindOf(text);
          LocalDB.addMem(state.sessionId, text, "manual", { kind, topic: memTopicOf(text, kind) });
        } else GlobalMem.add(text, "manual");
        state.memEdit = null;
        haptic("light");
        memReopen(scope);
        refreshMemCount();
        toast("已添加");
        return;
      }
      if (e.target.closest("#memResum")) {
        const t = Memo.summarizeSession(state.sessionId);
        state.memEdit = null;
        memReopen(scope);
        refreshMemCount();
        toast(t ? "已重新总结" : "还没有可总结的对话");
        return;
      }
      const pin = e.target.closest("[data-mem-pin]");
      if (pin) {
        GlobalMem.togglePin(pin.dataset.memPin);
        state.memEdit = null;
        memReopen(scope);
        haptic("light");
        return;
      }
      const del = e.target.closest("[data-mem-del]");
      if (del) {
        const id = del.dataset.memDel;
        if (scope === "session") LocalDB.removeMem(state.sessionId, id);
        else GlobalMem.remove(id);
        state.memEdit = null;
        memReopen(scope);
        refreshMemCount();
        toast("已删除");
        return;
      }
      const ed = e.target.closest("[data-mem-edit]");
      if (ed) {
        state.memEdit = { scope, id: ed.dataset.memEdit };
        memReopen(scope);
        const box = $("#memEditBox");
        if (box) {
          box.focus();
          box.setSelectionRange(box.value.length, box.value.length);
          // 键盘弹出后把编辑框顶到浮层可见区顶部，避免被键盘盖住
          const pin = () => {
            const body = box.closest(".sheet-body");
            if (!body) return;
            const top = box.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
            body.scrollTop = Math.max(0, top - 12);
          };
          setTimeout(pin, 260);
          setTimeout(pin, 520);
        }
        return;
      }
      const sv = e.target.closest("[data-mem-save]");
      if (sv) {
        const box = $("#memEditBox");
        const text = (box && box.value || "").trim();
        if (!text) { toast("内容不能为空，可直接删除这条"); return; }
        if (scope === "session") LocalDB.updateMem(state.sessionId, sv.dataset.memSave, text);
        else GlobalMem.update(sv.dataset.memSave, text);
        state.memEdit = null;
        memReopen(scope);
        refreshMemCount();
        toast("已保存");
        return;
      }
      if (e.target.closest("[data-mem-cancel]")) {
        state.memEdit = null;
        memReopen(scope);
      }
    });
    // 权限面板里的动作（首次引导与设置入口共用）
    // 底部按钮（.sheet-footer）会被 openSheet 移到 #sheetBody 之外，
    // 监听必须挂在 #sheet 上，否则「保存 / 取消」点了没反应、浮窗也不关。
    $("#sheet").addEventListener("click", (e) => {
      const req = e.target.closest("[data-perm-req]");
      if (req) { permMarkPrimed(); permAskGroup(req.dataset.permReq); return; }
      if (e.target.closest("#permAskAll")) {
        permMarkPrimed();
        haptic("light");
        if (Native && Native.requestAllPermissions) Native.requestAllPermissions();
        return;
      }
      if (e.target.closest("#permDone")) { permMarkPrimed(); closeSheet(); return; }
      if (e.target.closest("#permLater")) { permMarkPrimed(); closeSheet(); return; }
      if (e.target.closest("#permSettings")) {
        permMarkPrimed();
        closeSheet();
        if (Native && Native.openAppSettings) Native.openAppSettings();
        else toast("请到系统设置 → 应用 → 权限里开启");
      }
    });
    $("#btnNewJob").addEventListener("click", () => { state.editingJob = null; openSheet(sheetNewJob()); });

    /* 联网搜索配置 */
    const initSearch = $("#swSearch");
    if (initSearch) initSearch.checked = !!SearchCfg.get().on;
    const sv = $("#searchCfgValue");
    if (sv) sv.textContent = searchCfgLabel();
    $("#swSearch").addEventListener("change", (e) => {
      const c = SearchCfg.get();
      c.on = e.target.checked;
      if (!c.max) c.max = 5;
      SearchCfg.set(c);
      $("#searchCfgValue").textContent = searchCfgLabel();
      toast(c.on ? (c.url ? "联网搜索已开启" : "已开启，但还没有配置搜索接口") : "联网搜索已关闭");
    });
    $("#rowSearchCfg").addEventListener("click", () => {
      const c = SearchCfg.get();
      openSheet(`
        <div class="sheet-title">联网搜索接口</div>
        <div class="sheet-sub">兼容 Bing/Tavily</div>
        <div class="field"><label>搜索接口地址</label><input id="searchUrl" value="${esc(c.url || "")}" placeholder="https://api.example.com/search" inputmode="url" autocapitalize="off" /></div>
        <div class="field"><label>API Key（可留空）</label><input id="searchKey" type="password" value="${esc(c.key || "")}" placeholder="Bearer 鉴权用的 key" autocapitalize="off" /></div>
        <div class="field"><label>每次提问最多返回条数</label><input id="searchMax" type="number" min="1" max="10" value="${Number(c.max) || 5}" /></div>
        <button class="btn-primary" id="searchSave">保存</button>
      `);
      $("#searchSave").addEventListener("click", () => {
        const url = ($("#searchUrl").value || "").trim();
        const cfg = SearchCfg.get();
        cfg.url = url;
        cfg.key = ($("#searchKey").value || "").trim();
        cfg.max = Math.max(1, Math.min(10, Number($("#searchMax").value) || 5));
        cfg.on = !!$("#swSearch").checked;
        SearchCfg.set(cfg);
        $("#searchCfgValue").textContent = searchCfgLabel();
        closeSheet();
        toast(url ? "搜索接口已保存" : "已清空搜索接口");
      });
    });

    // 长按任务 / 文件 / 会话 → 操作面板
    const openJobSheet = (el) => {
      // 行从 `findJobRow()` 拿（账本优先）。以前这里去两份旧注册表 find：
      // `jobsList()` 是进程内存、重启即空，`team:` 这类 kind 干脆没有分支 ——
      // 结果面板什么都不开，用户看到的就是「任务点没反应、也删不掉」（实测 12 行全打不开）。
      // 行从 `findJobRow()` 拿（账本优先）。以前这里去两份旧注册表 find：
      // `jobsList()` 是进程内存、重启即空，`team:` 这类 kind 干脆没有分支 ——
      // 结果面板什么都不开，用户看到的就是「任务点没反应、也删不掉」（实测 12 行全打不开）。
      const row = findJobRow(String(el.dataset.job || ""));
      if (row) openSheet(sheetJobActions(row));
    };
    attachLongPress($("#jobsToday"), "[data-job]", openJobSheet);
    // 点按同样开面板：以前唯一入口是 520ms 长按且毫无提示，用户点一下没反应，
    // 结论就是「任务删不掉也改不了」。
    const jobsToday = $("#jobsToday");
    if (jobsToday) {
      jobsToday.addEventListener("click", (e) => {
        const el = e.target.closest("[data-job]");
        if (el) openJobSheet(el);
      });
    }
    bindJobFilters();
    // 进行中带：有卡就定位+高亮，没卡就回任务页 —— 不做第二个入口
    const missionStrip = $("#missionStrip");
    if (missionStrip) {
      missionStrip.addEventListener("click", () => {
        const card = document.querySelector("#messages .mission-card");
        if (card) {
          // 只滚对话自己。scrollIntoView 会把 #device（overflow:hidden 的外壳）也当成
          // 滚动祖先一起滚，滚完整个界面永久上移、自己回不来（实测 -20px，置回 0 才恢复）。
          scrollChatTo(card);
          card.classList.remove("is-flash");
          void card.offsetWidth;
          card.classList.add("is-flash");
        } else go("jobs");
        haptic("light");
      });
    }
    // Mission 卡的「查看」：就地开详情抽屉（状态/时间线/证据/权限），任务页只在抽屉里作为次要入口
    const messagesHost = $("#messages");
    if (messagesHost) {
      messagesHost.addEventListener("click", (e) => {
        if (!e.target.closest("[data-mission-open]")) return;
        const node = thread.find((n) => n.kind === "mission" && n.sid === state.sessionId);
        openMissionSheet(node);
      });
    }
    // 文件页长按：删除 / 打开
    attachLongPress($("#filesList"), "[data-file-kind]", (el) => {
      const kind = el.dataset.fileKind;
      const path = el.dataset.filePath;
      const name = el.dataset.fileName;
      const id = el.dataset.fileId;
      if (kind === "att") {
        const rec = LocalFiles.all().find((x) => x.id === id) || { name, id };
        openSheet(sheetFileActions({ ...rec, kind: "att", path: "" }));
      } else if (kind === "work") {
        const item = (workspaceFiles().items || []).find((f) => f.path === path) || { name, path };
        openSheet(sheetFileActions({ ...item, kind: "work" }));
      } else {
        const item = deliverableFiles().find((f) => f.path === path) || { name, path };
        openSheet(sheetFileActions({ ...item, kind: "out" }));
      }
    });
    // 会话不再走长按：左滑直接露出操作按钮（长按入口保留给文件行）
    bindSessionSwipe();

    const selectAll = $("#btnSelectAll");
    if (selectAll) selectAll.addEventListener("click", () => {
      if (currentMode() === "host") { toast("宿主机会话请在宿主机侧管理"); return; }
      openSheet(sheetPickSessions());
    });
    $("#rowModels").addEventListener("click", () => openSheet(sheetModel()));
    $("#rowAddModel").addEventListener("click", () => openSheet(sheetAddModel()));
    const mv = $("#modelValue"); if (mv) mv.textContent = modelLabel();
    $("#rowWorkspace").addEventListener("click", () => openSheet(sheetWorkspace()));
    $("#rowStorage").addEventListener("click", () => { openSheet(sheetStorage()); haptic("light"); });
    $("#rowPlugins").addEventListener("click", () => openSheet(sheetPlugins()));
    const rowUpdate = $("#rowUpdate");
    if (rowUpdate) {
      rowUpdate.addEventListener("click", openUpdateSheet);
      try {
        const u = JSON.parse((Native && Native.updateState ? Native.updateState() : "") || "{}");
        const uv = $("#updateValue");
        if (uv && u.local) uv.textContent = String(u.local).replace(/^0\.2\.1-/, "");
      } catch (_) {}
    }
    const rowSelfModify = $("#rowSelfModify");
    if (rowSelfModify) {
      rowSelfModify.addEventListener("click", () => openSheet(sheetSelfModify()));
      try {
        const s = JSON.parse((Native && Native.selfModify ? Native.selfModify("status") : "") || "{}");
        const sv = $("#selfModifyValue");
        if (sv) sv.textContent = s.overlayActive ? "覆盖生效中" : (s.enabled ? "已开启" : "关闭");
      } catch (_) {}
    }
    const rowPrompt = $("#rowPrompt");
    if (rowPrompt) {
      rowPrompt.addEventListener("click", () => {
        openPromptViewer();
      });
      refreshPromptRow();
    }
    $("#rowUsage").addEventListener("click", () => {
      state.heatSel = null;
      refreshBalance();
      openSheet(sheetUsage());
    });
    const uv = $("#usageValue");
    if (uv) {
      uv.textContent = usageRowText();   // 余额回调（onBalance）到达时会再刷新一次
    }
    const rowNotify = $("#rowNotify");
    if (rowNotify) rowNotify.addEventListener("click", () => openSheet(sheetNotify()));
    syncNotifyRow();
    // DeepSeek 账号复用设置页顶部的账号卡片（accountCard），不单独加第二入口
    Account.sync();
    Account.bootstrap();
    refreshPlugins();

    $("#swDark").addEventListener("change", (e) => {
      state.theme = e.target.checked ? "dark" : "light";
      localStorage.setItem("dsh.theme", state.theme);
      applyTheme();
    });

    // 文件页搜索
    $("#btnSearchFiles").addEventListener("click", () => {
      const wrap = $("#filesSearchWrap");
      const on = wrap.classList.toggle("is-on");
      if (on) setTimeout(() => $("#filesSearch").focus(), 120);
      else { $("#filesSearch").value = ""; renderFiles(); }
      haptic("light");
    });
    $("#filesSearch").addEventListener("input", renderFiles);

    // 空态引导按钮
    $("#emptyConnectJobs").addEventListener("click", () => Link.enter());
    $("#emptyConnectFiles").addEventListener("click", () => Link.enter());

    // 危险操作询问 / 完成后通知
    const askSw = $("#swAskDanger");
    if (askSw) {
      askSw.checked = state.askDanger;
      askSw.addEventListener("change", (e) => {
        state.askDanger = e.target.checked;
        localStorage.setItem("dsh.askDanger", state.askDanger ? "1" : "0");
        haptic("light");
        // 完全授权本身就不逐条确认（needConfirm 要求 permission != full），
        // 这时候打开开关不会有任何效果 —— 别让 toast 承诺一个做不到的事
        toast(state.askDanger
          ? (state.perm === "full" ? "完全授权下不逐条询问，切回默认权限后生效" : "危险操作前会先询问")
          : "危险操作将直接执行");
      });
    }
    const notifySw = $("#swNotifyDone");
    if (notifySw) {
      notifySw.checked = state.notifyDone;
      /* 原生侧（RunService）要读这个开关才知道要不要发「已完成」通知，
         所以启动时对齐一次、切换时再推一次；localStorage 只是给界面记状态。 */
      const pushNotifyDone = (on) => {
        try { if (Native && Native.setNotifyDone) Native.setNotifyDone(!!on); } catch (_) {}
      };
      pushNotifyDone(state.notifyDone);
      notifySw.addEventListener("change", (e) => {
        state.notifyDone = e.target.checked;
        localStorage.setItem("dsh.notifyDone", state.notifyDone ? "1" : "0");
        pushNotifyDone(state.notifyDone);
        haptic("light");
        if (!state.notifyDone) {
          toast("不再发完成提醒（失败提醒仍保留）");
        } else {
          /* 开关打开也可能一条都发不出来：系统层面「通知」被关掉时
             NotificationManager 直接静默丢弃（Android 13+ 尤其）。这里当场核对一次，
             别让用户以为开关生效了。 */
          let ni = {};
          try { ni = JSON.parse(Native.notifyInfo() || "{}"); } catch (_) {}
          if (ni && ni.ok && !ni.notificationsEnabled) {
            toast("系统通知还没授权，完成提醒发不出来（设置 → 通知 里允许）", 3800);
          } else {
            toast("任务完成会在通知栏提醒");
          }
        }
      });
    }
    const wsv = $("#wsValue"); if (wsv) wsv.textContent = state.workspace;
    renderJobs();
    renderFiles();
    $("#sheetBackdrop").addEventListener("click", () => {
      // 长按出面板：手指松开时浏览器还会补一个 click，落点正好是刚盖上的遮罩 ——
      // 不挡住就会「面板一闪而过」。WebView 的 tap 点击最长会晚 ~300ms 才送到，这里给足 900ms 窗口。
      if (performance.now() < (window.__sheetGuardUntil || 0)) return;
      closeSheet();
    });

    // 团队：顶栏徽标 + 面板；成员卡点开它自己的对话，running 时可从日志页叫停
    // 团队入口：顶栏常显，点开是成员/任务板面板
    const btnTeam = $("#btnTeam");
    if (btnTeam) btnTeam.addEventListener("click", () => { pullTeam(); openSheet(teamSheet()); markTaskClamp(); });
    syncTeamBadge();
    setTimeout(pullTeam, 800);
    setTimeout(syncTeamLimitsRow, 950);
    const rowTeam = $("#rowTeam");
    if (rowTeam) rowTeam.addEventListener("click", () => openTeamLimits());
    const rowIsland = $("#rowIsland");
    if (rowIsland) rowIsland.addEventListener("click", () => openIslandTune());
    // 启动时把上次存的灵动岛几何推给原生（存在 localStorage，原生不读前端存储）
    syncIslandValue();
    pushIslandTune();
    // 限额滑块：拖动时只更新数字，停手 350ms 才写原生（连续拖动不刷一串写入）
    $("#sheetBody").addEventListener("input", (e) => {
      // 灵动岛：拖动即生效（要实时看效果，不能等停手）
      const isl = e.target.closest(".island-set input[type=range]");
      if (isl) {
        const key = isl.id.slice(3);
        const out = $("#iv-" + key);
        if (out) out.textContent = islandTuneText(isl);
        const cur = islandTuneValue();
        cur[key] = Number(isl.value);
        state.islandTune = cur;
        pushIslandTune();
        return;
      }
      const el = e.target.closest(".tm-set input[type=range]");
      if (!el) return;
      const out = $("#tv-" + el.id.slice(3));
      if (out) out.textContent = teamLimitText(el);
      pushTeamLimits();
    });
    $("#sheetBody").addEventListener("click", (e) => {
      const kill = e.target.closest("[data-team-kill]");
      if (kill) {
        if (!Native || !Native.teamInterrupt) return;
        const name = kill.dataset.teamKill;
        try {
          const r = JSON.parse(Native.teamInterrupt(teamSid(), name) || "{}");
          if (r.team) { state.team = r.team; syncTeamBadge(); }
          haptic("medium");
          toast(r.ok ? `已中断 ${name} 的这一轮` : (r.error || "中断失败"));
        } catch (_) { toast("中断失败"); }
        return;
      }
      const open = e.target.closest("[data-team-open]");
      if (open) { enterTeamView(open.dataset.teamOpen); return; }
      // 任务描述展开/收起：状态记在 teamTaskOpen（Set）里再整块重绘 ——
      // 面板每来一次快照就重写 innerHTML，DOM 上的局部状态活不过一次刷新
      const tx = e.target.closest("[data-task-x]");
      if (tx) {
        const key = teamTaskKey(tx.dataset.taskX);
        if (teamTaskOpen.has(key)) teamTaskOpen.delete(key); else teamTaskOpen.add(key);
        refreshTeamSheet();
        return;
      }
    });

    // Mission 详情抽屉：换看另一件事、改这件事的权限、终止/删除、定位、导出、重跑
    // 绑在 #sheet 而不是 #sheetBody：openSheet 会把 .sheet-footer 整块搬到面板直属子节点，
    // 挂在 body 上的委托永远收不到底部按钮（真机实锤：重跑点了没反应）。
    // 这个局部变量以前叫 sheetHost —— 和外层那个「连接电脑」面板构造函数同名，把构造函数
    // 在同一个作用域里盖掉了：设置页点「连接电脑」直接 TypeError，什么都不弹（真机实锤）。
    const missionSheetEl = $("#sheet");
    if (missionSheetEl) missionSheetEl.addEventListener("click", (e) => {
      const pick = e.target.closest("[data-mission-pick]");
      if (pick) {
        const ids = missionGroupIds(thread.find((n) => n.kind === "mission" && n.sid === state.sessionId));
        openSheet(sheetMission(ids.length ? ids : [pick.dataset.missionPick], pick.dataset.missionPick));
        haptic("light");
        return;
      }
      const perm = e.target.closest("[data-mission-perm]");
      if (perm) {
        const id = perm.dataset.missionId;
        let res = {};
        try { res = JSON.parse((Native.missionSetPermission || function () { return "{}"; })(id, perm.dataset.missionPerm) || "{}"); } catch (_) {}
        if (res.error) { toast(res.error); return; }
        haptic("medium");
        toast("这件事的权限已设为" + (MISSION_PERMS.find((p) => p.mode === perm.dataset.missionPerm) || {}).name);
        const node = thread.find((n) => n.kind === "mission" && n.sid === state.sessionId);
        const group = missionGroupIds(node);
        openSheet(sheetMission(group.includes(id) ? group : [id], id));
        syncMissions();
        return;
      }
      const cancel = e.target.closest("[data-mission-cancel]");
      if (cancel) {
        const r = cancelMissionRow(cancel.dataset.missionCancel);
        haptic("medium");
        toast(r.msg);
        if (r.ok) setTimeout(() => { renderJobs(); syncMissions(); openMissionSheet(thread.find((n) => n.kind === "mission" && n.sid === state.sessionId)); }, 320);
        return;
      }
      const rerun = e.target.closest("[data-mission-rerun]");
      if (rerun) {
        const r = rerunMissionRow(rerun.dataset.missionRerun);
        haptic("medium");
        toast(r.msg);
        if (r.ok) { closeSheet(); setTimeout(() => { renderJobs(); syncMissions(); }, 320); }
        return;
      }
      const locate = e.target.closest("[data-mission-locate]");
      if (locate) { closeSheet(); locateMission(locate.dataset.missionLocate); haptic("light"); return; }
      const exp = e.target.closest("[data-mission-export]");
      if (exp) {
        let r = {};
        try { r = JSON.parse((Native.missionExport || function () { return "{}"; })(exp.dataset.missionExport, "md") || "{}"); } catch (_) {}
        haptic("light");
        toast(r.ok ? ("已导出到 " + r.path) : (r.error || "导出失败"));
      }
      // 一键清理：只动 cleanable 且确实占用的项（白名单在原生 StorageAudit.clear 里）
      const clearAll = e.target.closest("[data-storage-clear-all]");
      if (clearAll) {
        const snap = storageStat();
        const targets = ((snap && snap.items) || []).filter((i) => i.cleanable && i.bytes > 0);
        if (!targets.length) { toast("没有可清理的占用"); return; }
        let freed = 0, n = 0;
        for (const it of targets) {
          try {
            const r = JSON.parse((Native.storageClear || function () { return "{}"; })(it.key) || "{}");
            if (r.ok) { freed += r.freed || 0; n++; }
          } catch (_) {}
        }
        haptic("medium");
        toast(n ? ("已清理 " + n + " 项，释放 " + fmtBytes(freed)) : "清理失败");
        openSheet(sheetStorage());
        refreshStorageRow();
        return;
      }
      // 存储面板：单项清理，清完重算一遍再刷行
      const clear = e.target.closest("[data-storage-clear]");
      if (clear) {
        let r = {};
        try { r = JSON.parse((Native.storageClear || function () { return "{}"; })(clear.dataset.storageClear) || "{}"); } catch (_) {}
        haptic("medium");
        toast(r.ok ? ("已释放 " + fmtBytes(r.freed)) : (r.error || "清理失败"));
        openSheet(sheetStorage());
        refreshStorageRow();
      }
    });

    // 成员会话导航条的退出按钮
    const tvExit = $("#teamViewExit");
    if (tvExit) tvExit.addEventListener("click", exitTeamView);

    // 插件启停：改的是原生插件注册表，工具目录即时变化
    $("#sheetBody").addEventListener("change", (e) => {
      const t = e.target.closest("[data-plugin-toggle]");
      if (!t) return;
      const id = t.dataset.pluginToggle;
      const on = t.checked;
      const r = Plugins.setEnabled(id, on);
      haptic("medium");
      toast(r ? (on ? "插件已启用" : "插件已禁用") : "插件切换失败");
      refreshPlugins();
      setTimeout(() => openSheet(sheetPlugins()), 60);
    });

    // 相册选图 → 转表情包：input[type=file] 的 change 不会走 click 委托，必须单独挂在 change 上
    $("#sheetBody").addEventListener("change", async (e) => {
      const picker = e.target.closest("#stickerFile");
      if (!picker) return;
      const f = picker.files && picker.files[0];
      picker.value = "";
      if (!f) return;
      const raw = await new Promise((res) => {
        const rd = new FileReader();
        rd.onload = () => res(String(rd.result || ""));
        rd.onerror = () => res("");
        rd.readAsDataURL(f);
      });
      const st = raw ? await Stickers.toSticker(raw, f.name) : null;
      if (!st) { toast("这张图读不出来，换一张试试"); return; }
      // 仓库单条上限 3MB：超了就明确拒绝，别把 stickers.json 撑坏
      if ((st.dataUrl || "").length * 0.75 > 3 * 1024 * 1024) {
        toast("这张图太大了（超过 3MB），换一张小点的", 2600);
        return;
      }
      const name = (f.name || "表情").replace(/\.[a-z0-9]+$/i, "").slice(0, 12) || "表情";
      const id = Stickers.save({ ...st, name });
      if (!id) { toast("保存失败"); return; }
      haptic("medium");
      // 留在表情面板：新表情直接出现在格子里，点一下就能发出去
      openSheet(sheetStickers());
      toast(st.kind === "gif" ? "已存为动图表情，点一下发送" : "已存为表情包，点一下发送", 2200);
    });

    document.addEventListener("click", (e) => {
      // Markdown 正文里的图片（含 SVG）：缩略显示，点开看原图
      const mdImg = e.target.closest("img.md-img, img.tool-thumb");
      if (mdImg && !mdImg.classList.contains("is-broken")) {
        const src = mdImg.getAttribute("src") || "";
        if (src) MediaView.open({ kind: "image", dataUrl: src, name: mdImg.alt || "图片" });
        return;
      }
      // 对话里的缩略图：点开全屏查看器（视频此时才开始真正播放）
      const thumb = e.target.closest("[data-media-open]");
      if (thumb) {
        const wrap = thumb.closest("[data-uid]");
        const node = wrap ? nodeByUid(wrap.dataset.uid) : null;
        if (node) MediaView.open(node);
        return;
      }
      // 轮次尾行：复制这一轮的回复
      const voiceText = e.target.closest("[data-voice-text]");
      if (voiceText) {
        const row = voiceText.closest(".voice-row");
        const box = row && row.parentElement ? row.parentElement.querySelector(".vm-text") : null;
        if (box) {
          box.hidden = !box.hidden;
          voiceText.textContent = box.hidden ? "转文字" : "收起文字";
        }
        haptic("light");
        return;
      }
      const regenBtn = e.target.closest("[data-voice-regen]");
      if (regenBtn) {
        const wrapEl = regenBtn.closest("[data-uid]");
        const node = wrapEl ? nodeByUid(wrapEl.dataset.uid) : null;
        if (node) VoiceBubble.regen(node);
        haptic("light");
        return;
      }
      const voiceBtn = e.target.closest("[data-voice-play]");
      if (voiceBtn) {
        const wrapEl = voiceBtn.closest("[data-uid]");
        const node = wrapEl ? nodeByUid(wrapEl.dataset.uid) : null;
        if (node && node.dataUrl) VoicePlay.toggle(node, voiceBtn);
        haptic("light");
        return;
      }
      const speakTurn = e.target.closest("[data-speak-turn]");
      if (speakTurn) {
        const wrapEl = speakTurn.closest("[data-uid]");
        const node = wrapEl ? nodeByUid(wrapEl.dataset.uid) : null;
        const text = (node && node.text) || "";
        if (!text.trim()) { toast("这条回复没有可朗读的文字"); return; }
        haptic("light");
        // 再点一次停止
        if (speakTurn.dataset.speaking === "1") {
          SpeechOut.stop();
          speakTurn.dataset.speaking = "0";
          toast("已停止朗读", 1400);
          return;
        }
        if (SpeechOut.say(text)) {
          speakTurn.dataset.speaking = "1";
          toast("正在朗读 · 再点一次停止", 1800);
        } else {
          toast("系统没有可用的语音合成引擎");
        }
        return;
      }
      const cp = e.target.closest("[data-copy-turn]");
      if (cp) {
        const wrapEl = cp.closest("[data-uid]");
        const node = wrapEl ? nodeByUid(wrapEl.dataset.uid) : null;
        // 与长按面板同一条规矩：圈了部分就只复制部分，没圈才复制这一轮。
        const decision = copyDecision(selectedTextIn($("#messages")), (node && node.text) || "");
        copyText(decision.text, decision.label);
        haptic("light");
        return;
      }
      // 压缩标记：点一下展开/收起检查点正文（桌面 CompactionItem 的同构交互）
      const comp = e.target.closest("[data-compact-toggle]");
      if (comp) {
        const wrapEl = comp.closest(".msg");
        const detail = wrapEl && wrapEl.querySelector(".compact-detail");
        if (detail) {
          const show = detail.hidden;
          detail.hidden = !show;
          comp.classList.toggle("is-open", show);
          if (show) scrollToBottom();
        }
        return;
      }
      const subToggle = e.target.closest("[data-sub-toggle]");
      if (subToggle) {
        const wrapEl = subToggle.closest("[data-uid]");
        const node = wrapEl ? nodeByUid(wrapEl.dataset.uid) : null;
        if (node) { node.open = !node.open; patchNode(node); }
        haptic("light");
        return;
      }
      // 文件改动行：点开看增删对照
      const chg = e.target.closest("[data-toggle-change]");
      if (chg) {
        const wrapEl = chg.closest("[data-uid]");
        const node = wrapEl ? nodeByUid(wrapEl.dataset.uid) : null;
        if (node) {
          node.open = !node.open;
          patchNode(node);
        } else {
          chg.closest(".change-row")?.classList.toggle("is-open");
        }
        haptic("light");
        return;
      }
      // 轮次过程行（已完成，用时 N 秒）：点开才看到每一步
      const tp = e.target.closest("[data-toggle-tp]");
      if (tp) {
        const wrapEl = tp.closest("[data-uid]");
        const node = wrapEl ? nodeByUid(wrapEl.dataset.uid) : null;
        const box = tp.closest(".turnproc");
        if (!box || box.classList.contains("is-disabled")) return;
        const open = node ? !node.open : !box.classList.contains("is-open");
        if (node) node.open = open;
        box.classList.toggle("is-open", open);
        haptic("light");
        return;
      }
      // 运行中的过程组头
      const pg = e.target.closest("[data-toggle-pgroup]");
      if (pg) {
        const wrapEl = pg.closest("[data-uid]");
        const node = wrapEl ? nodeByUid(wrapEl.dataset.uid) : null;
        const box = pg.closest(".pgroup");
        if (node) {
          node.open = !node.open;
          // 收起期间正文行是懒渲染的，展开时按模型重绘一次，保证内容完整
          patchNode(node);
        } else if (box) {
          box.classList.toggle("is-open");
        }
        haptic("light");
        return;
      }
      // 组内单步：思考展开正文，工具展开输入/输出
      const pr = e.target.closest("[data-pg-toggle]");
      if (pr) {
        const row = pr.closest("[data-pg-row]");
        const wrapEl = pr.closest("[data-uid]");
        const node = wrapEl ? nodeByUid(wrapEl.dataset.uid) : null;
        const idx = Number(pr.getAttribute("data-pg-toggle"));
        const m = node && node.members ? node.members[idx] : null;
        if (m) {
          m.open = !m.open;
          // 人手动点过，就不再替他自动收起
          if (m.type === "think") m.auto = false;
          // 图片懒加载：只有真的展开才过桥取 base64，避免一次对话攒一堆大字符串
          if (m.open && m.imagePath && !m.imageData && Native && Native.imageData) {
            try { m.imageData = Native.imageData(m.imagePath) || ""; } catch (_) {}
          }
          patchNode(node);           // 展开时用当前完整正文重绘这一行
        } else if (row) {
          row.classList.toggle("is-open");
        }
        haptic("light");
        return;
      }
      const pcth = e.target.closest("[data-toggle-pcthink]");
      if (pcth) {
        const wrap = pcth.closest("[data-uid]");
        const node = wrap ? nodeByUid(wrap.dataset.uid) : null;
        if (node) { node.open = !node.open; haptic("light"); patchNode(node); }
        return;
      }
      const th = e.target.closest("[data-toggle-thinking]");
      if (th) { th.closest(".thinking").classList.toggle("is-open"); haptic("light"); }
      const pctItem = e.target.closest("[data-pc-tool-item]");
      if (pctItem) {
        const wrap = pctItem.closest("[data-uid]");
        const node = wrap ? nodeByUid(wrap.dataset.uid) : null;
        const item = node && node.items ? node.items[Number(pctItem.dataset.pcToolItem)] : null;
        if (item) {
          item.open = !item.open;
          node.open = true;          // 点里面的行，组本身当然要展开
          haptic("light");
          patchNode(node);           // 只重画这一组：整表重建会闪一下
        }
        return;
      }
      const pct = e.target.closest("[data-toggle-pctools]");
      if (pct) {
        const wrap = pct.closest("[data-uid]");
        const node = wrap ? nodeByUid(wrap.dataset.uid) : null;
        if (node) { node.open = !node.open; haptic("light"); patchNode(node); }
        return;
      }
      // present 交付卡片 / 文件行：Office 与文本走应用内预览
      const dfile = e.target.closest("[data-open-file]");
      if (dfile) {
        const path = dfile.getAttribute("data-open-file") || "";
        if (!path) return;
        haptic("light");
        openFilePreview(path);
        return;
      }
      // 对话气泡里的文件 chip：本地 dataUrl → 应用内预览（docx/pptx/xlsx/pdf/csv/json/代码/图片…）
      const fchip = e.target.closest("[data-file-chip]");
      if (fchip) {
        const url = fchip.getAttribute("data-url") || "";
        const name = fchip.getAttribute("data-name") || "附件";
        if (!url) { toast("该文件太大未随消息保留，请在文件页打开"); return; }
        haptic("light");
        const res = (Native && Native.previewLocal) ? Native.previewLocal(name, url) : "{}";
        let r = {};
        try { r = JSON.parse(res || "{}"); } catch (_) { r = { ok: false, error: "预览失败" }; }
        if (r && r.preview) { openSheet(sheetDocPreview(r)); return; }
        if (r && r.ok) return;
        toast("预览失败：" + (r && r.error ? r.error : name));
        return;
      }
      // 气泡里的图片：点开看大图
      const bigImg = e.target.closest("img.msg-img");
      if (bigImg && bigImg.src.startsWith("data:")) {
        haptic("light");
        const comma = bigImg.src.indexOf(",");
        const mime = bigImg.src.slice(5, bigImg.src.indexOf(";"));
        openSheet(sheetDocPreview({
          kind: "image", name: bigImg.alt || "图片", title: bigImg.alt || "图片",
          mime, data_base64: bigImg.src.slice(comma + 1), size: 0,
        }));
        return;
      }
      const fOpen = e.target.closest("[data-file-open]");
      if (fOpen) {
        openFilePreview(fOpen.getAttribute("data-file-open") || "");
        closeSheet();
        return;
      }
      // 预览面板里的「用其它应用打开」
      const fExt = e.target.closest("[data-file-external]");
      if (fExt) {
        const path = fExt.getAttribute("data-file-external") || "";
        // 长按菜单与预览面板共用这一段：先收起面板，选完应用直接切走，回来不带残留
        closeSheet();
        let res = "";
        try { res = path && Native && Native.externalOpen ? String(Native.externalOpen(path)) : ""; } catch (_) {}
        let r = null;
        try { r = JSON.parse(res || "{}"); } catch (_) { r = null; }
        // 原生失败时必须给出反馈：静默 return 就是"点了没反应"
        if (r && r.ok === false) toast(r.error || "打不开该文件");
        else if (!res) toast("当前环境不支持用外部应用打开");
        haptic("light");
        return;
      }
      const fDir = e.target.closest("[data-file-open-dir]");
      if (fDir) {
        state.fileCwd = fDir.getAttribute("data-file-open-dir") || ".";
        renderFiles();
        closeSheet();
        return;
      }
      const fShare = e.target.closest("[data-file-share]");
      if (fShare) {
        const path = fShare.getAttribute("data-file-share") || "";
        if (!(Native && Native.shareFile)) { toast("当前环境不支持分享文件"); return; }
        let res = { ok: false, error: "分享失败" };
        try { res = JSON.parse(Native.shareFile(path)); } catch (_) {}
        closeSheet();
        haptic("light");
        if (!res || !res.ok) toast("分享失败：" + ((res && res.error) || "未知原因"));
        return;
      }
      const fDel = e.target.closest("[data-file-del]");
      if (fDel) {
        const path = fDel.getAttribute("data-file-del") || "";
        let res = { ok: false, error: "当前环境不支持删除" };
        try { res = JSON.parse(Native.deleteWorkspace(path)); } catch (_) {}
        closeSheet();
        if (res && res.ok) { toast("已删除 " + path); renderFiles(); }
        else toast("删除失败：" + ((res && (res.error || res.output)) || "未知原因"));
        return;
      }
      const fDelAtt = e.target.closest("[data-file-del-att]");
      if (fDelAtt) {
        LocalFiles.remove(fDelAtt.getAttribute("data-file-del-att") || "");
        renderFiles();
        closeSheet();
        toast("已删除附件记录");
        return;
      }
      // 面包屑：点哪一级就回到哪一级
      const crumb = e.target.closest("[data-crumb-dir]");
      if (crumb) {
        state.fileCwd = crumb.getAttribute("data-crumb-dir") || ".";
        haptic("light");
        renderFiles();
        return;
      }
      // 文件行点击：目录进入、文件打开
      const fRow = e.target.closest("#filesList [data-file-kind]");
      if (fRow) {
        const kind = fRow.dataset.fileKind;
        const path = fRow.dataset.filePath || "";
        if (kind === "att") return;              // 附件只是记录，长按可删
        if (kind === "work" && fRow.querySelector(".job-tag")?.textContent === "DIR") {
          state.fileCwd = path;
          renderFiles();
          return;
        }
        if (path) {
          openFilePreview(path);
        }
        return;
      }
      // 联网搜索来源卡片：点开原文
      const su = e.target.closest("[data-open-url]");
      if (su) {
        const url = su.getAttribute("data-open-url") || "";
        if (url) {
          haptic("light");
          if (Native && Native.openExternal) { try { Native.openExternal(url); } catch (_) {} }
          else window.open(url, "_blank");
        }
      }

      // ask_user_question：点选项回传给内核
      const askOpt = e.target.closest("[data-ask-opt]");
      if (askOpt) {
        const raw = askOpt.getAttribute("data-ask-opt") || "";
        const sep = raw.indexOf("|");
        const askId = sep > 0 ? raw.slice(0, sep) : "";
        const label = sep > 0 ? raw.slice(sep + 1) : "";
        const node = NativeAgent.asks && NativeAgent.asks[askId];
        if (node) {
          node.answered = label;
          patchNode(node);
          delete NativeAgent.asks[askId];
        }
        if (Native && Native.agentAnswer) {
          try { Native.agentAnswer(Live.id || NativeAgent.id || "", askId, label); } catch (_) {}
        }
        haptic("medium");
        return;
      }
      // 模式条：点一下看详情/退出
      const mchip = e.target.closest("[data-mode-chip]");
      if (mchip) {
        haptic("light");
        openSheet(mchip.dataset.modeChip === "goal" ? sheetGoal() : sheetQuickActions());
        return;
      }

      // 计划卡片：批准 / 要求修改 / 结束
      const pact = e.target.closest("[data-plan-act]");
      if (pact) {
        const card = pact.closest("[data-plan-card]");
        const holder = card && card.closest("[data-uid]");
        const node = (holder && thread.find((n) => n.__uid === holder.dataset.uid)) || PlanReview.node;
        if (!node) return;
        const act = pact.dataset.planAct;
        if (act === "revise") {
          const box = card.querySelector("[data-plan-revise]");
          if (box) {
            box.hidden = !box.hidden;
            if (!box.hidden) { const ta = box.querySelector("textarea"); if (ta) ta.focus(); }
          }
          return;
        }
        if (act === "send-revise") {
          const ta = card.querySelector("[data-plan-revise] textarea");
          const fb = ((ta && ta.value) || "").trim();
          if (!fb) { toast("写点修改意见再提交"); return; }
          settlePlan(node, "revised", fb.slice(0, 300));
          return;
        }
        if (act === "approve" || act === "reject") {
          settlePlan(node, act === "approve" ? "approved" : "rejected");
        }
        return;
      }

      const acct = e.target.closest("[data-acct]");
      if (acct) {
        haptic("light");
        if (acct.dataset.acct === "login") Account.login();
        else if (acct.dataset.acct === "signout") Account.signOut();
        else if (acct.dataset.acct === "apply") Account.applyToModel();
        return;
      }

      const ap = e.target.closest("[data-approve]");
      if (ap) {
        const card = ap.closest("[data-approval]");
        const node = thread[thread.length - 1];
        // 轮次已终止（或原生侧已不在等确认）：卡片不能再点，明说本次确认无效。
        // 此前用户在请求框出现后终止对话，按钮仍可点 —— 确认会被丢给不存在的等待者。
        if (!NativeAgent.active || !Live.id || (node && node.kind === "approval" && node.resolved)) {
          card.classList.add("is-resolved");
          card.querySelector(".approval-actions").style.display = "none";
          const r = document.createElement("div");
          r.className = "approval-result";
          r.textContent = "对话已终止 · 本次确认无效";
          card.appendChild(r);
          return;
        }
        card.classList.add("is-resolved");
        card.querySelector(".approval-actions").style.display = "none";
        const result = document.createElement("div");
        result.className = "approval-result";
        const scope = ap.dataset.approve;   // deny / once / always
        // 「始终允许」的作用域跟着这件事走：绑了 Mission 的一轮记在那件事的 grants 里，
        // 说「记住本会话」会让用户以为整个会话都免问了。
        const bound = !!(node && node.missionId);
        result.textContent = scope === "deny"
          ? "已拒绝 · Agent 将换一种不会删除文件的做法"
          : scope === "always"
            ? (bound ? "已允许并记住这件事 · 命令执行中…" : "已允许并记住本会话 · 命令执行中…")
            : "已允许 · 命令执行中…";
        card.appendChild(result);
        haptic("medium");
        if (node && node.kind === "approval") { node.resolved = true; node.result = result.textContent; }
        // 原生内核在等这次确认：按 id 精确回传，避免串到别的调用。
        // always 走 agentApproveScope：无 Mission 的轮次记会话级授权，绑了 Mission 的记在那件事上。
        if (NativeAgent.active && Native && Native.agentApprove) {
          const apId = Object.keys(NativeAgent.approvals).find((k) => NativeAgent.approvals[k] === node);
          if (Native.agentApproveScope) Native.agentApproveScope(Live.id, apId || "", scope);
          else Native.agentApprove(Live.id, apId || "", scope !== "deny");
          delete NativeAgent.approvals[apId];
        }
      }
    });

    $("#chatScroll").addEventListener("scroll", () => {
      // 输入区常显，这里只用于后续可能的吸底逻辑
    });

    // 展开的思考正文自己滚（styles.css 给了高度上限）：用户往上翻过就别再自动贴底，
    // 否则一边往回看一边被新字拽下去。回到贴底位置后恢复跟随。
    $("#messages").addEventListener("scroll", (e) => {
      const el = e.target;
      // 思考正文与「工具实时输出」框同一套规矩：贴底跟随最新，用户上翻过就不动他
      if (!el || !el.classList ||
          (!el.classList.contains("pg-think-text") && !el.classList.contains("io-sec"))) return;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      if (atBottom) delete el.dataset.stick;
      else el.dataset.stick = "0";
    }, true);

    // 键盘：高度与 kb-open 统一由原生 IME inset 驱动（Android）。
    // 纯浏览器/无原生桥时用 visualViewport 兜底，避免两套逻辑互相打架。
    if (!Native && window.visualViewport) {
      const vv = window.visualViewport;
      const adjust = () => {
        const gap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        const open = gap > 40;
        document.documentElement.style.setProperty("--kb", open ? gap + "px" : "0px");
        document.documentElement.classList.toggle("kb-open", open);
      };
      vv.addEventListener("resize", adjust);
      vv.addEventListener("scroll", adjust);
    }

    // 调试/自动化入口：模式状态与模式面板（CDP 实测用）
    window.DSHModes = Modes;
    window.DSHPlugins = Plugins;
    window.DSHAccount = Account;
    window.DSHModesUI = {
      sync: syncModeBar,
      quick: () => openSheet(sheetQuickActions()),
      goal: () => openSheet(sheetGoal()),
      setPlan: (on) => { Modes.setPlan(on); openSheet(sheetQuickActions()); },
      thread: () => thread.map((n) => ({ kind: n.kind, status: n.status, title: n.title })),
      state: () => Modes.cur(),
      /** 调试入口：向内核事件渲染器注入一个事件（CDP 实测用） */
      inject: (ev) => { if (ev && ev.t) NativeAgent.on(ev); },
    };

    // expose status to native
    if (Native && Native.onReady) { try { Native.onReady(); } catch (_) {} }

    // 页面被系统回收后重载：内核这一轮还在跑，但新页面的 Live.id 已经丢了 —— 不重新认领，
    // 后续 delta 全被 `id !== Live.id` 丢掉，界面上就是「回复停在半路 / 像被终止了」。
    // 认领时还要把**已经流出去的那段**从内核快照补回来：只换个 id 的话气泡是空的，
    // 用户看到的仍然是一条被截断的回复（实测：退出应用再进来、息屏后再亮屏）。
    try {
      const act = (Native && Native.agentActive) ? JSON.parse(Native.agentActive() || "{}") : {};
      const runs = ((Array.isArray(act.runs) && act.runs.length ? act.runs : (act.id ? [act] : [])))
        .filter((r) => r && r.id && r.sessionId);
      // 先认领「用户正在看的这一场」：并行/团队时 map 的第一个不一定是它
      const mine = runs.find((r) => r.sessionId === state.sessionId) || runs[0];
      if (mine && LocalDB.get(mine.sessionId)) {
        state.sessionId = mine.sessionId;
        state.busy = true;
        openSession(mine.sessionId);     // 先把桶与界面落回这一场（还在跑的分支不会重建流）
        const got = claimRun(mine.sessionId);
        if (got) {
          toast(got.truncated ? "检测到正在进行的回复，已重新接入（前文过长，从截断处继续）"
            : "检测到正在进行的回复，已重新接入", 2600);
        }
      }
    } catch (_) {}

    // 在成员视图里被系统回收：重开至少回到那场团队自己的 Lead 会话，
    // 不要凭空停在一条空白新会话上（实测：成员视图里杀掉进程，再开 App 就是「新会话」，
    // 用户以为整支团队没了）。上面已经认领到在跑轮次时不插手，落点由它决定。
    // 注意开机时 state.sessionId 是占位 "s1"（不是空串），判定要按同一口径认它 = 没会话。
    if ((!state.sessionId || state.sessionId === "s1") && !state.busy) {
      try {
        const tv = JSON.parse(localStorage.getItem("dsh.teamView") || "null");
        const home = tv && tv.parent && LocalDB.get(tv.parent);
        if (home) {
          // 一次性消费：这条记录只描述「被回收那一刻正在看成员会话」。
          // 用完不删的话，下一次在别处被回收也会莫名其妙回到这场团队。
          localStorage.removeItem("dsh.teamView");
          openSession(home.id);
          toast(`上次你在看 ${tv.name} 的会话；已带回它的 Lead 对话，队友进度在团队面板里`, 3600);
        }
      } catch (_) {}
    }
    // 记忆条目计数
    refreshMemCount();
    syncModeBar();

    // 权限：同步状态；首次启动且麦克风未授权时弹一次引导
    if (Native && Native.getPermissionState) {      permSync();
      permPrimerOnce();
      // 从系统设置返回时刷新授权状态
      document.addEventListener("visibilitychange", () => { if (!document.hidden) permSync(); });
    }

    // 首次启动引导（模型没就绪才弹；配好 key / 选过「先逛逛」就再也不见）
    setTimeout(maybeOnboard, 600);
  }

  document.addEventListener("DOMContentLoaded", init);

  /* 原生工具执行结果回传：Kernel.call 注册的回调在这里结算 */
  if (window.DSHHost) {
    const needRuntimeShown = new Set();
    window.DSHHost.onToolResult = (id, json) => {
      // NEED_RUNTIME 协议（KernelRuntime.needRuntime）：全部内置方案下没有下载卡片，
      // 这里只做一次性说明 —— 首行 NEED_RUNTIME:<runtime>，次行起是原因
      try {
        const r0 = JSON.parse(json || "{}");
        const m = r0 && r0.error && /^NEED_RUNTIME:(\S+)/m.exec(r0.error);
        if (m && !needRuntimeShown.has(m[1])) {
          needRuntimeShown.add(m[1]);
          const why = r0.error.split("\n").slice(1).join(" ").trim();
          toast(`${m[1]} 运行环境不可用：${why}`, 5200);
        }
      } catch (_) {}
      const f = Kernel._waits[id];
      if (!f || typeof f !== "function") return;
      let r;
      try { r = JSON.parse(json || "{}"); } catch (_) { r = { ok: false, error: "工具结果解析失败" }; }
      f(r);
    };
    /* 异步语音合成回传：VoiceBubble.doSynth 注册的等待在这里结算 */
    window.DSHHost.onSynth = (id, json) => {
      const w = (typeof VoiceBubble !== "undefined" && VoiceBubble.synthWaits) || null;
      if (!w || !w[id]) return;
      const f = w[id];
      delete w[id];
      let r;
      try { r = JSON.parse(json || "{}"); } catch (_) { r = { ok: false, error: "合成结果解析失败" }; }
      f(r);
    };
  }

  /* ---------------- 用户语音条回放 ----------------
     录音存在 cacheDir/voice-in/ 里，点一次才读成 data URL 播放一次 ——
     不把 base64 常驻在消息节点里（10 秒就 320KB，会话一长就是内存灾难）。 */
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-vclip]");
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    let d = {};
    try {
      d = JSON.parse((Native && Native.voiceClipData ? Native.voiceClipData(b.dataset.vclip) : "{}") || "{}");
    } catch (_) {}
    if (!d.dataUrl) { toast("这段录音已不在缓存里"); return; }
    // 同时只放一条：再点别的先把上一条停掉
    if (state.__vclip) { try { state.__vclip.pause(); } catch (_) {} }
    const a = new Audio(d.dataUrl);
    state.__vclip = a;
    b.classList.add("is-playing");
    const done = () => b.classList.remove("is-playing");
    a.onended = done;
    a.onerror = done;
    a.play().catch(() => { done(); toast("播放失败"); });
    haptic("light");
  });
})();
