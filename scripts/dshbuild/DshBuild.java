import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.io.PrintWriter;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 手机端打包驱动：ecj → d8 → 注入 dex → apksigner。
 *
 * 两种运行方式：
 *
 * **一次性**（`java -cp dshbuild.jar DshBuild --ecj ecj.jar a.args --d8 d8.jar b.args …`）
 *   调试与兼容用；每次调用一个 JVM。
 *
 * **守护进程**（`java -cp dshbuild.jar DshBuild --daemon`，**正式路径**）
 *   stdin 每行一条命令：`BUILD <plan 文件>`，执行完回 `[done] ok=… total=…`，直到 `QUIT`。
 *
 * 为什么要常驻：实测（emulator，hello 工程）一次构建 13.4s，其中
 *   aapt2 compile 0.14s / link 0.22s / proot 启动 0.06s，
 *   ecj 5.3s、d8 4.8s、apksigner 2.8s —— 而 `java -version` 只要 0.05~0.15s。
 *   也就是说这 12.9s 几乎全是**每个工具自己把类加载起来**的固定成本（ecj 编译一个
 *   纯 Java 类、不带 android.jar 也要 4.7s；d8 不带 --lib 也要 3.3s），
 *   再被 proot 的 ptrace 逐 syscall 拦截放大。
 *
 * 换 JVM 不解决问题（JVM 启动本身很便宜），**只有把类留在内存里**才解决问题。
 * 这与桌面对齐：桌面 `packages/subprocess` 的进程「keeps process lifetime across
 * consumer reloads」，`packages/terminal` 的会话「keep ... sessions alive across tool
 * calls」—— 手机端原先每一步都 fork 一个新 JVM，等于每次重新付一遍类加载账。
 *
 * 为什么每个 stage 用隔离 ClassLoader：d8(R8) 与 apksigner 各自内联了不同版本的
 * guava/kotlin，塞进同一条 classpath 会互相遮蔽，典型症状是 NoSuchMethodError。
 * 守护进程里按 jar 路径缓存 loader，既隔离又能跨请求复用。
 *
 * 输出约定（Kotlin 侧用正则解析，别随意改格式）：
 *   [stage] --ecj ms=1234 ok=true args=42
 *   [done] ok=true total=1234
 * 退出码：0 成功；1 某阶段失败；2 参数错误。
 */
public final class DshBuild {

    /** jar 路径 → 常驻 loader（守护进程里跨请求复用，这就是省下来的那 12 秒） */
    private static final Map<String, URLClassLoader> LOADERS = new HashMap<>();

    public static void main(String[] argv) throws Exception {
        if (argv.length == 1 && "--daemon".equals(argv[0])) {
            daemon();
            return;
        }
        if (argv.length == 0) {
            System.err.println("usage: DshBuild [--ecj|--d8|--sign] <jar> <argfile> | [--inject] <argfile> … | --daemon");
            System.exit(2);
            return;
        }
        long total = System.currentTimeMillis();
        for (String[] stage : parseStages(argv)) {
            if (!exec(stage, System.out)) System.exit(1);
        }
        System.out.println("[stage] total ms=" + (System.currentTimeMillis() - total));
        System.out.flush();
    }

    /** 守护进程：一行一条 BUILD 命令，直到 QUIT / EOF */
    private static void daemon() throws IOException {
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        PrintStream out = System.out;
        String line;
        while ((line = in.readLine()) != null) {
            line = line.trim();
            if (line.isEmpty()) continue;
            if ("QUIT".equals(line)) break;
            if (!line.startsWith("BUILD ")) {
                out.println("[done] ok=false total=0 error=bad-request");
                out.flush();
                continue;
            }
            File plan = new File(line.substring("BUILD ".length()).trim());
            long t0 = System.currentTimeMillis();
            boolean ok = false;
            String err = "";
            try {
                List<String> planLines = readLines(plan);
                List<String[]> stages = parseStages(planLines.toArray(new String[0]));
                ok = true;
                for (String[] stage : stages) {
                    if (!exec(stage, out)) { ok = false; break; }
                }
            } catch (Throwable t) {
                err = " " + t.getClass().getSimpleName() + ":" + String.valueOf(t.getMessage()).replace('\n', ' ');
            }
            out.println("[done] ok=" + ok + " total=" + (System.currentTimeMillis() - t0) + err);
            out.flush();
        }
        out.flush();
    }

