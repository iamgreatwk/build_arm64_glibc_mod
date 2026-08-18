---
name: cross-build-aarch64
description: Cross-compile C/autotools/Makefile packages (wpa_supplicant, hostapd, iw, dropbear, etc.) for aarch64 (ARM64) Linux/glibc to run on embedded devices (postmarketOS / buildroot). Handles the D-Bus→libsystemd dependency trap, packaging without a top-level directory prefix, TFTP deployment, and unique artifact naming to dodge stale-cache collisions. Use when the user wants to build or repack a Linux binary for ARM64, fix "error while loading shared libraries" on an embedded device, or set up a GitHub Actions cross-build workflow.
---

# Cross-build aarch64 (ARM64) Linux packages

Use when building a C/Makefile/autotools/cmake package for an ARM64 embedded target
(postmarketOS, buildroot, glibc). Most common case: wpa_supplicant, but the pattern
applies to hostapd, iw, dropbear, tcpdump, etc.

## When to trigger
- "交叉编译 wpa_supplicant/hostapd 给 ARM64" / "GitHub Actions 编译 ARM64 包"
- Device reports `error while loading shared libraries: libsystemd.so.0` (or any
  missing `.so`) after deploying a cross-built binary.
- Repackaging / re-archiving a tarball so `tar -C /` overlays the right paths.

## Core recipe (GitHub Actions, ubuntu-22.04 runner — no fork of upstream needed)
1. `dpkg --add-architecture arm64`, install `gcc-aarch64-linux-gnu` + the arm64
   `-dev` packages the package needs (e.g. `libssl-dev:arm64`,
   `libnl-route-3-dev:arm64`, `libnl-genl-3-dev:arm64`).
   - arm64 packages live in `ubuntu-ports`, NOT `ubuntu`, on GitHub-hosted runners.
     Use `mirrors.aliyun.com/ubuntu-ports` if the default archive is unreachable.
   - **apt 源完整配置（2026-08-18 三次踩坑实锤）**：只 `dpkg --add-architecture arm64`
     后 apt update，默认源(azure.archive/security.ubuntu.com)被要求提供 arm64 索引 → 404；
     若把 ports 源加进来但不动默认源，默认源仍 404；若粗暴 sed 全部加 [arch=amd64]，
     microsoft-prod.list 等**已有 [arch=]** 的第三方源被搞坏 → Malformed entry。
     **正确写法**（只改 sources.list、跳过已有 [arch=] 行）：
     ```
     sudo dpkg --add-architecture arm64
     sudo sed -i '/\[arch=/!s/^deb /deb [arch=amd64] /' /etc/apt/sources.list 2>/dev/null || true
     echo "deb [arch=arm64] http://ports.ubuntu.com/ubuntu-ports jammy main universe multiverse restricted" | sudo tee /etc/apt/sources.list.d/arm64-ports.list
     sudo apt-get update
     ```
   - Prefer `ubuntu-22.04` (glibc 2.35) over 24.04 for broader device compatibility.
   - Source is fetched at build time (`wget` from upstream), so the repo can be empty.
2. Cross env: `CC=aarch64-linux-gnu-gcc`,
   `PKG_CONFIG_PATH=/usr/lib/aarch64-linux-gnu/pkgconfig`,
   `PKG_CONFIG_SYSROOT_DIR=/`.
3. Configure + build with the package's Makefile/autotools/cmake, passing the cross CC.
4. `aarch64-linux-gnu-strip` the binaries.
5. Package: copy binaries to `pkgroot/usr/sbin` (or `/usr/bin`) and ONLY the needed
   `.so` files to `pkgroot/usr/lib`, then
   `tar czpf out.tar.gz -C pkgroot usr` — **no top-level directory prefix**.
6. Name the artifact uniquely, e.g.
   `<pkg>-<ver>-aarch64-glibc[-<variant>]-<run#>.tar.gz`, so a stale TFTP/HTTP cache
   can never serve an old copy.
7. Add a verification step: `readelf -d <bin>` must NOT list forbidden libs
   (libdbus / libsystemd / libpcsclite) before uploading.

## URL 模式 workflow（2026-08-18 新增，实测通过 ✅）
仓库已有 4 个 workflow：
- **`cross-build-from-url.yml`（推荐，通用）**：Actions → Run workflow → 填
  `source_url`（源码下载地址）+ `build_command`（交叉编译命令，$PKGROOT 指向打包根）+
  `artifact_prefix` → 自动下载/解压/编译/打包/上传 artifact。**实测**：busybox-1.36.1
  编译成功，产物 64-bit AARCH64（usr/ 结构无前缀）；hello.c 端到端 ~60 秒。
