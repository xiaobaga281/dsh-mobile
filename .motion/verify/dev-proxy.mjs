#!/usr/bin/env node
/**
 * 开发用 TCP 中继（仅本机联调，不进 APK）
 *
 * 背景：模拟器 SLIRP 只把 10.0.2.2 映射到宿主 loopback，直连外网与 DNS 都不通；
 * 宿主自己出网走 HTTP 代理（http://127.0.0.1:61680）。这个脚本把两者接上。
 *
 * 三种用法（同一个端口）：
 *   1) 源站模式：收到 origin-form 请求（`POST /v1/chat/completions`）→ 补 Host/TLS，
 *      转发到 --origin（app 直接连 http://10.0.2.2:PORT，明文进、TLS 出）
 *   2) 代理模式：`CONNECT host:port` → 经上游代理建隧道（guest 里 curl/apk 用）
 *   3) 绝对 URI：`GET http://host/x` → 按 CONNECT 方式转发（http_proxy 标准行为）
 *
 * **必须做裸 TCP 转发**：用 Node 的 http 模块重写响应会剥掉 transfer-encoding
 * 却保留 chunked 正文，SSE 解析立刻坏掉。
 *
 * 用法：
 *   node .motion/verify/dev-proxy.mjs --port 8790 \
 *     --origin apihub.agnes-ai.com --upstream 127.0.0.1:61680
 */
import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";
import { once } from "node:events";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const PORT = +arg("port", 8790);
const [UP_HOST, UP_PORT] = arg("upstream", "127.0.0.1:61680").split(":");
const ORIGIN = arg("origin", "apihub.agnes-ai.com");
const ORIGIN_PORT = +arg("origin-port", 443);
const log = (...a) => console.error("[dev-proxy]", ...a);

/** 强制短连接：中继只改写每条连接的首个请求，复用连接会带着错误 Host 打回源站 */
function forceClose(head) {
  const has = /^connection:.*$/im.test(head);
  const h = has ? head.replace(/^connection:.*$/im, "Connection: close") : head + "\r\nConnection: close";
  return h.replace(/^proxy-connection:.*\r?\n/im, "");
}


/** 经上游代理 CONNECT 到 host:port，返回裸 socket */
function tunnel(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(+UP_PORT, UP_HOST, () => {
      s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx < 0) return;
      const head = buf.subarray(0, idx).toString();
      if (!/^HTTP\/1\.[01] 200/.test(head)) {
        s.destroy();
        reject(new Error(`CONNECT ${host}:${port} 失败: ${head.split("\r\n")[0]}`));
        return;
      }
      s.removeListener("data", onData);
      const rest = buf.subarray(idx + 4);
      if (rest.length) s.unshift(rest);
      resolve(s);
    };
    s.on("data", onData);
    s.on("error", reject);
  });
}

const server = net.createServer((client) => {
  client.setNoDelay(true);
  let buf = Buffer.alloc(0);
  let started = false;

  /** 解析请求头；返回 true 表示已接管（异步部分自己跑），false 表示还没收全 */
  const onHead = () => {
    const idx = buf.indexOf("\r\n\r\n");
    if (idx < 0) return false;
    started = true;
    // 先暂停：从摘掉 data 监听到 pipe 接上之间有 await（建隧道 + TLS 握手），
    // 不暂停会丢包（大请求体尤其明显）
    client.pause();
    client.removeListener("data", onData);
    const headText = buf.subarray(0, idx).toString();
    const rest = buf.subarray(idx + 4);
    buf = Buffer.alloc(0);
    const [firstLine] = headText.split("\r\n");
    const m = firstLine.match(/^([A-Z]+)\s+(\S+)\s+HTTP\/1\.[01]$/);

    (async () => {
      try {
        let upstream;
        let outHead = headText;
        if (!m) throw new Error("非法请求行: " + firstLine);

        if (m[1] === "CONNECT") {
          const [h, p] = m[2].split(":");
          upstream = await tunnel(h, +p || 443);
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        } else if (/^https?:\/\//.test(m[2])) {
          // 绝对 URI（http_proxy 行为）：拆出 host 建隧道，改回 origin-form
          const u = new URL(m[2]);
          upstream = await tunnel(u.hostname, +(u.port || (u.protocol === "https:" ? 443 : 80)));
          outHead = forceClose(headText
            .replace(firstLine, `${m[1]} ${u.pathname}${u.search} HTTP/1.1`)
            .replace(/^host:.*$/im, `Host: ${u.host}`));
          upstream.write(Buffer.from(outHead + "\r\n\r\n"));
        } else {
          // 源站模式：明文进、TLS 出
          const rawSock = await tunnel(ORIGIN, ORIGIN_PORT);
          const secure = tls.connect({ socket: rawSock, servername: ORIGIN });
          await once(secure, "secureConnect");
          upstream = secure;
          outHead = forceClose(headText.replace(/^host:.*$/im, `Host: ${ORIGIN}`));
          upstream.write(Buffer.from(outHead + "\r\n\r\n"));
        }

        if (rest.length) upstream.write(rest);
        // 调试：按 content-length 精确抓一份请求（含头），供宿主复现
        if (process.env.DEV_PROXY_DUMP && m[1] === "POST") {
          try {
            const cl = +(headText.match(/^content-length:\s*(\d+)/im) || [])[1];
            const chunks = [rest];
            let got = rest.length;
            const tee = (d) => {
              if (got >= cl) return;
              chunks.push(d);
              got += d.length;
              if (got >= cl) {
                const head = headText.replace(/^host:.*$/im, `Host: ${ORIGIN}`) + "\r\n\r\n";
                fs.writeFileSync("D:/1/dsh-mobile/.motion/verify/last-req.txt", head);
                fs.writeFileSync("D:/1/dsh-mobile/.motion/verify/last-req.bin", Buffer.concat(chunks).subarray(0, cl));
                log("dumped request", cl, "bytes");
              }
            };
            client.on("data", tee);
          } catch (_) {}
        }

        upstream.pipe(client);
        client.pipe(upstream);
        client.resume(); // 接上 pipe 再放行，保证一个字节都不丢

        const bye = (why) => () => {
          log("close", firstLine, why);
          try { upstream.destroy(); } catch (_) {}
          try { client.destroy(); } catch (_) {}
        };
        upstream.on("error", bye("upstream-error"));
        client.on("error", bye("client-error"));
        upstream.on("close", bye("upstream-close"));
        client.on("close", bye("client-close"));
        log("proxied", firstLine, "->", m[1] === "CONNECT" ? "CONNECT" : ORIGIN);
      } catch (e) {
        log("fail:", firstLine, e.message);
        try { client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"); } catch (_) {}
      }
    })();
    return true;
  };

  function onData(d) {
    if (started) return;
    buf = Buffer.concat([buf, d]);
    if (onHead()) return;
    // 只对「请求头都收不齐」的异常连接设上限；body 大小与这里无关
    if (buf.length > 128 * 1024) {
      log("drop: header too large", buf.length);
      client.destroy();
    }
  }

  client.on("data", onData);
  client.on("error", () => {});
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`dev-proxy: listen 127.0.0.1:${PORT} · origin=${ORIGIN}:${ORIGIN_PORT} · upstream=${UP_HOST}:${UP_PORT}`);
});