    /**
     * 把命令行拆成「阶段」三元组：`--stage <jar> <argfile>`（`--inject` 只有 argfile）。
     */
    private static List<String[]> parseStages(String[] argv) {
        List<String[]> out = new ArrayList<>();
        int i = 0;
        while (i < argv.length) {
            String stage = argv[i];
            boolean needsJar = !"--inject".equals(stage);
            int need = needsJar ? 3 : 2;
            if (i + need > argv.length) {
                throw new IllegalArgumentException("参数不完整（" + stage + " 需要 " + need + " 个）");
            }
            String jar = needsJar ? argv[i + 1] : null;
            String argFile = argv[i + need - 1];
            out.add(new String[]{stage, jar, argFile});
            i += need;
        }
        return out;
    }

    /** 执行一个阶段；失败只打印原因并返回 false（不 System.exit，守护进程要活下去） */
    private static boolean exec(String[] stage, PrintStream out) {
        String name = stage[0];
        File argFile = new File(stage[2]);
        List<String> args;
        try {
            args = readLines(argFile);
        } catch (Exception e) {
            out.println("[stage] " + name + " ms=0 ok=false args=0");
            out.println("[dshbuild] 读不到参数文件 " + argFile + "：" + e.getMessage());
            out.flush();
            return false;
        }
        long t0 = System.currentTimeMillis();
        try {
            String ok = run(name, stage[1], args.toArray(new String[0]));
            out.println("[stage] " + name + " ms=" + (System.currentTimeMillis() - t0)
                    + " ok=" + ok + " args=" + args.size());
            out.flush();
            if (!"true".equals(ok)) {
                out.println("[dshbuild] " + name + " 返回失败（详见上面的编译输出）");
                out.flush();
                return false;
            }
            return true;
        } catch (Throwable t) {
            Throwable cause = t.getCause() != null && t instanceof java.lang.reflect.InvocationTargetException
                    ? t.getCause() : t;
            out.println("[stage] " + name + " ms=" + (System.currentTimeMillis() - t0)
                    + " ok=false args=" + args.size());
            out.println("[dshbuild] " + name + " 失败：" + cause);
            out.flush();
            return false;
        }
    }

    private static String run(String stage, String jarPath, String[] args) throws Exception {
        if ("--inject".equals(stage)) return inject(args);
        File jar = new File(jarPath);
        if (!jar.isFile()) throw new IllegalStateException("工具 jar 不存在：" + jar);
        URLClassLoader cl = loaderFor(jar);
        switch (stage) {
            case "--ecj": {
                Class<?> main = cl.loadClass("org.eclipse.jdt.internal.compiler.batch.Main");
                PrintWriter pw = new PrintWriter(System.out, true);
                java.lang.reflect.Constructor<?> ctor = main.getConstructor(
                        PrintWriter.class, PrintWriter.class, boolean.class,
                        java.util.Map.class,
                        Class.forName("org.eclipse.jdt.core.compiler.CompilationProgress", true, cl));
                Object compiler = ctor.newInstance(pw, pw, Boolean.FALSE, null, null);
                Object ok = main.getMethod("compile", String[].class).invoke(compiler, (Object) args);
                return String.valueOf(Boolean.TRUE.equals(ok));
            }
            case "--d8": {
                // argfile 首行是 class 输出目录，其余是 d8 选项：d8 要的是 *.class 清单，
                // 而清单只有 ecj 编译完才存在 —— 只能由驱动在两步之间自己扫。
                if (args.length == 0) throw new IllegalArgumentException("--d8 的 argfile 首行必须是 class 目录");
                List<String> d8Args = new ArrayList<>(Arrays.asList(args).subList(1, args.length));
                List<String> classes = new ArrayList<>();
                collectClasses(new File(args[0]), classes);
                if (classes.isEmpty()) throw new IllegalStateException("没有编译出任何 .class：" + args[0]);
                d8Args.addAll(classes);
                invokeMain(cl.loadClass("com.android.tools.r8.D8"), d8Args.toArray(new String[0]));
                return "true";
            }
            case "--sign": {
                // apksigner 内部会 System.exit：守护进程模式下它是最后一个阶段，退出即会话结束
                invokeMain(cl.loadClass("com.android.apksigner.ApkSignerTool"), args);
                return "true";
            }
            default:
                throw new IllegalArgumentException("未知阶段 " + stage);
        }
    }

