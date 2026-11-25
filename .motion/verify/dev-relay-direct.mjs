// 直连版开发中继:监听 8791,把 /v1/* 透传到 https://apihub.agnes-ai.com/v1/*。
// 与 dev-proxy.mjs 的区别:宿主现在不需要上游代理,直接出网;裸流转发,保 SSE。
import http from "node:http";
import https from "node:https";

const ORIGIN = "apihub.agnes-ai.com";
const PORT = 8791;

http.createServer((req, res) => {
  const upstream = https.request(
    { host: ORIGIN, port: 443, path: req.url, method: req.method, headers: { ...req.headers, host: ORIGIN } },
    (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    },
  );
  upstream.on("error", (e) => {
    console.error("[relay]", req.method, req.url, "ERR", e.message);
    try { res.writeHead(502); res.end("relay error: " + e.message); } catch (_) {}
  });
  req.pipe(upstream);
  console.error("[relay]", req.method, req.url);
}).listen(PORT, "127.0.0.1", () => console.error("[relay] listening on " + PORT));
