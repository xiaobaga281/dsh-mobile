/* AUTO-GENERATED — DO NOT EDIT.
   Source: web/src/*.js in web/build.json order · 4 parts · parts sha256 a2f7a207
   Edit the parts, then run: node scripts/build-web.mjs   (or: node scripts/sync-web.mjs) */
/* =========================================================
   DSH Mobile — client runtime
   Harness-native agent session UI, Apple-inspired interaction.
   ========================================================= */
(() => {
  "use strict";

  /* 原生桥：内核按域拆成了十个命名空间（设备/宿主/网络/智能体/手机/账号/语音/内核/通知/联动），
     这里合成一个对象，业务代码继续用 Native.xxx —— 方法名全局唯一，不用关心它落在哪个域。
     新增域时只改这张表，调用点零改动。 */
  const NATIVE_DOMAINS = [
    window.DSHNativeDevice, window.DSHNativeHost, window.DSHNativeNet,
    window.DSHNativeAgent, window.DSHNativePhone, window.DSHNativeAccount,
    window.DSHNativeVoice, window.DSHNativeKernel, window.DSHNativeNotify,
    window.DSHNativeLink, window.DSHNativeSticker,
    window.DSHNativeTeam, window.DSHNativeUpdate,
  ].filter(Boolean);
  /* 白名单只是「优先级」，不是准入清单：新增一个原生桥如果忘了往上面加一行，
     Native.xxx 会静默变成 undefined（rc.146 的「检查更新」就这么哑了一版，
     界面只会说「当前版本不支持检查更新」）。所以把没列到的 DSHNative* 一律追加在后面，
     既保住已有顺序（同名方法以先列者为准），又不会因为漏登记而废掉整块功能。 */
  for (const k of Object.keys(window)) {
    if (!k.startsWith("DSHNative")) continue;
    const d = window[k];
    if (d && typeof d === "object" && !NATIVE_DOMAINS.includes(d)) NATIVE_DOMAINS.push(d);
  }
  /* 方法缓存：命中后 O(1)，未命中才退回线性扫描并记住结果。
     必须**懒着建**：`@JavascriptInterface` 对象上的每次 `typeof d[k]` 都是一次跨语言取值，
     启动时把两百多个方法全摸一遍是纯浪费（这版实测过：改成启动时预热反而更慢，已回退成懒建）。
     现在启动零成本，真正调用到时才记一次，之后的高频调用点（流式里每秒几十次）全走缓存。 */
  const NATIVE_METHODS = new Map();
  const Native = NATIVE_DOMAINS.length
    ? new Proxy({}, {
      get(_, key) {
        const hit = NATIVE_METHODS.get(key);
        if (hit) return hit;
        for (const d of NATIVE_DOMAINS) {
          if (typeof d[key] !== "function") continue;
          const fn = d[key].bind(d);
          NATIVE_METHODS.set(key, fn);
          return fn;
        }
        // 不缓存「没有」：桥按文档重挂，同文档内后续补齐仍要能取到
        return undefined;
      },
      has: (_, key) => NATIVE_METHODS.has(key) || NATIVE_DOMAINS.some((d) => typeof d[key] === "function"),
    })
    : null;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /* 记忆/摘要用的文本裁剪：去换行、去 Markdown 标记、超长省略 */
  const pageClip = (s, n) => {
    const t = String(s || "").replace(/```[\s\S]*?```/g, " ").replace(/[#*`>_\-]+/g, " ")
      .replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) + "…" : t;
  };
  const firstSentence = (s) => {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    const m = t.match(/^[^。！？!?\n]{2,80}[。！？!?]?/);
    return m ? m[0] : t.slice(0, 80);
  };

  /* ---------------- i18n（轻量：按文案精确匹配，覆盖界面 chrome） ---------------- */
  const I18N = {
    "会话": "Chats", "任务": "Tasks", "文件": "Files", "设置": "Settings",
    "置顶": "Pinned", "最近": "Recent", "今日": "Today", "定时": "Scheduled",
    // 会话行四个动作与分叉按钮的无障碍名/文案：i18n 探针扩到「任意按钮的属性」后实测出的缺词条
    "取消置顶": "Unpin", "从这里分叉": "Fork from here",
    "搜索会话、文件、命令": "Search chats, files, commands",
    "已连接": "Connected", "本地": "Local", "远程": "Remote", "运行中": "Running",
    "完成": "Done", "待处理": "Pending",
    "通用": "General", "宿主": "Host","外观": "Appearance",
    "连接宿主机": "Connect host","默认工作区": "Default workspace",
    "默认模型": "Default model", "添加自定义模型": "Add custom model",
    "深色模式": "Dark mode",
    "危险操作前询问": "Ask before risky actions",
    "完成后通知": "Notify when done", "材质": "Material",
    "未连接": "Not connected", "未登录": "Signed out", "登录": "Sign in", "管理": "Manage",
    "登录后使用 DeepSeek 模型与额度": "Sign in to use DeepSeek models and quota",
    "退出登录": "Sign out", "查看用量与充值": "Usage & top-up", "账号": "Account",
    "使用 API Key": "Use API key", "保存": "Save", "关闭": "Close", "取消": "Cancel",
    "发消息给 Agent…": "Message the agent…", "思考强度": "Reasoning effort",
    "在对话中搜索": "Search in chat", "输入关键词": "Type to search", "下一处": "Next match", "上一处": "Previous match", "退出搜索": "Exit search",
    "工作区": "Workspace", "分享会话": "Share chat", "重命名": "Rename",
    "打开宿主机 Web UI": "Open host Web UI",
    "删除会话": "Delete chat","创建任务": "Create task",
    "任务名称": "Task name", "补充说明（可选）": "Optional notes", "编辑任务": "Edit job", "保存修改": "Save changes",
    "产出": "Outputs",
    "端点": "Endpoint", "模型映射": "Model mapping", "显示名称": "Display name",
    "本地标识": "Local ID", "上游模型（发送给 API 的 model 字段）": "Upstream model (API model field)",
    "API 地址": "API base URL",
    "思考档位（填上游认的标识，逗号分隔；留空 = 不支持）": "Reasoning levels (upstream ids, comma separated; empty = none)",
    "添加模型": "Add model", "配置": "Configure", "删除": "Delete",
    "档位": "Level", "极速": "Fast", "均衡": "Balanced", "深入": "Deep",
    "极致": "Max", "关": "Off", "低": "Low", "中": "Medium", "高": "High", "最高": "Highest",
    "语言": "Language", "跟随系统": "System", "简体中文": "简体中文", "运行通知": "Run notification",
    "检查更新": "Check for updates",
    "额度与用量": "Usage & quota", "账户余额": "Balance", "最近 12 周": "Last 12 weeks", "会话消耗": "Chat usage",
    "输入": "Input", "输出": "Output", "轮次": "Turns", "平均每轮": "Avg / turn",
    "当前模型": "Current model", "支持": "supports",
    // —— 界面 chrome 补充（对话流、面板、按钮、空状态）——
    "新会话": "New chat", "发消息给 Agent…": "Message the agent…", "发送": "Send",
    "停止": "Stop", "继续": "Continue", "重新生成": "Regenerate", "复制": "Copy",
    "已复制": "Copied", "重试": "Retry", "取消": "Cancel", "确定": "OK", "保存": "Save",
    "关闭": "Close", "删除": "Delete", "重命名": "Rename", "更多": "More",
    "思考": "Thinking", "结论": "Conclusion", "改动": "Changes", "状态": "Status",
    "输出": "Output", "输入": "Input", "子代理": "Subagent", "子智能体": "Subagent",
    "正在压缩上下文": "Compacting context", "已压缩上下文": "Context compacted",
    "会话模式": "Session mode", "计划模式": "Plan mode", "目标模式": "Goal mode",
    "极简模式": "Minimal mode", "标准模式": "Standard mode", "增强模式": "Enhanced mode",
    "只读": "Read-only", "默认权限": "Default", "完全访问": "Full access",
    "上下文压缩": "Context compaction", "最大输出": "Max output", "工作区": "Workspace",
"思考强度": "Reasoning effort", "角色设定": "Persona",
    "语言": "Language", "账号": "Account", "插件": "Plugins", "权限": "Permissions",
    "读取文件": "Read file", "写入文件": "Write file", "编辑": "Edit",
    "查看目录": "List folder", "查找文件": "Find files", "搜索内容": "Search code",
    "执行命令": "Run command", "联网搜索": "Web search", "抓取网页": "Fetch page",
    "读取图片": "Read image", "加载技能": "Load skill", "更新待办": "Update todos",
    "更新目标": "Update goal", "建立目标": "Create goal", "查询目标": "Get goal",
    "提交计划": "Submit plan", "交付文件": "Deliver files", "终端": "Terminal",
    "后台任务": "Background jobs", "终止任务": "Kill job", "任务输出": "Job output",
    "任务": "Tasks", "文件": "Files", "设置": "Settings", "最近": "Recent",
    // 任务页两组筛选控件的无障碍名（i18n 探针实测：英文模式下这两个还念中文）
    "按状态筛选": "Filter by status", "按来源筛选": "Filter by source",
    "今日": "Today", "定时": "Scheduled", "已连接": "Connected", "本地": "Local",
    "远程": "Remote", "运行中": "Running", "完成": "Done", "待处理": "Pending",
    "还没有会话": "No chats yet", "工作区为空": "Workspace is empty",
    "暂无交付文件": "No deliverables yet", "没有匹配的文件": "No matching files",
    "换个关键词试试": "Try another keyword", "用其它应用打开": "Open in another app",
    "上传文件 / 图片": "Upload file / image", "添加附件": "Add attachment",
    "相机": "Camera", "语音输入": "Voice input", "麦克风": "Microphone",
    "删除文件": "Delete file", "删除这条附件记录": "Remove this attachment record",
    "立即触发一次": "Run now", "标记为完成": "Mark as done", "删除任务": "Delete job",
"删除定时任务": "Delete scheduled job",
    "删除记录": "Delete record", "重新跑一次": "Run it again",
    "打开团队面板": "Open team panel",
    "要取消或删掉，去团队面板的任务板上做；这里只是它的投影。": "Cancel or delete it on the team board; this list only mirrors it.",
    "已删除这条记录": "Record deleted", "已删除记录": "Record deleted",
    "定时任务已删除": "Scheduled job deleted",
    "内核里已经没有这条定时任务了": "This scheduled job no longer exists on the system",
    "这一条已经不在了": "This entry is already gone",
    "已终止这件事的后台任务": "Background job stopped",
    "已按当时的命令重新起一个后台任务": "Started a new background job with the same command",
    "执行计划": "Run plan", "要求修改": "Request changes", "拒绝": "Reject",
    "允许一次": "Allow once", "始终允许": "Always allow", "批准执行": "Approve and run",
    "正在读取电脑会话…": "Reading desktop chats…", "历史加载失败": "Failed to load history",
    "已登录": "Signed in", "未登录": "Signed out", "登录": "Sign in", "未连接": "Not connected",
    "连接宿主机": "Connect host","默认工作区": "Default workspace", "默认模型": "Default model",
    "添加自定义模型": "Add custom model", "深色模式": "Dark mode",
    "危险操作前询问": "Ask before risky actions", "完成后通知": "Notify when done",
    "通用": "General", "宿主": "Host", "外观": "Appearance",
"凭据": "Credentials", "刷新": "Refresh",
    "注入预览": "Injection preview", "移动到工作区": "Move to workspace",
    "删除会话": "Delete chat", "重命名会话": "Rename chat", "标题": "Title",
    "已回答": "Answered", "失败": "Failed", "结束": "End",
    "已打开": "Opened", "关闭全部": "Close all",
    // —— 高频动态文案（toast / 面板 / 按钮 / 状态行）——
    "当前环境不支持跳转": "Cannot open on this device",
    "登录后享受账号额度": "Sign in to use your plan quota",
    "表情包": "Stickers", "转文字": "To text", "朗读": "Play",
    "账号模型未就绪，请重新登录": "Account not ready, please sign in again",
    "已退出登录": "Signed out", "已保存": "Saved", "已删除": "Deleted",
    "已删除会话": "Chat deleted", "删除会话？": "Delete chat?",
    "删除所选": "Delete selected", "进入目录": "Open folder",
    "分享文件": "Share file", "图片数据缺失": "Image data unavailable",
    "音频数据缺失": "Audio data unavailable", "没有可预览的内容": "Nothing to preview",
    "用账号额度运行": "Run with plan quota", "等待子代理开始…": "Waiting for the subagent…",
    "提交修改意见": "Submit feedback", "登录 DeepSeek 账号": "Sign in to DeepSeek",
    "模型（拉取后选择）": "Model (fetch to choose)", "拉取": "Fetch",
    "本地标识（可留空自动生成）": "Local ID (blank = auto)",
    "正在查询账户余额…": "Checking balance…",
    "打开平台用量页": "Open usage page",
    "余额不足，可能无法继续调用": "Balance too low to keep calling",
    "点任意方块查看当天消耗": "Tap any square to see that day's usage",
    "无记录": "No records", "这一天没有调用模型": "No model calls that day",
    "还没有会话消耗记录": "No chat usage yet",
    "后台运行": "Run in background", "电池优化": "Battery optimization",
    "前台服务": "Foreground service", "打开通知设置": "Open notification settings",
    "加入电池优化白名单": "Add to battery whitelist",
    "我已复制，填入 API Key": "Copied — paste your API Key",
    "保存并启用": "Save and enable", "保存位置": "Stored at", "仅本机": "This device only",
    "退出登录？": "Sign out?", "选择模型": "Select model", "返回填写": "Back to form",
    "上下文窗口": "Context window", "生效强度": "Active effort",
    "看看模型实际收到什么": "See exactly what the model receives",
    "自定义角色设定": "Custom persona", "快捷操作": "Quick actions",
    "目标": "Goal", "追轮方式": "Round mode", "自定义轮数（可选）": "Custom rounds (optional)",
    "标记已完成": "Mark done", "清除目标": "Clear goal",
    "开启完全访问？": "Enable full access?", "确认开启": "Enable",
"当前环境不支持语音": "Voice is unavailable here",
    "已保存到剪贴板": "Copied to clipboard", "已复制到剪贴板": "Copied to clipboard",
    "复制失败": "Copy failed", "已停止朗读": "Playback stopped",
    "正在朗读": "Speaking", "没有可分享的目标": "No share target available",
    "这条回复没有可朗读的文字": "This reply has no text to read aloud",
    "系统没有可用的语音合成引擎": "No speech engine available",
    "已生成并显示在对话里": "Generated and shown in chat",
    "生成模型已保存": "Generation models saved", "保存失败": "Save failed",
    "当前环境不支持保存": "Saving is unavailable here",
    "模型配置": "Model configuration", "部分配置": "Partially configured", "已配置": "Configured",
    "图片模型": "Image model", "视频模型": "Video model",
    "接口地址（OpenAI 兼容）": "Endpoint (OpenAI-compatible)",
    "模型名": "Model name", "保存": "Save",
    "发送给 Agent…": "Message the agent…",
    "已连接": "Connected", "已启用": "Enabled", "已关闭": "Disabled",
    "语音输入已开启：输入框右侧可以说话": "Voice input on: tap the mic to speak",
    "语音输入已关闭": "Voice input off",
    "语音朗读已开启：闲聊会念出来，数据与代码不会": "Voice output on: chats are spoken, data is not",
    "语音朗读已关闭": "Voice output off",
    "没有匹配的文件": "No matching files", "换个关键词试试": "Try another keyword",
    "工作区为空": "Workspace is empty", "还没有附件": "No attachments yet",
    "在对话里点「+」上传文件，附件会记录在这里": "Files you attach in chat appear here",
    "连接宿主机后，Agent 产出的文件会显示在这里": "Host deliverables appear here once connected",
    "连接宿主机后，工作区文件会显示在这里": "Workspace files appear here once connected",
    "连接后显示 Agent 产出": "Deliverables appear here once connected",
    "连接后显示工作区文件": "Workspace files appear once connected",
    "连接后显示 Agent 任务": "Agent jobs appear once connected",
    "解除配对": "Unpair",
"删除会话": "Delete chat", "彻底删除": "Delete permanently",
    "不可恢复": "Cannot be undone",
    "已删除：会话与过程记录已从本机移除": "Deleted: the chat and its history are removed from this device",
    "宿主机会话请在宿主机那边删除": "Delete host chats on the host side",
    "重命名": "Rename", "打开宿主机 Web UI": "Open host Web UI",
    "移动到工作区": "Move to workspace",
    "搜索会话、文件、命令": "Search chats, files, commands",
    "已停止": "Stopped", "处理失败": "Failed", "已完成，用时": "Done in ",
    "这一轮没跑完": "Turn interrupted",
    "应用被退出或被系统回收，上面是已经产出的部分": "The app was closed or recycled mid-reply; what it produced is above",
    "分钟前": " min ago", "小时前": " h ago", "天前": " d ago", "刚刚": "just now",
    "复制": "Copy", "换一张码": "New code", "启动联动": "Start linking",
    "停止联动": "Stop linking", "启动中…": "Starting…", "停止中…": "Stopping…",
    "已停止联动": "Linking stopped", "联动已启动": "Linking started",
    "中继地址": "Relay address", "刷新": "Refresh",
    "配对": "Pair", "手动输入": "Enter manually", "取消": "Cancel",
    "用这段内容配对": "Pair with this", "先粘贴配对内容": "Paste the pairing text first",
    "已复制配对内容": "Pairing text copied",
    "已删除本地会话": "Local chat deleted", "删除本地会话？": "Delete local chat?",
    // —— rc.116 补齐：首页 chrome / 设置各面板 / 插件清单 / 提示说明 ——
    "暂无会话": "No chats yet", "电脑": "Desktop", "选择": "Select",
    "端到端加密 · 会话保存在你的设备上": "End-to-end encrypted · chats stay on this device",
    "退出": "Exit", "还没有任务": "No jobs yet",
    "点右上角「+」新建任务": "Tap + at the top right to create a job",
    "Agent 用 present 交付的文件会出现在这里": "Files the agent delivers with present appear here",
    "暂无产出文件": "No deliverables yet", "上下文与输出": "Context & output",
    "记忆": "Memory", "全局记忆": "Global memory", "全局记忆条目": "Global memory entries",
    "默认": "Default", "相处": "Bonding", "未开启": "Off",
    "搜索接口": "Search API", "未配置": "Not set up", "运行": "Run",
    "运行方式": "Run mode", "本地独立": "Standalone",
    "新对话默认档位": "Default mode for new chats", "内核插件": "Core plugins",
    "通知已关闭": "Notifications off", "生成模型": "Generation models",
    "Agent 权限": "Agent permissions", "权限模式": "Permission mode",
    "查看用户提示词": "View user prompt", "未设置": "Not set",
    "正在聆听…": "Listening…", "说完点确认": "Tap ✓ when done",
    "已追加到输入框": "Added to the input box",
    "麦克风未授权": "Microphone not granted", "联网搜索": "Web search",
    "仅此目录": "This folder only", "git main · 工作区根目录": "git main · workspace root",
    "主目录": "Home folder", "返回": "Back", "团队": "Team",
"语音": "Voice", "主导航": "Main navigation",
    // 全局记忆
    "自动抽取偏好、决策与事实": "Auto-extracts preferences, decisions and facts",
    "还没有记忆。对话里出现的偏好、决策、事实会被抽成条目自动存进来，也可以手动添加。":
      "No memories yet. Preferences, decisions and facts from your chats are captured automatically; you can also add entries yourself.",
    "看看这次会注入哪些": "Preview what gets injected",
    "如：回复尽量简短，代码给完整文件": "e.g. keep replies short; always give complete files for code",
    // 陪伴式畅聊
    "陪伴式畅聊": "Companion chat", "到点才说话": "Speaks on schedule",
    "关闭时它只在你说话之后回应": "When off, it only replies after you speak",
    "语音回聊": "Voice replies",
    "它说完不出声；想回就长按输入框说话": "It stays silent after speaking; hold the input box to reply by voice",
    "现在聊一句": "Say something now",
    "手动触发一次心跳，看看它会说什么（不会计入节流）": "Trigger one heartbeat to see what it says (not counted toward throttling)",
    "试试": "Try", "节奏": "Pace", "安静": "Quiet",
    "一到两小时，随口一句 · 每天最多 12 次": "Every 1–2 hours, a casual line · max 12/day",
    "适中": "Moderate",
    "半小时上下，想起来就聊 · 每天最多 24 次": "About every 30 min · max 24/day",
    "话多": "Chatty",
    "十几二十分钟就想搭话 · 每天最多 48 次": "Every 10–20 min · max 48/day",
    "免打扰": "Quiet hours", "这段时间它保持安静": "It stays silent during this period",
    "不设免打扰": "No quiet hours", "任何时间都可能开口（不建议）": "May speak at any time (not recommended)",
    "说话风格": "Speaking style", "随性": "Casual", "像熟人，自然就好": "Like a friend — just natural",
    "温柔": "Gentle", "先关心感受，语气软": "Feelings first, soft tone",
    "损友": "Playful", "会开小玩笑，轻轻吐槽": "Little jokes, light teasing",
    "话很少，只挑重要的": "Few words, only the essentials",
    "运行状态": "Status", "下次窗口": "Next window",
    "到点才判断，不保证开口": "Decided when due — it may not speak",
    "上次心跳": "Last heartbeat", "还没跑": "Not yet",
    "上次开口": "Last spoke", "还没说过": "Never yet",
    "上次跳过": "Last skipped",
    "间隔 25–55 分钟；前台服务保活，后台与锁屏期间也到点开口（通知送达）；被系统强杀后回到应用会自动补拍":
      "Every 25–55 min; a foreground service keeps it alive so it still speaks on schedule from background or lock screen (via notification); if the system kills it, it catches up when you return",
    // 联网搜索接口
    "联网搜索接口": "Web search API", "兼容 Bing/Tavily": "Bing/Tavily compatible",
    "搜索接口地址": "Search API endpoint", "每次提问最多返回条数": "Max results per query",
    "Bearer 鉴权用的 key": "Bearer auth key", "earer 鉴权用的 key": "Bearer auth key",
    // 运行方式
    "本地直连模型": "Direct model connection", "需要先配置模型 API 与密钥": "Set up a model API and key first",
    "连接主机": "Connect to host", "未填写宿主机地址": "Host address not set",
    "填写宿主机地址": "Enter the host address",
    "本地会话存本机，主机会话存宿主": "Local chats stay on this device, host chats on the host",
    // 新对话默认档位
    "对话内仍可随时用模式条临时切换": "You can still switch modes anytime from the mode bar",
    "处理代码、文件与资料": "Code, files and documents", "PTC 模式": "PTC mode",
    "批量调用工具并整理结果": "Batch tool calls with tidy results",
    "终端 + 图片读取，带压缩": "Terminal + image reading, with compaction",
    "创造模式": "Creator mode", "让 Agent 写插件、加功能": "Let the agent write plugins and add features",
    "档位决定对话能用到哪些工具：极简最省 token；PTC 只暴露 run_code 程序化调用；创造模式可写插件改自身":
      "The mode decides which tools a chat may use: Minimal saves the most tokens; PTC exposes only run_code for programmatic calls; Creator can write plugins and extend itself",
    // 插件面板
    "关闭后工具消失": "Tools disappear when off", "扩展插件": "Add-on plugins",
    "完全离线，不联网 · 当前 标准 · 内置中文": "Fully offline · current: Standard · built-in Chinese",
    "语音消息": "Voice messages",
    "已开启：闲聊回复会是语音消息（点开即播）；代码/表格/数据/长文仍用文字":
      "On: casual replies arrive as voice messages (tap to play); code, tables, data and long text stay textual",
    "语音音色": "Voice",
    "当前 系统 TTS · 点这里换": "Current: system TTS · tap to change",
    "增强模型 · SenseVoice": "Enhanced model · SenseVoice",
    "可选 228MB · 中英日韩粤混说、准确率更高": "Optional 228 MB · zh/en/ja/ko/yue, higher accuracy",
    "下载": "Download",
    "内置中文模型 26MB 已随应用安装，边说边出字；说英文术语多的时候建议下增强模型。":
      "The built-in Chinese model (26 MB) ships with the app and transcribes while you speak; get the enhanced model if you say many English terms.",
    "清单放": "Drop plugin manifests into ", "，重启生效": " — takes effect after restart",
    "文档读取": "Document reading",
    "读取 PDF / Word / Excel / PowerPoint / 文本类文档的正文 · 1 个工具": "Extract text from PDF / Word / Excel / PowerPoint / plain-text documents · 1 tool",
    "文档生成": "Document generation",
    "生成 .docx 报告与 .xlsx 表格（纯 JDK 写 OOXML，Word/WPS/Excel 可直接打开） · 5 个工具": "Generate .docx reports and .xlsx sheets (pure-JDK OOXML; opens in Word/WPS/Excel) · 5 tools",
    "命令": "Command",
    "在工作区执行一次性 shell 命令（无交互、20 秒超时、可后台） · 1 个工具": "Run one-shot shell commands in the workspace (non-interactive, 20 s timeout, background capable) · 1 tool",
    "语言运行时": "Language runtimes",
    "本机执行 python / node 脚本（运行时按需供给，缺失返回 NEED_RUNTIME） · 7 个工具": "Run python / node scripts on-device (runtimes provisioned on demand; NEED_RUNTIME when missing) · 7 tools",
    "Harness 行为": "Harness behavior",
    "计划评审、目标推进、待办清单、联网检索、子智能体、向用户提问 · 11 个工具": "Plan review, goal tracking, todos, web search, subagents, asking the user · 11 tools",
    "预设能力": "Preset abilities",
    "PTC 运行代码、Cordis 只读检查、插件管理与市场 · 5 个工具": "PTC code runs, Cordis read-only checks, plugin manager & market · 5 tools",
    "编辑与交付": "Editing & delivery",
    "str_replace_editor、present 交付物、apply_patch 补丁 · 3 个工具": "str_replace_editor, present deliverables, apply_patch · 3 tools",
    "终端与后台任务": "Terminal & background jobs",
    "持久 shell 会话（terminal_*）与后台任务（job_*） · 9 个工具": "Persistent shells (terminal_*) and background jobs (job_*) · 9 tools",
    "定时任务": "Scheduled jobs",
    "schedule_create / update / delete / list：按时间或 cron 触发一条提醒 · 4 个工具": "schedule_create / update / delete / list: fire a reminder by time or cron · 4 tools",
    "会话查询": "Session queries",
    "会话事件读取/搜索/追踪与工作目录切换 · 6 个工具": "Read / search / tail session events and switch the working directory · 6 tools",
    "具名 teammate 协作：roster、收件箱、共享任务板、预算、后台保活（十个工具） · 10 个工具": "Named teammate collaboration: roster, inbox, shared board, budget, keep-alive · 10 tools",
    "子代理控制": "Subagent control",
    "ralph / workflow / subagent_fork / list_subagent_models · 4 个工具": "ralph / workflow / subagent_fork / list_subagent_models · 4 tools",
    "兼容工具": "Compatibility tools",
    "lsp / mcp / stagehand / team / worktree / workspace-dependencies · 14 个工具": "lsp / mcp / stagehand / team / worktree / workspace-dependencies · 14 tools",
    "手机操控": "Phone control",
    "读屏 / 点击 / 滑动 / 输入 / 系统按键 / 打开应用 / Intent 唤起 · 27 个工具": "Screen reading / taps / swipes / input / system keys / app launch / intents · 27 tools",
    "自造插件": "Self-built plugins",
    "让 Agent 写插件清单、装配成工具、随时卸载 · 5 个工具": "Agent writes plugin manifests, assembles them into tools, unloads anytime · 5 tools",
    "跨会话的全局记忆与会话内记忆：写入、检索、修改、删除 · 6 个工具": "Global and per-session memory: write, search, edit, delete · 6 tools",
    "图像生成": "Image generation",
    "生成图片文件：外部图像 API（可选）+ 内置 SVG 海报/示意图 · 5 个工具": "Generate images: external image APIs (optional) + built-in SVG posters / diagrams · 5 tools",
    "聊天表情包：列举、发送、收藏（静图与 GIF 动图） · 5 个工具": "Chat stickers: list, send, collect (still images and GIFs) · 5 tools",
    "视频生成": "Video generation",
    "调用已配置的视频模型生成视频，成品进工作区并显示在对话里 · 1 个工具": "Generate videos with the configured video model; results land in the workspace and chat · 1 tool",
    "语音输出": "Voice output",
    "把文本朗读出来（默认系统 TTS，也可配云端语音模型） · 1 个工具": "Read text aloud (system TTS by default, or a configured cloud TTS model) · 1 tool",
    "系统提醒": "System notifications",
    "让 Agent 主动发系统通知（长任务完成、定时提醒、需要用户回来处理） · 1 个工具": "Let the agent post system notifications (long jobs done, scheduled reminders, needs you back) · 1 tool",
    "时间上下文": "Time context",
    "把设备当前日期时间注入系统提示，让「今天/明天/倒计时」有真实基准 · 纯能力插件": "Injects the device date & time into the system prompt so “today / tomorrow / countdown” have a real anchor · capability plugin",
    "到点主动搭话：有话说才开口，记住约定与情绪，免打扰时段静默；后台保活心跳不缺席 · 2 个工具": "Proactive chat: speaks only when it has something to say, remembers promises and moods, silent during quiet hours; keep-alive heartbeat never skips · 2 tools",
    "手机媒体": "Phone media",
    "读写系统相册与下载目录、从系统文件选择器导入（MediaStore / SAF，无需全局存储权限） · 4 个工具": "Read/write the system gallery and Downloads, import from the file picker (MediaStore / SAF, no broad storage permission) · 4 tools",
    "采集与分享": "Capture & share",
    "系统相机拍照、语音转写、把工作区文件分享到其它应用 · 3 个工具": "System camera capture, voice transcription, share workspace files to other apps · 3 tools",
    "系统时钟": "System clock",
    "在系统时钟 App 里创建闹钟与倒计时（系统意图，零运行时权限） · 2 个工具": "Create alarms and countdowns in the system Clock app (system intents, zero runtime permissions) · 2 tools",
    "手机状态": "Phone status",
    "电量、存储、网络状态与单次定位（device_info 零权限；定位需位置权限） · 2 个工具": "Battery, storage, network state and one-shot location (device_info needs no permission; locating needs location permission) · 2 tools",
    "日历与联系人": "Calendar & contacts",
    "系统日历查询/建日程、通讯录搜索（敏感：默认关闭，需在 presets.json overrides 手动启用） · 3 个工具": "Query the system calendar / create events, search contacts (sensitive: off by default, enable via presets.json overrides) · 3 tools",
    "装应用": "App installer",
    "把工作区里的 APK 交给系统安装器安装，并回传安装结果 · 1 个工具": "Hand a workspace APK to the system installer and report the result · 1 tool",
    "手机打包": "On-device packaging",
    "在手机上创建并编译 Android 工程（app_new 脚手架 + aapt2/d8/ecj/apksigner 打包） · 2 个工具": "Create and build Android projects on the phone (app_new scaffold + aapt2/d8/ecj/apksigner) · 2 tools",
    // 生成模型 / 权限
    "兼容接口": "Compatible API",
    "文件、网络与命令的边界": "Boundaries for files, network and commands",
    "只能读取文件与检索，不写入、不执行": "Read and search only — no writes, no execution",
    "可写工作区；删除与网络需逐次确认": "Workspace writable; deletions and network ask every time",
    "文件可超出工作区读写（仍受系统应用沙箱限制），不再逐条确认": "Files readable/writable beyond the workspace (still sandboxed by the OS), no more per-action prompts",
    // 智能体团队
    "拖动即生效 · 同时写入配置": "Drag to apply · saved to config",
    "并行上限": "Parallel limit", "最大递归深度": "Max recursion depth",
    "并行上限按设备与端点限流定，手机建议 2–4；它同时是同时执行的成员数与子智能体容量。递归深度只管子智能体：0 关闭子智能体，1（默认）只允许主 Agent 派，2 起子智能体可再派一层。队友不能再派 —— 桌面同规则：成员调 spawn 直接 TEAM_LEAD_REQUIRED。":
      "The parallel limit depends on device and endpoint throttling — 2–4 recommended on phones. It caps both teammates running at once and subagent capacity. Depth applies to subagents only: 0 disables them, 1 (default) lets only the lead spawn, 2+ lets a subagent spawn one level deeper. Teammates cannot spawn — same rule as desktop: a member calling spawn is rejected with TEAM_LEAD_REQUIRED.",
    // 团队面板（逐条对齐桌面 client-ui-agent-team 的 en 词典，桌面有的照抄，没有的按同一口径译）
    "共享任务": "Shared tasks",
    "暂无共享任务，可以通过对话创建": "No shared tasks yet. Create them through the conversation.",
    "成员": "Members",
    "可开始": "Ready",
    "被依赖阻塞": "Blocked by dependencies",
    "未分配": "Unowned",
    "展开": "Show more",
    "收起": "Show less",
    "写入范围": "Write scopes",
    "进行中": "In progress",
    "已完成": "Completed",
    "已删除": "Deleted",
    "等待唤醒": "Waiting to be woken",
    "进入会话": "Open conversation",
    "进入它的会话": "Open its conversation",
    "这个会话还没有团队。": "This chat has no team yet.",
    "这个会话还没有团队。<br/>让 Agent「建一个 reviewer 检查这次的改动」，<br/>队友会出现在这里，跑在后台，不占你的对话轮次。":
      "This chat has no team yet.<br/>Ask the agent to “spin up a reviewer for these changes” —<br/>teammates show up here, run in the background, and never take your turn.",
    "团队记录被拒绝：": "Rejected persisted team record: ",
    "这一轮没跑完：": "This turn did not finish: ",

    "创建已完成（对账通过），进程重启后转为 inactive": "Creation reconciled and completed; inactive after the process restart",
    // 用户提示词（角色设定）
    "用户提示词": "User prompt", "你写的角色设定，会拼进系统提示词一起发给模型":
      "Your persona, injected into the system prompt",
    "当前是默认人格，没有角色设定被注入。": "Default persona — nothing is injected.",
    "去「角色设定」选一个，或写一段自己的。": "Pick one under Persona, or write your own.",
    "去设置角色设定": "Set a persona",
    // 模型
    "新会话默认": "Default for new chats", "仅存本机": "Stored on this device only",
    // 用量
    "账号余额与本机用量": "Balance & on-device usage",
    "未登录且没有 API Key，无法查询余额": "Sign in or add an API key to check your balance",
    "登录 DeepSeek 账号或填入 API Key 后即可查询": "Available after signing in to DeepSeek or entering an API key",
    "登录 / 重新登录": "Sign in / re-sign in", "Token 消耗": "Token usage",
    "暂无记录": "No records yet", "少": "Less", "多": "More",
    "发一条消息后开始统计；只记 token 数，不记内容": "Tracking starts with your first message; token counts only, never content",
    // 运行通知
    "通知权限被关闭：退到桌面后看不到进度": "Notification permission is off: no progress in the shade after leaving",
    "通知权限": "Notification permission", "未授权": "Not granted",
    "通知渠道": "Notification channel", "首次运行时创建": "Created on first run",
    "空闲": "Idle", "什么时候会出现": "When it appears",
    "你在应用里时不打扰（运行态只在界面里显示）。退到桌面或切到别的应用后，通知栏出现进度，":
      "Silent while you're in the app (running state shows in the UI). After you leave for the home screen or another app, progress appears in the notification shade,",
    "Agent 跑在本应用进程里，退到桌面后要继续执行，需要：前台服务（会话开始即启动）+":
      "The agent runs inside this app's process. To keep running after you leave it needs: a foreground service (started when a session starts) +",
    "受系统限制": "Subject to system limits",
    "可单独开关「会话运行」这个渠道": "The “Session running” channel can be toggled separately",
    "不加入：切后台几分钟后系统会冻结应用": "If not whitelisted: the system freezes the app a few minutes after backgrounding",
    "应用启动管理 → 手动管理": "App launch management → manual control",
    "荣耀/华为：允许自启动、关联启动、后台活动": "Honor/Huawei: allow auto-launch, linked launch and background activity",
    // 语言
    "不改会话内容": "Chat content is not translated",
    // 角色设定
    "未启用，使用默认人格": "Off — default persona in use",
    "严谨、直接的通用助手": "Rigorous, direct general assistant",
    "SRE 工程师": "SRE engineer", "先评估影响面与回滚成本，再给动作": "Weighs impact and rollback cost before acting",
    "代码评审员": "Code reviewer", "先给结论，逐条列问题与改法": "Conclusion first, then issues and fixes item by item",
    "耐心导师": "Patient tutor", "一次只讲一层，配最小例子和练习": "One layer at a time with minimal examples and exercises",
    "轻": "Light", "只加一句定位，最小改动": "One framing line, minimal change",
    "标准": "Standard", "角色 + 输出格式 + 禁止项": "Role + output format + restrictions",
    "强": "Strong", "再加示例对话，小模型也能改口吻": "Adds example dialogue so even small models can shift tone",
    "清四件事，效果最稳：": "Cover four things for best results:",
    // 连接电脑
    "照抄电脑面板上的三项": "Copy the three fields from the desktop panel",
    "房间号": "Room ID", "中继口令": "Relay passphrase",
    "仅同一局域网 · 直连宿主机": "Same LAN only · direct to host",
    "同 WiFi · 端口 + token": "Same Wi-Fi · port + token",
    "宿主机地址": "Host address", "直连宿主机": "Direct to host",
    "电脑面板上的「房间号」": "Room ID from the desktop panel",
    "脑面板上的「房间号」": "Room ID from the desktop panel",
    "电脑面板上的「中继口令」": "Relay passphrase from the desktop panel",
    "脑面板上的「中继口令」": "Relay passphrase from the desktop panel",
    "电脑面板上的「中继地址」": "Relay address from the desktop panel",
    "脑面板上的「中继地址」": "Relay address from the desktop panel",
    "sh web 启动时输出的 URL 里的 token 参数": "The token param in the URL printed when sh web starts",
    "dsh web 启动时输出的 URL 里的 token 参数": "The token param in the URL printed when dsh web starts",
    // 二轮补漏
    "智能体团队": "Agent team", "新建会话": "New chat",
    "搜索文件名": "Search file names", "搜索文件": "Search files",
    "团队：还没有队友": "Team: no teammates yet",
    "API Key（可留空）": "API key (optional)",
    "在工作区内读取、写入、编辑、检索文件 · 12 个工具": "Read, write, edit and search files in the workspace · 12 tools",
    "例如：回复尽量简短，代码给完整文件": "e.g. keep replies short; always give complete files for code",
    "写清四件事，效果最稳：": "Cover four things for best results:",
    "写清四件事，效果最稳：\n1. 你是谁（角色 / 年限 / 领域）\n2. 怎么说话（句子长短、是否寒暄、称呼）\n3. 输出格式（先给结论还是先解释、要不要列条）\n4. 禁止项（不要夸奖、不要猜、不要大段代码…）":
      "Cover four things for best results:\n1. Who you are (role / years / domain)\n2. How it talks (sentence length, small talk, how to address you)\n3. Output format (conclusion first? bullet lists?)\n4. Restrictions (no flattery, no guessing, no huge code blocks…)",
    "你在应用里时不打扰（运行态只在界面里显示）。退到桌面或切到别的应用后，通知栏出现进度，可随时点「停止」；任务结束会补一条「已完成」，点开直接回到会话。需要你确认、或者模型有问题问你时，也会单独提醒一次。":
      "Silent while you're in the app (running state shows in the UI only). After you leave, progress appears in the notification shade — tap “Stop” anytime; a “Done” notification lands when the job finishes and takes you back to the chat. Confirmation requests and agent questions get a separate reminder.",
    "Agent 跑在本应用进程里，退到桌面后要继续执行，需要：前台服务（会话开始即启动）+电池优化白名单 + 厂商「应用启动管理」放行。":
      "The agent runs inside this app's process. To keep running after you leave it needs: a foreground service (started when a session starts) + the battery-optimization whitelist + the vendor's “app launch management” allowlist.",
    // 同键多译文的统一（一个中文串只留一个说法，按它实际渲染的位置选）：
    // 模型=settings 分组标题、附件=文件页签、新建任务=任务页 sheet 标题（「任务」= Tasks）
    "计划": "Plan", "模型": "Models", "连接电脑": "Connect computer", "原生通透面板": "Native glass panel",
    "新建任务": "New task", "附件": "Attachments", "会话记忆": "Chat memory", "创建失败：": "Create failed: ",
  };
  /* 动态组合文案的正则翻译（数字/模型名等运行期拼进来的部分） */
  const I18N_RX = [
    [/^最近 (\d+) 条$/, "Last $1"],
    [/^最近 (\d+) 周$/, "Last $1 weeks"],
    [/^共 (\d+) 条$/, "$1 in total"],
    [/^(\d+) 条$/, "$1 entries"],
    [/^(\d+)\/(\d+) 已授权$/, "$1/$2 granted"],
    [/^(\d+)\/(\d+) 已启用$/, "$1/$2 enabled"],
    [/^(\d+)\/(\d+) 次$/, "$1/$2 used"],
    [/^自动 · (\d+)%$/, "Auto · $1%"],
    [/^本地 · (.+)$/, "Local · $1"],
    [/^团队：(.+)$/, "Team: $1"],
    [/^图片 (.+?) · 视频 (.+)$/, "Images $1 · Videos $2"],
    [/^(\d+) 并行 · 深度 (\d+)$/, "$1 parallel · depth $2"],
    // 团队面板的组合行（一条文本节点里带着数值的，都在这儿翻）
    [/^Owner: (.+)$/, "Owner: $1"],
    [/^依赖: (.+)$/, "Blocked by: $1"],
    [/^写入范围: (.+)$/, "Write scopes: $1"],
    [/^(\d+) 人在跑 · 并行上限 (\S+)$/, "$1 running · parallel limit $2"],
    [/^并行上限 (\S+)$/, "Parallel limit $1"],
    [/^写范围与 (.+?) 重叠，仅提示不拦写入$/, "Write scopes overlap with $1 (advisory, no block)"],
    [/^(\d+) 轮 · (\d+) 次工具 · (.+)$/, "$1 turns · $2 tool calls · $3"],
    [/^(\d+) 轮 · (\d+) 次工具$/, "$1 turns · $2 tool calls"],
    [/^(\d+) 轮$/, "$1 turns"],
    [/^(\d+) 次工具$/, "$1 tool calls"],
    [/^(\d+) 个$/, "$1"],
    [/^(\d+) 层$/, "$1 levels"],
    [/^(.+?) · (\d+) 档$/, "$1 · $2 levels"],
    // 设置页存储一行：JS 写出去的是「1.98 GB 可用[ · 溢出缓存 12 MB]」
    [/^(.+?) 可用 · 溢出缓存 (.+)$/, "$1 free · overflow cache $2"],
    [/^(.+?) 可用$/, "$1 free"],
  ];
  function i18nMatch(key) {
    if (I18N[key]) return I18N[key];
    // 模板换行缩进会把长段落拆出内部空白：去空白后比对
    const norm = key.replace(/\s+/g, "");
    if (I18N_NORM[norm]) return I18N_NORM[norm];
    for (const [re, rep] of I18N_RX) {
      if (re.test(key)) return key.replace(re, rep);
    }
    return null;
  }

  const I18N_NORM = {};
  for (const k in I18N) {
    const n = k.replace(/\s+/g, "");
    if (!(n in I18N_NORM)) I18N_NORM[n] = I18N[k];
  }

  const LANGS = [
    { id: "zh", name: "简体中文" },
    { id: "en", name: "English" },
    { id: "system", name: "跟随系统" },
  ];
  const textStore = new WeakMap();
  const attrStore = new WeakMap();
  const EN = () => state.lang === "en" || (state.lang === "system" && !(navigator.language || "zh").toLowerCase().startsWith("zh"));

  /** 翻译一个文本节点。缓存里记三样：`o` 原文、`t` 译文（null=查过了但没词条）、
   *  `w` 上次真正写出去的值 —— 有它才能分清「节点里现在是原文、译文、还是 JS 新写的文案」。 */
  function translateTextNode(node, en) {
    const cur = node.nodeValue;
    let rec = textStore.get(node);
    // 既不是原文也不是我们写出去的值 → JS 刚写进来的新文案，换一份原文重新查
    if (!rec || (cur !== rec.o && cur !== rec.w)) rec = { o: cur, t: undefined, w: undefined };
    textStore.set(node, rec);
    if (!en) {
      if (cur !== rec.o) node.nodeValue = rec.o;
      rec.w = rec.o;
      return;
    }
    // 查表只做一次：同一次渲染里这份文案不会再变，重复 applyLang 不该再跑一遍正则
    if (rec.t === undefined) rec.t = i18nMatch(rec.o.trim()) || null;
    const out = rec.t || rec.o;
    if (cur !== out) node.nodeValue = out;
    rec.w = out;
  }

  /** 翻译一个元素上的可见属性。缓存里同时记「原始值」和「上次写出的值」：
   *  当前值 ≠ 上次写出值说明是 JS 新写入的中文，更新原始值再翻。 */
  function translateAttributes(el, en) {
    ["placeholder", "aria-label", "title"].forEach((attr) => {
      if (!el.hasAttribute || !el.hasAttribute(attr)) return;
      const cur = el.getAttribute(attr);
      const map = attrStore.get(el) || {};
      let orig = map[attr];
      if (orig === undefined || (map[attr + "!"] !== undefined && cur !== map[attr + "!"])) {
        orig = cur;
        map[attr] = cur;
      }
      const hit = en ? i18nMatch(orig.trim()) : null;
      const out = hit ?? orig;
      map[attr + "!"] = out;
      attrStore.set(el, map);
      if (cur !== out) el.setAttribute(attr, out);
    });
  }

  /**
   * 递归翻译一棵子树。动态渲染的界面（对话流、面板、列表）都走这里，
   * 否则切换语言后只有首屏那几个静态标签变，其它地方还是中文。
   */
  function applyLangTo(root) {
    if (!root) return;
    const en = EN();
    if (root.nodeType === 3) { translateTextNode(root, en); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) {
      if (/^(SCRIPT|STYLE|svg)$/i.test(root.nodeName)) return;
      translateAttributes(root, en);
    }
    // 对话原文、代码块永远不翻译：那是用户和模型的内容，不是界面文案
    const SKIP = /^(SCRIPT|STYLE|svg)$/i;
    const SKIP_CLASS = /(^|\s)(assistant-text|user-text|bubble-user|md|md-img|df)(\s|$)/;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: (n) => {
        if (n.nodeType === 1) {
          if (SKIP.test(n.nodeName)) return NodeFilter.FILTER_REJECT;
          if (n.classList && SKIP_CLASS.test(n.className)) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      if (node.nodeType === 3) translateTextNode(node, en);
      else translateAttributes(node, en);
    });
  }

  /** 上次真正应用过的语言：go() 每次切页都会调 applyLang，蓝层不该跟着重建 */
  let langApplied = null;
  function applyLang() {
    const en = EN();
    const key = en ? "en" : "zh";
    const lang = en ? "en" : "zh-CN";
    if (document.documentElement.lang !== lang) document.documentElement.lang = lang;
    // 中文模式没有可翻译的文案：首次、以及「从英文切回来」需要整树还原，
    // 其余情况整棵树扫一遍是纯空转（每次切页 / 每次列表重绘都会调到这里）。
    // 英文模式仍整树扫，但每个节点的查表结果已缓存（见 translateTextNode），重复扫不再跑正则。
    if (en || langApplied !== key) applyLangTo(document.body);
    const lv = $("#langValue");
    if (lv) lv.textContent = LANGS.find((l) => l.id === state.lang)?.name || "跟随系统";
    syncNativeLang();
    // 底部导航的蓝色克隆层是 DOM 快照：语言一变，蓝层还是旧语言的字符。
    // 只在语言真的换了时重建（宽度也变了，覆盖裁剪要按新矩形重算）。
    if (langApplied !== key) {
      langApplied = key;
      try { TabHighlight.build(); TabHighlight.follow(320); } catch (_) {}
    }
  }

  /* 新插入的 DOM 也要跟着当前语言走：批量去抖，避免流式输出时每个 token 都全量扫一遍 */
  const langPending = new Set();
  let langFlush = 0;
  const langObserver = new MutationObserver((records) => {
    if (!EN()) return;
    for (const rec of records) {
      if (rec.type === "attributes") {
        if (rec.target.nodeType === 1) langPending.add(rec.target);
        continue;
      }
      if (rec.type === "characterData") {
        const el = rec.target.parentElement;
        if (el && !(el.closest && el.closest(".assistant-text,.user-text,.bubble-user,.md,pre,code"))) langPending.add(rec.target);
        continue;
      }
      rec.addedNodes.forEach((n) => {
        if (n.nodeType !== 1 && n.nodeType !== 3) return;
        const el = n.nodeType === 1 ? n : n.parentElement;
        if (el && el.closest && el.closest(".assistant-text,.user-text,.bubble-user,.md,pre,code")) return;
        langPending.add(n);
      });
    }
    if (!langPending.size || langFlush) return;
    langFlush = setTimeout(() => {
      langFlush = 0;
      const batch = [...langPending];
      langPending.clear();
      batch.forEach((n) => { if (n.isConnected) applyLangTo(n); });
    }, 120);
  });

  /* 让原生侧（权限弹窗、语音识别等系统 UI）跟随 App 内语言 */
  let lastNativeLang = "";
  function syncNativeLang() {
    if (!Native || !Native.setLanguage) return;
    const tag = state.lang || "zh";
    if (tag === lastNativeLang) return;
    lastNativeLang = tag;
    try { Native.setLanguage(tag); } catch (_) {}
  }

  /* ---------------- state ---------------- */
  /**
   * 思考档位的取值是「上游认的标识」，不是中文标签：
   * 配置里存 off / minimal / low / medium / high / xhigh / max，
   * 中文模式下只做显示映射，发给上游的永远是英文标识本身。
   */
  // "on" 是给「只有开/关、没有强度档位」的模型准备的：
  // 这类端点只认 thinking:{type:"enabled"} / {type:"disabled"}，不支持 reasoning_effort。
  const EFFORT_TOKENS = ["off", "on", "minimal", "low", "medium", "high", "xhigh", "max"];
  const EFFORT_ZH = {
    off: "关", on: "开", minimal: "极简", low: "低", medium: "中",
    high: "高", xhigh: "很高", max: "最高",
  };
  /** 历史配置里出现过中文档位，读盘时按语义折回标识（不猜顺序，只做词义映射） */
  const EFFORT_ALIAS = {
    关: "off", 关闭: "off", 无: "off", off: "off",
    开: "on", 开启: "on", 打开: "on", 启用: "on", on: "on", enabled: "on", disabled: "off",
    极速: "minimal", 最低: "minimal", 极简: "minimal", minimal: "minimal",
    低: "low", 少: "low", low: "low",
    中: "medium", 均衡: "medium", 标准: "medium", medium: "medium",
    高: "high", 深入: "high", 长思考: "high", high: "high",
    很高: "xhigh", 极高: "xhigh", xhigh: "xhigh",
    最高: "max", 极致: "max", 最大: "max", max: "max",
  };
  const effortToken = (v) => {
    const raw = String(v == null ? "" : v).trim();
    if (!raw) return "";
    const low = raw.toLowerCase();
    if (EFFORT_TOKENS.includes(low)) return low;
    return EFFORT_ALIAS[raw] || EFFORT_ALIAS[low] || low;
  };
  const normalizeEfforts = (list) => {
    const out = [];
    (Array.isArray(list) ? list : String(list || "").split(/[,，、\s]+/))
      .forEach((x) => {
        const t = effortToken(x);
        if (t && !out.includes(t)) out.push(t);
      });
    return out;
  };
  /** 显示名：英文模式直接给标识，中文模式给映射后的中文档位 */
  const effortLabel = (tok) => {
    const t = effortToken(tok);
    if (!t) return "";
    return EN() ? t : (EFFORT_ZH[t] || t);
  };
  const DEFAULT_EFFORTS = ["off", "low", "medium", "high", "max"];

  const BUILTIN_MODELS = [
    // 档位对齐桌面 llm-deepseek/model-info.ts 与官方文档：off 关思考，low/high/max 三档有效思考强度
    // （官方兼容映射：minimal→low、medium/xhigh→high、ultra→max，所以不给 medium 留独立档位）
    { id: "DeepSeek-V4.1-Flash", name: "V4.1-Flash", desc: "低延迟 · 日常对话", builtin: true, upstream: "deepseek-chat", efforts: ["off", "low", "high", "max"] },
    { id: "DeepSeek-V4.1-Pro", name: "V4.1-Pro", desc: "更强推理 · 复杂任务", builtin: true, upstream: "deepseek-chat", efforts: ["off", "low", "high", "max"] },
    { id: "DeepSeek-R1", name: "R1", desc: "长思考链 · 数学与算法", builtin: true, upstream: "deepseek-reasoner", efforts: ["off", "low", "high", "max"] },
  ];

  const EFFORT_META = {
    off: { zh: "关闭思考，直接给出首答。", en: "No reasoning, answer straight away.", est: "约 1 秒内" },
    on: { zh: "开启思考（thinking: enabled）", en: "Reasoning on (thinking: enabled). For models that only toggle, without effort levels.", est: "由模型决定" },
    minimal: { zh: "几乎不思考，适合格式转换、取数、简单改写。", en: "Barely reasons; good for format conversion and lookups.", est: "预计 1–3 秒" },
    low: { zh: "最低推理预算，先给结论再补充。", en: "Smallest budget; conclusion first.", est: "预计 1–3 秒" },
    medium: { zh: "均衡的推理预算，适合大部分日常问答。", en: "Balanced budget for everyday questions.", est: "预计 3–8 秒" },
    high: { zh: "较高推理预算，多步推理并校验关键步骤。", en: "Higher budget; multi-step with self-checks.", est: "预计 8–20 秒" },
    xhigh: { zh: "很高推理预算，适合调试、重构与方案对比。", en: "Very high budget for debugging and refactors.", est: "预计 15–30 秒" },
    max: { zh: "最大推理预算，反复验证。适合疑难 bug 与架构决策。", en: "Maximum budget with repeated verification.", est: "预计 20–45 秒" },
  };

  function normalizeModel(m) {
    const efforts = Array.isArray(m.efforts) ? normalizeEfforts(m.efforts) : DEFAULT_EFFORTS.slice();
    return {
      ...m,
      builtin: !!m.builtin,
      efforts,
      // 本地标识 -> 上游 model 参数；未填则同名
      upstream: m.upstream || m.id,
    };
  }

  // 模型与它支持的档位一起持久化；旧数据（只有自定义模型）会自动合并内置模型
  function seedModels() {
    try {
      const raw = JSON.parse(localStorage.getItem("dsh.models") || "null");
      if (Array.isArray(raw) && raw.length) {
        const byId = new Map(raw.map((m) => [m.id, m]));
        const merged = BUILTIN_MODELS.map((b) => normalizeModel({ ...b, ...(byId.get(b.id) || {}), builtin: true }));
        raw.forEach((m) => {
          if (!merged.some((x) => x.id === m.id)) merged.push(normalizeModel(m));
        });
        return merged;
      }
    } catch (_) {}
    return BUILTIN_MODELS.map(normalizeModel);
  }

  const state = {
    screen: "sessions",
    sessionId: "s1",
    /** 团队快照：内核在 roster/任务变化时推送，面板与顶栏徽标都读它 */
    team: null,
    /** 成员会话视图：非空表示正在看某个 teammate 的会话（{parent, name, session, seen}） */
    teamView: null,
    /** 进成员视图时被「让到后台」的 Lead 回合（{id, sid}）：退出时按内核快照接回来 */
    bgRun: null,
    // 当前正在看的是电脑上的会话（中继）：消息走 Link，界面仍是同一个聊天页
    pcSession: null,
    model: localStorage.getItem("dsh.model") || "DeepSeek-V4.1-Flash",
    models: seedModels(),
    effortByModel: (() => {
      try { return JSON.parse(localStorage.getItem("dsh.effortByModel") || "{}"); } catch (_) { return {}; }
    })(),
    editingModelId: null,
    queue: [],                 // 发送队列：本轮进行中用户继续发的消息
    // 下限硬约束（这里写死数字：CONTEXT_OPTIONS 在文件更后面才声明，初始化时不能引用）
    // 旧数据里存着 32k/8k 这类小档位，启动时直接抬到 128k / 64k。
    context: (() => {
      const v = localStorage.getItem("dsh.context") || "128k";
      return (parseFloat(v) * 1024 || 0) >= 128 * 1024 ? v : "128k";
    })(),
    maxOut: (() => {
      const v = localStorage.getItem("dsh.maxOut") || "64k";
      return (parseFloat(v) * 1024 || 0) >= 64 * 1024 ? v : "64k";
    })(),
    compactMode: localStorage.getItem("dsh.compactMode") || (localStorage.getItem("dsh.compact") === "0" ? "off" : "auto"),
    sessMem: localStorage.getItem("dsh.sessMem") !== "0",
    globalMem: localStorage.getItem("dsh.globalMem") !== "0",
    memEdit: null,
    persona: localStorage.getItem("dsh.persona") || "",
    personaStrength: localStorage.getItem("dsh.personaStrength") || "normal",
    perm: localStorage.getItem("dsh.perm") || "default",
    account: (() => {
      try { return JSON.parse(localStorage.getItem("dsh.account") || "null"); } catch (_) { return null; }
    })(),
    lang: localStorage.getItem("dsh.lang") || "zh",
    theme: localStorage.getItem("dsh.theme") || "light",
    host: localStorage.getItem("dsh.host") || "",
    mode: localStorage.getItem("dsh.mode") || (localStorage.getItem("dsh.host") ? "host" : "local"),
    // Agent 预设（新任务默认）：standard | ptc | minimal | cordis，对应桌面「Agent 预设」
    preset: localStorage.getItem("dsh.preset") || "standard",
    launchToken: localStorage.getItem("dsh.launchToken") || "",
    busy: false,
    nativeInfo: null,
    attachments: [],
    showChips: localStorage.getItem("dsh.quickChips") !== "0",
    workspace: localStorage.getItem("dsh.workspace") || "harness",
    askDanger: localStorage.getItem("dsh.askDanger") !== "0",
    notifyDone: localStorage.getItem("dsh.notifyDone") !== "0",
    // 灵动岛几何（设置页滑块）：dx=水平偏移 / w=长度 / pad=上下留白（-1=按孔径自动）
    islandTune: (() => {
      try { return JSON.parse(localStorage.getItem("dsh.islandTune") || "{}") || {}; }
      catch (_) { return {}; }
    })(),
    fileTab: "out",
    fileCwd: ".",
    jobsTab: "all",
    selecting: false,
    goalRoundsSel: 0,
  };

  try { state.nativeInfo = Native && Native.getDeviceInfo ? JSON.parse(Native.getDeviceInfo()) : null; } catch (_) {}

  /* ---------------- 内置模式：计划 / 目标 ----------------
     桌面 Harness 里 plan-mode 是「逐 agent 的日志状态 + 部署引导 + exit_plan_mode 工具」，
     goal 是「同会话目标 + 多轮续跑」。手机端没有多窗口与评审弹窗，这里做等价的客户端转化：
     - 计划模式：锁住写类工具（真限制，不只靠提示词），用 exit_plan_mode 卡片在对话流里评审
     - 目标模式：一个目标跨多轮推进，轮数有上限，模型用 update_goal 结束/阻塞
     模式按会话隔离，存在 localStorage，重开应用仍然有效。 */
  const READONLY_TOOLS = ["read", "list_dir", "glob", "grep", "stat"];
  // 目标轮数：0 = 智能（跑到目标完成/受阻），>0 = 用户指定上限；智能模式仍有安全上限，防止失控
  const GOAL_SMART_CAP = 40;
  const goalCap = (g) => (g && Number(g.maxRounds) > 0 ? Number(g.maxRounds) : 0);
  const goalRoundLabel = (g, round) => {
    const cap = goalCap(g);
    return cap ? `第 ${round}/${cap} 轮` : `第 ${round} 轮 · 智能`;
  };

  /* ---------------- Agent 预设（四个内置模式） ----------------
     权威来源：桌面 packages/bundle/web-app/presets/{standard,ptc,minimal,cordis}.patch.yml
     desc 是面板里的一句话说明，刻意压短（原来的整段官方描述在手机上太占地方）；
     注意它只用于界面展示，绝不进 systemPrompt —— 提示词在 systemPrompt() 里单独维护。
     桌面用 preset 决定挂载哪些子插件；手机端等价做法是内核全量装配 +
     preset 工具白名单（在原生 AgentConfig/Presets.kt 里过滤模型可见目录）。
     顺序即桌面 order 字段；standard 是新任务默认。 */
  const PRESETS = [
    { id: "standard", name: "标准模式", badge: "新任务默认",
      desc: "处理代码、文件与资料" },
    { id: "ptc", name: "PTC 模式", badge: "内置",
      desc: "批量调用工具并整理结果" },
    { id: "minimal", name: "极简模式", badge: "内置",
      desc: "终端 + 图片读取，带压缩" },
    { id: "cordis", name: "创造模式", badge: "内置",
      desc: "让 Agent 写插件、加功能" },
  ];
  const presetOf = (id) => PRESETS.find((p) => p.id === id) || PRESETS[0];

  const Modes = {
    KEY: "dsh.modes",
    all() { try { return JSON.parse(localStorage.getItem(this.KEY) || "{}"); } catch (_) { return {}; } },
    key() {
      // "s1" 只是页面的初始占位 id，还没落库；模式和草稿一样挂到 __draft
      return (state.sessionId && state.sessionId !== "s1") ? state.sessionId : "__draft";
    },
    snap(sid) {
      const v = this.all()[sid || this.key()] || {};
      return { preset: v.preset || state.preset || "standard", plan: !!v.plan, planApproved: !!v.planApproved, goal: v.goal || null };
    },
    patch(p, sid) {
      const all = this.all();
      const k = sid || this.key();
      all[k] = { ...this.snap(k), ...p };
      localStorage.setItem(this.KEY, JSON.stringify(all));
      syncModeBar();
      return all[k];
    },
    /** 新会话首条消息落库时，把草稿上的模式迁移到真实 id */
    adopt(id) {
      if (!id) return;
      const all = this.all();
      if (!all.__draft) return;
      all[id] = all.__draft;
      delete all.__draft;
      localStorage.setItem(this.KEY, JSON.stringify(all));
    },
    cur() { return this.snap(); },
    planLocked() { const s = this.cur(); return s.plan && !s.planApproved; },
    /** 计划模式下写类工具直接拒绝（模型就算硬调也改不了文件） */
    blocks(name) {
      if (!this.planLocked()) return false;
      if (READONLY_TOOLS.includes(name)) return false;
      return !["exit_plan_mode", "update_goal", "subagent"].includes(name);
    },
    setPlan(on) {
      this.patch({ plan: !!on, planApproved: false });
      return this.cur();
    },
    approvePlan() { this.patch({ plan: false, planApproved: true }); },
    goal() { return this.cur().goal; },
    goalActive() { const g = this.cur().goal; return !!(g && g.phase === "active"); },
    setGoal(g) { this.patch({ goal: g }); return g; },
    clearGoal() { this.patch({ goal: null }); },
  };

  const allModels = () => state.models;
  const findModel = (id) => state.models.find((m) => m.id === id) || state.models[0];
  const modelLabel = (id = state.model) => findModel(id).name;
  const persistModels = () => localStorage.setItem("dsh.models", JSON.stringify(state.models));
  const hostOf = (url) => {
    try { return new URL(url).host; } catch (_) { return url || ""; }
  };

  const effortsOf = (id = state.model) => (findModel(id).efforts || []);

  function effortIndex(id = state.model) {
    const names = effortsOf(id);
    const n = names.length;
    if (!n) return -1;
    const saved = Number(state.effortByModel[id]);
    if (Number.isInteger(saved) && saved >= 0 && saved < n) return saved;
    // 默认档位对齐桌面 defaultEffort=high：声明里有 high 就用它，否则取中位
    const hi = names.indexOf("high");
    return hi >= 0 ? hi : Math.min(n - 1, Math.floor((n - 1) / 2));
  }

  function effortLevel(id = state.model) {
    const names = effortsOf(id);
    const index = effortIndex(id);
    if (index < 0) return null;
    const name = names[index];
    const meta = EFFORT_META[name] || { zh: "由模型配置决定的档位。", en: "Level defined by this model.", est: "" };
    return {
      name,
      label: effortLabel(name),
      desc: EN() ? meta.en : meta.zh,
      est: meta.est,
      budget: Math.max(1, Math.round(((index + 1) / names.length) * 4)),
      index,
      total: names.length,
    };
  }

  /** 发给上游的档位字段：对齐官方 Thinking Mode 文档 ——
   *  off 不能「不发」：官方端点默认思考开启，必须显式 thinking:{type:"disabled"} 才关得掉；
   *  其余档位走 OpenAI 格式 reasoning_effort（账号端点由 MessagesApi 转成 output_config.effort） */
  function effortField() {
    const lv = effortLevel();
    if (!lv || !lv.name) return {};                    // 模型没声明档位：不动，走端点默认
    // 开关型模型：只有 enabled / disabled 两种，不发 reasoning_effort
    if (lv.name === "off") return { thinking: { type: "disabled" } };
    if (lv.name === "on") return { thinking: { type: "enabled" } };
    // 其余档位仍走 reasoning_effort（不少 OpenAI 兼容端点不认 thinking 字段，
    // 官方 Messages 端点由 MessagesApi 自行补 thinking:enabled + output_config.effort）
    return { reasoning_effort: lv.name };
  }

  function setEffortIndex(index) {
    state.effortByModel[state.model] = index;
    localStorage.setItem("dsh.effortByModel", JSON.stringify(state.effortByModel));
  }

  function syncEffortChip() {
    const lv = effortLevel();
    const chip = $('[data-sheet="effort"]');
    if (!lv) {
      if (chip) chip.style.display = "none";
      return;
    }
    if (chip) chip.style.display = "";
  }

  function applyQuickChips() {
    const el = $(".composer-scroll");
    if (el) el.style.display = state.showChips ? "flex" : "none";
  }

  function syncContextChips() {
    const cv = $("#ctxValue"); if (cv) cv.textContent = state.context;
    const ov = $("#outValue"); if (ov) ov.textContent = state.maxOut;
    const comp = $("#compValue"); if (comp) comp.textContent = compactLabel();
  }

  function syncPermUI() {
    const p = PERMS.find((x) => x.id === state.perm) || PERMS[1];
    // 权限模式与「权限」（系统运行时授权）是两件事，之前共用 #permValue 互相覆盖
    const pv = $("#permModeValue"); if (pv) pv.textContent = p.name;
    // 完全访问 = 桌面 permission-presets 的 sandbox + approval 两个旋钮一起变（approval: never）。
    // 「危险操作前询问」在这一档不生效，置灰并说明 —— 别让开关承诺一件做不到的事。
    const askSw = $("#swAskDanger");
    if (askSw) {
      const full = state.perm === "full";
      askSw.disabled = full;
      const row = askSw.closest(".row");
      if (row) {
        row.style.opacity = full ? ".55" : "";
        row.title = full ? "完全访问下不再逐条询问；切回标准权限后恢复" : "";
      }
    }
    // 热更新：轮次还在跑时立刻通知内核改档位（完全访问立即生效，不等下一轮）。
    // 此前权限只在轮次启动的 payload 里带一次，改设置对正在跑的轮次毫无作用。
    try {
      if (NativeAgent && NativeAgent.active && Live.id && Native && Native.agentPermission) {
        Native.agentPermission(Live.id, state.perm);
      }
    } catch (_) {}
  }

  /* ---------------- 灵动岛几何（设置页滑块） ---------------- */

  /** 读当前值并规整：坏值一律回默认，别让原生收到 NaN 把岛弄没 */
  function islandTuneValue() {
    const t = state.islandTune || {};
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    return {
      dx: Math.round(num(t.dx, 0)),
      // dy 曾经漏在这里：滑块在面板里、原生也认 dy，但值从来没被推过去，
      // 于是「拖垂直位置没有任何反应」。加字段时**必须同时**加进这个返回值。
      dy: Math.round(num(t.dy, 0)),
      w: Math.round(num(t.w, 0)),
      pad: Math.round(num(t.pad, -1)),
    };
  }

  /** 应用并持久化：立刻推原生重建，拖滑块就能在屏幕顶部看到变化 */
  function pushIslandTune() {
    const v = islandTuneValue();
    state.islandTune = v;
    localStorage.setItem("dsh.islandTune", JSON.stringify(v));
    let r = null;
    try {
      if (Native && Native.islandTune) {
        r = JSON.parse(Native.islandTune(JSON.stringify(v)) || "{}");
      }
    } catch (_) {}
    syncIslandValue();
    return r;
  }

  /** 设置页那一行的摘要：改没改一眼看得出 */
  function syncIslandValue() {
    const el = $("#islandValue");
    if (!el) return;
    const v = islandTuneValue();
    const bits = [];
    if (v.dx) bits.push((v.dx > 0 ? "右 " : "左 ") + Math.abs(v.dx) + "px");
    if (v.dy) bits.push((v.dy > 0 ? "下 " : "上 ") + Math.abs(v.dy) + "px");
    if (v.w) bits.push(v.w + "px");
    if (v.pad >= 0) bits.push("留白 " + v.pad + "px");
    el.textContent = bits.length ? bits.join(" · ") : "默认";
  }

  /**
   * 切换权限档 —— **唯一入口**（设置面板 / 快捷条 / 确认页都走它）。
   *
   * 以前 [data-perm] 和 [data-quick-perm] 各写一遍「选完全访问要先弹确认」
   * 与 localStorage 写入：两处判断早晚会分叉（一处忘了热更新就是两套行为）。
   * @return true = 已切换；false = 没切（同档，或弹了确认页等用户点）
   */
  function applyPermission(id, origin) {
    if (!PERMS.some((x) => x.id === id)) return false;
    if (id === state.perm) return false;
    if (id === "full") {
      state.permOrigin = origin || "settings";
      openSheet(sheetConfirmFull());   // 危险档位必须二次确认
      haptic("heavy");
      return false;
    }
    state.perm = id;
    localStorage.setItem("dsh.perm", state.perm);
    syncPermUI();       // 内含运行中轮次的热更新
    haptic("medium");
    return true;
  }

  /** 输入框上方的模式条：谁在生效一眼可见，点一下可退出/调整 */
  function syncModeBar() {    const bar = $("#modeBar");
    if (!bar) return;
    const m = Modes.cur();
    const g = m.goal;
    const bits = [];
    // 对话内搜索进行中：计数 + 上一处 / 退出（下一处就是输入框右侧的发送键）
    if (SearchMode.on) {
      const n = ChatExtras.hits.length;
      const i = ChatExtras.hitIndex;
      bits.push(`<span class="mode-chip search" aria-live="polite">
        <svg class="ico xs"><use href="#i-search"/></svg>
        <span class="mc-text">${n ? `${i + 1}/${n}` : "输入关键词"}</span>
        <button class="mc-btn" data-search-prev aria-label="上一处">
          <svg class="ico xs flip-v"><use href="#i-chevron-down"/></svg>
        </button>
        <button class="mc-btn" data-search-close aria-label="退出搜索">
          <svg class="ico xs"><use href="#i-x"/></svg>
        </button>
      </span>`);
    }
    // Agent 预设：非默认时亮出来（标准模式不占位，等价桌面「在任务开始时确定」的隐性状态）
    // 搜索接管输入框期间不渲染这些签 —— 搜索是专注模式，modeBar 整条让给搜索签，
    // 避免「上一处 / 退出」和预设 / 计划 / 目标签挤在同一行（用户实测点名的避让问题）。
    if (!SearchMode.on && m.preset && m.preset !== "standard") {
      const p = presetOf(m.preset);
      bits.push(`<button class="mode-chip preset" data-mode-chip="preset" aria-label="${esc(p.name)}">
        <svg class="ico xs"><use href="#i-cpu"/></svg><span class="mc-text">${esc(p.name)}</span><i class="mode-dot"></i>
      </button>`);
    }
    if (!SearchMode.on && m.plan && !m.planApproved) {
      bits.push(`<button class="mode-chip plan" data-mode-chip="plan" aria-label="计划模式">
        <svg class="ico xs"><use href="#i-plan"/></svg><span>计划模式</span><i class="mode-dot"></i>
      </button>`);
    }
    if (!SearchMode.on && g) {
      const phase = g.phase === "active"
        ? goalRoundLabel(g, (g.rounds || 0) + 1)
        : g.phase === "complete" ? "已达成" : g.phase === "blocked" ? "受阻" : "已暂停";
      bits.push(`<button class="mode-chip goal is-${g.phase}" data-mode-chip="goal" aria-label="目标模式">
        <svg class="ico xs"><use href="#i-goal"/></svg>
        <span class="mc-text">${esc(pageClip(g.objective, 16))}</span><em>${phase}</em>
      </button>`);
    }
    bar.innerHTML = bits.join("");
  }

  function setModel(id) {
    state.model = id;
    localStorage.setItem("dsh.model", id);
    const label = modelLabel(id);
    const mv = $("#modelValue"); if (mv) mv.textContent = label;
    renderEffort();
    syncChatSub();
    // 换了模型（或换了 Key）：原生引擎手里的端点必须同步，否则后台还在用旧模型说话
    try { Companion.pushContextSoon(); } catch (_) {}
  }

  // 对话页副标题永远反映真实状态，避免出现写死的「运行中」
  function syncChatSub() {
    const sub = $("#chatSub");
    if (!sub) return;
    const where = currentMode() === "host" ? "宿主机" : "本地";
    sub.textContent = `${where} · ${modelLabel()}`;
  }

  /* ---------------- 真实数据：宿主机连接与会话 ---------------- */
  // 会话列表完全来自宿主机（dsh web）。未连接时为空，不使用任何演示数据。
  state.sessions = [];

  const Host = {
    seq: 0,
    pending: new Map(),
    request(method, url, body) {
      return new Promise((resolve) => {
        const id = "h" + (++this.seq);
        if (Native && Native.httpJson) {
          this.pending.set(id, resolve);
          Native.httpJson(id, method, url, body || "");
        } else {
          fetch(url, {
            method,
            credentials: "include",
            ...(body ? { headers: { "content-type": "application/json" }, body } : {}),
          }).then(async (r) => {
            resolve({ ok: r.ok, status: r.status, body: await r.text() });
          }).catch((e) => {
            resolve({ ok: false, status: 0, body: "", error: String(e && e.message || e) });
          });
        }
      });
    },
    onHttp(id, payload) {
      const resolve = this.pending.get(id);
      if (!resolve) return;
      this.pending.delete(id);
      let data = null;
      try { data = JSON.parse(payload); } catch (_) {}
      resolve(data || { ok: false, error: "empty response" });
    },
    async connect(launchToken) {
      const base = (state.host || "").replace(/\/+$/, "");
      const url = `${base}/connect?token=${encodeURIComponent(launchToken)}`;
      const res = await this.request("GET", url);
      if (!res.ok) throw new Error(res.error || `HTTP ${res.status}`);
      return true;
    },
    // 旧中继的 rt 口令已经随 `relay/` 一起删了：宿主机直连只带 launchToken，
    // 不再需要「把口令塞进查询参数」这一层（原生 HTTP 桥传不了自定义头才有的权宜）
    async call(endpoint, payload) {
      const base = (state.host || "").replace(/\/+$/, "");
      const body = JSON.stringify({
        type: "client-request",
        rpcId: "r" + Date.now() + Math.random().toString(16).slice(2),
        method: endpoint,
        payload: payload ?? {},
      });
      const res = await this.request("POST", `${base}/api/${endpoint}`, body);
      if (!res.ok) throw new Error(res.error || `HTTP ${res.status}`);
      let full = null;
      try { full = JSON.parse(res.body); } catch (_) { throw new Error("响应不是 JSON"); }
      if (full.error || full.result?.error) {
        throw new Error(full.error || full.result?.error?.message || "RPC 错误");
      }
      return full.result;
    },
  };
  /* =========================================================
     本地独立引擎：不依赖宿主机，直接调 OpenAI 兼容端点
     ========================================================= */
  const TOKEN_LIMIT = {
    "4k": 4096, "8k": 8192, "16k": 16384, "32k": 32768, "64k": 65536,
    "128k": 131072, "200k": 204800, "1M": 1048576,
  };
  const DEFAULT_BASE = { deepseek: "https://api.deepseek.com/v1" };
  const TINTS = ["", "p2", "p3", "p4"];

  /** 页面侧新建条目的 id：前缀 + 时间 + 自增 + 随机。
   *  只拼 `Date.now()` 的话，同一毫秒建两场会话就是同一个 id —— 索引里两条、
   *  payload 却只有一份（key 就是 id），后写的正文把前面的盖掉，点进去还是同一场。
   *  实测一次建 9 场探针会话：屏幕上 49 行只剩 43 个唯一 id。 */
  let uidSeq = 0;
  function uid(prefix) {
    uidSeq = (uidSeq + 1) % 46656;
    return prefix + Date.now().toString(36) + uidSeq.toString(36) + Math.random().toString(36).slice(2, 5);
  }

  const LocalDB = {
    KEY: "dsh.local.sessions",
    /* ---- 存储布局（架构修复：单一 key 全量重写是长对话卡顿/卡死的根因）----
       旧版把所有会话的 messages + shot 全塞在一个 key 里，任何一次写入都要
       JSON.parse + JSON.stringify **整个库**（流式期间每 8 秒一次，主线程同步执行），
       对话越长单次成本越高，最后肉眼可见地卡住流式渲染、甚至把 UI 线程顶死。
       现在：索引（元信息，小）仍在 KEY；每个会话的 messages/shot 落自己的
       `dsh.local.sess.<id>`，写入只动自己那一份。旧格式首次读取时自动迁移。 */
    pkey(id) { return "dsh.local.sess." + id; },
    _idx: null,
    _payloads: new Map(),

    idx() {
      if (this._idx) return this._idx;
      let v = null;
      try { v = JSON.parse(localStorage.getItem(this.KEY) || "null"); } catch (_) {}
      if (Array.isArray(v)) {
        // 旧格式迁移：把内嵌的 messages/shot 拆到独立 key（一次性，之后索引保持轻量）
        let migrated = false;
        for (const s of v) {
          if (s && (s.messages || s.shot)) {
            try { localStorage.setItem(this.pkey(s.id), JSON.stringify({ messages: s.messages || [], shot: s.shot || null })); } catch (_) {}
            delete s.messages; delete s.shot;
            migrated = true;
          }
        }
        if (migrated) { try { localStorage.setItem(this.KEY, JSON.stringify(v)); } catch (_) {} }
        this._idx = v;
      } else {
        // 「没有这个 key」= 第一次运行（干净的 0 条）；「有 key 但不是数组」= 读坏了。
        // 开机清扫必须分得清这两件事：拿一个读坏的索引去清扫 = 把所有会话的内核记录删光。
        this._idxBroken = v !== null;
        this._idx = [];
      }
      return this._idx;
    },
    flushIdx() { try { localStorage.setItem(this.KEY, JSON.stringify(this._idx || [])); } catch (_) {} },

    payload(id) {
      let p = this._payloads.get(id);
      if (p) return p;
      try { p = JSON.parse(localStorage.getItem(this.pkey(id)) || "null"); } catch (_) { p = null; }
      if (!p || typeof p !== "object") p = { messages: [], shot: null };
      if (!Array.isArray(p.messages)) p.messages = [];
      this._payloads.set(id, p);
      // 缓存上限：只留最近 6 个会话的 payload，防长对话把内存吃穿
      if (this._payloads.size > 6) {
        const oldest = this._payloads.keys().next().value;
        if (oldest !== id) this._payloads.delete(oldest);
      }
      return p;
    },
    savePayload(id) {
      const p = this._payloads.get(id);
      if (!p) return;
      try { localStorage.setItem(this.pkey(id), JSON.stringify(p)); } catch (_) {}
    },

    all() { return this.idx(); },
    write(list) { this._idx = list; this.flushIdx(); },
    get(id) {
      const m = this.idx().find((s) => s.id === id);
      if (!m) return null;
      const p = this.payload(id);
      // open 必须带出来：重开会话靠它区分「进程被杀」与「用户自己停掉」（见 markInterruptedRound）
      return Object.assign({}, m, { messages: p.messages, shot: p.shot, open: Number(p.open) || 0 });
    },
    create(title) {
      const list = this.idx();
      const s = {
        id: uid("l"),
        title: title || "新会话",
        createdAt: Date.now(), updatedAt: Date.now(),
        // 会话落在「创建时的默认工作区」：工作区分组就是这个字段
        ws: state.workspace || "harness",
        tokens: 0,
      };
      list.unshift(s);
      this.flushIdx();
      this._payloads.set(s.id, { messages: [], shot: null });
      return Object.assign({}, s, { messages: [], shot: null });
    },
    push(id, msg) {
      const meta = this.idx().find((x) => x.id === id);
      if (!meta) return null;
      const p = this.payload(id);
      p.messages.push(msg);
      this.savePayload(id);
      meta.updatedAt = Date.now();
      if (msg.role === "user" && p.messages.filter((m) => m.role === "user").length === 1) {
        meta.title = (msg.content || "").replace(/\s+/g, " ").slice(0, 20) || "新会话";
      }
      // 列表预览只留一小段（索引保持轻量，不内嵌整个 messages）
      meta.lastMsg = {
        content: String(msg.content || "").replace(/\s+/g, " ").trim().slice(0, 80),
        atts: (Array.isArray(msg.atts) && msg.atts.length) ? [1] : undefined,
      };
      this.flushIdx();
      return this.get(id);
    },
    addTokens(id, n) {
      if (!n) return;
      const meta = this.idx().find((x) => x.id === id);
      if (!meta) return;
      meta.tokens = (meta.tokens || 0) + n;
      this.flushIdx();
    },
    remove(id) {
      this.write(this.idx().filter((s) => s.id !== id));
      this._payloads.delete(id);
      try { localStorage.removeItem(this.pkey(id)); } catch (_) {}
    },
    rename(id, title) {
      const s = this.idx().find((x) => x.id === id);
      if (!s) return;
      s.title = title || s.title;
      s.updatedAt = Date.now();
      this.flushIdx();
    },
    pin(id, on) {
      const s = this.idx().find((x) => x.id === id);
      if (!s) return;
      s.pin = !!on;
      this.flushIdx();
    },
    /** 会话归属的工作区（长按菜单可以挪） */
    setWs(id, ws) {
      const s = this.idx().find((x) => x.id === id);
      if (!s) return;
      s.ws = ws || "harness";
      this.flushIdx();
    },
    /* ---- 完整对话流快照 ----
       messages 只存纯文本（给模型当上下文），重开会话时看不到思考/工具过程。
       这里额外存一份渲染用的节点快照，让归档、切会话回来还是原来那条时间线。 */
    shot(id) { return this.payload(id).shot || null; },
    /**
     * `open` = 「这一轮还没收尾」的登记时间（0 = 没有未收尾的回合）。
     *
     * 为什么不能靠「库里最后一条是不是用户那句」来判断进程被杀：用户主动停止、
     * 切走会话都会就地收尾，而这两条路径**不 commit assistant 消息** ——
     * 那个判据会把「用户自己停掉的回合」也当成「没跑完」，重开就多一行误报。
     */
    saveShot(id, shot, open) {
      const meta = this.idx().find((x) => x.id === id);
      if (!meta) return;
      const p = this.payload(id);
      p.shot = shot;
      p.open = Number(open) || 0;
      for (let attempt = 0; attempt < 8; attempt++) {
        try { this.savePayload(id); return; } catch (_) {
          // 配额不够：按「最久没更新」依次丢掉其它会话的快照，再试一次
          const others = this.idx().filter((x) => x.id !== id)
            .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
          let dropped = false;
          for (const o of others) {
            const op = this.payload(o.id);
            if (op.shot) { op.shot = null; this.savePayload(o.id); dropped = true; break; }
          }
          if (!dropped) return;
        }
      }
    },
    /* ---- 计划存档：已批准的计划随会话保存，重开会话仍能看到 ---- */
    plan(id) { return (this.get(id) || {}).plan || null; },
    setPlan(id, plan) {
      const list = this.all();
      const s = list.find((x) => x.id === id);
      if (!s) return;
      s.plan = plan || null;
      this.write(list);
    },
    /* ---- 会话记忆：每条会话可保存多个要点，可增删改 ----
       条目分两类：kind="turn" 是每轮问答摘要（保连贯），其余是结构化要点（事实/偏好/决策）。 */
    mems(id) { return (this.get(id) || {}).mems || []; },
    addMem(id, text, source, meta) {
      const list = this.all();
      const s = list.find((x) => x.id === id);
      if (!s) return null;
      s.mems = s.mems || [];
      const m = Object.assign({
        id: "sm" + Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
        text, source: source || "auto", kind: "turn", topic: "对话",
        hits: 1, createdAt: Date.now(), updatedAt: Date.now(),
      }, meta || {});
      s.mems.unshift(m);
      s.updatedAt = Date.now();
      this.write(list);
      return m;
    },
    updateMem(id, memId, text, meta) {
      const list = this.all();
      const s = list.find((x) => x.id === id);
      const m = s && (s.mems || []).find((x) => x.id === memId);
      if (!m) return;
      m.text = text;
      m.updatedAt = Date.now();
      if (meta) Object.assign(m, meta);
      s.updatedAt = Date.now();
      this.write(list);
    },
    /** 只裁轮次摘要，结构化要点全部保留（它们是这个会话的结论） */
    keepMems(id, turnKeep) {
      const list = this.all();
      const s = list.find((x) => x.id === id);
      if (!s || !s.mems) return;
      const turns = s.mems.filter((m) => m.kind === "turn" || !m.kind);
      if (turns.length <= turnKeep) return;
      const drop = new Set(turns.slice(turnKeep).map((m) => m.id));
      s.mems = s.mems.filter((m) => !drop.has(m.id));
      this.write(list);
    },
    removeMem(id, memId) {
      const list = this.all();
      const s = list.find((x) => x.id === id);
      if (!s) return;
      s.mems = (s.mems || []).filter((x) => x.id !== memId);
      this.write(list);
    },
  };

  /**
   * 删除一场会话 = 页面侧记录 + 内核侧残留，一起清。
   *
   * 以前只有 `LocalDB.remove`（localStorage 的索引与正文），于是内核那边留下三样：
   * Mission 账本里指向这场的行（任务页照旧列着，实测 8 行指向已不存在的会话）、
   * 唤醒队列里到点会把它叫起来的条目、以及会话日志与成员日志文件（索引 12 条 / 盘上 1025 个）。
   * 规则只写这一处，三个删除入口都走它。
   */
  function purgeSession(id) {
    if (!id) return null;
    LocalDB.remove(id);
    let r = null;
    try { r = JSON.parse((Native.sessionPurge || function () { return "{}"; })(id) || "{}"); } catch (_) {}
    return r;
  }

  /**
   * 开机清扫：把级联落地前已经攒下的孤儿收掉。
   *
   * 传的是 `{loaded, ids}` 而不是光 ids —— 「索引里 0 场」有两种完全不同的意思：
   * 第一次运行（干净的 0，孤儿该全清）和索引读坏了（这时候清扫等于删光用户的东西）。
   * 这两种在页面侧分得清，在内核侧分不清，所以由页面把结论递过去。
   */
  let sweptOrphans = false;
  function sweepOrphans() {
    if (sweptOrphans) return;
    sweptOrphans = true;
    const ids = LocalDB.all().map((s) => s.id);
    let r = null;
    try {
      r = JSON.parse((Native.sessionSweep || function () { return "{}"; })(
        JSON.stringify({ loaded: !LocalDB._idxBroken, ids })) || "{}");
    } catch (_) {}
    return r;
  }

  /* ---------------- 长期记忆（结构化：抽取 → 合并 → 检索） ----------------
     旧版是「正则命中就把整句原话存下来」，三个硬伤：
       1. 存原话，冗长且重复（同一个偏好换个说法就多一条）；
       2. 事实变更（JDK 17 → JDK 21）两条并存，注入时新旧冲突；
       3. 注入不看相关性，20 条全量塞进 prompt，无关的也占预算。
     这一版：抽取成 {kind, topic, text} → 同主题相似句覆盖（旧值进历史）→ 按当前输入打分取 top-N。 */

  const MEM_KIND_LABEL = { fact: "事实", pref: "偏好", decision: "决策", identity: "身份" };

  /* 主题：先看「说的是什么对象」，命中不了再看陈述类型 */
  const MEM_SUBJECTS = [
    [/(数据库|mysql|postgres|sqlite|mongodb)/i, "数据库"],
    [/(前端|react|vue|flutter|界面|ui|样式)/i, "前端"],
    [/(后端|spring|服务端|接口|api|controller|service)/i, "后端"],
    [/(部署|上线|发布|docker|k8s|kubernetes|服务器|nginx)/i, "部署"],
    [/(测试|单测|用例|覆盖率|junit)/i, "测试"],
    [/(命名|代码风格|缩进|规范|lint)/i, "代码风格"],
    [/(构建|maven|gradle|打包|apk)/i, "构建"],
    [/(模型|llm|deepseek|gpt|claude|qwen)/i, "模型"],
    [/(记忆|角色|人格|persona|设定)/i, "助手配置"],
    [/(语音|识别|asr|tts|麦克风)/i, "语音"],
    [/(git|分支|提交|commit|仓库)/i, "版本管理"],
  ];

  const MEM_STOP = new Set(["的了", "一个", "这个", "那个", "我们", "你们", "可以", "就是", "什么", "怎么", "现在", "还是", "已经", "然后", "所以"]);

  /** 中文按 2-gram、英文按整词切，用于相似度与检索打分 */
  function memTokens(s) {
    const out = new Set();
    const str = String(s || "").toLowerCase();
    for (const w of str.match(/[a-z][a-z0-9_+#.-]{0,}/g) || []) {
      if (w.length > 1) out.add(w);
    }
    for (const seg of str.replace(/[^\u4e00-\u9fa5]+/g, " ").split(/\s+/)) {
      if (seg.length === 1) out.add(seg);
      for (let i = 0; i < seg.length - 1; i++) {
        const g = seg.slice(i, i + 2);
        if (!MEM_STOP.has(g)) out.add(g);
      }
    }
    return out;
  }

  function memSimilar(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.includes(b) || b.includes(a)) return true;
    const A = memTokens(a);
    const B = memTokens(b);
    if (!A.size || !B.size) return false;
    let inter = 0;
    for (const k of A) if (B.has(k)) inter++;
    return inter / Math.min(A.size, B.size) >= 0.34;
  }

  function memKindOf(s) {
    if (/(我叫|我是|叫我|我的名字)/.test(s)) return "identity";
    if (/(我习惯|我偏好|我喜欢|我不喜欢|我通常|我一般|我总是|请始终|以后都|往后都|每次(都)?|一律|统一|不要再|别用|不要用)/.test(s)) return "pref";
    if (/(决定|确定用|改成|换成|改用|采用|选定|方案是|拍板)/.test(s)) return "decision";
    return "fact";
  }

  function memTopicOf(s, kind) {
    for (const [re, name] of MEM_SUBJECTS) if (re.test(s)) return name;
    if (/(项目|工程|仓库|目录|路径|工作区)/.test(s)) return "项目位置";
    if (/(端口|localhost|127\.0\.0\.1)/.test(s)) return "服务端口";
    if (/(jdk|java|node|python|版本|环境)/i.test(s)) return "环境版本";
    if (/(回复|回答|输出|格式|简洁|详细)/.test(s)) return "回答风格";
    return kind === "pref" ? "表达偏好" : kind === "decision" ? "方案决策" : "其他";
  }

  /* 事实型陈述的准入信号：没有这些词的普通句子（"我写了个函数"）不该进长期记忆 */
  const MEM_FACT_CUE = /(路径|目录|工作区|项目在|位于|端口|版本|用的是|用的|部署在|安装在|运行在|依赖|技术栈|数据库是|地址是|账号|默认)/;

  /** 从一段用户输入里抽结构化记忆；疑问句、寒暄、闲聊一律不产条目 */
  function memExtract(raw) {
    const src = String(raw || "").replace(/\s+/g, " ").trim();
    if (!src || src.length > 800) return [];
    const out = [];
    const seen = new Set();
    for (const part of src.split(/[。！？!?；;\n]/)) {
      let s = part.trim().replace(/^[-*\d.、)\s]+/, "");
      if (s.length < 4 || s.length > 120) continue;
      if (/[?？]$/.test(s) || /(吗|呢|吧)$/.test(s)) continue;
      const kind = memKindOf(s);
      const soft = kind === "pref" || kind === "decision" || kind === "identity";
      if (!soft && !MEM_FACT_CUE.test(s)) continue;
      s = s.replace(/^(那么|然后|所以|另外|对了|其实|不过)[，,]?\s*/, "");
      const topic = memTopicOf(s, kind);
      const key = topic + "|" + s;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind, topic, text: pageClip(s, 80) });
    }
    return out;
  }

  const GlobalMem = {
    KEY: "dsh.mem.v2",
    LEGACY: "dsh.global.mems",
    _cache: null,

    all() {
      if (GlobalMem._cache) return GlobalMem._cache;
      let items = null;
      try {
        const raw = JSON.parse(localStorage.getItem(GlobalMem.KEY) || "null");
        if (raw && Array.isArray(raw.items)) items = raw.items;
      } catch (_) {}
      if (!items) items = GlobalMem._migrate();
      GlobalMem._cache = items;
      return items;
    },

    /** 旧版是纯文本数组，升级时补上 kind/topic，避免老用户记忆丢失 */
    _migrate() {
      let legacy = [];
      try {
        const v = JSON.parse(localStorage.getItem(GlobalMem.LEGACY) || "[]");
        if (Array.isArray(v)) legacy = v;
      } catch (_) {}
      const now = Date.now();
      const items = [];
      for (const m of legacy) {
        const text = String((m && m.text) || "").trim();
        if (!text) continue;
        const kind = memKindOf(text);
        items.push({
          id: "gm" + now.toString(36) + Math.random().toString(36).slice(2, 5),
          topic: memTopicOf(text, kind), text: pageClip(text, 90), kind,
          source: (m && m.source) || "manual", hits: 1,
          createdAt: (m && m.createdAt) || now, updatedAt: (m && m.createdAt) || now,
          history: [], pinned: false,
        });
      }
      if (items.length) GlobalMem._write(items);
      return items;
    },

    _write(items) {
      GlobalMem._cache = items;
      try { localStorage.setItem(GlobalMem.KEY, JSON.stringify({ v: 2, items })); } catch (_) {}
    },

    /**
     * 写入或合并。
     * 合并条件：同 kind + 同 topic + 文本相似（共享词足够多）。
     * 「JDK 17」和「JDK 21」会判为同一槽位 → 覆盖，旧值进 history；
     * 「回复用 TL;DR」和「代码给完整文件」虽然都在「回答风格」，但不相近 → 并存。
     */
    upsert(entry, source) {
      const text = String((entry && entry.text) || "").trim();
      if (!text) return null;
      const items = GlobalMem.all();
      const now = Date.now();
      const kind = entry.kind || memKindOf(text);
      const topic = entry.topic || memTopicOf(text, kind);
      const same = items.find((m) => m.kind === kind && m.topic === topic && memSimilar(m.text, text));
      if (same) {
        if (same.text === text) {
          same.updatedAt = now;
          same.hits = (same.hits || 1) + 1;
          if (source && source !== "auto") same.source = source;
          GlobalMem._write(items);
          return same;
        }
        same.history = [{ text: same.text, at: same.updatedAt || same.createdAt }]
          .concat(same.history || []).slice(0, 5);
        same.text = text;
        same.updatedAt = now;
        same.hits = (same.hits || 1) + 1;
        if (source) same.source = source;
        GlobalMem._write(items);
        return same;
      }
      const m = {
        id: "gm" + now.toString(36) + Math.random().toString(36).slice(2, 5),
        topic, text, kind, source: source || "manual", hits: 1,
        createdAt: now, updatedAt: now, history: [], pinned: false,
      };
      items.unshift(m);
      if (items.length > 120) items.length = 120;
      GlobalMem._write(items);
      return m;
    },

    add(text, source) {
      const t = String(text || "").trim();
      if (!t) return null;
      return GlobalMem.upsert({ text: t, kind: memKindOf(t), topic: memTopicOf(t, memKindOf(t)) }, source || "manual");
    },

    update(id, text) {
      const items = GlobalMem.all();
      const m = items.find((x) => x.id === id);
      if (!m) return;
      m.text = String(text || "").trim();
      m.updatedAt = Date.now();
      GlobalMem._write(items);
    },

    remove(id) { GlobalMem._write(GlobalMem.all().filter((x) => x.id !== id)); },

    togglePin(id) {
      const items = GlobalMem.all();
      const m = items.find((x) => x.id === id);
      if (!m) return;
      m.pinned = !m.pinned;
      GlobalMem._write(items);
    },

    /**
     * 检索：按当前输入给每条记忆打分，取 top-N 且不超过字符预算。
     * 打分 = 相关度(2-gram 重合) × 6 + 时效(45 天半衰) + 命中次数 + 钉住加权。
     * 一条都不相关时兜底取最近的 2 条，保证「刚才说过的」不会突然消失。
     */
    search(query, opts) {
      const o = Object.assign({ limit: 8, budget: 800 }, opts || {});
      const items = GlobalMem.all();
      const q = memTokens(query || "");
      const now = Date.now();
      const byFresh = items.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

      const ranked = items.map((m) => {
        if (!q.size) return { m, rel: 0 };
        const t = memTokens(m.topic + " " + m.text);
        let inter = 0;
        for (const k of t) if (q.has(k)) inter++;
        const rel = inter / Math.sqrt(q.size * Math.max(1, t.size));
        return { m, rel };
      }).filter((x) => x.rel > 0.02)
        .sort((a, b) => b.rel - a.rel);

      const picked = [];
      const taken = new Set();
      const push = (m) => {
        if (!m || taken.has(m.id)) return;
        taken.add(m.id);
        picked.push(m);
      };
      let chars = 0;
      for (const x of ranked) {
        if (picked.length >= o.limit) break;
        if (chars + x.m.text.length > o.budget) continue;
        push(x.m);
        chars += x.m.text.length;
      }
      for (const m of byFresh) {
        if (picked.length >= Math.max(2, Math.min(4, o.limit))) break;
        if (m.pinned || picked.length < 2) { push(m); chars += m.text.length; }
      }
      return picked;
    },

    /** 拼成注入 prompt 的一段文本；没有条目时返回空串 */
    briefing(query) {
      const picked = GlobalMem.search(query, { limit: 8, budget: 800 });
      if (!picked.length) return "";
      const lines = picked.map((m) => `- ${MEM_KIND_LABEL[m.kind] || "事实"}·${m.topic}：${m.text}`);
      return [
        "【长期记忆 · 按当前问题挑选】",
        ...lines,
        "以上是用户此前确认过的事实与偏好，直接采用，不要重复询问。",
        "若与用户当前说法冲突，以当前说法为准。",
      ].join("\n");
    },
  };

  /* ---------------- 记忆：会话记忆（按会话隔离的自动总结）+ 全局记忆 ---------------- */
  const Memo = {
    /** 会话记忆：每轮对话后压缩一条，只属于当前会话，最多保留 20 条 */
    afterTurn(sessionId) {
      const s = LocalDB.get(sessionId);
      if (!s) return;
      const msgs = s.messages || [];
      if (msgs.length < 2) return;

      let u = null;
      let a = null;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (!a && msgs[i].role === "assistant") a = msgs[i];
        else if (a && msgs[i].role === "user") { u = msgs[i]; break; }
      }
      if (!u) return;

      if (state.sessMem && String(u.content || "").trim()) {
        const q = pageClip(u.content, 34);
        const text = a ? `问「${q}」→ ${pageClip(firstSentence(a.content), 70)}` : `问「${q}」`;
        if (!LocalDB.mems(sessionId).some((m) => m.text === text)) {
          LocalDB.addMem(sessionId, text, "auto", { kind: "turn", topic: "对话" });
        }
        // 结构化要点：同一主题的相似句覆盖，避免"同一件事说了三遍就三条"
        for (const f of memExtract(u.content)) {
          const dup = LocalDB.mems(sessionId).find(
            (m) => m.kind && m.kind !== "turn" && m.topic === f.topic && memSimilar(m.text, f.text),
          );
          if (dup) {
            LocalDB.updateMem(sessionId, dup.id, f.text, { updatedAt: Date.now(), hits: (dup.hits || 1) + 1 });
          } else {
            LocalDB.addMem(sessionId, f.text, "auto", f);
          }
        }
        LocalDB.keepMems(sessionId, 16);
      }

      if (state.globalMem) {
        // 全局记忆只收结构化结果：偏好 / 决策 / 事实 / 身份
        for (const f of memExtract(u.content)) GlobalMem.upsert(f, "auto");
      }
    },

    /** 重新总结整段会话（覆盖式生成一条概要，保留手动/已有明细） */
    summarizeSession(sessionId) {
      const s = LocalDB.get(sessionId);
      if (!s) return null;
      const msgs = (s.messages || []).filter((m) => m.content);
      if (!msgs.length) return null;
      const picks = msgs.filter((m) => m.role === "user").slice(-5).map((m) => pageClip(m.content, 30));
      if (!picks.length) return null;
      const text = `本会话已聊：${picks.join("；")}`;
      const mems = LocalDB.mems(sessionId);
      const old = mems.find((m) => m.text.startsWith("本会话已聊："));
      if (old) LocalDB.updateMem(sessionId, old.id, text);
      else LocalDB.addMem(sessionId, text, "auto", { kind: "turn", topic: "概要" });
      LocalDB.keepMems(sessionId, 16);
      return text;
    },
  };

  /* 本地任务队列：真实持久化，重开应用仍在 */
  const LocalJobs = {
    KEY: "dsh.local.jobs",
    all() {
      try {
        const v = JSON.parse(localStorage.getItem(this.KEY) || "[]");
        return Array.isArray(v) ? v : [];
      } catch (_) { return []; }
    },
    write(list) { localStorage.setItem(this.KEY, JSON.stringify(list)); },
    create(title, note) {
      const list = this.all();
      const job = {
        id: uid("j"),
        title,
        note: note || "",
        status: "pending",
        createdAt: Date.now(),
      };
      list.unshift(job);
      this.write(list);
      return job;
    },
    remove(id) { this.write(this.all().filter((j) => j.id !== id)); },
  };

  /* 附件索引：记录用过的附件，文件页「附件」页签据此展示 */
  const LocalFiles = {
    KEY: "dsh.local.files",
    all() {
      try {
        const v = JSON.parse(localStorage.getItem(this.KEY) || "[]");
        return Array.isArray(v) ? v : [];
      } catch (_) { return []; }
    },
    write(list) { localStorage.setItem(this.KEY, JSON.stringify(list.slice(0, 200))); },
    add(items) {
      if (!items || !items.length) return;
      const list = this.all();
      for (const a of items) {
        list.unshift({
          id: "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
          name: a.name, size: a.size, type: a.type || "", at: Date.now(), sessionId: state.sessionId || "",
        });
      }
      this.write(list);
    },
    remove(id) { this.write(this.all().filter((f) => f.id !== id)); },
  };

  function fmtWhen(ts) {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  /** 内核定时任务（schedule_* 的同一份数据）：任务页与 Agent 看到的是同一个清单 */
  function kernelSchedules() {
    try {
      if (!(Native && Native.scheduleList)) return [];
      const arr = JSON.parse(Native.scheduleList());
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }

  function kernelJobs() {
    try {
      if (!(Native && Native.jobsList)) return [];
      const arr = JSON.parse(Native.jobsList());
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }

  /* ---------------- Mission：任务页与对话卡共用的一份投影 ----------------
     现在数据还来自两个旧注册表（jobs / schedules），先在这里收成同一组 {state, source}；
     等内核 Mission Ledger 落地，只换数据源，任务页与卡片不动。 */
  const JobsFilter = { state: "all", source: "all" };

  /**
   * 内核 Mission Ledger 的投影。Ledger 不可用（旧包/预览）时返回 null，
   * 调用方回退到 jobs/schedules 的旧推导 —— 双读一个版本，Step 2 再删回退。
   */
  function readMissionLedger(sid) {
    try {
      if (!(Native && Native.missionList)) return null;
      const arr = JSON.parse(Native.missionList(sid || "") || "[]");
      if (!Array.isArray(arr)) return null;
      return arr.map((m) => {
        const kind = m.kind === "schedule" ? "schedule" : m.kind === "team" ? "team" : "job";
        const settled = String(m.state || "") === "settled";
        const state = settled ? "done" : String(m.state || "") === "waiting" ? "waiting" : "running";
        const outcome = String(m.outcome || "");
        let stateText;
        if (settled) {
          stateText = outcome === "failed" ? "失败"
            : outcome === "cancelled" ? "已终止"
            : outcome === "interrupted" ? "已中断" : "已完成";
        } else if (kind === "schedule") {
          stateText = m.overdue ? "已到点" : "等待 " + nextAtText(m.nextAt);
        } else if (kind === "team") {
          stateText = String(m.state || "") === "waiting" ? "被依赖挡住"
            : String(m.state || "") === "queued" ? "待认领" : "成员进行中";
        } else {
          stateText = "运行中";
        }
        const at = kind === "schedule"
          ? (Number(m.nextAt) || 0)
          : (Number(m.startedAt) || Number(m.updatedAt) || 0);
        return {
          id: String(m.id || ((kind === "schedule" ? "schedule:" : kind === "team" ? "team:" : "job:") + (m.sourceId || ""))),
          kind,
          sourceId: String(m.sourceId || ""),
          sessionId: String(m.sessionId || ""),
          title: String(m.title || (kind === "schedule" ? "定时任务" : kind === "team" ? "团队任务" : "后台任务")),
          state, stateText,
          meta: kind === "schedule" ? "定时" : kind === "team" ? "团队" : "后台",
          member: String((m.origin && m.origin.member) || ""),
          at,
          overdue: !!m.overdue,
          evidence: Number(m.evidenceCount) || (Array.isArray(m.evidence) ? m.evidence.length : 0),
          rule: m.rule || null,
          outcome,
        };
      });
    } catch (_) { return null; }
  }

  function missionRows(sid) {
    const ledger = readMissionLedger(sid);
    if (ledger) return ledger;
    const jobs = kernelJobs()
      .filter((j) => !sid || String(j.owner || "") === String(sid))
      .map((j) => ({
        id: "job:" + j.job_id,
        kind: "job",
        title: j.name || "后台任务",
        state: j.status === "running" ? "running" : "done",
        stateText: j.status === "running" ? "运行中"
          : j.status === "done" ? "已完成"
          : j.status === "killed" ? "已终止" : "失败",
        meta: "后台",
        at: Number(j.started_at) || 0,
        evidence: (Number(j.retained_chars) || 0) > 0 ? 1 : 0,
      }));
    const scheds = kernelSchedules()
      .filter((s) => !sid || String(s.sessionId || "") === String(sid))
      .map((s) => {
        const active = s.state === "active";
        return {
          id: "schedule:" + s.id,
          kind: "schedule",
          title: s.title || "定时任务",
          state: active ? "waiting" : "done",
          stateText: active ? (s.overdue ? "已到点" : "等待 " + nextAtText(s.scheduledAt)) : "已结束",
          meta: "定时",
          at: Number(s.scheduledAt) || 0,
          overdue: !!s.overdue,
          evidence: s.lastDelivery ? 1 : 0,
        };
      });
    return [...jobs, ...scheds].sort((a, b) => b.at - a.at);
  }

  /**
   * 按行 key（`kind:id`，就是 `data-job` / 账本 id）找回这一行。
   *
   * 列表早就改成「账本优先」了，操作面板却还在两份旧注册表里 find：
   * `jobsList()` 是进程内存（重启就空）、`schedule.json` 也可能是空的 ——
   * 找不到就什么都不开，用户看到的正是「任务点没反应、也删不掉」（实测 12 行全打不开）。
   * 所以入口只信这一份投影，本机纯记录（local）再回 LocalJobs。
   */
  function findJobRow(key) {
    const k = String(key || "");
    const hit = missionRows("").find((x) => x.id === k);
    if (hit) return hit;
    const id = k.split(":").slice(1).join(":") || k;
    const j = LocalJobs.all().find((x) => x.id === id);
    return j ? { id: "local:" + j.id, kind: "local", sourceId: j.id, title: j.title, note: j.note, state: "done", stateText: j.status === "done" ? "已完成" : "待办" } : null;
  }

  /**
   * 「删掉这一条」的唯一派发：任务页与对话里的 Mission 抽屉都走这里，规则只写一遍。
   * 返回 {ok, msg} —— 删不动要把原因还给用户，不能报「已删除」。
   */
  function deleteMissionRow(row) {
    if (!row) return { ok: false, msg: "这一条已经不在了" };
    if (row.kind === "local") { LocalJobs.remove(row.sourceId); return { ok: true, msg: "已删除记录" }; }
    if (row.kind === "schedule") {
      const sid = String(row.sourceId || row.id).replace(/^schedule:/, "");
      const ok = !!(Native && Native.scheduleDelete && Native.scheduleDelete(sid));
      // 内核已经没有这条定时任务（比如别处删过）：账本里的残留也要跟着收掉，
      // 否则按一次「删除」列表纹丝不动，看着就像按钮坏了。
      if (!ok) (Native.missionRemove || function () { return "{}"; })(row.id);
      return { ok, msg: ok ? "定时任务已删除" : "内核里已经没有这条定时任务了" };
    }
    let r = {};
    try { r = JSON.parse((Native.missionRemove || function () { return "{}"; })(row.id) || "{}"); } catch (_) {}
    return { ok: !!r.ok, msg: r.ok ? "已删除这条记录" : (r.error || "删除失败") };
  }

  /** 「终止这一件」：账本里在跑的后台任务 kill（随后 job_done 落账），规则只写这一处。 */
  function cancelMissionRow(id) {
    let r = {};
    try { r = JSON.parse((Native.missionCancel || function () { return "{}"; })(id) || "{}"); } catch (_) {}
    return { ok: !!r.ok, msg: r.ok ? "已终止这件事的后台任务" : (r.error || "终止失败") };
  }

  /** 「重新跑一次」：只按账本里留下的命令重起，参数没留就老实说不清（内核那条判据）。 */
  function rerunMissionRow(id) {
    let r = {};
    try { r = JSON.parse((Native.missionRerun || function () { return "{}"; })(id) || "{}"); } catch (_) {}
    return { ok: !!r.ok, msg: r.ok ? "已按当时的命令重新起一个后台任务" : (r.error || "重跑失败") };
  }

  /** 真正值得进「进行中」的：在跑的任务 + 已经到点/半小时内要到点的定时任务。
      远期定时任务只留在任务页，否则对话底部会长期挂着一条「进行中」噪音。 */
  function missionLive(m) {
    if (m.state === "running") return true;
    if (m.state !== "waiting") return false;
    return !!m.overdue || (m.at > 0 && m.at - Date.now() <= 30 * 60 * 1000);
  }

  function missionActive(sid) {
    return missionRows(sid).filter(missionLive);
  }

  /** 抠图毛绒本体：浅色主题用黑白款、深色主题用雾蓝款；不做圆形底盘，直接坐在卡面上 */
  function whalePlushHTML() {
    return `<span class="mc-plush"><img class="mc-plush-light" src="whale-plush-light.png" alt=""><img class="mc-plush-dark" src="whale-plush-dark.png" alt=""></span>`;
  }

  /** 输入框上沿的「进行中」带：一条安静的状态行，不是第二个导航 */
  function syncMissionStrip() {
    const bar = $("#missionStrip");
    const text = $("#missionStripText");
    if (!bar || !text) return;
    const active = state.sessionId ? missionActive(state.sessionId) : [];
    if (!active.length) {
      bar.hidden = true;
      text.textContent = "";
      return;
    }
    const names = active.slice(0, 2).map((m) => m.title).join(" · ");
    text.innerHTML = `<b>${active.length} 个进行中</b> · ${esc(names)}`;
    bar.hidden = false;
  }

  /**
   * 会话内的 Mission 卡：同一会话只保留一张，随任务开始/结束就地更新。
   * 只投影、不新增第二套事实源 —— 数据仍是 jobs/schedules，等 Ledger 落地换源即可。
   */
  function syncMissionCard() {
    if (currentMode() !== "local" || !state.sessionId || thread.__sid !== state.sessionId) return;
    // 空会话不单独长出一张卡：卡片属于「这段对话里的工作」，没有对话就没有落点
    if (!thread.length) return;
    const sid = state.sessionId;
    const all = missionRows(sid);
    const active = missionActive(sid);
    const existing = thread.find((n) => n.kind === "mission" && n.sid === sid);

    if (!active.length) {
      if (existing && existing.state !== "done") {
        existing.state = "done";
        existing.rows = (existing.rows || []).map((r) => {
          const now = all.find((m) => m.id === r.id);
          return now ? { ...r, state: now.state, stateText: now.stateText } : { ...r, stateText: "已结束" };
        });
        existing.updatedAt = Date.now();
        patchNode(existing);
        persistThread();
      }
      return;
    }

    const prevRows = (existing && existing.rows) || [];
    const rows = [
      ...active.map((m) => ({ id: m.id, kind: m.kind, title: m.title, state: m.state, stateText: m.stateText })),
      ...prevRows
        .filter((r) => !active.some((m) => m.id === r.id) && all.some((m) => m.id === r.id))
        .map((r) => {
          const now = all.find((m) => m.id === r.id);
          return { ...r, state: now.state, stateText: now.stateText };
        }),
    ].slice(0, 4);

    const payload = {
      sid,
      title: active.length === 1 ? active[0].title : `${active.length} 项进行中`,
      meta: [...new Set(active.map((m) => m.meta))].join(" · ") + " · 刚刚更新",
      state: "running",
      rows,
      evidence: active.reduce((n, m) => n + (m.evidence ? 1 : 0), 0),
      updatedAt: Date.now(),
    };

    if (existing) {
      const sig = (n) => JSON.stringify([n.title, n.state, n.rows, n.evidence]);
      if (sig(existing) === sig(payload)) return;
      Object.assign(existing, payload);
      patchNode(existing);
      persistThread();
      return;
    }
    const node = NODES.mission(payload);
    push(node, false);
    persistThread();
    if (followBottomOn) scrollToBottom();
  }

  function syncMissions() {
    try { syncMissionStrip(); } catch (_) {}
    try { syncMissionCard(); } catch (_) {}
  }

  function ruleLabel(rule) {
    if (!rule) return "未设置";
    if (rule.after_seconds) return `${rule.after_seconds} 秒后一次`;
    if (rule.every_seconds) return `每 ${Math.round(rule.every_seconds / 60)} 分钟`;
    if (rule.daily) return `每天 ${rule.daily.time || "09:00"}`;
    if (rule.weekly) return `每周 ${(rule.weekly.weekdays || []).join(",")} ${rule.weekly.time || "09:00"}`;
    if (rule.cron) return `cron ${rule.cron.expression || ""}`;
    if (rule.at) return String(rule.at);
    return "未设置";
  }

  function nextAtText(ts) {
    if (!ts) return "";
    const d = new Date(Number(ts));
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  /* ---------------- Mission 详情抽屉 ----------------
     卡片说「有件事在跑」，抽屉回答「谁发起的、到哪一步、产出什么、我批准过什么」。
     状态与证据都在内核账本里，这里只渲染；「跳任务页」降级成抽屉底部的次要入口，
     并且带着 id 过去定位到那一行 —— 看一眼详情不该把人从对话里赶出去。 */

  const MISSION_PERMS = [
    { mode: "inherit", name: "跟随会话", desc: "与会话权限一致", rank: -1 },
    { mode: "readonly", name: "只读", desc: "这件事不能写文件、不能执行命令", rank: 0 },
    { mode: "default", name: "标准", desc: "可写工作区，危险操作逐次确认", rank: 1 },
    { mode: "full", name: "完全访问", desc: "不再逐条确认", rank: 2 },
  ];
  const PERM_RANK_OF = { readonly: 0, ask: 1, default: 1, full: 2 };
  const WAKE_POLICY_TEXT = {
    "idle-auto": "空闲时自动续一轮",
    queue: "排队等空闲",
    notify: "只发通知",
    defer: "不自动打扰",
  };
  const MISSION_OUTCOME_TEXT = {
    done: "完成", failed: "失败", cancelled: "已终止", interrupted: "被中断（进程回收）",
  };

  function missionDetailOf(id) {
    try {
      if (!(Native && Native.missionDetail)) return null;
      const d = JSON.parse(Native.missionDetail(id) || "null");
      return d && d.mission ? d : null;
    } catch (_) { return null; }
  }

  function missionTimeText(ts) {
    const n = Number(ts) || 0;
    if (!n) return "—";
    const d = new Date(n);
    return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function missionDurText(m) {
    const a = Number(m.startedAt) || 0;
    const b = Number(m.endedAt) || 0;
    if (!a || !b || b < a) return "";
    return `用时 ${((b - a) / 1000).toFixed(1)}s`;
  }

  /** 这张卡当前还活着的 Mission（账本可能已经删掉其中几条）。 */
  function missionGroupIds(node) {
    const ids = [];
    (node && node.rows ? node.rows : []).forEach((r) => {
      const id = String(r.id || "");
      if (id && !ids.includes(id)) ids.push(id);
    });
    if (!ids.length && node && node.missionId) ids.push(String(node.missionId));
    return ids.filter((id) => !!missionDetailOf(id));
  }

  /** origin 在 rc.188 起是对象（留了重跑要用的参数），之前的账本里它是字符串 */
  function missionOriginType(m) {
    const o = m && m.origin;
    return typeof o === "string" ? o : ((o && o.type) || "");
  }

  function sheetMission(ids, pickedId) {
    const id = pickedId || ids[0];
    const d = missionDetailOf(id);
    if (!d) return `<div class="sheet-title">这件事已经不在了</div><div class="sheet-caption">任务可能已被删除或结算后被清理。</div><button class="btn-ghost" data-close>关闭</button>`;
    const m = d.mission || {};
    const ev = d.evidence || [];
    const tl = d.timeline || [];
    const scope = m.permissionScope || {};
    const mode = scope.mode || "inherit";
    const done = m.state === "settled";
    const running = m.state === "running";
    const waiting = m.state === "waiting";
    const kindName = m.kind === "schedule" ? "定时任务" : m.kind === "team" ? "团队任务" : m.kind === "job" ? "后台任务" : m.kind;
    const originType = missionOriginType(m);
    const member = (m.origin && m.origin.member) || "";
    const originLine = originType === "schedule" ? "定时到点"
      : originType === "team" ? ("任务板 · " + (member ? "成员 " + member : "待认领"))
      : "由对话发起";
    const sessionRank = PERM_RANK_OF[state.perm] === undefined ? 1 : PERM_RANK_OF[state.perm];
    // 只给「不比会话更宽」的档位：Mission 能收窄，不能替用户把全局闸门抬起来
    const permOptions = MISSION_PERMS.filter((o) => o.rank <= sessionRank);

    const group = ids.length > 1 ? `<div class="sheet-list">${ids.map((g) => {
      const gd = missionDetailOf(g);
      const gm = (gd && gd.mission) || {};
      return `<button class="sheet-item ${g === id ? "is-on" : ""}" data-mission-pick="${esc(g)}">
        <span class="nm">${esc(gm.title || g)}</span>
        <span class="row-value">${esc(gm.state === "settled" ? "已结束" : gm.state === "running" ? "进行中" : "等待中")}</span>
        <svg class="ico check"><use href="#i-check"/></svg>
      </button>`;
    }).join("")}</div>` : "";

    const chips = [
      kindName,
      done ? ("已结束 · " + (MISSION_OUTCOME_TEXT[m.outcome] || m.outcome || "")) : "",
      missionDurText(m),
      waiting && m.nextAt ? ("下次 " + nextAtText(m.nextAt)) : "",
      m.overdue ? "已到点待触发" : "",
      (m.rule ? ruleLabel(m.rule) : ""),
    ].filter(Boolean);

    const perms = permOptions.map((o) => `<button class="sheet-item ${o.mode === mode ? "is-on" : ""}" data-mission-perm="${esc(o.mode)}" data-mission-id="${esc(id)}">
      <span class="nm">${esc(o.name)}<span class="desc">${esc(o.desc)}</span></span>
      <svg class="ico check"><use href="#i-check"/></svg>
    </button>`).join("");

    const timeline = tl.length ? `<div class="sheet-list">${tl.map((t) => `<div class="sheet-item is-plain">
      <span class="nm">${esc(t.label)}</span><span class="row-value">${esc(t.text)}</span>
    </div>`).join("")}</div>` : "";

    const evid = ev.length ? ev.map((e) => `
      <div class="sheet-item is-plain"><span class="nm">${esc(e.title || e.kindLabel || "记录")}</span>
        <span class="row-value">${esc(missionTimeText(e.at))}</span></div>
      ${e.text ? `<pre class="pv-pre">${esc(e.text)}</pre>` : ""}`).join("")
      : `<div class="sheet-caption">这件事还没有留下可回看的记录。</div>`;

    const grants = (scope.grants || []);
    const grantLine = grants.length
      ? `<div class="sheet-caption">这件事内已允许：${esc(grants.join(" · "))}（不扩到会话里的其它事）</div>` : "";

    const acts = [];
    if (running && m.kind === "job") acts.push(`<button class="btn-ghost" data-mission-cancel="${esc(id)}" style="color:var(--red)">终止任务</button>`);
    // 重跑只在账本留了当时命令时出现：老记录没留参数，凭标题猜一条命令去跑是拿用户的东西冒险
    const rerunnable = m.kind === "job" && !running && !!((m.origin && m.origin.command) || "");
    if (rerunnable) acts.push(`<button class="btn-ghost" data-mission-rerun="${esc(id)}">重新跑一次</button>`);
    if (m.kind === "schedule") acts.push(`<button class="btn-ghost" data-job-del="schedule:${esc(m.sourceId || "")}" style="color:var(--red)">删除定时任务</button>`);
    // 已经结束的后台任务：记录本身可以删掉（还在跑的只给「终止」，不给「删除」）
    if (m.kind === "job" && !running) acts.push(`<button class="btn-ghost" data-job-del="${esc(id)}" style="color:var(--red)">删除记录</button>`);
    acts.push(`<button class="btn-ghost" data-mission-locate="${esc(id)}">在任务页定位</button>`);
    acts.push(`<button class="btn-ghost" data-mission-export="${esc(id)}">导出记录</button>`);
    acts.push(`<button class="btn-ghost" data-close>关闭</button>`);

    return `
      ${group}
      <div class="mc-head" style="padding:2px 2px 0">
        ${whalePlushHTML()}
        <div class="mc-titles">
          <b style="font-size:17px;white-space:normal">${esc(m.title || "Mission")}</b>
          <span>${esc(originLine + " · " + id)}</span>
        </div>
        <span class="mc-state${done ? " is-done" : ""}">${done ? "已结束" : running ? "进行中" : "等待中"}</span>
      </div>
      ${running || done ? `<div class="mc-bar"><i class="${running ? "is-run" : "is-done"}"></i></div>` : ""}
      <div class="pv-meta">${chips.map((c) => `<span class="pv-chip">${esc(c)}</span>`).join("")}</div>
      <div class="sheet-caption">唤醒策略：${esc(WAKE_POLICY_TEXT[m.wakePolicy] || m.wakePolicy || "空闲时自动续一轮")}</div>
      <div class="sheet-caption" style="margin-top:8px">权限范围</div>
      <div class="sheet-list">${perms}</div>
      ${grantLine}
      <div class="sheet-caption">时间线</div>
      ${timeline}
      <div class="sheet-caption">证据</div>
      ${evid}
      <div class="sheet-footer">${acts.join("")}</div>`;
  }

  /** 卡片的「查看」：就地开抽屉，不再离开对话页 */
  function openMissionSheet(node) {
    const ids = missionGroupIds(node);
    if (!ids.length) { go("jobs"); return; }
    openSheet(sheetMission(ids, ids[0]));
    haptic("light");
  }

  /** 抽屉里的次要出口：跳到任务页并定位到那一行（筛选先把目标放行） */
  function locateMission(missionId) {
    JobsFilter.state = "all";
    JobsFilter.source = "all";
    go("jobs");
    renderJobs();
    const sel = String(missionId || "").replace(/"/g, "");
    const row = document.querySelector(`#jobsToday [data-job="${sel}"]`);
    if (row) {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      row.classList.add("is-flash");
      setTimeout(() => row.classList.remove("is-flash"), 1200);
    }
  }

  function renderJobs() {
    const timers = kernelSchedules();
    const locals = LocalJobs.all();
    const bgJobs = kernelJobs();
    // 账本优先：状态/来源只信 Mission Ledger；Ledger 不在（旧包/预览）才回退两份旧数据
    const ledger = readMissionLedger("");
    const kernelRows = ledger
      ? ledger.map((m) => {
          const settled = m.state === "done";
          const status = (m.state === "running" || m.state === "waiting") ? "running"
            : (m.outcome === "failed" || m.outcome === "interrupted") ? "failed"
            : "done";
          const tag = m.kind === "schedule"
            ? (settled ? "已结束" : "等待")
            : (m.state === "running" ? "进行中" : m.stateText);
          const meta = m.kind === "schedule"
            ? `${m.rule ? ruleLabel(m.rule) : "定时"} · ${settled ? "已结束" : (m.overdue ? "已到点" : "下次 " + nextAtText(m.at))}`
            : m.kind === "team"
              ? `团队任务 · ${m.member || "任务板"}`
              : `后台任务 · ${m.stateText}`;
          return {
            kind: m.kind,
            // data-job 仍要 source id（openJobSheet 按 "kind:id" 找旧注册表），不是 "job:..." 双前缀
            id: m.sourceId || String(m.id).replace(/^(job|schedule|team):/, ""),
            title: m.title, note: "",
            state: m.state, source: m.kind,
            meta, status, tag,
          };
        })
      : [
          ...timers.map((s) => {
            // 内核 toView 给的是 scheduledAt/state，没有 next_at —— 以前读错字段，
            // 「下次执行」一列永远是空的，结束的任务还挂着「运行中」的绿点。
            const ended = s.state !== "active";
            return {
              kind: "schedule", id: s.id, title: s.title, note: s.prompt,
              state: ended ? "done" : "waiting", source: "schedule",
              meta: ended
                ? `${ruleLabel(s.rule)} · 已结束`
                : `${ruleLabel(s.rule)} · 下次 ${nextAtText(s.scheduledAt)}`,
              status: ended ? "done" : "running",
              tag: ended ? "已结束" : "等待",
            };
          }),
          ...bgJobs.map((j) => {
            const chars = (Number(j.retained_chars) || 0) + (Number(j.dropped_chars) || 0);
            return {
              kind: "job", id: j.job_id, title: j.name || "后台任务",
              note: chars ? `${chars} 字符输出` : "",
              state: j.status === "running" ? "running" : "done", source: "job",
              meta: `后台任务 · ${j.status === "running" ? "运行中" : j.status === "done" ? "已完成" : j.status === "killed" ? "已终止" : "失败"}`,
              status: j.status,
              tag: j.status === "running" ? "进行中" : j.status === "done" ? "完成" : j.status === "killed" ? "已终止" : "失败",
            };
          }),
        ];
    const list = [
      ...kernelRows,
      ...locals.map((j) => ({
        kind: "local", id: j.id, title: j.title, note: j.note,
        state: "done", source: "local",
        meta: `${fmtWhen(j.createdAt)} · 本地任务 · 仅记录`, status: j.status === "done" ? "done" : "pending",
        tag: "记录",
      })),
    ];

    const visible = list.filter((j) =>
      (JobsFilter.state === "all" || j.state === JobsFilter.state) &&
      (JobsFilter.source === "all" || j.source === JobsFilter.source));

    const wrap = $("#jobsToday");
    const empty = $("#jobsEmpty");
    if (!wrap || !empty) return;
    const has = visible.length > 0;
    wrap.style.display = has ? "" : "none";
    empty.style.display = has ? "none" : "";

    const connected = currentMode() === "host";
    const needHost = state.mode === "host" && !state.host;
    const jt = $("#jobsEmptyTitle");
    const js = $("#jobsEmptySub");
    const jc = $("#emptyConnectJobs");
    if (!list.length) {
      if (jt) jt.textContent = connected ? "宿主机还没有任务" : "还没有任务";
      if (js) js.textContent = connected
        ? "Agent 新建的任务会出现在这里"
        : "点右上角「+」新建任务";
      if (jc) jc.style.display = needHost ? "" : "none";
    } else if (!has) {
      // 有任务、只是被筛掉了 —— 不能再说「还没有任务」，否则看起来像数据丢了
      if (jt) jt.textContent = "没有符合条件的任务";
      if (js) js.textContent = "换个状态或来源试试";
      if (jc) jc.style.display = "none";
    }
    wrap.innerHTML = visible.map((j) => `
      <div class="job-row" data-job="${j.kind}:${j.id}" data-state="${j.state}" data-source="${j.source}">
        <span class="status-dot ${j.status === "done" ? "ok" : j.status === "running" ? "warn" : j.status === "failed" ? "err" : "idle"}"></span>
        <div class="job-title-wrap">
          <b>${esc(j.title)}</b>
          <span>${esc(j.meta)}${j.note ? " · " + esc(pageClip(j.note, 28)) : ""}</span>
        </div>
        <span class="job-tag ${j.state === "running" ? "warn" : ""}">${esc(j.tag)}</span>
      </div>`).join("");
    try { syncMissionStrip(); } catch (_) {}
  }

  /** 任务页筛选：状态与来源叠加，只筛视图、不动数据 */
  function bindJobFilters() {
    const seg = $("#jobStateSeg");
    const src = $("#jobSourceRow");
    if (seg) seg.addEventListener("click", (e) => {
      const b = e.target.closest("[data-job-state]");
      if (!b) return;
      JobsFilter.state = b.dataset.jobState;
      $$("#jobStateSeg button").forEach((x) => x.classList.toggle("is-on", x === b));
      renderJobs();
      haptic("light");
    });
    if (src) src.addEventListener("click", (e) => {
      const b = e.target.closest("[data-job-source]");
      if (!b) return;
      JobsFilter.source = b.dataset.jobSource;
      $$("#jobSourceRow [data-job-source]").forEach((x) => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
      renderJobs();
      haptic("light");
    });
  }

  const FILE_TABS = {
    out: { title: "暂无产出文件", sub: "连接后显示 Agent 产出" },
    work: { title: "工作区为空", sub: "连接后显示工作区文件" },
    att: { title: "还没有附件", sub: "在对话里点「+」上传文件，附件会记录在这里" },
  };

  /** 工作区真实文件列表（文件页「工作区」页签） */
  function workspaceFiles() {
    try {
      if (!(Native && Native.listWorkspace)) return { ok: false, items: [] };
      return JSON.parse(Native.listWorkspace(state.fileCwd || "."));
    } catch (e) { return { ok: false, items: [], error: String(e.message || e) }; }
  }

  function deliverableFiles() {
    try {
      if (!(Native && Native.deliverables)) return [];
      const arr = JSON.parse(Native.deliverables());
      if (!Array.isArray(arr)) return [];
      // 交付记录是会话事件，删掉文件后记录还在 —— 这里按磁盘实际存在性过滤，
      // 免得出现「列表里还有，点开却打不开」。
      if (!(Native && Native.fileExists)) return arr;
      return arr.filter((f) => {
        if (!f || !f.path) return true;
        try { return !!Native.fileExists(f.path); } catch (_) { return true; }
      });
    } catch (_) { return []; }
  }

  function fileRow(kind, f) {
    const isDir = !!f.isDir;
    const name = f.name || f.path || "";
    const sizeText = isDir ? "目录" : fmtSize(f.size || 0);
    const when = f.mtime || f.at;
    const tag = isDir ? "DIR" : (name.split(".").pop() || "文件").toUpperCase();
    return `
      <div class="job-row" data-file-kind="${kind}" data-file-path="${esc(f.path || "")}" data-file-name="${esc(name)}" data-file-id="${esc(f.id || "")}">
        <span class="status-dot ${isDir ? "warn" : "idle"}"></span>
        <div class="job-title-wrap">
          <b>${esc(name)}${isDir ? "/" : ""}</b>
          <span>${esc(sizeText)}${when ? " · " + fmtWhen(when) : ""}${f.description ? " · " + esc(pageClip(f.description, 24)) : ""}</span>
        </div>
        <span class="job-tag">${esc(tag)}</span>
        ${isDir ? `<svg class="ico xs file-dir-chev"><use href="#i-chevron"/></svg>` : ""}
      </div>`;
  }

  /** 工作区当前路径（面包屑）：点在任意一级就回那一级，最深也能一步回根 */
  function renderCrumb(tab) {
    const bar = $("#filesCrumb");
    if (!bar) return;
    if (tab !== "work") { bar.style.display = "none"; bar.innerHTML = ""; return; }
    const segs = String(state.fileCwd || ".").split("/").filter((p) => p && p !== ".");
    bar.style.display = "";
    bar.innerHTML = `
      <button class="crumb ${segs.length ? "" : "is-current"}" data-crumb-dir=".">
        <svg class="ico xs"><use href="#i-files"/></svg><span>工作区</span>
      </button>
      ${segs.map((s, i) => {
        const p = segs.slice(0, i + 1).join("/");
        return `<svg class="ico xs crumb-sep"><use href="#i-chevron"/></svg>
          <button class="crumb ${i === segs.length - 1 ? "is-current" : ""}" data-crumb-dir="${esc(p)}">${esc(s)}</button>`;
      }).join("")}`;
  }

  function renderFiles() {
    const tab = state.fileTab || "out";
    const q = ($("#filesSearch") ? $("#filesSearch").value : "").trim().toLowerCase();
    const wrap = $("#filesList");
    const empty = $("#filesEmpty");
    if (!wrap || !empty) return;

    let rows = [];
    if (tab === "work") {
      const res = workspaceFiles();
      rows = (res.items || []).filter((f) => !q || f.name.toLowerCase().includes(q));
    } else if (tab === "out") {
      rows = deliverableFiles().filter((f) => !q || (f.name || f.path || "").toLowerCase().includes(q));
    } else {
      rows = LocalFiles.all().filter((f) => !q || f.name.toLowerCase().includes(q));
    }

    const connected = currentMode() === "host";
    const meta = FILE_TABS[tab] || FILE_TABS.out;
    const localMeta = {
      out: { title: "暂无交付文件", sub: "Agent 用 present 交付的文件会出现在这里" },
      work: { title: "工作区为空", sub: "Agent 读写的文件都在这里" },
      att: FILE_TABS.att,
    };
    const pick = connected ? meta : (localMeta[tab] || localMeta.out);
    const t = $("#filesEmptyTitle");
    const s = $("#filesEmptySub");
    const c = $("#emptyConnectFiles");
    const title = connected ? pick.title.replace(/^暂无/, "宿主机暂无") : pick.title;
    if (t) t.textContent = q && rows.length === 0 ? "没有匹配的文件" : title;
    if (s) s.textContent = q && rows.length === 0 ? "换个关键词试试" : pick.sub;
    if (c) c.style.display = (state.mode === "host" && !state.host) ? "" : "none";

    const has = rows.length > 0;
    wrap.style.display = has ? "" : "none";
    empty.style.display = has ? "none" : "";
    wrap.innerHTML = rows.map((f) => fileRow(tab, f)).join("");
    renderCrumb(tab);
  }

  /* ---------- 任务 / 会话 / 文件的长按操作 ---------- */
  /**
   * 任务页一行的操作面板。传的是 `findJobRow()` 出来的**投影行**（账本优先），
   * 不是两份旧注册表里的原始对象 —— 否则进程重启后那些行永远打不开面板。
   */
  const sheetJobActions = (row) => {
    const kind = row.kind || "local";
    const rows = [];
    if (kind === "schedule") {
      // 提示词与规则的真值在定时任务记录里（账本只带 rule 与下次时间）
      const s = kernelSchedules().find((x) => x.id === row.sourceId) || {};
      const ended = row.state === "done";
      rows.push(`<div class="sheet-sub">${esc(ruleLabel(row.rule || s.rule))} · ${ended ? "已结束" : "下次 " + esc(nextAtText(row.at || s.scheduledAt))}</div>`);
      if (s.prompt) rows.push(`<div class="sheet-caption" style="margin:-4px 2px 10px">到点把「${esc(pageClip(s.prompt, 40))}」发给 Agent</div>`);
      if (!ended) rows.push(`<button class="btn-primary" data-job-edit="${esc(row.sourceId)}">编辑任务</button>`);
      rows.push(`<button class="btn-primary" data-job-run="${esc(row.sourceId)}">立即触发一次</button>`);
      rows.push(`<button class="btn-ghost" data-job-del="${esc(row.id)}" style="color:var(--red)">删除定时任务</button>`);
    } else if (kind === "job") {
      rows.push(`<div class="sheet-sub">后台任务 · ${esc(row.stateText)}${row.evidence ? " · 有产出可查" : ""}</div>`);
      if (row.state === "running") {
        rows.push(`<button class="btn-ghost" data-mission-cancel="${esc(row.id)}" style="color:var(--red)">终止任务</button>`);
      } else {
        rows.push(`<button class="btn-primary" data-mission-rerun="${esc(row.id)}">重新跑一次</button>`);
        rows.push(`<button class="btn-ghost" data-job-del="${esc(row.id)}" style="color:var(--red)">删除记录</button>`);
      }
    } else if (kind === "team") {
      rows.push(`<div class="sheet-sub">团队任务 · ${esc(row.stateText)}${row.member ? " · " + esc(row.member) : ""}</div>`);
      // 这一条是任务板的投影：在这里删，下一次同步 onTeamTask 又把它加回来 ——
      // 所以不给一个「按了没用」的删除按钮，直接说清去哪儿取消。
      rows.push(`<div class="sheet-caption" style="margin:-4px 2px 10px">要取消或删掉，去团队面板的任务板上做；这里只是它的投影。</div>`);
      rows.push(`<button class="btn-primary" data-team-board="1">打开团队面板</button>`);
    } else {
      rows.push(`<div class="sheet-sub">${fmtWhen(row.at || 0)} · 本地任务 · ${row.state === "done" ? "已完成" : "仅记录，不会自己执行"}</div>`);
      rows.push(`<button class="btn-primary" data-job-edit="${esc(row.sourceId)}">编辑任务</button>`);
      rows.push(`<button class="btn-primary" data-job-done="${esc(row.sourceId)}">标记为完成</button>`);
      rows.push(`<button class="btn-ghost" data-job-del="${esc(row.id)}" style="color:var(--red)">删除任务</button>`);
    }
    return `<div class="sheet-title">${esc(row.title || "任务")}</div>${rows.join("")}`;
  };

  /** 文件长按：打开 / 删除（工作区与交付物是真文件，删除走内核沙箱） */
  const sheetFileActions = (f) => {
    const kind = f.kind;
    const isDir = !!f.isDir;
    const canDelete = kind !== "att" && !isDir;
    return `
      <div class="sheet-title">${esc(f.name)}${isDir ? "/" : ""}</div>
      <div class="sheet-sub">${kind === "work" ? "工作区文件" : kind === "out" ? "Agent 交付的文件" : "附件记录"}${f.path ? " · " + esc(f.path) : ""}</div>
      ${isDir && kind === "work" ? `<button class="btn-primary" data-file-open-dir="${esc(f.path)}">进入目录</button>` : ""}
      ${!isDir && kind !== "att" ? `<button class="btn-primary" data-file-open="${esc(f.path)}">预览</button>` : ""}
      ${!isDir && kind !== "att" && f.path ? `<button class="btn-ghost" data-file-external="${esc(f.path)}">用其它应用打开</button>` : ""}
      ${!isDir && kind !== "att" && f.path ? `<button class="btn-ghost" data-file-share="${esc(f.path)}">分享文件</button>` : ""}
      ${canDelete ? `<button class="btn-ghost" data-file-del="${esc(f.path)}" style="color:var(--red)">删除文件</button>` : ""}
      ${kind === "att" ? `<button class="btn-ghost" data-file-del-att="${esc(f.id)}" style="color:var(--red)">删除这条附件记录</button>` : ""}
      <button class="btn-ghost" data-close>取消</button>`;
  };

  /** 文件预览：docx/pptx/xlsx/文本走应用内渲染；其它交给系统应用 */
  function openFilePreview(path, opts) {
    const o = opts || {};
    const res = (Native && Native.openWorkspaceFile) ? Native.openWorkspaceFile(path) : "{}";
    let r = {};
    try { r = JSON.parse(res || "{}"); } catch (_) { r = { ok: false, error: "打开失败" }; }
    if (r && r.preview) {
      openSheet(sheetDocPreview(r));
      return true;
    }
    if (r && r.ok) return true;
    toast("打不开该文件：" + (r && r.error ? r.error : path));
    return false;
  }

  const KIND_LABEL = {
    docx: "Word 文档", pptx: "PPT 演示", xlsx: "表格", pdf: "PDF",
    table: "表格", json: "JSON", code: "代码", markdown: "Markdown",
    image: "图片", text: "文本", html: "HTML", error: "错误",
  };

  /** 预览正文：图片直显 base64，markdown 走前端渲染，html 进沙箱 iframe，其余用原生给的 html */
  function previewBody(pv) {
    if (pv.error) return `<div class="pv-empty">${esc(pv.error)}</div>`;
    if (pv.kind === "image") {
      if (!pv.data_base64) return `<div class="pv-empty">图片数据缺失</div>`;
      return `<img class="pv-img" alt="${esc(pv.name || "")}" src="data:${pv.mime || "image/png"};base64,${pv.data_base64}" />`;
    }
    if (pv.kind === "markdown" && pv.text) {
      return `<div class="pv-md">${md(pv.text)}</div>`;
    }
    if (pv.kind === "html") {
      // HTML 交 WebView 渲染：净化后的原文经 sandbox iframe 显示。
      // rc.97 起放行脚本（allow-scripts）—— Agent 产出的图表/动效/H5 才能活；
      // 桥隔离由 mountHtmlPreview 注入的 shim 完成（addJavascriptInterface 会
      // 注入所有 frame，光靠 sandbox 挡不住 DSHNative*）。
      pvHtmlPending = pv.text || "";
      return `<div class="pv-html-holder" id="pvHtmlHolder"></div>`;
    }
    if (pv.kind === "audio") {
      if (!pv.data_base64) return `<div class="pv-empty">音频数据缺失</div>`;
      return `<audio class="pv-audio" controls src="data:${pv.mime || "audio/wav"};base64,${pv.data_base64}"></audio>`;
    }
    if (pv.kind === "code") {
      return `<div class="pv-meta">${esc(pv.lang || "代码")}</div>` + (pv.html || "");
    }
    return pv.html || `<div class="pv-empty">没有可预览的内容</div>`;
  }

  /** HTML 预览的临时载体：iframe 的 srcdoc 走属性赋值，避开字符串转义地狱 */
  let pvHtmlPending = "";

  /* 预览 iframe 的桥隔离（必须是预览文档里第一个执行的东西）。
     addJavascriptInterface 把 DSHNative* 注入**所有 frame**，sandbox 只隔离同源/DOM，
     不隔离这些注入对象 —— 预览里的脚本能直接拿到内核工具权限。这里进文档先把自己
     这个 frame 的 window 上的原生接口全部抹掉；图表/动效照常跑，桥没了。
     同时用 meta CSP 禁掉 connect-src：预览里的脚本无法对外发请求（防外带数据）。 */
  const PV_BRIDGE_SHIM = "<script>(function(){try{" +
    "var hide=function(k){try{window[k]=undefined}catch(e){}" +
    "try{Object.defineProperty(window,k,{get:function(){return undefined},set:function(){},configurable:false})}catch(e){}};" +
    "var names=Object.getOwnPropertyNames(window);" +
    "for(var i=0;i<names.length;i++){if(/^DSHNative/.test(names[i]))hide(names[i]);}" +
    "if('DshPtc' in window)hide('DshPtc');" +
    "}catch(e){}})();<\/script>" +
    // 本地预览只允许内联/data:/blob: 资源：外链图片、脚本、fetch 全部发不出去
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'none'; form-action 'none'; base-uri 'none'\">";

  function mountHtmlPreview() {
    const holder = document.getElementById("pvHtmlHolder");
    if (!holder || !pvHtmlPending) return;
    const frame = document.createElement("iframe");
    frame.className = "pv-html";
    frame.setAttribute("sandbox", "allow-scripts"); // 放行脚本；仍禁同源/表单/弹窗
    frame.setAttribute("referrerpolicy", "no-referrer");
    // doctype 必须留在最前（否则预览整体掉进 quirks 模式）；shim 紧跟其后
    const m = /^\s*<!doctype[^>]*>/i.exec(pvHtmlPending);
    frame.srcdoc = m
      ? pvHtmlPending.slice(0, m.index + m[0].length) + PV_BRIDGE_SHIM + pvHtmlPending.slice(m.index + m[0].length)
      : PV_BRIDGE_SHIM + pvHtmlPending;
    holder.appendChild(frame);
    pvHtmlPending = "";
  }

  const sheetDocPreview = (pv) => `
    <div class="sheet-title">${esc(pv.title || pv.name || "预览")}</div>
    <div class="sheet-sub">${esc(KIND_LABEL[pv.kind] || pv.kind || "文件")} · ${pv.size ? fmtSize(pv.size) : ""} · 应用内预览</div>
    <div class="doc-preview ${pv.kind === "pptx" ? "is-pptx" : ""} ${pv.kind === "image" ? "is-image" : ""}">
      ${previewBody(pv)}
    </div>
    ${pv.path ? `<button class="btn-ghost" data-file-external="${esc(pv.path)}">用其它应用打开</button>` : ""}
    <button class="btn-ghost" data-close>关闭</button>`;

  /** 改归属：同一工作区的会话在列表里堆成一摞，所以这里改的就是「摞」 */
  const sheetMoveWs = (s) => `
    <div class="sheet-title">移动到工作区</div>
    <div class="sheet-sub">「${esc(s.title)}」属于 ${esc(wsEntry(s.ws).name)}</div>
    <div class="sheet-list">
      ${WORKSPACES.map((w) => `
        <button class="sheet-item ${wsId(s.ws) === w.id ? "is-on" : ""}" data-sess-ws="${esc(w.id)}" data-sess-id="${esc(s.id)}">
          <span class="nm">${esc(w.name)}<span class="desc">${esc(w.desc)}</span></span>
          <svg class="ico check"><use href="#i-check"/></svg>
        </button>`).join("")}
    </div>
    <button class="btn-ghost" data-close>取消</button>`;

  /** 滑动按钮里的删除：先确认，避免误触直接丢掉整个会话 */
  function sheetConfirmDeleteSession(s) {
    return `
      <div class="sheet-title">删除会话？</div>
      <div class="sheet-sub">「${esc(s.title)}」将被彻底删除</div>
      <button class="btn-primary" id="btnConfirmDelSession" data-rename-id="${esc(s.id)}"
        style="background:linear-gradient(170deg,#ff6b6b,#ff3b30)">删除</button>
      <button class="btn-ghost" data-close>取消</button>`;
  }

  function sheetRename(s) {
    return `
      <div class="sheet-title">重命名会话</div>
      <div class="field"><label>标题</label><input id="renameInput" value="${esc(s.title)}" /></div>
      <button class="btn-primary" id="btnDoRename" data-rename-id="${s.id}">保存</button>
      <button class="btn-ghost" data-close>取消</button>`;
  }

  function sheetPickSessions() {
    const list = localSessionView();
    return `
      <div class="sheet-title">删除会话</div>
      <div class="sheet-sub">删除后不可恢复</div>
      <div class="sheet-list">
        ${list.length ? list.map((s) => `
          <button class="sheet-item" data-pick="${s.id}">
            <span class="nm">${esc(s.title)}<span class="desc">${esc(s.time || "")}</span></span>
            <svg class="ico check"><use href="#i-check"/></svg>
          </button>`).join("") : `<div class="sheet-item"><span class="nm">还没有会话</span></div>`}
      </div>
      <button class="btn-primary" id="btnDeletePicked">删除所选</button>
      <button class="btn-ghost" data-close>取消</button>`;
  }

  // 长按：520ms，移动超过 8px 取消
  function attachLongPress(container, selector, cb) {
    if (!container) return;
    let timer = null, sx = 0, sy = 0;
    const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
    /* 长按已经弹面板后，手指抬起仍会产生一次 click —— 此刻面板已经盖在手指下面，
       这一下会落到「删除」之类的按钮上（实测能误删任务）。所以长按触发后装一个
       一次性捕获监听把紧随其后的 click 吞掉；800ms 内没有 click 就自动拆掉。 */
    let swallow = null;
    const armSwallow = () => {
      const kill = () => {
        if (swallow) { document.removeEventListener("click", swallow, true); swallow = null; }
      };
      swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); kill(); };
      document.addEventListener("click", swallow, true);
      setTimeout(kill, 800);
    };
    container.addEventListener("pointerdown", (e) => {
      const el = e.target.closest(selector);
      if (!el) return;
      sx = e.clientX; sy = e.clientY;
      clear();
      timer = setTimeout(() => {
        clear();
        haptic("medium");
        armSwallow();
        cb(el);
      }, 520);
    });
    container.addEventListener("pointermove", (e) => {
      if (timer && (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8)) clear();
    });
    container.addEventListener("pointerup", clear);
    container.addEventListener("pointercancel", clear);
    container.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  const currentMode = () => (state.mode === "host" && state.host ? "host" : "local");

  function endpointOf(m) {
    m = m || {};
    const base = (m.url || "").trim().replace(/\/+$/, "");
    // 账号模型不落 token：key 留空，原生侧按「端点 = api.deepseek.com/anthropic」现取登录态
    const key = m.auth === "account" ? "" : ((m.key || "").trim() || (state.account && state.account.key) || "");
    const fallback = /deepseek/i.test(m.upstream || m.id) ? DEFAULT_BASE.deepseek : "";
    return { url: base || fallback, key };
  }
  function localReady() {
    const m = findModel(state.model);
    const e = endpointOf(m);
    // 账号模型：就绪条件是有登录态，而不是有 key（桌面同理，凭据由账号服务解析）
    if (m && m.auth === "account") {
      let signed = false;
      try { signed = !!(Native && Native.accountState && JSON.parse(Native.accountState()).signedIn); } catch (_) {}
      return !!(e.url && signed);
    }
    return !!(e.url && e.key);
  }

  const estTokens = (s) => Math.ceil(String(s || "").length / 1.6);

  function systemPrompt(query) {
    const parts = ["你是 DeepSeek，一个严谨、直接的 AI 助手。默认用中文回答；代码放进 Markdown 代码块。"];
    /* 角色设定独立于「全局记忆」开关：它是人格指令，不是记忆条目。
       之前跟着 globalMem 走，关掉全局记忆角色就静默失效，属于 bug。 */
    const ps = personaPrompt();
    if (ps) parts.push(ps);
    if (state.globalMem) {
      // 只注入与当前问题相关的记忆，而不是把全部条目倒进去
      const brief = GlobalMem.briefing(query || "");
      if (brief) parts.push(brief);
    }
    const perm = PERMS.find((p) => p.id === state.perm) || PERMS[1];
    parts.push(`当前 Agent 权限：${perm.name}。本地模式只能对话，读写文件与执行命令需要连接宿主机。`);
    if (state.workspace) parts.push(`默认工作区：${state.workspace}。`);
    parts.push(state.askDanger
      ? "执行删除、覆盖、推送等危险操作前必须先说明并等待确认。"
      : "危险操作可直接执行，无需逐条确认，但要在结果里说明做了哪些改动。");

    /* 计划模式：等价于 Harness 的 plan:policy 段落（部署侧引导），但按手机端使用习惯改写：
       小屏、单线程、逐步验证，计划要能被一眼看完。 */
    const m = Modes.cur();
    if (m.plan && !m.planApproved) {
      parts.push([
        "【当前处于计划模式】先探索与设计，再执行。",
        "- 只能用只读工具收集信息（read / list_dir / glob / grep / stat）；写文件、改文件、删除、执行命令都已被禁用，不要尝试。",
        "- 信息够了就停止探索，调用 exit_plan_mode 提交完整计划，等待用户批准。",
        "- 计划用 Markdown，以 # 标题开头，包含：目标、现状要点、分步骤动作（每步说明改哪个文件/做什么）、验证方式、风险。",
        "- 手机上要短：步骤控制在 3–6 步，每步一句话，不要贴大段代码。",
        "- 用户批准前不要开始执行；用户要求修改时，按反馈修订后重新调用 exit_plan_mode。",
      ].join("\n"));
    }
    const g = m.goal;
    if (g && g.phase === "active") {
      parts.push([
        `【同会话目标 · ${goalRoundLabel(g, (g.rounds || 0) + 1)}】`,
        "目标：" + g.objective,
        "- 每轮先对照目标盘点：已完成什么、下一步做什么，只做还没完成的下一步，不要重复已完成的工作。",
        "- 阶段回复简短（3–5 行），说明本轮进展与下一步；不要复述整个目标。",
        "- 目标达成时调用 update_goal(status=complete, summary=已完成内容的简述)。",
        "- 无法推进（缺信息、缺权限、需要用户决策）时调用 update_goal(status=blocked, summary=原因)，不要空转。",
      ].join("\n"));
    }
    return parts.join("\n\n");
  }

  /* ---------------- 联网搜索（本地模式，自定义搜索接口） ---------------- */
  const SearchCfg = {
    get() {
      try { return JSON.parse(localStorage.getItem("dsh.search") || "{}") || {}; } catch (_) { return {}; }
    },
    set(v) { localStorage.setItem("dsh.search", JSON.stringify(v || {})); },
  };

  // 兼容 Bing 风格 {webPages:{value:[...]}}、Tavily {results:[...]}、顶层数组三种返回
  function parseSearchResp(data, n) {
    const items = Array.isArray(data) ? data
      : data.results || (data.webPages && data.webPages.value) || data.data || [];
    return items.slice(0, n).map((it) => ({
      title: it.title || it.name || "",
      url: it.url || it.link || "",
      snippet: it.snippet || it.content || it.description || it.summary || "",
    }));
  }

  async function webSearch(query, n) {
    const cfg = SearchCfg.get();
    if (!cfg.url) throw new Error("未配置搜索接口");
    const body = { query, max_results: n, count: n };
    if (cfg.key) body.api_key = cfg.key;
    let data;
    if (Native && Native.httpPostJson) {
      // 走原生代理：外部搜索接口大多不带 CORS 头，WebView 里 fetch 会被拦
      let raw;
      try { raw = JSON.parse(Native.httpPostJson(cfg.url, cfg.key || "", JSON.stringify(body))); }
      catch (_) { throw new Error("原生代理返回异常"); }
      if (raw.__status === -1) throw new Error(raw.__error || "网络错误");
      if (raw.__status < 200 || raw.__status >= 300) throw new Error("搜索接口 HTTP " + raw.__status);
      try { data = JSON.parse(raw.__body); } catch (_) { throw new Error("搜索接口返回不是 JSON"); }
    } else {
      const headers = { "content-type": "application/json" };
      if (cfg.key) headers.authorization = "Bearer " + cfg.key;
      const res = await fetch(cfg.url, { method: "POST", headers, body: JSON.stringify(body) });
      if (!res.ok) throw new Error("搜索接口 HTTP " + res.status);
      data = await res.json();
    }
    return parseSearchResp(data, n);
  }

  function searchCfgLabel() {
    const c = SearchCfg.get();
    if (!c.url) return "未配置";
    return `${c.on ? "已开启" : "已配置"} · 每问最多 ${c.max || 5} 条`;
  }
  // 调试入口：控制台可直接测试搜索链路
  window.DSHSearch = { cfg: SearchCfg, run: webSearch };

  const isCompactOn = () => state.compactMode !== "off";
  const compactThreshold = () => (state.compactMode === "aggressive" ? 0.7 : 0.9);
  const COMPACT_OPTIONS = [
    { id: "auto", name: "自动 · 90%", desc: "接近窗口上限 90% 时自动省略较早消息" },
    { id: "aggressive", name: "激进 · 70%", desc: "更早压缩历史，为输出留更多空间" },
    { id: "off", name: "关闭", desc: "不压缩；超出窗口上限时请求会被拒绝" },
  ];
  const compactLabel = () => (COMPACT_OPTIONS.find((o) => o.id === state.compactMode) || COMPACT_OPTIONS[0]).name;

  // 按上下文窗口裁剪历史；上下文压缩打开时补一条省略说明
  function buildMessages(history, userText, searchNote) {
    const ctx = TOKEN_LIMIT[state.context] || 131072;
    const outMax = TOKEN_LIMIT[state.maxOut] || 65536;
    const budget = Math.max(2048, Math.floor(ctx * compactThreshold()) - outMax);
    const msgs = [{ role: "system", content: systemPrompt(userText) }];
    if (searchNote) msgs.push({ role: "system", content: searchNote });
    // 会话记忆：结构化要点按相关度挑，轮次摘要只带最近几条，都只属于当前会话
    if (state.sessMem && Live.sessionId) {
      const mems = LocalDB.mems(Live.sessionId);
      const facts = mems.filter((m) => m.kind && m.kind !== "turn" && m.kind !== "概要");
      const turns = mems.filter((m) => !m.kind || m.kind === "turn" || m.kind === "概要");
      const q = memTokens(userText || "");
      const ranked = facts
        .map((m) => {
          const t = memTokens(m.topic + " " + m.text);
          let inter = 0;
          for (const k of t) if (q.has(k)) inter++;
          return { m, rel: q.size ? inter / Math.sqrt(q.size * Math.max(1, t.size)) : 0 };
        })
        .sort((a, b) => b.rel - a.rel)
        .map((x) => x.m);
      const picked = ranked.filter((m, i) => i < 6 || m.hits > 1).slice(0, 8);
      const lines = []
        .concat(picked.map((m) => `- ${m.text}`))
        .concat(turns.slice(0, 6).map((m) => `- ${m.text}`));
      if (lines.length) {
        msgs.push({ role: "system", content: "本会话记忆（此前对话的要点）：\n" + lines.join("\n") });
      }
    }
    const kept = [];
    let used = estTokens(userText) + 300;
    if (state.sessMem) {
      for (let i = history.length - 1; i >= 0; i--) {
        const cost = estTokens(history[i].content) + 8;
        if (used + cost > budget) break;
        kept.unshift({ role: history[i].role, content: history[i].content });
        used += cost;
      }
    }
    const dropped = history.length - kept.length;
    if (dropped > 0 && isCompactOn()) {
      msgs.push({ role: "system", content: `（较早的 ${dropped} 条消息因上下文窗口限制已省略，可开启更大的上下文窗口。）` });
    }
    msgs.push(...kept);
    msgs.push({ role: "user", content: userText });
    return msgs;
  }

  /* ---- 流式渲染 ----
     一段回复可能被工具调用切成多段（正文 → 工具 → 正文）。
     Live.text 是「正在输出的这一段」，Live.parts 是已经定稿的前面几段；
     节点严格按事件顺序 append，绝不再把正在输出的气泡搬到列表末尾
     （那是工具/回复错位的根因）。 */
  const Live = {
    id: null, sessionId: null,
    text: "", parts: [], textEl: null, textNode: null,
    thinkText: "",
    // 段级增量渲染（对齐桌面 incremental.ts）：sealedLen 是已冻结前缀长度，
    // activeEl 是承载未定稿尾部的轻量容器 —— 每次 paint 只重排尾部
    sealedLen: 0, activeEl: null,
    dirty: false, started: 0, turnStart: 0, model: "", cancelled: false, lastIsland: 0, paintTimer: 0,
    /** 这一轮还活着（beginLive 置 true，结束/停止/失败三条路径都置 false）——
        落快照时用它登记「回合未收尾」，重开时据此判断要不要补「没跑完」那行 */
    running: false,
    /** 重试计数与最近一次失败原因（只用于最终失败那一句话，不在中途出卡片） */
    retries: 0, retryReason: "",
    /** 本轮是否已经出过语音条：Agent 主动 speak 之后，轮末不应再自动补一条同内容的 */
    voiceShown: false, voiceKeys: [],
    /** 本轮压缩的账目（compacted 事件写入，turn_end 挂进 footer 的用量面板后清空） */
    compact: null,
  };

  /** 本轮完整正文（已定稿段 + 正在输出段） */
  function liveBody() { return (Live.parts.join("") + Live.text).trim(); }

  /* ---- 等待态（桌面 RunningStatus 同构）----
     电脑端是「鲸尾图标 + 扫光『深度求索中』」，超过 2 秒带用时（chat.deepDivingFor）。
     不再用三点跳动。 */
  const WHALE_PATH = "M8.844 13.742C8.967 12.328 8.45 10.4 8.45 9.65C8.45 8.94 8.88 8.43 9.6 8.43C11.285 8.43 12.106 8.281 12.685 8.104C13.71 7.791 14.585 6.768 15.055 5.945C15.137 5.803 14.99 5.641 14.829 5.671C13.829 5.86 12.828 5.376 11.827 4.978C10.659 4.514 9.491 4.707 8.935 4.876C8.805 4.915 8.658 4.819 8.636 4.686C8.468 3.643 7.405 2.615 5.498 2.238C4.54 2.048 3.748 1.574 3.347 1.202C3.252 1.113 3.088 1.125 3.03 1.242C2.628 2.059 2.168 3.82 5.248 6.115C5.82 6.494 6.31 6.785 6.574 7.637C6.72 8.104 6.157 9.168 6.061 9.368C5.157 11.27 5.089 12.19 4.926 13.742";

  function runStatLabel() {
    const s = Math.floor((Date.now() - (Live.turnStart || Date.now())) / 1000);
    if (EN()) return s >= 2 ? `Deep diving for ${s}s ···` : "Deep diving";
    return s >= 2 ? `深度求索中，用时 ${s} 秒 ···` : "深度求索中";
  }

  /** 鲸尾 + 扫光等待行的唯一构造器（本机 live 气泡与电脑会话 pcrunning 节点共用） */
  function whaleStatHTML(label) {
    return `<span class="runstat">` +
      `<span class="runstat-ico" aria-hidden="true"><i class="runstat-whale"></i><svg viewBox="0 0 16 16" fill="none"><path d="${WHALE_PATH}" stroke="currentColor" stroke-width="1"/></svg></span>` +
      `<span class="runstat-label is-shimmer"${shimmerAttr()}>${esc(label)}</span></span>`;
  }

  function runStatHTML() {
    return whaleStatHTML(runStatLabel());
  }

  /**
   * 「这句话还没说完」的身体语言：正文末尾三个跳动的点。
   *
   * 用户点名要的就是这个形态（不是光标）：正文说完一句带冒号、模型在写工具参数的那几秒里，
   * 文字块自己带着「还在写」的标记，就不会看起来像这一轮结束了。
   * 工具行出现 / 轮末时摘掉 —— 那时「正在运行命令」由过程组头表达。
   */
  function syncTypingDots() {
    if (!Live.running || !Live.textEl) return;
    let el = Live.textEl.querySelector(".typing-dots");
    if (!el) {
      el = document.createElement("span");
      el.className = "typing-dots";
      el.setAttribute("aria-hidden", "true");
      el.innerHTML = "<i></i><i></i><i></i>";
    }
    // 必须一直是最后一个子节点：paintLiveText 只会往后追加，点不能留在中间
    if (Live.textEl.lastElementChild !== el) Live.textEl.appendChild(el);
  }

  function clearTypingDots() {
    // 全流清一遍：封口（freezeText）之后气泡不再是 Live.textEl，
    // 只按 Live.textEl 找会漏掉刚封进去的那个 —— 轮末就会留三个点在正文尾巴上。
    document.querySelectorAll("#messages .typing-dots").forEach((el) => el.remove());
  }


  function startRunClock() {
    stopRunClock();
    Live.runClock = setInterval(() => {
      // 出正文 / 节点没了就自动收摊
      if (!Live.textEl || Live.text) { stopRunClock(); return; }
      const lab = document.querySelector("#messages .runstat-label");
      if (!lab) { stopRunClock(); return; }
      lab.textContent = runStatLabel();
    }, 1000);
  }

  function stopRunClock() {
    if (Live.runClock) { clearInterval(Live.runClock); Live.runClock = 0; }
  }

  /* ---- 内联 <think> 标签分流 ----
     MiniCPM / R1 系模型把思考以 <think>…</think> 直接内联在正文里（llama.cpp 不会
     拆成 reasoning_content）。按流式增量把 think 段摘出来送进思考通道，
     标签可能被切成两半，尾部留半个标签长度的缓冲。 */
  const ThinkSplit = {
    buf: "",
    inThink: false,
    reset() { this.buf = ""; this.inThink = false; },
    feed(chunk) {
      this.buf += String(chunk == null ? "" : chunk);
      let think = "", text = "";
      for (;;) {
        if (this.inThink) {
          const end = this.buf.indexOf("</think>");
          if (end === -1) {
            const keep = tagTail(this.buf, "</think>");
            think += this.buf.slice(0, this.buf.length - keep);
            this.buf = this.buf.slice(this.buf.length - keep);
            return { think, text };
          }
          think += this.buf.slice(0, end);
          this.buf = this.buf.slice(end + 8);
          this.inThink = false;
        } else {
          const start = this.buf.indexOf("<think>");
          if (start === -1) {
            const keep = tagTail(this.buf, "<think>");
            text += this.buf.slice(0, this.buf.length - keep);
            this.buf = this.buf.slice(this.buf.length - keep);
            return { think, text };
          }
          text += this.buf.slice(0, start);
          this.buf = this.buf.slice(start + 7);
          this.inThink = true;
        }
      }
    },
    /** 流结束：把缓冲吐干净 */
    flush() {
      const rest = this.buf;
      this.buf = "";
      const out = this.inThink ? { think: rest, text: "" } : { think: "", text: rest };
      this.inThink = false;
      return out;
    },
  };

  function tagTail(s, tag) {
    for (let l = Math.min(tag.length - 1, s.length); l > 0; l--) {
      if (s.endsWith(tag.slice(0, l))) return l;
    }
    return 0;
  }

  /** 增量进 think/text 两个通道（onDelta 与内核 delta 共用） */
  function feedStreamChunk(chunk) {
    const r = ThinkSplit.feed(chunk);
    if (r.think) Flow.think(r.think);
    if (r.text) {
      if (Flow.group && !Flow.group.closed) Flow.closeGroup();
      if (!Live.textEl) Flow.newText();
      Live.text += r.text;
      Live.dirty = true;
    }
  }

  /* ---------------- 对话流快照（会话记录不丢） ----------------
     thread 里的节点是纯数据对象，可以直接序列化；只要掐掉运行时字段和 base64，
     重开会话就能把「思考 / 工具调用 / 工具结果 / 用时 / token」原样还原。 */
  const SHOT_TEXT = 6000;
  const SHOT_OUT = 1600;
  const SHOT_ARGS = 800;
  const SHOT_IMG = 200 * 1024;

  function shotNode(v, depth, key) {
    if (v == null) return v;
    if (typeof v === "string") {
      const cap = key === "out" ? SHOT_OUT : key === "args" ? SHOT_ARGS : (depth > 1 ? 2000 : SHOT_TEXT);
      return v.length > cap ? v.slice(0, cap) + "\n…（已截断）" : v;
    }
    if (typeof v === "number" || typeof v === "boolean") return v;
    if (Array.isArray(v)) return v.map((x) => shotNode(x, depth + 1, key));
    if (typeof v === "object") {
      const o = {};
      for (const k of Object.keys(v)) {
        if (k.startsWith("__")) continue;                       // __uid 等运行时字段
        if (k === "dataUrl") {                                  // 大图不进快照，避免撑爆 localStorage
          const d = String(v[k] || "");
          o[k] = d.length <= SHOT_IMG ? d : "";
          continue;
        }
        o[k] = shotNode(v[k], depth + 1, k);
      }
      return o;
    }
    return null;
  }

  /** 把当前对话流写进会话（切会话 / 归档 / 每轮结束 / 流式期间每 8 秒） */
  function persistThread(sync) {
    if (!state.sessionId || currentMode() !== "local") return;
    const sid = state.sessionId;
    // **身份自检**：thread 必须就是 sid 那一份。不等说明有路径漏了 attachThread
    // （新建会话、目标模式、宿主切回、成员会话视图……）——此时写下去就是「A 的内容存进 B」。
    // 宁可这一轮不落盘（下次打开重建，数据不丢），也绝不写错会话。
    // 看成员会话时 thread 是 "team:…#名字" 那一份，这道判断同样会挡住它。
    if (thread.__sid !== sid) {
      console.warn("[thread] 身份不符，跳过落盘", { thread: thread.__sid, session: sid });
      return;
    }
    if (!thread.length) return;
    // 关键：**同步**深拷贝快照，再异步落盘。
    // 以前把 shotNode(thread) 放在 requestIdleCallback 里执行，而 thread 始终是同一个
    // 数组引用 —— 切会话时 openSession() 会先 thread.length=0 再灌新会话，空闲回调
    // 此时拷到的是「新会话内容」却写进旧 sid，于是「点 A 进去看到 B 的内容」（会话串号）。
    // 现在 thread 已按会话分桶（见 bucketOf/attachThread），加上这道自检，
    // 双保险：即使将来新增路径忘了换桶，也只会漏存、不会串号。
    const snapshot = shotNode(thread, 0, "");
    // 这一轮还活着才登记 `open`：重开时只有它能把「进程被杀」和「用户停掉/切走」分开
    const openAt = (Live.running && Live.sessionId === sid) ? (Live.turnStart || Date.now()) : 0;
    const snap = () => { try { LocalDB.saveShot(sid, snapshot, openAt); } catch (_) {} };
    // sync=true：调用方是「页面马上就不行了」（锁屏 / 切后台 / 被回收）。
    // requestIdleCallback 在隐藏页面里可能永远不触发，挪到空闲就等于这一趟白丢。
    if (sync || !window.requestIdleCallback) snap();
    else requestIdleCallback(snap, { timeout: 2000 });
  }

  /** 流式绘制：按帧画，另加一个兜底定时器。
      - 用 rAF 把节奏交给屏幕刷新（16.7ms），流式观感才与桌面端一致；
        原先固定 48/60/80ms 是「12~20 帧/秒」，快模型下肉眼就是一顿一顿的。
      - 但 rAF 在「一轮很快结束」时可能根本来不及跑（后台标签/被节流的 WebView 更甚），
        正文会停在打字点上 —— 所以同时挂一个 setTimeout 兜底：谁先到谁画。
      - 单次成本是 O(尾部)（paintLiveText 的段级增量），所以按帧画不会放大开销。 */
  function schedulePaint() {
    if (Live.paintTimer) return;
    const n = (Live.text || "").length + (Live.thinkText || "").length;
    const fallback = n > 6000 ? 80 : n > 2500 ? 60 : 48;   // 兜底间隔沿用原自适应值
    const fire = () => { if (Live.paintTimer) clearTimeout(Live.paintTimer); Live.paintTimer = 0; livePaint(); };
    const raf = window.requestAnimationFrame(fire);
    Live.paintTimer = setTimeout(() => { cancelAnimationFrame(raf); fire(); }, fallback);
  }

  /** 清掉段级增量状态：新一段正文开始 / 整体重建前调用 */
  function resetSealed() {
    Live.sealedLen = 0;
    Live.activeEl = null;
    Live.bounds = null;        // 增量扫描缓存（见 sealedCut）
    Live.scanFrom = 0;
    Live.fenceOdd = 0;
    Live.paintedTail = "";
  }

  /* ---- 段级增量渲染（对齐桌面 IncrementalMarkdownParser）----
     桌面端只重解析尾部 UNSTABLE_TAIL_BLOCKS=2 个块，其余块解析一次后永久冻结；
     这里同理：定稿点之前的前缀整段 md() 一次后直接 insertAdjacentHTML，
     不再参与 morph —— 每次 paint 只对「最后 2 个块」做 md() + morphHTML，
     单次成本从 O(全文) 降为 O(尾部)，打字越到后面越卡的问题从根上解决。
     定稿点只落在双换行块边界，且围栏必须闭合、冻结区末行不能是列表/引用/表格行
     （下一块可能是同一结构的延续）；livePaint(true) 忽略缓存全量重建一次，
     自愈任何跨冻结边界的结构（等价桌面的 renderSettled 收尾）。

     sealedCut 原实现对全文做三遍 O(n) 扫描（\n\n 边界、两次 ``` 计数），
     每次 paint 都跑一遍 —— 正文一长这本身就是卡顿源。现在块边界与围栏奇偶
     随正文增量扫描缓存（Live.bounds / Live.fenceOdd），单次 paint 只做 O(新增) 与 O(尾部)。 */
  const MD_SEAL_TAIL_BLOCKS = 2;

  function prevBound(bounds, cut) {
    for (let i = bounds.length - 1; i >= 0; i--) if (bounds[i] < cut) return bounds[i];
    return 0;
  }

  /** 增量扫描新增正文：块边界（\n\n 结束下标）进 Live.bounds，``` 奇偶进 Live.fenceOdd。
      文本只追加不回退。回退量按模式长度各取所需（\n\n 回 1、``` 回 2），
      跨 chunk 边界的模式补上、又不与上一轮重复计数。 */
  function scanStreamText(text) {
    const from1 = Math.max(0, (Live.scanFrom || 0) - 1);   // \n\n（2 字符）
    const from3 = Math.max(0, (Live.scanFrom || 0) - 2);   // ```（3 字符）
    let i = text.indexOf("\n\n", from1);
    while (i !== -1) {
      if (!Live.bounds) Live.bounds = [];
      Live.bounds.push(i + 2);
      i = text.indexOf("\n\n", i + 1);
    }
    let c = 0, j = text.indexOf("```", from3);
    while (j !== -1) { c++; j = text.indexOf("```", j + 3); }
    Live.fenceOdd = ((Live.fenceOdd || 0) + c) & 1;
    Live.scanFrom = text.length;
  }

  /** 计算安全定稿点（字符下标）；返回 0 表示本轮不冻结（全走活动段，行为同旧版） */
  function sealedCut(text) {
    if (!text) return 0;
    scanStreamText(text);
    const bounds = Live.bounds || [];
    if (bounds.length < MD_SEAL_TAIL_BLOCKS) return 0;
    // 围栏奇偶：全文奇偶（缓存）⊕ 尾段 [cut, len) 奇偶（尾段很短，现场数）= head 奇偶
    const fenceAt = (cut) => (Live.fenceOdd ^ (((text.slice(cut).match(/```/g) || []).length) & 1)) & 1;
    let cut = bounds[bounds.length - 1 - MD_SEAL_TAIL_BLOCKS];
    for (let guard = 0; guard < 8 && cut > 0; guard++) {
      // 代码围栏没闭合：绝不能从围栏中间定稿
      if (fenceAt(cut) === 1) { cut = prevBound(bounds, cut); continue; }
      // 冻结区末行是列表/引用/表格行：下一个块可能是同一结构的延续，暂不冻结
      const nl = text.lastIndexOf("\n", cut - 1);
      const lastLine = text.slice(nl + 1, cut).trim();
      if (/^([-*+]|\d+[.)]|>|\|)/.test(lastLine)) { cut = prevBound(bounds, cut); continue; }
      break;
    }
    if (cut <= 0) return 0;
    return fenceAt(cut) === 1 ? 0 : cut;
  }

  /** 正文流式绘制：冻结前缀一次性插入，活动段才走 morph */
  function paintLiveText(force) {
    const el = Live.textEl;
    if (!el) return;
    // 非追加输入（回退/改写）：丢掉段级增量缓存、全量重建一次 —— 等价电脑端
    // IncrementalMarkdownParser 的 generation++（非追加时调用方丢弃冻结前缀）。
    // 对齐后即便上游次序异常，也不会留下错位的冻结边界（表现为视觉截断）。
    if (!force && Live.scanFrom && Live.text.length < Live.scanFrom) force = true;
    if (force) {
      // 定稿/收尾：全量解析一次，等价桌面的 renderSettled（自愈跨冻结边界结构）
      el.innerHTML = md(Live.text);
      resetSealed();
      return;
    }
    const cut = sealedCut(Live.text);
    if (cut > (Live.sealedLen || 0)) {
      const newly = Live.text.slice(Live.sealedLen || 0, cut);
      const html = md(newly);
      if (Live.activeEl && Live.activeEl.isConnected) Live.activeEl.insertAdjacentHTML("beforebegin", html);
      else el.insertAdjacentHTML("beforeend", html);
      Live.sealedLen = cut;
    }
    const tail = Live.text.slice(Live.sealedLen || 0);
    if (!Live.activeEl || !Live.activeEl.isConnected) {
      Live.activeEl = document.createElement("div");
      Live.activeEl.className = "md-live";
      el.appendChild(Live.activeEl);
    }
    if (tail) {
      // 活动段没变就别重排：md() 解析 + morph 是一次真实的 DOM 重建，
      // 而「光标/滚动」引发的重绘并不需要它（实测里每帧 65ms 的一大部分在这）
      if (tail !== Live.paintedTail) {
        Live.paintedTail = tail;
        morphHTML(Live.activeEl, md(tail));
      }
    } else if (Live.activeEl.firstChild) {
      Live.paintedTail = "";
      morphHTML(Live.activeEl, "");
    }
  }

  /** 流式跟手滚动：只在下一次 rAF 里写一次 scrollTop（同帧多次 paint 合并） */
  function streamFollow() {
    if (!followBottomOn) { ChatScroll.release(); try { ChatExtras.markNew(); } catch (_) {} return; }
    ChatScroll.adopt();
    const sc = $("#chatScroll");
    if (!sc || sc.__rafPending) return;
    sc.__rafPending = true;
    requestAnimationFrame(() => {
      sc.__rafPending = false;
      // 必须走 setScrollTop（behavior:instant）：直接写 sc.scrollTop 会被 CSS
      // scroll-behavior 接管，每帧写入 = 每次重启动画，视口永远追不上流式内容。
      // 记账在 ChatScroll._write 里做：自己写的滚动不算用户意图。
      ChatScroll.stick(sc);
    });
  }

  /**
   * 批次收尾后的贴底：连续 3 帧各写一次。
   *
   * 一轮消息落进 DOM 时高度会变（草稿换成正式消息、图片解码、字体回退），
   * 浏览器可能在某一帧把 scrollTop 钳在旧的最大值上 —— 单次 rAF 写一次不够，
   * 下一帧又被钳回去，看起来就是「消息列表自己上下滚」。
   */
  function settleFollow() {
    if (!followBottomOn) return;
    const sc = $("#chatScroll");
    if (!sc) return;
    let left = 3;
    const step = () => {
      if (left-- <= 0 || !followBottomOn) return;
      ChatScroll.toBottom(sc);
      if (left > 0) requestAnimationFrame(step);
    };
    step();
  }

  function livePaint(force) {
    if (!force && !Live.dirty) return;
    Live.dirty = false;
    // 增量同步：整段 innerHTML 重写会让已经输出完的段落重新排版 → 视觉跳动
    if (Live.textEl) {
      if (Live.text) {
        // 正文首帧就摘掉「深度求索中」占位行。桌面 RunningStatus 是独立一行、
        // running 结束时整体卸载；这里它住在流式气泡里，而 paintLiveText 的
        // 增量路径只往 .assistant-text 里 append、从不重写 innerHTML ——
        // 不摘的话它会一直钉在回复顶部（正文在它下面长出来）。
        const stat = Live.textEl.querySelector(".runstat");
        if (stat) stat.remove();
        paintLiveText(force);
        syncTypingDots();          // 正文在长 / 停顿时，末尾都带着「还在写」的三个点
      }
      else if (!Live.textEl.querySelector(".runstat")) Live.textEl.innerHTML = runStatHTML();
    }
    // 模型与 DOM 同步：万一一轮中途整表重绘，已输出的正文不会丢
    if (Live.textNode) Live.textNode.text = Live.text;
    streamFollow();                    // 流式：贴底；读取 scrollHeight 放到 rAF 里，避免 JS 任务中途强制排版
    // 流式期间每 8 秒落一次快照：进程被杀 / 直接退出也能留下已产出的过程
    // （原 3 秒：shotNode 全量深拷贝 + 同步写 localStorage 都在主线程，长对话明显拖慢流式；
    //   收尾/切会话/轮末仍有强刷，最多丢 8 秒过程可接受）
    const nowP = Date.now();
    if (nowP - (Live.lastPersist || 0) > 8000) {
      Live.lastPersist = nowP;
      // 深拷贝 + JSON.stringify + 写 localStorage 都在主线程，长对话下是一次可见的卡顿。
      // 流式期间挪到空闲时段（有 2s 兜底，最坏也就晚一点落盘）。
      const fire = () => { try { persistThread(); } catch (_) {} };
      if (window.requestIdleCallback) requestIdleCallback(fire, { timeout: 2000 });
      else setTimeout(fire, 0);
    }
    // 运行通知进度：节流 1s，把最新回复片段送去系统通知
    try {
      if (Native && Native.sessionProgress) {
        const now = Date.now();
        if (now - (Live.lastIsland || 0) > 1000) {
          Live.lastIsland = now;
          const brief = (Live.text.trim() || Live.thinkText.trim()).replace(/\s+/g, " ").slice(0, 120);
          if (brief) Native.sessionProgress(brief, Live.sessionId || state.sessionId || "");
        }
      }
    } catch (_) {}
  }

  /* ---------------- 过程流（桌面 process-groups / turn-process 同构） ----------------
     一轮里相邻的思考/工具归入一个过程组；正文出现即截断当前组（桌面 rebuild 的 reply flush）；
     轮次结束把本轮所有组合并成一条「已完成，用时 N 秒」的折叠行（桌面 TurnProcessNodeView），
     点开才展开每一步 —— 和电脑端一模一样的信息层级。 */
  const Flow = {
    group: null,
    groups: [],
    _byId: {},

    turnStart() { this.group = null; this.groups = []; this._byId = {}; },

    /** 结束当前正文段：有内容就原地定稿，空节点直接删掉 */
    freezeText() {
      if (!Live.textEl) return;
      livePaint(true);                      // 先把最后一块画到 DOM
      clearTypingDots();                    // 封口前的重绘会把点加回来；这一行必须在其后
      if (Live.text.trim()) {
        Live.parts.push(Live.text);
        if (Live.textNode) { Live.textNode.text = Live.text; Live.textNode.live = false; }
        Live.text = "";
        Live.textEl = null;
        Live.textNode = null;
      } else {
        const wrap = Live.textEl.closest(".msg");
        if (wrap) wrap.remove();
        const i = Live.textNode ? thread.indexOf(Live.textNode) : -1;
        if (i >= 0) thread.splice(i, 1);
        Live.textEl = null; Live.textNode = null; Live.text = "";
      }
    },

    /** 工具之后继续输出：在流末尾新开一段正文（不搬动已有节点） */
    newText() {
      if (Live.textEl) return;
      const node = NODES.text("");
      node.live = true;
      Live.textNode = node;
      const el = push(node, true);
      Live.textEl = $(".assistant-text", el);
      Live.textEl.innerHTML = runStatHTML();
      Live.text = "";
      resetSealed();               // 新段正文：段级增量状态从零开始
      startRunClock();
    },

    ensureGroup() {
      if (this.group && !this.group.closed) return this.group;
      // 过程组必须排在「已经说过的正文」之后：先把当前正文段定稿（空占位节点删掉），
      // 后面的正文再另起节点 —— 这是时间顺序不被工具行打断的关键。
      this.freezeText();
      const g = NODES.pgroup();
      g.started = Date.now();
      this.group = g;
      this.groups.push(g);
      push(g, true);
      return g;
    },

    /** 当前过程组收口（正文出现 / 提问 / 计划 / 审批边界） */
    closeGroup() {
      const g = this.group;
      if (!g || g.closed) return;
      g.closed = true;
      g.running = null;
      markThinksDone(g);
      // 这一段过程结束（正文/提问/计划边界）：组体收回一行，正文接上视线
      g.open = false;
      patchNode(g);
    },

    /**
     * 这一轮中间发生了「动作」（发表情、发图）：把当前这一段就地收口。
     *
     * 不收口的后果就是时序倒放：表情已经落在对话里，模型下一轮的思考还在它上面那段里
     * 继续长 —— 因为工具执行完 `this.group` 仍是开着的，新思考会并回同一个组。
     * 收口之后，后面的思考/正文必然另起一段，落在表情下面，跟人「说完 → 甩个表情 → 接着说」一致。
     */
    cut() {
      this.freezeText();
      this.closeGroup();
    },

    /** 思考增量：并入组内 think 行；摘要变了才重绘，展开时直接改正文 */
    think(text) {
      if (Live.text.trim()) this.freezeText();   // 正文之后又开始思考 → 新组
      const g = this.ensureGroup();
      let m = g.members[g.members.length - 1];
      if (!m || m.type !== "think" || m.status !== "run") {
        // 思考默认**回缩**：组头一行「正在思考…」跟着摘要走，正文要点开才看。
        // 以前是「一出现就展开」，代价是每 token 整段重排（一直闪）＋回答被顶走；
        // 收起后每 token 只改摘要一行字，展开/收尾由用户与 markThinksDone 接管。
        m = { type: "think", cat: "thinking", status: "run", text: "", open: false, auto: true };
        g.members.push(m);
        g.counts.thinking = (g.counts.thinking || 0) + 1;
        if (g.order.indexOf("thinking") < 0) g.order.push("thinking");
        g.running = { cat: "thinking", detail: "" };
        this._thinkSum = "";
        // 组体保持收起：把行补进组体（懒渲染，展开组时按模型重绘一次），组头就地刷新
        this.appendGroupRow(g, m);
        this.paintGroupHead(g);
        scrollToBottom();
      }
      m.text += text || "";
      Live.thinkText = m.text;
      // 「展开态」= 组展开且这一行也展开：只有这时正文可见、才走节流的正文更新。
      // 组被收起时（哪怕这一行还记得 open=true）用户看的是组头那一行 —— 摘要要继续更新，
      // 否则展开过一次、收起之后整个组头就停在半句话上（用户实测：显示卡住不再更新）。
      if (m.open && g.open) {
        // 展开态：每 token 重排整段思考正文 = 一直闪。改成节流 + 就地增量更新。
        this.paintOpenThink(g);
        return;
      }
      const sum = thinkSummary(m);
      if (sum !== this._thinkSum) {
        this._thinkSum = sum;
        // 收起态只改组头一行文字：正文行等展开/收尾时再渲染（每 token 重排整组才是闪的根源）。
        // 摘要要挂到 running.detail 上，组头那行才跟着走 —— 用户想的时候看到的就是组头这一行。
        if (g.running && g.running.cat === "thinking") g.running.detail = sum;
        this.paintGroupHead(g);
        // 组展开着、这一行没展开：组头只剩「分析中」，用户看的是组内那一行摘要 ——
        // 它也得跟着输出走（以前是 patchNode 那一刻的快照，之后再也不更新，看着像卡住）。
        if (g.open) {
          const sel = `#messages [data-uid="${nodeUid(g)}"] [data-pg-row="${g.members.indexOf(m)}"]`;
          const sumEl = document.querySelector(sel + " .pg-sum");
          if (sumEl) {
            sumEl.textContent = sum;
            syncThinkTail();
          } else if (document.querySelector(sel)) {
            // 这一行是思考刚冒头时补进 DOM 的，那时还没有任何字 → 摘要节点整段没被渲染出来。
            // 只写 textContent 就永远找不到落点，组内这一行此后只剩「思考」两个字（用户实测）。
            this.patchGroupRow(g, m);
          }
        }
        scrollToBottom();
      }
    },

    /** 只重画组体（新增一步 / 工具状态变化），组头元素保持不动 */
    renderGroupBody(g) {
      if (!g) return;
      const sel = `#messages [data-uid="${nodeUid(g)}"]`;
      const body = document.querySelector(sel + " .pgroup-body, " + sel + " .tp-body");
      if (!body) return;
      morphHTML(body, pgroupRowsHTML(g) || '<div class="pg-empty">…</div>');
      syncThinkTail();          // 组体重排后行宽会变，钉的位置要跟着重算
    },

    /** 组体增量：把新成员一行 append 到组体末尾，不重建整组
        （members 只 push 不删，index 稳定 —— 桌面端工具行是独立节点的同构做法） */
    appendGroupRow(g, m) {
      if (!g) return;
      const sel = `#messages [data-uid="${nodeUid(g)}"]`;
      const body = document.querySelector(sel + " .pgroup-body, " + sel + " .tp-body");
      if (!body) { this.renderGroupBody(g); return; }
      const empty = body.querySelector(".pg-empty");
      if (empty) empty.remove();
      const i = g.members.indexOf(m);
      if (i < 0) { this.renderGroupBody(g); return; }
      body.insertAdjacentHTML("beforeend", m.type === "think" ? thinkRowHTML(m, i) : toolRowHTML(m, i));
    },

    /** 组体单行增量：只 morph 变化的那一行；行不在 DOM（组体刚折叠/重建）时回退整组重画 */
    patchGroupRow(g, m) {
      if (!g) return;
      const i = g.members.indexOf(m);
      const sel = `#messages [data-uid="${nodeUid(g)}"]`;
      const body = document.querySelector(sel + " .pgroup-body, " + sel + " .tp-body");
      if (i < 0 || !body) { this.renderGroupBody(g); return; }
      const row = body.querySelector(`[data-pg-row="${i}"]`);
      if (!row) { this.renderGroupBody(g); return; }
      morphOuter(row, m.type === "think" ? thinkRowHTML(m, i) : toolRowHTML(m, i));
    },

    /** 工具执行期反馈（对齐桌面 RunningStatus 的 1Hz 慢时钟）：
        长审批/慢工具期间界面不再完全静止，运行中行显示已运行秒数。
        1s tick 不参与 paint 循环；没有运行中的行就自动停表。 */
    startToolClock() {
      if (this._toolClock) return;
      this._toolClock = setInterval(() => {
        const rows = document.querySelectorAll("#messages [data-run-ms]");
        if (!rows.length) { clearInterval(this._toolClock); this._toolClock = 0; return; }
        const now = Date.now();
        rows.forEach((el) => {
          const t0 = Number(el.getAttribute("data-run-ms")) || 0;
          if (t0) el.textContent = Math.max(1, Math.round((now - t0) / 1000)) + " s";
        });
      }, 1000);
    },

    /** 收起态就地改组头：不动 DOM 结构，扫光动画不被重启 */
    paintGroupHead(g) {
      const el = document.querySelector(`#messages [data-uid="${nodeUid(g)}"]`);
      if (!el || g.folded) return;
      const lab = el.querySelector(".pg-label");
      const title = pgroupTitle(g);
      if (lab && lab.textContent !== title) {
        lab.textContent = title;
        // 组头这一行是「每个 token 改一次文字」的直写路径，不走 patchNode：
        // 就地重钉，钉的距离就是刚写进去的那点字 —— 滚动速度 = 输出速度。
        syncThinkTail();
      }
      const box = el.querySelector(".pgroup");
      if (box) {
        box.classList.toggle("is-done", !!g.closed);
        box.classList.toggle("is-run", !g.closed);
      }
      const use = el.querySelector(".pg-lead .pg-act use");
      const icon = g.closed
        ? (g.members[0] && g.members[0].type === "think" ? "i-d-think" : (CAT_ICON[g.members[0] && g.members[0].cat] || "i-d-sparkle"))
        : (CAT_ICON[g.running && g.running.cat] || "i-d-sparkle");
      if (use && use.getAttribute("href") !== "#" + icon) use.setAttribute("href", "#" + icon);
    },

    /** 展开的思考正文：80ms 节流，就地增量同步（保留已渲染段落与滚动位置） */
    paintOpenThink(g) {
      this._thinkG = g || this.group;
      if (this._thinkTimer) return;
      this._thinkTimer = setTimeout(() => {
        this._thinkTimer = 0;
        const gg = this._thinkG;
        if (!gg) return;
        const mm = [...gg.members].reverse().find((x) => x && x.type === "think");
        if (!mm) return;
        const sel = `#messages [data-uid="${nodeUid(gg)}"] [data-pg-row="${gg.members.indexOf(mm)}"]`;
        const bodyEl = document.querySelector(sel + " .pg-think-text");
        if (bodyEl) {
          // 展开正文有自己的高度上限（styles.css），新字是加在下面的：
          // 默认贴底跟随；用户往上翻过（scroll 监听打了 stick=0）就别动他 ——
          // 否则展开后看着像「卡住不再更新」（文字在可见区外面长）。
          const stick = bodyEl.dataset.stick !== "0";
          morphHTML(bodyEl, md(mm.text || ""));
          if (stick) bodyEl.scrollTop = bodyEl.scrollHeight;
        }
        const sumEl = document.querySelector(sel + " .pg-sum");
        if (sumEl) {
          sumEl.textContent = thinkSummary(mm);
          syncThinkTail();                 // 组内那一行也跟到最新（组头同样由它钉）
        }
        if (followBottomOn) scrollToBottom();   // 整页贴底跟随；用户翻上去后就不动
      }, 80);
    },

    toolStart(ev) {
      clearTypingDots();         // 工具行自己会说明「正在跑」，点不能留在封口后的正文里
      this.freezeText();
      // 子代理是一条独立的顶层工具行：不进过程组（组一折叠就看不见了），始终可见
      if (ev.name === "subagent" || ev.name === "subagent_fork") {
        const detail = toolDetail(ev.name, ev.args || "") || "";
        const early = subagentState.get(ev.id);
        if (early) {
          // 进度事件先到时已经建过这一行（否则会插出两条一模一样的子代理行）
          early.task = early.task || detail;
          early.open = true;
          patchNode(early);
          return;
        }
        const node = NODES.subrow({ id: ev.id, task: detail, lines: [], result: "", done: false, open: true });
        subagentState.set(ev.id, node);
        push(node, true);
        return;
      }
      const g = this.ensureGroup();
      const runThinks = g.members.filter((x) => x.type === "think" && x.status === "run");
      markThinksDone(g);
      const cat = toolCategory(ev.name);
      const m = {
        type: "tool", id: ev.id, name: ev.name, cat,
        title: TOOL_LABEL[ev.name] || (TOOL_META[cat] && TOOL_META[cat].label) || ev.name,
        detail: toolDetail(ev.name, ev.args || ""),
        args: ev.args ?? "",   // 对象/字符串都原样存，fmtArgs 会分别处理（String(obj) 会变成 "[object Object]"）
        diff: toolDiff(ev.name, ev.args),
        imagePath: imagePathOf(ev.name, ev.args),

        status: "run", out: "", ms: 0, open: false, startedAt: Date.now(),
      };
      g.members.push(m);
      g.counts[cat] = (g.counts[cat] || 0) + 1;
      if (g.order.indexOf(cat) < 0) g.order.push(cat);
      g.running = { cat, detail: m.detail, name: ev.name };
      (this._byId[ev.id] || (this._byId[ev.id] = [])).push(m);
      // 有工具在跑也保持展开：不然「正在编辑文件」这类行藏在折叠体里，等于没渲染
      if (!g.open) {
        g.open = true;
        patchNode(g);            // 整节点重渲染：组体里已含全部行（含刚 push 的这行）
      } else {
        this.appendGroupRow(g, m);   // 组体已开着：只追加新行，不整组重建
      }
      // 刚被收口的思考行状态变了（run→done / 自动收起）：只 patch 那几行
      runThinks.forEach((tm) => this.patchGroupRow(g, tm));
      this.paintGroupHead(g);
      scrollToBottom();
      this.startToolClock();
      return m;
    },

    toolEnd(id, res) {
      const q = this._byId[id];
      const m = q && q.length ? q.shift() : null;
      if (!m) return;
      m.__live = "";                     // 实时输出只是过程，结果一到就以 tool_end 的 output 为准
      m.status = (res && (res.ok === false || res.error)) ? "err" : "done";
      m.out = res && res.denied ? (res.output || "已拒绝") : String((res && res.output) == null ? "" : res.output);
      m.ms = (res && res.ms) || 0;
      // 退出码：只有工具结果里带了才画徽标（终端/后台任务类），没有就维持原样
      m.exitCode = (res && typeof res.exitCode === "number") ? res.exitCode : null;
      // 截图类工具的结果是 JSON，路径在里面
      if (m.name === "phone_screenshot" && !m.imagePath) {
        try {
          const d = JSON.parse(m.out || "{}");
          if (d && d.ok && d.path) m.imagePath = d.path;
        } catch (_) {}
      }
      // replace_all：结果里带「替换 N 处」，把单次增减乘上去，读数才和桌面一致
      if (m.diff && /替换\s*(\d+)\s*处/.test(m.out)) {
        const hits = Number(RegExp.$1) || 1;
        if (hits > 1) m.diff = { added: m.diff.added * hits, removed: m.diff.removed * hits };
      }
      const g = this.group;
      if (g && !g.closed) {
        const running = g.members.filter((x) => x.status === "run");
        const last = running[running.length - 1];
        g.running = last ? { cat: last.cat, detail: last.detail, name: last.name } : null;
        this.patchGroupRow(g, m);    // 只 morph 变化的这一行，不重建整组
        this.paintGroupHead(g);
      }
      scrollToBottom();
    },

    /**
     * 工具运行中的实时输出：内核读一块、合帧器攒一段（见 StreamCoalescer.feedOutput），
     * 这里只改这一行的数据再 morph 这一行 —— 整组重绘会把已经渲染的节点全重写一遍。
     */
    toolOutput(id, chunk) {
      if (!id || !chunk) return;
      const q = this._byId[id];
      const m = q && q.length ? q[q.length - 1] : null;
      // 找不到行、或这一行已经落定：迟到的输出不该改写已经画完的行
      if (!m || m.status !== "run") return;
      const acc = (m.__live || "") + chunk;
      m.__live = acc.length > LIVE_OUT_MAX ? acc.slice(-LIVE_OUT_MAX) : acc;
      this.queueLivePatch(m);
    },

    /** 实时输出按 120ms 合批 morph：一块刷一次会把主线程占满（洪峰在桥出口已削过一层） */
    queueLivePatch(m) {
      (this._liveQ || (this._liveQ = new Set())).add(m);
      if (this._liveTimer) return;
      this._liveTimer = setTimeout(() => {
        this._liveTimer = 0;
        const q = this._liveQ;
        this._liveQ = null;
        (q || []).forEach((mm) => {
          const g = this.groups.find((x) => x.members.indexOf(mm) >= 0);
          if (!g || g.closed) return;
          this.patchGroupRow(g, mm);
          // 展开着看输出时贴底跟随最新一行（用户上翻过就不动他）—— 与思考正文同一套
          const secs = document.querySelectorAll(
            `#messages [data-uid="${nodeUid(g)}"] [data-pg-row="${g.members.indexOf(mm)}"] .io-sec`);
          const box = secs.length ? secs[secs.length - 1] : null;
          if (box && box.dataset.stick !== "0") box.scrollTop = box.scrollHeight;
        });
        syncThinkTail();
        if (followBottomOn) scrollToBottom();
      }, 120);
    },

    /** 工具过程里的附加行（子代理每步），并进该工具的展开正文 */
    note(m, text) {
      if (!m || !text) return;
      const line = "· " + String(text);
      m.out = m.out ? m.out + "\n" + line : line;
      this.patchGroupRow(this.group, m);
    },

    /** 轮次收尾：每个过程组原地折叠（第一条升级成「已完成，用时」行），绝不搬运节点 */
    settle(secs, end) {
      clearTypingDots();          // 轮末兜底：任何延后的一帧都不许把点留在正文尾巴上
      const groups = this.groups.filter((g) => thread.indexOf(g) >= 0);
      // 轮次结束，这一轮的**每个**过程组都要折成一行 —— 只收 Flow.groups 会漏：
      // `closeGroup`（正文/边界）只置 closed，折叠是 settle 才做的，所以「本轮里已经收口、
      // 但不在结算名单上的组」（重载后从快照重建的那一类，或认领之前建立的那一批）
      // 会永远停在不折叠的状态（探针 loose 计数按 folded 判，实测偶发 1 个）。
      // 名单合并后按流里的位置排：`turnLabel`（「已完成，用时 N 秒」）要落在本轮第一个组上。
      let lastUser = -1;
      for (let i = thread.length - 1; i >= 0; i--) {
        if (thread[i] && thread[i].kind === "user") { lastUser = i; break; }
      }
      for (let i = lastUser + 1; i < thread.length; i++) {
        const g = thread[i];
        if (g && g.kind === "pgroup" && !g.folded && groups.indexOf(g) < 0) groups.push(g);
      }
      groups.sort((a, b) => thread.indexOf(a) - thread.indexOf(b));
      this.groups = []; this.group = null; this._byId = {};
      if (!groups.length) { this.settleEmpty(secs, end); return false; }
      let has = false;
      groups.forEach((g, i) => {
        g.members.forEach((m) => { if (m.status === "run") m.status = "done"; });
        g.closed = true; g.running = null;
        g.folded = true;                     // 每个过程组都原地折成一行，谁都不搬家
        g.open = false;                      // 轮次结束：折叠行下面默认不摊开
        g.turnLabel = i === 0;               // 只有第一条是桌面 turn-process（用时）
        if (i === 0) { g.secs = secs; g.end = end || ""; }
        if (g.members.length) has = true;
        patchNode(g);

        // 工具行不跟着折叠。
        //
        // 折叠本身是对的（桌面端也一样：思考与「过程」收成一行），但**工具调用不能
        // 跟着一起消失**——用户看到的是「刚才明明调用了工具，回合结束就没了」。
        // 桌面的做法是：过程折起来，工具仍是独立行（读取/终端/编辑各自一行），点开
        // 还能看参数与输出。这里把成员里的工具抽成独立行，插在该组折叠行正下方；
        // 既然是「一行一个动作」，也就不构成卡片堆叠（不过度卡片化）。
        const keepRows = g.members.filter(
          (m) => m.status !== "run" && (m.diff || m.type === "tool"),
        );
        if (!keepRows.length) return;
        const el = document.querySelector(`#messages [data-uid="${nodeUid(g)}"]`);
        if (!el) return;
        let html = "";
        keepRows.forEach((m, k) => {
          const node = m.diff
            ? NODES.change({
                title: m.title || TOOL_LABEL[m.name] || m.name,
                path: m.detail || "",
                diff: m.diff,
                args: m.args,
                out: m.out,
                ms: m.ms,
                status: m.status,
                icon: m.name === "write" ? "i-file" : "i-edit",
                open: false,
              })
            : NODES.toolrow(m);
          thread.splice(thread.indexOf(g) + 1 + k, 0, node);
          html += nodeHTMLUid(node);
        });
        el.insertAdjacentHTML("afterend", html);
      });
      return has;
    },

    /** 这一轮没有任何工具/思考：只留一条用时行（桌面 hasContent=false 的 turn-process） */
    settleEmpty(secs, end) {
      const tp = NODES.pgroup();
      tp.closed = true; tp.folded = true; tp.secs = secs; tp.end = end || "";
      const wrap = Live.textEl ? Live.textEl.closest(".msg") : null;
      if (wrap) {
        wrap.insertAdjacentHTML("beforebegin", nodeHTMLUid(tp));
        const ti = Live.textNode ? thread.indexOf(Live.textNode) : -1;
        thread.splice(ti >= 0 ? ti : thread.length, 0, tp);
      } else {
        push(tp, false);
      }
    },
  };

  /** 子代理步骤/进度：按工具调用 id 存，工具行与事件处理共用这一份 */
  const subagentState = new Map();

  function markThinksDone(g) {
    (g.members || []).forEach((m) => {
      if (m.type !== "think" || m.status !== "run") return;
      m.status = "done";
      // 思考默认就是收起的，这里只剩状态切换；用户手动展开过（auto 已清）也不抢
      m.auto = false;
    });
  }

  function beginLive(sessionId, modelName) {
    Live.id = "c" + Date.now().toString(36) + Math.random().toString(16).slice(2, 6);
    Live.sessionId = sessionId;
    Live.text = ""; Live.parts = []; Live.thinkText = "";
    Live.textEl = null; Live.textNode = null;
    Live.started = Date.now();
    Live.turnStart = Date.now();
    Live.model = modelName;
    Live.cancelled = false;
    Live.running = true;
    Live.dirty = false;
    Live.lastIsland = 0;
    Live.retries = 0; Live.retryReason = "";
    Live.voiceShown = false; Live.voiceKeys = [];
    resetSealed();                  // 新一轮：段级增量状态从零开始
    Flow.turnStart();
    ThinkSplit.reset();
    followBottomOn = true;          // 新的一轮：重新贴住底部
    try { followPump(); } catch (_) {}   // 本轮内每帧自己量一次（见 followPump 的说明）

    // 运行通知：会话开始（前台服务 + 常驻进度通知，退到桌面也能看到）
    try {
      if (Native && Native.sessionBegin) {
        const s = LocalDB.get(sessionId);
        Native.sessionBegin((s && s.title) || "会话运行中", sessionId);
      }
    } catch (_) {}

    const node = NODES.text("");
    node.live = true;
    const el = push(node, true);
    Live.textNode = thread[thread.length - 1];
    Live.textEl = $(".assistant-text", el);
    Live.textEl.innerHTML = runStatHTML();
    startRunClock();
    return Live.id;
  }

  /** 需要用户处理时提醒（原生侧判断「在不在这个会话」：正看着才不打扰） */
  function attentionNotify(title, text, sid) {
    const session = String(sid || Live.sessionId || state.sessionId || "");
    try { if (Native && Native.sessionAttention) Native.sessionAttention(title, String(text || ""), session); } catch (_) {}
  }

  function finishLive(usage) {
    clearTypingDots();
    stopRunClock();
    // 流结束：把 <think> 缓冲吐干净（可能有一段没等到闭合标签）
    {
      const rest = ThinkSplit.flush();
      if (rest.think) Flow.think(rest.think);
      if (rest.text) Live.text += rest.text;
    }
    const secs = Math.max(1, Math.round((Date.now() - Live.turnStart) / 1000));
    const body = liveBody();
    // 完成通知：只有用户不在应用里时才真正提醒（原生侧判断前后台）
    try {
      if (Native && Native.sessionEndWith) Native.sessionEndWith(Live.cancelled ? "stopped" : "done", String(body || Live.text || "").replace(/\s+/g, " ").slice(0, 140), Live.sessionId || state.sessionId || "");
      else if (Native && Native.sessionEnd) Native.sessionEnd(Live.sessionId || state.sessionId || "");
    } catch (_) {}

    livePaint(true);
    const hadProcess = Flow.settle(secs, Live.cancelled ? "stopped" : "");
    if (Live.text.trim()) {
    } else if (Live.textEl) {
      // 最后一段没有内容（工具后没再说话）：清掉空节点，别留白块
      const wrap = Live.textEl.closest(".msg");
      if (wrap) wrap.remove();
      const i = Live.textNode ? thread.indexOf(Live.textNode) : -1;
      if (i >= 0) thread.splice(i, 1);
    }
    if (!body && !hadProcess) {
      push(NODES.text(Live.cancelled ? "已停止" : "**模型没有返回内容**"), true);
    }
    scrollToBottom();
    // 语音输出：按场景判定（代码/表格/数据/长文/失败 → 文字；语音问→语音答；点名要听→可纯语音）
    try {
      if (body && !Live.cancelled && SpeechOut.on()) {
        const verdict = SpeechOut.decide(body, {
          forced: Live.speakRequested === true,
          byVoice: Live.askedByVoice === true,
        });
        // 本轮已经由 speak 工具出过语音条 → 不再自动补一条：
        // 否则同一段话会在对话里出现两遍（Agent 主动说的 + 轮末自动生成的），
        // 这就是「语音条重复渲染」。
        if (verdict.mode !== "text" && !Live.voiceShown) {
          SpeechOut.attachVoiceBubble(body, Live.textEl ? Live.textEl.closest(".msg") : null, {
            only: verdict.mode === "voice",
          });
          // 节奏闸：连着说两句，下一句就自然转回打字
          Live.voiceStreak = (Number(Live.voiceStreak) || 0) + 1;
        } else {
          Live.voiceStreak = 0;
        }
      }
    } catch (_) {}
    Live.speakRequested = false;
    if (Live.sessionId) {
      if (body) LocalDB.push(Live.sessionId, { role: "assistant", content: body });
      const total = (usage && (usage.total || ((usage.prompt || 0) + (usage.completion || 0)))) || 0;
      if (total) LocalDB.addTokens(Live.sessionId, total);
      try { Usage.log(Live.sessionId, usage); } catch (_) {}
      // 每轮结束自动沉淀记忆：会话记忆（隔离）+ 全局记忆（通用偏好）
      try { if (body) Memo.afterTurn(Live.sessionId); } catch (_) {}
    }
    Live.sessionId = null; Live.textEl = null; Live.textNode = null;
    Live.running = false;
    persistThread();
    renderSessions($("#searchSessions") ? $("#searchSessions").value : "");
    // 一轮结束：把新的几条对话推给原生引擎，它在后台说话时才接得上刚才的话题
    try { Companion.pushContextSoon(); } catch (_) {}
  }

  function failLive(msg) {
    // 唤醒补的那一轮失败了：把唤醒退回队列，别让它被静默吃掉
    requeueWakes(msg);
    const body = liveBody();
    try {
      if (Native && Native.sessionEndWith) Native.sessionEndWith("fail", String(msg || "").replace(/\s+/g, " ").slice(0, 140), Live.sessionId || state.sessionId || "");
      else if (Native && Native.sessionEnd) Native.sessionEnd(Live.sessionId || state.sessionId || "");
    } catch (_) {}
    Flow.freezeText();
    Flow.settle(Math.max(1, Math.round((Date.now() - Live.turnStart) / 1000)), "error");
    // 收掉「深度求索中，用时 N 秒」的等待态：失败卡已经出来了，上面还挂着一条还在跳秒的
    // 等待行，等于同时说「在等」和「已经失败」，自相矛盾。
    stopRunClock();
    if (Live.textEl) {
      // 正文保留（原文不丢），无光标可摘；text 为空的空消息气泡照旧移除
      if (!Live.text.trim()) {
        const wrap = Live.textEl.closest(".msg");
        if (wrap) wrap.remove();
        const i = Live.textNode ? thread.indexOf(Live.textNode) : -1;
        if (i >= 0) thread.splice(i, 1);
      }
    }
    Live.textEl = null; Live.textNode = null;
    // 只落一条说明：原因由内核按本次真实端点/状态码现算（前端不拼环境信息、不写教程），
    // 重试次数并进标题，不再单独占一行
    let prev = null;
    for (let i = thread.length - 1; i >= 0; i--) {
      const n = thread[i];
      if (!n || !n.kind) break;
      if (n.kind === "user") break;
      if (n.kind === "fail") { prev = n; break; }
    }
    if (prev && prev.message === msg) {
      patchNode(prev);
    } else {
      push(NODES.fail({ message: msg, retries: Live.retries }), true);
    }
    // 失败轮次的过程组如果只有「分析」没有实际动作（读文件/命令/工具都没跑），
    // 折叠起来就是一串「已完成分析」，和失败说明放一起纯属噪音，直接清掉
    for (let i = thread.length - 1; i >= 0; i--) {
      const n = thread[i];
      if (!n || !n.kind) break;
      if (n.kind === "user") break;
      if (n.kind !== "pgroup") continue;
      const real = (n.order || []).some((c) => c !== "thinking" && (n.counts[c] || 0) > 0);
      if (!real) {
        const el = document.querySelector(`#messages [data-uid="${nodeUid(n)}"]`);
        if (el) el.remove();
        thread.splice(i, 1);
      }
    }
    scrollToBottom();
    if (Live.sessionId && body) LocalDB.push(Live.sessionId, { role: "assistant", content: body });
    Live.sessionId = null; Live.textEl = null; Live.textNode = null;
    Live.running = false;
    persistThread();
  }

  // 浏览器预览（无原生桥）时的流式兜底
  async function browserChat(url, key, body) {
    const res = await fetch(`${url.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: "Bearer " + key } : {}) },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 200));
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let rest = "";
    let usage = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += dec.decode(value, { stream: true });
      const lines = rest.split("\n");
      rest = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const obj = JSON.parse(data);
          if (obj.usage) usage = obj.usage;
          const d = obj.choices && obj.choices[0] && obj.choices[0].delta;
          if (!d) continue;
          if (d.reasoning_content) window.DSHHost.onReasoning(Live.id, d.reasoning_content);
          if (d.content) window.DSHHost.onDelta(Live.id, d.content);
        } catch (_) {}
      }
    }
    window.DSHHost.onDone(Live.id, JSON.stringify(usage || {}));
  }

  /* ---------------- 原生 Agent 内核驱动 ----------------
   * 这里只做两件事：把这句话打包成运行参数交给 Kotlin 内核；把内核事件渲染成卡片。
   * 工具循环、意图分析、上下文压缩、计划评审等待、子智能体全部在原生侧，
   * 页面重载或退到后台都不会打断这一轮。
   */
  /**
   * WP1「日志即上下文」开关。
   *
   * 开启时模型历史由内核从会话日志派生（native HistoryPolicy → SessionStore.deriveMessages），
   * 前端这份 LocalDB.messages 只作为渲染缓存传空历史；关闭时保持旧行为（前端历史兜底）。
   * 默认关闭，验证通过后由设置页写入 localStorage.nativeHistory=1。
   */
  function nativeHistoryEnabled() {
    try { return localStorage.getItem("nativeHistory") === "1"; } catch (_) { return false; }
  }

  const NativeAgent = {
    active: false,
    id: null,
    tools: {},
    subs: {},
    approvals: {},
    todoNode: null,
    intent: null,

    available() { return !!(Native && Native.agentStart); },

    tools: {}, subs: {}, approvals: {}, asks: {},

    reset() {
      this.active = false; this.id = null;
      this.tools = {}; this.subs = {}; this.approvals = {}; this.asks = {};
      this.todoNode = null; this.intent = null; this.group = null;
    },

    /** 回复边界（桌面规则：Assistant 回复截断当前过程组） */
    closeGroup() { Flow.closeGroup(); },

    /** 组装一次运行的全部参数（设置里改的东西下一轮就生效） */
    payload(text, history, m, ep, atts, extra) {
      const mods = Modes.cur();
      const g = mods.goal;
      const scfg = SearchCfg.get();
      return {
        sessionId: Live.sessionId || state.sessionId || Live.id,
        baseUrl: ep.url, apiKey: ep.key, model: m.upstream || m.id,
        userText: text,
        // 唤醒续轮要带上「为哪件事、由哪条唤醒叫起来」，内核据此合档并落证据
        ...(extra || {}),
        // 端点自报的窗口（本地模型常见 4k~32k）优先：按 128k 攒上下文，小模型必然 400
        contextWindow: (() => {
          const set = Math.max(CONTEXT_FLOOR, TOKEN_LIMIT[state.context] || CONTEXT_FLOOR);
          const cap = Number(m.ctx) || 0;
          // 端点自己声明比下限还小（本地小模型）时只能按它来，否则请求必被 400；
          // 只要端点没声明，就一律按不低于 128k 发。
          return cap > 0 ? Math.min(set, Math.max(cap, 4096)) : set;
        })(),
        maxOut: (() => {
          const set = Math.max(OUT_FLOOR, TOKEN_LIMIT[state.maxOut] || OUT_FLOOR);
          const cap = Number(m.ctx) || 0;
          if (cap <= 0) return set;
          // 同样：端点比下限还小时退让，但至少要给系统提示词和工具目录留出 2/3 空间
          return cap <= OUT_FLOOR ? Math.max(1024, Math.floor(cap / 3)) : Math.min(set, cap);
        })(),
        // off / on 也要下发：前者要显式关思考，后者只有开关没有档位
        reasoningEffort: (() => { const lv = effortLevel(); return lv && lv.name ? lv.name : ""; })(),
        compactMode: state.compactMode,
        permission: state.perm,
        askDanger: !!state.askDanger,
        workspaceLabel: state.workspace || "harness",
        planMode: !!mods.plan, planApproved: !!mods.planApproved,
        preset: mods.preset || "standard",
        goal: g ? { objective: g.objective, phase: g.phase, rounds: g.rounds || 0, maxRounds: g.maxRounds || 0 } : null,
        persona: (() => {
          const p = PERSONAS.find((x) => x.id === state.persona);
          return p ? p.text : (state.persona || "");
        })(),
        globalMemories: state.globalMem ? GlobalMem.all().map((x) => x.text) : [],
        sessionMemories: state.sessMem && Live.sessionId ? LocalDB.mems(Live.sessionId).map((x) => x.text) : [],
        searchUrl: scfg.url || "", searchKey: scfg.key || "",
        searchMax: Math.max(1, Math.min(10, Number(scfg.max) || 5)),
        searchOn: !!(scfg.on && scfg.url),
        toolsEnabled: Kernel.enabled(),
        subagentEnabled: true,
        device: (state.nativeInfo && state.nativeInfo.model) || "Android",
        // WP1：nativeHistory=1 时历史由内核从会话日志派生（日志即上下文），
        // 前端这份仅作渲染缓存，不再作为模型输入；关闭时保持旧行为兜底。
        history: nativeHistoryEnabled() ? [] : (history || []).map((x) => ({
          role: x.role,
          content: x.content,
          // 历史里的图全部公平对待（含表情包）：每条都带自己的图，单张 ≤300KB、最多 2 张，
          // 注入预算在 AgentDriver 里统一控制。否则「刚才那张图里是什么」这种追问必然翻车。
          atts: (x.atts || [])
            .filter((a) => a && typeof a.dataUrl === "string" && a.dataUrl.startsWith("data:image") && a.dataUrl.length <= 300_000)
            .slice(0, 2),
        })),
        attachments: atts || [],
      };
    },

    start(cfg) {
      this.id = Live.id;
      this.active = true;
      this.tools = {}; this.subs = {}; this.approvals = {}; this.todoNode = null;
      Native.agentStart(Live.id, JSON.stringify(cfg));
    },

    stop() {
      if (!this.id) return;
      if (Native && Native.agentCancel) Native.agentCancel(this.id);
    },

    /* ---- 事件渲染 ---- */
    on(ev) {
      if (!ev || !ev.t) return;
      // 事件归属（桌面端 Peer/事件订阅的手机端等价物）：内核在每条事件上带 sessionId
      // （见 AgentBridge），这里只渲染属于**当前这份对话流**的事件。
      // 用户切走会话后，旧会话的正文/思考/工具事件仍会继续到达 —— 不丢弃就会写进
      // 当前会话，这正是「点进 A 却看到 B 的内容」的另一条路径。
      // teamView 时当前流是成员会话，也一并被挡住。没有 sessionId 时保持原行为。
      const evSid = ev.sessionId ? String(ev.sessionId) : "";
      if (evSid && thread.__sid !== evSid) return;
      if (ev.t === "intent") {
        // 意图路由只做内部决策（工具下发/上下文策略），不再渲染「执行任务 100% 打分」卡片
        this.intent = ev;
        return;
      }
      if (ev.t === "delta") {
        // 正文出现 = 过程组边界（桌面 reply flush）；工具之后继续说话则新开一段
        // 重试期间等待行被隐藏过：正文一到就恢复（此时等待态本来也要被正文替换掉）
        if (Live.textEl) {
          const w = Live.textEl.closest(".msg");
          if (w && w.style.display === "none") w.style.display = "";
        }
        feedStreamChunk(ev.text);   // 内联 <think> 会在这里被分流进思考通道
        if (Live.textEl) schedulePaint();
        return;
      }
      if (ev.t === "reasoning") {
        Flow.think(ev.text || "");
        return;
      }
      if (ev.t === "tool_start") {
        // exit_plan_mode 有专用计划评审卡，不进过程组。
        // subagent **必须**继续走 Flow.toolStart：它在那里的分支会建一条顶层进度行。
        // 以前这里把 subagent 一起 return 了，于是 Flow.toolStart 的子代理分支永远不执行，
        // 进度事件只能 patch 一个从未渲染的节点 —— 用户完全看不到子代理在跑。
        if (ev.name === "exit_plan_mode") return;
        Flow.toolStart({ id: ev.id, name: ev.name, args: ev.args || ev.meta || "" });
        return;
      }
      if (ev.t === "tool_output") {
        // 命令还在跑，输出先落在这一行上（不用等 tool_end）
        Flow.toolOutput(ev.id, ev.text || "");
        return;
      }
      if (ev.t === "tool_end") {
        Flow.toolEnd(ev.id, ev);
        return;
      }
      if (ev.t === "subagent") {
        // 子代理 = 一条顶层工具行：进度环 + 步骤树都在这一行上，不随过程组折叠
        let node = subagentState.get(ev.id);
        if (!node) {
          // 事件早于 tool_start 到达（内核先发进度再发工具开始）：直接把行建出来并插入。
          // 以前这里只存 stub 就 return，而 tool_start 有时根本不会再来（子代理由模型直接调度），
          // 结果这条子代理在界面上彻底消失。
          node = NODES.subrow({
            id: ev.id, task: String(ev.task || ""), lines: [], result: "", done: false, open: true,
          });
          subagentState.set(ev.id, node);
          push(node, true);
        }
        if (ev.phase === "start") {
          node.task = String(ev.task || "");
        } else if (ev.phase === "step") {
          node.lines.push({ text: ev.step || "", tool: ev.tool || "" });
          node.open = true;             // 跑的时候默认展开，看得见它在干什么
        } else if (ev.phase === "end") {
          node.done = true;
          node.result = String(ev.result || "").slice(0, 400);
          node.open = false;            // 跑完收起，点开能看完整步骤
        }
        patchNode(node);
        scrollToBottom();
        return;
      }
      if (ev.t === "ask_request") {
        this.closeGroup();
        const node = NODES.ask({
          id: ev.id || "",
          question: String(ev.question || ""),
          detail: String(ev.detail || ""),
          options: (ev.options || []).map((o) => ({ label: String(o.label || ""), description: String(o.description || "") })),
        });
        this.asks[ev.id] = node;
        push(node, true);
        haptic("light");
        attentionNotify("需要你回答", String(ev.question || ""), this.id);
        return;
      }
      if (ev.t === "plan_request") {
        this.closeGroup();
        const node = NODES.plan({
          pid: uid("p"),
          title: String(ev.title || "执行计划").slice(0, 40),
          plan: String(ev.plan || "").trim() || "（模型没有给出计划正文）",
          status: "pending", note: "",
        });
        push(node, true);
        PlanReview.node = node;
        haptic("light");
        attentionNotify("计划待批准", String(ev.title || "执行计划"), this.id);
        return;
      }
      if (ev.t === "approval_request") {
        this.closeGroup();
        const node = NODES.approval({
          title: "需要你确认",
          desc: ev.reason || "危险操作",
          cmd: ev.name + " " + ((ev.args && (ev.args.path || ev.args.command)) || ""),
          // 批准的范围由「这是哪件事」决定：绑了 Mission 的轮次，「始终允许」只在那件事里生效
          mission: ev.missionTitle || "",
          missionId: ev.missionId || "",
          resolved: false,
        });
        this.approvals[ev.id] = node;
        push(node, true);
        haptic("medium");
        attentionNotify("需要你确认", (ev.reason || "危险操作") + " · " + ev.name, this.id);
        return;
      }
      if (ev.t === "todo") {
        const items = (ev.items || []).map((i) => ({ text: i.text, state: i.done ? "done" : "todo" }));
        if (this.todoNode) {
          this.todoNode.items = items;
          patchNode(this.todoNode);
        } else {
          const node = NODES.todo({ items });
          this.todoNode = node;
          push(node, true);
        }
        scrollToBottom();
        return;
      }
      if (ev.t === "goal_end") {
        const g = Modes.goal();
        if (g) Modes.setGoal({
          ...g,
          phase: ev.status,
          summary: ev.summary || "",
          // 同一次 update_goal 里带上新目标：以 Agent 写回的为准
          objective: (ev.objective && String(ev.objective).trim()) || g.objective,
          updatedAt: Date.now(),
        });
        push(NODES.goalresult({ status: ev.status, summary: ev.summary || "" }), true);
        haptic(ev.status === "complete" ? "medium" : "light");
        return;
      }
      if (ev.t === "goal_edited") {
        // Agent 按推进阶段改写目标：落库 + 立刻反映到模式栏，下一轮就用新目标
        const g = Modes.goal();
        const next = (ev.objective || "").trim();
        if (g && next) {
          Modes.setGoal({
            ...g,
            objective: next,
            maxRounds: ev.maxRounds === undefined || ev.maxRounds === null ? g.maxRounds : Number(ev.maxRounds) || 0,
            updatedAt: Date.now(),
          });
        }
        push(NODES.goalresult({ status: "edited", summary: next }), true);
        toast("Agent 更新了目标");
        return;
      }
      if (ev.t === "goal_created") {
        // 模型用 create_goal 建立目标：把目标落到当前会话（等价桌面 command-goal）
        Modes.setGoal({
          objective: ev.objective || "",
          phase: "active", rounds: 0,
          maxRounds: Number(ev.maxRounds) || 0,
          createdAt: Date.now(), updatedAt: Date.now(),
        });
        syncModeBar();
        push(NODES.goalresult({ status: "created", summary: ev.objective || "" }), true);
        toast("Agent 建立了目标：" + pageClip(ev.objective || "", 24));
        return;
      }
      if (ev.t === "retry") {
        // 重试过程不往会话里塞卡片：请求还在自动重试，界面就继续显示「深度求索中，用时 N 秒」。
        // 只有重试用尽、确实失败时才落一条最终说明（failLive），这样不会出现
        // 「还在深度求索」和「请求失败」同屏，也不会一发出就弹失败。
        Live.retries = Number(ev.attempt) || (Live.retries + 1);
        if (ev.reason) Live.retryReason = String(ev.reason);
        return;
      }
      if (ev.t === "max_tokens") {
        push(NODES.maxtokens({ completion: ev.completion || 0, maxOut: ev.maxOut || 0 }), true);
        return;
      }
      if (ev.t === "compacting") {
        compactingRow(true, ev);
        return;
      }
      if (ev.t === "compacted") {
        compactingRow(false, ev);
        // 记下本轮压缩的账目，turn_end 挂进用量面板（桌面 TurnUsagePanel 有压缩分项）
        Live.compact = {
          dropped: Number(ev.dropped) || 0,
          folded: Number(ev.folded) || 0,
          summarized: !!ev.summarized,
          summarizedCount: Number(ev.summarizedCount) || 0,
          before: Number(ev.before) || 0,
          after: Number(ev.after) || 0,
        };
        return;
      }
      if (ev.t === "notice" || ev.t === "steer") {
        const txt = ev.note || ev.text || "";
        if (txt) toast(txt.length > 40 ? txt.slice(0, 40) + "…" : txt);
        return;
      }
      if (ev.t === "usage") {
        Live.usage = { prompt: ev.prompt, completion: ev.completion, total: ev.total };
        return;
      }
      if (ev.t === "title") {
        // 内核后台生成的 provider 标题（maybeTitle 已异步化，此时 turn_end 早已发出）。
        // 只覆盖自动生成的首句标题/默认标题 —— 用户手动 rename 过就不抢他的选择。
        // 本地列表标题源在 LocalDB，kernel jsonl 的 session/title 前端从不读。
        const sid = Live.sessionId || state.sessionId || Live.id;
        const s = sid ? LocalDB.get(sid) : null;
        if (s && ev.title) {
          const firstUser = (s.messages || []).find((m) => m.role === "user");
          const auto = (firstUser ? String(firstUser.content || "").replace(/\s+/g, " ").slice(0, 20) : "") || "新会话";
          if (!s.title || s.title === auto || s.title === "新会话") {
            LocalDB.rename(sid, String(ev.title));
            renderSessions();
            if (state.sessionId === sid && $("#chatTitle")) $("#chatTitle").textContent = String(ev.title);
          }
        }
        return;
      }
      if (ev.t === "error") {
        NativeAgent.reset();
        compactingClear();
        failLive(ev.message || "请求失败");
        state.busy = false;
        updateSendState();
        return;
      }
      // 交付物卡片：内核在 turn_end 之后单独推一条（本轮 present 的文件 + 无 present 时的自动兜底）。
      // 这段逻辑以前只写在已经废弃的旧事件处理器里，原生内核这条链路根本没接，
      // 结果就是「文件明明写成了，对话界面轮末什么卡片都没有」。
      if (ev.t === "deliverable") {
        if (ev.sessionId && ev.sessionId !== state.sessionId) return;
        const files = ev.files || [];
        if (!files.length) return;
        const node = NODES.deliverable({ files });
        const tailMsg = currentTurnTail();
        if (tailMsg && tailMsg.parentElement === $("#messages")) {
          // 插在本轮尾行（复制/用量）之前，卡片才落在这一轮里面而不是飘到最末尾
          const added = insertAnchored(tailMsg, nodeHTMLUid(node));
          if (added) hydrateMedia(added); // 缩略图是占位，不 hydrate 就是一块空白
          // thread 里的位置与 DOM 对齐：放在最后一个 footer 之前，全量重绘才不掉到后面
          const at = lastFooterIndex();
          thread.splice(at, 0, node);
          keepTailSync(at);
          persistThread();          // 不落快照，切走会话再回来卡片就没了
        } else {
          const el = push(node, true);
          if (el) hydrateMedia(el);
          persistThread();
          if (followBottomOn) scrollToBottom();
        }
        haptic("medium");
        return;
      }
      if (ev.t === "turn_end") {
        const wasActive = this.active;
        this.reset();
        compactingClear();
        if (ev.error) { failLive(ev.error); state.busy = false; updateSendState(); return; }
        // 本轮正常收尾（含用户主动停止）：唤醒不再回滚，否则下一轮会被"补"回来跟用户对着干
        lastWakeIds = [];
        if (ev.cancelled) Live.cancelled = true;
        const usage = ev.usage || null;
        if (ev.goalContinue && wasActive && !ev.cancelled && Modes.goalActive()) { nativeGoalAdvance(usage); return; }
        const turnText = liveBody();
        finishLive(usage);
        // 轮次尾行（桌面 turn-tail 的同构）：复制 + token 用量
        if (usage || ev.steps || ev.ms) {
          push(NODES.footer({
            steps: ev.steps || 0, ms: ev.ms || 0, text: turnText,
            tokens: usage ? (usage.total || ((usage.prompt || 0) + (usage.completion || 0))) : 0,
            // 分项留着给「用量」面板用：桌面 TurnUsagePanel 就是这几项
            prompt: (usage && Number(usage.prompt)) || 0,
            completion: (usage && Number(usage.completion)) || 0,
            cached: (usage && Number(usage.cached)) || 0,
            ctxWindow: (usage && Number(usage.contextWindow)) || 0,
            compact: Live.compact || null,
            cancelled: !!ev.cancelled,
          }), true);
          Live.compact = null; // 账目只属于这一轮，挂完就清，别串到下一轮
        }
        persistThread();          // 尾行也要进快照，重开会话才完整
        state.busy = false;
        updateSendState();
        // 本轮期间到点的唤醒留在统一队列里：等这一轮结束再认领，别打断回复
        setTimeout(() => { if (!state.busy) { try { wakeMissions(); } catch (_) {} } }, 350);
        return;
      }
    },
  };

  /** 目标续跑：内核在一轮结束时告诉我们还能继续，就再开一轮 */
  function nativeGoalAdvance(usage) {
    // 用户排了话就先发用户的，目标续轮等队列清空之后再说
    if (queueOf().length) {
      if (Live.id) finishLive(usage);
      state.busy = false;
      updateSendState();
      return;
    }
    const sid = Live.sessionId;
    const g = Modes.goal();
    // 目标在轮中被暂停/结束（或用户清了目标）：不再起下一轮，就地把这一轮收尾
    if (!sid || !g || g.phase !== "active") {
      if (Live.id) finishLive(usage);
      state.busy = false;
      updateSendState();
      return;
    }
    finishLive(usage);
    const round = (g.rounds || 0) + 2;
    Modes.setGoal({ ...g, rounds: (g.rounds || 0) + 1, updatedAt: Date.now() });
    push(NODES.goalround({ round, max: goalCap(g) }));

    state.busy = true;
    updateSendState();
    beginLive(sid, modelLabel());
    const s = LocalDB.get(sid) || { messages: [] };
    const m = findModel(state.model);
    const ep = endpointOf(m);
    NativeAgent.start(NativeAgent.payload(goalNudge(g, round), (s.messages || []), m, ep, []));
  }

  /** 目标每一轮发给模型的话（启动与续跑共用，措辞只在轮次上不同） */
  function goalNudge(g, round) {
    return [
      `[目标${round > 1 ? "续跑" : "启动"} · ${goalRoundLabel(g, round)}] 目标：${g.objective}`,
      "先对照目标盘点已经完成了什么，只做尚未完成的下一步，不要重复已完成的工作。",
      "如果所处阶段变了（例如从「摸清现状」进入「实现并验证」），调用 update_goal(action=\"edit\", objective=\"新的阶段目标\") 改写目标，再继续推进。",
      '全部达成就调用 update_goal(action="complete", summary="…")；卡住就 update_goal(action="blocked", blocked_reason="…") 说明原因。',
    ].join("\n");
  }

  /**
   * 目标驱动：目标确定/恢复后立刻起一轮，不必等用户再发一句话。
   * 桌面端目标保存即进入推进，这里补齐同样的自动驱动。
   */
  async function startGoalTurn(silent) {
    const g = Modes.goal();
    if (!g || g.phase !== "active") return false;
    if (currentMode() === "host") {
      if (!silent) toast("目标驱动需要本地内核：宿主机模式请在桌面端启动目标");
      return false;
    }
    if (state.busy) {
      if (!silent) toast("当前一轮还在跑，这一轮结束后会自动接着推进目标");
      return false;
    }
    if (!localReady()) {
      const st = Account.info();
      if (st.signedIn) {
        await Account.applyToModel(true);
        if (!localReady()) { toast("账号模型未就绪，请重新登录"); openSheet(Account.sheet()); return false; }
      } else {
        toast("登录 DeepSeek 账号即可推进目标；也可在设置里填第三方 API 密钥");
        openSheet(Account.sheet());
        return false;
      }
    }

    // 没有会话就先建一个：目标必须挂在一个真实会话上，否则刷新后模式会丢
    let sid = (state.sessionId && state.sessionId !== "s1") ? state.sessionId : Live.sessionId;
    if (!sid || !LocalDB.get(sid)) {
      const s = LocalDB.create(g.objective);
      sid = s.id;
      state.sessionId = sid;
      // 新建的会话 = 新的一份对话流（同 handleSend：只换 sessionId 不换桶会串号）
      adoptThread(sid);
      Modes.adopt(sid);
      $("#chatTitle").textContent = s.title || "新会话";
      $("#chatSub").textContent = "本地 · " + modelLabel();
    } else {
      // 复用已有会话：确保对话流就是它那一份（中间可能切过别的会话）
      attachThread(sid);
    }

    const round = (g.rounds || 0) + 1;
    Modes.setGoal({ ...g, updatedAt: Date.now(), lastStartAt: Date.now() });
    push(NODES.goalround({ round, max: goalCap(g) }));
    haptic("medium");

    state.busy = true;
    updateSendState();
    beginLive(sid, modelLabel());
    const s = LocalDB.get(sid) || { messages: [] };
    const m = findModel(state.model);
    const ep = endpointOf(m);

    if (NativeAgent.available()) {
      NativeAgent.start(NativeAgent.payload(goalNudge(g, round), (s.messages || []), m, ep, []));
      return true;
    }
    try {
      await localSend(goalNudge(g, round), [], { keepAll: true });
    } catch (e) {
      failLive(e.message || String(e));
      state.busy = false;
      updateSendState();
      return false;
    }
    return true;
  }

  async function localSend(text, atts = [], opts = {}) {
    const m = findModel(state.model);
    const ep = endpointOf(m);
    const session = LocalDB.get(Live.sessionId) || { messages: [] };
    // 刚写入的用户消息已在库中，构造历史时排除最后一条；
    // 目标启动/续跑这类「系统代发的推进消息」没有对应的用户消息，要整段带上
    const all = (session.messages || []);
    const history = opts.keepAll ? all.slice() : all.slice(0, -1);

    // 原生内核可用时，整轮交给 Kotlin：这里不再组装 system prompt / 不再跑工具循环
    if (NativeAgent.available()) {
      let parts = [];
      if (atts.length) {
        try {
          const raw = await attachmentParts(atts);
          parts = raw.map((p) => p.type === "image_url"
            ? { type: "image", dataUrl: (p.image_url || {}).url || "" }
            : { type: "text", text: p.text || "", name: "" });
        } catch (_) {}
      }
      // opts.mission 显式传入；唤醒续轮走 handleSend 这条普通出口，用 state.pendingMission 递一手。
      // 两个都必须「下一个 localSend 消费掉」，否则会把这件事泄漏给随后用户自己发的消息。
      const bind = opts.mission || state.pendingMission || null;
      state.pendingMission = null;
      NativeAgent.start(NativeAgent.payload(text, history, m, ep, parts, bind));
      return;
    }

    // 联网搜索（本地模式）：开启且配置了接口时，先搜一轮把结果注入上下文
    let searchNote = "";
    const scfg = SearchCfg.get();
    if (scfg.on && scfg.url) {
      const n = Math.max(1, Math.min(10, Number(scfg.max) || 5));
      try {
        const hits = await webSearch(text, n);
        if (hits && hits.length) {
          // 来源卡片插到流式气泡之前；只插入新节点，不重建列表（避免流式气泡被销毁导致闪烁）
          const liveIdx = thread.length - 1;
          const isLive = thread[liveIdx] && thread[liveIdx].kind === "text" && !thread[liveIdx].text;
          const node = NODES.search(hits, text);
          if (isLive) {
            thread.splice(liveIdx, 0, node);
            const liveEl = Live.textEl && Live.textEl.closest(".msg");
            if (liveEl) liveEl.insertAdjacentHTML("beforebegin", nodeHTMLUid(node));
            else renderThread();
          } else {
            push(node, false);
          }
          scrollToBottom();
        }
        searchNote = hits && hits.length
          ? "[联网搜索结果 · 仅作参考，回答时注明来源链接]\n" +
            hits.map((h, i) => `${i + 1}. ${h.title}${h.url ? "（" + h.url + "）" : ""}\n${h.snippet}`).join("\n")
          : "[联网搜索没有返回结果]";
      } catch (err) {
        searchNote = "[联网搜索失败：" + (err.message || err) + "]";
      }
    }
    const messages = buildMessages(history, text, searchNote);
    if (atts.length) {
      const parts = await attachmentParts(atts);
      if (parts.length) {
        const last = messages[messages.length - 1];
        last.content = [{ type: "text", text }, ...parts];
      }
    }
    const payload = {
      model: m.upstream || m.id,
      messages,
      stream: true,
      max_tokens: TOKEN_LIMIT[state.maxOut] || 65536,
      ...effortField(),
    };
    // 手机端内核：挂上工具（文件/命令/搜索/子代理），进入工具循环
    if (Kernel.enabled()) {
      const tools = Kernel.toolDefs();
      if (tools.length) {
        payload.tools = tools;
        payload.tool_choice = "auto";
        Agent.active = true;
        Agent.messages = messages;
        Agent.round = 0;
        Agent.pendingCalls = null;
      }
    } else {
      agentReset();
    }
    if (!Native || !Native.chatStream) {
      try { await browserChat(ep.url, ep.key, payload); } catch (e) { failLive(e.message || String(e)); }
      return;
    }
    Native.chatStream(Live.id, ep.url, ep.key, JSON.stringify(payload));
  }

  /**
   * 停止生成：必须**立刻**结束这一轮。
   * 原生侧的打断是异步的（断连接 / 内核收尾），而且不保证一定回 turn_end；
   * 之前这里只置了个 cancelled 标志就返回，按钮要等回调才变回「发送」，
   * 于是表现为「点了没反应 / 停不下来」。现在打断之后立即就地收尾。
   */
  function stopLive(silent) {
    const wasBusy = state.busy || !!Live.id;
    Live.cancelled = true;
    // 先尽力打断底层：原生 Agent 内核 + 本地 SSE 连接
    try { if (NativeAgent.active) NativeAgent.stop(); } catch (_) {}
    try { if (Native && Native.abortChat && Live.id) Native.abortChat(Live.id); } catch (_) {}
    // 正在等用户评审计划时停止：把评审卡片结算掉，工具循环才能退出
    if (PlanReview.pending && PlanReview.node) settlePlan(PlanReview.node, "rejected");
    // 未决授权框随轮次一起结算：按钮隐藏 + 变灰，不能再点
    //（此前终止后卡片仍是活的，点了要么白答、要么把确认发给已经结束的轮次）
    const staleApprovals = Object.values(NativeAgent.approvals || {}).filter((n) => n && !n.resolved);
    if (staleApprovals.length) {
      staleApprovals.forEach((node) => { node.resolved = true; node.result = "已终止 · 本次确认无效"; patchNode(node); });
      NativeAgent.approvals = {};
    }
    if (!wasBusy) { state.busy = false; updateSendState(); return; }

    // 断开 JS 侧的事件入口：Live.id 置空后，迟到的 onDelta/onReasoning/onDone 全部丢弃
    const oldId = Live.id;
    Live.id = null;
    stopRunClock();
    if (Live.paintTimer) { clearTimeout(Live.paintTimer); Live.paintTimer = 0; }
    if (Live.stopGuard) { clearTimeout(Live.stopGuard); Live.stopGuard = 0; }
    try { NativeAgent.reset(); } catch (_) {}
    // 用户主动停止：只撤运行通知，不发「已完成」提醒
    try {
      if (Native && Native.sessionEndWith) Native.sessionEndWith("stopped", "", Live.sessionId || state.sessionId || "");
      else if (Native && Native.sessionEnd) Native.sessionEnd(Live.sessionId || state.sessionId || "");
    } catch (_) {}

    // 就地结算这一轮：过程组折叠成「已停止」，正文保留，尾巴加一条停止标记
    const body = liveBody();
    flowFinishStopped();
    Live.running = false;
    state.busy = false;
    updateSendState();
    persistThread();
    if (!silent) toast("已停止");
    return oldId;
  }

  /** 把当前流式轮次按「用户主动停止」收尾（不依赖原生回调） */
  function flowFinishStopped() {
    stopRunClock();
    {
      const rest = ThinkSplit.flush();
      if (rest.think) Flow.think(rest.think);
      if (rest.text) Live.text += rest.text;
    }
    const secs = Math.max(1, Math.round((Date.now() - (Live.turnStart || Date.now())) / 1000));
    const body = liveBody();
    livePaint(true);
    Flow.settle(secs, "stopped");
    if (Live.textEl) {
      // 正文保留（原文不丢），无光标可摘；text 为空的空消息气泡照旧移除
      if (!Live.text.trim()) {
        const wrap = Live.textEl.closest(".msg");
        if (wrap) wrap.remove();
        const i = Live.textNode ? thread.indexOf(Live.textNode) : -1;
        if (i >= 0) thread.splice(i, 1);
      }
    }
    if (body || thread.length) {
      push(NODES.footer({ steps: 0, ms: 0, text: body, tokens: 0, cancelled: true }), true);
    }
    Live.sessionId = null;
    Live.textEl = null;
    Live.textNode = null;
    Live.text = "";
    Live.parts = [];
    scrollToBottom();
  }

  // 通知里的「停止」按钮：原生侧回调进来
  try {
    window.DSHIslandStop = () => stopLive();
  } catch (_) {}

  /* ---------------- 手机端内核：工具循环 + 子代理 ---------------- */

  const Kernel = {
    _schemas: null,
    _waits: {},
    enabled() {
      return localStorage.getItem("dsh.kernelTools") !== "0" && !!(Native && Native.toolCall);
    },
    schemas() {
      if (!this._schemas) {
        try { this._schemas = JSON.parse(Native.toolSchemas()); } catch (_) { this._schemas = []; }
      }
      return this._schemas;
    },
    /** OpenAI tools 格式；末尾追加 JS 侧实现的 subagent 与内置模式工具 */
    toolDefs(withSubagent = true) {
      let defs = this.schemas().map((s) => ({
        type: "function",
        function: { name: s.name, description: s.description, parameters: s.parameters },
      }));
      if (withSubagent) {
        defs.push({
          type: "function",
          function: {
            name: "subagent",
            description: "派一个子代理独立完成一段任务（独立上下文，最多若干轮工具调用），只返回最终结论。适合拆解子任务或隔离很长的上下文。",
            parameters: {
              type: "object",
              properties: {
                task: { type: "string", description: "交给子代理的完整任务描述" },
                max_rounds: { type: "number", description: "最多工具轮数，默认 6" },
              },
              required: ["task"],
              additionalProperties: false,
            },
          },
        });
      }
      const m = Modes.cur();
      if (m.plan && !m.planApproved) {
        defs.push({
          type: "function",
          function: {
            name: "exit_plan_mode",
            description: "把完整执行计划提交给用户评审。批准前不要执行任何写操作；用户在卡片上批准后才继续。",
            parameters: {
              type: "object",
              properties: {
                title: { type: "string", description: "计划标题，一句话概括要做什么" },
                plan: { type: "string", description: "Markdown 计划正文，以 # 标题开头，分步骤、可验证" },
              },
              required: ["plan"],
              additionalProperties: false,
            },
          },
        });
        // 计划模式：写类工具不下发，模型连看到都看不到（子代理只用于只读探索）
        defs = defs.filter((d) => {
          const n = d.function.name;
          return READONLY_TOOLS.includes(n) || n === "exit_plan_mode" || n === "subagent";
        });
      }
      if (m.goal && m.goal.phase === "active") {
        defs.push({
          type: "function",
          function: {
            name: "update_goal",
            description: "更新目标：阶段变了用 edit 改写目标内容；全部做完用 complete；无法推进用 blocked 并写清原因。",
            parameters: {
              type: "object",
              properties: {
                action: { type: "string", enum: ["edit", "complete", "blocked"], description: "要做的动作" },
                objective: { type: "string", description: "edit 时的新目标（写清这一阶段要达成什么）" },
                summary: { type: "string", description: "一句话说明完成了什么，或卡在哪里" },
                blocked_reason: { type: "string", description: "blocked 时的卡点说明" },
              },
              required: ["action"],
              additionalProperties: false,
            },
          },
        });
      }
      return defs;
    },
    call(name, args) {
      return new Promise((resolve) => {
        if (Modes.blocks(name)) {
          resolve({ ok: false, error: "计划模式进行中：写操作与命令已禁用。请先调用 exit_plan_mode 提交计划并等待用户批准。" });
          return;
        }
        if (!Native || !Native.toolCall) {
          resolve({ ok: false, error: "当前环境不支持本地工具" });
          return;
        }
        const id = "tc" + Date.now().toString(36) + Math.random().toString(16).slice(2, 6);
        let settled = false;
        const finish = (r) => {
          if (settled) return;
          settled = true;
          delete this._waits[id];
          resolve(r);
        };
        this._waits[id] = finish;
        try { Native.toolCall(id, name, JSON.stringify(args || {})); }
        catch (e) { finish({ ok: false, error: String(e) }); }
        setTimeout(() => finish({ ok: false, error: "工具执行超时：" + name }), 60000);
      });
    },
    /** 一次性独立请求（子代理用，不干扰主气泡）：带 90s 超时 —— 以前没超时，
     *  网络挂起时陪伴「试一试」会永远停在「让它想一句」且 pending 不释放 */
    once(messages, tools) {
      return new Promise((resolve, reject) => {
        if (!Native || !Native.chatStream) {
          reject(new Error("当前环境不支持本地模型调用"));
          return;
        }
        const m = findModel(state.model);
        const ep = endpointOf(m);
        const id = "sg" + Date.now().toString(36) + Math.random().toString(16).slice(2, 6);
        const timer = setTimeout(() => {
          if (!this._waits[id]) return;
          delete this._waits[id];
          try { Native.abortChat && Native.abortChat(id); } catch (_) {}
          reject(new Error("模型请求超时（90 秒无响应）"));
        }, 90000);
        this._waits[id] = { text: "", reasoning: "", toolCalls: null, resolve, reject, _timer: timer };
        const payload = {
          model: m.upstream || m.id,
          messages,
          stream: true,
          max_tokens: TOKEN_LIMIT[state.maxOut] || 65536,
      ...effortField(),
        };
        if (tools && tools.length) { payload.tools = tools; payload.tool_choice = "auto"; }
        Native.chatStream(id, ep.url, ep.key, JSON.stringify(payload));
      });
    },
  };
  window.DSHKernel = Kernel;

  /* 内核插件：与桌面 Harness「一切皆插件」对齐的运行时视图。
     工具目录完全由原生插件注册表给出，这里只负责展示与启停，不做二次包装。 */
  /* DeepSeek 账号：走与桌面端同一条授权链路（PKCE + loopback 回调），
     token 只留在原生侧，前端拿不到明文，只展示登录状态。 */
  const Account = {
    st: { signedIn: false, phase: "idle", user: {}, error: "" },

    info() {
      if (!Native || !Native.accountState) return this.st;
      try { this.st = JSON.parse(Native.accountState()); } catch (_) {}
      return this.st;
    },

    label() {
      const s = this.info();
      if (!s.signedIn) return "未登录";
      const u = s.user || {};
      return u.name || u.email || u.mobile || "已登录";
    },

    sync() {
      // 有原生账号能力时，同步到设置页顶部的账号卡片（唯一的账号入口）
      if (!(Native && Native.accountState)) return;
      const s = this.info();
      const name = $("#accName");
      const sub = $("#accSub");
      const action = $("#accAction");
      if (!name) return;
      if (s.signedIn) {
        const u = s.user || {};
        name.textContent = u.name || u.email || u.mobile || "已登录";
        sub.textContent = u.email || u.mobile || "账号凭据已保存在本机";
        action.textContent = "管理";
      } else {
        name.textContent = "未登录";
        sub.textContent = "登录后使用 DeepSeek 模型与额度";
        action.textContent = "登录";
      }
    },

    /**
     * 启动时对齐：已登录但当前模型没有可用凭据 → 自动挂上账号额度。
     * 桌面里「登录后就能直接选账号模型」是配置层的事，手机端没有独立配置页，
     * 就在启动这一处补齐，避免用户登录完还看到「未配置」。
     */
    bootstrap() {
      const s = this.info();
      if (!s.signedIn) return;
      const cur = findModel(state.model);
      if (cur && cur.auth === "account") return;
      const e = endpointOf(cur || {});
      if (e.url && e.key) return;      // 已有自己的 key，不打扰
      this.applyToModel(true);
    },

    async open() {
      this.info();
      openSheet(this.sheet());
      // 进面板时拉一次最新状态（可能是后台授权刚回来）
      if (!this.st.signedIn) this.info();
    },

    sheet() {
      const s = this.info();
      const u = s.user || {};
      const name = u.name || u.email || u.mobile || "";
      const waiting = s.phase === "waiting-browser" || s.phase === "exchanging";
      return `
      <div class="sheet-title">DeepSeek 账号</div>
      <div class="sheet-sub">登录后享受账号额度</div>

      ${s.signedIn ? `
        <div class="acct-card">
          <div class="acct-avatar"><svg class="ico"><use href="#i-shield"/></svg></div>
          <div class="acct-main">
            <b>${esc(name || "已登录")}</b>
            <span>${esc(u.email || u.mobile || "账号凭据已保存在本机")}</span>
          </div>
          <span class="acct-badge">已登录</span>
        </div>
        <button class="btn-primary" data-acct="apply">用账号额度运行</button>
        <button class="btn-ghost" data-acct="signout">退出登录</button>
      ` : `
        <div class="acct-empty">
          <svg class="ico"><use href="#i-shield"/></svg>
          <p>${esc(waiting ? "已打开浏览器，完成登录后会自动回来" : (s.error || "还没有登录 DeepSeek 账号"))}</p>
        </div>
        <button class="btn-primary" data-acct="login"${waiting ? " disabled" : ""}>${waiting ? "等待浏览器授权…" : "登录 DeepSeek 账号"}</button>
      `}
      <button class="btn-ghost" data-close>关闭</button>`;
    },

    login() {
      if (!Native || !Native.accountStart) { toast("当前环境不支持账号登录"); return; }
      this.st.phase = "waiting-browser";
      this.st.error = "";
      openSheet(this.sheet());
      Native.accountStart("acc" + Date.now().toString(36));
      toast("已打开浏览器，请完成登录");
    },

    onState(st) {
      this.st = st || this.st;
      this.sync();
      if (sheetOpen) openSheet(this.sheet());
      if (st && st.signedIn) {
        toast("已登录 DeepSeek 账号");
        // 登录的意图就是「能用模型」：没有可用模型时直接切过去；
        // 已经在用自己的 key 时只登记这项，不打断当前选择
        this.applyToModel(true, true);
      } else if (st && st.error) toast("登录未完成：" + st.error);
    },

    signOut() {
      try { this.st = JSON.parse(Native.accountSignOut()); } catch (_) {}
      this.sync();
      openSheet(this.sheet());
      toast("已退出登录");
    },

    /**
     * 切到「账号额度」模型。
     * 桌面等价物是 llm-deepseek-account 路由：端点固定为 Messages 根
     * （api.deepseek.com/anthropic），鉴权由账号服务按来源解析，
     * 所以这里**不保存任何 token** —— 退登/换号立即生效，配置里也不会残留凭据。
     */
    async applyToModel(silent, registerOnly) {
      const signedIn = !!(Native && Native.accountState && JSON.parse(Native.accountState() || "{}").signedIn);
      if (!signedIn) { if (!silent) toast("先登录再用账号额度"); return; }
      let m = state.models.find((x) => x.id === "deepseek-account");
      if (!m) {
        m = {
          id: "deepseek-account",
          name: "DeepSeek 账号",
          desc: "登录态直连 · 无需密钥",
          url: "https://api.deepseek.com/anthropic",
          auth: "account",
          key: "",
          upstream: "deepseek-chat",
          // 官方 Messages 端点的有效档位（桌面 llm-deepseek/serialize.ts 同款）：off 关思考，low/high/max 三档
          efforts: ["off", "low", "high", "max"],
        };
        state.models.push(m);
      } else {
        // 清掉历史版本写进去的 token（旧实现把登录态当 key 存在 localStorage）
        m.url = "https://api.deepseek.com/anthropic";
        m.auth = "account";
        m.key = "";
        m.desc = m.desc || "登录态直连 · 无需密钥";
        // 旧版本给过 ["均衡","深入"]（归一成 medium/high，而官方把 medium 映射为 high，
        // 两档实际等价）——这里强制刷新成官方有效档位
        m.efforts = ["off", "low", "high", "max"];
      }
      // 登录后拉一次平台给这个账号的模型目录（失败不阻塞，仍可用默认上游名）
      try {
        const raw = Native.accountModels ? Native.accountModels() : "";
        const res = raw ? JSON.parse(raw) : null;
        if (res && res.ok && Array.isArray(res.models) && res.models.length) {
          const preferred = res.models.find((x) => /chat|flash|pro/i.test(x.id)) || res.models[0];
          m.upstream = preferred.id;
          m.accountModels = res.models;
        }
      } catch (_) {}
      // 先记住用户原来在用的模型，再决定要不要切换
      const prev = findModel(state.model);
      const prevUsable = !!(prev && prev.id !== m.id && (prev.auth === "account" || endpointOf(prev).key));
      state.model = m.id;
      persistModels();
      // 只是「让账号模型出现在列表里」时，不要抢走用户已经在用的可用模型
      if (registerOnly && prevUsable) {
        state.model = prev.id;
        localStorage.setItem("dsh.model", prev.id);
        if (sheetOpen) closeSheet();
        toast("已添加「DeepSeek 账号」额度，可在模型列表切换");
        return;
      }
      localStorage.setItem("dsh.model", m.id);
      if (sheetOpen) closeSheet();
      toast(silent ? "已使用 DeepSeek 账号额度" : "已切换为账号额度");
    },
  };

  /* ---------------- 过程组（桌面 conversation-nodes/process-groups 同构渲染） ----------------
     一轮里相邻的工具调用归入同一组；回复/计划/目标等边界截断组；
     类别变化不拆组（read → bash 仍是一组）。
     组头：运行中显示实时活动（类别文案 · 参数详情），结束后显示类别摘要组合。
     分类表 / 活动文案表 / 详情字段优先级逐条来自桌面 process-activity.ts 的业务规则。 */
  function toolCategory(name) {
    const n = String(name || "");
    if (n === "read") return "read";
    if (n === "read_image") return "readImage";
    if (n === "grep" || n === "glob" || /_inspect$/.test(n)) return "search";
    if (n === "write") return "write";
    if (n === "edit" || n === "apply_patch") return "edit";
    if (n === "bash" || n === "pwsh" || n === "exec_command" || n === "write_stdin" || /^terminal_/.test(n)) return "commands";
    if (n === "run_code") return "code";
    if (n === "web_search") return "webSearch";
    if (n === "web_fetch" || n === "http_request") return "webFetch";
    if (n === "subagent" || /^subagent_/.test(n)) return "subagents";
    // 团队工具（agent-team 插件）：与右上角团队按钮同一个图标（#i-agent）
    if (/^(spawn_teammate|list_agents|send_message|interrupt_agent|wait_agent|team_status|team_task_)/.test(n)) return "team";
    if (n === "todo_write" || n === "create_goal" || n === "update_goal" || n === "get_goal") return "plan";
    if (n === "ask_user_question" || n === "request_user_input") return "questions";
    return "tools";
  }
  const CAT_ACTIVITY = {
    thinking: ["正在分析请求", "已完成分析"],
    read: ["正在读取文件", "已读取文件"],
    readImage: ["正在读取图片", "已读取图片"],
    search: ["正在搜索代码", "已搜索代码"],
    write: ["正在写入文件", "已写入文件"],
    edit: ["正在编辑文件", "修改了文件"],
    commands: ["正在运行命令", "执行了命令"],
    code: ["正在运行代码", "运行了代码"],
    webSearch: ["正在搜索网页", "已搜索网页"],
    webFetch: ["正在访问网页", "已访问网页"],
    subagents: ["正在协调子代理", "已协调子代理"],
    team: ["正在调度团队", "已调度团队"],
    plan: ["正在更新计划", "更新了计划"],
    questions: ["等待你的操作", "向用户提出了问题"],
    tools: ["正在调用工具", "已调用工具"],
  };
  /* 和桌面 ui-chat 的 PROCESS_ICONS 同一套字形：思考/工具行不再是自绘图标 */
  const CAT_ICON = {
    thinking: "i-d-think",
    read: "i-d-browse", readImage: "i-d-browse", search: "i-d-search", write: "i-d-edit",
    edit: "i-d-edit", commands: "i-d-api", code: "i-d-code", webSearch: "i-d-globe",
    webFetch: "i-d-globe", subagents: "i-d-agent", team: "i-d-agent", plan: "i-d-plan",
    questions: "i-d-question", tools: "i-d-sparkle",
  };

  /** 桌面 activity(name) 的同一份判定：PC 会话只拿得到工具名，图标按这里落 */
  function toolCatOf(name) {
    const n = String(name || "");
    if (n === "read") return "read";
    if (n === "read_image") return "readImage";
    if (n === "grep" || n === "glob" || n.endsWith("_inspect")) return "search";
    if (n === "write") return "write";
    if (n === "edit" || n === "apply_patch") return "edit";
    if (["bash", "pwsh", "exec_command", "write_stdin"].includes(n) || n.startsWith("terminal_")) return "commands";
    if (n === "run_code") return "code";
    if (n === "web_search") return "webSearch";
    if (n === "web_fetch") return "webFetch";
    if (n === "subagent" || n.startsWith("subagent_")) return "subagents";
    if (["todo_write", "create_goal", "update_goal", "get_goal"].includes(n)) return "plan";
    if (n === "ask_user_question" || n === "request_user_input") return "questions";
    return "tools";
  }
  const toolIconOf = (name) => CAT_ICON[toolCatOf(name)] || "i-d-sparkle";
  /** 实时详情：按桌面优先级取第一个非空字段；数组全部为字符串时用 ", " 连接 */
  function toolDetail(name, argsJson) {
    let a = {};
    try { a = typeof argsJson === "string" ? JSON.parse(argsJson || "{}") : (argsJson || {}); } catch (_) { return String(name || ""); }
    const prio = ["title", "description", "objective", "task", "task_name", "name", "question", "questions",
      "prompt", "message", "command", "cmd", "queries", "query", "pattern", "url", "uri", "file_path", "path", "target", "action", "status"];
    for (const k of prio) {
      const v = a[k];
      if (typeof v === "string" && v.trim()) return v.trim().slice(0, 160);
      if (Array.isArray(v) && v.length) {
        if (k === "questions") {
          // questions 取对象数组中首个非空 question（桌面规则）
          const q = v.find((x) => x && typeof x.question === "string" && x.question.trim());
          if (q) return q.question.trim().slice(0, 160);
        } else if (v.every((x) => typeof x === "string")) {
          const s = v.join(", ").trim();
          if (s) return s.slice(0, 160);
        }
      }
    }
    return String(name || "");
  }
  /* 文件改动的增删行数：桌面在「编辑 <路径>」行尾显示 `+6 -3`，手机照着来。
     edit 的增减取自 old_string / new_string 的行数（单点替换与桌面读数一致）；
     write 只知道写入内容，减记 0。replace_all 的倍数在结果里按「替换 N 处」再乘。 */
  function parseArgs(argsJson) {
    try {
      return typeof argsJson === "string" ? JSON.parse(argsJson || "{}") : (argsJson || {});
    } catch (_) {
      return null;
    }
  }

  /** 会产生图片的工具：路径从参数或结果里取 */
  function imagePathOf(name, argsJson) {
    if (name !== "read_image") return "";
    const a = parseArgs(argsJson);
    return (a && (a.file_path || a.path || a.image_path)) || "";
  }

  function lineCount(text) {
    if (typeof text !== "string" || text.length === 0) return 0;
    return text.split("\n").length;
  }

  function toolDiff(name, argsJson) {
    const a = parseArgs(argsJson);
    if (!a) return null;
    if (name === "edit" || name === "str_replace_editor" || name === "apply_patch") {
      const oldText = a.old_string ?? a.old_str ?? a.old ?? "";
      const newText = a.new_string ?? a.new_str ?? a.new ?? "";
      const added = lineCount(newText);
      const removed = lineCount(oldText);
      if (!added && !removed) return null;
      // 原文一起留住：快照里只有行数就画不出 diff（桌面 file-mutation 视图是这样做的）。
      // 限长 1200 字，超出的部分在画的时候标注「已截断」，不让会话快照无限膨胀。
      const clip = (t) => String(t || "").slice(0, 1200);
      return { added, removed, before: clip(oldText), after: clip(newText) };
    }
    if (name === "write") {
      const added = lineCount(a.content);
      if (!added) return null;
      return { added, removed: 0, before: "", after: String(a.content || "").slice(0, 1200) };
    }
    return null;
  }

  /** 目标是文件路径的工具：摘要按蓝色等宽显示，和命令/查询区分 */
  const FILE_TOOLS = new Set([
    "read", "write", "edit", "list_dir", "str_replace_editor", "apply_patch",
    "read_image", "stat", "delete_path", "mkdir",
  ]);

  function diffChipsHTML(diff) {
    if (!diff || (!diff.added && !diff.removed)) return "";
    const parts = [];
    if (diff.added) parts.push(`<i class="add">+${diff.added}</i>`);
    if (diff.removed) parts.push(`<i class="del">-${diff.removed}</i>`);
    return `<span class="pg-diff">${parts.join("")}</span>`;
  }

  /* ---------------- 改动对照的轻量语法高亮 ----------------
     不引第三方库：按扩展名选关键字表，逐行切出「注释 / 字符串 / 数字 / 关键字」四类。
     行底色仍由 diff 决定，只给 token 上色，读代码时眼睛能抓住结构。 */
  const HL_KEYWORDS = {
    c: "abstract|as|break|case|catch|class|const|continue|default|do|else|enum|extends|false|final|finally|for|fun|if|implements|import|in|interface|is|null|object|open|override|package|private|protected|public|return|sealed|static|super|this|throw|true|try|val|var|void|when|while|new|delete|typeof|instanceof|async|await|yield|function|let|export|from|of|switch|struct|impl|fn|pub|use|mut|match|loop|trait",
    py: "and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield",
    sh: "if|then|else|elif|fi|for|while|do|done|case|esac|function|return|export|local|set|source|echo|cd|sudo|rm|cp|mv|mkdir|node|npm|git",
    sql: "select|from|where|join|left|right|inner|outer|on|group|by|order|having|limit|offset|insert|into|values|update|set|delete|create|table|index|alter|drop|and|or|not|null|as|distinct|count|sum|avg|case|when|then|end",
  };
  const HL_FAMILY = {
    kt: "c", kts: "c", java: "c", js: "c", mjs: "c", cjs: "c", ts: "c", tsx: "c", jsx: "c",
    c: "c", h: "c", cpp: "c", cc: "c", hpp: "c", cs: "c", go: "c", rs: "c", swift: "c",
    dart: "c", php: "c", scala: "c", groovy: "c", gradle: "c", json: "c",
    py: "py", rb: "py", yml: "py", yaml: "py", toml: "py",
    sh: "sh", bash: "sh", zsh: "sh", ps1: "sh",
    sql: "sql",
  };
  const HL_COMMENT = { c: "//", py: "#", sh: "#", sql: "--" };

  function hlLangOf(path) {
    const name = String(path || "").split(/[\\/]/).pop() || "";
    const m = /\.([a-z0-9]+)$/i.exec(name);
    return m ? (HL_FAMILY[m[1].toLowerCase()] || "") : "";
  }

  function highlightLine(text, family) {
    if (!family) return esc(text);
    const kw = HL_KEYWORDS[family] || "";
    const marker = HL_COMMENT[family] || "//";
    const source = [
      "(" + marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\s\\S]*$)",
      "(\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|`(?:\\\\.|[^`\\\\])*`)",
      "(\\b\\d+(?:\\.\\d+)?\\b)",
      kw ? "\\b(" + kw + ")\\b" : "",
    ].filter(Boolean).join("|");
    const re = new RegExp(source, "gi");
    let out = "";
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      out += esc(text.slice(last, m.index));
      if (m[1]) out += `<span class="tk-c">${esc(m[1])}</span>`;
      else if (m[2]) out += `<span class="tk-s">${esc(m[2])}</span>`;
      else if (m[3]) out += `<span class="tk-n">${esc(m[3])}</span>`;
      else if (m[4]) out += `<span class="tk-k">${esc(m[4])}</span>`;
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex += 1;
    }
    out += esc(text.slice(last));
    return out;
  }

  /** 展开后的改动对照：删的行红底、增的行绿底，并按文件类型高亮 token */
  function editDiffHTML(argsJson, filePath) {
    const a = parseArgs(argsJson);
    if (!a) return "";
    const oldText = a.old_string ?? a.old_str ?? a.old ?? "";
    const newText = a.new_string ?? a.new_str ?? a.new ?? "";
    if (!oldText && !newText) return "";
    const family = hlLangOf(filePath || a.file_path || a.path || "");
    const rows = [];
    String(oldText).split("\n").forEach((l) => {
      if (String(oldText).length) rows.push(`<div class="df-l del">${highlightLine(l, family) || " "}</div>`);
    });
    String(newText).split("\n").forEach((l) => {
      if (String(newText).length) rows.push(`<div class="df-l add">${highlightLine(l, family) || " "}</div>`);
    });
    if (!rows.length) return "";
    return `<div class="io-sec"><span class="io-label">改动</span><div class="df">${rows.join("")}</div></div>`;
  }

  /** 组头摘要组合：1 类=该文案；2 类=「并」；3 类=中文逗号；>3=前三类+「等」 */
  function pgroupTitleClosed(counts, order) {
    const ranked = order.filter((c) => counts[c] > 0);
    if (!ranked.length) return "已完成分析";
    const labels = ranked.slice(0, 3).map((c) => CAT_ACTIVITY[c][1]);
    if (labels.length === 1) return labels[0];
    if (labels.length === 2) {
      const [a, b] = labels;
      return a + "并" + (a.startsWith("已") && b.startsWith("已") ? b.slice(1) : b);
    }
    if (ranked.length > 3) return labels.join("，") + "等";
    return labels.join("，");
  }
  function pgroupTitle(g) {
    if (g.running && g.running.cat) {
      const base = (CAT_ACTIVITY[g.running.cat] || CAT_ACTIVITY.tools)[0];
      // 收起时组头就是用户在看的那一行：带上摘要（thinkSummary 给正在写的这一段，
      // syncThinkTail 钉在末尾 —— 滚动速度等于输出速度）。
      // 展开后正文就在下面，这一行不再重复摘要，否则看着像半句话。
      return g.running.detail && !g.open ? `${base} · ${g.running.detail}` : base;
    }
    if (g.closed || g.folded) return pgroupTitleClosed(g.counts, g.order);
    return "正在分析请求";
  }

  /* ---- 过程行（桌面 ReasoningRow / ToolRow 同构） ---- */
  /** 思考摘要：运行中取「正在写的这一段」（尾部锚定后停在最新字上），结束后取首行 */
  function thinkSummary(m) {
    // 收起时这一行是用户唯一看得见的一行，所以它必须一直有内容：
    // 从最后一段往前找**第一个非空**的段。以前直接取数组末尾那一段，而模型每段之间都夹一个空行、
    // 一整段思考也常以空行收尾 —— 于是每个段落边界（和收尾那一刻）这一行被清空，
    // 界面上就只剩「思考」两个字（用户实测：不显示最新那一行）。
    const parts = String(m.text || "").split(/\r?\n(?:[\t ]*\r?\n)+/);
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = String(parts[i] || "").replace(/\s*\n\s*/g, " ").trim().replaceAll("**", "");
      if (p) return p;
    }
    return "";
  }

  /** 取一行文本的**尾部** n 个字符（思考行要停在最新内容上，不是从开头截） */
  function pageClipTail(text, n) {
    const t = String(text || "").trim();
    return t.length <= n ? t : "…" + t.slice(-(n - 1));
  }

  function firstLine(text) {
    const s = String(text || "").trim();
    const nl = s.indexOf("\n");
    return (nl === -1 ? s : s.slice(0, nl)).trim();
  }

  /** 实时输出要显示的是「最后那一行」（命令常连着吐几个空行，空行不算） */
  function lastLine(text) {
    const lines = String(text || "").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (t) return t;
    }
    return "";
  }

  /**
   * 路径摘要：模型常传 "." / "./" 或干脆不传（工具默认落在工作区根），
   * 原样摆出来就是一个孤零零的蓝点 —— 用户实测「查看目录 · .」看不出它在干什么。
   * 相对路径本来就是相对工作区的，所以根目录用工作区名顶上，其余原样保留。
   */
  function pathForDisplay(p) {
    const t = String(p || "").trim();
    if (t && t !== "." && t !== "./" && t !== ".\\") return t;
    return `${state.workspace || "harness"}/（工作区根目录）`;
  }

  /** 运行中实时输出的内存上限：只留尾巴（构建日志能刷出几 MB，整条留着没必要） */
  const LIVE_OUT_MAX = 20000;

  function fmtToolMs(ms) {
    const v = Number(ms) || 0;
    if (v <= 0) return "";
    return v < 1000 ? v + "ms" : (v / 1000).toFixed(v < 10000 ? 1 : 0) + "s";
  }

  /** 轮次用时：数字用等宽字体（桌面 formatRunDuration） */
  function durHTML(secs) {
    const total = Math.max(0, Math.floor(Number(secs) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor(total / 60) % 60;
    const s = total % 60;
    const parts = [];
    if (h > 0) parts.push(`<i class="tp-num">${h}</i> 小时`);
    if (total >= 60) parts.push(`<i class="tp-num">${m}</i> 分`);
    parts.push(`<i class="tp-num">${s}</i> 秒`);
    return parts.join("");
  }

  function fmtArgs(args) {
    let raw = args;
    if (typeof raw === "string") {
      try { raw = JSON.parse(raw); } catch (_) { return String(args).slice(0, 4000); }
    }
    try {
      const s = JSON.stringify(raw, null, 2);
      return s.length > 4000 ? s.slice(0, 4000) + "\n…" : s;
    } catch (_) { return String(args).slice(0, 4000); }
  }

  /** 展开后的输入/输出卡片（桌面 ioCard） */
  function ioHTML(m) {
    const input = m.args ? fmtArgs(m.args) : "";
    // 还在跑：没有最终结果，先把已经刷出来的实时输出摆上（tool_end 一到就被权威结果替换）
    const running = m.status === "run";
    const output = String(m.out || "").trim() || (running ? String(m.__live || "").trim() : "");
    const err = m.status === "err";
    const secs = [];
    if (m.imagePath) {
      secs.push(m.imageData
        ? `<div class="io-sec"><img class="tool-thumb" src="${m.imageData}" alt=""></div>`
        : `<div class="io-sec"><div class="tool-thumb-hint">图片已生成 · 点这一行展开加载</div></div>`);
    }
    // 改动类工具直接给「删/增」对照，比整段 args JSON 好读得多
    const diff = m.diff ? editDiffHTML(m.args, m.detail) : "";
    if (diff) {
      secs.push(diff);
    } else if (input) {
      secs.push(`<div class="io-sec"><span class="io-label">输入</span><span class="io-text">${esc(input)}</span></div>`);
    }
    if (output) {
      // 跑完的长输出截头（结果的前面才是结论），跑动中的截尾（最新那一行才是进度）
      const shown = output.length <= 6000 ? output
        : (running ? "…" + output.slice(-6000) : output.slice(0, 6000) + "\n…");
      secs.push(`<div class="io-sec"><span class="io-label">输出</span><span class="io-text${err ? " is-err" : ""}">${esc(shown)}</span></div>`);
    }
    if (!secs.length) {
      secs.push(`<div class="io-sec"><span class="io-label">状态</span><span class="io-text">${m.status === "run" ? "运行中…" : (err ? "执行失败" : "已完成")}</span></div>`);
    }
    return `<div class="io">${secs.join('<i class="io-div"></i>')}</div>`;
  }

  function thinkRowHTML(m, i) {
    const sum = thinkSummary(m);
    const running = m.status === "run";
    return `
      <div class="pg-row is-think${running ? " is-run" : ""}${m.open ? " is-open" : ""}" data-pg-row="${i}">
        <button class="pg-main" data-pg-toggle="${i}">
          <svg class="pg-ico"><use href="#i-d-think"/></svg>
          <span class="pg-title">思考</span>
          ${sum && !m.open ? `<i class="pg-sep"></i><span class="pg-sum${running ? " is-shimmer" : ""}"${running ? shimmerAttr() : ""}>${esc(sum)}</span>` : ""}
        </button>
        <div class="pg-detail"><div class="pg-think-text">${md(m.text || "")}</div></div>
      </div>`;
  }


  function toolRowHTML(m, i) {
    const running = m.status === "run";
    const err = m.status === "err";
    // 文件类工具的目标路径按桌面的样子用蓝色等宽字显示，和命令/查询区分开
    const isPath = FILE_TOOLS.has(m.name) && !err;
    const detail = isPath ? pathForDisplay(m.detail) : m.detail;
    // 运行中已经有实时输出了，就把「正在打印的那一行」摆到摘要位（配合 syncThinkTail
    // 钉尾，看到的是最新一行而不是开头）；参数摘要退到它前面，滚出去也认得出来。
    const live = running ? lastLine(m.__live) : "";
    const sum = err ? (firstLine(m.out) || "执行失败")
      : (live ? `${detail ? detail + " · " : ""}${live}` : (detail || ""));
    const ms = fmtToolMs(m.ms);
    return `
      <div class="pg-row is-tool${running ? " is-run" : ""}${err ? " is-err" : ""}${m.open ? " is-open" : ""}" data-pg-row="${i}">
        <button class="pg-main" data-pg-toggle="${i}">
          <svg class="pg-ico"><use href="#${CAT_ICON[m.cat] || "i-branch"}"/></svg>
          <span class="pg-title${running ? " is-shimmer" : ""}"${running ? shimmerAttr() : ""}>${esc(m.title || TOOL_LABEL[m.name] || m.name || "工具")}</span>
          ${sum ? `<i class="pg-sep"></i><span class="pg-sum${running ? " is-shimmer" : ""}${live ? " is-live" : ""}${err ? " is-err" : ""}${isPath ? " pg-path" : ""}"${running ? shimmerAttr() : ""}>${esc(sum)}</span>` : ""}
          ${diffChipsHTML(m.diff)}
          ${m.exitCode === null || m.exitCode === undefined ? "" : `<span class="pg-exit${m.exitCode === 0 ? "" : " is-bad"}">exit ${m.exitCode}</span>`}
          ${running
            ? `<span class="pg-ms" data-run-ms="${m.startedAt || 0}">${m.startedAt ? Math.max(1, Math.round((Date.now() - m.startedAt) / 1000)) + " s" : ""}</span>`
            : (ms ? `<span class="pg-ms">${ms}</span>` : "")}
        </button>
        <div class="pg-detail">${ioHTML(m)}${diffBlockHTML(m.diff)}</div>
      </div>`;
  }

  /**
   * 真实改动对照（桌面 ui-tool 的 file-mutation-row）：行级 LCS 出 +/- 行。
   * 只给窗口内的前 160 行，超长改动退回一行说明 —— 手机上没人会去读 800 行 diff。
   */
  function diffBlockHTML(diff) {
    if (!diff || (diff.before === undefined && diff.after === undefined)) return "";
    const a = String(diff.before || "").split("\n");
    const b = String(diff.after || "").split("\n");
    if (a.length > 300 || b.length > 300) {
      return `<div class="df"><div class="df-note">改动较大（${a.length} → ${b.length} 行），只显示行数</div></div>`;
    }
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m && out.length < 160) {
      if (a[i] === b[j]) { out.push(`<div class="df-l">${esc(a[i])}</div>`); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(`<div class="df-l is-del">-${esc(a[i])}</div>`); i++; }
      else { out.push(`<div class="df-l is-add">+${esc(b[j])}</div>`); j++; }
    }
    while (i < n && out.length < 160) out.push(`<div class="df-l is-del">-${esc(a[i++])}</div>`);
    while (j < m && out.length < 160) out.push(`<div class="df-l is-add">+${esc(b[j++])}</div>`);
    const cut = (i < n || j < m) ? `<div class="df-note">只显示前 160 行</div>` : "";
    return `<div class="df">${out.join("")}${cut}</div>`;
  }

  const Plugins = {
    _data: null,
    info(force = false) {
      if (!force && this._data) return this._data;
      try {
        this._data = (Native && Native.pluginList)
          ? JSON.parse(Native.pluginList())
          : { plugins: [], errors: [], logs: [] };
      } catch (_) { this._data = { plugins: [], errors: [], logs: [] }; }
      if (!Array.isArray(this._data.plugins)) this._data.plugins = [];
      return this._data;
    },
    setEnabled(id, on) {
      try {
        const r = JSON.parse(Native.setPluginEnabled(id, on));
        Kernel._schemas = null;      // 工具目录变了，下次请求重新拉 schema
        this._data = null;
        return r;
      } catch (_) { return null; }
    },
    summary() {
      const d = this.info();
      const on = d.plugins.filter((p) => p.enabled).length;
      return d.plugins.length ? `${on}/${d.plugins.length} 已启用` : "不可用";
    },
  };

  function refreshPlugins() {
    const el = $("#pluginValue");
    if (el) el.textContent = Plugins.summary();
  }

  function toolKind(name) {
    if (name === "bash") return "shell";
    if (name === "glob" || name === "grep") return "glob";
    if (name === "read" || name === "list_dir" || name === "stat") return "read";
    if (name === "subagent") return "subagent";
    if (name === "web_search" || name === "web_fetch") return "web";
    if (name === "exit_plan_mode" || name === "update_goal" || name === "create_goal" ||
        name === "get_goal" || name === "todo_write") return "plan";
    if (name === "run_code") return "shell";
    return "edit";
  }
  function toolMetaText(name, argsJson) {
    let a = {};
    try { a = JSON.parse(argsJson || "{}"); } catch (_) {}
    const brief = a.path || a.pattern || a.command || a.task || "";
    return String(brief).replace(/\s+/g, " ").slice(0, 60);
  }

  /** 子代理：独立上下文里跑工具循环，最终只把结论交回主代理；每步都通过 onStep 上报 */
  async function runSubagent(args, onStep) {
    const task = String((args && args.task) || "").trim();
    if (!task) return { ok: false, error: "task 不能为空" };
    const rounds = Math.max(1, Math.min(10, Number(args.max_rounds) || 6));
    const tools = Kernel.toolDefs(false).filter((t) => {
      const n = t.function.name;
      return n !== "subagent" && n !== "exit_plan_mode" && n !== "update_goal";
    });
    const msgs = [
      {
        role: "system",
        content:
          "你是一个子代理，只负责完成交给你的子任务。可以使用文件与命令工具；" +
          "完成后用简短中文汇报结果（做了什么、结论、关键文件），不要寒暄，不要复述任务。",
      },
      { role: "user", content: task },
    ];
    for (let i = 0; i < rounds; i++) {
      let r;
      try { r = await Kernel.once(msgs, tools); }
      catch (e) { return { ok: false, error: "子代理请求失败：" + (e.message || e) }; }
      const calls = r.toolCalls || [];
      if (!calls.length) {
        const out = (r.text || "").trim();
        return { ok: true, output: out || "（子代理没有返回内容）" };
      }
      msgs.push({
        role: "assistant",
        content: r.text || null,
        tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
      });
      for (const c of calls) {
        let a = {};
        try { a = JSON.parse(c.arguments || "{}"); } catch (_) {}
        const step = {
          name: TOOL_LABEL[c.name] || c.name,
          kind: toolKind(c.name),
          meta: toolMetaText(c.name, c.arguments),
          status: "run",
          out: "",
        };
        if (onStep) onStep(step, "start");
        const res = await Kernel.call(c.name, a);
        step.status = res.ok === false ? "err" : "ok";
        step.out = res.ok === false ? (res.error || "失败") : String(res.output || "");
        if (onStep) onStep(step, "end");
        msgs.push({
          role: "tool",
          tool_call_id: c.id,
          name: c.name,
          content: res.ok === false ? "ERROR: " + res.error : String(res.output || ""),
        });
      }
    }
    return { ok: true, output: "（子代理达到轮数上限，未给出结论）" };
  }

  /* ---------------- 内置模式的工具：exit_plan_mode / update_goal ---------------- */

  /** 计划评审：把 Promise 挂在 PlanReview 上，卡片按钮点击后结算 */
  const PlanReview = { pending: null, node: null };

  function presentPlan(args) {
    const node = NODES.plan({
      pid: uid("p"),
      title: String((args && args.title) || "执行计划").slice(0, 40),
      plan: String((args && args.plan) || "").trim() || "（模型没有给出计划正文）",
      status: "pending",
      note: "",
    });
    push(node, true);
    haptic("light");
    return new Promise((resolve) => {
      PlanReview.pending = resolve;
      PlanReview.node = node;
    });
  }

  /** 结算计划卡片：批准 / 打回修订 / 结束 */
  function settlePlan(node, status, feedback) {
    if (!node) return;
    node.status = status;
    node.note = status === "approved"
      ? "已批准 · 写操作已解锁，正在按计划执行"
      : status === "revised"
        ? "已提交修改意见：" + feedback
        : "已结束本轮规划 · 计划模式仍然开启";
    patchNode(node);
    haptic(status === "approved" ? "medium" : "light");

    if (status === "approved") {
      Modes.approvePlan();
      if (state.sessionId) {
        try { LocalDB.setPlan(state.sessionId, { text: node.plan, title: node.title, status: "approved", at: Date.now() }); } catch (_) {}
      }
    }
    syncModeBar();

    // 原生内核在等这一次评审结论：直接回传，不再走 JS 的 Promise
    if (NativeAgent.active && Native && Native.agentPlanDecision) {
      const approved = status === "approved";
      Native.agentPlanDecision(Live.id, approved, status === "revised" ? feedback : "");
      PlanReview.pending = null;
      PlanReview.node = null;
      return;
    }

    const resolve = PlanReview.pending;
    PlanReview.pending = null;
    PlanReview.node = null;
    if (!resolve) return;
    if (status === "approved") {
      toast("已批准，继续执行");
      resolve({ ok: true, output: "用户已批准计划。写类工具已解锁，按计划执行；每完成一步简要说明结果。" });
    } else if (status === "revised") {
      toast("已提交修改意见");
      resolve({ ok: false, error: "用户要求继续规划，反馈：" + feedback + "。请据此修订计划，再次调用 exit_plan_mode 提交。" });
    } else {
      toast("已结束本轮规划");
      resolve({ ok: false, error: "用户结束了本轮规划，未批准执行。不要执行写操作，用一两句话确认下一步该怎么做。" });
    }
  }

  /** 目标模式：模型汇报/改写目标（兼容旧版 status 写法） */
  function markGoal(args) {
    const g = Modes.goal();
    if (!g) return { ok: false, error: "当前会话没有激活的目标" };
    const action = String((args && (args.action || args.status)) || "").trim();
    const summary = String((args && (args.blocked_reason || args.summary)) || "").slice(0, 300);
    // 阶段推进：以新目标覆盖旧目标，phase 保持 active 继续推进
    if (action === "edit") {
      const objective = String((args && (args.objective || args.summary)) || "").trim();
      if (!objective) return { ok: false, error: "edit 需要 objective：写清这一阶段要达成什么" };
      Modes.setGoal({ ...g, objective, phase: "active", summary, updatedAt: Date.now() });
      push(NODES.goalresult({ status: "edited", summary: objective }), true);
      haptic("light");
      toast("目标已更新");
      return { ok: true, output: "目标已更新为：" + objective + "。之后各轮按这个目标推进，做完再调用 complete。" };
    }
    const status = action === "complete" ? "complete" : action === "blocked" ? "blocked" : "";
    if (!status) return { ok: false, error: "action 只能是 edit / complete / blocked" };
    const objective = String((args && args.objective) || "").trim();
    Modes.setGoal({ ...g, phase: status, summary, objective: objective || g.objective, updatedAt: Date.now() });
    push(NODES.goalresult({ status, summary }), true);
    haptic(status === "complete" ? "medium" : "light");
    toast(status === "complete" ? "目标已完成" : "目标受阻，等你处理");
    return {
      ok: true,
      output: status === "complete" ? "已记录：目标完成。" + summary : "已记录：目标受阻。" + summary,
    };
  }

  /** 主代理的工具轮次状态 */
  const Agent = {
    active: false,
    pendingCalls: null,
    messages: null,
    round: 0,
    maxRounds: 12,
  };

  function agentReset() {
    Agent.active = false;
    Agent.pendingCalls = null;
    Agent.messages = null;
    Agent.round = 0;
  }

  /** 一轮结束：有工具调用就执行并续跑，否则收尾 */
  async function agentAfterRound() {
    const calls = Agent.pendingCalls || [];
    Agent.pendingCalls = null;
    const body = Live.text.trim();

    if (!calls.length || Agent.round >= Agent.maxRounds) {
      Agent.active = false;
      if (goalWantsNext()) { goalAdvance(null); return; }
      finishLive(null);
      state.busy = false;
      updateSendState();
      return;
    }

    Agent.round++;
    const wireCalls = calls.map((c) => ({
      id: c.id, type: "function", function: { name: c.name, arguments: c.arguments },
    }));
    if (body) Agent.messages.push({ role: "assistant", content: body, tool_calls: wireCalls });
    else Agent.messages.push({ role: "assistant", content: null, tool_calls: wireCalls });

    for (const c of calls) {
      const t0 = Date.now();
      let args = {};
      try { args = JSON.parse(c.arguments || "{}"); } catch (_) {}

      // 计划评审与目标状态是客户端 seam，不落成普通工具卡片
      if (c.name === "exit_plan_mode") {
        const res = await presentPlan(args);
        Agent.messages.push({
          role: "tool", tool_call_id: c.id, name: c.name,
          content: res.ok === false ? "DENIED: " + res.error : String(res.output || ""),
        });
        scrollToBottom();
        continue;
      }
      if (c.name === "update_goal") {
        const res = markGoal(args);
        Agent.messages.push({
          role: "tool", tool_call_id: c.id, name: c.name,
          content: res.ok === false ? "ERROR: " + res.error : String(res.output || ""),
        });
        scrollToBottom();
        continue;
      }

      const member = Flow.toolStart({ id: c.id, name: c.name, args: c.arguments });

      const res = c.name === "subagent"
        ? await runSubagent(args, (step, phase) => {
            if (phase === "start") Flow.note(member, step);
          })
        : await Kernel.call(c.name, args);

      Flow.toolEnd(c.id, {
        ok: res.ok !== false,
        output: res.ok === false ? (res.error || "执行失败") : String(res.output || ""),
        ms: Date.now() - t0,
      });

      Agent.messages.push({
        role: "tool",
        tool_call_id: c.id,
        name: c.name,
        content: res.ok === false ? "ERROR: " + res.error : String(res.output || ""),
      });
    }

    // 用户中途停止：不要再起下一轮
    if (Live.cancelled) { Agent.active = false; Agent.pendingCalls = null; return; }

    // 工具跑完继续输出：在流末尾开新的一段正文（前面的节点原地不动）
    Live.cancelled = false;
    Live.dirty = false;
    Live.lastIsland = 0;
    Flow.newText();

    const m = findModel(state.model);
    const ep = endpointOf(m);
    const payload = {
      model: m.upstream || m.id,
      messages: Agent.messages,
      stream: true,
      max_tokens: TOKEN_LIMIT[state.maxOut] || 65536,
      ...effortField(),
      tools: Kernel.toolDefs(),
      tool_choice: "auto",
    };
    if (Native && Native.chatStream) Native.chatStream(Live.id, ep.url, ep.key, JSON.stringify(payload));
  }

  /* ---------------- 目标模式：跨轮推进（等价桌面端 goal-round-driver） ---------------- */

  function goalWantsNext() {
    const g = Modes.goal();
    if (!g || g.phase !== "active") return false;
    if (currentMode() !== "local") return false;       // 宿主机模式有自己的循环
    if (!Kernel.enabled()) return false;                // 没有工具就只是闲聊，不必续跑
    const done = g.rounds || 0;
    const cap = goalCap(g);
    if (cap ? done >= cap : done >= GOAL_SMART_CAP) return false;  // 智能模式也留安全上限
    if (Live.cancelled) return false;
    if (!liveBody()) return false;                // 空回复不续跑，避免空转
    return true;
  }

  /** 一轮结束但目标没达成：收尾当前气泡，带目标提示再起一轮 */
  function goalAdvance(usage) {
    const sid = Live.sessionId;
    const g = Modes.goal();
    if (!sid || !g || g.phase !== "active") { return; }
    // 续跑属于发起它的那个会话：流没切到它那一份就先切过来（中途切过会话的情形）
    if (thread.__sid !== sid) attachThread(sid);
    finishLive(usage);
    const round = (g.rounds || 0) + 2;                  // 首次续跑 = 第 2 轮
    Modes.setGoal({ ...g, rounds: (g.rounds || 0) + 1, updatedAt: Date.now() });
    state.busy = true;
    updateSendState();

    push(NODES.goalround({ round, max: goalCap(g) }));

    beginLive(sid, modelLabel());
    const s = LocalDB.get(sid) || { messages: [] };
    const history = (s.messages || []).slice();
    const nudge = [
      `[目标续跑 · ${goalRoundLabel(g, round)}] 目标：${g.objective}`,
      "只做尚未完成的下一步，不要重复已完成的工作。",
      '已完成就调用 update_goal(status="complete")；卡住就 update_goal(status="blocked") 并说明原因。',
    ].join("\n");
    const messages = buildMessages(history, nudge);
    const m = findModel(state.model);
    const ep = endpointOf(m);
    const payload = {
      model: m.upstream || m.id,
      messages,
      stream: true,
      max_tokens: TOKEN_LIMIT[state.maxOut] || 65536,
      ...effortField(),
    };
    const tools = Kernel.toolDefs();
    if (tools.length) {
      payload.tools = tools;
      payload.tool_choice = "auto";
      Agent.active = true;
      Agent.messages = messages;
      Agent.round = 0;
      Agent.pendingCalls = null;
    }
    if (Native && Native.chatStream) Native.chatStream(Live.id, ep.url, ep.key, JSON.stringify(payload));
    else { state.busy = false; updateSendState(); }
  }


  // 本地会话列表（转成与会话行同构的视图模型）
  function localSessionView() {
    return LocalDB.all().map((s, i) => {
      // 预览取「最后一条消息」而不是「最后一条助手消息」：
      // 刚发出、还没回复就退出对话时，列表也该显示你刚说的那句，而不是上一轮。
      // 索引里不内嵌 messages（分键存储），只有 push 时写下的 lastMsg 摘要
      const last = s.messages
        ? (s.messages.length ? s.messages[s.messages.length - 1] : null)
        : (s.lastMsg || null);
      const title = s.title || "新会话";
      const previewText = last
        ? (String(last.content || "").replace(/\s+/g, " ").trim()
          || (Array.isArray(last.atts) && last.atts.length ? "[图片]" : ""))
        : "";
      return {
        id: s.id,
        title,
        sub: (previewText || (last ? "" : "本地会话 · 尚未提问")).slice(0, 48),
        time: new Date(s.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }),
        letter: title.trim().slice(0, 1).toUpperCase(),
        tint: TINTS[i % TINTS.length],
        tokens: s.tokens || 0,
        pin: !!s.pin,
        // 列表上要能看出哪个会话正在跑（退出去再回来不至于认不出来）
        running: !!(state.busy && s.id === state.sessionId),
        // 老数据没有 ws 字段：按默认工作区归类，不要因此把会话弄丢
        ws: s.ws || DEFAULT_WS,
        at: s.updatedAt || s.createdAt || 0,
      };
    });
  }

  async function loadSessions() {
    if (currentMode() === "local") { state.sessions = []; renderSessions(); return; }
    try {
      const result = await Host.call("session/list", {});
      state.lastError = "";
      // 宿主机返回结构可能是 {sessions:[...]} 或数组，兼容两种
      const list = Array.isArray(result) ? result
        : (result?.sessions || result?.items || []);
      state.sessions = list.map((it, i) => ({
        id: it.id || it.sessionId || ("s" + i),
        title: it.title || it.name || it.id || "未命名会话",
        sub: it.lastMessage || it.summary || "",
        time: it.updatedAt ? new Date(it.updatedAt).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "",
        letter: (it.title || it.name || it.id || "未").trim().slice(0, 1).toUpperCase(),
        tint: TINTS[i % TINTS.length],
        running: !!it.running,
        // 宿主机把会话挂在哪个工作区就显示哪个；没带就归默认工作区
        ws: it.workspace || it.workspaceId || it.cwd || DEFAULT_WS,
        at: Number(it.updatedAt) || 0,
        pin: !!it.pinned,
      }));
    } catch (e) {
      state.sessions = [];
      state.lastError = e.message;
    }
    renderSessions();
  }

  /* ---------------- markdown-lite ---------------- */
  /* ---- 极简语法着色（零依赖，对齐桌面 shiki 但走 class 方案）----
     输入假定已 esc（& < > " ' 均已实体化）。按语言给 token 加 class，不支持的语言原样返回。
     覆盖高频语言：ts/js/py/bash/kotlin/java/go/rust/c/cpp/c#/json/yaml/sql/hcl/docker/make。
     字符串引号已实体化（&quot; / &#39;），扫描以实体为边界、遇 \ 跳 2 处理转义引号。 */
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
