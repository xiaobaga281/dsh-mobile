package ai.deepseek.harness.mobile.kernel.plugin.builtin.doc

import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.doc.DocWriter
import ai.deepseek.harness.mobile.kernel.doc.PdfWriter
import ai.deepseek.harness.mobile.kernel.doc.PptxWriter
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.Schemas
import ai.deepseek.harness.mobile.kernel.plugin.SimpleTool
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import ai.deepseek.harness.mobile.kernel.plugin.pick
import ai.deepseek.harness.mobile.kernel.plugin.pickBool
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 文档生成 —— 补上「只能读不能写」的另一半。
 *
 * 之前手机端能读 PDF/Word/Excel/PPT，却写不出 .docx/.xlsx，于是提示词里只能要求模型
 * 「表格交 CSV、报告交 Markdown，不要声称生成了 xlsx」。这在实际使用里很别扭：
 * 用户说「给我一份周报 Word」「把这批数据做成 Excel」，交付的却是 .md/.csv。
 *
 * 现在两个工具直接产出**真正的 OOXML 包**（[DocWriter]，纯 JDK 实现）：
 *   - `write_docx`：Markdown 子集 → Word（标题/项目符号/编号/引用/代码块/表格/粗体）
 *   - `write_xlsx`：二维数据 → Excel（表头加粗冻结、列宽自适应、数字保持数值型）
 *
 * 边界也写清楚，避免模型夸大：不嵌图片、不做页眉页脚/目录/合并单元格。这些在手机上
 * 由模型硬凑只会产出打不开的文件，不如直接告诉用户「这部分需要电脑端处理」。
 */
class DocWritePlugin : KernelPlugin {
    override val id = "doc-write"
    override val name = "文档生成"
    override val description = "生成 .docx 报告与 .xlsx 表格（纯 JDK 写 OOXML，Word/WPS/Excel 可直接打开）"
    override val version = "1.0.0"

    private var ctx: PluginContext? = null
    private var written = 0

    override fun onLoad(ctx: PluginContext) { this.ctx = ctx }
    override fun onUnload() { ctx = null }

    override fun status(): Map<String, String> = mapOf(
        "已生成" to written.toString(),
        "格式" to "docx / xlsx / pptx / pdf / zip",
    )

    override fun promptSection(): String? =
        "【写文档】要交付 Word 用 write_docx（正文写 Markdown 子集：标题、- 列表、1. 编号、> 引用、```代码```、| 表格 |、**粗体**、![](工作区图片相对路径) 嵌入图片），" +
            "要交付 Excel 用 write_xlsx（二维数组或 CSV 文本），" +
            "要交付 PPT 用 write_pptx（**必须用 layout 分页型**：cover 封面 / section 章节页 / bullets 要点 / two-col 双栏对比 / quote 引言 / table 表格；每页可给 image（工作区 png/jpg）+ image_side（right/left/full）嵌配图；" +
            "每页还可以给 transition（页切换：fade 默认 / push / wipe / cover / none）——这是整页转场，不是元素动画；" +
            "整套演示稿至少给一页 cover、按章节给 section，accent 传一个主色；只写 bullets 会得到一份很单调的稿子），" +
            "要交付 PDF 用 write_pdf（正文写同一套 Markdown 子集），要把多个文件一起发出去用 write_zip（paths 给工作区相对路径，目录会递归）。" +
            "生成后路径会进交付卡片，不要再用 write 手写 XML，也不要声称生成了图片/动效。" +
            "不嵌图片、不合并单元格、不做动画；用户要这些时说清需要电脑端处理。"

    private fun schema(props: JSONObject, required: List<String>): JSONObject = JSONObject().apply {
        put("type", "object")
        put("properties", props)
        put("required", JSONArray(required))
        put("additionalProperties", false)
    }

