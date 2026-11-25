package ai.deepseek.harness.mobile.kernel.plugin.builtin.app

import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.sandbox.WorkspaceSandbox
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.zip.CRC32
import java.util.zip.Deflater

/**
 * 工程脚手架：一次写出一份「能编译、能启动、有图标」的最小 Android 工程。
 *
 * 为什么要有它：`app_build` 只负责编译，模型要造 App 还得手写清单、资源目录、
 * 图标位图、Activity 源码 —— 少了任何一处都是编译期报错，而模型没有「看着 IDE 改」的机会。
 * 这里把**结构契约**固化成模板（包名 → 源码路径、清单 → 启动 Activity、图标 → mipmap 分档），
 * 模型只需要改 MainActivity 的界面。
 *
 * 图标不用随包带 PNG 素材：本文件里有个三十行的 PNG 编码器（IHDR/IDAT/IEND + zlib），
 * 按主色现画 —— 圆角底 + 对角渐变 + 白色三角，双倍超采样抗锯齿。省掉每个图标 5 档位图的体积，
 * 也让「换主色」变成一次参数，而不是换一套素材。
 */
internal object AppScaffold {

    data class Result(val dir: File, val pkg: String, val activities: Int, val files: List<String>)

    private val PACKAGE_RE = Regex("^[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z][a-zA-Z0-9_]*)+$")
    private val PAGE_CLASSES = listOf("MainActivity", "SecondActivity", "ThirdActivity")

    /** mipmap 分档：密度名 → 边长（px）。48/72/96/144/192 是启动图标的标准五档 */
    private val ICON_SIZES = listOf("mdpi" to 48, "hdpi" to 72, "xhdpi" to 96, "xxhdpi" to 144, "xxxhdpi" to 192)

    fun generate(
        sb: WorkspaceSandbox,
        dirArg: String,
        pkgArg: String,
        labelArg: String,
        activitiesArg: Int,
        colorArg: String,
        force: Boolean,
    ): Result {
        val dir = dirArg.trim().trim('.', '/').ifBlank { throw KernelError("dir 不能为空（例如 hello）") }
        val root = sb.checkWrite(dir)
        if (root.isFile) throw KernelError("$dir 是一个文件，不是目录")
        if (root.isDirectory && !force) {
            val existing = root.listFiles()?.filter { it.name != ".dsh" }?.map { it.name }.orEmpty()
            if (existing.isNotEmpty()) {
                throw KernelError(
                    "$dir 已存在且非空（${existing.take(5).joinToString("、")}）。" +
                        "换个目录名，或传 force=true 覆盖已有文件",
                )
            }
        }

        val pkg = pkgArg.trim().ifBlank { "com.dsh." + sanitizePackage(dir) }
        if (!PACKAGE_RE.matches(pkg)) throw KernelError("包名不合法：$pkg（形如 com.example.app）")
        val label = labelArg.trim().ifBlank { dir.replace(Regex("[_/-]+"), " ").trim().ifBlank { "App" } }
        val activities = activitiesArg.coerceIn(1, PAGE_CLASSES.size)
        val color = parseColor(colorArg).let { if (it == 0) 0xFF4C6FFF.toInt() else it }
        val colorHex = "#%06X".format(color and 0xFFFFFF)

        val written = mutableListOf<String>()
        fun write(rel: String, text: String) {
            val f = File(root, rel)
            f.parentFile?.mkdirs()
            f.writeText(text)
            written += rel
        }

        fun writeBytes(rel: String, bytes: ByteArray) {
            val f = File(root, rel)
            f.parentFile?.mkdirs()
            f.writeBytes(bytes)
            written += rel
        }

        write("AndroidManifest.xml", manifest(pkg, activities))
        write("res/values/strings.xml", strings(label, activities))
        write("res/values/colors.xml", colors(colorHex))
        write("res/drawable/ic_launcher_foreground.xml", FOREGROUND_VECTOR)
        // 自适应图标（API 26+）：背景纯色 + 前景矢量，启动器自己裁形状
        write("res/mipmap-anydpi-v26/ic_launcher.xml", ADAPTIVE_ICON)
        // 旧系统只能吃位图：五档 PNG 现画
        for ((density, px) in ICON_SIZES) {
            writeBytes("res/mipmap-$density/ic_launcher.png", PngIcon.launcher(px, color))
        }

        val srcDir = "src/" + pkg.replace('.', '/')
        for (i in 0 until activities) {
            val cls = PAGE_CLASSES[i]
            // 必须是「还有下一页」才生成跳转：只按数组取下一个元素的话，
            // 2 页工程会给第 2 页也生成 ThirdActivity 的跳转 → ecj 报 cannot be resolved（踩过）
            val next = if (i + 1 < activities) PAGE_CLASSES[i + 1] else null
            write("$srcDir/$cls.java", activitySource(pkg, cls, i + 1, activities, next))
        }
        write("README.md", readme(dir, pkg, activities))

        return Result(root, pkg, activities, written)
    }

