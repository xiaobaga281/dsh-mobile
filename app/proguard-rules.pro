# ---------------------------------------------------------------------------
# R8 / keep 规则（release 开启 isMinifyEnabled=true + isShrinkResources=true）
# 每条都对应一个「运行期按名字查找」的入口；删之前先确认没有反射/JS/JNI 调用。
# ---------------------------------------------------------------------------

# JS bridge：WebView 通过 @JavascriptInterface 按方法名调用，不能被重命名。
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepclassmembers class ai.deepseek.harness.mobile.bridge.NativeBridge {
    public *;
}
-keepattributes JavascriptInterface

# WebView 注入的 JS 侧通过 addJavascriptInterface 暴露的对象
-keep class ai.deepseek.harness.mobile.bridge.** { *; }

# sherpa-onnx：JNI 侧按类名/方法名回调 Kotlin 包装类，不能混淆。
-keep class com.k2fsa.sherpa.onnx.** { *; }
-dontwarn com.k2fsa.sherpa.onnx.**

# 荣耀通透 SDK 通过反射加载（可选 aar；未放置时也必须有规则，避免构建告警）
-dontwarn com.hihonor.**
-keep class com.hihonor.uikit.transparency.** { *; }

# CameraX / ZXing 在部分设备上走反射；只保留告警抑制，不整体 keep（省体积）
-dontwarn androidx.camera.**
-dontwarn com.google.zxing.**

# 泛型/注解/内部类信息：JSON、协程、反射构造会用到
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod

# 保留行号，崩溃栈才可读（体积代价很小）
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# org.json 在 JVM 单测里由真实实现替换；Android 上由系统提供，不需要保留实现
-dontwarn org.json.**

# ---------------------------------------------------------------------------
# 禁止工具/插件层级被 R8 水平类合并（rc.110）。
# 实锤案例：ImagePlugin$tools$1 等 20+ 个匿名 ToolSpec 被合并成合成类 o.M，
# ToolSpec$DefaultImpls 的静态体被搬进另一个合并类且类型层级没对齐 —— 运行期
# AbstractMethodError（abstract method "n.p.a(JSONObject, n.l)" on receiver Class<o.M>）。
# -Xjvm-default=all 已消灭 DefaultImpls；这里再加一道：合并会破坏「接口实现关系」
# 的类一律保持独立（allowobfuscation = 仍可改名省符号，只是不并类）。
# ---------------------------------------------------------------------------
-keep,allowobfuscation interface ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
-keep,allowobfuscation class * implements ai.deepseek.harness.mobile.kernel.plugin.ToolSpec { *; }
-keep,allowobfuscation interface ai.deepseek.harness.mobile.kernel.plugin.Plugin
-keep,allowobfuscation class * implements ai.deepseek.harness.mobile.kernel.plugin.Plugin { *; }

