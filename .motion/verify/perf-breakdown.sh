#!/system/bin/sh
# 拆开量：JVM 启动 / android.jar(25.8MB) 解析 / 工具本身的工作，看 5s 到底花在哪
cd files || exit 1
WS=$PWD/workspace
BT=$WS/.dsh/buildtools
OUT=$WS/.dsh/perf2
rm -rf "$OUT"; mkdir -p "$OUT/c1" "$OUT/dex1" "$OUT/dex2"

n() { date +%s%3N; }
J() {
  PROOT_LOADER=$PWD/runtime/proot/loader PROOT_TMP_DIR=$PWD/runtime/tmp \
  LD_LIBRARY_PATH=$PWD/runtime/proot \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root TMPDIR=/tmp \
  $PWD/runtime/proot/proot -r $PWD/runtime/proot-root -0 -w /workspace \
    -b $WS:/workspace -b /dev -b /proc /usr/bin/java "$@"
}
JR() { i=0; while [ $i -lt 4 ]; do J "$@" >/dev/null 2>&1 && return 0; i=$((i+1)); done; return 1; }
# 只跑一遍、不做重试的计时（VM 启动失败会立刻返回，耗时接近 0，可就地重跑）
t() { s=$(n); JR "$@"; echo "$1_rc=$? " ; echo "  ms=$(( $(n) - s ))"; }

echo "== JVM 启动（-version）=="
for i in 1 2 3; do
  s=$(n); J -version >/dev/null 2>&1; echo "  java_version_ms=$(( $(n) - s ))"
done

echo "== 工具类装载，不做实际工作 =="
s=$(n); J -cp /workspace/.dsh/buildtools/d8.jar com.android.tools.r8.D8 --version >/dev/null 2>&1; echo "  d8_version_ms=$(( $(n) - s ))"
s=$(n); J -jar /workspace/.dsh/buildtools/apksigner.jar --version >/dev/null 2>&1; echo "  apksigner_version_ms=$(( $(n) - s ))"

echo "== 纯 Java 类：ecj 不带 android.jar =="
printf 'public class A { public static int x(){ return 1; } }\n' > "$OUT/A.java"
s=$(n); JR -jar /workspace/.dsh/buildtools/ecj.jar -nowarn -source 8 -target 8 -d /workspace/.dsh/perf2/c1 /workspace/.dsh/perf2/A.java; echo "  ecj_plain_ms=$(( $(n) - s ))"

echo "== 同一文件：ecj 带 25.8MB android.jar 当 bootclasspath（不引用任何 android 类）=="
s=$(n); JR -jar /workspace/.dsh/buildtools/ecj.jar -nowarn -source 8 -target 8 -bootclasspath /workspace/.dsh/buildtools/android.jar -d /workspace/.dsh/perf2/c1 /workspace/.dsh/perf2/A.java; echo "  ecj_androidcp_ms=$(( $(n) - s ))"

echo "== 第二次（同一命令，OS 页缓存已热）=="
s=$(n); JR -jar /workspace/.dsh/buildtools/ecj.jar -nowarn -source 8 -target 8 -bootclasspath /workspace/.dsh/buildtools/android.jar -d /workspace/.dsh/perf2/c1 /workspace/.dsh/perf2/A.java; echo "  ecj_androidcp_warm_ms=$(( $(n) - s ))"

echo "== d8：不带 --lib =="
s=$(n); JR -cp /workspace/.dsh/buildtools/d8.jar com.android.tools.r8.D8 --min-api 21 --output /workspace/.dsh/perf2/dex1 /workspace/.dsh/perf2/c1/A.class; echo "  d8_nolib_ms=$(( $(n) - s ))"

echo "== d8：带 --lib android.jar =="
s=$(n); JR -cp /workspace/.dsh/buildtools/d8.jar com.android.tools.r8.D8 --lib /workspace/.dsh/buildtools/android.jar --min-api 21 --output /workspace/.dsh/perf2/dex2 /workspace/.dsh/perf2/c1/A.class; echo "  d8_lib_ms=$(( $(n) - s ))"

echo "== d8：带 --lib，第二次 =="
s=$(n); JR -cp /workspace/.dsh/buildtools/d8.jar com.android.tools.r8.D8 --lib /workspace/.dsh/buildtools/android.jar --min-api 21 --output /workspace/.dsh/perf2/dex2 /workspace/.dsh/perf2/c1/A.class; echo "  d8_lib_warm_ms=$(( $(n) - s ))"
