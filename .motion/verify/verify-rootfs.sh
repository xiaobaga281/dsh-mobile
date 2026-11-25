#!/system/bin/sh
# 验证 rootfs 三件套（python3/node/gcc）
M=/data/data/ai.deepseek.harness.mobile/files/m0
export PROOT_LOADER=$M/libexec/proot/loader PROOT_LOADER32=$M/libexec/proot/loader32
export LD_LIBRARY_PATH=$M/lib PATH=$M/bin:/system/bin
$M/bin/proot -r $M/rootfs -0 -b /dev -b /proc -b /sys -w /root \
  /usr/bin/env PATH=/usr/bin:/bin:/sbin TMPDIR=/tmp HOME=/root \
  /bin/sh -c 'python3 -c "print(\"py\", 6*7)"; node -e "console.log(\"node\", 40+2)"; printf "int main(){return 42;}" > /tmp/hi.c; gcc /tmp/hi.c -o /tmp/hi && /tmp/hi; echo gcc-rc=$?'
echo "guest-code=$?"
