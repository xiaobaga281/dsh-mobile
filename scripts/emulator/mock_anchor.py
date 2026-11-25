#!/usr/bin/env python3
"""交付物卡片回归用的 mock。

两种回合：
  · 普通提问 → 回一大段正文（用来把对话撑到好几屏，让「本轮尾行」落到视口上方）
  · 提问里带「交付」→ 正文 + write + present + 收尾正文
present 那一步会让手机端往对话流**中间**插一张交付卡。
"""
import json
import socket
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
PATH = "notes/anchor-check.md"
BULK = "\n".join(f"第 {i} 段：这一段的文字用来把对话撑高，好让交付卡插在视口上方。" for i in range(14))
# 思考行的一行摘要要长到一行装不下，才能验「跟着输出走」这条
THINK = ("先确认工作区里有没有同名文件，再决定是覆盖还是新建，顺手把目录结构也看一遍。"
         + "\n\n"
         + "接着把三行内容按 Markdown 列表写进去，最后用 present 把它作为本轮产出交付给用户，"
           "并检查路径是否落在 notes 目录下；中途如果发现目录不存在就先建目录，再写文件。") * 3

# 「宽思考」分片：拼起来是一段带代码块/长链接/行内代码/表格/超长无空格串的思考正文
LONG_TOK = "pneumonoultramicroscopicsilicovolcanoconiosis" * 3
WIDE = [
    "先普通说一句：这一段中文本来就该自动折行，用来当负对照。\n\n",
    "```bash\n",
    "cd /d/1/dsh-mobile/app/src/main/assets/web && node scripts/sync-web.mjs "
    "&& grep -rn \"pg-think-text\" styles.css | head -n 40\n",
    "```\n\n",
    "参考 https://example.com/very/long/path/that/should/wrap/inside-the-thinking-body"
    "/and-not-be-clipped-by-the-phone-screen?q=1 这条链接。\n\n",
    "行内代码 `D:\\1\\dsh-mobile\\app\\src\\main\\assets\\web\\app.js` 前后都有中文，别把它顶出去。\n\n",
    "| 名称 | 说明 |\n",
    "| --- | --- |\n",
    "| " + LONG_TOK + " | 这一格塞一个超长无空格串 |\n\n",
    "再来一段英文 WithoutAnyBreakPointsThisSentenceWillRunOffTheRightEdgeOfANarrowPhoneScreen"
    "UnlessOverflowWrapIsAppliedProperly " + LONG_TOK + " 收尾。\n",
]

# 「断行思考」分片：每片都是完整一段、且以空行收尾 —— 真模型就是这样吐 reasoning 的。
BROKEN_THINK = [
    "先看目录里有没有同名文件。\n\n",
    "已经有了，说明上一轮写过一次，不能直接盖。\n\n",
    "- 备份放到 notes/.anchor-check.bak.md\n",
    "- 正文仍然落在 notes/anchor-check.md\n\n",
    "所以顺序是：备份 → 写正文 → present 交付。\n\n",
    "还有一点：路径必须在工作区里，否则用户找不到文件。\n\n",
]


def sse(obj):
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode()


