#!/system/bin/sh
# 一次构建的分段耗时（对照 AppBuildPlugin 的流水线，逐阶段手动跑）
# 计时用 date +%s%3N（毫秒）；%N 在 toybox 上不保证有，%3N 稳定
cd files || exit 1
WS=$PWD/workspace
BT=$WS/.dsh/buildtools
OUT=$WS/.dsh/perf
rm -rf "$OUT"; mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex"

n() { date +%s%3N; }
J() {
  PROOT_LOADER=$PWD/runtime/proot/loader PROOT_TMP_DIR=$PWD/runtime/tmp \
  LD_LIBRARY_PATH=$PWD/runtime/proot \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root TMPDIR=/tmp \
  $PWD/runtime/proot/proot -r $PWD/runtime/proot-root -0 -w /workspace \
    -b $WS:/workspace -b /dev -b /proc /usr/bin/java "$@"
}
# proot 下 ~40% 概率 VM 初始化失败（mprotect PROT_EXEC），与 AppBuildPlugin 同款重试
JR() {
  i=0
  while [ $i -lt 4 ]; do
    out=$(J "$@" 2>&1); rc=$?
    if [ $rc -eq 0 ]; then return 0; fi
    echo "$out" | grep -q "memory page as executable" || { echo "$out" >&2; return $rc; }
    i=$((i+1))
  done
  return 1
}

# 0) proot 本身的开销（guest /bin/true）
s=$(n); PROOT_LOADER=$PWD/runtime/proot/loader PROOT_TMP_DIR=$PWD/runtime/tmp \
  LD_LIBRARY_PATH=$PWD/runtime/proot $PWD/runtime/proot/proot -r $PWD/runtime/proot-root \
  -0 -w /workspace -b $WS:/workspace -b /dev -b /proc /bin/true; echo "proot_boot_ms=$(( $(n) - s ))"

# 1) aapt2 compile
s=$(n)
LD_LIBRARY_PATH=$PWD/buildtools/aapt2/lib TMPDIR=$OUT \
  $PWD/buildtools/aapt2/bin/aapt2 compile --dir "$WS/hello/res" -o "$OUT/compiled.zip"
echo "aapt2_compile_ms=$(( $(n) - s ))"

# 2) aapt2 link
s=$(n)
LD_LIBRARY_PATH=$PWD/buildtools/aapt2/lib TMPDIR=$OUT \
  $PWD/buildtools/aapt2/bin/aapt2 link -o "$OUT/base.apk" -I "$BT/android.jar" \
  --manifest "$WS/hello/AndroidManifest.xml" --java "$OUT/gen" \
  --min-sdk-version 21 --target-sdk-version 28 --auto-add-overlay \
  -R "$OUT/compiled.zip"
echo "aapt2_link_ms=$(( $(n) - s ))"

# 3) ecj（一次 JVM）
find "$WS/hello/src" "$OUT/gen" -name '*.java' | sed "s#$WS#/workspace#g" > "$OUT/sources.txt"
s=$(n)
JR -jar /workspace/.dsh/buildtools/ecj.jar -nowarn -source 8 -target 8 \
  -bootclasspath /workspace/.dsh/buildtools/android.jar -d /workspace/.dsh/perf/classes \
  "@/workspace/.dsh/perf/sources.txt" || echo "ecj_failed"
echo "ecj_ms=$(( $(n) - s ))"

# 4) d8（一次 JVM，class 清单在 shell 里展开）
set --
for f in $(find "$OUT/classes" -name '*.class' | sed "s#$WS#/workspace#g"); do set -- "$@" "$f"; done
s=$(n)
JR -cp /workspace/.dsh/buildtools/d8.jar com.android.tools.r8.D8 \
  --lib /workspace/.dsh/buildtools/android.jar --min-api 21 --output /workspace/.dsh/perf/dex "$@" || echo "d8_failed"
echo "d8_ms=$(( $(n) - s ))"

# 5) apksigner（签 base.apk：这一步只量签名本身，dex 注入由宿主侧 zip 完成）
s=$(n)
JR -jar /workspace/.dsh/buildtools/apksigner.jar sign \
  --ks /workspace/.dsh/buildtools/debug.keystore --ks-pass pass:android --key-pass pass:android \
  --min-sdk-version 21 --out /workspace/.dsh/perf/signed.apk /workspace/.dsh/perf/base.apk || echo "sign_failed"
echo "sign_ms=$(( $(n) - s ))"

ls -l "$OUT/signed.apk" "$OUT/dex/classes.dex" 2>/dev/null | sed 's/^/  /'
