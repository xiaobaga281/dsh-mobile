package ai.deepseek.harness.mobile.kernel.doc

import java.io.ByteArrayOutputStream
import java.util.zip.Inflater

/**
 * PDF 正文抽取（统一实现，[DocReader] 与 DocPreview 共用）。
 *
 * 之前那版只认「内容流里的字面 ASCII」：`(你好) Tj`。这在纯西文 PDF 上凑合能用，
 * 但**中文 PDF 一律是 CID 编码** —— 内容流里是 `<00010002> Tj` 这种字形编号，
 * 直接当字符读出来就是乱码，于是所有中文 PDF（包括本应用自己生成的）都显示
 * 「没有文本层」。
 *
 * 正确做法是顺着 `/ToUnicode` CMap 把字形编号映射回 Unicode：
 *   1. 扫出所有间接对象，建立 `对象号 → 字典/流`；
 *   2. 字体字典里的 `/ToUnicode N 0 R` 指向一份 CMap 流，解析 bfchar / bfrange；
 *   3. 内容流里用 `Tf` 切换当前字体，Tj/TJ 的串按该字体「单字节还是 CID」解码。
 *
 * 仍然是「提取文本、不还原版式」。扫描件（纯图）没有文本层，本类返回空串，
 * 调用方自行提示用户。
 */
object PdfText {

    /** @return 抽出的正文；没有可用文本层时返回空串 */
    fun extract(bytes: ByteArray): String {
        val raw = String(bytes, Charsets.ISO_8859_1)
        val objs = parseObjects(raw, bytes)
        if (objs.isEmpty()) return ""
        val fonts = buildFonts(objs)
        val sb = StringBuilder()
        // 内容流：有文本操作符的流。按对象顺序处理，避免把 XObject 表单重复算进来
        objs.values.filter { it.stream != null }
            .sortedBy { it.id }
            .forEach { obj ->
                val body = String(obj.stream!!, Charsets.ISO_8859_1)
                if (!body.contains("Tj") && !body.contains("TJ") && !body.contains("'")) return@forEach
                val text = decodeContent(body, fonts)
                if (text.isNotBlank()) sb.append(text).append('\n')
            }
        return sb.toString().trim().replace(Regex("[ \\t]{2,}"), " ").replace(Regex("\\n{3,}"), "\n\n")
    }

    /* ---------------- 对象与流 ---------------- */

    private class Obj(val id: Int, val dict: String, val stream: ByteArray?)

    private fun parseObjects(raw: String, bytes: ByteArray): Map<Int, Obj> {
        val out = LinkedHashMap<Int, Obj>()
        val head = Regex("(\\d+)\\s+\\d+\\s+obj\\b")
        var pos = 0
        while (true) {
            val m = head.find(raw, pos) ?: break
            val id = m.groupValues[1].toIntOrNull() ?: 0
            val dictStart = m.range.last + 1
            val end = raw.indexOf("endobj", dictStart).let { if (it < 0) raw.length else it }
            val sIdx = raw.indexOf("stream", dictStart)
            val hasStream = sIdx in dictStart until end
            if (!hasStream) {
                if (id > 0) out[id] = Obj(id, raw.substring(dictStart, end), null)
                pos = end + 6
                continue
            }
            val dict = raw.substring(dictStart, sIdx)
            var dataStart = sIdx + 6
            if (dataStart < raw.length && raw[dataStart] == '\r') dataStart++
            if (dataStart < raw.length && raw[dataStart] == '\n') dataStart++
            // 流长度：优先信字典里的 /Length，它才是权威。
            // 以前在这里全文搜 "endstream" 定界，二进制流（字形、CMap）里随机出现
            // "endstream" 字节就会被截断 → inflate 失败 → 内容流全丢 → 中文 PDF 抽不出正文。
            val lenM = Regex("/Length\\s+(\\d+)(?!\\s+\\d+\\s+R)").find(dict)
            val dataEnd = if (lenM != null) {
                (dataStart + (lenM.groupValues[1].toIntOrNull() ?: 0)).coerceAtMost(bytes.size)
            } else {
                // 无 /Length 才回退搜 endstream，且要求行首（PDF 规范：endstream 前必有 EOL）
                var e = -1
                var p = dataStart
                while (p < raw.length) {
                    val cand = raw.indexOf("endstream", p)
                    if (cand < 0) break
                    val before = if (cand > 0) raw[cand - 1] else ' '
                    if (before == '\n' || before == '\r') { e = cand; break }
                    p = cand + 9
                }
                if (e < 0) end else e
            }
            val rawData = bytes.copyOfRange(dataStart.coerceAtMost(bytes.size), dataEnd)
            val stream = if (dict.contains("/FlateDecode")) inflate(rawData) else rawData
            if (id > 0) out[id] = Obj(id, dict, stream)
            // 下一个对象从 endstream 之后继续；找不到就用数据末尾
            val es = raw.indexOf("endstream", dataEnd).let { if (it < 0) dataEnd else it + 9 }
            pos = es.coerceAtLeast(pos + 1)
        }
        return out
    }