def last_user(msgs):
    for m in reversed(msgs):
        if m.get("role") == "user":
            c = m.get("content")
            if isinstance(c, list):
                return " ".join(str(p.get("text", "")) for p in c if isinstance(p, dict))
            return str(c or "")
    return ""


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_GET(self):
        b = json.dumps({"object": "list", "data": [{"id": "mock-anchor"}]}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        req = json.loads(self.rfile.read(n) or b"{}")
        msgs = req.get("messages") or []
        done = sum(1 for m in msgs if m.get("role") == "tool")
        wants = "交付" in last_user(msgs)

        self.send_response(200)
        self.send_header("content-type", "text/event-stream; charset=utf-8")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "close")
        self.end_headers()

        def send(o):
            self.wfile.write(sse(o))
            self.wfile.flush()

        def call(idx, cid, name, args):
            send({"choices": [{"delta": {"tool_calls": [{
                "index": idx, "id": cid, "type": "function",
                "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)},
            }]}}]})

        def finish(reason):
            send({"choices": [{"delta": {}, "finish_reason": reason,
                               "usage": {"prompt_tokens": 60, "completion_tokens": 20, "total_tokens": 80}}]})
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()

        # 慢速长流：整轮要跑 20 秒以上，才测得出「流式途中页面重载」
        # （默认那档 2 秒就结束，重载时轮次早没了，测的是另一回事）
        if "慢慢写" in last_user(msgs):
            for i in range(90):
                if i % 6 == 0:
                    send({"choices": [{"delta": {"reasoning_content": f"第 {i} 步：先想一句再往下写。"}}]})
                else:
                    send({"choices": [{"delta": {"content": f"第 {i} 段：这一段是正文，用来让流式持续几十秒。"}}]})
                time.sleep(0.3)
            finish("stop")
            return

        # 团队：Lead 先 spawn 一名 teammate；teammate 自己那轮靠 prompt 里的 MOCKMATE 认出来，
        # 否则它会再 spawn 一次 → 递归。只用「有没有 tool 消息」区分不够（队友那轮也没有）。
        lu = last_user(msgs)
        # 「断行思考」：真实推理的段落形态 —— 每段之间夹一个空行，整段也常以空行收尾。
        # 这是「折叠那一行只剩『思考』两个字」的取证样本：摘要一旦取到末尾那个空段就整块为空，
        # 而且段落边界会一直出现（旧夹具每片都不带换行，所以从没跑到过这条路）。
        if "断行思考" in lu:
            for piece in BROKEN_THINK:
                send({"choices": [{"delta": {"reasoning_content": piece}}]})
                time.sleep(0.9)
            send({"choices": [{"delta": {"content": "断行思考完了，这是正文。"}}]})
            finish("stop")
            return
        # 「组内再想」：思考 → 工具 → 又一段思考，中间不出正文，所以全在同一个过程组里。
        # 用户把组展开着看工具输出时，第二段思考那一行是「先建空行、后长字」的 ——
        # 那条行的摘要节点在建立时根本没渲染出来，只写 textContent 就永远不更新。
        if "组内再想" in lu:
            if done == 0:
                send({"choices": [{"delta": {"reasoning_content": "先列一下目录，看看有没有旧文件。\n\n"}}]})
                time.sleep(0.5)
                call(0, "call_g1", "bash", {"description": "列目录", "command": "echo ok"})
                finish("tool_calls")
            else:
                for piece in BROKEN_THINK:
                    send({"choices": [{"delta": {"reasoning_content": piece}}]})
                    time.sleep(0.9)
                send({"choices": [{"delta": {"content": "组内再想完了。"}}]})
                finish("stop")
            return
        # 「列目录」：模型用相对路径 "." 调 list_dir（真模型常这么写），并刷一段多行输出。
        # 取证「工具行只剩一个蓝点」：那一行的 .pg-sum 是蓝色等宽路径 + 钉尾 + 扫光三层叠加。
        if "列目录" in lu:
            if done == 0:
                call(0, "call_l1", "list_dir", {"path": "."})
                finish("tool_calls")
            else:
                send({"choices": [{"delta": {"content": "目录看完了。"}}]})
                finish("stop")
            return
        # 「TEAMDEMO 真实团队」：Lead 先建一条任务再派两名队友；alpha 干活之后
        # **认领任务并向 Lead 汇报**（团队工具在成员手里也必须能用，且认领要记在 alpha 名下），
        # 汇报回来后 Lead 合成一份总结并 present 交付。触发词要同时出现在 Lead 与
        # 队友的 prompt 里 —— 队友那轮的 last_user 就是它的 prompt，只写「真实团队」
        # 会让它掉回旧 MOCKMATE 档（上一版夹具就是这么错的）。
        if "TEAMDEMO" in lu:
            if "ALPHA" in lu:
                # 按调用 id 分档（与 Lead 同理）：成员历史里 role=tool 的计数会跳步
                ah = json.dumps(msgs, ensure_ascii=False)
                if "call_a1" not in ah:
                    call(0, "call_a1", "bash", {"description": "看根目录", "command": "ls -1 /sdcard | head -5"})
                    finish("tool_calls")
                elif "call_a2" not in ah:
                    call(0, "call_a2", "write", {"file_path": "notes/alpha.md", "content": "# alpha 的产出\n\n根目录看过了。\n"})
                    finish("tool_calls")
                elif "call_a3" not in ah:
                    # 成员认领：任务板必须把 owner 记成 alpha（记成 lead 就是这次修的反例）
                    call(0, "call_a3", "team_task_update",
                         {"task_id": "task-1", "expected_revision": 1, "action": "claim"})
                    finish("tool_calls")
                elif "call_a5" not in ah:
                    # 服务层认人：队友手里有这两条 schema（目录与桌面一致），但操作本身必须被拒。
                    # 一次发两条：interrupt 的 target 用 "lead"（自中断），不是别的队友 ——
                    # 拿别人名字试只能测到 TEAM_LEAD_REQUIRED，测不到 TEAM_INVALID_TARGET。
                    call(0, "call_a5", "spawn_teammate",
                         {"name": "gamma", "description": "队友想再派一个人", "prompt": "MOCKMATE 请回一句话"})
                    call(1, "call_a6", "interrupt_agent", {"target": "lead"})
                    finish("tool_calls")
                elif "call_a4" not in ah:
                    call(0, "call_a4", "send_message",
                         {"target": "lead", "message": "ALPHA 汇报：看了目录、写了 notes/alpha.md、已认领 task-1"})
                    finish("tool_calls")
                else:
                    send({"choices": [{"delta": {"content": "ALPHA 收尾：产物在 notes/alpha.md。"}}]})
                    finish("stop")
                return
            if "BETA" in lu:
                if done == 0:
                    call(0, "call_b1", "list_dir", {"path": "notes"})
                    finish("tool_calls")
                else:
                    send({"choices": [{"delta": {"content": "BETA 汇报：notes 目录里就那两个文件。"}}]})
                    finish("stop")
                return
            # 按「哪一步的调用已经出现在历史里」分档，不按 role=tool 计数：
            # 一次发两个 spawn 时 done 会跳 2，用计数会整步跳过（present 就永远不执行）。
            hist = json.dumps(msgs, ensure_ascii=False)
            if "call_t1" not in hist:
                # 建任务排在 spawn 之前：同一批按顺序执行，队友一起来就有 task-1 可领
                call(0, "call_t0", "team_task_create",
                     {"subject": "看根目录并写一份说明",
                      "description": "先用 bash 执行 ls -1 /sdcard 看清根目录，再把结论写进 notes/alpha.md："
                                     "第一行写标题，第二行写你看到的条目数量，最后列三条你觉得值得关注的目录。"
                                     "写完用 team_task_update 把 task-1 认领下来再汇报给 lead。"})
                # 第二条：被 task-1 挡住的待办，没人认领 —— 面板要报「被依赖阻塞 + 依赖: task-1 +
                # Owner: 未分配」，这三条是桌面 TaskCard 的 meta 行，少一条用户就分不清
                # 「没人领」与「领了但被挡」
                call(1, "call_t0b", "team_task_create",
                     {"subject": "汇总两名队友的结论",
                      # 故意写得很短：这一条是「展开按钮不该出现」的负对照
                      "description": "汇总两份结论",
                      "blocked_by": ["task-1"], "write_scopes": ["notes"]})
                call(2, "call_t1", "spawn_teammate",
                     {"name": "alpha", "description": "看根目录并写一份说明",
                      "prompt": "MOCKMATE TEAMDEMO ALPHA 先用 bash 看 /sdcard，再写 notes/alpha.md，"
                                "然后 team_task_update 认领 task-1，最后 send_message 汇报给 lead"})
                call(3, "call_t2", "spawn_teammate",
                     {"name": "beta", "description": "清点 notes 目录",
                      "prompt": "MOCKMATE TEAMDEMO BETA 用 list_dir 看 notes 目录，然后汇报"})
                finish("tool_calls")
            elif "call_t3" not in hist:
                call(0, "call_t3", "write", {"file_path": "notes/summary.md",
                     "content": "# 团队总结\n\nalpha 与 beta 都完成了。\n"})
                finish("tool_calls")
            elif "call_t4" not in hist:
                call(0, "call_t4", "present", {"files": ["notes/summary.md"]})
                finish("tool_calls")
            elif "call_t5" not in hist:
                # Lead 自己中断自己：桌面 roster.ts:192 给的是 TEAM_INVALID_TARGET（不是「查无此人」）。
                # 手机端 roster 里 lead 是真实一行，少了这一刀就会把 Lead 写成 inactive。
                call(0, "call_t5", "interrupt_agent", {"target": "lead"})
                finish("tool_calls")
            else:
                send({"choices": [{"delta": {"content": "两名队友都完成了，总结已经写进 notes/summary.md 并交付。"}}]})
                finish("stop")
            return
        if "MOCKSLOW" in lu:
            # 长时间的一口气：60 × 0.4 秒 ≈ 24 秒，够页面在成员视图里被回收、重建、再进去一趟
            if done == 0:
                call(0, "call_s1", "bash", {"description": "队友列目录", "command": "ls -1 /sdcard"})
                finish("tool_calls")
                return
            for i in range(60):
                send({"choices": [{"delta": {"content": f"慢流第 {i} 句：还在处理…"}}]})
                time.sleep(0.4)
            finish("stop")
            return
        # 「TRACEDEMO 离开期间还在产工具」：Lead 先派一个慢队友，然后隔很久再调两条工具，
        # 最后才说正文。用户报的形状是「进成员视图期间 Lead 跑了工具，回到 Lead 只剩正文、
        # 过程里那几行工具没了」—— 工具必须排在进入之后，探针才量得到这条差异。
        if "TRACEDEMO" in lu:
            if done == 0:
                call(0, "call_td1", "spawn_teammate",
                     {"name": "mate-x", "description": "挤桶夹具的队友",
                      "prompt": "MOCKSLOW 请回一句话"})
                finish("tool_calls")
                return
            if done == 1:
                time.sleep(8)     # 这段时间探针进成员视图并挤过别的会话
                call(1, "call_td2", "bash", {"description": "离开期间第一条", "command": "echo 期间一"})
                finish("tool_calls")
                return
            if done == 2:
                time.sleep(6)
                call(2, "call_td3", "write", {"file_path": "notes/trace.txt", "content": "离开期间写的\n"})
                finish("tool_calls")
                return
            for seg in ["两条工具都在离开期间跑完了。\n", "这一段正文是回来后的对照。\n"]:
                send({"choices": [{"delta": {"content": seg}}]})
                time.sleep(0.4)
            finish("stop")
            return
        if "RELOADDEMO" in lu:
            if done == 0:
                call(0, "call_r1", "spawn_teammate",
                     {"name": "mate-one", "description": "长时间流式的队友",
                      "prompt": "MOCKSLOW 请回一句话"})
                finish("tool_calls")
            else:
                for i in range(30):
                    send({"choices": [{"delta": {"content": f"Lead 第 {i} 段：等队友的同时我也在写。"}}]})
                    time.sleep(0.5)
                finish("stop")
            return
        if "TEAMFULL" in lu:
            # 并发命中形状（桌面 manager.ts:744 pool.reserve → ACTIVATION_LIMIT_REACHED →
            # 落成 failed 成员，roster.ts:264-281）：一次派两个队友，探针把上限设成 1，
            # 第二个就该是「failed + error 文本 + 面板红点」，而不是安静地挂着等待唤醒。
            if done == 0:
                call(0, "call_f1", "spawn_teammate",
                     {"name": "fast-one", "description": "先占住唯一槽位",
                      "prompt": "MOCKSLOW 请回一句话"})
                finish("tool_calls")
                return
            if done == 1:
                call(0, "call_f2", "spawn_teammate",
                     {"name": "fast-two", "description": "抢不到槽位的那个",
                      "prompt": "MOCKSLOW 请回一句话"})
                finish("tool_calls")
                return
            for seg in ["两次派活都试过了。\n", "探针看的是第二次的落点。\n"]:
                send({"choices": [{"delta": {"content": seg}}]})
                time.sleep(0.4)
            finish("stop")
            return
        if "MOCKMATE" in lu:
            # 队友也调一次工具：成员视图要能画出与主对话同一形状的工具行（过程组 + 行 + 输入/输出）
            if done == 0:
                call(0, "call_m1", "bash", {"description": "队友列目录", "command": "ls -1 /sdcard"})
                finish("tool_calls")
                return
            # 慢一点：留出「成员还在跑、人已进入它的会话」的时间窗
            for i in range(20):
                send({"choices": [{"delta": {"content": f"队友第 {i} 句：正在处理…"}}]})
                time.sleep(0.5)
            finish("stop")
            return
        if "组建团队" in lu:
            if done == 0:
                call(0, "call_t1", "spawn_teammate",
                     {"name": "mate-one", "description": "测试队友", "prompt": "MOCKMATE 请回一句话"})
                finish("tool_calls")
            else:
                # Lead 在 spawn 之后也慢慢说：用来复现「进入成员会话时 Lead 还在跑」
                for i in range(30):
                    send({"choices": [{"delta": {"content": f"Lead 第 {i} 段：等队友的同时我也在写。"}}]})
                    time.sleep(0.5)
                finish("stop")
            return

        # 工具名回归：第一个 chunk 给真名，后续 chunk 再发 `"name": null`（真实端点/代理会这样），
        # 累积逻辑必须保住真名 —— 否则 exec 收到字符串 "null"，报「工具名不合法」。
        # 「先说再干」：正文说完 → 3.5 秒空窗（模型在写工具参数）→ 工具 → 收尾。
        # 复现「说完一句带冒号、界面看起来就结束了」那段空窗。
        if "先说再干" in lu:
            if done == 0:
                for seg in ["收到，我直接重画一版更精细的（光影、细节、背景层次全面升级）："]:
                    send({"choices": [{"delta": {"content": seg}}]})
                time.sleep(3.5)
                call(0, "call_x1", "bash", {"description": "先跑一下", "command": "echo 画完了"})
                finish("tool_calls")
            else:
                send({"choices": [{"delta": {"content": "好了。"}}]})
                finish("stop")
            return

        # 慢速思考：看清「组头那一行是否跟着最新字走」「展开后是否还在长」
        if "慢慢想" in lu:
            for i in range(80):
                send({"choices": [{"delta": {"reasoning_content": f"第{i:02d}步：先确认目录里有没有同名文件，再决定覆盖还是新建，"}}]})
                time.sleep(0.25)
            send({"choices": [{"delta": {"content": "想完了，这是正文。"}}]})
            finish("stop")
            return

        # 子代理回合（「子代理工具命令老是处理失败」取证用）：Lead 派子代理 → 子代理自己
        # 调 bash → 回结论 → Lead 收尾。子代理那条请求靠提示词里的 SUBBASH 认出来。
        if "派子代理" in lu or "SUBBASH" in lu:
            sub = "SUBBASH" in lu
            if sub and done == 0:
                call(0, "call_b1", "bash", {"description": "列目录", "command": "ls -1"})
                finish("tool_calls")
            elif sub:
                send({"choices": [{"delta": {"content": "子代理结论：目录里有 3 个文件。"}}]})
                finish("stop")
            elif done == 0:
                call(0, "call_sub1", "subagent", {"description": "看目录",
                     "prompt": "SUBBASH 请用 bash 执行 ls -1 并汇报结果"})
                finish("tool_calls")
            else:
                send({"choices": [{"delta": {"content": "子代理回来了，Lead 收尾。"}}]})
                finish("stop")
            return

        # 工具回合（重载补档 / 实时输出回归用）：思考 → 一条会刷 7 秒输出的命令 →
        # 慢正文（12 秒，留出「已经跑过工具、正文还在流」的重载窗口）→ 第二条命令 → 收尾。
        if "慢工具" in lu:
            if done == 0:
                send({"choices": [{"delta": {"reasoning_content": "先看一眼目录，再决定读哪个文件。"}}]})
                time.sleep(0.3)
                call(0, "call_a1", "bash", {"description": "逐行打印",
                     "command": "for i in $(seq 1 25); do echo 第${i}行输出; sleep 0.3; done; echo 全部完成"})
                finish("tool_calls")
            elif done == 1:
                for i in range(20):
                    if i % 5 == 0:
                        send({"choices": [{"delta": {"reasoning_content": f"第{i}步：边写边想，这一段要够长才撑得住重载窗口。"}}]})
                    else:
                        send({"choices": [{"delta": {"content": f"第{i}段：正文继续，重载要发生在这中间。"}}]})
                    time.sleep(0.6)
                call(0, "call_a2", "bash", {"description": "再数一次", "command": "echo 第二次输出"})
                finish("tool_calls")
            else:
                send({"choices": [{"delta": {"content": "两次命令都跑完了，这是收尾正文。"}}]})
                finish("stop")
            return

        # 宽度回归：思考正文里混进 md() 会渲染成块级的东西 —— 代码块、长链接、行内代码、
        # 表格、超长无空格串。这些是「展开后被屏幕横向截断」的取证样本（.pg-think-text
        # 里的 pre 不吃 .assistant-text 那套折行规则，默认 white-space: pre 直接横着长）。
        if "宽思考" in lu:
            for piece in WIDE:
                send({"choices": [{"delta": {"reasoning_content": piece}}]})
                time.sleep(0.4)
            send({"choices": [{"delta": {"content": "宽思考完了。"}}]})
            finish("stop")
            return

        if "MOCKNULLNAME" in lu:
            if done == 0:
                send({"choices": [{"delta": {"tool_calls": [{
                    "index": 0, "id": "call_n1", "type": "function",
                    "function": {"name": "team_status", "arguments": ""}}]}}]})
                time.sleep(0.15)
                send({"choices": [{"delta": {"tool_calls": [{
                    "index": 0, "function": {"name": None, "arguments": "{}"}}]}}]})
                finish("tool_calls")
            else:
                send({"choices": [{"delta": {"content": "工具调用结束。"}}]})
                finish("stop")
            return

        if not wants:
            # 思考分片流出：测「思考行跟着输出走」需要看到多个中间态
            for i in range(0, len(THINK), 14):
                send({"choices": [{"delta": {"reasoning_content": THINK[i:i + 14]}}]})
                time.sleep(0.06)
            send({"choices": [{"delta": {"content": BULK}}]})
            finish("stop")
            return

        if done == 0:
            send({"choices": [{"delta": {"content": BULK + "\n\n先写一个文件，再把它作为本轮产出交付。"}}]})
            time.sleep(0.1)
            call(0, "call_w1", "write", {"file_path": PATH, "content": "锚定插入回归用的一行内容\n"})
            finish("tool_calls")
        elif done == 1:
            call(0, "call_p1", "present", {"files": [{"path": PATH, "description": "锚定检查"}]})
            finish("tool_calls")
        else:
            send({"choices": [{"delta": {"content": "已交付，本轮结束。"}}]})
            finish("stop")


if __name__ == "__main__":
    # 端口自检：ThreadingHTTPServer 默认允许重绑，所以「起了新的、旧的还在听」不会报错 ——
    # 实测有一整轮 teamops 假失败就是这么来的（症状是「夹具没派出队友」，看着像内核坏了）。
    probe = socket.socket()
    probe.settimeout(0.6)
    try:
        probe.connect(("127.0.0.1", PORT))
        sys.exit(f"端口 {PORT} 已经有东西在听：那是上一次起的旧夹具，它会抢走请求。"
                 f"先 `netstat -ano | findstr :{PORT}` 拿到 PID 杀掉，再重起这一份。")
    except OSError:
        pass
    finally:
        probe.close()
    print(f"anchor mock on {PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
