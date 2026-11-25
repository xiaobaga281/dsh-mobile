#!/system/bin/sh
# 清理 rootfs 构建残留并打包为 tar.gz（R1 管线）
M=/data/data/ai.deepseek.harness.mobile/files/m0
R=$M/rootfs
rm -rf $R/tmp/pkgs2 $R/tmp/hi $R/tmp/hi.c $R/tmp/hello $R/tmp/hello.c $R/tmp/list.txt \
       $R/apk.log $R/var/cache/apk/* $R/usr/share/man $R/usr/share/doc \
       $M/rootfs-x86_64.tar.gz 2>/dev/null
du -sh $R
cd $R && tar -czf $M/rootfs-x86_64.tar.gz . 2>/dev/null
echo "tar-code=$? size=$(stat -c %s $M/rootfs-x86_64.tar.gz)"