    private fun inflate(data: ByteArray): ByteArray? = runCatching {
        val inf = Inflater()
        inf.setInput(data)
        val out = ByteArrayOutputStream(data.size * 4 + 64)
        val buf = ByteArray(16 * 1024)
        while (!inf.finished()) {
            val n = inf.inflate(buf)
            if (n <= 0) break
            out.write(buf, 0, n)
        }
        inf.end()
        out.toByteArray()
    }.getOrNull()

    /* ---------------- 字体 → CMap ---------------- */

    private class Font(val twoByte: Boolean, val map: Map<Int, String>)

    /**
     * 资源名 → 字体。PDF 里同一页的 `/F1` 通常指向同一字体，跨页复用很常见；
     * 极少数文档会用同一个名字指向不同字体（每页重定义资源），那种情况按「先出现者」
     * 处理 —— 抽文本只求可读，不追求逐页精确。
     */
    private fun buildFonts(objs: Map<Int, Obj>): Map<String, Font> {
        // 1. 每个字体对象 → Font
        val byId = HashMap<Int, Font>()
        objs.forEach { (id, o) ->
            val toUni = Regex("/ToUnicode\\s+(\\d+)\\s+\\d+\\s+R").find(o.dict)?.groupValues?.get(1)?.toIntOrNull()
            // 只有 Type0（复合字体，Identity-H 编码）才是双字节 CID；
            // Type3 的 glyph 过程虽然也写着 CIDToGIDMap /Identity，但代码始终是单字节。
            val twoByte = o.dict.contains("/Type0") || o.dict.contains("/Identity-H")
            val map = if (toUni != null) objs[toUni]?.stream?.let { parseCMap(String(it, Charsets.ISO_8859_1)) } ?: emptyMap() else emptyMap()
            byId[id] = Font(twoByte, map)
        }
        // 2. 资源字典里 /Font << /F1 12 0 R /F2 13 0 R >> → 名字到字体
        val out = HashMap<String, Font>()
        Regex("/Font\\s*<<([\\s\\S]{0,4000}?)>>").findAll(objs.values.joinToString("\n") { it.dict }).forEach { m ->
            Regex("/([A-Za-z0-9_.+-]+)\\s+(\\d+)\\s+\\d+\\s+R").findAll(m.groupValues[1]).forEach { e ->
                val f = byId[e.groupValues[2].toIntOrNull() ?: return@forEach]
                if (f != null && f.map.isNotEmpty()) out.putIfAbsent(e.groupValues[1], f)
            }
        }
        return out
    }

