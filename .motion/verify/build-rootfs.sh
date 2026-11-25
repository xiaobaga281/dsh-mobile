#!/system/bin/sh
# M2 预制 rootfs 验证 + 打包（在设备 shell 域执行）
M=/data/data/ai.deepseek.harness.mobile/files/m0
export PROOT_LOADER=$M/libexec/proot/loader PROOT_LOADER32=$M/libexec/proot/loader32
export LD_LIBRARY_PATH=$M/lib PATH=$M/bin:/system/bin

GUEST='python3 -c "print(6*7)"; node -e "console.log(40+2)"; printf "int main(){return 42;}" > /tmp/hi.c; gcc /tmp/hi.c -o /tmp/hi && /tmp/hi; echo gcc-rc=$?; grep -c "^P:" /etc/apk/db/installed'

$M/bin/proot -r $M/rootfs -0 -b /dev -b /proc -b /sys -w /root \
  /usr/bin/env PATH=/usr/bin:/bin:/sbin TMPDIR=/tmp HOME=/root \
  /bin/sh -c "$GUEST"
echo "guest-code=$?"

# 清掉临时包与构建残留，减小包体
rm -rf $M/rootfs/tmp/pkgs2 $M/rootfs/tmp/hello $M/rootfs/tmp/hello.c $M/rootfs/root/.ash_history 2>/dev/null

# 打包 rootfs（GNU tar 语义由 busybox tar 提供；-czf 单线程，够用）
cd $M/rootfs && $M/rootfs/bin/busybox tar -czf $M/rootfs-x86_64.tar.gz . 2>/dev/null || tar -czf $M/rootfs-x86_64.tar.gz . 2>/dev/null
echo "tar-code=$? size=$(stat -c %s $M/rootfs-x86_64.tar.gz 2>/dev/null)"
