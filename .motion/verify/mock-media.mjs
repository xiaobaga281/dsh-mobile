// 生成模型 mock:视频(OpenAI /videos 兼容) + 图像(/images/generations + /images/edits)。
// 用途:在无真实生成 API 的模拟器上端到端实测 video_generate / image_generate 的新参数。
// 记录收到的请求体到 /tmp/mock-media.log 供断言(multipart 也能看到边界与字段名)。
import http from "node:http";
import fs from "node:fs";

const PORT = 8792;
const LOG = [];
// 最小合法 mp4(ftyp+mdat 头,能被下载与识别为 mp4 即可,不要求可播放)
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 24]), Buffer.from("ftypmp42"), Buffer.alloc(8),
  Buffer.from([0, 0, 0, 8]), Buffer.from("free"),
  Buffer.from([0, 0, 1, 0]), Buffer.from("mdat"), Buffer.alloc(4096),
]);
// 1x1 png
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function logReq(kind, req, body) {
  LOG.push({ kind, method: req.method, url: req.url, ct: req.headers["content-type"] || "", at: Date.now() });
  fs.writeFileSync("D:/1/dsh-mobile/.motion/verify/mock-media-last.json", JSON.stringify(LOG.slice(-20), null, 1));
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    logReq("req", req, body);
    const url = req.url || "";

    // ---- 视频:POST /videos(创建) → GET /videos/:id(轮询) → GET /file.mp4 ----
    if (req.method === "POST" && url.endsWith("/videos")) {
      // multipart 里取不到字段名细节也无所谓:记录 ct 即可断言走的是 multipart
      const id = "job-" + Date.now();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, status: "queued" }));
      return;
    }
    if (req.method === "GET" && url.includes("/videos/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "job", status: "completed", url: `http://10.0.2.2:${PORT}/file.mp4` }));
      return;
    }
    if (req.method === "GET" && url.endsWith("/file.mp4")) {
      res.writeHead(200, { "content-type": "video/mp4", "content-length": MP4.length });
      res.end(MP4);
      return;
    }

    // ---- 图像:POST /images/generations | /images/edits(b64_json 返回) ----
    if (req.method === "POST" && (url.endsWith("/images/generations") || url.endsWith("/images/edits"))) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }));
      return;
    }

    res.writeHead(404);
    res.end("not found: " + url);
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`[mock-media] ${PORT}`));
console.error("[mock-media] listening on " + PORT);
