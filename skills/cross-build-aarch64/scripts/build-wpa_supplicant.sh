#!/usr/bin/env bash
# 本地交叉编译 wpa_supplicant（amd64 Ubuntu 22.04+，需 sudo）
# 与 GitHub Actions 逻辑一致：禁用 D-Bus/PCSC，产物为无顶层目录、唯一命名的 tar.gz
# 用法：sudo bash build-wpa_supplicant.sh [版本]  例：sudo bash build-wpa_supplicant.sh 2.10
set -euo pipefail

VER="${1:-2.10}"
RUN="$(date +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"
cd "$WORK"

echo "==> 安装依赖（交叉工具链 + arm64 开发库）"
sudo dpkg --add-architecture arm64
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  gcc-aarch64-linux-gnu g++-aarch64-linux-gnu \
  libnl-route-3-dev:arm64 libnl-genl-3-dev:arm64 \
  libssl-dev:arm64 pkg-config make bc ca-certificates

echo "==> 下载 wpa_supplicant $VER"
wget -q "https://w1.fi/releases/wpa_supplicant-${VER}.tar.gz" -O wpa.tar.gz
tar xzf wpa.tar.gz
cd "wpa_supplicant-${VER}/wpa_supplicant"

echo "==> 生成 .config（禁用 D-Bus/PCSC，启用 libnl32+OpenSSL+EAP）"
cp defconfig .config
sed -i 's/^#CONFIG_LIBNL32=y/CONFIG_LIBNL32=y/' .config
sed -i 's/^CONFIG_CTRL_IFACE_DBUS=y/#CONFIG_CTRL_IFACE_DBUS=y/' .config
sed -i 's/^CONFIG_CTRL_IFACE_DBUS_NEW=y/#CONFIG_CTRL_IFACE_DBUS_NEW=y/' .config
sed -i 's/^CONFIG_CTRL_IFACE_DBUS_INTRO=y/#CONFIG_CTRL_IFACE_DBUS_INTRO=y/' .config
sed -i 's/^CONFIG_PCSC=y/#CONFIG_PCSC=y/' .config

echo "==> 编译"
export PKG_CONFIG_PATH=/usr/lib/aarch64-linux-gnu/pkgconfig
export PKG_CONFIG_SYSROOT_DIR=/
make CC=aarch64-linux-gnu-gcc -j"$(nproc)"
aarch64-linux-gnu-strip wpa_supplicant wpa_cli wpa_passphrase

echo "==> 安全检查"
if readelf -d wpa_supplicant | grep -qiE "libdbus|libsystemd|libpcsclite"; then
  echo "❌ 检测到禁止的库依赖，中止"; exit 1
fi

echo "==> 打包（唯一命名）"
PKGROOT="$WORK/pkgroot"
rm -rf "$PKGROOT" && mkdir -p "$PKGROOT/usr/sbin" "$PKGROOT/usr/lib"
cp -a wpa_supplicant wpa_cli "$PKGROOT/usr/sbin/"
for lib in libnl-3.so.200 libnl-genl-3.so.200 libnl-route-3.so.200 libssl.so.3 libcrypto.so.3; do
  cp -aL "/usr/lib/aarch64-linux-gnu/$lib" "$PKGROOT/usr/lib/"
done
OUT="$HOME/wpa_supplicant-${VER}-aarch64-glibc-nosystemd-${RUN}.tar.gz"
tar czpf "$OUT" -C "$PKGROOT" usr
echo "✅ 产物: $OUT"
tar tzf "$OUT"
