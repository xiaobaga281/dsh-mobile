# 注入的运行时二进制（伪装 .so）
# 小件（busybox/proot，<2MB）直接入库；libdshrootfs.so（~160MB/ABI）不入库。
# 重建：scripts/fetch-runtimes.mjs → scripts/resolve-apks.mjs → .motion/verify/build-rootfs.sh + pack-rootfs.sh（需设备端离线安装）
#
# 增量补丁（gzip tar 伪装 .so，宿主 busybox `tar -xzf` 解进 rootfs，幂等）：
#   app/src/complete/jniLibs/<abi>/libdshgit.so  —— git 2.47.3（Alpine 3.21，一次性手工产物，无生成脚本）
#   app/src/complete/jniLibs/<abi>/libdshnpm.so  —— npm 10.9.1 / npx / node-gyp（纯 JS，双 ABI 内容相同）
#     重建：python scripts/build-npm-patch.py             （自动取 Alpine v3.20 community 的 npm .apk）
#           python scripts/build-npm-patch.py --check     （只校验现有产物）
#   app/src/complete/jniLibs/<abi>/libdshnode.so —— node 22.23.4 LTS（musl 半静态，按 ABI 各一份，xz tar）
#     重建：python scripts/build-node-patch.py            （取 unofficial-builds 的 *-musl 构建，只留 bin/node）
#           python scripts/build-node-patch.py --check    （只校验现有产物）
#   三者都不入库；由 KernelRuntime 的 ensureGitPatch / ensureNpmPatch / ensureNodePatch
#   在 prepareProotRootfs 三个分支里幂等补齐。node 补丁解包后原子替换 /usr/bin/node，
#   失败时旧 node 20 原封不动。
