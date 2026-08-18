#!/usr/bin/env bash
# 通用 aarch64 本地交叉编译模板（amd64 Ubuntu 22.04+，需 sudo）
# 用法：sudo bash cross-build-template.sh <PKG> <VERSION> <SOURCE_URL> [configure-args...]
# 例：sudo bash cross-build-template.sh hostapd 2.10 https://w1.fi/releases/hostapd-2.10.tar.gz
set -euo pipefail

PKG="${1:?用法: $0 <PKG> <VERSION> <SOURCE_URL> [configure-args...]}"
VER="${2:?缺少版本}"
URL="${3:?缺少源码 URL}"
shift 3
EXTRA_CFG=("$@")
RUN="$(date +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"
cd "$WORK"

echo "==> 安装交叉工具链 + arm64 开发库（按包需要增删）"
sudo dpkg --add-architecture arm64
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  gcc-aarch64-linux-gnu g++-aarch64-linux-gnu \
  pkg-config make bc ca-certificates libssl-dev:arm64

echo "==> 下载并解压 $PKG $VER"
wget -q "$URL" -O src.tar.gz
tar xzf src.tar.gz --one-top-level=src
cd src/*

echo "==> 配置 + 编译"
export CC=aarch64-linux-gnu-gcc
export PKG_CONFIG_PATH=/usr/lib/aarch64-linux-gnu/pkgconfig
export PKG_CONFIG_SYSROOT_DIR=/
if [ -x ./configure ]; then
  ./configure --host=aarch64-linux-gnu --prefix=/usr "${EXTRA_CFG[@]}"
elif [ -f CMakeLists.txt ]; then
  cmake -DCMAKE_C_COMPILER=aarch64-linux-gnu-gcc -DCMAKE_INSTALL_PREFIX=/usr "${EXTRA_CFG[@]}" .
fi
make -j"$(nproc)"

echo "==> 安全检查（禁止 systemd/dbus/pcsc 泄漏）"
readarray -t BINS < <(find . -maxdepth 2 -type f -executable -name "$PKG" 2>/dev/null)
for b in "${BINS[@]:-$(find . -maxdepth 2 -type f -executable ! -name '*.sh' | head -1)}"; do
  [ -n "$b" ] || continue
  echo "== $b =="
  readelf -d "$b" | grep -i needed
  if readelf -d "$b" | grep -qiE "libdbus|libsystemd|libpcsclite"; then
    echo "❌ 泄漏宿主依赖，中止"; exit 1
  fi
done

echo "==> 打包（无顶层目录，唯一命名）"
PKGROOT="$WORK/pkgroot"
rm -rf "$PKGROOT" && mkdir -p "$PKGROOT/usr/bin" "$PKGROOT/usr/lib"
# 以下按包把产出二进制拷到 $PKGROOT/usr/bin，按需自行调整
cp -a "$(find . -maxdepth 2 -type f -executable -name "$PKG" | head -1)" "$PKGROOT/usr/bin/" 2>/dev/null || true
OUT="$HOME/${PKG}-${VER}-aarch64-glibc-${RUN}.tar.gz"
tar czpf "$OUT" -C "$PKGROOT" usr
echo "✅ 产物: $OUT"
tar tzf "$OUT"