    /** 目录名 → 合法包名片段（去掉非标识符字符，数字开头补前缀） */
    private fun sanitizePackage(dir: String): String {
        val s = dir.lowercase().replace(Regex("[^a-z0-9_]"), "")
        if (s.isBlank()) return "app"
        return if (s.first().isDigit()) "app$s" else s
    }

    private fun parseColor(hex: String): Int {
        val t = hex.trim().removePrefix("#")
        if (t.length != 6) return 0
        return t.toLongOrNull(16)?.let { (0xFF000000L or it).toInt() } ?: 0
    }

    private fun manifest(pkg: String, activities: Int): String = buildString {
        append("""<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="$pkg">

    <uses-sdk android:minSdkVersion="21" android:targetSdkVersion="28" />

    <application
        android:allowBackup="false"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:theme="@android:style/Theme.Material.Light.NoActionBar">

        <activity
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
""")
        for (i in 1 until activities) {
            append("""
        <activity
            android:name=".${PAGE_CLASSES[i]}"
            android:exported="false" />
""")
        }
        append("""    </application>
</manifest>
""")
    }

    private fun strings(label: String, activities: Int): String = buildString {
        append("""<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">${xmlEscape(label)}</string>
    <string name="hello_title">${xmlEscape(label)}</string>
    <string name="hello_hint">这个应用是在手机上编译、签名并安装的</string>
""")
        for (i in 2..activities) {
            append("""    <string name="page_${i}_title">第 $i 个页面</string>
""")
        }
        append("""    <string name="open_next">打开下一个页面</string>
    <string name="go_back">返回</string>
</resources>
""")
    }

    private fun colors(colorHex: String): String = """<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">$colorHex</color>
</resources>
"""

    /** 单页 / 多页共用一套模板：标题 + 说明 + （下一页 / 返回）按钮，界面全用代码搭，不引 layout */
    private fun activitySource(pkg: String, cls: String, index: Int, total: Int, next: String?): String {
        val titleRes = if (index == 1) "hello_title" else "page_${index}_title"
        val buttons = buildString {
            if (next != null) {
                append("""        Button next = new Button(this);
        next.setText(R.string.open_next);
        next.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startActivity(new Intent($cls.this, $next.class));
            }
        });
        box.addView(next);
""")
            }
            if (index > 1) {
                append("""        Button back = new Button(this);
        back.setText(R.string.go_back);
        back.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                finish();
            }
        });
        box.addView(back);
""")
            }
        }
        return """package $pkg;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** 第 $index/$total 页 · 由 app_new 生成；改这个文件就能改界面 */
public class $cls extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        float d = getResources().getDisplayMetrics().density;
        int pad = (int) (24 * d);

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setPadding(pad, pad, pad, pad);
        box.setBackgroundColor(0xFFFFFFFF);

        TextView title = new TextView(this);
        title.setText(R.string.$titleRes);
        title.setTextSize(24);
        title.setTextColor(0xFF111827);
        title.setGravity(Gravity.CENTER);
        box.addView(title);

        TextView hint = new TextView(this);
        hint.setText(R.string.hello_hint);
        hint.setTextSize(14);
        hint.setTextColor(0xFF6B7280);
        hint.setGravity(Gravity.CENTER);
        hint.setPadding(0, pad / 2, 0, pad);
        box.addView(hint);

$buttons
        setContentView(box);
    }
}
"""
    }

    private fun readme(dir: String, pkg: String, activities: Int): String = """# $dir

由 `app_new` 生成的 Android 工程，可直接在手机上编译安装。

| 动作 | 调用 |
|---|---|
| 打包 | `app_build(dir="$dir")` → `$dir.apk`（已签名） |
| 安装 | `app_install(file="$dir.apk")` |
| 启动 | bash: `am start -n $pkg/.MainActivity` |

## 结构

```
AndroidManifest.xml          包名 $pkg，启动页 .MainActivity（共 $activities 页）
src/$pkg/…                   Java 源码（界面全用代码搭，不依赖 layout XML）
res/values/strings.xml       文案（改这里就能改显示文字）
res/values/colors.xml        图标底色
res/mipmap-*/ic_launcher.png 启动图标（五档，由主色现画）
res/drawable/ic_launcher_foreground.xml  自适应图标前景（API 26+）
```

## 改界面的三个位置

1. `res/values/strings.xml` —— 文案
2. `src/…/MainActivity.java` —— 布局与交互（`onCreate` 里全是原生 View）
3. `AndroidManifest.xml` —— 加权限、加页面、改主题
"""