    /** parent 只到平台层：每个 stage 只看得见自己的 jar，避免内联库互相遮蔽 */
    private static synchronized URLClassLoader loaderFor(File jar) throws Exception {
        String key = jar.getAbsolutePath();
        URLClassLoader cl = LOADERS.get(key);
        if (cl == null) {
            cl = new URLClassLoader(new URL[]{jar.toURI().toURL()},
                    ClassLoader.getSystemClassLoader().getParent());
            LOADERS.put(key, cl);
        }
        return cl;
    }

    private static void invokeMain(Class<?> c, String[] args) throws Exception {
        c.getMethod("main", String[].class).invoke(null, (Object) args);
    }

    /** 递归收集 *.class（d8 的输入清单），上限防御：极端工程不该把命令行撑爆 */
    private static void collectClasses(File dir, List<String> out) {
        File[] kids = dir.listFiles();
        if (kids == null) return;
        Arrays.sort(kids, (a, b) -> a.getName().compareTo(b.getName()));
        for (File f : kids) {
            if (f.isDirectory()) collectClasses(f, out);
            else if (f.getName().endsWith(".class") && out.size() < 4000) out.add(f.getAbsolutePath());
        }
    }

    /**
     * 把 aapt2 link 产出的 APK 与 d8 产出的 classes.dex 合成一份（其余条目原样搬）。
     * args: base.apk classes.dex out.apk
     *
     * 放在驱动里做（而不是宿主侧），是为了让「编译 → dex → 合成 → 签名」整条链
     * 都发生在同一个常驻进程内，中间不回宿主。
     */
    private static String inject(String[] a) throws Exception {
        if (a.length < 3) throw new IllegalArgumentException("--inject 需要 base / dex / out 三个路径");
        File base = new File(a[0]);
        File dex = new File(a[1]);
        File out = new File(a[2]);
        if (!dex.isFile()) throw new IllegalStateException("没有生成 classes.dex：" + dex);
        byte[] buf = new byte[64 * 1024];
        java.util.zip.ZipFile zin = new java.util.zip.ZipFile(base);
        try {
            java.util.zip.ZipOutputStream zout =
                    new java.util.zip.ZipOutputStream(new java.io.FileOutputStream(out));
            try {
                java.util.Enumeration<? extends java.util.zip.ZipEntry> en = zin.entries();
                while (en.hasMoreElements()) {
                    java.util.zip.ZipEntry e = en.nextElement();
                    if ("classes.dex".equals(e.getName())) continue;   // 已有一份就替换
                    java.util.zip.ZipEntry ne = new java.util.zip.ZipEntry(e.getName());
                    ne.setTime(e.getTime());
                    zout.putNextEntry(ne);
                    java.io.InputStream in = zin.getInputStream(e);
                    int n;
                    while ((n = in.read(buf)) > 0) zout.write(buf, 0, n);
                    in.close();
                    zout.closeEntry();
                }
                java.util.zip.ZipEntry de = new java.util.zip.ZipEntry("classes.dex");
                de.setTime(System.currentTimeMillis());
                zout.putNextEntry(de);
                java.io.InputStream din = new java.io.FileInputStream(dex);
                int n;
                while ((n = din.read(buf)) > 0) zout.write(buf, 0, n);
                din.close();
                zout.closeEntry();
            } finally {
                zout.close();
            }
        } finally {
            zin.close();
        }
        return "true";
    }

    private static List<String> readLines(File f) throws IOException {
        List<String> out = new ArrayList<>();
        for (String line : Files.readAllLines(f.toPath(), StandardCharsets.UTF_8)) {
            String s = line.trim();
            if (s.isEmpty() || s.startsWith("#")) continue;
            out.add(s);
        }
        return out;
    }
}