    /** 写入路径统一走沙箱：完全授权按字面，标准/只读模式下会被 checkWrite 拦下 */
    private fun target(path: String, ext: String): File {
        val c = ctx ?: throw KernelError("工作区未就绪")
        val p = path.trim().ifBlank { "docs/文档-${System.currentTimeMillis()}.$ext" }
        val f = c.sandbox.checkWrite(p) ?: c.workspace.resolve(p)
        if (f.isDirectory) throw KernelError("目标是目录：$p")
        if (!f.name.contains('.')) throw KernelError("路径缺少扩展名，应该是 .$ext：$p")
        if (!f.extension.equals(ext, ignoreCase = true)) {
            throw KernelError("扩展名不对：write_$ext 只写 .$ext，收到 .${f.extension}")
        }
        (c.service("workspace.journal") as? ai.deepseek.harness.mobile.kernel.WorkspaceJournal)?.record(f, "write")
        return f
    }

    override val tools: List<ToolSpec> = listOf(
        SimpleTool(
            name = "write_docx",
            description =
                "生成 Word 文档（.docx）。content 用 Markdown 子集：`# 标题`、`- 列表`、`1. 编号`、`> 引用`、" +
                    "```代码块```、`| 表格 |`（第二行 |---| 分隔）、`**粗体**`、`---` 分隔线。标题会渲染成真正的 Word 标题，" +
                    "表格是真正的表格（表头有底色、单元内有边距），正文首行缩进两字符、1.5 倍行距，" +
                    "自动带封面页（大标题+副标题+作者+日期）、页眉和页脚页码。\n" +
                    "写报告/方案时：title 给正式名称、subtitle 给一句话说明、content 里用 # / ## 分章节。" +
                    "cover=false 可关掉封面（便签、清单这类短文档）；header=\"-\" 关页眉。不嵌图片、不合并单元格。",
            parameters = schema(
                JSONObject()
                    .put("file_path", JSONObject().put("type", "string").put("description", "保存路径（相对工作区），必须以 .docx 结尾，例如 报告/周报.docx"))
                    .put("content", JSONObject().put("type", "string").put("description", "正文（Markdown 子集）"))
                    .put("title", JSONObject().put("type", "string").put("description", "文档标题（也用作封面上的大标题与页眉）"))
                    .put("subtitle", JSONObject().put("type", "string").put("description", "封面副标题，一句话说明文档用途"))
                    .put("author", JSONObject().put("type", "string").put("description", "封面署名，默认 DeepSeek Harness"))
                    .put("date", JSONObject().put("type", "string").put("description", "封面日期行，默认今天"))
                    .put("cover", JSONObject().put("type", "boolean").put("description", "是否生成封面页，默认 true"))
                    .put("header", JSONObject().put("type", "string").put("description", "页眉文字，默认用 title；传 \"-\" 关闭")),
                listOf("file_path", "content"),
            ),
        ) { a ->
            val c = ctx ?: throw KernelError("工作区未就绪")
            val content = a.getString("content")
            if (content.isBlank()) throw KernelError("content 不能为空")
            if (content.length > 400_000) throw KernelError("正文过长（${content.length} 字），请拆成多份文档")
            val f = target(a.pick("file_path", "path"), "docx")
            val r = DocWriter.writeDocx(
                f, content,
                title = a.optString("title"),
                author = a.optString("author").ifBlank { "DeepSeek Harness" },
                subtitle = a.optString("subtitle"),
                cover = if (a.has("cover")) a.optBoolean("cover", true) else true,
                header = a.optString("header"),
                dateText = a.optString("date"),
                // 图片嵌入：![](工作区相对路径) 行会被解析成 inline 图片（media part 进包）
                imageResolver = { rel -> runCatching { c.workspace.resolve(rel) }.getOrNull()?.takeIf { it.isFile } },
            )
            written++
            JSONObject().apply {
                put("ok", true)
                put("path", c.workspace.relative(f))
                put("bytes", r.bytes)
                put("paragraphs", r.meta["paragraphs"] ?: 0)
                put("images", r.meta["images"] ?: 0)
                put("cover", r.meta["cover"] ?: false)
                put("note", "已生成 Word 文档（含封面/页眉/页码）；用户可直接用 WPS/Word 打开")
            }.toString()
        },

        SimpleTool(
            name = "write_xlsx",
            description =
                "生成 Excel 表格（.xlsx）。两种写法任选：sheets 给二维数组（第一行默认作表头：加粗、冻结、自动筛选、列宽按内容自适应），" +
                    "或只给 csv 文本（逗号或制表符分隔）作为单表。数字会保存为数值型（不是文本），以 0 开头的编号保持文本。",
            parameters = schema(
                JSONObject()
                    .put("file_path", JSONObject().put("type", "string").put("description", "保存路径（相对工作区），必须以 .xlsx 结尾"))
                    .put(
                        "sheets",
                        JSONObject().put("type", "array").put("description", "多工作表：每项 {name, rows: [[...]], header?:true}").put(
                            "items",
                            JSONObject().put("type", "object").put(
                                "properties",
                                JSONObject()
                                    .put("name", JSONObject().put("type", "string"))
                                    .put("rows", JSONObject().put("type", "array").put("items", JSONObject().put("type", "array").put("items", JSONObject().put("type", "string"))))
                                    .put("header", JSONObject().put("type", "boolean")),
                            ),
                        ),
                    )
                    .put("csv", JSONObject().put("type", "string").put("description", "单表简写：整段 CSV/TSV 文本"))
                    .put("sheet_name", JSONObject().put("type", "string").put("description", "csv 简写时的表名，默认 Sheet1")),
                listOf("file_path"),
            ),
        ) { a ->
            val c = ctx ?: throw KernelError("工作区未就绪")
            val sheets = mutableListOf<DocWriter.Sheet>()
            val arr = a.optJSONArray("sheets")
            if (arr != null) {
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    val rows = mutableListOf<List<String>>()
                    val rowArr = o.optJSONArray("rows")
                    if (rowArr != null) {
                        for (r in 0 until rowArr.length()) {
                            val line = rowArr.optJSONArray(r) ?: continue
                            rows.add((0 until line.length()).map { line.optString(it, "") })
                        }
                    }
                    if (rows.isNotEmpty()) {
                        sheets.add(DocWriter.Sheet(o.optString("name", "Sheet${i + 1}"), rows, o.optBoolean("header", true)))
                    }
                }
            }
            if (sheets.isEmpty()) {
                val csv = a.optString("csv")
                if (csv.isBlank()) throw KernelError("sheets 与 csv 至少给一个")
                val rows = DocWriter.parseTable(csv)
                if (rows.isEmpty()) throw KernelError("csv 里没有可用的行")
                sheets.add(DocWriter.Sheet(a.optString("sheet_name", "Sheet1"), rows, header = a.optBoolean("header", true)))
            }
            if (sheets.sumOf { it.rows.size } > 20_000) throw KernelError("行数过多（>20000），请拆分成多个文件")
            val f = target(a.pick("file_path", "path"), "xlsx")
            val r = DocWriter.writeXlsx(f, sheets)
            written++
            JSONObject().apply {
                put("ok", true)
                put("path", c.workspace.relative(f))
                put("bytes", r.bytes)
                put("sheets", r.meta["sheets"] ?: sheets.size)
                put("rows", r.meta["rows"] ?: 0)
                put("note", "已生成 Excel 表格；表头已加粗冻结，数字为数值型")
            }.toString()
        },

