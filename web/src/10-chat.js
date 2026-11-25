  const HL_ALIAS = {
    js: "ts", jsx: "ts", tsx: "ts", typescript: "ts", javascript: "ts", node: "ts",
    py: "python", py3: "python", sh: "bash", shell: "bash", zsh: "bash", console: "bash",
    kts: "kotlin", kt: "kotlin", cs: "csharp", csharp: "csharp", cpp: "cpp", "c++": "cpp",
    cc: "cpp", hpp: "cpp", h: "cpp", c: "c", go: "go", rs: "rust", rust: "rust",
    yml: "yaml", tf: "hcl", dockerfile: "docker", makefile: "make",
    json: "json", jsonc: "json", sql: "sql", hcl: "hcl", docker: "docker", make: "make",
  };
  const HL_KW = {
    ts: "const let var function return if else for while do switch case break continue new class extends super this typeof instanceof in of await async yield try catch finally throw import export from default null undefined true false void delete enum interface type namespace public private protected static readonly get set constructor as".split(" "),
    python: "def class return if elif else for while import from as try except finally raise with lambda yield pass break continue global nonlocal assert del in is not and or None True False self async await print".split(" "),
    bash: "if then else elif fi for in do done while case esac function return export local set unset source echo cd exit read declare".split(" "),
    kotlin: "fun val var return if else for while when class object interface data sealed open override public private protected internal abstract suspend lateinit import package null true false this super get set constructor companion".split(" "),
    java: "public private protected class interface enum void return if else for while switch case break continue new import package static final this super extends implements throws try catch finally null true false int long double float boolean char byte short".split(" "),
    go: "func var const return if else for range switch case break continue defer go chan map struct interface import package type nil true false select".split(" "),
    rust: "fn let mut return if else for while loop match struct enum impl trait pub use mod const static ref move async await where dyn Self true false continue break".split(" "),
    c: "int char float double void return if else for while switch case break continue struct typedef static const sizeof unsigned signed long short enum union goto".split(" "),
    cpp: "int char float double void return if else for while switch case break continue struct class public private protected static const virtual template typename namespace using new delete this sizeof unsigned signed long short bool true false nullptr".split(" "),
    csharp: "using namespace class public private protected internal static void return if else for foreach while switch case break continue new int string bool var async await try catch finally null true false struct enum interface".split(" "),
    json: "true false null".split(" "),
    yaml: [], sql: "select from where insert update delete create table join on group by order limit as and or not null true false into values set distinct having union all".split(" "),
    hcl: "resource variable provider data module output locals true false null".split(" "),
    docker: "FROM RUN CMD LABEL EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL".split(" "),
    make: "ifdef ifndef ifeq ifneq else endif include define endef".split(" "),
  };
  const HL_CM = {
    ts: "//", python: "#", bash: "#", kotlin: "//", java: "//", go: "//", rust: "//", c: "//", cpp: "//", csharp: "//", json: "", yaml: "#", sql: "--", hcl: "#", docker: "#", make: "#",
  };
  const HL_BLOCK = {
    ts: "/*", python: "", bash: "", kotlin: "/*", java: "/*", go: "/*", rust: "/*", c: "/*", cpp: "/*", csharp: "/*", json: "", yaml: "", sql: "", hcl: "", docker: "", make: "",
  };
  function highlight(src, lang) {
    let id = (lang || "").toLowerCase().trim();
    id = HL_ALIAS[id] || id;
    if (!HL_KW[id]) return src;
    const kw = new Set(HL_KW[id]);
    const lineCm = HL_CM[id], blockCm = HL_BLOCK[id];
    const t = src, n = t.length;
    let out = "", i = 0;
    const isIdStart = (c) => (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_" || c === "$";
    const isId = (c) => isIdStart(c) || (c >= "0" && c <= "9");
    const QUOT = /^(?:&quot;|&#39;)/;
    while (i < n) {
      const rest = t.slice(i);
      if (lineCm && rest.startsWith(lineCm)) {
        let j = t.indexOf("\n", i); if (j < 0) j = n;
        out += "<span class='tok-cm'>" + t.slice(i, j) + "</span>"; i = j; continue;
      }
      if (blockCm && rest.startsWith(blockCm)) {
        let j = t.indexOf("*/", i); if (j < 0) j = n; else j += 2;
        out += "<span class='tok-cm'>" + t.slice(i, j) + "</span>"; i = j; continue;
      }
      const qm = rest.match(QUOT);
      if (qm) {
        const q = qm[0]; let j = i + q.length;
        while (j < n) {
          if (t[j] === "\\") { j += 2; continue; }
          if (t.startsWith(q, j)) { j += q.length; break; }
          j++;
        }
        out += "<span class='tok-str'>" + t.slice(i, j) + "</span>"; i = j; continue;
      }
      if (t[i] >= "0" && t[i] <= "9" && !(i > 0 && isId(t[i - 1]))) {
        let j = i + 1; while (j < n && /[0-9a-fA-FxXob._]/.test(t[j])) j++;
        out += "<span class='tok-num'>" + t.slice(i, j) + "</span>"; i = j; continue;
      }
      if (isIdStart(t[i])) {
        let j = i + 1; while (j < n && isId(t[j])) j++;
        const w = t.slice(i, j);
        let k = j; while (k < n && (t[k] === " " || t[k] === "\t")) k++;
        if (kw.has(w)) out += "<span class='tok-kw'>" + w + "</span>";
        else if (t[k] === "(") out += "<span class='tok-fn'>" + w + "</span>";
        else out += w;
        i = j; continue;
      }
      out += t[i]; i++;
    }
    return out;
  }

  /* ---------------- 数学公式（本地懒加载 KaTeX，对齐桌面） ----------------
     文本先经 esc() 转义（& < > " ' 变实体），公式定界符内的原始 TeX 需还原后再喂给 KaTeX。
     仅在「完整定界符」出现时才生成占位符 <span class="math" data-display data-tex>；
     不完整的流式 TeX 保持原文 —— 这样流式过程中不会闪红错误，闭合后才升级为公式。
     代码块（```）由 md() 单独走 highlight()，不进 inline()，故公式不会污染代码。 */
  const MATH_RE = /\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$|\$(?![0-9\s])((?:\\.|[^$\n])+?)\$(?!\d)/g;
  function unescapeTex(s) {
    return s
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  }
  function escAttr(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function md(src) {
    const lines = esc(src).split("\n");
    const out = [];
    let i = 0;
    let list = null;
    const flushList = () => {
      if (!list) return;
      out.push(`<${list.type}>${list.items.map((t) => {
        const task = list.type === "ul" ? t.match(/^\[([ xX])\]\s+([\s\S]*)$/) : null;
        if (task) {
          const done = task[1].toLowerCase() === "x";
          return `<li class="task ${done ? "done" : ""}"><span class="task-box"></span><span>${inline(task[2])}</span></li>`;
        }
        return `<li>${inline(t)}</li>`;
      }).join("")}</${list.type}>`);
      list = null;
    };
    const cells = (l) => l.replace(/^\||\|$/g, "").split("|").map((s) => s.trim());

    while (i < lines.length) {
      const line = lines[i];

      // 代码块（流式中未闭合也要正常显示）
      if (/^```/.test(line.trim())) {
        flushList();
        const lang = line.trim().slice(3).trim();
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
        if (i < lines.length) i++;
        out.push(`<div class="code-wrap"><pre class="code"${lang ? ` data-lang="${esc(lang)}"` : ""}><code>${highlight(buf.join("\n"), lang)}</code></pre>` +
          `<button class="code-copy" data-copy-code aria-label="复制代码"><svg class="ico"><use href="#i-copy"/></svg></button></div>`);
        continue;
      }

      // 块级数学公式围栏 $$ ... $$（多行；单行 $$ 由下方 inline 处理）
      if (/^\s*\$\$\s*$/.test(line.trim())) {
        flushList();
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*\$\$\s*$/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
        if (i < lines.length) i++;
        const texEsc = buf.join("\n");
        out.push(`<div class="math-block"><span class="math" data-display="1" data-tex="${escAttr(unescapeTex(texEsc))}">${texEsc}</span></div>`);
        continue;
      }

      // 标题
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        flushList();
        const lv = Math.min(h[1].length + 1, 4);
        out.push(`<h${lv} class="md-h">${inline(h[2])}</h${lv}>`);
        i++;
        continue;
      }

      // 分隔线
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
        flushList();
        out.push('<hr class="md-hr">');
        i++;
        continue;
      }

      // 引用（esc 之后 > 已变成 &gt;）
      if (/^(&gt;|>)\s?/.test(line)) {
        flushList();
        const buf = [];
        while (i < lines.length && /^(&gt;|>)\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^(&gt;|>)\s?/, ""));
          i++;
        }
        out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`);
        continue;
      }

      // 表格：表头 + 分隔行
      if (line.includes("|") && i + 1 < lines.length && /^[\s|:-]*-[\s|:-]*$/.test(lines[i + 1])) {
        flushList();
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|")) { rows.push(cells(lines[i])); i++; }
        out.push(
          `<div class="md-table-wrap"><table class="md-table"><thead><tr>${
            head.map((c) => `<th>${inline(c)}</th>`).join("")
          }</tr></thead><tbody>${
            rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")
          }</tbody></table></div>`
        );
        continue;
      }

      // 有序 / 无序列表
      const ul = line.match(/^\s*([-*•])\s+(.*)$/);
      const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
      if (ul || ol) {
        const type = ul ? "ul" : "ol";
        if (list && list.type !== type) flushList();
        if (!list) list = { type, items: [] };
        list.items.push(ul ? ul[2] : ol[2]);
        i++;
        continue;
      }

      // 空行
      if (!line.trim()) { flushList(); i++; continue; }

      // 段落
      flushList();
      const buf = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^(#{1,4}\s|```|&gt;|>|\s*[-*•]\s|\s*\d+[.)]\s)/.test(lines[i]) &&
        !lines[i].includes("|")
      ) { buf.push(lines[i]); i++; }
      out.push(`<p>${inline(buf.join("<br>"))}</p>`);
    }
    flushList();
    return out.join("");
  }
  function inline(s) {
    // 先抽离数学公式，用占位符保护，避免加粗/斜体/链接等规则改写到公式内部
    const mathSlots = [];
    s = s.replace(MATH_RE, (m, g1, g2, g3, g4) => {
      const tex = g1 || g2 || g3 || g4;
      const display = !!(g2 || g3);
      const raw = unescapeTex(tex);
      mathSlots.push(`<span class="math" data-display="${display ? 1 : 0}" data-tex="${escAttr(raw)}">${tex}</span>`);
      return "\u0000M" + (mathSlots.length - 1) + "\u0000";
    });
    s = s
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img class="md-img" alt="$1" src="$2" loading="lazy" onerror="this.classList.add(\'is-broken\')">')
      // 链接只放行 http(s)/mailto/页内锚点：javascript: 不会触发 shouldOverrideUrlLoading，
      // 会在应用 origin 里直接执行（桥有完整内核权限），必须在渲染层就掐掉
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, href) =>
        /^(?:https?:\/\/|mailto:|#)/i.test(href)
          ? `<a href="${href}" target="_blank" rel="noreferrer">${text}</a>`
          : text)
      .replace(/~~([^~]+)~~/g, "<del>$1</del>");
    // 还原公式占位符
    s = s.replace(/\u0000M(\d+)\u0000/g, (mm, i) => mathSlots[+i]);
    return s;
  }

  /* ---------------- KaTeX 懒加载与渲染 ----------------
     首次遇到 .math 才注入 katex.min.css/js（本地资源，相对页面同目录的 katex/）。
     渲染走 MutationObserver：任意落 DOM 的公式占位符出现即升级，覆盖流式/首屏/历史/hydrate。
     带渲染缓存：同一公式（display+tex）只算一次，避免流式逐 token 重渲染时闪动。 */
  let _katexReady = null;
  const _katexCache = new Map();
  let _mathRaf = 0;
  function ensureKatex() {
    if (window.katex) return Promise.resolve();
    if (_katexReady) return _katexReady;
    _katexReady = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "katex/katex.min.css";
      document.head.appendChild(css);
      const js = document.createElement("script");
      js.src = "katex/katex.min.js";
      js.onload = () => resolve();
      js.onerror = () => reject(new Error("katex load failed"));
      document.head.appendChild(js);
    });
    return _katexReady;
  }
  function renderMath(root) {
    const host = root || document.getElementById("messages");
    if (!host) return;
    const nodes = host.querySelectorAll(".math:not(.math-done)");
    if (!nodes.length) return;
    ensureKatex().then(() => {
      nodes.forEach((el) => {
        if (el.classList.contains("math-done")) return;
        const tex = el.getAttribute("data-tex");
        if (tex == null) { el.classList.add("math-done"); return; }
        const display = el.getAttribute("data-display") === "1";
        const key = (display ? "1|" : "0|") + tex;
        let html = _katexCache.get(key);
        if (html === undefined) {
          try {
            html = window.katex.renderToString(tex, { displayMode: display, throwOnError: false });
          } catch (e) {
            html = null;
          }
          _katexCache.set(key, html);
        }
        if (html == null) { el.classList.add("math-done", "math-error"); return; }
        el.innerHTML = html;
        el.classList.add("math-done");
      });
    }).catch(() => {});
  }
  function scheduleMathRender(root) {
    if (_mathRaf) return;
    _mathRaf = requestAnimationFrame(() => { _mathRaf = 0; renderMath(root); });
  }
  let _mathObs = null;
  function initMathObserver() {
    if (_mathObs) return;
    const host = document.getElementById("messages");
    if (!host) return;
    _mathObs = new MutationObserver((muts) => {
      let dirty = false;
      for (const m of muts) {
        if (m.type !== "childList") continue;
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.classList && node.classList.contains("math")) { dirty = true; break; }
          if (node.querySelector && node.querySelector(".math")) { dirty = true; break; }
        }
        if (dirty) break;
      }
      if (dirty) scheduleMathRender(host);
    });
    _mathObs.observe(host, { childList: true, subtree: true });
  }


  /* ---------------- haptics / toast ---------------- */
  function haptic(kind = "light") {
    // 一次手势只出一记触感：按钮 handler 与 openSheet()/动画回调经常各自 tick 一次
    // （点击「＋」= handler 一记 + 面板弹出一记 = 用户感到「振两下」），80ms 内的
    // 第二记合并掉；窗口小到不会吞有意的连续节奏。
    const now = Date.now();
    if (now - (haptic._lastAt || 0) < 80) return;
    haptic._lastAt = now;
    if (Native && Native.haptic) { try { Native.haptic(kind); return; } catch (_) {} }
    if (navigator.vibrate) navigator.vibrate(kind === "heavy" ? 18 : 8);
  }
  let toastTimer;
  function toast(msg, ms) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("is-on"), ms || 2400);
  }

  /* ---------------- theme ---------------- */
  function applyTheme() {
    document.documentElement.dataset.theme = state.theme;
    const dark = state.theme === "dark";
    $('meta[name="theme-color"]').setAttribute("content", dark ? "#000000" : "#F2F2F7");
    const sw = $("#swDark");
    if (sw) sw.checked = dark;
    if (Native && Native.setSystemBars) { try { Native.setSystemBars(dark); } catch (_) {} }
  }

  // 原生壳通过 ?theme= 传入系统外观，仅在用户尚未手动选择时生效
  (function initialTheme() {
    const qs = new URLSearchParams(location.search).get("theme");
    if (qs && !localStorage.getItem("dsh.theme")) state.theme = qs;
  })();

  /* ---------------- 会话列表：置顶 / 最近 / 工作区 ----------------
     桌面端侧栏是「置顶 → 各工作区」；手机上屏幕窄，改成三段：
       置顶       = 手动置顶的会话（平铺）
       最近       = 未置顶里最近更新的 3 条（快速回到手上正在做的事；只是快捷入口，不搬走会话）
       工作区     = **全部未删除的会话**按工作区分组，同一工作区默认堆叠，点开才列出来 */
  const WORKSPACES = [
    { id: "harness", name: "harness", desc: "git main · 工作区根目录" },
    { id: "ui", name: "ui-layout", desc: "packages/client/ui-layout" },
    { id: "home", name: "主目录", desc: "~/projects" },
  ];
  const DEFAULT_WS = "harness";
  const wsId = (id) => id || DEFAULT_WS;
  /** 会话上记的工作区 → 展示用的条目；未知 id（宿主机带来的）原样显示，不丢会话 */
  function wsEntry(id) {
    const key = wsId(id);
    return WORKSPACES.find((w) => w.id === key) || { id: key, name: key, desc: "会话工作区" };
  }
  /** 工作区展开/收起：记住用户的选择，重开应用还是他上次看到的形态 */
  const WsState = {
    KEY: "dsh.wsOpen",
    read() {
      try { const v = JSON.parse(localStorage.getItem(this.KEY) || "{}"); return v && typeof v === "object" ? v : {}; }
      catch (_) { return {}; }
    },
    open(id) { return !!this.read()[wsId(id)]; },
    set(id, v) {
      const m = this.read();
      m[wsId(id)] = !!v;
      try { localStorage.setItem(this.KEY, JSON.stringify(m)); } catch (_) {}
    },
    toggle(id) {
      const m = this.read();
      m[wsId(id)] = !m[wsId(id)];
      try { localStorage.setItem(this.KEY, JSON.stringify(m)); } catch (_) {}
      return m[wsId(id)];
    },
  };

  /* ---------------- 会话行左滑：置顶 / 重命名 / 删除 ---------------- */
  const SESS_ACT_W = 214;          // 右滑露出的操作区宽度（4 圆钮 + 间距 + 内边距）
  let sessSwipe = null;
  let lastSwipeAt = 0;

  /**
   * 动效 v2 小工具（P2 专用，局部引用 window.Motion）：
   * Motion 逐帧写 transform/opacity 的元素上，CSS 的过渡/动画必须摘掉 —— 否则浏览器
   * 会把每一帧再补间一次（拖起来发粘、落位过冲）。styles.css 的「动效 v2」段会做同样
   * 的事，这里兜一道，保证面板/浮窗/左滑单独也能跑对。
   */
  function p2Own(el, killAnim) {
    if (!el) return el;
    try { el.style.transition = "none"; } catch (_) {}
    if (killAnim) { try { el.style.animation = "none"; } catch (_) {} }
    return el;
  }

  /** 已滑开的行收回：走弹簧（不再靠 CSS 过渡落位），落定后再交给 is-swiped 类名 */
  function closeSwipedRow(except) {
    const M = window.Motion;
    const modern = !!(M && !M.legacy);
    $$("#sessionsScroll .sess-row").forEach((r) => {
      if (r === except) return;
      const item = r.querySelector(".session-item");
      const open = r.classList.contains("is-swiped") || !!(item && item.style.transform);
      if (!open) return;
      if (!modern || !item) { r.classList.remove("is-swiped"); return; }
      // 不先 stop：springTo 会从当前值和当前速度接管，动画天然可打断
      M.springTo(item, { x: 0 }, {
        preset: "press",
        onComplete: () => {
          r.classList.remove("is-swiped", "is-dragging");
          M.clear(item);
        },
      });
    });
  }

  /** 手指横滑超过 8px 才认成滑动，竖滑交给列表滚动，不动行 */
  function bindSessionSwipe() {
    const M = window.Motion;
    const modern = !!(M && !M.legacy);
    const sc = $("#sessionsScroll");
    if (!sc || sc.__swipeBound) return;
    sc.__swipeBound = true;

    /* ---------------- 动效 v2：跟手（橡皮筋）+ 速度判定 + 弹簧落位 ---------------- */
    if (modern) {
      let g = null;      // 本次手势
      let gy = 0;        // 行当前位移（含越界橡皮筋）

      // 松手结算：位移与速度一起判。落定后才切类名、清内联（顺序反过来会闪一帧原位）。
      const settle = (s, vx) => {
        if (!s) return;
        if (!s.moved) { s.row.classList.remove("is-dragging"); return; }
        // 关着：越过 40% 或向左快扫 → 开；已经开着：回到 40% 以内或向右快扫 → 关
        const open = s.base < 0
          ? !(gy > -SESS_ACT_W * 0.6 || vx > 0.3)
          : (gy < -SESS_ACT_W * 0.4 || vx < -0.3);
        lastSwipeAt = Date.now();
        M.springTo(s.item, { x: open ? -SESS_ACT_W : 0 }, {
          preset: "press",
          velocity: { x: (vx || 0) * 1000 },
          onComplete: () => {
            s.row.classList.toggle("is-swiped", open);
            s.row.classList.remove("is-dragging");
            M.clear(s.item);
          },
        });
      };

      M.drag(sc, {
        axis: "x",
        threshold: 8,
        capture: false,                  // 不在滚动容器上抓指针：纵向滚动仍归 WebView
        filter: (e) => !!e.target.closest(".sess-row") && !e.target.closest(".sess-act"),
        onDown: (e) => {
          const row = e.target.closest(".sess-row");
          const item = row ? row.querySelector(".session-item") : null;
          g = null;
          if (!row || !item) return;
          gy = row.classList.contains("is-swiped") ? -SESS_ACT_W : 0;
          g = { row, item, base: gy, y0: e.clientY, moved: false };
        },
        onStart: () => {
          if (!g) return;
          g.row.classList.add("is-dragging");   // 拖动期间吃掉 .session-item 的 CSS 过渡
          closeSwipedRow(g.row);                // 同时只允许开一行
        },
        onMove: ({ dx, raw }) => {
          if (!g) return;
          let tx = g.base + dx;
          // 越界橡皮筋：只在本行合法区间 [-214, 0] 之外生效，系数 0.15、最多 14px
          if (tx < -SESS_ACT_W) tx = Math.max(-SESS_ACT_W - 14, -SESS_ACT_W + (tx + SESS_ACT_W) * 0.15);
          else if (tx > 0) tx = Math.min(14, tx * 0.15);
          gy = tx;
          g.moved = true;
          M.set(g.item, { x: tx });
          lastSwipeAt = Date.now();
        },
        onEnd: ({ vx }) => {
          const s = g;
          g = null;
          settle(s, vx);
        },
        // 被系统取消也按已经滑出的位移结算，不能直接弹回原位
        onCancel: ({ vx }) => {
          const s = g;
          g = null;
          settle(s, vx);
        },
      });

      sc.addEventListener("scroll", () => {
        // 列表一滚，所有半开状态全部收起（含动画进行中的内联位移）
        $$("#sessionsScroll .sess-row").forEach((r) => {
          if (r.classList.contains("is-swiped")) return;
          const item = r.querySelector(".session-item");
          if (!item) return;
          if (item.style.transform) {
            M.springTo(item, { x: 0 }, {
              preset: "press",
              onComplete: () => { r.classList.remove("is-dragging"); M.clear(item); },
            });
          } else if (r.classList.contains("is-dragging")) {
            r.classList.remove("is-dragging");
          }
        });
      }, { passive: true });
      // 点空白处收起已经滑开的行
      sc.addEventListener("pointerdown", (e) => {
        if (!e.target.closest(".sess-row")) closeSwipedRow(null);
      }, { passive: true });
      return;
    }

    /* ---------------- 旧行为（window.Motion 缺失或 ?motion=legacy） ---------------- */
    sc.addEventListener("pointerdown", (e) => {
      const row = e.target.closest(".sess-row");
      if (!row || e.target.closest(".sess-act")) { sessSwipe = null; return; }
      sessSwipe = {
        row,
        x0: e.clientX, y0: e.clientY,
        base: row.classList.contains("is-swiped") ? -SESS_ACT_W : 0,
        dx: 0, active: false,
      };
    }, { passive: true });

    // 必须非 passive：一旦浏览器接管手势，就会发 pointercancel 把行弹回去（表现就是「弹一下」）。
    // 认成横滑后 eat 掉默认行为，手势留给这一行。
    sc.addEventListener("pointermove", (e) => {
      const s = sessSwipe;
      if (!s) return;
      const dx = e.clientX - s.x0, dy = e.clientY - s.y0;
      if (!s.active) {
        if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy)) return;
        s.active = true;
        s.row.classList.add("is-dragging");
        closeSwipedRow(s.row);
      }
      if (e.cancelable) e.preventDefault();
      s.dx = dx;
      const tx = Math.max(-SESS_ACT_W - 14, Math.min(0, s.base + dx));
      const item = s.row.querySelector(".session-item");
      if (item) item.style.transform = `translateX(${tx}px)`;
      lastSwipeAt = Date.now();
    }, { passive: false });

    const settle = (cancelled) => {
      const s = sessSwipe;
      sessSwipe = null;
      if (!s || !s.active) return;
      s.row.classList.remove("is-dragging");
      const item = s.row.querySelector(".session-item");
      if (item) item.style.transform = "";
      // 被系统取消也要按已经滑出的位移结算，不能直接弹回原位
      const moved = s.base + s.dx;
      s.row.classList.toggle("is-swiped", moved < -SESS_ACT_W / 2.4);
      lastSwipeAt = Date.now();
    };
    sc.addEventListener("pointerup", () => settle(false), { passive: true });
    sc.addEventListener("pointercancel", () => settle(true), { passive: true });
    sc.addEventListener("scroll", () => {
      // 列表一滚，所有半开状态全部收起（含残留的内联位移）
      $$("#sessionsScroll .sess-row").forEach((r) => {
        if (r.classList.contains("is-swiped")) return;
        const item = r.querySelector(".session-item");
        if (item) item.style.transform = "";
        r.classList.remove("is-dragging");
      });
    }, { passive: true });
    // 点空白处收起已经滑开的行
    sc.addEventListener("pointerdown", (e) => {
      if (!e.target.closest(".sess-row")) closeSwipedRow(null);
    }, { passive: true });
  }

  /* ---------------- sessions ---------------- */
  /**
   * 电脑端会往会话里写一批「给模型看的」注入内容，它们不是人说的话：
   * 运行时上下文、时区采样、system-reminder、切模型提示。手机端要按对话流显示，
   * 就得把这些剔除，否则一条注入能顶满一屏。
   */
  function isInjectedUserText(text) {
    const t = String(text || "").trim();
    if (!t) return true;
    if (/^<(system-reminder|user_info|additional-data)/i.test(t)) return true;
    if (/^(Current runtime context|Time sampled while preparing)/i.test(t)) return true;
    if (/^Browser time zone for this request/i.test(t)) return true;
    if (/^\[model changed:/i.test(t)) return true;
    if (/^step \d+\.\s*\d{4}-/.test(t)) return true;
    return false;
  }

  /** 参数压成一行摘要：电脑端也是这个思路，太长就截断 */
  function toolMetaOf(args) {
    if (args === null || args === undefined) return "";
    if (typeof args === "string") {
      // 流式工具调用的参数常是 JSON 字符串：先解析，行上才显示得成「路径」而不是
      // 一整串 {"path":"..."}（桌面那行就是这样显示的）
      const s = args.trim();
      if (s[0] === "{" || s[0] === "[") { try { return toolMetaOf(JSON.parse(s)); } catch (_) {} }
      return pageClip(args, 48);
    }
    try {
      const first = Array.isArray(args) ? args[0] : args;
      if (first && typeof first === "object") {
        // present 的参数是一串文件：摘要给第一个文件名，而不是 "files: [object Object]"
        if (Array.isArray(first.files) && first.files.length) {
          const f0 = first.files[0];
          const p = typeof f0 === "string" ? f0 : String((f0 && (f0.path || f0.name)) || "");
          return pageClip(p + (first.files.length > 1 ? ` 等 ${first.files.length} 个` : ""), 60);
        }
        const prefer = ["path", "pattern", "command", "query", "url", "file", "target"];
        for (const key of prefer) if (first[key]) return pageClip(String(first[key]), 60);
        const key = Object.keys(first)[0];
        if (key) return pageClip(key + ": " + String(first[key]), 60);
      }
      return pageClip(String(first), 60);
    } catch (_) { return ""; }
  }

  /** 电脑上 present 的参数 → 交付文件列表（对象或 JSON 字符串都认，条目可为路径字符串） */
  function presentFilesOf(args) {
    let a = args;
    if (typeof a === "string") { try { a = JSON.parse(a); } catch (_) { return []; } }
    if (!a) return [];
    const raw = Array.isArray(a) ? a : (Array.isArray(a.files) ? a.files : (a.files ? [a.files] : []));
    return raw.map((f) => {
      if (typeof f === "string") return { path: f, name: f.split(/[\\/]/).pop() || f };
      if (!f || typeof f !== "object") return null;
      const path = String(f.path || f.file || f.name || "");
      if (!path) return null;
      return {
        path,
        name: String(f.name || path.split(/[\\/]/).pop() || path),
        description: String(f.description || ""),
      };
    }).filter(Boolean);
  }

  /* 会话主列表里的「电脑」分区。
     配对之后电脑上的会话就是这个列表里的一组，而不是藏在「更多 → 电脑会话」里 ——
     否则人只会记得"连上了"，却不知道连上之后到底有什么。 */
  let pcCache = [];

  function pcRow(s) {
    const title = s.title || (s.cwd ? String(s.cwd).split(/[\\/]/).pop() : "未命名会话");
    const when = s.updatedAt ? fmtWhen(s.updatedAt) : "";
    const letter = (title.trim()[0] || "P").toUpperCase();
    // 副标题用目录名：每行都写「电脑上的会话」等于什么都没说
    const where = s.cwd ? String(s.cwd).split(/[\\/]/).filter(Boolean).pop() : "";
    // 和「工作区」里那套完全同一张卡片：.sess-row 包一层（左滑位留给以后），
    // .session-item.in-ws 走组内缩进与小头像 —— 行高、字号、间距都与本机一致
    return `
      <div class="sess-row">
        <button class="session-item in-ws" data-pc-open="${esc(s.id)}" data-pc-title="${esc(title)}">
          <span class="s-avatar-wrap">
            ${s.running ? '<span class="s-live-dot" aria-label="运行中"></span>' : ""}
            <span class="s-avatar p2">${esc(letter)}</span>
          </span>
          <span class="s-main">
            <span class="s-title-row">
              <span class="s-title">${esc(title)}</span>
              <span class="s-time">${esc(when)}</span>
            </span>
            <span class="s-sub">${s.running ? "电脑上正在运行" : esc(where || "电脑上的会话")}</span>
          </span>
        </button>
      </div>`;
  }

  /** 电脑会话的展开状态：单独存，不占用工作区那份（wsId 会把未知 key 归一化到默认工作区） */
  const PcState = {
    KEY: "dsh.pcOpen",
    open: () => localStorage.getItem(PcState.KEY) === "1",
    toggle() {
      const next = !PcState.open();
      try { localStorage.setItem(PcState.KEY, next ? "1" : "0"); } catch (_) {}
      return next;
    },
  };

  /* 一个电脑就是一堆会话，所以这里照工作区的做法做成可折叠组：
     组头写主机名与条数，展开才铺开会话行。 */
  function pcGroupHTML(rows) {
    const st = Link.state();
    const open = PcState.open();
    const latest = rows[0] || {};
    const openText = `${rows.length} 个会话`;
    const closedText = `${rows.length} 个会话 · 最近 ${latest.title || "新会话"}`;
    return `
      <div class="ws-group ${open ? "is-open" : "is-stacked"}" data-pc-group="1">
        <button class="ws-head" data-pc-toggle="1" aria-expanded="${open}">
          <span class="ws-ico"><svg class="ico sm"><use href="#i-cpu"/></svg></span>
          <span class="ws-main">
            <span class="ws-name">${esc(st.host || "电脑")}</span>
            <span class="ws-meta" data-open-text="${esc(openText)}" data-closed-text="${esc(closedText)}">${esc(open ? openText : closedText)}</span>
          </span>
          <span class="ws-count">${rows.length}</span>
          <svg class="ico chev"><use href="#i-chevron"/></svg>
        </button>
        <div class="ws-body"${open ? ' style="max-height:none;opacity:1"' : ""}><div class="ws-body-in">${pcWorkspaceHTML(rows)}</div></div>
      </div>`;
  }

  /** 电脑上的会话按工作区分组（和桌面端一致）：组的顺序按各自最新一条排 */
  function pcWorkspaceHTML(rows) {
    const byCwd = new Map();
    for (const s of rows) {
      const cwd = String(s.cwd || "");
      if (!byCwd.has(cwd)) byCwd.set(cwd, []);
      byCwd.get(cwd).push(s);
    }
    const groups = [...byCwd.entries()].map(([cwd, list]) => ({ cwd, list }));
    groups.sort((a, b) => Math.max(...b.list.map((x) => x.updatedAt || 0)) - Math.max(...a.list.map((x) => x.updatedAt || 0)));
    const folder = (cwd) => (cwd ? String(cwd).split(/[\\/]/).filter(Boolean).pop() : "默认工作区");
    return groups.map((g) => `
      <div class="pc-ws">
        <div class="pc-ws-head"><span class="pc-ws-name">${esc(folder(g.cwd))}</span><span class="pc-ws-count">${g.list.length}</span></div>
        ${g.cwd ? `<div class="pc-ws-path">${esc(g.cwd)}</div>` : ""}
        ${g.list.map(pcRow).join("")}
      </div>`).join("");
  }

  function renderPcSessions(rows, error) {
    const sec = $("#pcSection");
    const list = $("#pcList");
    if (!sec || !list) return;
    const st = Link.state();
    if (!st.paired) { sec.style.display = "none"; pcCache = []; return; }
    sec.style.display = "";
    if (rows === undefined) {
      // 还没拿到结果：只在完全没数据时占位，别把已有列表闪空
      if (!pcCache.length) {
        list.innerHTML = '<div class="session-item is-empty"><span class="s-main"><span class="s-title">正在读取电脑会话…</span></span></div>';
      }
      return;
    }
    pcCache = rows || [];
    list.innerHTML = pcCache.length
      ? pcGroupHTML(pcCache)
      : `<div class="session-item is-empty"><span class="s-main"><span class="s-title">${error ? "读不到电脑上的会话" : "电脑上还没有会话"}</span></span></div>`;
  }

  function renderSessions(filter = "") {
    // 开机第一次画列表 = 索引已经读出来了，这时才是清扫孤儿的安全时机
    // （内核不知道哪场会话还活着，空列表去清扫等于删光用户的东西）
    if (typeof sweepOrphans === "function") { try { sweepOrphans(); } catch (_) {} }
    const mode = currentMode();
    const all = mode === "host" ? state.sessions : localSessionView();
    const q = (filter || "").trim().toLowerCase();
    const hit = (s) => !q || `${s.title || ""} ${s.sub || ""}`.toLowerCase().includes(q);
    const byTime = (a, b) => (b.at || 0) - (a.at || 0);

    const pinned = all.filter((s) => s.pin).filter(hit).sort(byTime);
    const rest = all.filter((s) => !s.pin).sort(byTime);
    const matched = rest.filter(hit);
    const recent = matched.slice(0, 3);

    // 置顶：没有就整块不占位，不留一个空的「置顶」标题
    $("#pinnedList").innerHTML = pinned.map((s) => sessionRow(s)).join("");
    const pinnedSec = $("#pinnedSection");
    if (pinnedSec) pinnedSec.style.display = pinned.length ? "" : "none";

    // 最近：最多 3 条，和「工作区」里的是同一批会话（这里是快捷入口，不搬走）
    $("#recentList").innerHTML = recent.length
      ? recent.map((s) => sessionRow(s)).join("")
      : (!q && state.lastError)
        ? `<div class="session-item is-empty">
             <span class="s-main">
               <span class="s-title">会话列表没读出来</span>
               <span class="s-sub">${esc(String(state.lastError))}</span>
             </span>
             <button class="btn-ghost" data-retry-sessions>重试</button>
           </div>`
        : `<div class="session-item is-empty"><span class="s-main"><span class="s-title">${
            q ? "没有匹配的会话" : "暂无会话"
          }</span></span></div>`;
    const recentSec = $("#recentSection");
    if (recentSec) recentSec.style.display = recent.length || !q ? "" : "none";

    // 工作区：列出**全部未删除的会话**，按所属分组，组内按更新时间倒序；组间按各自最新一条排序。
    // 「最近」只是同屏幕上的快捷入口，不从这里搬走任何一条 —— 会话在窄屏上默认堆着（点开才列出来），
    // 少一条才是真问题（实测：三场会话时工作区整块空掉，写着「还没有归档到工作区的会话」，
    // 用户以为会话没了；产品里根本没有「归档」，会话只有直接删除）。
    const groups = new Map();
    for (const s of matched) {
      const key = wsId(s.ws);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    const order = [...groups.keys()].sort((a, b) => (groups.get(b)[0].at || 0) - (groups.get(a)[0].at || 0));
    $("#wsList").innerHTML = order.length
      ? order.map((key) => wsGroupHTML(key, groups.get(key), !!q)).join("")
      : `<div class="session-item is-empty"><span class="s-main"><span class="s-title">${
          q ? "没有匹配的会话" : "暂无会话"
        }</span></span></div>`;
    const wsSec = $("#wsSection");
    if (wsSec) wsSec.style.display = all.length || q ? "" : "none";

    // 「本地运行」统计卡与宿主机状态卡（#statSessions / #hostCard 那一块）已从会话页移除多年，
    // 更新代码却一直在：DOM 不在，每次都是空转。要看运行状态去设置页，别在这里补。
    // 电脑分区跟着列表一起刷新：配对之后这里就是电脑会话的入口。
    // 搜索时不掺进来 —— 电脑那边的一次往返会让结果慢半拍。
    Link.refreshList();
    const pcSec = $("#pcSection");
    if (pcSec && q) pcSec.style.display = "none";
    renderMode();
    applyLang();
  }

  /** 一个工作区块：头部是工作区本身，会话堆在下面，点头部展开/收起 */
  function wsGroupHTML(key, list, forceOpen) {
    const w = wsEntry(key);
    const open = forceOpen || WsState.open(key);
    const latest = list[0] || {};
    const openText = `${list.length} 个会话`;
    const closedText = `${list.length} 个会话 · 最近 ${latest.title || "新会话"}`;
    // 堆叠边的语义是「底下还压着别的会话」：只有 1 条时画两层等于撒谎
    // （用户实测：单会话的工作区也显示成两摞）。
    const many = list.length > 1;
    const cls = [open ? "is-open" : "", many ? "" : "is-single", (!open && many) ? "is-stacked" : ""]
      .filter(Boolean).join(" ");
    return `
      <div class="ws-group ${cls}" data-ws-group="${esc(key)}">
        <button class="ws-head" data-ws-toggle="${esc(key)}" aria-expanded="${open}">
          <span class="ws-ico"><svg class="ico sm"><use href="#i-branch"/></svg></span>
          <span class="ws-main">
            <span class="ws-name">${esc(w.name)}</span>
            <span class="ws-meta" data-open-text="${esc(openText)}" data-closed-text="${esc(closedText)}">${esc(open ? openText : closedText)}</span>
          </span>
          <span class="ws-count">${list.length}</span>
          <svg class="ico chev"><use href="#i-chevron"/></svg>
        </button>
        <div class="ws-body"${open ? ' style="max-height:none;opacity:1"' : ""}><div class="ws-body-in">${list.map((s) => sessionRow(s, true)).join("")}</div></div>
      </div>`;
  }

  /**
   * 展开/收起：先量出内容高度写进 max-height（CSS 里 0fr→1fr 在低端机会跳帧），
   * 展开结束再切成 none，之后内容变高也不会被裁；收起前先量一次，才能从 none 平滑回 0。
   */
  function wsSetBody(group, open) {
    const body = $(".ws-body", group);
    const inner = $(".ws-body-in", body || document.createElement("div"));
    if (!body || !inner) return;

    if (open) {
      // 量目标高度**不能**先把 max-height 设成 none —— 那会让内容以全高真实绘制一帧，
      // 下一帧才被收回到 0，观感就是「展开瞬间闪一下白/闪一下整块」。
      // scrollHeight 在 max-height:0 + overflow:hidden 下依然给出内容真实高度，
      // 所以量高度这一步根本不需要摊开：读它 → 从 0 长到它。
      const target = Math.max(body.scrollHeight, inner.offsetHeight);
      body.style.maxHeight = "0px";
      void body.offsetHeight;          // 强制一次样式落定，确保下面的 rAF 从 0 起跑
      requestAnimationFrame(() => {
        body.style.maxHeight = target + "px";
        body.style.opacity = "1";
      });
      const done = (ev) => {
        if (ev && ev.propertyName !== "max-height") return;
        body.removeEventListener("transitionend", done);
        if (group.classList.contains("is-open")) body.style.maxHeight = "none";
      };
      body.addEventListener("transitionend", done);
      return;
    }

    // 收起：先保持展开态的行样式（is-closing），高度动画结束再撤，
    // 否则行的 padding/边框瞬间回缩，视觉上就是整个列表跳一下
    group.classList.add("is-closing");
    // 收起的起点必须是「当前真实高度」的确定值：若此刻是 none，先写死一次再归零，
    // 否则 max-height:none → 0 之间会有一帧按全高绘制（回收时的那下白闪）。
    const from = body.style.maxHeight === "none" ? Math.max(body.scrollHeight, inner.offsetHeight) : null;
    body.style.maxHeight = (from || Math.max(body.scrollHeight, inner.offsetHeight)) + "px";
    void body.offsetHeight;
    body.style.maxHeight = "0px";
    body.style.opacity = "0";
    clearTimeout(group._closeTimer);
    group._closeTimer = setTimeout(() => group.classList.remove("is-closing"), 380);
  }

  function sessionRow(s, inWs) {
    // 外层负责左滑：操作按钮垫在下面，会话本体水平位移露出来（同一条列表里就能改）
    return `
      <div class="sess-row" data-sess-row="${s.id}">
        <div class="sess-acts">
          <button class="sess-act pin" data-sess-pin="${s.id}" aria-label="${s.pin ? "取消置顶" : "置顶"}" title="置顶">
            <svg class="ico sm"><use href="#i-bookmark"/></svg>
          </button>
          <button class="sess-act move" data-sess-move="${s.id}" aria-label="移动到工作区" title="工作区">
            <svg class="ico sm"><use href="#i-branch"/></svg>
          </button>
          <button class="sess-act edit" data-sess-rename="${s.id}" aria-label="重命名" title="重命名">
            <svg class="ico sm"><use href="#i-file"/></svg>
          </button>
          <button class="sess-act del" data-sess-del="${s.id}" aria-label="删除" title="删除">
            <svg class="ico sm"><use href="#i-x"/></svg>
          </button>
        </div>
        <button class="session-item${inWs ? " in-ws" : ""}" data-open="${s.id}">
          <span class="s-avatar-wrap">
            ${s.running ? `<span class="s-live-dot" aria-label="运行中"></span>` : ""}
            <span class="s-avatar ${s.tint}">${s.letter}</span>
          </span>
          <span class="s-main">
            <span class="s-title-row">
              <span class="s-title">${esc(s.title)}</span>
              <span class="s-time">${s.time}</span>
            </span>
            <span class="s-sub">${esc(s.sub)}</span>
          </span>
          ${s.badge ? `<span class="badge">${s.badge}</span>` : ""}
        </button>
      </div>`;
  }

  /* ---------------- 用量统计（额度 / 热力图 / 会话明细） ---------------- */
  const fmtTokens = (n) => {
    if (!n) return "0";
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
    return String(n);
  };

  /**
   * 本地用量账本：按天 + 按会话累计 token。
   * 只记 token 数（不记内容），存在 localStorage，和会话数据一样只在本机。
   */
  const Usage = {
    KEY: "dsh.usage.v1",
    read() {
      try {
        const v = JSON.parse(localStorage.getItem(this.KEY) || "{}");
        return v && typeof v === "object" ? v : {};
      } catch (_) { return {}; }
    },
    write(o) { localStorage.setItem(this.KEY, JSON.stringify(o)); },
    key(d = new Date()) {
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    },
    log(sessionId, usage) {
      if (!usage) return;
      const p = Number(usage.prompt) || 0;
      const c = Number(usage.completion) || 0;
      const t = Number(usage.total) || (p + c);
      if (!t) return;
      const db = this.read();
      db.days = db.days || {};
      db.sessions = db.sessions || {};
      const k = this.key();
      const d = db.days[k] || { t: 0, p: 0, c: 0, n: 0 };
      d.t += t; d.p += p; d.c += c; d.n += 1;
      db.days[k] = d;
      if (sessionId) {
        const x = db.sessions[sessionId] || { t: 0, p: 0, c: 0, n: 0, last: 0 };
        x.t += t; x.p += p; x.c += c; x.n += 1; x.last = Date.now();
        db.sessions[sessionId] = x;
      }
      this.write(db);
    },
    totals() {
      const db = this.read();
      let t = 0, p = 0, c = 0, n = 0;
      Object.values(db.days || {}).forEach((d) => {
        t += d.t || 0; p += d.p || 0; c += d.c || 0; n += d.n || 0;
      });
      return { t, p, c, n, days: Object.keys(db.days || {}).length, today: (db.days || {})[this.key()] || null };
    },
    /** 近 weeks 周的热力图数据（结束在本周周六，保证最后一列整周） */
    heat(weeks = 12) {
      const db = this.read();
      const daysMap = db.days || {};
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const end = new Date(today);
      end.setDate(end.getDate() + (6 - end.getDay()));
      const cells = [];
      let max = 0;
      const total = (weeks * 7);
      for (let i = 0; i < total; i++) {
        const d = new Date(end);
        d.setDate(end.getDate() - (total - 1 - i));
        const k = this.key(d);
        const t = (daysMap[k] || {}).t || 0;
        max = Math.max(max, t);
        cells.push({ k, t, date: d });
      }
      const level = (t) => (t <= 0 ? 0 : Math.max(1, Math.ceil((t / (max || 1)) * 4)));
      return cells.map((c) => ({ ...c, level: c.date > today ? -1 : level(c.t) }));
    },
  };

  /* ---------------- messages ---------------- */

  /**
   * 会话数据按会话身份分桶（桌面端 per-session 日志的手机端等价物）。
   *
   * 以前 `thread` 是全局唯一的一个可变数组：`openSession()` 先 `thread.length = 0`
   * 再灌新会话，而 `persistThread()` 又把「当前这个数组」写进 `state.sessionId` 的槽位。
   * 两者只要有一瞬间不同步（切会话间隙、异步回调、发送首条消息时刚 create 出新 sid、
   * 目标模式新建会话），就会把 A 的内容写进 B —— 现象是「点进 A 却是 B 的对话」，
   * 而且写坏的数据不会自愈（数据里没有「这段本来属于谁」的标记）。
   *
   * 现在 `thread` 只是「当前会话那一份」的**引用**，切会话只换指针：
   *  · 每一份都是独立数组，任何 push/splice 都影响不到别的会话；
   *  · `persistThread()` 落盘前做身份自检（`__sid`），不匹配就跳过 —— **宁可漏存，
   *    也绝不写错会话**。这正是桌面端「按会话身份追加、结构上不可能串号」的语义。
   */
  const BUCKET_MAX = 8;        // 内存里最多留几份已加载的会话，其余落盘后释放
  const buckets = new Map();   // key -> { arr, loaded }；Map 插入序 = LRU 顺序
  let thread = [];             // 当前会话的节点数组（永远指向 buckets 里的一份）

  function bucketOf(key) {
    const k = String(key || "");
    let b = buckets.get(k);
    if (b) { buckets.delete(k); buckets.set(k, b); return b; }   // 访问即提权（LRU）
    b = { arr: [], loaded: false };
    b.arr.__sid = k;
    buckets.set(k, b);
    evictBuckets(k);
    return b;
  }

  /** 只保留最近几份：其余先落一次快照再释放，避免开几十个会话把内存吃满 */
  function evictBuckets(keepKey) {
    for (const [k, b] of buckets) {
      if (buckets.size <= BUCKET_MAX) return;
      if (k === keepKey || b.arr === thread) continue;
      // 正在跑的那条会话的桶绝不能丢：Live 还在往这个数组里写，丢了下一次
      // 打开就会「重建 thread 但 Live 指向游离节点」= 只有终止按钮、正文全空
      if (state.busy && k === (Live.sessionId || "")) continue;
      // 挂在后台的那一轮（看成员会话时 Lead 还在跑）同样算「正在跑」：
      // 这时 state.busy / Live 都被让到后台了，只按它们判就会把这一份挤掉，
      // 回来时只剩最后一次快照 —— 节点、展开过的过程组、工具行全要重建
      if (state.bgRun && k === state.bgRun.sid) continue;
      // 正在看某个队友的会话：Lead 那一场的桶既不是当前 thread（当前是 "team:…" 那一份），
      // busy/Live 也让到后台了 —— 只有 teamView.parent 还认得它。不保住的话，用户在成员
      // 视图里顺手点开几别的会话就把 Lead 的桶挤出 LRU，而这一轮的产出又没落进页内的库
      // （见 appendMissedTail 的注释），回来就只剩离开那一刻的快照。
      if (state.teamView && k === state.teamView.parent) continue;
      if (k && b.loaded && b.arr.length) {
        try { LocalDB.saveShot(k, shotNode(b.arr, 0, "")); } catch (_) {}
      }
      buckets.delete(k);
    }
  }

  /**
   * 把 `thread` 切到 key 那一份，返回它的桶（调用方常要读 `loaded`）。
   * **切会话只允许走这一组函数**：attachThread / attachBlank / adoptThread。
   */
  function attachThread(key) {
    const b = bucketOf(key);
    thread = b.arr;
    return b;
  }

  /** 开一份空白的新流（新会话、删除后的空态）：不继承任何内容 */
  function attachBlank(key) {
    const b = attachThread(key);
    thread.length = 0;
    // 清空 = 这一份不再算「已加载」。留着 loaded=true，下一次打开这个 key 会
    // 「有桶、但一片空白，而且不肯从库里重灌」—— 表现就是聊天记录没了、
    // 只有杀后台重启才恢复（桶是进程内的，重启才重建）。
    b.loaded = false;
    return b;
  }

  /** 接管一条刚建好的会话：它自己那份就是本轮真相，不需要再从库灌 */
  function adoptThread(key) {
    const b = attachThread(key);
    b.loaded = true;
    return b;
  }

  /**
   * 内存里是否还留着这一场的对话（有内容才算）。
   *
   * 给「回到某场会话但库里查不到它」的兜底用：页面明明还握着这些节点，
   * 却把界面清成空白，用户看到的就是「聊天记录没了」—— 而内核日志与库里其实都在，
   * 只有杀后台重启才恢复（这正是用户报的那条）。
   */
  function bucketHas(key) {
    const b = buckets.get(String(key || ""));
    return !!(b && b.arr.length);
  }

  // 启动时 state.sessionId 是占位值 "s1"（还没打开任何会话）：把当前流也绑到它，
  // 免得冷启动后第一次切会话就触发一次「身份不符」告警。
  attachThread("s1");

  /* 一轮结束后，把「深度思考中 · N 秒」的活标题收口成「思考」。
     不收口会出两件事：完成的回合一直显示「思考中」；下一条消息的秒表按
     `[data-live-secs]` 取到的是**全对话第一条**（也就是上一轮），每秒改写一个
     已经定稿的节点（封条重写，而且用户看到旧回合上的秒数还在涨）。 */
  function finalizeLiveHead(el) {
    const head = el && el.querySelector(".pc-think-title");
    if (!head) return;
    head.classList.remove("is-shimmer");
    head.removeAttribute("data-live-secs");
    if (/深度思考中/.test(head.textContent || "")) head.textContent = "思考";
  }

  const NODES = {
    user: (o) => typeof o === "string"
      ? { kind: "user", text: o, atts: [], files: [], voice: null }
      : { kind: "user", text: o.text || "", atts: o.atts || [], files: o.files || [], voice: o.voice || null },
    pgroup: () => ({
      kind: "pgroup", members: [], counts: {}, order: [], running: null,
      closed: false, folded: false, open: false, secs: 0, end: "", started: 0,
    }),
    deliverable: (o) => ({ kind: "deliverable", files: o.files || [], pc: !!o.pc }),
    retry: (o) => ({ kind: "retry", attempt: o.attempt || 2, reason: o.reason || "", count: o.count || 1 }),
    fail: (o) => ({ kind: "fail", message: o.message || "", retries: o.retries || 0 }),
    maxtokens: (o) => ({ kind: "maxtokens", completion: o.completion || 0, maxOut: o.maxOut || 0 }),
    footer: (o) => ({ kind: "footer", ...o }),
    notice: (o) => ({ kind: "notice", title: o.title || "", text: o.text || "" }),
    /* 半截回合的说明行：进程在流式途中被杀，这一轮永远等不到收尾（正文也从没落进历史）。
       重开时必须在断掉的地方说一句，否则用户看到的就是一条说到一半、没有任何解释的回复。 */
    interrupted: () => ({ kind: "interrupted" }),
    /* 会话内的 Mission 卡：同一会话只保留一张，随任务开始/结束就地更新。
       它是异步工作的可见实体，不是工具行的一种样式 —— 工具行仍然是扁平行。 */
    mission: (o) => ({
      kind: "mission",
      sid: o.sid || "",
      title: o.title || "进行中的工作",
      meta: o.meta || "",
      state: o.state || "running",
      rows: o.rows || [],
      evidence: Number(o.evidence) || 0,
      updatedAt: Number(o.updatedAt) || Date.now(),
    }),
    /* 压缩标记：桌面 CompactionItem 的同构 —— 低调一行，点开才看检查点正文 */
    compaction: (o) => ({
      kind: "compaction",
      running: !!o.running,
      summarized: !!o.summarized,
      count: Number(o.count) || 0,
      folded: Number(o.folded) || 0,
      before: Number(o.before) || 0,
      after: Number(o.after) || 0,
      summary: o.summary || "",
    }),
    ask: (o) => ({ kind: "ask", id: o.id || "", question: o.question || "", detail: o.detail || "", options: o.options || [], answered: "" }),
    text: (text) => ({ kind: "text", text }),
    tool: (o) => ({ kind: "tool", ...o }),
    /* 轮末抽出来的「独立工具行」：一行 = 一次调用（图标 + 名称 + 摘要 + 耗时），
       点开是参数与输出。markup 直接复用组内的 toolRowHTML —— 桌面端 ToolRow
       就是这样一个 DisclosureRow（client/ui-tool/.../ToolRow.tsx），不是卡片。
       members 里放一个成员：这样共用的展开逻辑（data-pg-toggle → node.members[i]）直接可用。 */
    toolrow: (m) => ({ kind: "toolrow", members: [m], id: m.id || "" }),
    /* 电脑会话的工具过程组：连续的工具调用收进一条，默认只占一行。
       桌面端就是这样——过程是背景信息，不该每一调用都摆一张卡片。 */
    pctools: () => ({ kind: "pctools", items: [], open: false, closed: false }),
    /** 电脑会话里的思考块：和本机一样是「可折叠的一段思考」，不是卡片 */
    pcthink: (o) => ({ kind: "pcthink", text: o.text || "", open: !!o.open, status: o.status || "done" }),
    todo: (items) => ({ kind: "todo", items }),
    search: (hits, query) => ({ kind: "search", hits: hits || [], query: query || "" }),
    approval: (o) => ({ kind: "approval", ...o }),
    intent: (o) => ({ kind: "intent", ikind: o.kind, confidence: o.confidence, reason: o.reason }),
    plan: (o) => ({ kind: "plan", ...o }),
    goalround: (o) => ({ kind: "goalround", ...o }),
    goalresult: (o) => ({ kind: "goalresult", ...o }),
    /** 子代理工具行：顶层节点，长得和普通工具行一致，但始终可见（不随过程组折叠） */
    subrow: (o) => ({ kind: "subrow", ...o }),
    /** 媒体消息（视频/图片生成）：直接在对话里播放 */
    // `kind` 写在最后：内核回传的 media 自带 kind=image/video，先展开就会被它盖掉，
    // 节点类型变成 video 后 switch 里没有分支 → 整条媒体消息不渲染。
    // 原始判别值存进 mediaKind，渲染侧只看 mediaKind。
    media: (o) => ({ ...o, mediaKind: (o.mediaKind || o.kind) === "video" ? "video" : "image", kind: "media" }),
    /** 表情包：聊天里的大图气泡（微信风格，无背景框） */
    // 同理：表情包对象自带 kind=static/gif（以前直接盖掉节点类型，气泡整个消失）
    sticker: (o) => ({ ...o, anim: o.anim || (o.kind === "gif" ? "gif" : "static"), kind: "sticker" }),
    /** 语音消息：微信式一条可点播的气泡（波形 + 时长） */
    voice: (o) => ({ kind: "voice", ...o }),
    /** 文件改动行：轮次结束后仍常驻在对话流里（桌面同样如此），点开看对照 */
    change: (o) => ({ kind: "change", ...o }),
  };

  const TOOL_META = {
    shell: { icon: "i-term", tint: "shell", label: "终端" },
    glob: { icon: "i-search", tint: "glob", label: "检索文件" },
    read: { icon: "i-file", tint: "read", label: "读取文件" },
    edit: { icon: "i-branch", tint: "edit", label: "修改文件" },
    web: { icon: "i-globe", tint: "web", label: "联网搜索" },
    subagent: { icon: "i-agent", tint: "read", label: "子智能体" },
    team: { icon: "i-agent", tint: "read", label: "智能体团队" },
    plan: { icon: "i-plan", tint: "read", label: "会话模式" },
  };
  /** 工具名的中文展示（模型侧仍是英文 id） */
  const TOOL_LABEL = {
    read: "读取文件",
    write: "写入文件",
    edit: "编辑",
    list_dir: "查看目录",
    glob: "查找文件",
    grep: "搜索内容",
    mkdir: "新建目录",
    delete_path: "删除",
    stat: "查看属性",
    bash: "执行命令",
    subagent: "子智能体",
    exit_plan_mode: "提交计划",
    update_goal: "更新目标",
    create_goal: "建立目标",
    get_goal: "查询目标",
    todo_write: "更新待办",
    web_search: "联网搜索",
    web_fetch: "抓取网页",
    http_request: "HTTP 请求",
    read_image: "读取图片",
    skill: "加载技能",
    ask_user_question: "向你提问",
    run_code: "运行代码",
    cordis_inspect_list: "内核检查",
    cordis_inspect_query: "查询工具定义",
    plugin_manager: "插件管理",
    plugin_market: "插件市场",
    // 桌面其余工具（逐个移植后的展示名）
    str_replace_editor: "精确编辑",
    apply_patch: "应用补丁",
    present: "交付文件",
    terminal_open: "打开终端",
    terminal_list: "终端列表",
    terminal_read: "读取终端",
    terminal_send: "终端输入",
    terminal_signal: "终端信号",
    terminal_close: "关闭终端",
    job_list: "后台任务",
    job_output: "任务输出",
    job_kill: "终止任务",
    schedule_create: "创建定时任务",
    schedule_update: "修改定时任务",
    schedule_delete: "删除定时任务",
    schedule_list: "定时任务列表",
    session_event_read: "读会话事件",
    session_event_search: "搜索会话事件",
    session_event_trace: "追踪会话事件",
    session_search: "搜索历史会话",
    session_trace: "会话概览",
    working_directory: "切换目录",
    list_agents: "子代理列表",
    send_message: "给子代理发消息",
    interrupt_agent: "中断子代理",
    list_subagent_models: "模型路由",
    ralph: "Ralph 多轮推进",
    workflow: "工作流",
    lsp: "语言服务",
    pwsh: "PowerShell",
    create_worktree: "创建 worktree",
    load_workspace_dependencies: "加载依赖",
    spawn_teammate: "派生协作代理",
    team_task_create: "创建团队任务",
    team_task_get: "读团队任务",
    team_task_list: "团队任务列表",
    team_task_update: "更新团队任务",
    wait_agent: "等待子代理",
    stagehand_navigate: "浏览器导航",
    stagehand_act: "浏览器操作",
    stagehand_extract: "浏览器提取",
    stagehand_observe: "浏览器观察",
    stagehand_screenshot: "浏览器截图",
    stagehand_tabs: "浏览器标签页",
    list_mcp_resources: "MCP 资源",
    list_mcp_resource_templates: "MCP 资源模板",
    read_mcp_resource: "读 MCP 资源",
    delete_path: "删除文件",
    mkdir: "新建目录",
    // 手机操控 / 读屏（ComputerUsePlugin 的工具，之前没有中文名，行里直接显示英文 id）
    screen_read: "读取屏幕",
    phone_screenshot: "手机截图",
    phone_app_info: "应用信息",
    phone_foreground: "当前应用",
    phone_list_apps: "应用列表",
    phone_launch: "打开应用",
    phone_open_app: "打开应用",
    phone_key: "按键",
    phone_tap: "点击",
    phone_long_press: "长按",
    phone_swipe: "滑动",
    phone_gesture: "手势",
    phone_scroll: "滚动",
    phone_scroll_until: "滚动查找",
    phone_drag: "拖拽",
    phone_pinch: "缩放",
    phone_type: "输入文字",
    phone_set_text: "填入文本",
    phone_clear_text: "清空文本",
    phone_ime_enter: "回车",
    phone_form_fill: "填写表单",
    phone_clipboard: "剪贴板",
    phone_media: "媒体控制",
    phone_volume: "音量",
    phone_notifications: "通知",
    phone_toggle: "开关设置",
    phone_wait: "等待",
    subagent_fork: "派生会话",
  };

  /**
   * 扫光相位锁：元素无论因为什么被重建，都用负延迟接上「当前相位」继续扫，
   * 而不是从 0 重新开始 —— 那是运行中文字一直闪的第二个原因。
   */
  function shimmerAttr() {
    const p = Math.round(performance.now() % 1600);
    return ` style="animation-delay:-${p}ms"`;
  }

  /** 过程组内的每一步（思考行 / 工具行）——组头与组体分开渲染，便于按需局部更新 */
  function pgroupRowsHTML(n) {
    return (n.members || []).map((m, i) => m.type === "think" ? thinkRowHTML(m, i) : toolRowHTML(m, i)).join("");
  }

  function nodeHTML(n) {
    switch (n.kind) {
      case "subrow": {
        // 不再显示「第 N/M 轮」和进度环 —— 轮数是内核的循环计数，对用户不是信息；
        // 要看的是它此刻在做什么（下面那棵步骤树），所以摘要位直接放最新那一步。
        const steps = n.lines || [];
        const lastStep = steps.length ? String(steps[steps.length - 1].text || "") : "";
        const label = n.done ? "完成" : (lastStep || "启动中");
        const rows = steps.map((l) => {
          const meta = l.tool ? TOOL_META[toolCategory(l.tool)] : null;
          const icon = l.tool ? ((meta && meta.icon) || "i-branch") : "i-sparkle";
          return `<div class="sa-row"><span class="sa-rail"></span>
            <svg class="sa-ico"><use href="#${icon}"/></svg>
            <span class="sa-text">${esc(l.text)}</span></div>`;
        }).join("");
        const concl = n.result
          ? `<div class="sa-concl"><span class="sa-rail"></span><b>结论</b><span class="sa-text">${esc(n.result)}</span></div>`
          : "";
        const task = n.task ? ` · ${esc(String(n.task).slice(0, 24))}` : "";
        return `
          <div class="msg assistant">
            <div class="pg-row is-tool${n.done ? "" : " is-run"}${n.open ? " is-open" : ""}" data-subrow>
              <button class="pg-main" data-sub-toggle>
                <svg class="pg-ico"><use href="#i-agent"/></svg>
                <span class="pg-title">子代理${task}</span>
                <i class="pg-sep"></i>
                <span class="pg-sum${n.done ? "" : " is-live"}">${esc(label)}${steps.length ? ` · ${steps.length} 步` : ""}</span>
              </button>
              <div class="pg-detail"><div class="sa-tree">${rows || '<div class="sa-row"><span class="sa-rail"></span><span class="sa-text">等待子代理开始…</span></div>'}${concl}</div></div>
            </div>
          </div>`;
      }

      case "media": {
        // 对话流里只放缩略版：图片限高、视频只出首帧，点开才进全屏查看器
        const isVideo = n.mediaKind === "video";
        // 远端视频加 #t=0.1 让 WebView 抓首帧当缩略；data: URL 加 fragment 会破坏 base64，只在 http(s) 上加
        const vsrc = /^https?:/i.test(String(n.dataUrl || "")) ? n.dataUrl + "#t=0.1" : n.dataUrl;
        const thumb = isVideo
          ? `<video class="ct-video" src="${esc(vsrc)}" preload="metadata" playsinline muted></video>
             <span class="ct-play"><svg class="ico"><use href="#i-play"/></svg></span>
             ${n.durSec ? `<span class="ct-dur">${esc(String(Math.round(n.durSec)))}″</span>` : ""}`
          : `<img class="ct-img" src="${esc(n.dataUrl)}" alt="${esc(n.name || "")}" loading="lazy" />`;
        return `
          <div class="msg assistant">
            <button class="chat-thumb ${isVideo ? "is-video" : "is-img"}" data-media-open
              aria-label="${isVideo ? "播放视频" : "查看大图"}">${thumb}</button>
          </div>`;
      }

      case "sticker": {
        const gif = (n.anim || n.stickerKind) === "gif";
        // 按表情自身宽高比出盒子（仓库里存了 w/h）。尺寸统一走 CSS 变量 --stk，
        // 默认 96px：原来的 132 在手机上和头像差不多大，一屏刷两三张就压满对话。
        // 以前固定 132×132 + object-fit:fill，竖图会被横向拉宽、横图被压扁，
        // 表情看起来「变形」——这里仍按宽高比出盒子，只把边长收小。
        const w = Number(n.w) || 0, h = Number(n.h) || 0;
        const box = w > 0 && h > 0 && w !== h
          ? (w >= h ? `style="width:var(--stk);aspect-ratio:${w}/${h}"` : `style="height:var(--stk);aspect-ratio:${w}/${h}"`)
          : "";
        return `
          <div class="msg ${n.by === "user" ? "user" : "assistant"}">
            <button class="chat-sticker${gif ? " is-gif" : ""}" data-media-open aria-label="查看表情">
              <img src="${esc(n.dataUrl)}" alt="${esc(n.name || "表情")}" ${box} />
              ${gif ? '<span class="cs-gif">GIF</span>' : ""}
            </button>
          </div>`;
      }

      case "voice": {
        // 占位态：气泡先出现（宽度按时长估好），合成完成后再补上音频。
        // 以前是「合成完才插气泡」，用户盯着空白等 1~3 秒，体感就是卡。
        if (n.pending) {
          const secsP = Math.max(1, Math.round((Number(n.durMs) || 1000) / 1000));
          return `
          <div class="msg assistant">
            <div class="voice-row">
              <div class="voice-msg is-pending" aria-label="语音合成中">
                <span class="vm-wave vm-loading"><i></i><i></i><i></i></span>
                <span class="vm-dur">${secsP}″</span>
              </div>
            </div>
          </div>`;
        }
        const secs = Math.max(1, Math.round((Number(n.durMs) || 1000) / 1000));
        // 波形只是观感：按消息内容长度生成稳定的一组柱高，重绘不会跳
        const seed = String(n.text || "").length + secs * 7;
        const bars = Array.from({ length: 18 }, (_, i) => {
          const h = 4 + Math.abs(Math.sin((i + 1) * 1.7 + seed)) * 12 + ((i * 5 + seed) % 4);
          return `<i style="height:${Math.round(h)}px"></i>`;
        }).join("");
        if (n.expired) {
          return `
          <div class="msg assistant">
            <div class="voice-row">
              <button class="voice-msg is-failed" data-voice-regen aria-label="重新生成语音">
                <svg class="vm-ico"><use href="#i-play"/></svg>
                <span class="vm-dur">重新生成</span>
              </button>
              <span class="vm-fail">语音未生成，点一下重试</span>
            </div>
          </div>`;
        }
        if (n.failed) {
          // 合成失败：不留空壳，退回「朗读这句」的入口，文字仍可看
          return `
          <div class="msg assistant">
            <div class="voice-row">
              <button class="voice-msg is-failed" data-speak-turn aria-label="朗读">
                <svg class="vm-ico"><use href="#i-play"/></svg>
                <span class="vm-dur">朗读</span>
              </button>
              <span class="vm-fail">语音生成失败</span>
            </div>
          </div>`;
        }
        // 纯语音消息（日常闲聊）：气泡就是整条回复，文字默认收起，可「转文字」展开
        return `
          <div class="msg assistant"${n.only ? ' data-voice-only="1"' : ""}>
            <div class="voice-row">
              <button class="voice-msg" data-voice-play aria-label="播放语音">
                <span class="vm-wave">${bars}</span>
                <span class="vm-dur">${secs}″</span>
              </button>
              ${n.only && n.text ? '<button class="vm-conv" data-voice-text>转文字</button>' : ""}
            </div>
            ${n.only && n.text ? `<div class="vm-text" hidden>${md(n.text)}</div>` : ""}
          </div>`;
      }

      case "change": {
        const open = !!n.open;
        return `
          <div class="msg assistant">
            <div class="change-row${open ? " is-open" : ""}" data-change>
              <button class="chg-head" data-toggle-change>
                <svg class="chg-ico"><use href="#${n.icon || "i-edit"}"/></svg>
                <span class="chg-title">${esc(n.title || "编辑")}</span>
                <i class="pg-sep"></i>
                <span class="chg-path">${esc(n.path || "")}</span>
                ${diffChipsHTML(n.diff)}
              </button>
              <div class="pg-detail">
                ${editDiffHTML(n.args, n.path)}
                ${n.out ? `<div class="io-sec"><span class="io-label">输出</span><span class="io-text">${esc(String(n.out).slice(0, 600))}</span></div>` : ""}
              </div>
            </div>
          </div>`;
      }

      case "pgroup": {
        const rows = pgroupRowsHTML(n);

        /* 轮次收尾：桌面 TurnProcessNodeView —— 一条「已完成，用时 N 秒」的折叠行 */
        if (n.folded) {
          const label = n.turnLabel
            ? (n.end === "stopped" ? "已停止"
              : n.end === "error" ? "处理失败"
                : `已完成，用时 ${durHTML(n.secs)}`)
            : pgroupTitleClosed(n.counts, n.order);
          const canOpen = n.members.length > 0;
          return `
            <div class="msg assistant">
              <div class="turnproc${n.turnLabel ? " is-turn" : ""}${n.open ? " is-open" : ""}${n.end ? " is-" + n.end : ""}" data-turnproc>
                <button class="tp-head"${canOpen ? "" : " disabled"} data-toggle-tp>
                  <span class="tp-label">${label}</span>
                  ${canOpen ? '<svg class="ico xs chev"><use href="#i-chevron-down"/></svg>' : ""}
                </button>
                ${canOpen ? `<div class="tp-body">${rows}</div>` : ""}
              </div>
            </div>`;
        }

        /* 运行中 / 本轮中间的过程组：单行实时活动，点开看每一步 */
        const first = n.members[0];
        const icon = n.closed
          ? (first && first.type === "think" ? "i-d-think" : (CAT_ICON[first && first.cat] || "i-d-sparkle"))
          : (CAT_ICON[n.running && n.running.cat] || "i-d-sparkle");
        return `
          <div class="msg assistant">
            <div class="pgroup ${n.closed ? "is-done" : "is-run"}${n.open ? " is-open" : ""}" data-pgroup>
              <button class="pgroup-head" data-toggle-pgroup>
                <span class="pg-lead">
                  <svg class="pg-ico pg-act"><use href="#${icon}"/></svg>
                  <svg class="pg-ico pg-chev"><use href="#i-chevron-down"/></svg>
                </span>
                <span class="pg-label${n.closed ? "" : " is-shimmer"}"${n.closed ? "" : shimmerAttr()}>${esc(pgroupTitle(n))}</span>
              </button>
              <div class="pgroup-body">${rows || '<div class="pg-empty">…</div>'}</div>
            </div>
          </div>`;
      }

      case "deliverable": {
        const files = n.files || [];
        if (!files.length) return "";
        // 电脑会话的交付物：文件在电脑那台机器上，手机既预览不了也没有缩略图，
        // 所以不给「点开」的假入口，只把名字与说明如实摆出来。
        const pc = !!n.pc;
        return `
          <div class="msg assistant">
            <div class="deliver-card">
              <div class="deliver-head">
                <svg class="ico xs"><use href="#i-files"/></svg>
                <b>交付文件 · ${files.length} 个</b>
                ${pc ? '<span class="dh-hint">在电脑上</span>' : ""}
              </div>
              ${files.map((f) => {
                const name = f.name || f.path || "";
                // 图片类交付物直接给缩略图（svg/动图也算图片），视频给播放角标
                const img = !pc && isImageName(name, f.mime);
                const vid = !pc && isVideoName(name, f.mime);
                const ico = img
                  ? `<img class="deliver-thumb" data-thumb-path="${esc(f.path || name)}" alt="" />`
                  : vid
                    ? '<span class="deliver-vid"><svg class="ico"><use href="#i-play"/></svg></span>'
                    : fileBadge(name, f.mime || "");
                return `
                <${pc ? "div" : "button"} class="deliver-item${pc ? " is-static" : ""}"${pc ? "" : ` data-open-file="${esc(f.path || "")}"`}>
                  <span class="deliver-ico${img ? " has-thumb" : ""}${vid ? " has-vid" : ""}">${ico}</span>
                  <span class="deliver-main">
                    <span class="di-name">${esc(name)}</span>
                    ${f.description ? `<span class="di-desc">${esc(f.description)}</span>` : ""}
                  </span>
                  <span class="di-size">${f.size ? fmtSize(f.size) : ""}</span>
                </${pc ? "div" : "button"}>`;
              }).join("")}
            </div>
          </div>`;
      }

      case "ask": {
        if (n.answered) {
          return `
          <div class="msg assistant">
            <div class="turn-note">
              <svg class="ico xs"><use href="#i-check"/></svg>
              <span><b>已回答</b><br>${esc(n.question)}<br>你选择了：${esc(n.answered)}</span>
            </div>
          </div>`;
        }
        const opts = (n.options || []).map((o, i) => `
          <button class="ask-opt" data-ask-opt="${esc(n.id)}|${esc(o.label)}">
            <b>${esc(o.label)}</b>
            ${o.description ? `<span>${esc(o.description)}</span>` : ""}
          </button>`).join("");
        return `
          <div class="msg assistant">
            <div class="ask-card">
              <div class="ask-head"><svg class="ico xs"><use href="#i-user"/></svg><span>Agent 想问你</span></div>
              <div class="ask-q">${esc(n.question)}</div>
              ${n.detail ? `<div class="ask-detail">${esc(n.detail)}</div>` : ""}
              <div class="ask-opts">${opts || '<div class="pg-empty">（模型没有给出选项）</div>'}</div>
            </div>
          </div>`;
      }

      case "compaction": {
        // 桌面是**两个东西**，不能拼在一行：
        //  · 进行中：轨迹里的一行「正在压缩上下文…」（ui-trajectory layout.ts:357-359），
        //    没有标题、没有圆点、没有数字；
        //  · 完成后：聊天里的 CompactionItem（ui-chat CompactionItem.tsx）——
        //    「图标 · 上下文已压缩 · 已压缩 N 条历史记录（约 M tokens）」，有摘要才可展开。
        if (n.running) {
          // 运行中那一行用全应用统一的扫光（与工具行/思考行的 is-shimmer 同一套），
          // 让人一眼看出它还在跑；行两侧的细线由 .compact-run 的伪元素画。
          return `<div class="msg assistant"><div class="compact-run">` +
            `<span class="is-shimmer"${shimmerAttr()}>正在压缩上下文…</span></div></div>`;
        }
        const items = n.count || 0;
        const tokens = n.after || n.before || 0;
        const summary = (n.summarized && items > 0)
          ? `已压缩 ${items} 条历史记录（约 ${tokens} tokens）`
          : n.summary ? "点击查看压缩摘要" : "压缩摘要不可用";
        const detail = n.summary ? `<div class="compact-detail" hidden>${md(n.summary)}</div>` : "";
        const chev = detail ? '<svg class="ico xs compact-chev"><use href="#i-chevron-down"/></svg>' : "";
        return `
          <div class="msg assistant">
            <div class="turn-note is-compact${detail ? " is-expandable" : ""}"${detail ? ' data-compact-toggle' : ""}>
              <svg class="ico xs"><use href="#i-compress"/></svg>
              <span class="compact-title">上下文已压缩</span>
              <i class="compact-sep"></i>
              <span class="compact-sum">${esc(summary)}</span>
              ${chev}
            </div>
            ${detail}
          </div>`;
      }

      case "mission": {
        const done = n.state === "done";
        return `
          <div class="msg assistant">
            <div class="mission-card${done ? " is-done" : ""}">
              <div class="mc-head">
                ${whalePlushHTML()}
                <div class="mc-titles">
                  <b>${esc(n.title)}</b>
                  <span>${esc(n.meta || "")}</span>
                </div>
                <span class="mc-state${done ? " is-done" : ""}">${done ? "已结束" : "进行中"}</span>
              </div>
              <div class="mc-bar"><i class="${done ? "is-done" : "is-run"}"></i></div>
              <div class="mc-foot">
                <span class="mc-ev">${n.evidence ? n.evidence + " 条证据" : "执行记录"}</span>
                <button class="mc-link" data-mission-open>查看 ›</button>
              </div>
            </div>
          </div>`;
      }

      case "notice":
        return `
          <div class="msg assistant">
            <div class="turn-note">
              <svg class="ico xs"><use href="#i-bell"/></svg>
              <span><b>${esc(n.title)}</b>${n.text ? "<br>" + esc(n.text) : ""}</span>
            </div>
          </div>`;

      case "retry":
        return `
          <div class="msg assistant">
            <div class="turn-note is-warn">
              <svg class="ico xs"><use href="#i-shield"/></svg>
              <span>${n.final
                ? `请求失败（已重试 ${n.attempt} 次）${n.reason ? " · " + esc(String(n.reason).slice(0, 120)) : ""}`
                : `请求失败，正在重试（第 ${n.attempt} 次）${n.reason ? " · " + esc(String(n.reason).slice(0, 80)) : ""}`}</span>
            </div>
          </div>`;

      case "fail":
        return `
          <div class="msg assistant">
            <div class="turn-note is-warn">
              <svg class="ico xs"><use href="#i-shield"/></svg>
              <span><b>请求失败${n.retries ? `（重试 ${n.retries} 次）` : ""}</b> · ${esc(String(n.message || "").slice(0, 120))}</span>
            </div>
          </div>`;

      case "maxtokens":
        // 与压缩标记同一套低调一行：用户点名去掉橙色卡片（桌面也不把系统提示做成卡）
        return `
          <div class="msg assistant">
            <div class="turn-note is-compact">
              <svg class="ico xs"><use href="#i-shield"/></svg>
              <span>${Number(n.completion) > 0
                ? `已达到输出上限（${n.completion}/${n.maxOut} tokens），回复可能被截断。可以在设置里调大「最大输出」。`
                : /* 端点没回传统用量的截断（llama.cpp 这类）：报「0/N tokens」等于没说 ——
                     真实情况是预算用完了而正文一个字都没有，多半被思考占满。 */
                  `输出预算（${n.maxOut} tokens）用完，正文一个字都没有（这一档没回传用量）。多半是思考占满了预算：调大「最大输出」，或把思考档位关掉再试。`}</span>
            </div>
          </div>`;

      case "interrupted":
        return `
          <div class="msg assistant">
            <div class="turn-note is-warn">
              <svg class="ico xs"><use href="#i-shield"/></svg>
              <span><b>这一轮没跑完</b> · 应用被退出或被系统回收，上面是已经产出的部分</span>
            </div>
          </div>`;

      case "footer": {
        const bits = [];
        const hasUsage = !!(n.tokens || n.ms || n.steps);
        return `
          <div class="msg assistant">
            <div class="turn-tail">
              <button class="tt-btn" data-copy-turn><svg class="ico xs"><use href="#i-copy"/></svg>复制</button>
              ${SpeechOut.available() ? `<button class="tt-btn" data-speak-turn><svg class="ico xs"><use href="#i-mic"/></svg>朗读</button>` : ""}
              ${hasUsage ? `<button class="tt-btn tt-usage" data-turn-usage="${esc(n.__uid || "")}">${
                n.tokens ? (n.tokens >= 1000 ? (n.tokens / 1000).toFixed(1) + "k tokens" : n.tokens + " tokens") : "用量"
              }<svg class="ico xs"><use href="#i-chevron"/></svg></button>` : ""}
            </div>
          </div>`;
      }

      case "user": {
        // 用户自己发的表情包：和 agent 发的用同一套「表情格式」渲染（同一枚 .chat-sticker、
        // 同样的边长与比例），只是靠右。以前它走图片附件那条路，会多出一层气泡底和气泡内边距，
        // 同一个表情在两边长得不一样 —— 用户实测指出来的就是这个。
        if (/^\[表情包\]/.test(String(n.text || "")) && (n.atts || []).length === 1 && n.atts[0].dataUrl) {
          const st = n.atts[0];
          const nm = String(n.text).replace(/^\[表情包\]\s*/, "");
          return `
            <div class="msg user">
              <button class="chat-sticker is-own" data-media-open aria-label="查看表情">
                <img src="${esc(st.dataUrl)}" alt="${esc(nm || "表情")}" />
              </button>
            </div>`;
        }
        // 图片/SVG 附件直接渲染进气泡（dataUrl 在 WebView 的 img 里原生可显示，含 image/svg+xml）
        const imgs = (n.atts || []).filter((a) => a && a.dataUrl);
        const grid = imgs.length ? `<div class="msg-imgs">${imgs.map((a) =>
          `<img class="msg-img" src="${a.dataUrl}" alt="${esc(a.name || "图片")}" />`).join("")}</div>` : "";
        // 非图片附件：文件 chip（名字 + 大小）；带 dataUrl 的点开即预览
        const chips = (n.files || []).length ? `<div class="msg-files">${(n.files || []).map((f) => {
          const inner = `${esc(fileGlyph({ name: f.name || "", type: "" }))} ${esc(f.name || "")}<em>${f.size ? fmtSize(f.size) : ""}</em>`;
          return f.dataUrl
            ? `<button class="msg-file is-link" data-file-chip data-url="${f.dataUrl}" data-name="${esc(f.name || "")}">${inner}</button>`
            : `<span class="msg-file">${inner}</span>`;
        }).join("")}</div>` : "";
        // 说出来的一条：气泡画成语音条（可回放），识别出的文字以小字跟在下面便于核对。
        // agent 收到的仍然是这段文字，语音条只是界面的呈现方式。
        if (n.voice && n.voice.clip) {
          const secs = Math.max(1, Math.round((Number(n.voice.dur) || 0) / 1000));
          const bars = "<i></i>".repeat(Math.min(16, Math.max(6, secs * 2)));
          return `<div class="msg user">
            <div class="bubble-user is-voice">
              <button class="vclip" data-vclip="${esc(n.voice.clip)}" aria-label="播放语音">
                <svg class="ico vclip-play"><use href="#i-play"/></svg>
                <span class="vclip-bars">${bars}</span>
                <b class="vclip-sec">${secs}″</b>
              </button>
              <div class="vclip-text">${esc(n.text)}</div>
            </div>${grid}${chips}</div>`;
        }
        return `<div class="msg user"><div class="bubble-user">${esc(n.text)}</div>${grid}${chips}</div>`;
      }

      case "text":
        // 空正文（历史占位/被截断的 live 节点）不渲染，避免出现空气泡
        if (!n.live && !String(n.text || "").trim()) return "";
        return `<div class="msg assistant"><div class="assistant-text">${md(n.text)}</div></div>`;

      /* 流式增量：模型还在生成时就往上长，思考与正文分开 */
      case "pclive": {
        if (!n.text && !n.think) return "";
        // 思考阶段把秒数带上：桌面也是「Deep diving for Ns」，光写「深度思考中」等于丢了时间感
        const secs = n.started ? Math.max(0, Math.floor((Date.now() - n.started) / 1000)) : 0;
        const thinkTitle = n.text ? "思考" : (secs >= 1 ? `深度思考中 · ${secs} 秒` : "深度思考中");
        const think = n.think
          ? `<div class="pc-think is-open">
               <button class="pc-think-head" data-toggle-pcthink>
                 <svg class="ico xs"><use href="#i-d-think"/></svg>
                 <span class="pc-think-title${n.text ? "" : " is-shimmer"}"${n.text ? "" : shimmerAttr()} data-live-secs="${secs}">${esc(thinkTitle)}</span>
               </button>
               <div class="pc-think-body"><div class="pc-think-text">${esc(n.think)}</div></div>
             </div>`
          : "";
        const body = n.text ? `<div class="assistant-text">${md(n.text)}</div>` : "";
        return `<div class="msg assistant">${think}${body}</div>`;
      }

      /* 等待态：鲸尾 + 扫光「深度求索中」，和本机（桌面 RunningStatus 同构）一致 */
      case "pcrunning": {
        // 秒数按这个节点自己的开始时间算：runStatHTML 用的是本机 Live.turnStart，
        // 电脑会话没有那一份，直接借会永远显示 0 秒。
        const secs = Math.max(0, Math.floor((Date.now() - (n.started || Date.now())) / 1000));
        const label = secs >= 2 ? `深度求索中，用时 ${secs} 秒 ···` : "深度求索中";
        return `<div class="msg assistant"><div class="assistant-text">${whaleStatHTML(label)}</div></div>`;
      }

      case "pcthink": {
        // 和工具过程同一套语言：一行灰色文字，展开才看正文。没有底色、没有圆角卡片。
        const running = n.status === "run";
        // 取尾部而不是开头：这一行要一直停在「刚想出来的字」上（尾部锚定见 syncThinkTail）
        const brief = pageClipTail(String(n.text || "").replace(/\s+/g, " "), 160);
        return `
          <div class="msg assistant">
            <div class="pc-think${n.open ? " is-open" : ""}">
              <button class="pc-think-head" data-toggle-pcthink>
                <svg class="ico xs"><use href="#i-d-think"/></svg>
                <span class="pc-think-title">${running ? "深度思考中" : "思考"}</span>
                ${brief && !n.open ? `<span class="pc-think-brief">${esc(brief)}</span>` : ""}
                <svg class="ico chev"><use href="#i-chevron"/></svg>
              </button>
              <div class="pc-think-body"><div class="pc-think-text">${md(n.text || "")}</div></div>
            </div>
          </div>`;
      }

      case "pctools": {
        const items = n.items || [];
        if (!items.length) return "";
        const running = items.filter((x) => x.status === "run").length;
        const failed = items.filter((x) => x.status === "err").length;
        const rows = items.map((x, index) => `
          <div class="pc-tool${x.status === "run" ? " run" : ""}${x.open ? " is-open" : ""}">
            <button class="pc-tool-head" data-pc-tool-item="${index}">
              <svg class="ico xs"><use href="#${toolIconOf(x.name)}"/></svg>
              <span class="pc-tool-name${x.status === "run" ? " is-shimmer" : ""}"${x.status === "run" ? shimmerAttr() : ""}>${esc(TOOL_LABEL[x.name] || x.name || "工具")}</span>
              <span class="pc-tool-meta">${esc(x.meta || "")}</span>
              <span class="pc-tool-state">${x.status === "run" ? '<span class="spinner"></span>' : x.status === "err" ? "失败" : "完成"}</span>
            </button>
            ${x.open ? `<pre class="pc-tool-out">${esc(x.out || "（没有输出）")}</pre>` : ""}
          </div>`).join("");
        return `
          <div class="msg assistant">
            <div class="pc-tools${n.open ? " is-open" : ""}">
              <button class="pc-tools-head" data-toggle-pctools>
                <svg class="ico xs"><use href="#${toolIconOf(items[items.length - 1].name)}"/></svg>
                <span class="pc-tools-title${running ? " is-shimmer" : ""}"${running ? shimmerAttr() : ""}>${items.length} 个工具${running ? " · 运行中" : failed ? " · " + failed + " 个失败" : ""}</span>
                <svg class="ico chev"><use href="#i-chevron"/></svg>
              </button>
              <div class="pc-tools-list">${rows}</div>
            </div>
          </div>`;
      }

      case "search": {
        const items = n.hits || [];
        if (!items.length) return "";
        return `
          <div class="msg assistant">
            <div class="search-card">
              <div class="search-head">
                <span class="search-ico"><svg class="ico xs"><use href="#i-globe"/></svg></span>
                <span class="search-title">联网搜索 · ${items.length} 条来源</span>
              </div>
              <div class="search-list">
                ${items.map((h) => `
                  <button class="search-item" data-open-url="${esc(h.url || "")}">
                    <span class="si-title">${esc(h.title || h.url || "来源")}</span>
                    ${h.snippet ? `<span class="si-snip">${esc(pageClip(h.snippet, 110))}</span>` : ""}
                    <span class="si-host">${esc(hostOf(h.url))}</span>
                  </button>`).join("")}
              </div>
            </div>
          </div>`;
      }

      /* 工具调用：**一律单行**（桌面 client/ui-tool 的 ToolRow 就是 DisclosureRow：
         icon + 标题 + 摘要 + 耗时，点开才看参数/输出）。历史快照里的 tool 节点、
         轮末从过程组抽出来的 toolrow 节点，都走这一套 markup —— 不再有卡片外壳，
         同一件事在对话流里只有一种长相。 */
      case "tool":
      case "toolrow": {
        const m0 = n.kind === "toolrow"
          ? ((n.members && n.members[0]) || {})
          : {
              name: n.name,
              cat: n.tool || "shell",
              title: TOOL_LABEL[n.name] || (TOOL_META[n.tool] || TOOL_META.shell).label || n.name,
              detail: n.meta || "",
              out: n.out || "",
              ms: typeof n.dur === "number" ? n.dur : (parseFloat(String(n.dur || "")) || 0),
              status: n.status === "run" ? "run" : (n.status === "err" ? "err" : "done"),
              diff: null,
            };
        return `<div class="msg assistant tool-line">${toolRowHTML(m0, 0)}</div>`;
      }

      /* 意图分析：内核给出的路由结论，只在需要动手/检索时露一行，避免打扰 */
      case "intent":
        // 已下线：意图打分卡对用户没有信息量（内部路由即可），历史快照里残留的也不再渲染
        return "";

      case "todo": {
        const done = n.items.filter((i) => i.state === "done").length;
        return `
          <div class="msg assistant">
            <div class="todo-card">
              <div class="todo-head">
                <svg class="ico xs" style="color:var(--green)"><use href="#i-tasks"/></svg>
                <b>执行计划</b>
                <span class="todo-progress">${done}/${n.items.length}</span>
              </div>
              ${n.items.map((i) => `
                <div class="todo-row ${i.state}">
                  <span class="todo-box"><svg class="ico"><use href="#i-check"/></svg></span>
                  <span>${esc(i.text)}</span>
                </div>`).join("")}
            </div>
          </div>`;
      }

      case "approval":
        return `
          <div class="msg assistant">
            <div class="approval ${n.resolved ? "is-resolved" : ""}" data-approval>
              <div class="approval-top">
                <span class="approval-ico"><svg class="ico"><use href="#i-shield"/></svg></span>
                <div>
                  <div class="approval-title">${esc(n.title)}</div>
                  <div class="approval-sub">${esc(n.desc)}</div>
                </div>
              </div>
              <pre class="approval-cmd"><span class="p">$ </span>${esc(n.cmd)}</pre>
              ${n.mission ? `<div class="approval-sub">属于这件事：${esc(n.mission)}</div>` : ""}
              <div class="approval-actions">
                <button class="deny" data-approve="deny">拒绝</button>
                <button data-approve="once">允许一次</button>
                <button class="always" data-approve="always">始终允许</button>
              </div>
              ${n.resolved ? `<div class="approval-result">${esc(n.result || "")}</div>` : ""}
            </div>
          </div>`;

      /* 计划模式：相当于桌面版的计划评审面板，搬到对话流里就地批准/打回 */
      case "plan": {
        const st = n.status || "pending";
        const tags = { pending: "待批准", approved: "已批准", revised: "待修订", rejected: "已结束" };
        return `
          <div class="msg assistant">
            <div class="plan-card is-${st}" data-plan-id="${esc(n.pid || "")}" data-plan-card>
              <div class="plan-head">
                <span class="plan-ico"><svg class="ico xs"><use href="#i-plan"/></svg></span>
                <b>${esc(n.title || "执行计划")}</b>
                <span class="plan-tag">${tags[st] || ""}</span>
              </div>
              <div class="plan-body assistant-text">${md(n.plan || "")}</div>
              ${st === "pending" ? `
              <div class="plan-actions" data-plan-actions>
                <button class="deny" data-plan-act="reject">结束</button>
                <button data-plan-act="revise">要求修改</button>
                <button class="approve" data-plan-act="approve">批准执行</button>
              </div>
              <div class="plan-revise" data-plan-revise hidden>
                <textarea rows="3" placeholder="说说要改什么，例如：第 2 步先别动数据库，补一个测试再改"></textarea>
                <button class="btn-primary" data-plan-act="send-revise">提交修改意见</button>
              </div>` : ""}
              ${n.note ? `<div class="plan-note">${esc(n.note)}</div>` : ""}
            </div>
          </div>`;
      }

      case "goalround":
        return `<div class="goal-round"><span>目标推进 · ${n.max ? `第 ${n.round}/${n.max} 轮` : `第 ${n.round} 轮 · 智能`}</span></div>`;

      case "goalresult":
        return `
          <div class="msg assistant">
            <div class="goal-result is-${n.status}">
              <svg class="ico xs"><use href="#${n.status === "complete" ? "i-check" : n.status === "edited" ? "i-goal" : "i-shield"}"/></svg>
              <b>${n.status === "complete" ? "目标已完成" : n.status === "created" ? "目标已建立" : n.status === "edited" ? "目标已更新" : "目标受阻"}</b>
              <span>${esc(n.summary || "")}</span>
            </div>
          </div>`;
    }
    return "";
  }

  /** 给节点分配稳定 uid，供局部替换定位 */
  function nodeUid(n) {
    if (!n.__uid) n.__uid = "n" + Math.random().toString(36).slice(2, 9);
    return n.__uid;
  }
  function nodeHTMLUid(n) {
    // 先赋 uid 再渲染：footer 的模板里就读 n.__uid（data-turn-usage），
    // 以前的顺序是「渲染 → 赋 uid」，按钮上的 uid 永远是空串，用量面板点不开。
    const uid = nodeUid(n);
    // 节点 HTML 缓存：已 settle 的 text 节点按 uid 命中即跳过 md()/highlight 重算，
    // 避免重绘（切会话/批量更新）时每条重新解析 markdown。
    // 「在流里」要看节点上的 live 标记，不能拿 `n !== Live.textNode` 当判据：那样只豁免主对话
    // 那一个节点，成员视图的在跑气泡（另一个对象）第一口就被缓存住，之后 patchNode 每次拿回
    // 同一段旧 HTML，morph 认为没变化 → 屏上的字永远停在第一次渲染的长度（实测 65 字不动）。
    const cacheable = n.kind === "text" && !n.live && !!uid;
    if (cacheable) {
      const hit = nodeHTMLUid._cache.get(uid);
      if (hit) return hit;
    }
    const html = nodeHTML(n).replace(/^(\s*<div )/, `$1data-uid="${uid}" `);
    if (cacheable) {
      if (nodeHTMLUid._cache.size >= 800) nodeHTMLUid._cache.clear();
      nodeHTMLUid._cache.set(uid, html);
    }
    return html;
  }
  nodeHTMLUid._cache = nodeHTMLUid._cache || new Map();

  /** 由 DOM 节点找回模型节点（开合状态存在模型上，重绘后不会丢） */
  function nodeByUid(uid) {
    if (!uid) return null;
    for (let i = thread.length - 1; i >= 0; i--) {
      if (thread[i] && thread[i].__uid === uid) return thread[i];
    }
    return null;
  }

  /**
   * 长上下文渲染：尾部优先，历史分帧补齐。
   *
   * 以前是一次性 `innerHTML = thread.map(...)`：几百条消息（markdown/代码块/图片）
   * 同步解析 + 排版，长会话重开要白屏卡好几秒；中途事件触发的重绘也会整表重建。
   * 现在尾部 40 条先出（用户看到的永远是最新消息），更早的历史每帧往前补一批，
   * 补的时候自己锚定视口（#chatScroll 已禁 overflow-anchor，避免双重补偿打架）。
   */
  const RENDER_FIRST = 40;      // 首屏一次出的条数
  const RENDER_BATCH = 60;      // 每帧往前补的条数
  const RENDER_CHUNK = 12;      // 首屏尾部队每帧 append 的条数（分摊同步解析开销，避免卡一帧）
  let renderFillRaf = 0;        // 进行中的补渲染任务：新一轮重绘要先掐掉，不然两套批次互相插入
  let renderHeadRaf = 0;        // 首屏尾部队的分批 append 任务
  let renderTailFrom = 0;       // 尾部队下一个要灌的 thread 下标：push 用它判断 DOM 是否落后于 thread

  function renderThread() {
    if (renderFillRaf) { cancelAnimationFrame(renderFillRaf); renderFillRaf = 0; }
    if (renderHeadRaf) { cancelAnimationFrame(renderHeadRaf); renderHeadRaf = 0; }
    const host = $("#messages");
    host.textContent = "";    const first = Math.max(0, thread.length - RENDER_FIRST);
    const scRt = $("#chatScroll");
    const stick = followBottomOn || chatAtBottom();
    if (stick) {
      // 首屏尾部队也分批 rAF append：避免一次性同步解析 40 条 markdown/高亮卡一帧；
      // 每批后同帧贴底，观感与一次性出一致（只是摊到几帧），不改视觉结果。
      let head = first;
      renderTailFrom = first;
      const fillHead = () => {
        renderHeadRaf = 0;
        const end = Math.min(thread.length, head + RENDER_CHUNK);
        host.insertAdjacentHTML("beforeend", thread.slice(head, end).map(nodeHTMLUid).join(""));
        renderTailFrom = head = end;
        if (scRt) ChatScroll.toBottom(scRt);
        if (head < thread.length) renderHeadRaf = requestAnimationFrame(fillHead);
        else { applyVoiceOnly(); syncChatTopFade(); }
      };
      if (first < thread.length) renderHeadRaf = requestAnimationFrame(fillHead);
      else { renderTailFrom = thread.length; applyVoiceOnly(); syncChatTopFade(); }
    } else {
      // 非贴底（用户在历史中部）：同步出首屏，保持原行为，避免历史跳动；
      // 重建清空会让 scrollHeight 塌成 0、scrollTop 被钳 0，下一帧再还原。
      if (first < thread.length) host.insertAdjacentHTML("beforeend", thread.slice(first).map(nodeHTMLUid).join(""));
      renderTailFrom = thread.length;
      applyVoiceOnly();
      syncChatTopFade();
      syncThinkTail();
      if (scRt) { const prevTop = scRt.scrollTop; requestAnimationFrame(() => { ChatScroll._write(scRt, prevTop); }); }
    }

    let filled = first;
    const fill = () => {
      renderFillRaf = 0;
      if (filled === 0) { applyVoiceOnly(); return; }
      const s = Math.max(0, filled - RENDER_BATCH);
      const sc = $("#chatScroll");
      // 锚定：记「视口底边距文档底的距离」，插入后把 scrollTop 补回同值，视口纹丝不动
      const before = sc ? (sc.scrollHeight - sc.scrollTop) : 0;
      host.insertAdjacentHTML("afterbegin", thread.slice(s, filled).map(nodeHTMLUid).join(""));
      if (sc && before > 0) ChatScroll._write(sc, sc.scrollHeight - before);
      filled = s;
      renderFillRaf = requestAnimationFrame(fill);
    };
    if (first > 0) renderFillRaf = requestAnimationFrame(fill);
    rebindLiveDom();
    try { ChatExtras.refresh(); } catch (_) {}
  }

  /**
   * 整表重绘后把「流式正文容器」重新绑到新 DOM 上。
   *
   * `renderThread()` 是清空 + 重灌，旧元素全被移除；`Live.textEl` 还指着它们，
   * 后续 delta 就写进游离节点 —— 现象是「只有终止按钮、正文一片空白」。
   * 节点本身带 data-uid，按它找回外层再取正文容器即可。
   * 流式没在跑（无 textNode）时什么都不做。
   */
  function rebindLiveDom() {
    if (!Live.textNode) return;
    const uid = Live.textNode.__uid;
    const wrap = uid ? document.querySelector(`#messages [data-uid="${uid}"]`) : null;
    Live.textEl = wrap ? wrap.querySelector(".assistant-text") : null;
  }

  /**
   * 「纯语音回复」的文字折叠。
   *
   * 以前是在插入语音条的那一刻用 `anchorEl.style.display = "none"` 直接改 DOM：
   *  · 语音还在合成（或合成失败）时，文字已经先藏了 → 界面上什么都没有，
   *    用户以为回复丢了，直到下一轮重绘才冒出来；
   *  · 这是 DOM 级状态，任何一次重绘都会丢 → 下一轮文字和语音条同时出现，
   *    看起来就是「语音重复渲染」。
   * 现在改成渲染期规则：**语音真的可以播了**才折叠它前面那条文字，
   * 折叠状态每次重绘都会重新算一遍，稳定且可逆。
   */
  function applyVoiceOnly() {
    document.querySelectorAll('#messages [data-voice-only="1"]').forEach((el) => {
      const node = nodeByUid(el.dataset.uid);
      if (!node || !node.dataUrl) return;              // 还没合成好 / 失败：文字留着
      let prev = el.previousElementSibling;
      while (prev && !prev.classList.contains("msg")) prev = prev.previousElementSibling;
      if (prev && prev.classList.contains("assistant") && !prev.hasAttribute("data-voice-only")) {
        prev.style.display = "none";
      }
    });
  }

  /* ================= 陪伴式畅聊（内核插件 companion 的前端侧） =================
     设计上分三层，各管一段，谁都不越界：
       · 插件（Kotlin）：什么时候**可以**开口 —— 心跳、免打扰时段、每日上限、待跟进线索；
       · 这里（前端）：什么时候**适合**开口 —— 应用在前台、人在对话页、没在生成中；
       · 模型：到底说什么 —— 由人设 + 最近对话 + 线索决定，没话说就回 SILENT。
     三者缺一就会出现「像推送」而不是「像朋友」：只有定时器 = 骚扰，只有模型 = 永远不主动。 */
  const Companion = {
    c: null,
    DEFAULTS: {
      enabled: false, cadence: "normal", quietStart: 23, quietEnd: 8,
      style: "auto", countToday: 0, day: "", lastSpokeAt: 0, threads: [],
      nextDueAt: 0, dueCadence: "", voiceReply: false, silentStreak: 0,
    },
    /* 间隔是区间不是定值：真人不会整点来消息。每次问模型之前从区间里抽一个，
       写进 nextDueAt，心跳只对表。Kotlin 侧 CompanionPlugin.cadenceWindow 有同值副本。 */
    CADENCE: {
      quiet: { min: 60, max: 120, cap: 12, name: "安静", desc: "一到两小时，随口一句" },
      // 适中：25–55 → 20–45。原来窗口偏长，加上提示词偏保守，实测一天也就两三句，
      // 用户体感是「开了没感觉」。窗口略收紧，并给「连续沉默 3 次」加一次强制开口。
      normal: { min: 20, max: 45, cap: 24, name: "适中", desc: "二十来分钟到一小时，想起来就聊" },
      // 「话多」是用户明确要求「多主动」的档位：窗口压到 6–18 分钟，且提示词放宽
      // SILENT 的条件（见 system()）——此前 10–30 分钟 + 严格 SILENT 纪律，
      // 实测用户开着最强档一整天几乎收不到一句。
      chatty: { min: 6, max: 18, cap: 48, name: "话多", desc: "十来分钟就想搭一句话" },
    },
    STYLES: [
      { id: "auto", name: "随性", desc: "像熟人，自然就好" },
      { id: "warm", name: "温柔", desc: "先关心感受，语气软" },
      { id: "teasing", name: "损友", desc: "会开小玩笑，轻轻吐槽" },
      { id: "calm", name: "安静", desc: "话很少，只挑重要的" },
    ],

    cfg() {
      if (this.c) return this.c;
      let o = {};
      try { o = JSON.parse(Native && Native.companionState ? Native.companionState() : "{}") || {}; } catch (_) {}
      // 原来写的是 `Array.isArray(o.threads) ? o : {}`：只要文件里还没写过 threads
      // （开启后一次都没记过线索就是这种状态），整份配置会被丢掉 —— 开关、档位、免打扰
      // 全部回默认，用户重开应用就觉得「陪伴自己关了」。这里只挑对象合并。
      this.c = Object.assign({}, this.DEFAULTS, o && typeof o === "object" ? o : {});
      if (!Array.isArray(this.c.threads)) this.c.threads = [];
      return this.c;
    },

    save(patch) {
      const wasOn = !!this.cfg().enabled;
      this.c = Object.assign({}, this.cfg(), patch);
      let extra = null;
      if (!wasOn && this.c.enabled) {
        // 刚打开：给一个「很快」的首个窗口（1–2 分钟）。
        // 以前沿用文件里的旧 nextDueAt，可能已经是半小时后 —— 用户当场等不到任何反应，
        // 就会认为这功能根本没生效。
        extra = {
          nextDueAt: Date.now() + 60_000 + Math.round(Math.random() * 60_000),
          dueCadence: this.c.cadence || "normal",
          day: this.dayKey(),
          countToday: 0,
          lastSkip: "",
        };
        this.c = Object.assign({}, this.c, extra);
      }
      try { Native.companionSave(JSON.stringify(extra ? Object.assign({}, patch, extra) : patch)); } catch (_) {}
      this.syncValue();
      // 档位/人设/线索一变，原生引擎手里的提示词就过期了：立刻重发
      this.pushContextSoon();
      return this.c;
    },

    /** 当前档位参数。**数字只来自 Kotlin**（companionState().cadenceTable）；
     *  本地 CADENCE 仅作老版本原生侧的兜底，别在这里改数字。 */
    cad() {
      const id = this.cfg().cadence || "normal";
      const t = (this.cfg().cadenceTable || {})[id];
      const local = this.CADENCE[id] || this.CADENCE.normal;
      if (!t) return local;
      return {
        min: Number(t.min) || local.min,
        max: Number(t.max) || local.max,
        cap: Number(t.cap) || local.cap,
        name: t.name || local.name,
        desc: local.desc,
      };
    },

    /**
     * 抽下一个开口窗口。
     * 区间上下限优先用插件心跳带过来的（gapMin/gapMax）—— 单一来源在 Kotlin，
     * 这里只是兜底，避免两边配置改漏一个就退化成固定节奏。
     */
    nextGap(beat) {
      const c = this.cad();
      const lo = Math.max(1, Number(beat && beat.gapMin) || c.min);
      const hi = Math.max(lo + 1, Number(beat && beat.gapMax) || c.max);
      const min = lo + Math.random() * (hi - lo);
      return { at: Date.now() + Math.round(min) * 60000, min: Math.round(min) };
    },
    styleName() { const s = this.STYLES.find((x) => x.id === this.cfg().style); return s ? s.name : "随性"; },

    label() {
      const c = this.cfg();
      if (!c.enabled) return "未开启";
      const q = c.quietStart === c.quietEnd ? "不静默" : `${pad2(c.quietStart)}–${pad2(c.quietEnd)} 静默`;
      return `已开启 · ${this.cad().name} · ${q}`;
    },

    syncValue() {
      const v = $("#companionValue");
      if (v) v.textContent = this.label();
    },

    dayKey() {
      const d = new Date();
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    },

    todayCount() {
      const c = this.cfg();
      return c.day === this.dayKey() ? (Number(c.countToday) || 0) : 0;
    },

    quietNow() {
      const c = this.cfg();
      const s = Number(c.quietStart), e = Number(c.quietEnd);
      if (s === e) return false;
      const h = new Date().getHours();
      return s < e ? (h >= s && h < e) : (h >= s || h < e);
    },

    /** 到点了要不要真的开口 —— 这里的每条判断都是「不打扰」的一部分 */
    due(beat) {
      const c = this.cfg();
      if (!c.enabled) return "未开启";
      if (!Native || !Native.chatStream) return "当前环境不支持";
      // 模型没配好 / 网络不通时，以前是静默重试，用户完全看不出为什么一次都不说
      if (!this.modelReady()) return "模型不可用（换个模型或检查网络）";
      if (state.busy) return "正在对话";
      // 后台也允许开口（v1.1）：消息落进会话 + 系统通知 —— 这正是「主动触发性」的来源，
      // 心跳由前台保活服务撑着，后台/锁屏不再缺席。免打扰与上限照常生效。
      // 手动「试试」的入口本来就在设置面板里，不受这条影响。
      if (this.quietNow() && !beat.manual) return "免打扰时段";
      const cap = this.cad().cap;
      if (this.todayCount() >= cap) return "今天说得够多了";
      const last = Number(c.lastSpokeAt) || 0;
      if (!beat.manual && last && Date.now() - last < this.cad().min * 60000) return "还没到间隔";
      if (this.pending) return "上一句还没说完";
      return "";
    },

    system(beat) {
      const c = this.cfg();
      const styleLine = {
        auto: "语气：自然、像熟人，不必刻意热络。",
        warm: "语气：偏软一点，先接住感受再说话，别急着给建议。",
        teasing: "语气：可以开个小玩笑、轻轻吐槽一句，但别过火。",
        calm: "语气：话很少，语气平，只在真值得说的时候开口。",
      }[c.style] || "";
      const p = (PERSONAS.find((x) => x.id === state.persona) || {}).text || "";
      const mem = state.globalMem ? GlobalMem.all().map((x) => x.text).slice(0, 12) : [];
      const threads = (beat.threads && beat.threads.length)
        ? beat.threads.map((t) => "- " + (t.text || "")).join("\n")
        : "- （没有记下的线索）";
      // 手动「试试」= 用户主动想听一句：这时必须开口，SILENT 会把测试入口变成「点了没反应」
      const manual = !!(beat && beat.manual);
      const cadence = c.cadence || "normal";
      const streak = Number(beat && beat.silentStreak) || 0;
      // 开口纪律必须跟档位走：以前不分档一律「没由头就 SILENT」，
      // 前端把「话多」窗口调得再短，模型照样句句沉默 —— 用户看到的就是「最强档没反应」。
      let discipline;
      if (manual) {
        discipline = "1) 这次是他主动点「试试」想听你说一句：必须说话，不要回 SILENT。";
      } else if (cadence === "chatty") {
        discipline = streak >= 2
          ? `1) 你已经连续 ${streak} 次没开口了。这次必须说一句：随便挑个真实由头（现在几点、多久没聊、上次提到的事、他这会儿可能在做什么），不要回 SILENT。`
          : "1) 现在是最主动的档位：只要有一点由头就说一到两句——时间、上次聊到的事、他可能正在做的事都算；只有你确定他在忙或刚说过别聊，才回 SILENT。";
      } else if (cadence === "quiet") {
        // 安静档也设上限：连着 4 次沉默就允许轻轻问一句，否则「安静」会退化成「哑巴」。
        discipline = streak >= 4
          ? `1) 你已经连续 ${streak} 次没开口了。这次可以轻轻问一句（现在几点、隔了多久、他之前提过的小事），不必等特别好的由头。`
          : "1) 没有真实由头就别开口，只回四个字母 SILENT（前端会吞掉，不显示）。";
      } else {
        // 适中档：默认「有由头就说」，连续沉默 3 次同样强制一次 —— 这是「主动性」的保底。
        discipline = streak >= 3
          ? `1) 你已经连续 ${streak} 次没开口了。这次挑个真实由头说一到两句（时间、上次聊到的事、他这会儿可能在忙什么）。`
          : "1) 有由头就说一到两句；别为了安静而沉默 —— 只要接得上上次的话，那就是由头。";
      }
      return [
        "你在这台手机上陪着一个人。现在不是他找你办事，是你自己想起了他。",
        p ? `他给你的人设：${p}` : "",
        "说话方式：像朋友发微信 —— 一到两句，短、具体、接得上上次聊的；可以用口语、有点情绪。",
        styleLine,
        "纪律：",
        discipline,
        "2) 不追问、不连环问、不总结陈词、不列清单、不用 Markdown、不加小标题。",
        "3) 不编造他的生活细节；不确定就轻轻问一句。",
        manual ? "" : "4) 他明显在忙、刚说过别聊、或者你只是想说「我还在」—— 都回 SILENT。",
        mem.length ? "你记得关于他的事：\n" + mem.map((x) => "- " + x).join("\n") : "",
        "还没结掉的线索：\n" + threads,
      ].filter(Boolean).join("\n");
    },

    nudge(beat) {
      const hh = pad2(new Date().getHours()) + ":" + pad2(new Date().getMinutes());
      const since = Number(beat.sinceUserMin);
      const gap = since >= 0 ? `距他上次说话 ${since} 分钟` : "有一阵没聊了";
      const quota = `${this.todayCount() || 0}/${this.cad().cap}`;
      // 手动测试时不能同时给「没有就回 SILENT」的出口，否则模型一句沉默就把测试吞了
      if (beat && beat.manual) {
        return `（内部提示：现在 ${hh}，他手动点了「试试」，就是想听你说一句。直接说一到两句，别说 SILENT。）`;
      }
      const cad = this.cfg().cadence || "normal";
      const streak = Number(this.cfg().silentStreak) || 0;
      const tail =
        cad === "chatty"
          ? (streak >= 2
            ? "你已经连续几次没开口了，这次直接说一句，不要回 SILENT。"
            : "这是最主动的档位：有一个由头就说一两句，别回 SILENT。")
          : cad === "quiet"
            ? (streak >= 4
              ? "隔了很久了，这次可以轻轻问一句。"
              : "没有真实由头就回 SILENT。")
            : (streak >= 3
              ? "你已经连续几次没开口了，这次挑个由头说一两句。"
              : "有由头就说一两句；别为了安静而沉默。");
      return `（内部提示：现在 ${hh}，${gap}，今天你已经主动说过 ${quota} 次。）` + tail;
    },

    /** 手动「试试」走这里；自动心跳已由原生引擎负责（见 drain） */
    async onBeat(beat) {
      beat = beat || {};
      if (!beat.manual) return this.drain();
      const why = this.due(beat);
      // 诊断：把「这次为什么没说」记下来，设置面板能直接看到，
      // 不用再靠猜「是不是根本没跑」
      if (!beat.manual) {
        const c = this.cfg();
        if (c.lastSkip !== why || Math.abs(Date.now() - (Number(c.lastBeatAt) || 0)) > 120000) {
          this.save({ lastBeatAt: Date.now(), lastSkip: why || "" });
        }
      }
      if (why) {
        if (beat.manual) toast("这次先不说：" + why, 2400);
        return "";
      }
      // 不在对话页时不切页：先把话落进会话，再提示一声，用户点开就能看到
      const onChat = state.screen === "chat";
      if (onChat) {
        if (this.ensureSession() && !beat.manual) go("chat");
      } else {
        this.companionSessionId();
      }
      this.pending = true;
      // 先抽下一个窗口再问：哪怕它这次回 SILENT，这次机会也算用掉了。
      // 否则插件每分钟都会来敲一次，既费电，也容易在刚沉默完立刻又开口。
      if (!(beat && beat.manual)) {
        const gap = this.nextGap(beat);
        this.save({ nextDueAt: gap.at, dueCadence: this.cfg().cadence });
      }
      try {
        // 连续沉默次数要真的传进提示词：话多档连沉默两次后强制开口，
        // 否则「窗口越来越密、模型永远 SILENT」= 用户还是收不到话。
        const streak0 = Number(this.cfg().silentStreak) || 0;
        const text = await this.ask(Object.assign({}, beat || {}, { silentStreak: streak0 }));
        if (!text) {
          if (!(beat && beat.manual)) this.save({ silentStreak: streak0 + 1 });
          if (beat && beat.manual) toast("它想了想，这次不打扰你", 2400);
          return "";
        }
        this._apply(text, false);
        return text;
      } catch (e) {
        // 问失败（模型没配好 / 接口挂了）不算「用掉一次机会」：退避 3 分钟再试，
        // 既不会白等一个整窗口，也不会每分钟轰炸一次。
        // 但**必须把原因记下来**：以前自动心跳失败是静默的，用户看不到任何反馈，
        // 就得到「开了跟没开一样」的结论 —— 而真相只是模型连不上。
        const reason = "开口失败：" + String((e && e.message) || e || "未知错误").slice(0, 60);
        if (!(beat && beat.manual)) {
          this.save({ nextDueAt: Date.now() + 180_000, lastBeatAt: Date.now(), lastSkip: reason });
        }
        if (beat && beat.manual) toast("没能开口：" + (e.message || e), 2600);
        return "";
      } finally {
        this.pending = false;
      }
    },

    /**
     * 把一句主动消息落进对话。两条路径共用：
     *   · fromNative=false —— 手动「试试」，计数与通知由这里做；
     *   · fromNative=true  —— 原生引擎已生成（它在原生侧就写好了次数/时间，并已发过通知），
     *     这里只负责「让它出现在该出现的会话里」。
     */
    _apply(text, fromNative) {
      const node = NODES.text(text);
      node.proactive = true;
      const bg = document.visibilityState !== "visible";
      if (state.screen === "chat") {
        push(node);
        persistThread();
        try { LocalDB.push(state.sessionId, { role: "assistant", content: text }); } catch (_) {}
      } else {
        // 不在对话页：只落库 + 提示，别把人从正在看的设置里拽走
        const sid = this.companionSessionId();
        try { LocalDB.push(sid, { role: "assistant", content: text }); } catch (_) {}
        try { LocalDB.touch && LocalDB.touch(sid); } catch (_) {}
        this.unread = (this.unread || 0) + 1;
        try { renderSessions(); } catch (_) {}
      }
      if (state.screen !== "chat" || bg) {
        const sid = this.companionSessionId();
        if (!bg) toast(text.length > 26 ? text.slice(0, 26) + "…" : text, 3200);
        // 原生侧再判一次「应用可见且正看着这个会话」才压制；原生引擎那条已经弹过就不重复
        if (!fromNative) { try { attentionNotify("你的伙伴", text, sid); } catch (_) {} }
      }
      if (!fromNative) {
        this.save({
          lastSpokeAt: Date.now(),
          day: this.dayKey(),
          countToday: this.todayCount() + 1,
          spokeTotal: (Number(this.cfg().spokeTotal) || 0) + 1,
          silentStreak: 0,
        });
      }
      haptic("light");
      // 语音闭环：它说你就听见；开了「语音回聊」的话，说完自动接麦等你回一句
      if (SpeechOut.on()) {
        try {
          const vn = SpeechOut.speakAsVoice(text, 1, { autoPlay: true });
          if (vn && this.cfg().voiceReply) {
            VoicePlay.onEnded = () => { try { Companion.startVoiceReply(); } catch (_) {} };
          }
        } catch (_) {}
      }
      return text;
    },

    /**
     * 领走原生引擎已经生成的消息。
     *
     * 应用不在前台时，生成发生在原生前台服务里（没有 WebView 也能问模型），
     * 消息先写进 `companion-outbox.json`；用户回到应用、或应用还在前台时，
     * 这里把它们补进对话并回执。**这是「不在界面也能收到一句话」的落地端。**
     */
    drain() {
      if (!Native || !Native.companionOutbox) return 0;
      let list = [];
      try { list = JSON.parse(Native.companionOutbox() || "[]"); } catch (_) { return 0; }
      if (!Array.isArray(list) || !list.length) return 0;
      const ids = [];
      let n = 0;
      for (const it of list) {
        const id = String((it && it.id) || "");
        if (id) ids.push(id);
        const text = String((it && it.text) || "").trim();
        if (!text) continue;
        this._apply(text, true);
        n++;
      }
      try { Native.companionOutboxAck(ids.join(",")); } catch (_) {}
      // 次数/上次开口已经被原生改过，丢掉缓存让面板与 due() 读到新值
      this.c = null;
      try { this.syncValue(); } catch (_) {}
      return n;
    },

    /** 把生成侧要用的上下文落到原生（端点/Key、system、nudge 模板、最近几条对话）。
     *  措辞全在这里，Kotlin 只负责挑模板 + 替换占位符。 */
    pushContext() {
      if (!Native || !Native.companionModel) return;
      const c = this.cfg();
      const m = findModel(state.model);
      const ep = m && endpointOf(m);
      if (!c.enabled || !ep || !ep.url) {
        // 关掉/没有可用模型时把端点清空：引擎下次 tick 会记「模型未配置」而不是瞎发请求
        try { Native.companionModel(JSON.stringify({ url: "" })); } catch (_) {}
        return;
      }
      const nd = this.nudges();
      const recent = (thread || [])
        .filter((n) => n && (n.kind === "user" || n.kind === "text") && n.text)
        .slice(-8)
        .map((n) => ({ role: n.kind === "user" ? "user" : "assistant", content: String(n.text).slice(0, 800) }));
      const payload = {
        url: ep.url,
        key: ep.key || "",
        model: m.upstream || m.id,
        maxTokens: 220,
        // 基础 system（不含「连续沉默」那档）：那部分由引擎按实时 streak 用 nudgeForce 表达
        system: this.system({ threads: c.threads || [], silentStreak: 0 }),
        phrases: nd.phrases,
        nudge: nd.nudge,
        nudgeForce: nd.nudgeForce,
        streakForce: nd.streakForce,
        recent,
        at: Date.now(),
      };
      try { Native.companionModel(JSON.stringify(payload)); } catch (_) {}
    },

    /** 防抖：一轮对话结束/切前后台都可能触发，1.5s 内的重复调用合成一次 */
    pushContextSoon() {
      clearTimeout(this._pcTimer);
      this._pcTimer = setTimeout(() => { try { this.pushContext(); } catch (_) {} }, 1500);
    },

    /** 原生引擎用的 nudge 模板。占位符：{hh} {gap} {since} {count} {cap} {streak} */
    nudges() {
      const cad = this.cfg().cadence || "normal";
      const head = "（内部提示：现在 {hh}，{gap}，今天你已经主动说过 {count}/{cap} 次。）";
      const phrases = { gapKnown: "距他上次说话 {since} 分钟", gapUnknown: "有一阵没聊了" };
      const map = {
        chatty: {
          streakForce: 2,
          nudge: head + "这是最主动的档位：有一个由头就说一两句，别回 SILENT。",
          nudgeForce: head + "你已经连续 {streak} 次没开口了，这次直接说一句，不要回 SILENT。",
        },
        quiet: {
          streakForce: 4,
          nudge: head + "没有真实由头就回 SILENT。",
          nudgeForce: head + "隔了很久了，这次可以轻轻问一句。",
        },
        normal: {
          streakForce: 3,
          nudge: head + "有由头就说一两句；别为了安静而沉默。",
          nudgeForce: head + "你已经连续 {streak} 次没开口了，这次挑个由头说一两句。",
        },
      };
      return Object.assign({ phrases }, map[cad] || map.normal);
    },

    /** 一次性问模型（不走主气泡/工具循环）：陪伴只要一句话，不需要一整轮 Agent */
    async ask(beat) {
      const m = findModel(state.model);
      const ep = m && endpointOf(m);
      if (!ep || !ep.url) throw new Error("当前模型未配置");
      // 上下文优先取界面上这条会话的 thread：它比本地库新（正在说的这一轮还没落库），
      // 会话刚被切换/恢复时也比 messages 全。库里那份只作兜底。
      const fromThread = (thread || [])
        .filter((n) => n && (n.kind === "user" || n.kind === "text") && n.text)
        .slice(-12)
        .map((n) => ({ role: n.kind === "user" ? "user" : "assistant", content: String(n.text).slice(0, 1200) }));
      const fromDb = ((LocalDB.get(state.sessionId) || {}).messages || [])
        .filter((x) => x && x.content && (x.role === "user" || x.role === "assistant"))
        .slice(-12)
        .map((x) => ({ role: x.role, content: String(x.content).slice(0, 1200) }));
      const hist = fromThread.length ? fromThread : fromDb;
      const msgs = [
        { role: "system", content: this.system(beat) },
        ...hist,
        { role: "user", content: this.nudge(beat) },
      ];
      const r = await Kernel.once(msgs);
      let t = String((r && r.text) || "").trim();
      if (!t) return "";
      if (/^SILENT\b/i.test(t)) return "";
      // 模型偶尔仍会带上引号或前缀，剥掉
      t = t.replace(/^(主动说[:：]|消息[:：])\s*/, "").replace(/^["「]([\s\S]*)["」]$/, "$1").trim();
      return t.slice(0, 300);
    },

    /** 主动说话必须落在「一个看得见的会话」里：否则消息写进空 thread 或旧会话，
     *  用户点完「试试」界面上什么都没有，只能认为功能坏了。
     *  优先用最后活跃的那个会话（陪伴就该在熟悉的那条对话里说话），实在没有才新建。 */
    ensureSession() {
      if (state.sessionId && LocalDB.get(state.sessionId)) return false;
      const list = (LocalDB.all() || []).slice()
        .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
      const last = list[0];
      if (last) {
        // 复用最近会话：openSession 会加载历史、切到对话页，消息就落在用户看得见的地方
        openSession(last.id);
        return false;
      }
      const s = LocalDB.create("陪伴");
      state.sessionId = s.id;
      adoptThread(s.id);           // 新会话 = 新的一份对话流
      renderThread();
      $("#chatTitle").textContent = s.title;
      $("#chatSub").textContent = "本地 · " + modelLabel();
      return true;
    },

    /** 现在这个模型能不能真的问出话来（陪伴开口的前置条件） */
    modelReady() {
      const m = typeof findModel === "function" ? findModel(state.model) : null;
      const ep = m && typeof endpointOf === "function" ? endpointOf(m) : null;
      return !!(ep && ep.url);
    },

    /** 运行状态：设置面板直接显示「下次窗口 / 上次心跳 / 上次跳过原因」
     *  这样"到底跑没跑、为什么没说话"一眼能看到，不用猜。 */
    diag() {
      const c = this.cfg();
      const now = Date.now();
      const next = Number(c.nextDueAt) || 0;
      const ago = (ts) => {
        const m = Math.max(0, Math.round((now - ts) / 60000));
        return m < 60 ? `${m} 分钟前` : `${Math.floor(m / 60)} 小时前`;
      };
      return {
        next: !c.enabled ? "—" : (next > now ? `${Math.max(1, Math.round((next - now) / 60000))} 分钟后` : "随时"),
        lastBeat: Number(c.lastBeatAt) ? ago(Number(c.lastBeatAt)) : "还没跑",
        lastSpoke: Number(c.lastSpokeAt) ? ago(Number(c.lastSpokeAt)) : "还没说过",
        skip: c.lastSkip || "—",
      };
    },

    /** 陪伴消息的落点：当前会话 → 最近会话 → 新建「陪伴」 */
    companionSessionId() {
      if (state.sessionId && LocalDB.get(state.sessionId)) return state.sessionId;
      const list = (LocalDB.all() || []).slice()
        .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
      if (list[0]) return list[0].id;
      try { return LocalDB.create("陪伴").id; } catch (_) { return state.sessionId; }
    },

    async tryNow() {
      // 先把界面上该有的东西准备好：进对话页 + 保证有一个真实会话，
      // 再判定能不能说；否则「不在对话页」会把手动测试挡在门外
      go("chat");
      this.ensureSession();
      const why = this.due({ manual: true });
      if (why) { toast("这次先不说：" + why, 2400); return; }
      // 等待期要有持续反馈：模型一次问答可能十几秒，1.6s 的 toast 一闪而过，
      // 用户只会觉得「点了没反应」。完成后成功气泡/错误提示会顶掉它。
      toast("让它想一句…", 60000);
      try {
        await this.onBeat({ manual: true, threads: this.cfg().threads || [] });
      } finally {
        const t = $("#toast");
        if (t && t.textContent === "让它想一句…") t.classList.remove("is-on");
      }
    },

    /**
     * 语音回聊：它刚说完一句，自动接麦听你回。
     *
     * 这条链路只在「它的话真的播完了」之后由 VoicePlay 的 ended 回调触发，
     * 所以不会出现「它还在念，麦克风把它的声音也收进去」的串音。
     * 识别结果由 onVoice 落进输入框后自动发送（state.__cpVoiceReply 标记），
     * 中途用户点取消 / 识别出错都会把标记清掉，绝不会替用户发一条没影的消息。
     */
    startVoiceReply() {
      const c = this.cfg();
      if (!c.enabled || !c.voiceReply) return;
      if (state.screen !== "chat" || state.busy) return;
      if (state.voiceLive || this.pending) return;
      if (document.visibilityState !== "visible") return;
      if (!VoicePlugin.on() || !Native || !Native.startVoiceInput) return;
      if ($("#input") && $("#input").value.trim()) return; // 输入框有草稿：不打断，让用户自己发
      state.voiceLive = true;
      state.voiceDraft = "";
      state.__cpVoiceReply = true;
      haptic("light");
      voiceClearWatch();
      voiceOpen("接它一句 · 说完点麦克风结束");
      let started = true;
      try { started = Native.startVoiceInput() !== false; } catch (_) { started = false; }
      if (!started) {
        // 没有识别服务：面板不能开着转圈，立刻收掉（否则用户退不出去）
        state.voiceLive = false;
        state.__cpVoiceReply = false;
        voiceClose();
      }
    },
  };
  window.DSHCompanion = Companion;
  const pad2 = (n) => String(n).padStart(2, "0");

  /* 调试入口（CDP 测试 / 线上排障）：只暴露引用，不改行为 */
  try {
    window.__dsh = {
      Live, Flow, NODES, livePaint, renderThread,
      get thread() { return thread; },
      get follow() { return followBottomOn; },
      get renderTailFrom() { return renderTailFrom; },
      get state() { return state; },
      // 「聊天记录没了」这类问题只能在现场取证：哪个桶还在内存里、这一份加载过没有、
      // 库里这条会话有几条消息、快照有没有 —— 缺一样就只能靠猜。探针要能一次读全。
      get buckets() { return buckets; },
      bucketHas,
      LocalDB,
      // 惰性取：SpeechOut 在这段之后才声明，直接引用会撞 TDZ 导致整个调试钩子挂不上
      get SpeechOut() { return SpeechOut; },
      // Link 同理（电脑会话域在文件后半段）：跑没跑完、游标在哪，回归脚本要能直接读
      get Link() { return Link; },
      localReady,
    };
  } catch (_) {}

  /* ---- DOM 增量更新（morph） ----
     整块 innerHTML / replaceWith 会把「正在扫光的文字元素」一起销毁重建：
       · CSS 动画从头开始 → 文字看起来一直在闪（思考中「正在分析请求」、展开后的思考正文都是这个原因）
       · 长文本整段重排 → 内容跳变、选中丢失、滚动位置抖动
     这里按「节点类型 + 标签 + 属性」逐层下钻，只动真正变化的那一个 text node。 */
  function attrSig(el) {
    const a = el.attributes, out = [];
    for (let i = 0; i < a.length; i++) out.push(a[i].name + "=" + a[i].value);
    return out.sort().join("\u0001");
  }

  function morphChildren(box, next) {
    const n = next.childNodes.length;
    for (let i = 0; i < n; i++) {
      const cur = box.childNodes[i];
      const src = next.childNodes[i];
      if (!cur) { box.appendChild(src.cloneNode(true)); continue; }
      morphNode(cur, src);
    }
    while (box.childNodes.length > n) box.removeChild(box.lastChild);
  }

  function morphNode(cur, next) {
    if (next.nodeType === 3) {
      if (cur.nodeType === 3) {
        if (cur.nodeValue !== next.nodeValue) cur.nodeValue = next.nodeValue;
      } else {
        cur.replaceWith(next.cloneNode(true));
      }
      return;
    }
    if (next.nodeType !== 1 || cur.nodeType !== 1 ||
        cur.tagName !== next.tagName || attrSig(cur) !== attrSig(next)) {
      cur.replaceWith(next.cloneNode(true));
      return;
    }
    morphChildren(cur, next);
  }

  /** 把容器内容增量同步成 html（保留未变化的元素与其动画/滚动状态） */
  function morphHTML(box, html) {
    if (!box) return;
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    morphChildren(box, tmp);
  }

  /**
   * 把「元素本身」同步成 html —— 用于 html 的根就是要更新的那个元素（行级 patch）。
   *
   * 为什么不能直接用 morphHTML：它比的是 box 的**子节点**，喂进去的却是一整个
   * `.pg-row`，于是旧行的第一个子节点（`.pg-main`）被换成一个嵌套的 `.pg-row`、
   * 其余子节点被裁掉 —— 实测：工具行跑一次 patch 就变成「行里套行」，两条一模一样的
   * 摘要。以前只发生在 toolEnd 那一刻，下一次整组重绘就顺带修好了，所以没人看见；
   * 实时输出让这一行每秒被 patch 好几次，问题就一直挂在屏幕上。
   */
  function morphOuter(el, html) {
    if (!el) return;
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    const next = tmp.firstElementChild;
    if (!next) return;                     // 空 html 不当「删掉这个元素」理解（与 patchNode 原行为一致）
    if (next.tagName === el.tagName && attrSig(next) === attrSig(el)) morphChildren(el, next);
    else el.replaceWith(next);
  }

  /**
   * 只更新单个节点，不动其他 DOM。
   * 工具卡片状态更新如果走 renderThread，会把正在流式输出的气泡一起重建 → 界面闪烁。
   */
  /**
   * 思考行的一行摘要默认横向滚动显示（只此一处，工具行保持原样）。
   *
   * 思考行是「一行 + 点开看全文」的结构，一行装不下时截断等于把想法的开头藏起来
   * —— 而思考恰恰是越往后越说到点上。所以量一次：真的溢出才加滚动，
   * 并把要滚的距离交给 CSS（text-indent 动画，不改结构、不动盒模型）。
   * 结果按「文本长度 + 盒宽」缓存，内容或宽度变了才重测。
   */
  const TAIL_SEL = ".pg-label, .is-think .pg-sum, .pg-sum.is-live, .pc-think-brief";
  let tailRaf = 0;

  /**
   * 思考那一行钉在「最新内容」上（只钉最后一条，工具行保持省略号）。
   *
   * 一行装不下时以前是截断看开头 —— 而思考越往后才是说到点上的部分。
   * 现在把这一行的可视位置钉到文字末尾：输出多长就往前挪多长，
   * **滚动速度等于输出速度**，没有补间、没有节拍。
   *
   * 用 scrollLeft 而不是负 text-indent：负缩进会被 scrollWidth 再算一遍，
   * 每次测量都更负（实测 -131 → -411 → -1139 → -1339），一行字就这样滚没了。
   * scrollWidth 会触发同步排版，所以每次只量最后那一条，其余只清零。
   */
  function syncThinkTail() {
    const host = $("#messages");
    if (!host) return;
    const all = host.querySelectorAll(TAIL_SEL);
    // 只钉「看得见且真的溢出」的那几行：
    //  · 组收起时组体是 display:none —— 里面的摘要行 clientWidth=0，拿它当 last 会直接
    //    整段跳过（老实现就是 `if (!w) return`），组头于是再也不滚（用户实测：展开再收起，
    //    那一行就停在开头不动了）；
    //  · 组展开时组头与组内那一行会同时在，两行都该跟到末尾，不能只钉 DOM 里最后那个。
    for (const el of all) {
      const w = el.clientWidth;
      const to = w ? el.scrollWidth - w : 0;
      if (to > 0) {
        if (!el.classList.contains("is-tail")) el.classList.add("is-tail");
        if (el.scrollLeft !== to) el.scrollLeft = to;
      } else if (el.classList.contains("is-tail") || el.scrollLeft) {
        el.classList.remove("is-tail");
        el.scrollLeft = 0;
      }
    }
  }

  function patchNode(n) {
    const el = document.querySelector(`#messages [data-uid="${nodeUid(n)}"]`);
    if (!el) return;
    morphOuter(el, nodeHTMLUid(n));
    syncThinkTail();
  }

  /**
   * 在对话流中间插一枚节点，并且不让视口动。
   *
   * 交付物卡片、表情/图片、上一轮迟到的回复都走这里。插入点在视口上方时浏览器
   * 不会自动补偿（.chat-scroll 关了 overflow-anchor），内容会整体位移 ——
   * 用户看到的就是「列表滚到历史里再滚回来」。所以：贴底状态直接重新贴底，
   * 其它情况把「距底距离」原样补回去。
   */
  function insertAnchored(anchorEl, html) {
    const sc = $("#chatScroll");
    if (!sc || !anchorEl) return null;
    const keepFromBottom = sc.scrollHeight - sc.scrollTop;
    const above = anchorEl.getBoundingClientRect().top < sc.getBoundingClientRect().top + 1;
    anchorEl.insertAdjacentHTML("beforebegin", html);
    syncThinkTail();
    if (above || followBottomOn) ChatScroll._write(sc, Math.max(0, sc.scrollHeight - keepFromBottom));
    return anchorEl.previousElementSibling;
  }

  /** 对话流里最后一个匹配元素。
     不能用 `querySelector("#messages .turn-tail:last-of-type")`：`:last-of-type` 判断的是
     「在它自己的兄弟里是否是同类型的最后一个」，每条回复的尾行都满足这个条件，
     querySelector 只会拿到**历史里第一条**尾行 —— 表情/产物就被插进了很久以前的轮次里。 */
  function lastMatch(sel, root) {
    const all = (root || document).querySelectorAll(sel);
    return all.length ? all[all.length - 1] : null;
  }

  /** 本轮尾行（复制 / 用量）的 .msg 容器；新节点要插在它之前 */
  function turnTailMsg() {
    const host = $("#messages");
    const tail = lastMatch("#messages .turn-tail");
    const msg = tail ? tail.closest(".msg") : null;
    return msg && msg.parentElement === host ? msg : null;
  }

  /**
   * 只返回「本轮」的尾行。
   *
   * turnTailMsg() 拿的是全表最后一个尾行 —— 本轮还没结束时，那是上一轮的收尾行。
   * 表情/图片在工具执行时就到了（这时本轮连正文都没有），照着上一轮的尾行插，
   * 就会把这一轮的表情塞进上一轮末尾（真机上的「发送的图片跑到上一轮」）。
   * 判断归属很简单：尾行必须在最后一条用户消息之后。
   */
  function currentTurnTail() {
    const tail = turnTailMsg();
    if (!tail) return null;
    const host = $("#messages");
    const users = host.querySelectorAll(".msg.user");
    const lastUser = users[users.length - 1];
    if (!lastUser) return tail;
    // DOCUMENT_POSITION_FOLLOWING：尾行在用户消息之后 → 属于本轮
    return (lastUser.compareDocumentPosition(tail) & Node.DOCUMENT_POSITION_FOLLOWING) ? tail : null;
  }

  /**
   * 把「这一轮里发生的动作」（表情包、图片）插进对话流。
   *
   * 两件事必须一起做，否则顺序看着像倒放：
   *  1. 先把正在流式的这一段收口（正文定稿、思考组折叠）—— 动作发生在「说完之后」，
   *     不会插在一段话说到一半时；
   *  2. 落在最后一个尾行之前；之后模型继续产出的思考与正文会另起一段接在它下面。
   */
  function flowAction(node) {
    try { Flow.cut(); } catch (_) {}
    const tailMsg = currentTurnTail();
    if (tailMsg) {
      insertAnchored(tailMsg, nodeHTMLUid(node));
      // thread 顺序要和 DOM 一致：插在最后一个 footer 之前，否则下次整表重绘会跑到末尾
      const at = lastFooterIndex();
      thread.splice(at, 0, node);
      keepTailSync(at);
      return tailMsg.previousElementSibling;
    }
    thread.push(node);
    return appendTail(node);
  }

  /** 本轮最后一个尾行（复制 / 用量）在 thread 里的下标；没有就落到末尾 */
  function lastFooterIndex() {
    for (let i = thread.length - 1; i >= 0; i--) if (thread[i] && thread[i].kind === "footer") return i;
    return thread.length;
  }

  /**
   * 往流中间插了一枚「已经渲染进 DOM」的节点之后，必须同步尾部队指针。
   * 不同步的后果不是错位而是整表重建：paintLiveNode 的兜底条件是
   * `renderTailFrom !== thread.length`，差 1 也算差 —— 于是下一次流式 paint
   * 把整张对话清空重灌，用户看到的就是「刚插的那一下全页闪一遍」。
   */
  function keepTailSync(at) {
    if (at <= renderTailFrom) renderTailFrom += 1;
  }

  /** 尾部插节点：DOM 顺序必须与 thread 一致。
      首屏尾部队还在分帧灌时（renderThread 刚排了 rAF、一帧未执行），先同步把
      剩余历史灌完再插新节点 —— 否则新节点插进还没灌出历史的空档里，
      「深度求索中」跑到用户消息上面就是它；且后面的 fillHead 会把同一节点再灌一遍。 */
  function appendTail(n) {
    const host = $("#messages");
    if (renderHeadRaf) {
      cancelAnimationFrame(renderHeadRaf);
      renderHeadRaf = 0;
      const end = thread.length - 1;                 // 不含刚 push 的这个
      if (renderTailFrom < end) host.insertAdjacentHTML("beforeend", thread.slice(renderTailFrom, end).map(nodeHTMLUid).join(""));
      renderTailFrom = end;
    }
    host.insertAdjacentHTML("beforeend", nodeHTMLUid(n));
    renderTailFrom = thread.length;
    syncThinkTail();
    return host.lastElementChild;
  }

  function push(n, scroll = true) {
    thread.push(n);
    const el = appendTail(n);
    if (scroll) scrollToBottom();
    return el;
  }

  /* 上下文压缩的实时状态。
     摘要是一次真实的模型调用，可能持续几秒；桌面版把它做成提示行上方的一行
     「Context being compacted <elapsed>」，手机这里等价地放进对话流：
     开始是一条临时行（不写进 thread，也不进会话历史），落定后换成终态说明。 */
  /** 本轮压缩标记：桌面 CompactionItem 只有一个节点，运行态→完成原地补账目 */
  let compactNode = null;

  /** 插在本轮开头（轮首压缩语义）：不影响视口；thread 里同样落在最后一个用户消息之后 */
  function insertCompactionNode(node) {
    const host = $("#messages");
    if (!host) return;
    let anchor = null;
    const allEls = Array.from(host.children);
    for (let i = allEls.length - 1; i >= 0; i--) {
      if (allEls[i].querySelector(".bubble-user")) { anchor = allEls[i + 1] || null; break; }
    }
    if (anchor) insertAnchored(anchor, nodeHTMLUid(node));
    else host.insertAdjacentHTML("beforeend", nodeHTMLUid(node));
    let at = thread.length;
    for (let i = thread.length - 1; i >= 0; i--) {
      if (thread[i] && thread[i].kind === "user") { at = i + 1; break; }
    }
    thread.splice(at, 0, node);
    keepTailSync(at);
  }

  function compactingRow(on, ev) {
    if (on) {
      if (compactNode) return;                 // 已经在显示，别插第二个
      compactNode = NODES.compaction({ running: true });
      insertCompactionNode(compactNode);
      haptic("light");
      return;
    }
    const node = compactNode || NODES.compaction({});
    compactNode = null;
    Object.assign(node, {
      kind: "compaction", running: false,
      summarized: !!ev.summarized,
      count: ev.summarized ? (ev.summarizedCount ?? ev.dropped) : ev.dropped,
      folded: ev.folded,
      before: ev.before, after: ev.after, summary: ev.summary || "",
    });
    if (thread.indexOf(node) >= 0) patchNode(node);
    else insertCompactionNode(node);
    haptic("light");
  }

  function compactingClear() {
    if (!compactNode) return;
    const el = document.querySelector(`#messages [data-uid="${nodeUid(compactNode)}"]`);
    if (el) el.remove();
    const i = thread.indexOf(compactNode);
    if (i >= 0) thread.splice(i, 1);
    compactNode = null;
  }

  /* 跟随底部：只有用户本来就在底部时才自动滚。
     回复过程中手指往上滑，用户意图优先 —— 之前每帧强拉 scrollTop，屏幕根本滑不动。 */
  let followBottomOn = true;
  /** 宽松判据（90px）：只用于「要不要露出回到底部按钮」。
      绝不能拿它决定「是否重新跟随」—— 用户在底部附近慢滑、看最后两行时，
      每一帧都满足 <90px，于是每一帧都把跟随重新打开，下一刻又被拽回底部，
      手感就是「界面跟手指较劲、来回跳」（rc.217 用户实测）。 */
  function chatAtBottom() {
    const sc = $("#chatScroll");
    if (!sc) return true;
    return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 90;
  }
  /** 真贴底：恢复跟随的唯一判据口径。2px 是浮点/四舍五入的余量，不是容差。 */
  const RESTICK_EPS = 2;
  /* 恢复跟随必须等「滚动停下来」再判：惯性滑行（fling）期间 touchend 早就发过了，
     那一瞬间也可能恰好贴底，就地 adopt 会在下一帧把惯性滑行拦腰截断。
     判定用的**不是**「停止后再量一次距底」—— 流式内容每 50ms 就长一截，等 200ms 再量
     永远是几十上百像素，用户明明滚到了底也会被判成「停在半空」，跟随再也回不来。
     所以记两个时刻：最后一次滚动、以及最后一次「那一刻确实贴底」。滚动停下时两者
     挨着 = 用户停在了底部。 */
  let restickTimer = 0;
  let scrollStamp = 0;      // 最后一次 scroll 事件
  let bottomStamp = 0;      // 最后一次「此刻 dist<=EPS」的 scroll 事件
  function noteScrollStamp(probe) {
    scrollStamp = performance.now();
    if (probe.dist <= RESTICK_EPS) bottomStamp = scrollStamp;
  }
  function scheduleRestick(delay = 200) {
    if (restickTimer) clearTimeout(restickTimer);
    restickTimer = setTimeout(() => {
      restickTimer = 0;
      if (ChatScroll.state.pointer) return;              // 手指还按着：还在拖，不夺回
      if (scrollStamp - bottomStamp > 40) return;        // 停手时不在底部 = 他在读历史，别动
      followBottomOn = true;
      ChatScroll.adopt();
    }, delay);
  }

  /* ================= 滚动意图：唯一决策层 =================
     为什么要有它：写入 scrollTop 的地方一度有 9 条（流式跟手、批次收口、pinBottom、
     缓动跳转、插中间补偿、首屏灌入、ResizeObserver……），每条自带时钟；而「这次滚动
     是不是用户自己滑的」靠一个 240ms 时间窗猜。工具行实时输出之后，程序写入变成
     连续不断，时间窗几乎永真 —— 用户上滑被拽回、视口被甩开都是这么来的。
     这里只做两件事：
       1. 一个纯决策块（@pure 标记，Node 里可按时间线跑断言，不需要 DOM）；
       2. 一个执行器 ChatScroll：唯一允许写 scrollTop 的地方，度量统一用「距底距离」。
     迁移是渐进的：现只有流式跟手与批次收口走这里，其余写入点保持原样，
     视觉零变化；等设备回归覆盖到位再逐个搬过来。 */
  /* @pure:begin scroll-intent */
  const SCROLL_INTENT = { FOLLOW: "follow", AWAY: "away" };

  /** 量一次视口：统一用「距底距离」，流式期间 scrollHeight 每帧在变，scrollTop 本身不可比 */
  function scrollProbe(sc) {
    const content = sc.scrollHeight;
    const viewport = sc.clientHeight;
    const top = sc.scrollTop;
    return { top, viewport, content, dist: content - top - viewport };
  }

  /**
   * 这次 scroll 事件是谁造成的。
   * 不再用时间窗：执行器每次写之前记下 lastWritten，位置对得上就是自己写的。
   * 指针按下期间的任何滚动都算用户（宁可这一帧不跟，也不要和手指抢）。
   */
  function classifyScroll(state, probe) {
    if (state.pointer) return "user";
    if (state.lastWritten >= 0 && Math.abs(probe.top - state.lastWritten) <= 2) return "programmatic";
    return "user";
  }

  /** 该不该写、写到哪里。away 一律不写（用户在看历史）。
      手指按在列表上时也一律不写：rc.217 之前「按着慢滑」会来回弹 —— 手指没离开，
      scroll 事件把跟随重新打开，紧接的 stick（50ms 泵 / 每帧 rAF）就把他拽回底部，
      再滑、再拽。跟随的时机永远只在「没人碰屏幕」时才成立。 */
  function decideScroll(state, probe) {
    if (state.pointer) return { write: false, top: probe.top, reason: "pointer" };
    if (state.intent !== SCROLL_INTENT.FOLLOW) return { write: false, top: probe.top, reason: "away" };
    if (probe.dist <= 1) return { write: false, top: probe.top, reason: "at-bottom" };
    return { write: true, top: Math.max(0, probe.content - probe.viewport), reason: "follow" };
  }

  /** 往流中间插了 deltaH 高的内容：补回同等高度，视口看起来不动；意图不变 */
  function anchorCompensate(state, probe, deltaH) {
    return { top: Math.max(0, probe.top + deltaH), intent: state.intent };
  }
  /* @pure:end scroll-intent */

  const ChatScroll = {
    state: { intent: SCROLL_INTENT.FOLLOW, pointer: false, lastWritten: -1 },

    /** 唯一写入点：记账 + 写。记账是 classifyScroll 判断「谁滚的」的依据 */
    _write(sc, top) {
      this.state.lastWritten = Math.max(0, Math.round(top));
      setScrollTop(sc, top);
    },

    /** 跟随最新内容（流式每帧调）：已经贴底就不写，省掉一次无意义的重排 */
    stick(sc) {
      if (!sc) return false;
      const plan = decideScroll(this.state, scrollProbe(sc));
      if (!plan.write) return false;
      this._write(sc, plan.top);
      return true;
    },

    /** 用户明确要回到底部（发送、进入会话） */
    toBottom(sc) {
      if (!sc) return;
      this.state.intent = SCROLL_INTENT.FOLLOW;
      this._write(sc, sc.scrollHeight);
    },

    /** 用户把视口滑走了：从这一帧起不再自动跟，直到他滑回底部 */
    release() { this.state.intent = SCROLL_INTENT.AWAY; },
    adopt() { this.state.intent = SCROLL_INTENT.FOLLOW; },
    setPointer(down) { this.state.pointer = !!down; },
    following() { return this.state.intent === SCROLL_INTENT.FOLLOW; },
  };

  /**
   * 一轮在跑时定时自己量一次「距底」并跟上去。
   *
   * 为什么不能只靠「谁注意到内容变高了」：正文与正文之间有整段空窗（等工具返回、等下一步），
   * 这期间插进来的工具行、输入区 padding 都会让视口落后几十到几百像素，而流式 paint 不跑 ——
   * `#messages` 的高度观察器又只看消息盒子本身（实测：内容高 875→1136 的那 200ms 里
   * `#messages` 一直是 848，一次回调都没有）。用户看到的就是「最新那行沉在输入框底下，
   * 过一下才弹上来」，跟手的节拍全靠下一次 delta 碰运气。
   *
   * 为什么是定时器而不是 requestAnimationFrame：这台 WebView 在没有绘图负载的空窗里 rAF
   * 只有约 4 次/秒（实测：1.5 秒内只回了 6 次），100~250ms 的卡住正好掉在两帧之间 ——
   * 同一份道理 `schedulePaint` 早就挂了 setTimeout 兜底。
   * 成本：一次读 + 一次比较；已经贴底时 `decideScroll` 判 at-bottom，不写就不重排。
   */
  let followPumpTimer = 0;
  function followPump() {
    if (followPumpTimer) return;
    followPumpTimer = setInterval(() => {
      if (!state.busy && !Live.running) { clearInterval(followPumpTimer); followPumpTimer = 0; return; }
      if (followBottomOn) ChatScroll.stick($("#chatScroll"));
    }, 50);
  }

  /* ================= 动效层统一入口（.motion/CONTRACT.md §2） =================
     motion.js 先于 app.js 加载，暴露 window.Motion。三种状态：
       MOTION_MODERN=false（motion.js 缺失 / ?motion=legacy）→ 全部保留改造前的旧逻辑；
       MOTION_REDUCE()=true（系统「减弱动效」/ ?motion=reduce）→ 不做位移缩放，直接落位；
       其余 → 弹簧 / 跟手 / 可打断（同一元素重复 springTo 会自动从当前值 + 当前速度接管，
             所以任何新动画都不需要先 stop，天然可打断）。
     命名带 MOTION_ 前缀是为了跟 P2 区域区分：app.js 是同一个 IIFE，
     顶层重复声明 `const M` 会让整个文件 SyntaxError（不是运行时问题，直接整页空白）。 */
  const Motion = window.Motion;
  const MOTION_MODERN = !!(Motion && !Motion.legacy);
  const MOTION_REDUCE = () => !!(Motion && Motion.reduced && Motion.reduced());

  /* ---------------- 滚动缓起缓停 ----------------
     系统默认的程序化滚动是「匀速突进」，长列表一跳到顶很生硬。
     这里用 easeInOutCubic 把「起步」和「收尾」都拉平缓，时长随距离轻微自适应。
     动效 v2：CSS 的 scroll-behavior:smooth 摘掉后这段是唯一的程序化滚动机制；
     手指/滚轮一碰就立刻停手，不跟用户抢滚动条。 */
  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }
  /** 写 scrollTop 时显式声明 instant：即使 CSS 里还残留 scroll-behavior:smooth（比如回滚/漏摘），
      逐帧写入也不会被浏览器再补间一次；REDUCE() 时才是真的「立即跳」。
      注意：这里不再维护 progScrollUntil 时间窗 —— 「这是不是程序写的」由 ChatScroll 的
      写入记账（lastWritten）判定，时间窗在连续程序写入下必然失效。 */
  function setScrollTop(el, top) {
    if (!el) return;
    try { el.scrollTo({ top, behavior: "instant" }); }
    catch (_) { el.scrollTop = top; }
  }
  function easedScrollTo(el, to, dur = 380) {
    if (!el) return;
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    const target = Math.max(0, Math.min(to, max));
    const from = el.scrollTop;
    const delta = target - from;
    if (Math.abs(delta) < 1.5) { ChatScroll._write(el, target); return; }
    // 触摸 / 指针 / 滚轮立刻取消：用户意图优先，程序化滚动不能和手指抢
    if (!el.__easeStop) {
      el.__easeStop = () => {
        if (el.__easeRaf) { cancelAnimationFrame(el.__easeRaf); el.__easeRaf = 0; }
      };
      ["touchstart", "pointerdown", "wheel"].forEach((n) =>
        el.addEventListener(n, el.__easeStop, { passive: true }));
    }
    if (el.__easeRaf) { cancelAnimationFrame(el.__easeRaf); el.__easeRaf = 0; }
    // 减弱动效：直接跳（legacy 模式仍走下面的缓动，保持改造前行为）
    if (MOTION_MODERN && MOTION_REDUCE()) { ChatScroll._write(el, target); return; }
    const t0 = performance.now();
    const step = (now) => {
      // 补间写的是「自己那条曲线上的绝对位置」，而流式跟手 / ResizeObserver 可能已经把
      // 视口推到更下面。这时补间必须立刻退场 —— 不退场它就在下一帧把已经贴底的画面
      // 又拽回半空，两条写入互相拉扯，看起来正是「内容跑掉、再慢慢滚回来」。
      const cur = el.scrollTop;
      if ((delta > 0 && cur >= target - 1) || (delta < 0 && cur <= target + 1)) { el.__easeRaf = 0; return; }
      const p = Math.min(1, (now - t0) / dur);
      ChatScroll._write(el, from + delta * easeInOutCubic(p));
      el.__easeRaf = p < 1 ? requestAnimationFrame(step) : 0;
    };
    el.__easeRaf = requestAnimationFrame(step);
  }

  /** 把对话里的某个元素滚到视口中部：只动 #chatScroll，不碰任何祖先滚动容器 */
  function scrollChatTo(el, dur = 320) {
    const sc = $("#chatScroll");
    if (!sc || !el) return;
    const r = el.getBoundingClientRect(), sr = sc.getBoundingClientRect();
    const to = sc.scrollTop + (r.top - sr.top) - Math.max(0, (sc.clientHeight - r.height) / 2);
    easedScrollTo(sc, Math.max(0, to), dur);
  }

  function scrollToBottom(force, instant) {
    if (!force && !followBottomOn) return;
    const sc = $("#chatScroll");
    if (!sc) return;
    // 流式 paint 高频触发：直接贴底，不让 460ms 缓动被下一帧反复打断重启
    if (instant) { ChatScroll.toBottom(sc); return; }
    // 一轮还在产出（本机 busy / 电脑在跑）：一律瞬时下贴底。补间在这里只有坏处 ——
    // 它追的是「出发那一刻的目标」，而内容每帧都在长，实测能落后 2000px，
    // 看起来就是「消息跑掉、再慢慢滚回来」。缓动只留给用户主动的跳转。
    if (!force && (state.busy || Link.running)) {
      requestAnimationFrame(() => ChatScroll.toBottom(sc));
      return;
    }
    requestAnimationFrame(() => {
      const delta = sc.scrollHeight - sc.clientHeight - sc.scrollTop;
      // 流式输出每帧只涨几像素：直接贴底，避免动画被反复取消而拖影
      if (Math.abs(delta) < 28) { ChatScroll.toBottom(sc); return; }
      easedScrollTo(sc, sc.scrollHeight, Math.min(460, 220 + Math.abs(delta) * 0.12));
    });
  }

  /**
   * 贴底直到稳定：页面切换动画、键盘弹出/收起、气泡里的图片异步加载，
   * 都会让「写入 scrollTop 那一刻的 scrollHeight」过时 —— 单次 scrollToBottom
   * 停在半空，看起来就是「发送/重进后没在最底部」。
   * 这里逐帧校验：没贴住就补写；连续 2 帧到位或超时才放手。手指一碰立即让位。
   */
  function pinBottom(ms = 900, force = false) {
    const sc = $("#chatScroll");
    if (!sc) return;
    // force = 用户刚做了「我要看最新」的动作（发送、点进这条会话）；
    // 非 force = 内容自己在推进（后台轮跑完、定时唤醒补消息）。后者必须尊重阅读位置：
    // 以前这里无条件把 followBottomOn 置 true 并逐帧贴底，用户正慢慢滑着读历史，
    // 一轮恰好结束就把人拽回底部（rc.217 实测「来回跳」的另一半来源）。
    if (!force && (ChatScroll.state.pointer || !ChatScroll.following())) return;
    followBottomOn = true;                 // 主动进入/发送 = 明确想看最新消息
    ChatScroll.adopt();
    const t0 = performance.now();
    let okFrames = 0;
    let raf = 0;
    const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };
    sc.addEventListener("touchstart", stop, { passive: true, once: true });
    const step = () => {
      raf = 0;
      if (performance.now() - t0 > ms) return;
      if (chatAtBottom()) {
        // 到位后仍要盯住：布局晚一拍变高（图片/字体加载）会把底部顶出去
        if (++okFrames >= 2) return;
      } else {
        okFrames = 0;
        ChatScroll.toBottom(sc);
      }
      raf = requestAnimationFrame(step);
    };
    step();
  }
  /** #device 外壳是 overflow:hidden，但 scrollIntoView / 焦点滚动仍会把它一起滚，
      滚过之后整屏偏移且不会自己回来（实测 #device.scrollTop=20 → #screen-chat top=-20，
      置 0 立刻恢复）。任何来路的偏移都在这里拉回 0。 */
  function bindDeviceScroll() {
    const dev = document.querySelector("#device");
    if (!dev || dev.__scrollGuard) return;
    dev.__scrollGuard = true;
    dev.addEventListener("scroll", () => { if (dev.scrollTop) dev.scrollTop = 0; }, { passive: true });
  }

  /** 用户一碰列表就停止自动跟随，松手后按位置重新判断 */
  function bindFollowScroll() {
    const sc = $("#chatScroll");
    if (!sc || sc.__followBound) return;
    sc.__followBound = true;
    // 手指状态喂给 ChatScroll：按下期间的滚动一律算用户，程序写入不许抢
    const grab = () => {
      if (restickTimer) { clearTimeout(restickTimer); restickTimer = 0; }
      ChatScroll.setPointer(true);
      // 这里**不**关跟随：轻触（点代码块复制、长按选字、点工具行）不该打断跟手。
      // 「用户真的在拖」的证据是「按着的同时发生了滚动」，那在 scroll 监听里处理。
    };
    const letGo = () => {
      ChatScroll.setPointer(false);
      // 松手不等于要跟随：惯性还在滑，200ms 后真贴底才把跟随打开（见 scheduleRestick）
      scheduleRestick();
    };
    sc.addEventListener("touchstart", grab, { passive: true });
    // touchcancel 必须与 touchend 同等对待：拖到屏幕边缘变成返回手势、来电、通知栏下拉
    // 走的都是 cancel。以前只认 touchend，指针位会永久卡在 true —— 此后整场对话不再跟手，
    // 不报错也不提示，看起来就是「流式不滚了」。
    sc.addEventListener("touchend", letGo, { passive: true });
    sc.addEventListener("touchcancel", letGo, { passive: true });
    // document 级兜底：手势如果在别处结束（触摸目标被摘掉、页面切换、系统抢走），
    // sc 上收不到 end/cancel，指针位会永久卡 true —— 此后整场对话不再跟手。
    // 这里只复位指针，不触发 restick（跟随恢复仍由 sc 的 scroll 监听决定）。
    ["touchend", "touchcancel"].forEach((n) => {
      document.addEventListener(n, () => ChatScroll.setPointer(false), { passive: true, capture: true });
    });
    // 鼠标 / 触控板（模拟器探针、接显示器用鼠标滑）走 pointer 事件，语义保持一致。
    // **只认非触摸指针**：Android WebView 在滚动接管手势时会派发 pointercancel，
    // 若在这里无条件复位，触摸拖动期间 pointer 立刻变回 false，下面的保护就形同虚设。
    const mouseOnly = (fn) => (e) => { if (e.pointerType !== "touch") fn(); };
    sc.addEventListener("pointerdown", mouseOnly(grab), { passive: true });
    sc.addEventListener("pointerup", mouseOnly(letGo), { passive: true });
    sc.addEventListener("pointercancel", mouseOnly(letGo), { passive: true });
    sc.addEventListener("wheel", () => { followBottomOn = false; ChatScroll.release(); }, { passive: true });
    sc.addEventListener("scroll", () => {
      // 复用同一次测量：距底距离既喂「谁滚的」判定，也喂「最后是不是停在底部」
      const probe = scrollProbe(sc);
      noteScrollStamp(probe);
      syncChatTopFade();
      // 「这次滚动是谁造成的」由记账判定（classifyScroll），不再用 240ms 时间窗猜：
      // 工具行实时输出之后程序写入是连续的，时间窗几乎永真，会把用户上滑也当成自己写的。
      if (classifyScroll(ChatScroll.state, probe) === "programmatic") return;
      // 手指按着 + 有滚动 = 用户在拖：从这一刻起停止跟随，直到他自己滑回底部。
      // （轻触不产生滚动，所以点复制按钮 / 长按选字不会把跟手关掉。）
      if (ChatScroll.state.pointer) {
        followBottomOn = false;
        ChatScroll.release();
        return;
      }
      // 已经在跟随就不用重判；重判会让每个 scroll 事件都 adopt 一次，把惯性滑行截断
      if (ChatScroll.following()) return;
      // 恢复跟随只有一条路：滚动停下来（去抖）且真贴底 —— 不是「距底 90px 就算底部」
      scheduleRestick();
    }, { passive: true });
    // 内容长了就跟着滚：输入框是浮在内容上的，如果只在「发消息/收事件」时滚，
    // 流式输出涨高后最后一行会先钻到输入框底下，等下一次滚动事件才弹上来。
    // 这里盯住消息列表高度，一涨就跟（用户手指碰过列表时 intent 是 AWAY，不抢他的滚动）。
    // 键盘：--kb 由原生注入（MainActivity 直接 setProperty），既不改 #messages 也不改
    // dock 的高度 —— 两种 ResizeObserver 都不会响。但 padding-bottom 变了就等于
    // scrollHeight 变了：不重新贴底，最后一条会被输入框/键盘压在下面（实测差 310px）。
    const rootEl = document.documentElement;
    if (rootEl && window.MutationObserver && !rootEl.__kbPin) {
      rootEl.__kbPin = true;
      let lastKb = "";
      const pinOnKb = () => {
        const kb = rootEl.style.getPropertyValue("--kb");
        if (kb === lastKb) return;
        lastKb = kb;
        if (followBottomOn) settleFollow();
      };
      new MutationObserver(pinOnKb).observe(rootEl, { attributes: true, attributeFilter: ["style"] });
    }
    const list = $("#messages");
    if (list && window.ResizeObserver && !list.__followRO) {
      list.__followRO = new ResizeObserver(() => {
        // 组展开 / 收起会改高度，但不会走 patchNode —— 摘要行的滚动与否要在这时重测
        if (tailRaf) cancelAnimationFrame(tailRaf);
        tailRaf = requestAnimationFrame(() => { tailRaf = 0; syncThinkTail(); });
        if (!followBottomOn) return;
        ChatScroll.stick($("#chatScroll"));
      });
      list.__followRO.observe(list);
    }
    syncChatTopFade();
  }

  /** 只读诊断口：滚动意图层的状态快照，供 .motion 探针验证（不参与任何 UI 逻辑）。
      没有它，探针只能从 scrollTop 轨迹反推意图 —— 「指针卡住」和「restick 没跑」
      在轨迹上一模一样，排查会变成猜。 */
  window.__chatScrollState = () => ({
    intent: ChatScroll.state.intent,
    pointer: ChatScroll.state.pointer,
    lastWritten: ChatScroll.state.lastWritten,
    follow: followBottomOn,
    scrollStamp: Math.round(scrollStamp),
    bottomStamp: Math.round(bottomStamp),
    now: Math.round(performance.now()),
  });

  /* ---------------- 对话阅读增强（rc.152） ----------------
     把桌面端的三件阅读辅助搬到手机上：回到底部、轮次刻度、对话内搜索；
     外加「长按消息 → 复制 / 从这里分叉」与代码块复制。
     原则：只做增量 —— 不改既有 DOM 结构、不动任何既有动效、不引入新色板。 */
  /** 对话内搜索的接管态：on 时输入框本体就是搜索框（handleSend / updateSendState /
      syncModeBar 都看这个标志分流），退出时把草稿原样还回去。 */
  const SearchMode = { on: false, draft: "", query: "" };

  const ChatExtras = {
    bound: false,
    turns: [],
    hits: [],
    marks: [],
    hitIndex: -1,

    bind() {
      if (this.bound) return;
      this.bound = true;
      const btn = $("#toBottom");
      if (btn) {
        btn.addEventListener("click", () => {
          haptic("light");
          followBottomOn = true;
          scrollToBottom(true);
          this.syncBottom();
        });
      }
      const sc = $("#chatScroll");
      if (sc) sc.addEventListener("scroll", () => this.syncBottom(), { passive: true });

      // 代码块复制：委托到 document —— 流式期间代码块会被反复重建，逐块绑定会漏
      document.addEventListener("click", (e) => {
        const cp = e.target.closest("[data-copy-code]");
        if (!cp) return;
        const wrap = cp.closest(".code-wrap");
        const code = wrap && wrap.querySelector("code");
        if (!code) return;
        copyText(code.textContent || "");
        haptic("light");
        cp.classList.add("is-done");
        cp.innerHTML = '<svg class="ico"><use href="#i-check"/></svg>';
        setTimeout(() => {
          cp.classList.remove("is-done");
          cp.innerHTML = '<svg class="ico"><use href="#i-copy"/></svg>';
        }, 1200);
      });

      // 长按消息 → 动作面板（手机上「悬停」不存在，长按是它的等价物）
      this.bindLongPress($("#messages"));

      // 「更多」里的搜索入口：不占用标题栏位置，和现有菜单同一套手势
      document.addEventListener("click", (e) => {
        if (e.target.closest('[data-act="search"]')) {
          closeSheet();
          this.openSearch();
        }
      });

      // 面板里的消息动作（复制 / 分叉）
      document.addEventListener("click", (e) => {
        const cp = e.target.closest("[data-msg-copy]");
        if (cp) {
          const n = nodeByUid(cp.dataset.msgCopy);
          const whole = (n && n.text) || this._lastText || "";
          // 复制什么由用户选区说了算：圈了半句就只给半句，没选才给整条。
          // 旧实现无条件 copyText(node.text)，用户选中的部分被直接丢弃。
          const decision = copyDecision(selectedTextIn($("#messages")), whole);
          copyText(decision.text, decision.label);
          haptic("light");
          closeSheet();
          return;
        }
        const fk = e.target.closest("[data-msg-fork]");
        if (fk) {
          const n = nodeByUid(fk.dataset.msgFork);
          closeSheet();
          if (n) this.forkFrom(n);
          return;
        }
        const tu = e.target.closest("[data-turn-usage]");
        if (tu) {
          const n = nodeByUid(tu.dataset.turnUsage);
          if (n) { haptic("light"); openSheet(sheetTurnUsage(n)); }
        }
      });

      this.bindSearch();
      this.syncBottom();
    },

    bindLongPress(host) {
      if (!host) return;
      let timer = 0, sx = 0, sy = 0;
      const cancel = () => { if (timer) { clearTimeout(timer); timer = 0; } };
      host.addEventListener("pointerdown", (e) => {
        const el = e.target.closest(".msg");
        if (!el || e.target.closest("button,a,input,textarea,.code-wrap")) return;
        // 正文区域长按 = 系统原生文字选择接管，不弹自定义面板
        if (e.target.closest(".assistant-text, .bubble-user, pre, code")) return;
        sx = e.clientX; sy = e.clientY;
        cancel();
        timer = setTimeout(() => {
          timer = 0;
          // 用户正在用系统选择手柄圈字：这次长按是「选择手势」，交给系统原生菜单
          // （复制 / 全选）处理，绝不弹自定义动作面板。否则面板里的「复制整条消息」
          // 会在用户眼前把选中的半句换成整条 —— 这就是「选了部分却复制了全部」。
          if (selectedTextIn(host)) return;
          // 快照里恢复的历史消息不一定还挂 __uid：取不到模型节点就只退回**正文**文本。
          // 不能退回整块 .msg 的 textContent —— 那会把思考行、工具行、时间戳一起
          // 当成「消息正文」塞进剪贴板，复制出来比整条消息还多。
          const bodyEl = el.querySelector(".assistant-text, .bubble-user");
          const node = nodeByUid(el.dataset.uid) || {
            __uid: "",
            text: (bodyEl && bodyEl.textContent) || "",
          };
          if (!node.text) { toast("这条消息没有可复制的正文"); return; }
          haptic("medium");
          this._lastText = node.text || "";
          window.__sheetGuardUntil = performance.now() + 900;
          openSheet(sheetMessageActions(node));
          // 650ms：必须晚于 WebView 系统选词（约 500ms）建立选区的那一刻。
          // 以前是 480ms，面板抢在系统选择之前弹出，此时 selectedTextIn() 还是空，
          // 检查形同虚设 —— 用户看到自己圈了半句，眼前却是「复制文字」面板。
        }, 650);
      }, { passive: true });
      host.addEventListener("pointermove", (e) => {
        if (!timer) return;
        if (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8) cancel();
      }, { passive: true });
      host.addEventListener("pointerup", cancel, { passive: true });
      host.addEventListener("pointercancel", cancel, { passive: true });
    },

    /* ---- 对话内搜索：复用底部输入框本体（键盘就贴在框上方，不用够到屏幕顶部） ----
       接管方式：placeholder / 发送键 / 附件与语音键全部切到搜索语义，
       Enter（enterkeyhint=search）= 下一处；计数与「上一处 / 退出」在 modeBar 的搜索签里。
       旧版浮在标题栏下的独立搜索条已删——同一功能两个入口只会让其中一个烂掉。 */
    bindSearch() {
      const input = $("#input");
      if (!input || input.__searchBound) return;
      input.__searchBound = true;
      const run = () => {
        if (!SearchMode.on) return;
        this.applySearch();
        if (this.hits.length) this.jump(0);
      };
      input.addEventListener("input", () => {
        if (!SearchMode.on) return;
        clearTimeout(this._t);
        this._t = setTimeout(run, 120);
      });
      // modeBar 上的「上一处 / 退出」
      const bar = $("#modeBar");
      if (bar && !bar.__searchNavBound) {
        bar.__searchNavBound = true;
        bar.addEventListener("click", (e) => {
          if (!SearchMode.on) return;
          if (e.target.closest("[data-search-prev]")) { haptic("light"); this.jump(-1); }
          if (e.target.closest("[data-search-close]")) this.closeSearch();
        });
      }
    },
    openSearch() {
      const input = $("#input");
      if (!input || SearchMode.on) return;
      // 进来先把面板状态收干净：关闭态若还挂着上一次拖拽的内联位移，
      // 它会半开着贴在屏底（就是「底部露出浮窗顶部」那条）——搜索期间尤其显眼。
      if (!sheetOpen && !sheetClosing) sheetHideHard();
      SearchMode.on = true;
      SearchMode.draft = input.value;
      input.value = "";
      input.style.height = "auto";
      document.documentElement.classList.add("search-on");
      input.setAttribute("placeholder", "在对话中搜索");
      input.setAttribute("enterkeyhint", "search");
      document.querySelector(".composer-dock")?.classList.add("is-searching");
      const btn = $("#btnSend");
      if (btn) {
        btn.disabled = false;
        btn.querySelector("use")?.setAttribute("href", "#i-chevron-down");
        btn.setAttribute("aria-label", "下一处");
      }
      this.hits = [];
      this.hitIndex = -1;
      syncModeBar();
      setTimeout(() => input.focus(), 30);
    },
    closeSearch() {
      const input = $("#input");
      SearchMode.on = false;
      document.documentElement.classList.remove("search-on");
      document.querySelector(".composer-dock")?.classList.remove("is-searching");
      this.clearMarks();
      this.hits = [];
      this.hitIndex = -1;
      SearchMode.query = "";
      if (input) {
        input.value = SearchMode.draft;
        SearchMode.draft = "";
        input.setAttribute("placeholder", "发消息给 Agent…");
        input.setAttribute("enterkeyhint", "send");
        input.style.height = "auto";
        input.style.height = Math.min(input.scrollHeight, 116) + "px";
      }
      const btn = $("#btnSend");
      if (btn) {
        btn.querySelector("use")?.setAttribute("href", "#i-send");
        btn.setAttribute("aria-label", "发送");
      }
      syncModeBar();
      updateSendState();
    },
    jump(step) {
      if (!this.hits.length) return;
      this.hitIndex = (this.hitIndex + step + this.hits.length) % this.hits.length;
      // 只给「当前这一处」上色（其余命中保持原样），不重包 —— 重包会打断 markdown 结构
      this.syncCurMark();
      const el = this.hits[this.hitIndex];
      if (!el) return;
      followBottomOn = false;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      setTimeout(() => this.syncBottom(), 420);
      if (SearchMode.on) syncModeBar();
    },
    /* 「哪一处是当前」的唯一写入口：整块命中的 <mark> 按 __midx 比对，只给当前那个搬 hl-on。 */
    syncCurMark() {
      if (!this.marks) return;
      this.marks.forEach((m) => m.classList.toggle("hl-on", m.__midx === this.hitIndex));
    },
    /* 字符级高亮：把命中的子串用 <mark> 包住，只动文本节点、不动外层 DOM，
       因而不会打断 markdown 渲染出来的结构（链接 / 代码块 / 标题都安全）。
       退出或改词时 clearMarks() 整体 unwrap 还原。

       搜索范围 = 对话正文：助手正文（.assistant-text）与用户气泡（.bubble-user）。
       以前取整条 .msg 的 textContent，"已完成，用时 39 秒" / "思考" 摘要 /
       "复制·朗读·20.8k tokens" 这些界面文字也会算命中，计数与跳转都被它们带偏。 */
    applySearch() {
      const input = $("#input");
      const q = (input ? input.value : "").trim().toLowerCase();
      SearchMode.query = q;
      this.clearMarks();
      this.hits = [];
      this.hitIndex = -1;
      if (!q) { if (SearchMode.on) syncModeBar(); return; }
      $$("#messages .assistant-text, #messages .bubble-user").forEach((el) => {
        if ((el.textContent || "").toLowerCase().includes(q)) this.hits.push(el);
      });
      if (!this.hits.length) { if (SearchMode.on) syncModeBar(); return; }
      this.hitIndex = 0;
      this.hits.forEach((el, idx) => {
        const marks = this.wrapMatches(el, q);
        marks.forEach((m) => (m.__midx = idx));
        this.marks.push(...marks);
      });
      this.syncCurMark();       // 只有第 0 处先上色，其余等切过去再说
      if (SearchMode.on) syncModeBar();
    },
    wrapMatches(el, q) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          const p = node.parentNode;
          // 跳过代码块 / 控件 / 已有 mark，避免破坏复制按钮与嵌套
          if (p && /^(CODE|SCRIPT|STYLE|TEXTAREA|INPUT|BUTTON|MARK|PRE)$/.test(p.tagName)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const nodes = [];
      let n;
      while ((n = walker.nextNode())) nodes.push(n);
      const out = [];
      for (const node of nodes) {
        const text = node.nodeValue;
        const lower = text.toLowerCase();
        let idx = lower.indexOf(q);
        if (idx === -1) continue;
        const frag = document.createDocumentFragment();
        let last = 0;
        while (idx !== -1) {
          if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
          const mark = document.createElement("mark");
          // .hl 只负责「包住 + 抹掉 UA 的黄底」，不上色；.hl-on 才是当前命中（见 styles.css）
          mark.className = "hl";
          mark.textContent = text.slice(idx, idx + q.length);
          frag.appendChild(mark);
          out.push(mark);
          last = idx + q.length;
          idx = lower.indexOf(q, last);
        }
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        node.parentNode.replaceChild(frag, node);
      }
      return out;
    },
    clearMarks() {
      if (this.marks && this.marks.length) {
        this.marks.forEach((m) => {
          if (m.parentNode) m.replaceWith(document.createTextNode(m.textContent));
        });
        this.hits.forEach((el) => el.normalize && el.normalize());
      }
      this.marks = [];
    },

    /* 轮次刻度（#turnRail）已随侧栏改造删掉：DOM 不在了，这里的 buildRail/syncRail
       永远在第一行 return —— 留着只会让人以为还有一条刻度线可以查。
       （它内部的 scrollIntoView 也正是 rc.193「整屏上移卡死」的那个坑。） */
    refresh() {
      this.syncBottom();
    },

    syncBottom() {
      const btn = $("#toBottom");
      const sc = $("#chatScroll");
      if (!btn || !sc) return;
      const away = sc.scrollHeight - sc.scrollTop - sc.clientHeight > 120;
      if (away !== btn.__shown) { btn.__shown = away; btn.hidden = !away; if (away) syncDockHeight(); }
      if (!away && btn.classList.contains("has-new")) btn.classList.remove("has-new");
    },
    /** 流式期间脱离尾部：底部浮标上点一个小蓝点，提示「有新内容」 */
    markNew() {
      const btn = $("#toBottom");
      if (btn && !btn.hidden) btn.classList.add("has-new");
    },

    /* ---- 从这条消息分叉：本地会话按消息顺序复制出一份新会话 ---- */
    forkFrom(node) {
      if (currentMode() !== "local") { toast("只有本地会话可以分叉"); return; }
      const idx = thread.indexOf(node);
      if (idx < 0) return;
      const msgs = [];
      for (let i = 0; i <= idx; i++) {
        const n = thread[i];
        if (!n) continue;
        if (n.kind === "user") msgs.push({ role: "user", content: n.text || "", atts: n.atts || [] });
        else if (n.kind === "text") msgs.push({ role: "assistant", content: n.text || "" });
      }
      if (!msgs.length) { toast("这条之前还没有可沿用的内容"); return; }
      const src = LocalDB.get(state.sessionId) || {};
      const s = LocalDB.create((src.title || "会话") + " · 分叉");
      const now = Date.now();
      msgs.forEach((m, i) => LocalDB.push(s.id, { ...m, at: now - (msgs.length - i) * 1000 }));
      renderSessions();
      openSession(s.id);
      haptic("light");
      toast("已从这里分叉");
    },
  };

  /** 长按一条消息弹出的动作面板：复制 / 从这里分叉（桌面 MessageIconActions 的手机版） */
  function sheetMessageActions(node) {
    const text = String(node.text || "");
    const preview = text.replace(/\s+/g, " ").trim().slice(0, 42) || "（无正文）";
    return `
      <div class="sheet-title">这条消息</div>
      <div class="sheet-sub">${esc(preview)}</div>
      <button class="btn-primary" data-msg-copy="${esc(node.__uid || "")}">复制整条消息</button>
      <div class="sheet-caption" style="margin-top:8px">若已圈选部分文字，只复制圈中的那一段</div>
      ${currentMode() === "local" && node.__uid ? `<button class="btn-ghost" data-msg-fork="${esc(node.__uid)}">从这里分叉</button>` : ""}
      <button class="btn-ghost" data-close>取消</button>`;
  }

  /** 压缩账目的一行话：摘要/折叠/省略 + 省出来的 token。 */
  function compactUsageText(c) {
    const what = c.summarized
      ? `摘要 ${c.summarizedCount} 条`
      : c.folded
        ? `折叠 ${c.folded} 处工具输出`
        : c.dropped
          ? `省略 ${c.dropped} 条`
          : "";
    const saved = c.before > c.after
      ? `${fmtTokens(c.before)}→${fmtTokens(c.after)} · 省 ${Math.round((1 - c.after / c.before) * 100)}%`
      : "";
    return [what, saved].filter(Boolean).join(" · ") || "无";
  }

  /** 轮末「用量」面板：输入 / 输出 / 合计 / 步数 / 耗时 + 会话累计（桌面 TurnUsagePanel 的手机版） */
  function sheetTurnUsage(node) {
    const total = Number(node.tokens) || (Number(node.prompt) || 0) + (Number(node.completion) || 0);
    const secs = Number(node.ms) ? Number(node.ms) / 1000 : 0;
    const sess = (() => {
      try { return (Usage.read().sessions || {})[state.sessionId] || {}; } catch (_) { return {}; }
    })();
    const row = (k, v) => `<div class="k">${k}</div><div class="v">${v}</div>`;
    return `
      <div class="sheet-title">本轮用量</div>
      <div class="sheet-sub">${node.cancelled ? "这一轮被中止，数字按已产出的部分计" : "模型回报的 token 账目"}</div>
      <div class="usage-grid">
        ${row("输入", fmtTokens(Number(node.prompt) || 0))}
        ${row("输出", fmtTokens(Number(node.completion) || 0))}
        ${row("合计", fmtTokens(total))}
        ${node.cached ? row("其中缓存命中", fmtTokens(Number(node.cached)) + (node.prompt ? " · " + Math.round(node.cached / node.prompt * 100) + "%" : "")) : ""}
        ${node.ctxWindow && node.prompt ? row("上下文占用", Math.round(node.prompt / node.ctxWindow * 100) + "% · " + fmtTokens(node.ctxWindow)) : ""}
        ${node.compact ? row("上下文压缩", compactUsageText(node.compact)) : ""}
        ${node.steps ? row("步数", node.steps + " 步") : ""}
        ${secs ? row("耗时", secs >= 60 ? (secs / 60).toFixed(1) + " 分" : secs.toFixed(1) + " 秒") : ""}
        ${sess.t ? row("本会话累计", fmtTokens(sess.t)) : ""}
      </div>
      <div class="usage-note">输入是这一轮发给模型的上下文，输出是模型生成的正文与思考。对话越长，输入越贵。</div>
      <button class="btn-ghost" data-close>关闭</button>`;
  }

  /* ---------------- 按压形变（拖拽橡皮筋） ----------------
     按住按钮拖动时，按钮沿拖动方向被拉伸、垂直方向被挤压，松手回弹。
     刻意**不做位移**：transform 里只有 scale/skew，没有 translate ——
     按钮本身不跟着手指走，只有"被捏住"的形变。
     底部 tab 除外：它自己有拖拽切页手势，形变会让命中区一起抖。 */
  function bindPressDeform() {
    if (document.__pressDeformBound) return;
    document.__pressDeformBound = true;
    const SEL = 'button:not(.tab), .sheet-item, .row[role="button"], .seg';
    /* 这些元素自己有拖拽 / 位移语义（底部 tab 指示器拖动、会话左滑、队列拖动），
       按压形变会让命中区跟着一起抖，统一交给它们自己的手势驱动。 */
    const EXCL = ".tab, .session-item, .queue-item";
    let el = null, sx = 0, sy = 0, px = 0, py = 0, raf = 0;

    /* ---- 旧实现：motion.js 缺失 / ?motion=legacy 时保持改造前行为（CSS 过渡回弹） ---- */
    if (!MOTION_MODERN) {
      const paintLegacy = () => {
        raf = 0;
        if (!el) return;
        // 拖动位移限幅：超过 52px 不再加大形变，避免整块按钮被拉变形到不可读
        const dx = Math.max(-52, Math.min(52, px - sx));
        const dy = Math.max(-52, Math.min(52, py - sy));
        const ax = Math.abs(dx), ay = Math.abs(dy);
        const amp = Math.min(1, Math.max(ax, ay) / 52);
        const stretch = amp * 0.14;
        const squash = stretch * 0.62;
        const horiz = ax >= ay;
        const scaleX = horiz ? 1 + stretch : 1 - squash;
        const scaleY = horiz ? 1 - squash : 1 + stretch;
        const skew = Math.max(-3.5, Math.min(3.5, dx * 0.06));
        el.style.transformOrigin = "center";
        el.style.transform = `scale(${scaleX.toFixed(3)}, ${scaleY.toFixed(3)}) skewX(${skew.toFixed(2)}deg)`;
      };

      const releaseLegacy = () => {
        if (!el) return;
        const node = el;
        el = null;
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        // 回弹曲线压到 1.16 过冲：还留一点弹性示意，但不再「先弹过头再晃回来」，
        // 收尾拖长到 .5s，松手后是缓缓归位而不是蹦一下
        node.style.transition = "transform .5s cubic-bezier(.16, 1.16, .3, 1)";
        node.style.transform = "scale(1, 1) skewX(0deg)";
        setTimeout(() => {
          node.style.transition = "";
          node.style.transform = "";
        }, 520);   // 比回弹曲线 .5s 略长，收尾帧不被提前清掉
      };

      document.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        const t = e.target && e.target.closest ? e.target.closest(SEL) : null;
        if (!t || t.disabled) return;
        el = t; sx = e.clientX; sy = e.clientY; px = sx; py = sy;
      }, { passive: true });

      document.addEventListener("pointermove", (e) => {
        if (!el) return;
        px = e.clientX; py = e.clientY;
        if (!raf) raf = requestAnimationFrame(paintLegacy);
      }, { passive: true });

      ["pointerup", "pointercancel", "blur"].forEach((n) =>
        document.addEventListener(n, releaseLegacy, true));
      return;
    }

    /* ---- 弹簧版（契约 §4 按压）：按下 scale .965 → 拖动 >8px 叠 skew → 松手回 1 ---- */
    if (MOTION_REDUCE()) return;      // 减弱动效：完全不动（不是「更快的动画」，是根本没有）
    let pid = -1, skewing = false;
    /* 圆形独立按钮走专用「果冻形变」通道（MagicOS 11）：
       拖动期以中心为铆钉沿拖拽轴拉伸/垂直压扁，松手 Q 弹回圆。 */
    const JELLY_SEL = ".round-btn, .send-btn, .voice-btn, .icon-btn";
    let jelly = null, jellyLive = false, jp = 0, ja = 0;

    const jellyRelease = (node, cancelled) => {
      jelly = null; jellyLive = false;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      Motion.stop(node);
      node.style.transition = "";
      node.style.transform = "";
      const p = jp, a = ja;
      jp = 0; ja = 0;
      node.classList.remove("is-jelly", "is-jelly-tap");   // 连点时清残留，避免旧动画盖新的
      if (cancelled) return;           // 手势被系统打断：静默归位，不演
      if (p > .02) {                   // 拖过：沿最后形变轴做 Q 弹回圆
        node.style.setProperty("--jp", p.toFixed(4));
        node.style.setProperty("--ja", a.toFixed(2) + "deg");
        void node.getBoundingClientRect();
        node.classList.add("is-jelly");
        setTimeout(() => node.classList.remove("is-jelly"), 700);
      } else {                         // 原地点按：轻快的小果冻
        void node.getBoundingClientRect();
        node.classList.add("is-jelly-tap");
        setTimeout(() => node.classList.remove("is-jelly-tap"), 480);
      }
    };

    const release = (cancelled) => {
      if (!el) return;
      const node = el;
      if (jelly) {
        el = null; pid = -1; skewing = false;
        jellyRelease(node, cancelled === true);
        return;
      }
      el = null; pid = -1; skewing = false;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      // 松手回弹走 press（比 pressIn 软），终值本来就是 identity（scale1/skew0），
      // 收尾只需把内联样式擦干净，保证连点 20 次不留 transform。
      // max 压到 240：press 的自然收敛在 240~260ms 之间，取硬上限兑现「松手 ≤260ms 归位」
      // （到点由 Motion 强制 finish，此刻残差 <0.5%，看不出硬着陆）。
      Motion.springTo(node, { scale: 1, skew: 0 }, {
        preset: "press",
        max: 240,
        onComplete: () => { if (el !== node) Motion.clear(node); },
      });
      // 保险：重定向（same el 再次 springTo）时 motion.js 只保留第一轮的 onComplete，
      // 这里补一个更长的超时兜底，保证内联样式最终一定被擦掉。
      setTimeout(() => { if (el !== node) Motion.clear(node); }, 420);
    };

    document.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const t = e.target && e.target.closest ? e.target.closest(SEL) : null;
      if (!t || t.disabled || t.getAttribute("aria-disabled") === "true") return;
      if (t.closest(EXCL)) return;
      if (el && el !== t) release();     // 上一颗没等到 pointerup 就换了目标：先收尾
      el = t; pid = e.pointerId; skewing = false;
      jelly = t.closest(JELLY_SEL) || null;
      jellyLive = false; jp = 0; ja = 0;
      if (jelly) jelly.classList.remove("is-jelly", "is-jelly-tap");  // 回弹途中再按：立刻让位给按压弹簧
      sx = px = e.clientX; sy = py = e.clientY;
      // 当帧起手：pressIn（k=900）首帧就走完约 12%，手感是「立刻被捏住」
      Motion.springTo(t, { scale: 0.965 }, { preset: "pressIn", max: 220 });
    }, { passive: true });

    document.addEventListener("pointermove", (e) => {
      if (!el || e.pointerId !== pid) return;
      px = e.clientX; py = e.clientY;
      if (jelly) {
        const dx = px - sx, dy = py - sy, dist = Math.hypot(dx, dy);
        if (!jellyLive) {
          if (dist < 4) return;      // 没拖起来：继续让按压弹簧演
          jellyLive = true;
          skewing = true;            // 不进通用 skew 分支
          Motion.stop(el);           // 手动逐帧接管，弹簧停掉免得互相覆盖
          el.style.transition = "none";
        }
        if (!raf) raf = requestAnimationFrame(() => {
          raf = 0;
          if (!el || !jelly) return;
          const ddx = px - sx, ddy = py - sy, d = Math.hypot(ddx, ddy);
          if (d < 1) { el.style.transform = ""; return; }
          // 拉伸量随拖距软饱和（永不超 .2），沿拖拽轴拉伸、垂直压扁，中心铆钉不动
          const p = Math.min(.2, .2 * d / (d + 34));
          const a = Math.atan2(ddy, ddx) * 180 / Math.PI;
          jp = p; ja = a;
          el.style.transform =
            `rotate(${a.toFixed(2)}deg) scale(${(1 + p).toFixed(4)}, ${(1 - p * .62).toFixed(4)}) rotate(${(-a).toFixed(2)}deg)`;
        });
        return;
      }
      if (!skewing) {
        if (Math.abs(px - sx) < 8 && Math.abs(py - sy) < 8) return;
        skewing = true;
        // 从「弹簧按压」切成「跟手」：先让按下的弹簧落到终值。这不是重启动画，是换驱动方式；
        // 否则逐帧 M.set 的 skew 会被仍在跑的弹簧用旧值盖掉（每帧互相覆盖 → 抖）。
        Motion.stop(el);
      }
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0;
        if (!el) return;
        // dx*0.04 ≈ 50px 到 2°：横向拖动时的「被捏住」侧倾，限幅 ±2°
        const skew = Math.max(-2, Math.min(2, (px - sx) * 0.04));
        Motion.set(el, { scale: 0.965, skew });
      });
    }, { passive: true });

    ["pointerup", "pointercancel", "blur"].forEach((n) =>
      document.addEventListener(n, () => release(n !== "pointerup"), true));
  }

  /** 滚到顶就没有「钻到标题下」的内容，关掉顶部渐隐；一离开顶再打开 */
  function syncChatTopFade() {
    const sc = $("#chatScroll");
    if (!sc) return;
    sc.classList.toggle("is-at-top", sc.scrollTop <= 1);
  }

  /** 悬浮输入框的高度写进 --dock-h：对话内容要延伸到屏幕底，
      底部 padding 必须等于输入框真实高度（多行输入、排队条都会变），否则滚到底时最后一条被挡住 */
  function syncDockHeight() {
    const dock = document.querySelector(".composer-dock");
    if (!dock) return;
    const h = Math.round(dock.offsetHeight);
    if (h > 0) document.documentElement.style.setProperty("--dock-h", h + "px");
  }

  /* 观察器必须被强引用:只 new 不存会被 GC 回收,回调从此不再触发,
     --dock-h 停在某一帧的旧值(实测 reload 后停在 78px、真实 88px)——
     回到底部按钮用它定位,滞后了就和输入框重叠。 */
  let dockRO = null;

  /* ---------------- attachments ---------------- */
  function fmtSize(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
    if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
    return bytes + " B";
  }
  /* 之前 Office/PDF 全用同一个 📄，一屏交付物看上去像同一个文件。
     这里按格式分开：文档蓝、表格绿、演示橙、PDF 红，其余再按文本/代码/压缩区分。 */
  function fileGlyph(a) {
    const n = String(a.name || "").toLowerCase();
    const t = String(a.type || "").toLowerCase();
    if (t.startsWith("image/") || /\.(png|jpe?g|webp|gif|svg|bmp)$/.test(n)) return "🖼";
    if (/\.pdf$/.test(n) || t === "application/pdf") return "📕";
    if (/\.(docx?|rtf|pages)$/.test(n)) return "📘";
    if (/\.(xlsx?|csv|numbers)$/.test(n)) return "📗";
    if (/\.(pptx?|key)$/.test(n)) return "📙";
    if (/\.(zip|rar|7z|tar|gz|tar\.gz)$/.test(n)) return "🗜";
    if (/\.(js|ts|jsx|tsx|py|kt|java|go|rs|c|cpp|h|sh|css|html|json|ya?ml)$/.test(n)) return "🧾";
    if (t.startsWith("text/") || TEXTY.test(n)) return "📝";
    return "📎";
  }

  /**
   * 交付卡片用的彩色格式徽标（比 emoji 更容易一眼区分）。
   * 返回 HTML，调用处不要再 esc。
   */
  function fileBadge(name, mime) {
    const n = String(name || "").toLowerCase();
    const t = String(mime || "").toLowerCase();
    const reDoc = /\.(docx?|rtf|pages|odt)$/, reXls = /\.(xlsx?|csv|numbers|ods)$/;
    const rePpt = /\.(pptx?|key|odp)$/, rePdf = /\.pdf$/;
    const reZip = /\.(zip|rar|7z|tar|gz|bz2|xz)$/;
    const reMd = /\.(md|markdown|mdx)$/;
    const reCode = /\.(js|ts|jsx|tsx|py|kt|kts|java|go|rs|c|cc|cpp|h|hpp|sh|bash|css|scss|html|htm|sql|rb|php|swift)$/;
    const reData = /\.(json|ya?ml|xml|toml|ini|conf|properties)$/;
    const reImg = /\.(png|jpe?g|webp|gif|svg|bmp|avif|heic)$/;
    const reVid = /\.(mp4|m4v|mov|webm|mkv|3gp)$/;
    if (reDoc.test(n) || t.includes("wordprocessingml") || t.includes("msword")) return `<span class="fi fi-word">W</span>`;
    if (reXls.test(n) || t.includes("spreadsheetml") || t.includes("ms-excel")) return `<span class="fi fi-xls">X</span>`;
    if (rePpt.test(n) || t.includes("presentationml") || t.includes("ms-powerpoint")) return `<span class="fi fi-ppt">P</span>`;
    if (rePdf.test(n) || t === "application/pdf") return `<span class="fi fi-pdf">PDF</span>`;
    if (reZip.test(n) || t.includes("zip") || t.includes("compressed")) return `<span class="fi fi-zip">ZIP</span>`;
    if (reMd.test(n)) return `<span class="fi fi-md">MD</span>`;
    // 数据类要排在代码之前：application/json 的 MIME 里也含 "json"，
    // 先判代码会把 .json 显示成一眼看不出是配置的 </>。
    if (reData.test(n) || t.includes("json") || t.includes("yaml") || t.includes("xml")) return `<span class="fi fi-data">{ }</span>`;
    if (reCode.test(n) || t.includes("javascript") || t.includes("ecmascript")) return `<span class="fi fi-code">&lt;/&gt;</span>`;
    if (reImg.test(n) || t.startsWith("image/")) return `<span class="fi fi-img">IMG</span>`;
    if (reVid.test(n) || t.startsWith("video/")) return `<span class="fi fi-vid">VID</span>`;
    if (t.startsWith("text/") || TEXTY.test(n)) return `<span class="fi fi-txt">TXT</span>`;
    return `<span class="fi fi-any">FILE</span>`;
  }
  const TEXTY = /\.(txt|md|markdown|json|csv|log|ya?ml|js|ts|jsx|tsx|css|html|xml|py|kt|java|go|rs|c|cpp|h|sh)$/i;
  /* 图片/视频判定：优先 MIME，其次扩展名（含 SVG —— 它也是图片，只是要走自己的 MIME） */
  const IMG_EXT = /\.(png|jpe?g|webp|gif|svg|bmp|avif|heic|heif|ico)$/i;
  const VID_EXT = /\.(mp4|m4v|mov|webm|mkv|3gp)$/i;
  const stripQuery = (s) => String(s || "").split(/[?#]/)[0];
  const isImageName = (name, mime) =>
    (!!mime && /^image\//i.test(mime)) || IMG_EXT.test(stripQuery(name));
  const isVideoName = (name, mime) =>
    (!!mime && /^video\//i.test(mime)) || VID_EXT.test(stripQuery(name));

  /* ---------------- 缩略图补水 ----------------
     渲染走字符串拼接，本地图片（含 SVG）得先过桥换成 dataUrl 才能显示；
     交付卡片的缩略图同理。统一用 MutationObserver 补，渲染路径不用各自记得调用。 */
  function localImageData(path) {
    if (!(Native && Native.imageData)) return "";
    const p = String(path || "").trim().replace(/^\.\//, "");
    if (!p || /^(data:|https?:|blob:|content:)/i.test(p)) return "";
    try { return Native.imageData(p) || ""; } catch (_) { return ""; }
  }

  function hydrateMedia(scope) {
    const root = scope || $("#messages");
    if (!root || !root.querySelectorAll) return;
    // Markdown 图片：相对路径 → 工作区读成 dataUrl；外链与 dataUrl 原样留
    root.querySelectorAll("img.md-img").forEach((img) => {
      if (img.dataset.hydrated) return;
      img.dataset.hydrated = "1";
      const raw = img.getAttribute("src") || "";
      if (/^(data:|https?:|blob:)/i.test(raw)) return;
      const url = localImageData(raw);
      if (url) img.setAttribute("src", url);
      else img.classList.add("is-broken");
    });
    // 交付卡片 / 列表里的缩略图占位
    root.querySelectorAll("[data-thumb-path]").forEach((el) => {
      if (el.dataset.hydrated) return;
      el.dataset.hydrated = "1";
      const path = el.getAttribute("data-thumb-path") || "";
      const url = localImageData(path);
      if (url) { el.setAttribute("src", url); return; }
      // 读不到图（文件被删 / 路径失效）时退回格式徽标：
      // 只留一个灰底空盒子的话，卡片上看起来跟「没有图标」一样。
      const host = el.closest(".deliver-ico");
      if (host) { host.classList.remove("has-thumb"); host.innerHTML = fileBadge(path, ""); }
      else el.outerHTML = fileBadge(path, "");
    });
  }
  let mediaTick = 0;
  function watchMedia() {
    const box = $("#messages");
    if (!box || box.__mediaWatched) return;
    box.__mediaWatched = true;
    new MutationObserver(() => {
      clearTimeout(mediaTick);
      mediaTick = setTimeout(() => hydrateMedia(), 140);
    }).observe(box, { childList: true, subtree: true });
    hydrateMedia();
  }

  const readAsDataURL = (file) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result || ""));
    r.onerror = () => rej(new Error("读取失败：" + file.name));
    r.readAsDataURL(file);
  });
  const readAsText = (file) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result || ""));
    r.onerror = () => rej(new Error("读取失败：" + file.name));
    r.readAsText(file);
  });

  // 把附件真正塞进请求：图片走 image_url，文本类内联，其它只留元信息
  /* 二进制文档：正文由内核 DocReader 抽取（前端不做 ZIP/PDF 解析） */
  const DOCY = /\.(pdf|docx|docm|xlsx|xlsm|pptx|pptm)$/i;

  async function attachmentParts(atts) {
    const parts = [];
    for (const a of atts) {
      try {
        // 图片优先：表情包这类附件只有 dataUrl、没有 File 对象。
        // 旧代码开头就 `if (!a.file) continue`，把表情包整条跳过 ——
        // 于是模型只收到「我发了一个表情包」这句话，从来看不到图（看起来就像"看不懂表情包"）。
        if ((a.type || "").startsWith("image/")) {
          const url = a.file ? await readAsDataURL(a.file) : (a.dataUrl || "");
          if (url) parts.push({ type: "image_url", image_url: { url } });
          continue;
        }
        if (!a.file) continue;
        if (DOCY.test(a.name) && Native && Native.docText) {
          // 文档附件：抽正文塞进上下文，模型才能真正「看到」这份文件
          if (a.size > 24 * 1024 * 1024) {
            parts.push({ type: "text", text: `\n\n[附件 ${a.name} · ${fmtSize(a.size)}] 文件过大（超过 24MB），未抽取正文。` });
            continue;
          }
          const url = await readAsDataURL(a.file);
          let r = {};
          try { r = JSON.parse(Native.docText(a.name, url) || "{}"); } catch (_) { r = {}; }
          if (r.ok && r.text) {
            const body = r.text.length > 40000 ? r.text.slice(0, 40000) + "\n…（内容过长已截断）" : r.text;
            const meta = [r.kind, r.pages ? `${r.pages} 页` : "", r.slides ? `${r.slides} 页` : ""].filter(Boolean).join(" · ");
            parts.push({ type: "text", text: `\n\n[附件 ${a.name}${meta ? " · " + meta : ""}]\n${body}` });
          } else {
            parts.push({
              type: "text",
              text: `\n\n[附件 ${a.name} · ${fmtSize(a.size)}] 抽不出正文：${r.error || "可能是扫描件、加密文档或纯图片"}` +
                `\n不要猜测文件内容。需要时请让用户提供文字版或截图（可用 read_image 看图）。`,
            });
          }
        } else if (TEXTY.test(a.name)) {
          const raw = await readAsText(a.file);
          const body = raw.length > 40000 ? raw.slice(0, 40000) + "\n…（内容过长已截断）" : raw;
          parts.push({ type: "text", text: `\n\n[附件 ${a.name}]\n${body}` });
        } else {
          parts.push({ type: "text", text: `\n\n[附件 ${a.name} · ${fmtSize(a.size)}，内容未随消息上传]` });
        }
      } catch (_) {
        parts.push({ type: "text", text: `\n\n[附件 ${a.name} 读取失败]` });
      }
    }
    return parts;
  }

  function renderAttachments() {    const tray = $("#attachTray");
    if (!tray) return;
    const has = state.attachments.length > 0;
    tray.style.display = has ? "flex" : "none";
    // 托盘夹在队列和输入框中间时，两者不贴着，输入框保留胶囊圆角（见 has-queue 那条规则）
    const dock = $("#composerDock");
    if (dock) dock.classList.toggle("has-attach", has);
    tray.innerHTML = state.attachments.map((a, i) => `
      <div class="attach-item">
        ${a.thumb ? `<img src="${a.thumb}" alt="" />` : `<span class="ph">${fileGlyph(a)}</span>`}
        <button class="attach-x" data-attach-x="${i}">✕</button>
        <span class="attach-name">${esc(a.name)}</span>
        <span class="attach-size">${fmtSize(a.size)}</span>
      </div>`).join("");
  }

  /* ---------------- 电脑会话：选图与压缩 ----------------
     电脑那条链路只带图片（桌面端 /session/:id/prompt 的 images 是 PromptContentPart.image），
     而且限 ≤4 张；信封还要再套一层 base64（中继 body 有上限）。手机原图动辄 3~8MB，
     原样发就是「发送失败」，所以先在手机里缩：长边 1600 起、质量逐档降，
     单张 base64 ≤ 900k、整条消息 ≤ 3.2M —— 用户看到的还是他选的那张图。 */
  const PC_IMG = { max: 4, per: 900_000, total: 3_200_000, sides: [1600, 1280, 1080], qs: [0.82, 0.7, 0.62, 0.55, 0.45] };
  const b64OfDataUrl = (url) => { const i = String(url || "").indexOf(","); return i < 0 ? "" : String(url).slice(i + 1); };
  const bytesOfB64 = (text) => Math.round(String(text || "").length * 0.75);

  async function loadImage(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file); } catch (_) { /* 落到 <img> 那条路 */ }
    }
    return await new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("这张图读不出来")); };
      img.src = url;
    });
  }

  /** 缩到这条链路装得下：返回 {dataUrl, size, mime}。GIF 原样保留动画，超预算才拒绝。 */
  async function shrinkImage(file) {
    if ((file.type || "") === "image/gif") {
      const url = await readAsDataURL(file);
      if (b64OfDataUrl(url).length <= PC_IMG.per) return { dataUrl: url, size: file.size, mime: "image/gif" };
      throw new Error("GIF 太大，这条链路装不下（换静态图或先压一下）");
    }
    const bmp = await loadImage(file);
    try {
      const w0 = bmp.width || 0, h0 = bmp.height || 0;
      const long = Math.max(w0, h0) || 1;
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      for (const side of PC_IMG.sides) {
        const k = Math.min(1, side / long);
        canvas.width = Math.max(1, Math.round((w0 || long) * k));
        canvas.height = Math.max(1, Math.round((h0 || long) * k));
        // 透明 PNG 转 JPEG 会变黑底：先铺白
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        for (const q of PC_IMG.qs) {
          const url = canvas.toDataURL("image/jpeg", q);
          if (b64OfDataUrl(url).length <= PC_IMG.per) {
            return { dataUrl: url, size: bytesOfB64(b64OfDataUrl(url)), mime: "image/jpeg" };
          }
        }
      }
      throw new Error("这张图缩到最小还是太大");
    } finally {
      if (bmp && bmp.close) { try { bmp.close(); } catch (_) {} }
    }
  }

  /** 电脑会话的「添加图片」：走页面上那个隐藏 input（用户手势直接触发，不动态造节点）。 */
  function pickPcImages() {
    const el = $("#pcImageInput");
    if (el) el.click();
  }

  /** 选好的图：压到链路装得下再进附件托盘，随下一条消息一起发出去。 */
  async function addPcImages(files) {
    const room = Math.max(0, PC_IMG.max - state.attachments.length);
    if (files.length > room) toast("电脑会话最多 " + PC_IMG.max + " 张图，多出来的没加");
    for (const f of files.slice(0, room)) {
      if (!(f.type || "").startsWith("image/")) { toast("电脑会话只能带图片：" + f.name); continue; }
      try {
        const fit = await shrinkImage(f);
        const used = state.attachments.reduce((n, a) => n + b64OfDataUrl(a.dataUrl).length, 0);
        if (used + b64OfDataUrl(fit.dataUrl).length > PC_IMG.total) { toast("图片总大小超了，这张没加：" + f.name); continue; }
        state.attachments.push({ name: f.name, size: fit.size, type: fit.mime, file: f, thumb: fit.dataUrl, dataUrl: fit.dataUrl });
      } catch (e) {
        toast((e && e.message) || (f.name + " 加不进来"));
      }
    }
    renderAttachments();
    // 只发图时发送键靠「有附件」点亮：加完要立刻重算一次，否则按钮还是灰的
    updateSendState();
  }

  async function streamText(text) {
    const el = push(NODES.text(""), false);
    const body = $(".assistant-text", el);
    let acc = "";
    for (let i = 0; i < text.length; i += 2) {
      acc += text.slice(i, i + 2);
      body.innerHTML = md(acc);
      if (i % 12 === 0) scrollToBottom();
      await sleep(11);
    }
    body.innerHTML = md(text);
  }

  /* ---------------- router ---------------- */
  /* 拖拽松手时传给落位弹簧的水平速度（px/s）：拖动中 Motion.set 会把内存速度清零，
     不接续的话「甩出去」的手感在松手瞬间被杀死，滑块像被按停一样。一次性消费。 */
  let tabSnapVx = 0;
  function moveTabIndicator(snap) {
    const ind = $("#tabIndicator");
    const bar = $("#tabbar");
    const active = $(".tab.is-on");
    if (!ind || !bar || !active) return;
    // 必须用布局空间量取（offsetLeft/offsetWidth 不含 transform）：松手后导航条还挂着
    // 形变回弹弹簧（scaleX≠1，ζ0.61 全程 ~600ms 还带过冲），getBoundingClientRect 量到
    // 的是缩放后的视觉距离，写进滑块 translateX 后又被 bar 的 scale 再乘一次 ——
    // 落位 = 真实偏移 × sx²，偏移量 ∝ tab 离左边的距离：设置 tab 最右偏得最多（rc.109
    // 用户实测「回弹到设置上滑块偏左」）。
    const x = active.offsetLeft + 6;
    const w = Math.max(0, active.offsetWidth - 12);
    if (!MOTION_MODERN) {
      ind.style.width = w + "px";
      ind.style.transform = `translateX(${x}px)`;
      return;
    }
    // 第一次落位（或显式 snap）：直接写终值 —— 入场时不该从 0 滑一下
    if (!ind.__mPlaced || snap === true) {
      ind.__mPlaced = true;
      Motion.set(ind, { x, width: w });
      TabHighlight.paint();
      return;
    }
    // 切页 / 拖动松手落位：press 弹簧；重复调用会从当前值 + 当前速度接管，不叠层、可打断
    // transition 必须内联关掉：CSS 的 .tab-indicator{transition:transform .46s} 在松手后
    // （is-dragging 摘除）恢复生效，会把弹簧每帧写的内联值当过渡目标插值 —— 渲染值永远
    // 追着滞后 ~.46s 的尾巴， overshoot 被抹平、落位变「面」。rc.106 实测复现。
    ind.style.transition = "none";
    const vx = tabSnapVx; tabSnapVx = 0;
    // 落地回弹：先给一点点「压下去」的预热（1.05），弹簧再收回 1 ——
    // 这是替代图标位移动画的轻量动感。裁剪读的是滑块实际矩形，缩放不会破坏对齐。
    try { Motion.set(ind, { scale: 1.04 }); } catch (_) {}
    Motion.springTo(ind, { x, width: w, scale: 1 }, {
      preset: "press", max: 340,
      velocity: vx ? { x: vx } : undefined,
      // 关键：裁剪跟着 Motion 的**同一帧**走。放在自己的 rAF 里会晚一帧，
      // 快速切页时蓝区就落在滑块后面，看起来像「叠层残影」（真机实测）。
      onUpdate: () => TabHighlight.paint(),
      onComplete: () => { ind.style.transition = ""; TabHighlight.paint(); },
    });
  }

  /* Tab 符号的方向性切换动画：入从来源方向滑入，出朝切走的方向让位。
     点击 go() 与拖动滑块松手两条路径都汇到这里，保证动画方向永远与滑块移动方向一致。 */
  let lastIconAnimAt = 0;
  function animateTabIcons(fromEl, toEl) {
    if (!fromEl || !toEl || fromEl === toEl) return;
    if (!MOTION_MODERN || MOTION_REDUCE()) return;
    // 覆盖染色模式下不播图标「出入场」动画（位移 + 缩放）：
    // 那时图标一部分落在蓝层、一部分落在灰层，裁剪是按**位置**切的 ——
    // 动画期间同一颗图标被切成两段画在两地，看起来就是「残影」和「到位时闪一下叠层」。
    // 染色本身已经是逐帧的位置反馈，不需要再加位移花活。
    if (TabHighlight.ready) return;
    // 快速连点时不播图标动画：上一段「让位/入场」还没跑完就叠下一段，
    // 两个动画抢同一个图标的 transform，看起来就是图标在「弹」（真机实测）。
    const now = performance.now();
    if (now - lastIconAnimAt < 260) return;
    lastIconAnimAt = now;
    const ord = (el) => Array.prototype.indexOf.call(el.parentElement.children, el);
    const rightward = ord(toEl) > ord(fromEl);
    const tabs = Array.from(document.querySelectorAll("#tabbar > .tab"));
    const play = (tabEl, cls) => {
      const ico = tabEl.querySelector(".ico");
      if (!ico) return;
      // 覆盖层里还有一份同款 .ico（蓝色副本，按真实 tab 绝对定位、逐像素重合）。
      // 只给基础层图标挂动画的话，切换期间它在滑、副本原地不动 —— 两层错开就是
      // 「快速切换时蓝白叠层」（真机实测）。把同一动画类同步挂到副本图标。
      const idx = tabs.indexOf(tabEl);
      const ghosts = [];
      for (const ov of [tabBlue, tabIdle]) {
        if (!ov || idx < 0) continue;
        const g = ov.querySelectorAll(".tab-ghost")[idx];
        const gi = g && g.querySelector(".ico");
        if (gi) ghosts.push(gi);
      }
      const icons = [ico, ...ghosts].filter(Boolean);
      for (const el of icons) el.classList.remove("ico-in-l", "ico-in-r", "ico-out-l", "ico-out-r");
      void ico.getBoundingClientRect();   // 重启动画（连切时也从头来）
      for (const el of icons) {
        el.classList.add(cls);
        clearTimeout(el.__icoT);
        el.__icoT = setTimeout(() => el.classList.remove(cls), 560);
      }
    };
    play(toEl, rightward ? "ico-in-l" : "ico-in-r");
    play(fromEl, rightward ? "ico-out-r" : "ico-out-l");
  }

  /* 正在跑的那一轮页面切换：切页途中再切页时先把它立刻收尾，避免两层页面叠着发光 */
  let screenTween = null;
  /* 从对话返回时「延后露出底部胶囊」的定时器（见 go()） */
  let tabbarTimer = 0;
  function settleScreenTween(st) {
    if (!st) return;
    if (st.timer) { clearTimeout(st.timer); st.timer = 0; }
    // 胶囊的延后露出到点没跑完就立刻补上（绝不能让 tabbar 一直藏着）
    if (tabbarTimer) {
      clearTimeout(tabbarTimer); tabbarTimer = 0;
      const tb = $("#tabbar");
      if (tb) {
        try { Motion.stop(tb); Motion.clear(tb); } catch (_) {}
        tb.classList.remove("is-hidden");
      }
    }
    try { if (st.im) st.im.stop(); } catch (_) {}
    try { if (st.om) st.om.stop(); } catch (_) {}
    // 动效 v3 的 transitionend 监听：中断收尾时必须摘掉，否则监听器随页面常驻
    if (st.onEnd) { try { st.onEnd.el.removeEventListener("transitionend", st.onEnd.fn); } catch (_) {} st.onEnd = null; }
    // chrome（顶栏/上下文条/悬浮输入框）：先停掉各自的弹簧，再擦内联，
    // 否则下一次进入会带着上一轮的 opacity/transform 起手（返回时「玻璃顶栏还在」就是这么来的）
    (st.chrome || []).forEach((el) => {
      try { Motion.stop(el); } catch (_) {}
      try { Motion.clear(el); } catch (_) {}
    });
    [st.inEl, st.outEl].forEach((el) => {
      if (!el) return;
      // push 完成后：底层会话页的压暗层（tween-under 类 + --under-dim）留给 pop 连续淡出，
      // 但**其余复位必须照做** —— 尤其 is-leaving 必须移除：.screen 非 active 默认
      // visibility:hidden，唯一让会话页仍可见的就是 is-leaving；整块跳过会让它一直露在
      // 透明的对话页底下（rc.127 回归：新建会话后对话页透出会话页 + 压暗灰层）。
      const keepDim = el === st.chatUnder && st.keepUnder;
      el.classList.remove("is-leaving", "tween-shadow");
      if (!keepDim) el.classList.remove("tween-under");
      el.style.zIndex = "";
      el.style.visibility = "";
      el.style.willChange = "";
      // 动效 v3：pose() 写下的 transition/transform/opacity 也要一并擦掉，
      // 中断收尾 = 直接落在终态；不清的话下一轮起手会带上一轮的过渡和位移
      el.style.transition = "";
      el.style.transform = "";
      el.style.opacity = "";
      if (!keepDim) el.style.removeProperty("--under-dim");   // 保留时留给 pop 淡出；否则复位，免得下一轮 pop 不压暗
      try { Motion.clear(el); } catch (_) {}
    });
    // 玻璃恢复与摘层同帧做（rc.124 实测：拆到 +34ms 并没有更顺，坏帧反而多 ——
    // 恢复玻璃的那一帧成本固定，晚一帧只是把顿挪个位置，还多一次跨帧状态）
    document.documentElement.classList.remove("screen-tweening");
    st.glassTimer = 0;
  }

  function go(screen, opts) {
    // 切屏先收面板：设置里打开的抽屉留在 DOM 上，会盖住新页面，
    // 还会让 wakeReady 以为「用户正在看面板」而一直不认领唤醒（真机实锤）。
    if (sheetOpen && screen !== state.screen) { try { closeSheet(); } catch (_) {} }
    // 离开对话页就停声：语音消息不该在列表页/设置页背后继续念
    if (state.screen === "chat" && screen !== "chat") {
      try { VoicePlay.stopAll(); } catch (_) {}
      try { SpeechOut.stop(); } catch (_) {}
      // 不在对话页了：任何会话的「需要确认」都该弹系统提醒
      try { if (Native && Native.setActiveSession) Native.setActiveSession(""); } catch (_) {}
    }
    const from = state.screen;
    // 上一轮还没跑完就再切：先把它立刻收尾（摘类、清内联），否则两层页面会叠在一起
    if (screenTween) {
      const prev = screenTween; screenTween = null;
      if (prev.glassTimer) { clearTimeout(prev.glassTimer); prev.glassTimer = 0; }  // 别让旧收尾摘掉新一轮的玻璃开关
      settleScreenTween(prev);
    }
    state.screen = screen;
    // 回到对话页：把当前会话的进行中工作对齐一次，并认领队列里的唤醒
    if (screen === "chat") setTimeout(() => {
      try { syncMissions(); } catch (_) {}
      try { wakeMissions(); } catch (_) {}
    }, 0);
    const inEl = document.querySelector(`.screen[data-screen="${screen}"]`);
    const outEl = from && from !== screen ? document.querySelector(`.screen[data-screen="${from}"]`) : null;
    $$(".screen").forEach((s) => s.classList.toggle("is-active", s.dataset.screen === screen));
    const prevTab = $(".tab.is-on");
    $$(".tab").forEach((t) => t.classList.toggle("is-on", t.dataset.tab === screen));
    if (from && from !== screen) animateTabIcons(prevTab, $(`.tab[data-tab="${screen}"]`));
    // 底部胶囊：进对话立刻收起；从对话返回时，聊天页的输入框还要 ~140ms 才淡完，
    // 胶囊立刻弹出会和它叠在屏幕底部 → 先保持隐藏，120ms 后再摘（timer 见 settleScreenTween）。
    const tabbarEl = $("#tabbar");
    if (tabbarEl) {
      if (tabbarTimer) { clearTimeout(tabbarTimer); tabbarTimer = 0; }
      // 导航条可被纵向拖拽形变，Motion 写的内联 transform 优先级高于 .is-hidden 的类样式：
      // 不清就会出现「已经进对话了，胶囊还歪着浮在底部」。切换 contain 必须先把形变收干净。
      try { Motion.stop(tabbarEl); Motion.clear(tabbarEl); tabbarEl.classList.remove("is-dragging"); } catch (_) {}
      TabHighlight.barDeforming = false;   // 形变被强行清掉：折算系数回到 1:1
      if (screen === "chat") tabbarEl.classList.add("is-hidden");
      else if (from === "chat" && MOTION_MODERN && !MOTION_REDUCE()) {
        tabbarTimer = setTimeout(() => {
          tabbarTimer = 0;
          const tb = $("#tabbar");
          if (tb) {
            try { Motion.stop(tb); Motion.clear(tb); tb.classList.remove("is-dragging"); } catch (_) {}
            tb.classList.remove("is-hidden");
          }
        }, 120);
      } else tabbarEl.classList.remove("is-hidden");
    }
    // 回到会话页就重取一次：本地列表按 LocalDB 现算，宿主机列表要重新问一次，
    // 否则刚聊完退回来还挂着上一轮的摘要。
    // 整列表重建会触发布局/重绘：动画在跑时压在首帧上就是掉帧。
    // 有切换动画就等它收尾（≈340ms）再重建，用户看不出这点延迟；没有动画才用一帧后。
    if (screen === "sessions") {
      const refresh = () => {
        if (state.screen !== "sessions") return;   // 这段时间里用户又切走了
        if (currentMode() === "host") loadSessions();
        else renderSessions($("#searchSessions") ? $("#searchSessions").value : "");
      };
      const tweening = MOTION_MODERN && !MOTION_REDUCE() && from && from !== screen;
      // 430ms：切换收尾（摘合成层+玻璃恢复 ~240-280ms）之后，错开同一帧
      if (tweening) setTimeout(refresh, 430);
      else requestAnimationFrame(refresh);
    }
    if (screen === "jobs") {
      // 任务页与「会话页」同一个教训：只靠启动时渲染一次，启动瞬间内核还没就绪
      // scheduleList 返回空，或任务是对话里后来建的/刚到点变结束 —— 页面就永远停在
      // 旧快照上，看起来就是「任务记录消失了」。每次进页都现读一次。
      const refresh = () => {
        if (state.screen !== "jobs") return;
        renderJobs();
      };
      const tweening = MOTION_MODERN && !MOTION_REDUCE() && from && from !== screen;
      if (tweening) setTimeout(refresh, 430);
      else requestAnimationFrame(refresh);
    }
    if (screen === "settings") {
      // 进设置页的两件事都推到动画之后（430ms）：余额要发网络请求、记忆条数要读文件，
      // 压在切换首帧上就是"每点一次设置都顿一下"。用户看不出这点差别。
      const after = MOTION_MODERN && !MOTION_REDUCE() && from && from !== screen ? 430 : 0;
      const sync = () => {
        if (state.screen !== "settings") return;
        refreshMemCount();
        refreshStorageRow();
        if (Date.now() - (state.balanceAt || 0) > 60000) refreshBalance();
      };
      if (after) setTimeout(sync, after); else sync();
    }
    requestAnimationFrame(moveTabIndicator);
    // 切页后滑块还要滑 ~460ms（弹簧/过渡）：这段时间的蓝必须跟着滑块走。
    // 之前只靠 is-on 整颗点亮，滑块还没到时新页整颗已经蓝了、旧页也还蓝着 ——
    // 就是「滑块外边还有变蓝」的来源。
    // Motion 路径下 onUpdate 每帧已经画过；这里只为「CSS 过渡」兜底（legacy / 减弱动效），
    // 否则就是每帧画两遍 —— 之前切换掉帧的一半来自这里。
    if (screen !== "chat" && !(MOTION_MODERN && !MOTION_REDUCE())) TabHighlight.follow(620);
    // 这里**不再**调 applyLang()：它会用 TreeWalker 全量扫 body 做翻译，
    // 语言没变也照扫一遍，正好压在切换动画的首帧上（实测切换掉帧的主因之一）。
    // 语言切换走 setLang；新插入的 DOM 由 langObserver 增量翻译。
    // 首次进入 / 重复点同一个 Tab：没有「从哪来」，不做切换动画
    if (!inEl || !outEl || from === screen) return;
    if (!MOTION_MODERN || MOTION_REDUCE()) return;   // 旧模式 / 减弱动效：类名切完就是终态

    /* ===== 切页动效 v3（rc.125）=====
       Tab 之间：Material 3 fade-through —— 旧页 140ms 淡出并微缩到 .98，
       新页延迟 80ms 从 .96 缩放淡入（emphasized 曲线）。层次靠缩放表达，没有横移。
       会话 ↔ 对话：iOS 式全幅推入/推出 —— 对话页整页从右滑入（push）/ 滑出（pop），
       底下的会话页向左视差退让 24% 并压暗；顶栏/输入框随页面一起滑，不再单独编排。
       实现走内联 CSS transition：transform/opacity 的插值在合成器线程上跑，
       主线程只在起、止各写一次值 —— 比 Motion 逐帧写样式省一整个每帧税。 */
    document.documentElement.classList.add("screen-tweening");
    const st = { inEl, outEl, im: null, om: null, timer: 0, chrome: [], onEnd: null, chatUnder: null, keepUnder: false };
    const chat = screen === "chat" || from === "chat";
    const EASE = "cubic-bezier(0.2, 0, 0, 1)";
    // 起始值必须本帧同步写入且不带过渡：is-active 会让 CSS 立刻 opacity:1，慢一帧就闪
    const pose = (el, props, trans) => {
      el.style.transition = "none";
      for (const k in props) el.style[k] = props[k];
      void el.offsetWidth;                 // 强制同步布局：让起始值先落地
      el.style.transition = trans;
    };
    const done = () => {
      if (screenTween !== st) return;      // 已被下一轮接管，别去动新一轮的样式
      screenTween = null;
      settleScreenTween(st);
    };
    outEl.classList.add("is-leaving");     // 离场页保持可见、不吃触摸（见 .is-leaving 规则）
    outEl.style.visibility = "visible";
    if (chat) {
      // push：对话页压顶从右滑入；pop：对话页滑出，会话页从视差位归位。
      // 层级不再固定「入场在上」：谁是对话页谁在上（iOS 导航栈语义）。
      const push = screen === "chat";
      const top = push ? inEl : outEl;
      const under = push ? outEl : inEl;
      // 记录「持续压暗的底层」：进入对话页后底层会话页保持压暗（被对话页盖住），
      // 直到返回会话页才清。否则返回那一下底层 ::after 会「重新出现即 .14」，
      // 先啪地变暗再淡亮 —— 正是用户点名的「闪暗、变化太直接」。
      st.chatUnder = under;
      st.keepUnder = push;
      top.style.zIndex = "3";
      under.style.zIndex = "2";
      top.style.willChange = "transform";
      under.style.willChange = "transform";
      // 进入时先把压暗置 0（透明）再加类：加类那一帧伪元素透明出现，下一帧 rAF
      // 才升到目标值 —— 进入柔和不闪；返回时底层已持续压暗，不必重置。
      if (push) under.style.setProperty("--under-dim", "0");
      under.classList.add("tween-under");  // 底层页压暗层（::after，见 styles.css 动效 v3）
      top.classList.add("tween-shadow");   // 滑动页带投影，浮在底层之上
      pose(top, { opacity: "1", transform: push ? "translateX(100%)" : "translateX(0)" }, `transform 360ms ${EASE}`);
      pose(under, { opacity: "1", transform: push ? "translateX(0)" : "translateX(-24%)" }, `transform 360ms ${EASE}`);
      requestAnimationFrame(() => {
        top.style.transform = push ? "translateX(0)" : "translateX(100%)";
        under.style.transform = push ? "translateX(-24%)" : "translateX(0)";
        // 压暗层与滑动同帧驱动、连续过渡：进入随对话页滑入渐深（0→.14），
        // 返回随对话页滑出渐浅（.14→0）。两端对称，不再有「先暗后亮」的跳变。
        under.style.setProperty("--under-dim", push ? ".14" : "0");
      });
      const onEnd = (e) => {
        if (e.target !== top || e.propertyName !== "transform") return;
        top.removeEventListener("transitionend", onEnd);
        done();
      };
      top.addEventListener("transitionend", onEnd);
      st.onEnd = { el: top, fn: onEnd };
    } else {
      // Tab 之间：fade-through（旧页快淡出，新页延迟 80ms 缩放淡入）
      inEl.style.zIndex = "2";
      outEl.style.zIndex = "1";
      outEl.style.willChange = "transform, opacity";
      inEl.style.willChange = "transform, opacity";
      pose(outEl, { opacity: "1", transform: "scale(1)" }, `transform 140ms ${EASE}, opacity 140ms ${EASE}`);
      pose(inEl, { opacity: "0", transform: "scale(0.96)" }, `transform 260ms ${EASE} 80ms, opacity 260ms ${EASE} 80ms`);
      requestAnimationFrame(() => {
        outEl.style.opacity = "0";
        outEl.style.transform = "scale(0.98)";
        inEl.style.opacity = "1";
        inEl.style.transform = "scale(1)";
      });
      const onEnd = (e) => {
        if (e.target !== inEl || e.propertyName !== "opacity") return;
        inEl.removeEventListener("transitionend", onEnd);
        done();
      };
      inEl.addEventListener("transitionend", onEnd);
      st.onEnd = { el: inEl, fn: onEnd };
    }
    // 保险：transitionend 偶发不触发（WebView 丢事件 / 页面被切走）时定时器兜底收尾
    st.timer = setTimeout(done, chat ? 400 : 380);
    screenTween = st;
  }

  /* 底部胶囊：左右拖动切换页面，玻璃滑块跟随手指 */
  let tabJustDragged = false;

  /* 覆盖式高亮的实现全部在下面的 TabHighlight（单一模块、单一数据流）。 */
  /* ---- 悬浮导航栏「整体」纵向拖拽形变（rc.107）----
     此前 Motion.drag 锁成 axis:"x"，纵向 dy 被硬写成 0，所以导航条只能横向拖出滑块、
     完全不能被竖向拽动。放开成 "xy" 后按下列模型逐帧算形变：

       ① 跟手位移取软饱和而非线性：shift = sign(dy)·D·|dy|/(|dy|+K)（D=22px / K=70）。
          起手轻快、越拖越沉，远端位移增益趋于 0 —— 像拽一条有弹性的带子，
          而不是「拖多少走多少」的贴纸。这是肌肉阻尼的人因写法。
       ② 形变按「拉伸轴拉长、垂直轴反向补偿」（近似体积守恒，与圆形按钮同源）：
            向上拔起 → scaleY 1+q / scaleX 1−0.62q
            向下按压 → scaleY 1−0.62q / scaleX 1+0.45q
          q = Q·|shift|/(|shift|+26)，Q=0.17（最大形变 17%）。
       ③ 铆钉在底边（CSS transform-origin: 50% 100%）：悬浮栏「挂」在屏幕底沿，
          向上是被拔长的软体，向下是被压扁的垫子，不会整体上蹿下跳。
       ④ 松手由弹簧从当前值 + 手指实际速度接管：甩过一次就多一次小回弹，
          而不是 CSS 定速归位。
          阻尼比是这里唯一的旋钮：通用 press（k420/c34 → ζ≈0.83）理论过冲只有 0.9%，
          11px 的形变回摆 0.1px，肉眼就是「慢慢爬回去」，没有 Q 弹（rc.107 实测复现）。
          所以导航条形变回弹自带一组 ζ≈0.61（k300/c21 → 过冲 ≈9%）的专用弹簧：
          看得见一次干净回弹，又不至于像玩具那样抖好几下；甩得越狠回摆越大（速度另算）。 */
  const VB_D = 22, VB_K = 70, VB_Q = 0.17;
  const VB_BACK = { k: 300, c: 21, m: 1 };
  function tabBarDeform(dy) {
    const a = Math.abs(dy || 0);
    const shift = (dy < 0 ? -1 : 1) * VB_D * a / (a + VB_K);
    const q = VB_Q * Math.abs(shift) / (Math.abs(shift) + 26);
    const up = shift < 0;
    return { y: shift, scaleY: up ? 1 + q : 1 - q * 0.62, scaleX: up ? 1 - q * 0.62 : 1 + q * 0.45 };
  }
  function writeTabBarDeform(bar, dy) {
    const d = tabBarDeform(dy);
    TabHighlight.barDeforming = true;      // 这一帧起导航条带 scale，裁剪要折算
    Motion.set(bar, d);
    // 覆盖绘制的水平折算要用同一个 scaleX（读回 computedStyle 会强制样式重算）
    return d;
  }
  /** 松手 Q 弹。dy = 松手瞬间的形变输入（与 writeTabBarDeform 同一坐标系，含副轴耦合），
      vFling = 手指速度 px/ms。
      关键：手指速度绝不能直接灌进弹簧 —— 形变 y 是软饱和映射，导航条视觉速度只有
      手指速度的 slope = VB_D·VB_K/(|dy|+VB_K)² 倍（中心处 ≤0.314，拖得越深越小）。
      rc.108 实测：直接灌 ±3000px/s，k300 弹簧振幅被吹到 ~170px，松手瞬间导航条
      上蹿几十像素再荡回来 —— 就是用户说的「跳跃式」。按局部斜率折算成导航条
      真实在动的速度、再夹到 ±420px/s（振幅 ≈ 24px → 一次干净的小 Q 弹，不再跳）。 */
  function releaseTabBar(bar, dy, vFling) {
    if (!bar) return;
    const a = Math.abs(dy || 0);
    const slope = VB_D * VB_K / ((a + VB_K) * (a + VB_K));
    const vy = Math.max(-420, Math.min(420, (vFling || 0) * 1000 * slope));
    Motion.springTo(bar, { y: 0, scaleX: 1, scaleY: 1 }, {
      preset: VB_BACK, velocity: { y: vy }, max: 620,
      // is-dragging 期间 transition 被关掉（见 styles.css），必须等回弹跑完才恢复，
      // 否则 CSS 的 transform .28s 会把弹簧每帧写入插值成滞后。
      // 收尾还要把内联擦干净：回弹终值的 translate3d(0,0,0) 会盖住 .is-hidden 的类样式，
      // 出现「已经进对话页、胶囊还不走」。
      onComplete: () => {
        try { bar.classList.remove("is-dragging"); Motion.clear(bar); } catch (_) {}
        TabHighlight.barDeforming = false;   // 形变弹簧收尾：回到 1:1
        TabHighlight.paint();
      },
    });
  }

  /* ============================================================================
   * TabHighlight —— 底部导航的「胶囊染色」模块（rc.118 重写，唯一实现）
   *
   * 职责单一：让**胶囊盖到的位置**变蓝（图标与文字同一规则），且屏幕上永远只有一层墨。
   *
   * DOM 分工：
   *   #tabbar
   *     ├─ .tab × N            基础层：只提供布局与字形尺寸，渲染时整体透明（不画字）
   *     ├─ #tabIndicator       玻璃胶囊：唯一的位置真值（Motion 逐帧写 transform/width）
   *     ├─ .tab-blue-overlay   蓝副本：只显示「胶囊内」
   *     └─ .tab-idle-overlay   灰副本：只显示「胶囊外」，与蓝层互补
   *
   * 数据流（单向，没有第二份位置状态）：
   *   Motion 写滑块 → 同一帧 onUpdate → paint()
   *   → 读滑块 getBoundingClientRect() → 换算到导航条本地坐标 → 同时写两层 clip-path
   *
   * 三条不变量（改动前先读）：
   *   1. 位置只有一个真值 = 滑块的实际矩形。不要用「写入坐标 × 形变」自己再算一遍，
   *      也不要缓存矩形：缓存会与 Motion 差一帧 → 快速切换留残影。
   *   2. 副本不许位移/缩放：按真实 tab 的 offset* 绝对定位，字形栅格化与基础层一致；
   *      一旦给副本加 transform 必出重影（前几版踩过三次）。
   *   3. 基础层不画字：否则蓝色下面会透出白字（观感是「图标四周发白」）。
   * ========================================================================== */
  const TabHighlight = {
    blue: null,
    idle: null,
    ready: false,
    raf: 0,
    until: 0,
    /** 导航条是否正在被纵向手势形变（只有这时才需要折算 scale） */
    barDeforming: false,
    _last: "",

    /** 建（或重建）两层副本。语言切换、tab 文案变化时调用。 */
    build() {
      const bar = $("#tabbar");
      if (!bar) return;
      bar.classList.add("cover-live");
      for (const old of bar.querySelectorAll(".tab-blue, .tab-lens, .tab-blue-overlay, .tab-idle-overlay")) old.remove();
      const mk = (cls, ghostCls) => {
        const ov = document.createElement("div");
        ov.className = cls;
        ov.setAttribute("aria-hidden", "true");
        for (const tab of bar.querySelectorAll(":scope > .tab")) {
          const c = document.createElement("div");
          c.className = "tab " + ghostCls;
          // 与真实 tab 同框：绝对定位 + 原样复制尺寸，字形栅格化逐像素对齐
          c.style.position = "absolute";
          c.style.left = tab.offsetLeft + "px";
          c.style.top = tab.offsetTop + "px";
          c.style.width = tab.offsetWidth + "px";
          c.style.height = tab.offsetHeight + "px";
          for (const child of Array.from(tab.children)) c.appendChild(child.cloneNode(true));
          ov.appendChild(c);
        }
        bar.appendChild(ov);
        return ov;
      };
      this.blue = mk("tab-blue-overlay", "tab-ghost");
      this.idle = mk("tab-idle-overlay", "tab-ghost tab-ghost-idle");
      this.ready = true;
      this._bindPress();
      this.paint();
    },

    /** 胶囊轮廓（多边形采样）：直线段近似圆弧，比 arc 标志位稳 */
    _capsule(x, w, y, h) {
      const n = 8, r = Math.min(w, h) / 2, cy = y + h / 2, pts = [];
      pts.push([x + r, y]);
      pts.push([x + w - r, y]);
      for (let i = 1; i <= n; i++) {
        const a = -Math.PI / 2 + (Math.PI * i) / n;
        pts.push([x + w - r + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
      pts.push([x + r, y + h]);
      for (let i = 1; i <= n; i++) {
        const a = Math.PI / 2 + (Math.PI * i) / n;
        pts.push([x + r + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
      return pts;
    },

    /** 唯一入口：读滑块实际矩形 → 写两层裁剪。可安全地每帧调用。 */
    paint() {
      const bar = $("#tabbar"), ind = $("#tabIndicator");
      if (!bar || !ind || !this.blue || !this.idle) return;
      const ir = ind.getBoundingClientRect(), br = bar.getBoundingClientRect();
      // 导航条自身可能带形变（拖动时被拉长/压扁）：rect 是视觉像素，
      // 而 clip-path 写在本地坐标系，必须除掉这层 scale。滑块自身的 scale
      // （落地回弹）已经包含在 ir 里，正是我们要的。
      let sx = 1, sy = 1;
      if (this.barDeforming) {
        const tf = getComputedStyle(bar).transform;
        if (tf && tf !== "none" && typeof DOMMatrix !== "undefined") {
          const m = new DOMMatrix(tf);
          if (m.a) sx = m.a;
          if (m.d) sy = m.d;
        }
      }
      const W = bar.clientWidth, H = bar.clientHeight;
      const x = (ir.left - br.left) / sx, w = ir.width / sx;
      const y = (ir.top - br.top) / sy, h = ir.height / sy;
      const l = Math.max(0, x), r = Math.max(0, W - (x + w));
      const t = Math.max(0, y), b = Math.max(0, H - (y + h));
      // 位置没变就别写：clip-path 一变就整层重绘，弹簧落位后的空转帧尤其亏
      const key = `${l.toFixed(1)}|${r.toFixed(1)}|${t.toFixed(1)}|${b.toFixed(1)}|${sx.toFixed(3)}|${sy.toFixed(3)}`;
      if (key === this._last) return;
      this._last = key;
      // 蓝层：胶囊内（round 半径 ≥ 半高 → 浏览器收敛成 h/2，形状即胶囊本尊）
      this.blue.style.clipPath =
        `inset(${t.toFixed(1)}px ${r.toFixed(1)}px ${b.toFixed(1)}px ${l.toFixed(1)}px round 999px)`;
      // 灰层：外框（顺时针）+ 胶囊（反向 → 逆时针）= 中间挖空，与蓝层互补不重叠
      const pts = this._capsule(l, w, t, h).reverse();
      const d = `M0 0H${W}V${H}H0Z M${pts.map((q) => q[0].toFixed(1) + " " + q[1].toFixed(1)).join("L")}Z`;
      this.idle.style.clipPath = `path("${d}")`;
    },

    /** 跟拍：滑块还在动的窗口里逐帧 paint，落位后自动停。ms = 预计动画时长。 */
    follow(ms) {
      const bar = $("#tabbar");
      if (!bar || !this.ready) return;
      this.until = Math.max(this.until, performance.now() + (ms || 700));
      if (this.raf) return;
      const step = () => {
        this.raf = 0;
        if (!bar.isConnected) return;
        this.paint();
        if (performance.now() < this.until) this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
    },

    /** 松手：弹簧/回弹大约还要跑 600~700ms，跟到落位 */
    release() { this.follow(720); },

    /** 按压反馈：基础层图标是透明的，:active 的缩放打不到，落在副本上 */
    press(idx, on) {
      if (idx < 0) return;
      for (const ov of [this.blue, this.idle]) {
        if (!ov) continue;
        const g = ov.querySelectorAll(".tab-ghost")[idx];
        if (g) g.classList.toggle("is-pressing", on);
      }
    },

    _bindPress() {
      const bar = $("#tabbar");
      if (!bar || bar.__pressBound) return;   // 重建副本层时不要重复挂
      bar.__pressBound = true;
      const idxOf = (e) => {
        const t = e.target && e.target.closest ? e.target.closest(".tab") : null;
        if (!t || t.parentElement !== bar) return -1;   // 排除副本层里的克隆
        return Array.from(bar.children).filter((c) => c.classList.contains("tab")).indexOf(t);
      };
      bar.addEventListener("pointerdown", (e) => this.press(idxOf(e), true), true);
      const off = () => { for (let i = 0; i < 8; i++) this.press(i, false); };
      for (const ev of ["pointerup", "pointercancel", "pointerleave"]) {
        bar.addEventListener(ev, off, true);
      }
    },
  };

  function bindTabDrag() {
    const bar = $("#tabbar");
    const ind = $("#tabIndicator");
    if (!bar || !ind) return;
    TabHighlight.build();
    // 首屏落位：等一帧让字体/布局稳定，再按滑块真实矩形画出静止态的覆盖
    TabHighlight.follow(600);
    // 尺寸/字体变化会改 tab 的宽度：副本的绝对定位必须重建，然后重画
    window.addEventListener("resize", () => { TabHighlight.build(); TabHighlight.follow(320); });
    const tabsOf = () => Array.from(bar.querySelectorAll(":scope > .tab"));
    const geom = () => {
      const b = bar.getBoundingClientRect();
      // 列表量布局空间（offsetLeft/offsetWidth）：拖拽期间导航条可能带 scaleX 形变，
      // 视觉矩形量出来的「最近项」会系统性偏向形变方向 —— 与滑块写入值同一坐标系才不漂
      return { bar: { left: b.left, top: b.top, width: bar.clientWidth }, list: tabsOf().map((t) => {
        return { el: t, left: t.offsetLeft, width: t.offsetWidth };
      }) };
    };

    /* ---- 旧实现：motion.js 缺失 / ?motion=legacy（保持改造前行为） ---- */
    if (!MOTION_MODERN) {
      let drag = null;
      let lastIdx = -1;

      bar.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        const g = geom();
        const active = bar.querySelector(".tab.is-on") || g.list[0];
        const cur = g.list.find((x) => x.el === active) || g.list[0];
        const w = Math.max(0, cur.width - 12);
        drag = {
          id: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          base: cur.left + 6,
          w,
          min: 6,
          max: g.bar.width - w - 6,
          moved: false,
          axisLock: null,
          idx: g.list.indexOf(cur),
          g,
          active: cur.el,
          stole: false,
        };
        lastIdx = drag.idx;
        ind.style.transition = "none";
        bar.classList.add("is-dragging");
        try { bar.setPointerCapture(e.pointerId); } catch (_) {}
      });

      bar.addEventListener("pointermove", (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        // 与现代路径同一套语义：主方向锁定，横向=切页，纵向=捏形变
        if (!drag.axisLock && Math.hypot(dx, dy) > 6) {
          drag.axisLock = Math.abs(dy) > Math.abs(dx) * 1.15 ? "y" : "x";
        }
        const wy = drag.axisLock === "x" ? 0.45 : 1;
        const d = tabBarDeform(dy * wy);
        bar.style.transform = `translateY(${d.y.toFixed(2)}px) scale(${d.scaleX.toFixed(4)},${d.scaleY.toFixed(4)})`;
        if (drag.axisLock === "y") { if (e.cancelable) e.preventDefault(); return; }
        if (Math.abs(dx) > 4) {
          drag.moved = true;
          // 拖动起步就让位高亮：旧 tab 摘掉 is-on，蓝随滑块覆盖范围走（松手/取消时还原）
          if (!drag.stole) { drag.stole = true; drag.active.classList.remove("is-on"); }
        }
        const x = Math.min(drag.max, Math.max(drag.min, drag.base + dx));
        drag.x = x;
        ind.style.transform = `translateX(${x}px)`;   // 不加 scale：透镜按同一矩形对齐，缩放会让蓝字错开
        // 覆盖式高亮：滑块压到哪半边，哪半边变蓝
        TabHighlight.paint();
        // 滑块中心越过某一项中心时，轻微反馈一次（只做 haptic，不再整颗变蓝）
        const mid = x + drag.w / 2;
        let near = 0;
        drag.g.list.forEach((t, i) => {
          if (mid >= t.left + t.width / 2) near = i;
        });
        if (near !== lastIdx) {
          lastIdx = near;
          haptic("light");
        }
        if (e.cancelable) e.preventDefault();
      });

      const finish = (e, cancelled) => {
        if (!drag) return;
        const d = drag;
        drag = null;
        TabHighlight.release();
        // 没有 Motion 的降级路径：用 CSS 过渡把形变弹回去（同一条 Q 弹曲线，只是不带甩动速度）
        bar.style.transition = "transform .46s cubic-bezier(.32,1,.4,1)";
        bar.style.transform = "";
        setTimeout(() => { bar.style.transition = ""; }, 480);
        bar.classList.remove("is-dragging");
        if (d.stole) d.active.classList.add("is-on");
        ind.style.transition = "";
        if (d.axisLock === "y" || !d.moved || cancelled) {
          requestAnimationFrame(moveTabIndicator);
          return;
        }
        // 吸附到离滑块中心最近的一项（用写入坐标 drag.x，不用矩形量取：
        // 导航条带着 scaleX 形变时 rect 量到的是缩放后的距离，与布局空间的 g.list 对不上）
        const mid = (drag.x ?? drag.base) + drag.w / 2;
        let best = d.g.list[0], bestDist = Infinity;
        d.g.list.forEach((t) => {
          const dist = Math.abs(t.left + t.width / 2 - mid);
          if (dist < bestDist) { bestDist = dist; best = t; }
        });
        d.g.list.forEach((t) => t.el.classList.toggle("is-on", t === best));
        if (best.el !== d.active) animateTabIcons(d.active, best.el);
        tabJustDragged = true;
        setTimeout(() => { tabJustDragged = false; }, 260);
        go(best.el.dataset.tab);
        haptic("light");
      };

      bar.addEventListener("pointerup", (e) => finish(e, false));
      bar.addEventListener("pointercancel", (e) => finish(e, true));
      bar.addEventListener("lostpointercapture", (e) => finish(e, false));
      return;
    }

    /* ---- 跟手版（契约 §4 Tab 指示器）：M.drag 1:1 + 越界橡皮筋 + 松手按最近项 ----
       注意 M.drag 的 rubber 夹的是「位移增量 dx」，不是最终 x：所以按下时把同一个
       rubber 对象的边界改写成相对增量的值，视觉上等于 x 被夹在 [6, bar宽-滑块宽-6]、
       越界按 0.35 橡皮筋且最多探出 10px（maxOver，契约「橡皮筋 0.35/最大 10px」，
       rc.106 前 resist 没做这个上限，滑块能滑出容器半个身位以上）。 */
    const RUB = { min: 0, max: 0, factor: 0.35, maxOver: 10 };
    let g = null, baseX = 0, baseW = 0, lastIdx = -1, activeEl = null, stole = false, axisLock = null;

    const arm = () => {
      g = geom();
      const active = bar.querySelector(".tab.is-on") || g.list[0];
      const cur = g.list.find((x) => x.el === active) || g.list[0];
      baseW = Math.max(0, cur.width - 12);
      baseX = cur.left + 6;
      // 纵向不设边界[]{min,max}：合法性由 tabBarDeform 的软饱和给，不需要越界夹逼
      RUB.min = 6 - baseX;
      RUB.max = Math.max(RUB.min, g.bar.width - baseW - 6 - baseX);
      lastIdx = g.list.indexOf(cur);
      axisLock = null;
      activeEl = cur.el;
      stole = false;
      bar.classList.add("is-dragging");
      // 上一轮回弹弹簧若还在跑，必须无声打断（kill 不写终值）：
      // 用 stop 会立刻把导航条收尾到 y=0 —— 按下瞬间跳一下；不杀则旧弹簧每帧
      // 覆写拖拽写入的 transform，且它的 onComplete 会在拖拽中途摘 is-dragging + 清内联。
      try { Motion.kill(bar); } catch (_) {}
      // 关掉 CSS 过渡——拖动是 1:1 直接操纵，任何过渡都是滞后。
      // 注意：这里**不能**给滑块加 scale「举起」——透镜按平移矩形对齐，滑块一旦缩放，
      // 视觉矩形比 translateX 更宽，蓝字就会整体错开一格（真机实测：白蓝重影）。
      ind.style.transition = "none";
      Motion.set(ind, { x: baseX, width: baseW });
      TabHighlight.barDeforming = false;   // 起手未形变；onMove 里再随写入值打开
    };

    /* 拖动起步就把旧页的高亮「让位」：滑块离开起点后旧 tab 摘掉 is-on，
       其蓝色改为由 TabHighlight 按「胶囊实际矩形 ∩ 字形」逐帧裁剪，
       不会出现旧页全蓝 + 新页覆盖半蓝同时亮着像两个当前页。 */
    const stealHighlight = () => {
      if (stole || !activeEl) return;
      stole = true;
      activeEl.classList.remove("is-on");
    };

    Motion.drag(bar, {
      axis: "xy",
      threshold: 3,
      // 不抓指针：抓了之后 tap 的 click 可能被重定向到 tabbar，点击切页就失灵（旧实现靠它兜住过）
      capture: false,
      // 横向沿用原来的越界夹逼（滑块不许滑出容器）；纵向交给 tabBarDeform 做软饱和阻尼
      rubber: { x: RUB, y: null },
      filter: (e) => !!(e.target && e.target.closest && e.target.closest(".tab")),
      onStart: arm,
      onMove: ({ dx, dy }) => {
        if (!g) return;
        // 主方向一经判定就不翻转：横向=拖滑块切页，纵向=捏着导航条形变。
        // 不锁的话斜着划一下会在两种语义间来回跳 —— 这是手势最不能忍的抖动。
        if (!axisLock && Math.hypot(dx, dy) > 6) {
          axisLock = Math.abs(dy) > Math.abs(dx) * 1.15 ? "y" : "x";
        }
        // 副轴保留一点耦合（0.45）：斜向拖动时导航条不是「要么动要么不动」，
        // 而是随手指的自然分量轻微起伏
        writeTabBarDeform(bar, dy * (axisLock === "x" ? 0.45 : 1));
        if (axisLock === "y") return;   // 纯竖向：不偷蓝、不动滑块、不换页
        if (Math.abs(dx) > 4) stealHighlight();
        const x = baseX + dx;
        Motion.set(ind, { x, width: baseW });
        // 覆盖式高亮：滑块压到哪半边，哪半边变蓝（逐帧 clip-path，不是整颗提前蓝）
        TabHighlight.paint();
        // 滑块中心越过某一项中心时：轻微反馈一次（只做 haptic，不再整颗变蓝）
        const mid = x + baseW / 2;
        let near = 0;
        g.list.forEach((t, i) => { if (mid >= t.left + t.width / 2) near = i; });
        if (near !== lastIdx) {
          lastIdx = near;
          haptic("light");
        }
      },
      onEnd: ({ dx, dy, vx, vy }) => {
        if (!g) return;
        const lock = axisLock;
        const gg = g;
        g = null;
        axisLock = null;
        TabHighlight.release();
        // Q 弹回位（is-dragging 由弹簧跑完后摘，见 releaseTabBar）；
        // dy 换算成与形变同一坐标系再传入（副轴耦合 0.45 同 onMove）
        releaseTabBar(bar, dy * (lock === "x" ? 0.45 : 1), vy);
        if (lock === "y") {
          // 竖向手势是「捏一捏」探索：不换页、不动滑块，只把导航条弹回去。
          // 滑块也要归位：arm() 起手把它 set 成 scale(1.03)，y 锁分支不落位的话
          // 这 3% 的放大就永远留在滑块上（rc.109 取证实测 pinch 后 scale(1.03) 残留）
          stole = false; activeEl = null;
          haptic("light");
          requestAnimationFrame(moveTabIndicator);
          return;
        }
        // 速度接续：松手瞬间的水平速度（px/ms → px/s）带进落位弹簧，
        // 甩出去的滑块继续往前冲、被弹簧拉回目标位，不是按停
        tabSnapVx = Math.max(-4000, Math.min(4000, (vx || 0) * 1000));
        // 速度投影：手一甩就往前多认一点，避免「甩到头却停在上一个」
        const proj = baseX + dx + Math.max(-60, Math.min(60, (vx || 0) * 120));
        const mid = proj + baseW / 2;
        let best = gg.list[0], bestDist = Infinity;
        gg.list.forEach((t) => {
          const dist = Math.abs(t.left + t.width / 2 - mid);
          if (dist < bestDist) { bestDist = dist; best = t; }
        });
        // go() 可能因「切的就是当前页」提前返回，is-on 的归位不指望它，这里显式落定
        gg.list.forEach((t) => t.el.classList.toggle("is-on", t === best));
        if (best.el !== activeEl) animateTabIcons(activeEl, best.el);
        activeEl = null; stole = false;
        tabJustDragged = true;
        setTimeout(() => { tabJustDragged = false; }, 260);
        // go() 里 rAF(moveTabIndicator) 会用 press 弹簧把滑块落到新位置（可被打断）
        go(best.el.dataset.tab);
        haptic("light");
      },
      onCancel: () => {
        TabHighlight.release();
        if (stole && activeEl) activeEl.classList.add("is-on");
        g = null;
        axisLock = null;
        activeEl = null;
        releaseTabBar(bar, 0, 0);    // 取消：按停回原位，不带甩动速度
        tabSnapVx = 0;
        requestAnimationFrame(moveTabIndicator);
      },
    });
  }

  /**
   * 把一条会话的内容从本地库灌进**它自己那一份**对话流（只在首次加载时做一次）。
   *
   * 返回 true 表示这次真的灌了内容（调用方据此决定要不要整表重建）。
   * 幂等：同一条会话第二次调用直接返回 false —— 内存里那份才是最新的
   * （含思考展开、工具行开合这些不落库的状态）。
   */
  function hydrateThread(s, b) {
    if (!s || !b || b.loaded) return false;
    b.loaded = true;
    const saved = LocalDB.plan(s.id);
    if (saved && saved.text) {
      thread.push(NODES.plan({ pid: "saved" + s.id, title: saved.title || "执行计划", plan: saved.text, status: "approved", note: "这份计划已批准，可在后续对话里继续执行" }));
    }
    const shot = LocalDB.shot(s.id);
    if (Array.isArray(shot) && shot.length) {
      // 优先用快照：思考、工具调用、工具结果、用时、token 都在里面
      shot.forEach((n) => {
        if (!n || !n.kind) return;
        // 快照里不存音频（base64 会撑爆 localStorage），语音节点恢复后没有 dataUrl：
        // 标成 expired，渲染为「重新生成」，而不是一个点了没反应的空气泡
        if (n.kind === "voice" && !n.dataUrl) n.expired = true;
        thread.push(n);
      });
    } else {
      (s.messages || []).forEach((m) => {
        if (m.role !== "user") { thread.push(NODES.text(m.content)); return; }
        // 表情包历史：识别「新旧两种标记」+ atts 里的表情图，还原成纯表情气泡。
        // 旧数据存的是「（我发了一个表情包…」长指令，新数据是「[表情包] 名字」短标记。
        const isStkMsg = /^\[表情包\]/.test(m.content || "") || /^（我发了一个表情包/.test(m.content || "");
        if (isStkMsg && (m.atts || []).length && (m.atts[0].dataUrl || "").startsWith("data:image")) {
          const a = m.atts[0];
          thread.push(NODES.sticker({ name: a.name || "表情", dataUrl: a.dataUrl, mime: a.mime || "image/png", by: "user" }));
          return;
        }
        thread.push(NODES.user({ text: m.content, atts: m.atts || [] }));
      });
    }
    return true;
  }

  /* ---------------- 统一唤醒：WakeRouter ----------------
     内核把「job 完成 / 定时到点」写进 wakes 队列；前端在空闲且正停在对话页时
     认领并消费，忙碌 / 切走 / 输入框有草稿 / 后台时留在队列，等下一次进入会话
     或本轮结束再补。agent pre-step 也认领同一队列，谁先拿到谁负责，不会重复。 */
  function wakeListFor(sessionId) {
    try {
      if (!(Native && Native.wakeList)) return null;
      const arr = JSON.parse(Native.wakeList(sessionId || "") || "[]");
      return Array.isArray(arr) ? arr : null;
    } catch (_) { return null; }
  }

  function wakeReady(w) {
    if (!w) return false;
    if (String(w.policy || "idle-auto") === "defer") return false;
    if (!w.sessionId || w.sessionId !== state.sessionId) return false;
    if (currentMode() !== "local" || state.busy || state.screen !== "chat" ||
        sheetOpen || state.teamView || state.pcSession || SearchMode.on) return false;
    if (document.visibilityState && document.visibilityState !== "visible") return false;
    if (!localReady()) return false;
    const input = $("#input");
    if (!input || input.value.trim()) return false;   // 不覆盖用户草稿
    return true;
  }

  /** 启动一条由唤醒触发的轮次；定时用 nudge（提醒已在日志里），job 走普通输入。 */
  function startWakeTurn(w, display) {
    const text = String(w.text || w.display || w.title || "").trim();
    if (!text) return false;
    if (w.kind === "schedule") {
      const shown = String(display || w.display || text);
      // 界面显示用户当时设的原文；模型拿到 nudge（避免 prompt 看两遍）
      thread.push(NODES.user({ text: shown }));
      followBottomOn = true;
      renderThread();
      pinBottom(800, true);
      try {
        const s = LocalDB.get(state.sessionId);
        if (s) { LocalDB.push(state.sessionId, { role: "user", content: shown }); renderSessions(); }
      } catch (_) {}
      state.busy = true;
      updateSendState();
      try { SpeechOut.stop(); } catch (_) {}
      Live.speakRequested = false;
      Live.askedByVoice = false;
      attachThread(state.sessionId);
      beginLive(state.sessionId, modelLabel());
      toast(`定时任务「${w.title || "提醒"}」已到点`);
      localSend(text, [], { mission: { missionId: w.missionId || "", wake: true, wakeId: w.id || "" } }).catch((e) => {
        failLive(e.message || String(e));
        state.busy = false;
        updateSendState();
      });
      return true;
    }
    // job：把完成通知当普通输入发起一轮（与旧的空闲唤醒一致）
    const input = $("#input");
    if (!input) return false;
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    toast("后台任务完成，Agent 正在继续");
    // 走的是普通发送口，所以用 pendingMission 递一手（下一个 localSend 立即消费）
    state.pendingMission = { missionId: w.missionId || "", wake: true, wakeId: w.id || "" };
    try { handleSend(); } catch (_) { state.pendingMission = null; return false; }
    return true;
  }

  /**
   * 本轮是为哪几条唤醒跑的。失败时要把它们退回队列 —— 「先消费再启动」保证不重复，
   * 但如果不回滚，一次网络失败就把这件事永久吃掉了。
   */
  let lastWakeIds = [];

  function requeueWakes(reason) {
    if (!lastWakeIds.length) return;
    const ids = lastWakeIds.slice();
    lastWakeIds = [];
    let back = 0;
    try {
      if (!(Native && Native.wakeRequeue)) return;
      ids.forEach((id) => {
        try {
          const r = JSON.parse(Native.wakeRequeue(id, String(reason || "本轮失败")) || "{}");
          if (r.ok) back++;
        } catch (_) {}
      });
    } catch (_) {}
    if (back) toast("这一轮没跑成，唤醒已退回队列，下次进会话再试");
  }

  /**
   * 认领并处理唤醒。一次只开一轮：job 通知合并成一轮；定时任务一次一条，
   * 其余留在队列，等这一轮结束 / 下次进入会话再补。
   */
  function wakeMissions(sessionId) {
    if (!state.sessionId) return false;
    if (sessionId && sessionId !== state.sessionId) return false;
    const list = wakeListFor(state.sessionId);
    if (!list || !list.length) return false;
    const ready = list.filter(wakeReady);
    if (!ready.length) return false;
    const first = ready[0];
    const picked = first.kind === "job" ? ready.filter((w) => w.kind === "job") : [first];
    const ids = picked.map((w) => String(w.id || "")).filter(Boolean);
    // 先消费再启动：即使启动失败，也不会被 agent pre-step 二次注入
    try { if (Native.wakeConsume && ids.length) Native.wakeConsume(ids.join(",")); } catch (_) {}
    lastWakeIds = ids.slice();
    if (first.kind === "job") {
      const text = picked.map((w) => String(w.text || "")).filter(Boolean).join("\n\n");
      return startWakeTurn({ ...first, text, display: text });
    }
    return startWakeTurn(first);
  }

  /** 本轮已经显示在流里的正文与思考（按出现顺序拼：从最后一条用户消息往后走）。 */
  function roundShown() {
    let text = "";
    let think = "";
    for (let i = thread.length - 1; i >= 0; i--) {
      const n = thread[i];
      if (n.kind === "user") break;
      if (n.kind === "text") text = String(n.text || "") + text;
      if (n.kind === "pgroup") {
        (n.members || []).forEach((m) => {
          if (m && m.type === "think") think = String(m.text || "") + think;
        });
      }
    }
    // 正在流的那口气泡：Live.text 可能比节点上同步过的还长（绘制按帧走）。
    // 只在本轮确实还在流、且节点还在时才算 —— 进成员视图时我们主动摘了 textNode，
    // 这时 Live.text 是残留，再加一遍会把同一段算两遍（实测 shown 352，真实只有 176）。
    if (Live.running && Live.textNode) {
      const synced = String(Live.textNode.text || "");
      if (Live.text && Live.text.length > synced.length) text += Live.text.slice(synced.length);
    }
    return { text, think };
  }

  /**
   * 内核快照与流里已显示的文字同源同序（都是同一条 delta 流）：能对上就只补尾巴。
   * 对不上（快照被 SNAPSHOT_MAX 截断、或落盘的半截比快照长）时整段补 ——
   * 重复一段比少一段更显眼，但两种都不能让气泡空着。
   */
  function unseenTail(shown, full) {
    const f = String(full || "");
    const s = String(shown || "");
    if (!f) return "";
    if (!s) return f;
    if (f.startsWith(s)) return f.slice(s.length);
    if (s.startsWith(f)) return "";
    return f;
  }

  /**
   * 把「重载前已经落在流里的那些工具行」认领回来，返回它们的调用 id。
   *
   * 三件事缺一不可：
   *  · 已有行的 id —— 回放时这些 tool_start 要跳过，否则屏幕上多出几条一模一样的行；
   *  · 还在跑的行挂回 `Flow._byId` —— 补进来的 tool_end 才找得到归属，不然那一行会一直
   *    显示「运行中」，直到轮末被 settle 悄悄改掉（看着就像工具卡住了）；
   *  · 最后那个还没收口的过程组交给 Flow 当当前组 —— 补的行才有地方落，
   *    否则会另起一个组头，两条「思考/工具」并列摆在那儿。
   */
  function adoptShownTools() {
    const seen = {};
    let open = null;
    for (let i = thread.length - 1; i >= 0; i--) {
      const n = thread[i];
      if (n.kind === "user") break;
      if (n.kind !== "pgroup") continue;
      (n.members || []).forEach((m) => {
        if (!m || m.type !== "tool" || !m.id) return;
        seen[m.id] = true;
        if (m.status === "run") (Flow._byId[m.id] || (Flow._byId[m.id] = [])).push(m);
      });
      if (!open && !n.closed) open = n;         // 从尾往前第一个还开着的组，就是这一轮当前的组
    }
    // **追加，不要整组替换**：这里以前是把结算名单整个换成「这一个组」，于是认领之前建立的
    // 过程组被从名单里抹掉 —— 轮末 settle 收不到它，屏幕上就留一个永远开着的组
    // （重载 + 回来两条路各认领一次时实测到：loose=1）。
    if (open && Flow.groups.indexOf(open) < 0) { Flow.groups.push(open); Flow.group = open; }
    return seen;
  }

  /**
   * 把内核正在跑的那一轮接回界面：换回同一个 Live.id，只补快照里没见过的那段。
   *
   * 两个调用点：页面被系统回收后重载（init）、从成员会话回到主会话（exitTeamView）。
   * 调用前必须已经落回目标会话的视图（openSession 完成），thread 就是那一场的桶。
   * 返回在跑的那条轮次；没有在跑的返回 false（调用方按「已经跑完」处理）。
   */
  /** 内核里这一场**还在跑**的那一轮（没有在跑返回 null）。claimRun 与补账共用这一个判据 */
  function activeRun(sid) {
    const act = (Native && Native.agentActive) ? JSON.parse(Native.agentActive() || "{}") : {};
    const runs = ((Array.isArray(act.runs) && act.runs.length ? act.runs : (act.id ? [act] : [])))
      .filter((r) => r && r.id && r.sessionId);
    return runs.find((r) => r.sessionId === sid) || null;
  }

  function claimRun(sid) {
    const mine = activeRun(sid);
    if (!mine) return false;
    // 已经有人认领过这一轮就别再认一次：`beginLive` 会另起一条流式气泡，
    // 两次认领 = 同一批工具行画两遍 + 前一个过程组永远收不到口（重载路径上真撞到过：
    // init 认领一次、回到会话的补账又认领一次，屏幕上「再数一次」出现两行）。
    if (Live.id) return mine;
    const shown = roundShown();       // 快照里这一场已经显示过多少（流式期间每 8 秒落一次）
    beginLive(sid, modelLabel());     // 造出这一轮的流式气泡（内部会另生成 Live.id）
    state.busy = true;
    Live.id = mine.id;                // 换回内核那份：onAgent 的归属判断认的是它
    Live.running = true;
    NativeAgent.active = true;
    NativeAgent.id = mine.id;
    // 只补快照没见过的那一段：整段灌会把重载前已落进快照的那半截再说一遍
    // （实测：重载前页面 367 字 → 认领后流里 734 字，同一句话出现两次）
    const restThink = unseenTail(shown.think, mine.reasoning);
    const restText = unseenTail(shown.text, mine.text);
    // 已显示的那半截要挂回这一轮的账上：回合结束时 commit 的是 liveBody()
    // = Live.parts + Live.text，不补进来的话落库的回复就少了重载前那一截
    // （实测：页面 1917 字，库里只有 1125 字，下一轮模型也不知道自己说过什么）
    if (shown.text) Live.parts = [shown.text];
    // 先认领，再喂任何事件 —— 顺序反了的话：喂思考会自己另起一个新组，
    // 接着 adoptShownTools 从尾往前找到的就是这个新组，重载前那个还开着的过程组
    // 既不在 Flow.groups 也不会被 settle 收口（实测：轮末屏幕上留一条永远展开、
    // 里面的思考还写着「运行中」的过程组）。
    const shownTools = adoptShownTools();
    if (restThink) NativeAgent.on({ t: "reasoning", text: restThink, sessionId: sid });
    // 工具行：内核按发出顺序记了一份「页面见过什么」（StreamCoalescer.snapshot 的 segments）。
    // 正文/思考仍按「两条通道各补尾巴」走（那套前缀比对已经验过），工具事件按原序补进来 ——
    // 顺序上仍是「想 → 做 → 说」：思考先进组，再补工具行，正文尾巴最后。
    (Array.isArray(mine.segments) ? mine.segments : []).forEach((s) => {
      if (!s || (s.t !== "tool_start" && s.t !== "tool_end")) return;
      if (s.t === "tool_start" && shownTools[s.id]) return;
      NativeAgent.on(Object.assign({ sessionId: sid }, s));
    });
    if (restText) NativeAgent.on({ t: "delta", text: restText, sessionId: sid });
    livePaint(true);
    updateSendState();
    return mine;
  }

  /** 这一轮的过程组/工具行按日志补回来要的段（内核 sessionRoundTrace，段名与在跑快照一致） */
  function roundTrace(sid) {
    if (!(Native && Native.sessionRoundTrace)) return null;
    let t = {};
    try { t = JSON.parse(Native.sessionRoundTrace(sid) || "{}"); } catch (_) { return null; }
    if (!t || !t.ok || !Array.isArray(t.segments) || !t.segments.length) return null;
    return t;
  }

  /** 把日志段按通道拼成全量（正文 / 思考），用来判断能不能安全跳过页面已显示的那截 */
  function channelText(segs, t) {
    return segs.filter((s) => s && s.t === t).map((s) => String(s.text || "")).join("");
  }

  /**
   * 重放完的收尾：过程组原地折成一行、补收尾行、把这一轮落进页内的库。
   *
   * 不整表重绘 —— `Flow.settle` 是就地 patch 组节点，`push` 只往尾部追加，
   * 已经画出来的每一行都不搬家（对话流只做增量刷新那条纪律）。
   */
  function commitReplayedRound(sid, finalText, stats) {
    const ms = Number(stats && stats.ms) || 0;
    Flow.settle(ms ? Math.max(1, Math.round(ms / 1000)) : 0, "done");
    if (!ms) {
      // 降级路径（只补到正文尾巴）不知道这一轮跑了多久：不许在屏幕上写「用时 0 秒」。
      // 撤掉「本轮过程」标记，折叠行退回按步数说的标题 —— 少说一个数字，不撒一个谎。
      const labelled = thread.filter((x) => x && x.kind === "pgroup" && x.turnLabel).pop();
      if (labelled) { labelled.turnLabel = false; patchNode(labelled); }
    }
    push(NODES.footer({
      steps: Number(stats && stats.steps) || 0, ms, text: finalText,
      tokens: Number(stats && stats.tokens) || 0, cancelled: false,
    }), false);
    // 页面的库里这一轮还停在「只有用户那句」：不补这条，下次从库重灌又会少一段
    const msgs = ((LocalDB.get(sid) || {}).messages) || [];
    const tailMsg = msgs[msgs.length - 1];
    if (finalText && (!tailMsg || tailMsg.role !== "assistant" || tailMsg.content !== finalText)) {
      try { LocalDB.push(sid, { role: "assistant", content: finalText }); } catch (_) {}
      try { renderSessions(); } catch (_) {}
    }
    persistThread();
    pinBottom(600);
  }

  /**
   * 按会话日志重放这一轮：思考 → 工具行 → 正文，顺序就是日志顺序。
   *
   * 已经显示过的不重画：正文 / 思考各按「页面已显示的那段前缀」跳字符，已经在流里的
   * 工具行按调用 id 跳（`adoptShownTools` 顺带把「离开那一刻还开着的过程组」认领回 Flow，
   * 否则那个组会永远挂着「正在分析请求」的头）。
   * 前缀对不上就整段不重放 —— 顺序无法可信对齐时，宁可只补一段正文，也不能画出错序的过程组。
   */
  function replayRound(sid, tr) {
    const shown = roundShown();
    const fullText = channelText(tr.segments, "delta");
    const fullThink = channelText(tr.segments, "reasoning");
    if (shown.text && !fullText.startsWith(shown.text)) return false;
    if (shown.think && !fullThink.startsWith(shown.think)) return false;
    // 页面一个字都没显示过也敢整段重放：段来自「最后一个 turn/start 之后」，本来就是这一轮，
    // 而 adoptShownTools 会把已经画过的工具行按 id 跳掉 —— 不会重复，也不会串到上一轮。
    const has = adoptShownTools();
    let leftText = shown.text.length;
    let leftThink = shown.think.length;
    let drew = 0;
    tr.segments.forEach((s) => {
      if (!s) return;
      if (s.t === "reasoning") {
        const skip = Math.min(leftThink, String(s.text || "").length);
        leftThink -= skip;
        const rest = String(s.text || "").slice(skip);
        if (rest) { Flow.think(rest); drew++; }
        return;
      }
      if (s.t === "tool_start") {
        if (has[s.id]) return;
        Flow.toolStart({ id: s.id, name: s.name, args: s.args || "" });
        drew++;
        return;
      }
      if (s.t === "tool_end") {
        // 开始已经画过：只有「离开时还在跑」的那一行需要我们补结算
        // （adoptShownTools 只把 status=run 的行挂回 Flow._byId，跑完过的不动它）
        if (has[s.id] && !(Flow._byId && Flow._byId[s.id])) return;
        Flow.toolEnd(s.id, { ok: s.ok !== false, output: s.output || "", ms: Number(s.ms) || 0 });
        drew++;
        return;
      }
      if (s.t === "delta") {
        const skip = Math.min(leftText, String(s.text || "").length);
        leftText -= skip;
        const rest = String(s.text || "").slice(skip);
        if (!rest) return;
        Flow.closeGroup();          // 正文是过程组的边界：先把上面那段收口
        push(NODES.text(rest), false);
        drew++;
      }
    });
    if (!drew) return false;
    commitReplayedRound(sid, String(tr.text || fullText || ""), tr);
    return true;
  }

  /**
   * 把「这一轮页面没渲染过的东西」从内核日志补回当前流。
   *
   * 为什么需要：看队友会话 / 切去看别的会话时，页面这一侧不渲染主会话，事件被丢弃、
   * 轮末的 onDone 收不到 —— 界面停在最后一次快照，既差几秒也没有收尾行，而且**这一轮的
   * 产出从来没落进页内的库**（persistThread 的身份自检必须挡住「把成员的内容写进 Lead」，
   * 顺带也把 Lead 自己的落盘一起挡了）。不补就是用户报的「Lead 的记录少了一大段/没了」。
   *
   * 首选按日志重放整轮（过程组与工具行都在），拿不到重放段或前缀对不上时才回落到
   * 只补正文尾巴（`sessionLastReply`）—— 仍然只补**严格的前缀尾巴**：`unseenTail`
   * 在两段无关文本之间会整段返回，那等于把上一轮的旧回复当新内容灌进来。
   */
  function appendMissedTail(sid) {
    if (!sid || state.busy || Live.id) return false;   // 页面正在跟这一轮：尾巴由流式自己写
    // 内核还在跑这一轮：按实时通道认领（有 Live 气泡、轮末照常结算），
    // 不能拿日志重放出一行「已完成」—— 那会把还在长的回复当已收尾。
    if (activeRun(sid)) return !!claimRun(sid);
    const tr = roundTrace(sid);
    if (tr && replayRound(sid, tr)) return true;
    if (!(Native && Native.sessionLastReply)) return false;
    let r = {};
    try { r = JSON.parse(Native.sessionLastReply(sid) || "{}"); } catch (_) {}
    if (!r.ok || !r.text) return false;
    const shown = roundShown().text;
    if (!shown) return false;                       // 一个字都没显示过 → 交给整表重建，不整段灌
    if (!String(r.text).startsWith(shown)) return false;
    const rest = String(r.text).slice(shown.length);
    if (!rest) return false;
    adoptShownTools();                              // 把离开时还开着的过程组认领回来，别让它永远开着
    push(NODES.text(rest), false);
    commitReplayedRound(sid, r.text, null);
    return true;
  }

  /**
   * 从别的视图回来：先把还在跑的那一轮接回来；离开期间已经跑完了，就把最后一段补上。
   */
  function resumeBgRun(sid) {
    const bg = state.bgRun;
    // 认领只发生在「回到它属于的那一场」。以前这里无条件先把 bgRun 清空，
    // 于是路过别的会话（哪怕只点开一眼）就把后台那一轮的账丢了 —— 而这份账同时是
    // 「Lead 那份桶不许被 LRU 挤掉」的凭据（见 evictBuckets）：账一丢，桶就能被挤，
    // 挤掉之后能恢复的只剩离开那一刻的快照（实测回到 Lead 只剩 19% 的正文）。
    if (!bg || bg.sid !== sid) return;
    state.bgRun = null;
    if (claimRun(sid)) { toast("已回到对话，这一轮还在继续", 2400); return; }
    appendMissedTail(sid);
  }

  /**
   * 重开一场「说到一半就没了」的会话时，把断掉这件事说出来（就地补一行，不动已有节点）。
   *
   * 判据是快照里登记的 `open`（落盘时这一轮还活着才有），**不能**用「库里最后一条还是
   * 用户那句」：主动停止和切走会话都会就地收尾，而这两条路不 commit assistant 消息 ——
   * 那个判据会把用户自己停掉的回合也标成「没跑完」（实测：切走再回来就多一行误报）。
   */
  function markInterruptedRound(s) {
    if (!s || !(Number(s.open) > 0)) return false;
    // 从成员视图回来、这一轮还在后台跑：那是「我们自己的轮次」，不是进程被杀
    if (state.bgRun && state.bgRun.sid === s.id) return false;
    const tail = thread[thread.length - 1];
    // 尾巴本身已经说明了结局（还没开始 / 已补过 / 失败卡）就不重复
    if (!tail || ["user", "interrupted", "fail", "retry", "maxtokens", "notice"].includes(tail.kind)) return false;
    thread.push(NODES.interrupted());
    return true;
  }

  function openSession(id) {
    // openSession 要么整场换过去，要么什么都不动。以前这里先把成员视图拆掉（清 teamView、
    // 停轮询、收条），再往下才去认「这一场在不在」—— 认不到就直接 return，留下的状态是
    // 「界面还停在队友那一份，但成员条已经没了」，用户看到的正是「Lead 的记录不见了，
    // 只剩队友的话」，杀后台重开才恢复。所以先认目标，认不到就原样返回。
    const local = currentMode() === "local";
    const found = local ? LocalDB.get(id) : (state.sessions.find((x) => x.id === id) || null);
    if (!found) return;
    if (state.pcSession) Link.leave();
    // 离开成员会话视图：nav 条与轮询都跟着会话走，不能跨会话残留
    if (state.teamView) {
      state.teamView = null;
      stopTeamViewPoll();
      syncTeamViewBar();
    }
    // 上报「用户正在看哪个会话」：后台跑的其它会话要权限时才不会被静默吞掉
    try { if (Native && Native.setActiveSession) Native.setActiveSession(String(id || "")); } catch (_) {}
    // 换会话先停声：上一条语音不该跨会话继续念
    if (id !== state.sessionId) {
      try { VoicePlay.stopAll(); } catch (_) {}
      // 语音节奏也跟着归零：新会话第一句该能正常出声
      Live.voiceStreak = 0;
    }
    // 切走会话时，未决的计划评审必须结算，否则工具循环会一直挂着
    if (PlanReview.pending) {
      const r = PlanReview.pending;
      PlanReview.pending = null;
      PlanReview.node = null;
      try { r({ ok: false, error: "用户切换了会话，计划评审已取消。" }); } catch (_) {}
    }
    // 离开当前会话前先落快照，并把它从「运行中」摘掉（按钮状态不能跨会话残留）
    if (id !== state.sessionId) {
      persistThread();
      if (state.busy) stopLive(true);
      // 队列属于发起它的那个会话，切走就作废（避免把 A 的话发到 B 里）
      if (queueOf().length) {
        queueOf().length = 0;
        renderQueue();
        toast("已切换会话，原来的排队消息已清空", 2200);
      }
    }
    if (local) {
      const s = found;
      // 同一个会话还在跑：直接回到界面，绝不能重建 thread。
      // 重建会把 Live/Flow 持有的节点从 DOM 上摘掉，后续 delta 全写进游离节点，
      // 用户看到的就是「只有终止按钮、对话内容一片空白」。
      const sameRunning = id === state.sessionId && (state.busy || !!Live.id);
      if (sameRunning) {
        // 但「不重建」不等于「不换桶 / 不重绘」：
        //  · 页面被系统回收后重载，内存里的桶是空的 → 需要灌历史；
        //  · 从成员会话（teamView）或别的桶切回来时，**DOM 里还是上一个视图的内容**，
        //    不重绘就会出现「历史变成上一个视图的内容」（用户实测：退出成员对话后
        //    回到原对话，历史显示的是刚发给成员的任务）。
        const prevKey = thread.__sid;
        const sb = attachThread(s.id);
        const switched = prevKey !== s.id;
        const hydrated = hydrateThread(s, sb);
        $("#chatTitle").textContent = s.title || "新会话";
        $("#chatSub").textContent = "本地 · " + modelLabel();
        if (hydrated || switched) renderThread();
        go("chat");
        // 立刻全量重绘一次流式正文：离开期间 paint 可能因页面被降频而滞后，
        // 等下一个 delta 才追上 —— 用户重进的头一秒看到的是空白/旧内容。
        try { livePaint(true); } catch (_) {}
        // 后台那一轮在**这里**接回来（不是只在面板「退出」按钮里）：从成员视图切去
        // 会话列表、再点回这场会话时，走的就是这条路 —— 以前没人认领，界面停在
        // 离开那一刻的半截，busy 也不再是 true（用户实测：Lead 的聊天记录与运行状态
        // 一起没了，只有杀后台重启才恢复）。
        resumeBgRun(s.id);
        pinBottom(1200, true);
        return;
      }
      state.sessionId = s.id;
      // 团队按会话隔离：切会话先清旧快照，再拉这个会话的 roster/任务板
      state.team = null;
      syncTeamBadge();
      setTimeout(pullTeam, 120);
      $("#chatTitle").textContent = s.title || "新会话";
      $("#chatSub").textContent = "本地 · " + modelLabel();
      // 切到这条会话自己那一份。**已经加载过就原样复用** —— 里面的节点、展开状态、
      // 甚至正在跑的 Live 节点都还在，不再「清空 + 从库重建」（重建正是丢节点、
      // 以及把上一个会话的内容灌进来的入口）。
      hydrateThread(s, attachThread(s.id));
      markInterruptedRound(s);
      followBottomOn = true; // 跟随要在重建前置位，重建贴底才走同帧路径（pinBottom 再兜底）
      renderThread();
      syncModeBar();
      go("chat");
      // 切会话必须强制回底，pinBottom 逐帧校验，扛住页面切换动画/图片晚加载
      pinBottom(1200, true);
      // 同上：这一场如果还挂着「在后台跑的那一轮」，回到界面时认领回来
      resumeBgRun(s.id);
      // 没认领到（离开期间已经跑完 / 那笔后台账在半路被别的路径清掉）也要对一次账：
      // 以内核日志为准把缺的那段补回来 —— 桌面端就是「重开走日志重放」，
      // 页面自己的快照只能是缓存，不能是唯一来源。
      appendMissedTail(s.id);
      // 上次进程被杀前没认领完的完成通知：进入空闲会话时补一次唤醒
      setTimeout(() => { try { wakeMissions(); } catch (_) {} }, 600);
      return;
    }
    const sess = found;                       // 已在函数开头认过一遍（认不到早就返回了）
    state.sessionId = sess.id;
    $("#chatTitle").textContent = sess.title;
    $("#chatSub").textContent = sess.running ? "宿主机 · 运行中" : "宿主机 · " + modelLabel();
    // 宿主机会话也按身份分一份，和本机会话、电脑中继会话互不干扰
    const hostKey = "host:" + sess.id;
    attachThread(hostKey);
    renderThread();
    go("chat");
    // 真实历史从宿主机拉取（端点随协议版本可能变化，错误会如实显示）
    Host.call("session/history", { sessionId: sess.id })
      .then((result) => {
        // 拉回来时用户可能已经切走了：写进当前桶就是把 A 的历史灌进 B。
        // 身份不符直接丢弃（那头还在跑，用户再点回来会重新拉）。
        if (thread.__sid !== hostKey) return;
        const events = result?.events || result?.messages || [];
        if (!events.length) return;
        events.forEach((ev) => {
          const text = ev.text || ev.content || "";
          if (!text) return;
          thread.push(ev.role === "user" || ev.role === "human" ? NODES.user(text) : NODES.text(text));
        });
        renderThread();
        pinBottom(1200, true);
      })
      .catch((e) => {
        const note = document.createElement("div");
        note.className = "empty-state";
        note.style.padding = "30px 16px";
        note.innerHTML = `<b>历史加载失败</b><span>${esc(e.message)}</span>`;
        $("#messages").appendChild(note);
      });
    syncModeBar();
    pinBottom(1200, true);
  }

  /* ---------------- sheet ---------------- */
  let sheetOpen = false;
  /* 动效 v2：开合代次 —— 迟到的 onComplete / 保险超时不能把下一轮打开的面板收掉 */
  let sheetGen = 0;
  let sheetClosing = false;

  /** 底部渐隐：内容可滚动且未到底时才裁切，避免最后一行被永久淡掉 */
  function syncSheetFade() {
    const body = $("#sheetBody");
    if (!body) return;
    const scrollable = body.scrollHeight - body.clientHeight > 4;
    const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 4;
    body.classList.toggle("is-scrollable", scrollable);
    body.classList.toggle("is-at-bottom", !scrollable || atBottom);
  }

  /* 浮窗里的说明性文案只保留一层意思：去掉括号补充、只留第一句、超长在自然断点收。
     只处理 .sheet-sub（说明行），不动标题、数值、状态、按钮 —— 这些是功能不是说明。 */
