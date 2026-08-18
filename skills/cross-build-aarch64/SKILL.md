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
