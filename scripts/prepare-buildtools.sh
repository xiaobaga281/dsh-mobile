#!/usr/bin/env bash
# 准备手机端打包工具链（不随仓库提交，进 APK 前跑一次）
#
#   aapt2        Termux bionic 构建（x86_64 + aarch64），scripts/fetch-aapt2.py 解析依赖
#   d8/apksigner Android build-tools 里现成的 jar（纯 Java，跑设备上的 JRE 21）
#   android.jar  编译期骨架 + aapt2 链接用的框架资源
#   ecj          单 jar 的 Java 编译器（替代 javac：JRE 不带 javac，JDK 要多吃 11MB）
set -euo pipefail
cd "$(dirname "$0")/.."
BT="${BT:-/d/1/tools/android-sdk/build-tools/35.0.0}"
PLAT="${PLAT:-/d/1/tools/android-sdk/platforms/android-35/android.jar}"
OUT=app/src/complete/assets/buildtools
mkdir -p "$OUT"

cp "$PLAT" "$OUT/android.jar"
cp "$BT/lib/d8.jar" "$BT/lib/apksigner.jar" "$OUT/"
cp ~/.android/debug.keystore "$OUT/debug.keystore" 2>/dev/null || true
curl -sL --fail -o "$OUT/ecj.jar" \
  "https://maven.aliyun.com/repository/public/org/eclipse/jdt/ecj/3.33.0/ecj-3.33.0.jar"

python scripts/fetch-aapt2.py x86_64
python scripts/fetch-aapt2.py aarch64# aapt2 载荷放 jniLibs（按 ABI 拆分），不放 assets：
# 放 assets 时两个 ABI 的包都得各带一份 3.9+3.8MB，而设备只用得上自己那份。
# 文件名必须是 lib*.so 才会被当作 native 库按 ABI 装进 nativeLibraryDir；
# 运行时再读出来解包，不需要它是真的 ELF。
cp .motion/runtimes/aapt2-termux-x86_64.tar.gz app/src/complete/jniLibs/x86_64/libdshaapt2.so
cp .motion/runtimes/aapt2-termux-aarch64.tar.gz app/src/complete/jniLibs/arm64-v8a/libdshaapt2.so

# 打包驱动：一次 JVM 跑完 ecj → d8 → 注入 dex → 签名（原来每步起一个 JVM，
# proot 下光启动就占掉大头）。源码 scripts/dshbuild/DshBuild.java，产物约 4KB。
# -encoding UTF-8 必须写死：Windows 的 javac 默认 GBK，源码里的中文注释会直接编错。
DSHB="$(mktemp -d)"
javac -encoding UTF-8 --release 8 -Xlint:-options -d "$DSHB/classes" scripts/dshbuild/DshBuild.java
printf 'Main-Class: DshBuild\n' > "$DSHB/manifest.txt"
jar --create --file "$OUT/dshbuild.jar" --manifest "$DSHB/manifest.txt" -C "$DSHB/classes" .
rm -rf "$DSHB"

du -sh "$OUT"; ls -la "$OUT"
