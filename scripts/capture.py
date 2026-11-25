import base64
import json
import os
import sys
import time
import urllib.request

import websocket

OUT = sys.argv[1] if len(sys.argv) > 1 else "D:/1/dsh-mobile/preview/shots"
os.makedirs(OUT, exist_ok=True)


def targets():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open("http://127.0.0.1:9222/json/list", timeout=10) as r:
        return json.loads(r.read())


page = next(t for t in targets() if t["type"] == "page")
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=30, suppress_origin=True)
_id = 0
logs = []


def send(method, params=None):
    global _id
    _id += 1
    ws.send(json.dumps({"id": _id, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == _id:
            return msg


def evaluate(expr):
    res = send("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
    return res.get("result", {}).get("result", {}).get("value")


def shot(name):
    time.sleep(0.7)
    res = send("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
    data = base64.b64decode(res["result"]["data"])
    path = os.path.join(OUT, name)
    with open(path, "wb") as f:
        f.write(data)
    print("saved", path, len(data))


send("Runtime.enable")
send("Log.enable")
send("Emulation.setDeviceMetricsOverride", {
    "width": 402, "height": 874, "deviceScaleFactor": 2, "mobile": True,
})
send("Emulation.setTouchEmulationEnabled", {"enabled": True})
send("Page.navigate", {"url": "file:///D:/1/dsh-mobile/preview/index.html"})
time.sleep(2.0)

print("sessions:", evaluate("document.querySelectorAll('#sessionsList .session-item').length"))
print("errors:", evaluate("window.__errs || 'none'"))
shot("01-sessions.png")

evaluate("document.querySelector('#pinnedList [data-open]').click()")
time.sleep(1.4)
evaluate("var s=document.querySelector('#chatScroll'); s.scrollTop=0;")
shot("02-chat-top.png")
evaluate("var s=document.querySelector('#chatScroll'); s.scrollTop=s.scrollHeight;")
shot("02-chat.png")

evaluate("document.querySelector('[data-sheet=\"effort\"]').click()")
time.sleep(0.9)
shot("03-effort.png")

evaluate("document.querySelector('#sheetBackdrop').click()")
time.sleep(0.5)
evaluate("document.querySelector('[data-approve=\"once\"]').click()")
time.sleep(1.6)
shot("04-approved.png")

evaluate("document.querySelector('[data-sheet=\"model\"]').click()")
time.sleep(0.8)
shot("05-model.png")

evaluate("document.querySelector('#sheetBackdrop').click();document.documentElement.dataset.theme='dark'")
time.sleep(0.6)
shot("06-dark.png")

evaluate("document.documentElement.dataset.theme='light';window.DSHHandleBack()")
time.sleep(0.5)
shot("07-back.png")

evaluate("document.querySelector('.tab[data-tab=\"jobs\"]').click()")
time.sleep(0.8)
shot("08-jobs.png")

evaluate("document.querySelector('.tab[data-tab=\"settings\"]').click()")
time.sleep(0.8)
shot("09-settings.png")

print("done")
ws.close()
