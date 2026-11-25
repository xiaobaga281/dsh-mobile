# 宣传片生成（贴纸拼贴叙事）

不依赖剪辑软件：真实界面截图 + PIL 逐帧合成 + edge-tts 旁白 + numpy 配乐 + ffmpeg 编码。

## 管线

```bash
# 1) 采集当前版本界面（无头 Edge + CDP，390×844@2x）
node scripts/promo/capture_screens.mjs

# 2) 先出 7 张关键帧检查版式
python scripts/promo/make_promo.py --stills

# 3) 渲染全片（约 34s / 1920×1080 / 30fps）
python scripts/promo/make_promo.py --render
```

- 素材输出：`D:/1/tmp/promo/screens/`
- 横屏成片（1920×1080）：`D:/1/dsh-mobile-release/promo/dsh-mobile-promo-rc176.mp4`
- 抖音竖屏成片（1080×1920）：`D:/1/dsh-mobile-release/promo/dsh-mobile-promo-rc176-douyin.mp4`

抖音版：

```bash
python scripts/promo/make_promo_vertical.py --stills
python scripts/promo/make_promo_vertical.py --render
```

竖屏版不是横屏裁剪：标题上移、手机界面居中放大，字幕/按钮避开抖音底栏与右侧操作区。

## 依赖

- Node 22+（内置 `fetch` / `WebSocket`）
- 本机 Edge（`C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`）
- Python 3：`pillow`、`numpy`、`qrcode[pil]`、`edge-tts`
- `ffmpeg` / `ffprobe` 在 PATH

## 设计约定

- **只用真实界面**：截图由 preview 当前源码 + 注入的演示数据产生，不画假 UI。
- **贴纸叙事**：米色再生纸底、白色模切边、胶带、手写批注、鲸鱼贴纸、章节签。
- **节奏**：7 个场景（口袋 / 会动手 / 随手调 / 连电脑 / 后台跑 / 留在本机 / 下载），
  每场一个短句旁白 + 底部字幕；转场用纸张闪白，不做幻灯片式 Ken Burns。
- 旧版宣传素材（4 张图 + 旧成片）已从本地与 GitHub 仓库清除，本管线生成的是替换版本。