    private const val ADAPTIVE_ICON = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
"""

    /** 108dp 视口，图形落在 66dp 安全区内（自适应图标规范） */
    private const val FOREGROUND_VECTOR = """<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M42,30 L80,54 L42,78 Z" />
</vector>
"""

    private fun xmlEscape(s: String): String = s
        .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace("\"", "&quot;").replace("'", "&apos;")
}

/**
 * 现画启动图标用的 PNG 编码器（RFC 2083）。
 *
 * 只做一件事：把「像素函数」压成一张 RGBA PNG。用 JDK 自带的 Deflater/CRC32，
 * 不引第三方库，也不往 APK 里塞位图素材 —— 换主色就是换个参数。
 */
internal object PngIcon {

    fun launcher(size: Int, base: Int): ByteArray {
        val s = size.toDouble()
        val radius = s * 0.22
        // 白色三角：靠左的「播放」形状，落在自适应图标安全区里
        val ax = s * 0.38; val ay = s * 0.29
        val bx = s * 0.74; val by = s * 0.50
        val cx = s * 0.38; val cy = s * 0.71

        fun inTriangle(px: Double, py: Double): Boolean {
            val d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
            val d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
            val d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
            val hasNeg = d1 < 0 || d2 < 0 || d3 < 0
            val hasPos = d1 > 0 || d2 > 0 || d3 > 0
            return !(hasNeg && hasPos)
        }

        return PngIcon.encode(size, size) { x, y ->
            var a = 0.0
            var r = 0.0
            var g = 0.0
            var b = 0.0
            // 2×2 超采样：圆角与三角形边缘不至于锯齿
            for (sy in 0..1) {
                for (sx in 0..1) {
                    val px = x + 0.25 + sx * 0.5
                    val py = y + 0.25 + sy * 0.5
                    if (!insideRounded(px, py, s, radius)) continue
                    a += 1.0
                    if (inTriangle(px, py)) {
                        r += 255.0; g += 255.0; b += 255.0
                    } else {
                        // 左上亮 → 右下暗的对角渐变
                        val t = ((px + py) / (2.0 * s)).coerceIn(0.0, 1.0)
                        val k = 1.0 - 0.35 * t
                        r += ((base ushr 16) and 0xFF) * k
                        g += ((base ushr 8) and 0xFF) * k
                        b += (base and 0xFF) * k
                    }
                }
            }
            if (a <= 0.0) return@encode 0
            val alpha = (255.0 * a / 4.0).toInt().coerceIn(0, 255)
            val rr = (r / a).toInt().coerceIn(0, 255)
            val gg = (g / a).toInt().coerceIn(0, 255)
            val bb = (b / a).toInt().coerceIn(0, 255)
            (alpha shl 24) or (rr shl 16) or (gg shl 8) or bb
        }
    }

    private fun insideRounded(px: Double, py: Double, s: Double, radius: Double): Boolean {
        if (px < 0 || py < 0 || px > s || py > s) return false
        val nx = px.coerceIn(radius, s - radius)
        val ny = py.coerceIn(radius, s - radius)
        val dx = px - nx
        val dy = py - ny
        return dx * dx + dy * dy <= radius * radius
    }

    /** RGBA8 PNG；[pixel] 返回 ARGB */
    fun encode(width: Int, height: Int, pixel: (Int, Int) -> Int): ByteArray {
        val raw = ByteArray((width * 4 + 1) * height)
        var p = 0
        for (y in 0 until height) {
            raw[p++] = 0 // 每行滤波器：None（图标很小，压缩率差别可忽略）
            for (x in 0 until width) {
                val argb = pixel(x, y)
                raw[p++] = ((argb ushr 16) and 0xFF).toByte()
                raw[p++] = ((argb ushr 8) and 0xFF).toByte()
                raw[p++] = (argb and 0xFF).toByte()
                raw[p++] = ((argb ushr 24) and 0xFF).toByte()
            }
        }
        val out = ByteArrayOutputStream()
        out.write(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))
        val ihdr = ByteArrayOutputStream().apply {
            writeInt(width)
            writeInt(height)
            write(8)   // 位深
            write(6)   // 颜色类型：RGBA
            write(0)   // 压缩方法
            write(0)   // 过滤方法
            write(0)   // 隔行
        }.toByteArray()
        out.chunk("IHDR", ihdr)
        out.chunk("IDAT", deflate(raw))
        out.chunk("IEND", ByteArray(0))
        return out.toByteArray()
    }

    private fun ByteArrayOutputStream.writeInt(v: Int) {
        write((v ushr 24) and 0xFF)
        write((v ushr 16) and 0xFF)
        write((v ushr 8) and 0xFF)
        write(v and 0xFF)
    }

    private fun ByteArrayOutputStream.chunk(type: String, data: ByteArray) {
        val t = type.toByteArray(Charsets.US_ASCII)
        writeInt(data.size)
        write(t)
        write(data)
        writeInt(CRC32().apply { update(t); update(data) }.value.toInt())
    }

    private fun deflate(raw: ByteArray): ByteArray {
        val deflater = Deflater(Deflater.BEST_COMPRESSION)
        deflater.setInput(raw)
        deflater.finish()
        val out = ByteArrayOutputStream()
        val buf = ByteArray(1 shl 13)
        while (!deflater.finished()) {
            val n = deflater.deflate(buf)
            if (n <= 0) break
            out.write(buf, 0, n)
        }
        deflater.end()
        return out.toByteArray()
    }
}