        SimpleTool(
            name = "write_pptx",
            description =
                "生成 PowerPoint 演示文稿（.pptx），16:9，WPS/PowerPoint 可直接打开编辑。\n" +
                    "slides 每页都要给 layout：\n" +
                    "· cover —— 封面：title 主标题、subtitle 副标题、by 作者/日期（整页主色背景）\n" +
                    "· section —— 章节页：title 章节名、subtitle 一句说明\n" +
                    "· bullets —— 要点页（默认）：bullets 列表，以两个空格开头为二级要点\n" +
                    "· two-col —— 双栏对比：left / right 两个字符串数组，可用 \"## 小标题\" 做栏头\n" +
                    "· quote —— 引言页：title 是引文正文、by 是出处\n" +
                    "· table —— 表格页：table 是二维数组，第一行自动作为表头（主色底白字）\n" +
                    "可选 accent（六位十六进制主色，如 1F6FEB）统一整套配色，footer 作页脚；页码自动加。" +
                    "不做图片、图表、动画、自定义母版。",
            parameters = schema(
                JSONObject()
                    .put("file_path", JSONObject().put("type", "string").put("description", "保存路径（相对工作区），必须以 .pptx 结尾"))
                    .put(
                        "slides",
                        JSONObject().put("type", "array").put("description", "幻灯片数组").put(
                            "items",
                            JSONObject().put("type", "object").put(
                                "properties",
                                JSONObject()
                                    .put("layout", JSONObject().put("type", "string").put("description", "cover / section / bullets / two-col / quote / table，默认 bullets"))
                                    .put("title", JSONObject().put("type", "string").put("description", "本页标题（quote 页则是引文正文）"))
                                    .put("subtitle", JSONObject().put("type", "string").put("description", "副标题/说明，封面与章节页用"))
                                    .put("by", JSONObject().put("type", "string").put("description", "作者或出处，cover/quote 用"))
                                    .put("bullets", JSONObject().put("type", "array").put("items", JSONObject().put("type", "string")).put("description", "要点（bullets 版式）"))
                                    .put("left", JSONObject().put("type", "array").put("items", JSONObject().put("type", "string")).put("description", "左栏（two-col 版式）"))
                                    .put("right", JSONObject().put("type", "array").put("items", JSONObject().put("type", "string")).put("description", "右栏（two-col 版式）"))
                                    .put("table", JSONObject().put("type", "array").put("items", JSONObject().put("type", "array").put("items", JSONObject().put("type", "string"))).put("description", "二维数组，首行为表头（table 版式）"))
                                    .put("note", JSONObject().put("type", "string").put("description", "页脚小字，可省略")),
                            ),
                        ),
                    )
                    .put("title", JSONObject().put("type", "string").put("description", "文档属性里的标题，也作为默认页脚"))
                    .put("accent", JSONObject().put("type", "string").put("description", "主色，六位十六进制不带 #，默认 2B6CB0"))
                    .put("footer", JSONObject().put("type", "string").put("description", "页脚文字，默认用 title")),
                listOf("file_path", "slides"),
            ),
        ) { a ->
            val c = ctx ?: throw KernelError("工作区未就绪")
            val arr = a.optJSONArray("slides") ?: throw KernelError("slides 不能为空")
            fun strs(o: JSONObject, key: String): List<String> {
                val out = mutableListOf<String>()
                o.optJSONArray(key)?.let { b ->
                    for (j in 0 until b.length()) b.optString(j, "").takeIf { it.isNotBlank() }?.let { out.add(it) }
                }
                return out
            }
            val slides = mutableListOf<PptxWriter.Slide>()
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val rows = mutableListOf<List<String>>()
                o.optJSONArray("table")?.let { tb ->
                    for (k in 0 until tb.length()) {
                        val row = tb.optJSONArray(k) ?: continue
                        rows.add((0 until row.length()).map { row.optString(it, "") })
                    }
                }
                slides.add(
                    PptxWriter.Slide(
                        title = o.optString("title", "第 ${i + 1} 页"),
                        bullets = strs(o, "bullets"),
                        note = o.optString("note"),
                        layout = o.optString("layout", "bullets").ifBlank { "bullets" },
                        subtitle = o.optString("subtitle"),
                        by = o.optString("by"),
                        left = strs(o, "left"),
                        right = strs(o, "right"),
                        table = rows,
                        // 配图：工作区相对路径（png/jpg）；image_side = right/left/full
                        image = o.optString("image"),
                        imageSide = o.optString("image_side", "right").ifBlank { "right" },
                        // 页切换：fade（默认）/ push / wipe / cover / none
                        transition = o.optString("transition", "fade").ifBlank { "fade" },
                    ),
                )
            }
            if (slides.isEmpty()) throw KernelError("slides 里没有可用的页")
            val f = target(a.pick("file_path", "path"), "pptx")
            val r = PptxWriter.write(
                f, slides, a.optString("title"),
                accent = a.optString("accent"),
                footer = a.optString("footer"),
                // 配图嵌入：解析不到的图会被忽略该页配图（不阻断整份 PPT）
                imageResolver = { rel -> runCatching { c.workspace.resolve(rel) }.getOrNull()?.takeIf { it.isFile } },
            )
            written++
            val kinds = slides.map { it.layout.lowercase() }.toSet()
            JSONObject().apply {
                put("ok", true)
                put("path", c.workspace.relative(f))
                put("bytes", r.bytes)
                put("slides", r.slides)
                put("layouts", kinds.joinToString(","))
                put("note", "已生成 PPT（${r.slides} 页，版式：${kinds.joinToString("、")}）；可直接用 WPS/PowerPoint 编辑")
            }.toString()
        },

        SimpleTool(
            name = "write_pdf",
            description =
                "生成 PDF（.pdf）。content 用与 write_docx 相同的 Markdown 子集（标题/列表/编号/引用/代码块/表格/分隔线）。" +
                    "正文用设备中文字体真实排版并自动分页，不是图片也不是纯文本；可打印。" +
                        "注意：文字按字形绘制，**不可选中/搜索**（要可检索的文本请用 docx）。不嵌图片。",
            parameters = schema(
                JSONObject()
                    .put("file_path", JSONObject().put("type", "string").put("description", "保存路径（相对工作区），必须以 .pdf 结尾"))
                    .put("content", JSONObject().put("type", "string").put("description", "正文（Markdown 子集）"))
                    .put("title", JSONObject().put("type", "string").put("description", "标题，会作为一级标题写在最前"))
                    .put("accent", JSONObject().put("type", "string")
                        .put("description", "主色（6 位 hex，如 4C8DFF），作用于 H1 下划线/引用竖条/表头底色；缺省用品牌蓝")),
                listOf("file_path", "content"),
            ),
        ) { a ->
            val c = ctx ?: throw KernelError("工作区未就绪")
            val content = a.getString("content")
            if (content.isBlank()) throw KernelError("content 不能为空")
            if (content.length > 400_000) throw KernelError("正文过长（${content.length} 字），请拆成多份")
            val f = target(a.pick("file_path", "path"), "pdf")
            val r = PdfWriter.write(f, content, a.optString("title"), accent = a.optString("accent"))
            written++
            JSONObject().apply {
                put("ok", true)
                put("path", c.workspace.relative(f))
                put("bytes", r.bytes)
                put("pages", r.pages)
                put("note", "已生成 PDF（版式排版，可打印；文字因中文字体按字形绘制，暂不可选中/搜索）")
            }.toString()
        },

        SimpleTool(
            name = "write_zip",
            description =
                "把多个文件/目录打成 .zip（.zip）。paths 给工作区相对路径数组，目录会递归打包（保留相对结构）。" +
                    "适合「把这些交付物一起发出去」。同名条目只保留第一个。",
            parameters = schema(
                JSONObject()
                    .put("file_path", JSONObject().put("type", "string").put("description", "保存路径（相对工作区），必须以 .zip 结尾"))
                    .put(
                        "paths",
                        JSONObject().put("type", "array").put("items", JSONObject().put("type", "string"))
                            .put("description", "要打包的路径（相对工作区），目录递归"),
                    ),
                listOf("file_path", "paths"),
            ),
        ) { a ->
            val c = ctx ?: throw KernelError("工作区未就绪")
            val arr = a.optJSONArray("paths") ?: throw KernelError("paths 不能为空")
            val entries = mutableListOf<Pair<String, File>>()
            for (i in 0 until arr.length()) {
                val raw = arr.optString(i, "").trim()
                if (raw.isBlank()) continue
                val src = c.workspace.resolve(raw)
                if (!src.exists()) continue
                if (src.isDirectory) {
                    val base = c.workspace.resolve(raw)
                    base.walkTopDown()
                        // 交付包不该带内核自己的撤销存档与构建产物：体积翻倍，还可能泄露已删文件的旧内容
                        .onEnter { it.name !in setOf(".dsh", ".git", "node_modules", "build", ".gradle") }
                        .filter { it.isFile }.forEach { file ->
                            entries.add(file.relativeTo(base).path.let { "${base.name}/$it" } to file)
                        }
                } else {
                    entries.add(c.workspace.relative(src) to src)
                }
            }
            if (entries.isEmpty()) throw KernelError("paths 里没有找到任何文件")
            if (entries.size > 5_000) throw KernelError("文件数过多（${entries.size}），请分批打包")
            val f = target(a.pick("file_path", "path"), "zip")
            val r = DocWriter.writeZip(f, entries)
            written++
            JSONObject().apply {
                put("ok", true)
                put("path", c.workspace.relative(f))
                put("bytes", r.bytes)
                put("entries", r.meta["entries"] ?: 0)
                put("note", "已打包；解压后保持原有目录结构")
            }.toString()
        },
    )
}