- `build-wpa_supplicant-aarch64-glibc.yml`：wpa 专用（URL 写死 w1.fi + EAP 配置）
- `build-from-uploaded-source.yml`：本机已下载源码（上传仓库 src/ 再编）
- `cross-build-aarch64-template.yml`：通用模板（复制改名）

## ghbuild 一键命令（2026-08-18 实测通过 ✅，PC/手机通用）
**`ghbuild.js`（node>=18 零依赖，全程 api.github.com）**，仓库根 + 设备 `/usr/bin/ghbuild`：
```
ghbuild url <源码URL> "<build_command>" [prefix]   一键：触发→轮询→下载→解zip→验证ELF
ghbuild poll                                       最近 5 次状态
ghbuild dl [run_id]                                下载产物（默认最新）
```
- Token：环境变量 `GH_TOKEN`/`GITHUB_TOKEN`，或 `~/.gh_token` 文件（`echo 'ghp_xxx' > ~/.gh_token && chmod 600`）
- 实测示例（busybox）：
  ```
  ghbuild url https://busybox.net/downloads/busybox-1.36.1.tar.bz2 \
    "make ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu- defconfig && make ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu- -j2 && mkdir -p \$PKGROOT/usr/bin && cp busybox \$PKGROOT/usr/bin/" busybox
  ```
- 产物命名自动带 run#（`<prefix>-<run#>.tar.gz`），不会撞缓存；解压到设备 `tar -xzf ... -C /`
- **坑 1**：源码 URL 要现验（dropbear 旧版本 2022.83 官网已 404，busybox.net 稳定）
- **坑 2**：GitHub workflow_dispatch POST 返回 **204 空 body**——API 封装若 `r.json()` 会
  `Unexpected end of JSON input`，要先 `r.text()` 再判空（ghbuild.js 已处理）


## The D-Bus → libsystemd trap (most common failure)
wpa_supplicant's defconfig enables `CONFIG_CTRL_IFACE_DBUS_NEW`. That pulls in
libdbus, and on a systemd-based build host libdbus itself NEEDED `libsystemd.so.0`.
Embedded glibc images usually lack libsystemd → runtime crash.
**Fix:** disable all D-Bus control interfaces + PCSC before building:
```
sed -i 's/^CONFIG_CTRL_IFACE_DBUS=y/#CONFIG_CTRL_IFACE_DBUS=y/' .config
sed -i 's/^CONFIG_CTRL_IFACE_DBUS_NEW=y/#CONFIG_CTRL_IFACE_DBUS_NEW=y/' .config
sed -i 's/^CONFIG_CTRL_IFACE_DBUS_INTRO=y/#CONFIG_CTRL_IFACE_DBUS_INTRO=y/' .config
sed -i 's/^CONFIG_PCSC=y/#CONFIG_PCSC=y/' .config
sed -i 's/^#CONFIG_LIBNL32=y/CONFIG_LIBNL32=y/' .config
```
Keep `CONFIG_TLS=openssl` + EAP (PEAP/TTLS/TLS/SIM/AKA) enabled.

## Deployment on device (TFTP example)
```bash
busybox tftp -g -l /tmp/<artifact>.tar.gz -r <artifact>.tar.gz <SERVER_IP>
tar tzf /tmp/<artifact>.tar.gz | head -1     # must be "usr/", not a top dir
cd /tmp && tar -xzf <artifact>.tar.gz -C /
/usr/sbin/wpa_supplicant -v                  # no more libsystemd error
```
Always re-upload under a NEW name; never reuse a name already on the TFTP server.

## Gotchas log
| Symptom | Root cause | Fix |
|---|---|---|
| `libsystemd.so.0 not found` | D-Bus enabled → libdbus → libsystemd | disable D-Bus/PCSC, rebuild |
| `tar` extracts a `wpa-eap-.../` folder at root | source tarball had a top-level dir | package with `tar -C pkgroot usr` |
| device still shows old behaviour after `tftp` | stale same-name file on server | force unique artifact name each build |
| wpa_supplicant connects to wrong SSID | `update_config=1` wrote other networks into conf | set `update_config=0`, keep only target network |

## References
- `references/workflows.md` — ready-to-use GitHub Actions workflow for wpa_supplicant
  + a generic template for any aarch64 package.
- `scripts/build-wpa_supplicant.sh` — equivalent local build (amd64 Ubuntu).
- `scripts/cross-build-template.sh` — local template for other packages.
