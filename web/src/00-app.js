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
