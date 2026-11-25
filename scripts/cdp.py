"""在模拟器 WebView 里执行 JS / 截图（走 adb forward 出来的 devtools）。

用法:
  python scripts/cdp.py eval "document.title"
  python scripts/cdp.py shot  out.png
  python scripts/cdp.py eval "1+1" --port 9223
"""
import base64
import json
import sys
import time
import urllib.request

import websocket


def page_ws(port, url_sub=None):
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    # adb forward 在 WebView 的 devtools socket 就绪前会接受连接但不回包，
    # 所以短超时 + 多次重试（应用刚启动时常遇到）。
    last = None
    for _ in range(15):
        try:
            with op.open(f"http://127.0.0.1:{port}/json/list", timeout=6) as r:
                targets = json.loads(r.read())
            break
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.2)
    else:
        raise last
    pages = [t for t in targets if t["type"] == "page"]
    if url_sub:
        pages = [t for t in pages if url_sub in t.get("url", "")]
    # 优先选非 about:blank 的主界面 target
    pages.sort(key=lambda t: t.get("url", "") == "about:blank")
    return pages[0]["webSocketDebuggerUrl"]


class Cdp:
    def __init__(self, port=9223, url_sub=None):
        self.port = port
        self.url_sub = url_sub
        self.ws = websocket.create_connection(
            page_ws(port, url_sub), timeout=45, suppress_origin=True
        )
        self._id = 0

    def reconnect(self):
        try:
            self.ws.close()
        except Exception:  # noqa: BLE001
            pass
        self.ws = websocket.create_connection(
            page_ws(self.port, self.url_sub), timeout=45, suppress_origin=True
        )

    def send(self, method, params=None):
        # 页面 reload / 渲染进程重启会让旧 ws 失效：重连再试，脚本不用各自处理。
        # 装完新包或刚开机后的第一跳可能真的慢（解析整包 + 渲染几百行列表），
        # 两跳就放弃会把「设备慢」误报成「页面坏了」，所以给三次机会。
        for attempt in range(3):
            self._id += 1
            try:
                self.ws.send(json.dumps({"id": self._id, "method": method, "params": params or {}}))
                while True:
                    msg = json.loads(self.ws.recv())
                    if msg.get("id") == self._id:
                        return msg
            except Exception:  # noqa: BLE001
                if attempt == 2:
                    raise
                time.sleep(2.0)
                self.reconnect()

    def eval(self, expr):
        res = self.send(
            "Runtime.evaluate",
            {"expression": expr, "returnByValue": True, "awaitPromise": True},
        )
        r = res.get("result", {})
        if "exceptionDetails" in r:
            return {"error": r["exceptionDetails"].get("text"), "raw": r["exceptionDetails"]}
        return r.get("result", {}).get("value")

    def shot(self, path):
        res = self.send("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
        with open(path, "wb") as f:
            f.write(base64.b64decode(res["result"]["data"]))
        return path


if __name__ == "__main__":
    port = 9223
    url_sub = None
    args = sys.argv[1:]
    if "--port" in args:
        i = args.index("--port")
        port = int(args[i + 1])
        del args[i : i + 2]
    if "--url" in args:
        i = args.index("--url")
        url_sub = args[i + 1]
        del args[i : i + 2]
    c = Cdp(port, url_sub)
    cmd = args[0]
    if cmd == "eval":
        expr = " ".join(args[1:])
        if expr.startswith("@"):
            expr = open(expr[1:], encoding="utf-8").read()
        print(json.dumps(c.eval(expr), ensure_ascii=False, indent=2))
    elif cmd == "shot":
        time.sleep(0.6)
        print(c.shot(args[1]))