    /** CMap：beginbfchar / beginbfrange，目标串是 UTF-16BE 十六进制 */
    private fun parseCMap(s: String): Map<Int, String> {
        val map = HashMap<Int, String>()
        Regex("beginbfchar([\\s\\S]*?)endbfchar").findAll(s).forEach { blk ->
            Regex("<([0-9A-Fa-f]+)>\\s*<([0-9A-Fa-f]+)>").findAll(blk.groupValues[1]).forEach { p ->
                val src = p.groupValues[1].toIntOrNull(16) ?: return@forEach
                map[src] = hexToString(p.groupValues[2])
            }
        }
        Regex("beginbfrange([\\s\\S]*?)endbfrange").findAll(s).forEach { blk ->
            val body = blk.groupValues[1]
            // <lo> <hi> <dst>
            Regex("<([0-9A-Fa-f]+)>\\s*<([0-9A-Fa-f]+)>\\s*<([0-9A-Fa-f]+)>").findAll(body).forEach { p ->
                val lo = p.groupValues[1].toIntOrNull(16) ?: return@forEach
                val hi = p.groupValues[2].toIntOrNull(16) ?: return@forEach
                val dst = p.groupValues[3]
                val base = dst.toIntOrNull(16) ?: 0
                for (c in lo..hi) {
                    val v = base + (c - lo)
                    map[c] = if (dst.length <= 4) String(Character.toChars(if (v <= 0x10FFFF) v else 0xFFFD))
                    else hexToString(Integer.toHexString(v).padStart(4, '0'))
                }
            }
            // <lo> <hi> [<d1> <d2> ...]
            Regex("<([0-9A-Fa-f]+)>\\s*<([0-9A-Fa-f]+)>\\s*\\[([\\s\\S]*?)]").findAll(body).forEach { p ->
                val lo = p.groupValues[1].toIntOrNull(16) ?: return@forEach
                Regex("<([0-9A-Fa-f]+)>").findAll(p.groupValues[3]).forEachIndexed { i, d ->
                    map[lo + i] = hexToString(d.groupValues[1])
                }
            }
        }
        return map
    }

    private fun hexToString(hex: String): String {
        val sb = StringBuilder()
        var i = 0
        while (i + 3 < hex.length + 1 && i < hex.length) {
            val end = minOf(i + 4, hex.length)
            val code = hex.substring(i, end).toIntOrNull(16) ?: break
            sb.appendCodePoint(if (code == 0) 0x20 else code)
            i = end
        }
        return sb.toString()
    }

    /* ---------------- 内容流解码 ---------------- */

    private fun decodeContent(body: String, fonts: Map<String, Font>): String {
        val out = StringBuilder()
        var font: Font? = null
        val operands = ArrayList<Any>()
        var array: ArrayList<Any>? = null
        var i = 0
        val n = body.length
        while (i < n) {
            val ch = body[i]
            when {
                ch == '%' -> { while (i < n && body[i] != '\n') i++ }
                ch == '<' && i + 1 < n && body[i + 1] == '<' -> { i += 2 }
                ch == '>' && i + 1 < n && body[i + 1] == '>' -> { i += 2 }
                ch == '<' -> {
                    val e = body.indexOf('>', i)
                    if (e < 0) { i = n; continue }
                    val hex = body.substring(i + 1, e).filter { !it.isWhitespace() }
                    val op: Any = HexStr(hex)
                    if (array != null) array.add(op) else operands.add(op)
                    i = e + 1
                }
                ch == '(' -> {
                    val (s, next) = readLiteral(body, i)
                    val op: Any = LitStr(s)
                    if (array != null) array.add(op) else operands.add(op)
                    i = next
                }
                ch == '[' -> { array = ArrayList(); i++ }
                ch == ']' -> { operands.add(array ?: ArrayList<Any>()); array = null; i++ }
                ch == '/' -> {
                    var j = i + 1
                    while (j < n && !body[j].isWhitespace() && body[j] !in "/[]<>()") j++
                    val name = body.substring(i + 1, j)
                    if (array != null) array.add(Name(name)) else operands.add(Name(name))
                    i = j
                }
                ch.isWhitespace() -> i++
                else -> {
                    var j = i
                    while (j < n && !body[j].isWhitespace() && body[j] !in "/[]<>()") j++
                    val tok = body.substring(i, j)
                    i = if (j == i) i + 1 else j
                    if (tok.isEmpty()) continue
                    if (isOperator(tok)) {
                        when (tok) {
                            "Tf" -> {
                                val nm = operands.filterIsInstance<Name>().lastOrNull()?.v
                                if (nm != null) font = fonts[nm]
                            }
                            "Tj", "'", "\"" -> {
                                val s = operands.lastOrNull() as? LitStr ?: operands.lastOrNull() as? HexStr
                                if (s != null) out.append(decodeStr(s, font))
                                if (tok == "'" || tok == "\"") out.append('\n')
                            }
                            "TJ" -> {
                                val arr = operands.lastOrNull() as? ArrayList<Any>
                                arr?.forEach { el -> if (el is LitStr || el is HexStr) out.append(decodeStr(el, font)) }
                            }
                            "Td", "TD", "T*", "ET" -> out.append('\n')
                        }
                        operands.clear()
                    } else {
                        val d = tok.toDoubleOrNull()
                        if (d != null) { if (array != null) array.add(d) else operands.add(d) }
                    }
                }
            }
        }
        return out.toString().replace(Regex(" *\n *"), "\n").replace(Regex("\n{2,}"), "\n").trim()
    }

