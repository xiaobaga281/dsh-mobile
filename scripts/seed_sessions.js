/* 造一批会话，覆盖「置顶 / 最近 3 条 / 多工作区堆叠」三种形态。
   只在测试机上跑：写完 localStorage 直接 reload，让首屏按新数据渲染。 */
(function () {
  const now = Date.now();
  const H = 3600 * 1000;
  const seeds = [
    { id: "t-pin", title: "重构目标驱动的续跑逻辑", ws: "harness", pin: true, at: now - 5 * 60 * 1000 },
    { id: "t-ui", title: "安卓 WebView 滚动性能排查", ws: "ui", at: now - 1 * H },
    { id: "t-readme", title: "把 README 改成可验证的安装清单", ws: "harness", at: now - 2 * H },
    { id: "t-travel", title: "旅行指南接口联调", ws: "home", at: now - 24 * H },
    { id: "t-report", title: "周报汇总", ws: "ui", at: now - 48 * H },
    { id: "t-doc", title: "长文档摘要实验", ws: "harness", at: now - 72 * H },
  ];
  const mk = (s) => ({
    id: s.id, title: s.title, createdAt: s.at, updatedAt: s.at, ws: s.ws,
    pin: !!s.pin, tokens: 1200,
    messages: [
      { role: "user", content: s.title },
      { role: "assistant", content: `${s.title}：这一步已经做完，下一步继续。` },
    ],
  });
  const old = (() => { try { return JSON.parse(localStorage.getItem("dsh.local.sessions") || "[]"); } catch (_) { return []; } })();
  const keep = old.filter((x) => !/^t-/.test(x.id)).map((x) => ({ ...x, ws: x.ws || "harness" }));
  localStorage.setItem("dsh.local.sessions", JSON.stringify([...seeds.map(mk), ...keep]));
  localStorage.removeItem("dsh.wsOpen");
  location.reload();
  return "seeded";
})();