    private fun isOperator(t: String): Boolean =
        t in setOf("Tf", "Tj", "TJ", "'", "\"", "Td", "TD", "T*", "ET", "BT", "Tz", "TL", "Tr", "Ts", "Tc", "Tw")

    private class Name(val v: String)
    private class LitStr(val v: String)
    private class HexStr(val v: String)

    private fun decodeStr(s: Any, font: Font?): String = when (s) {
        is LitStr -> {
            val f = font
            if (f != null && f.map.isNotEmpty() && f.twoByte) {
                val bytes = s.v.toByteArray(Charsets.ISO_8859_1)
                val sb = StringBuilder()
                var i = 0
                while (i + 1 < bytes.size) {
                    val cid = ((bytes[i].toInt() and 0xFF) shl 8) or (bytes[i + 1].toInt() and 0xFF)
                    sb.append(f.map[cid] ?: "")
                    i += 2
                }
                sb.toString()
            } else if (f != null && f.map.isNotEmpty()) {
                s.v.map { ch -> f.map[ch.code] ?: ch.toString() }.joinToString("")
            } else s.v
        }
        is HexStr -> {
            val hex = s.v
            val f = font
            if (f != null && f.map.isNotEmpty()) {
                val sb = StringBuilder()
                if (f.twoByte) {
                    var i = 0
                    while (i + 4 <= hex.length) {
                        val cid = hex.substring(i, i + 4).toIntOrNull(16) ?: 0
                        sb.append(f.map[cid] ?: "")
                        i += 4
                    }
                } else {
                    var i = 0
                    while (i + 2 <= hex.length) {
                        val cid = hex.substring(i, i + 2).toIntOrNull(16) ?: 0
                        sb.append(f.map[cid] ?: "")
                        i += 2
                    }
                }
                sb.toString()
            } else {
                // 没有 CMap：按字节当 UTF-16BE 试一把（不少工具导出的就是这个）
                val sb = StringBuilder()
                var i = 0
                while (i + 4 <= hex.length) {
                    val code = hex.substring(i, i + 4).toIntOrNull(16) ?: 0
                    if (code >= 0x20) sb.appendCodePoint(code)
                    i += 4
                }
                if (sb.isEmpty()) hex.chunked(2).mapNotNull { it.toIntOrNull(16)?.toChar() }.joinToString("") else sb.toString()
            }
        }
        else -> ""
    }

    /** 字面串：处理 \\ 转义与括号配对 */
    private fun readLiteral(s: String, start: Int): Pair<String, Int> {
        val sb = StringBuilder()
        var i = start + 1
        var depth = 1
        while (i < s.length) {
            val c = s[i]
            when {
                c == '\\' -> {
                    i++
                    if (i >= s.length) break
                    when (val e = s[i]) {
                        'n' -> sb.append('\n')
                        'r' -> sb.append('\r')
                        't' -> sb.append('\t')
                        'b' -> sb.append('\b')
                        'f' -> sb.append('\u000C')
                        '(', ')', '\\' -> sb.append(e)
                        in '0'..'7' -> {
                            var oct = ""
                            var k = 0
                            while (k < 3 && i < s.length && s[i] in '0'..'7') { oct += s[i]; i++; k++ }
                            i--
                            sb.append((oct.toIntOrNull(8) ?: 0).toChar())
                        }
                        '\n', '\r' -> Unit
                        else -> sb.append(e)
                    }
                    i++
                }
                c == '(' -> { depth++; sb.append(c); i++ }
                c == ')' -> { depth--; if (depth == 0) { i++; break }; sb.append(c); i++ }
                else -> { sb.append(c); i++ }
            }
        }
        return sb.toString() to i
    }
}
