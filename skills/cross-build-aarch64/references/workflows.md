# 交叉编译 aarch64 工作流（可直接用）

## 1) wpa_supplicant 专用（已验证：去 D-Bus/systemd，EAP 保留）

文件命名：`build-wpa_supplicant-aarch64-glibc.yml`

```yaml
name: Build wpa_supplicant (aarch64/ARM64, glibc, no D-Bus/systemd)

on:
  workflow_dispatch:
    inputs:
      wpa_version:
        description: 'wpa_supplicant 版本'
        required: false
        default: '2.10'
  push:
    paths:
      - '.github/workflows/build-wpa_supplicant-aarch64-glibc.yml'

jobs:
  build-wpa_supplicant-aarch64:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - name: 安装交叉工具链与 arm64 开发库
        run: |
          sudo dpkg --add-architecture arm64
          sudo apt-get update
          sudo apt-get install -y --no-install-recommends \
            gcc-aarch64-linux-gnu g++-aarch64-linux-gnu \
            libnl-route-3-dev:arm64 libnl-genl-3-dev:arm64 \
            libssl-dev:arm64 pkg-config make bc ca-certificates
      - name: 下载源码
        run: |
          VER="${{ github.event.inputs.wpa_version || '2.10' }}"
          wget -q "https://w1.fi/releases/wpa_supplicant-${VER}.tar.gz" -O wpa.tar.gz
          tar xzf wpa.tar.gz
          echo "WPA_DIR=wpa_supplicant-${VER}" >> "$GITHUB_ENV"
      - name: 生成 .config（禁用 D-Bus/PCSC，启用 libnl32+OpenSSL+EAP）
        working-directory: ${{ env.WPA_DIR }}/wpa_supplicant
        run: |
          cp defconfig .config
          sed -i 's/^#CONFIG_LIBNL32=y/CONFIG_LIBNL32=y/' .config
          sed -i 's/^CONFIG_CTRL_IFACE_DBUS=y/#CONFIG_CTRL_IFACE_DBUS=y/' .config
          sed -i 's/^CONFIG_CTRL_IFACE_DBUS_NEW=y/#CONFIG_CTRL_IFACE_DBUS_NEW=y/' .config
          sed -i 's/^CONFIG_CTRL_IFACE_DBUS_INTRO=y/#CONFIG_CTRL_IFACE_DBUS_INTRO=y/' .config
          sed -i 's/^CONFIG_PCSC=y/#CONFIG_PCSC=y/' .config
          grep -nE "LIBNL32|CTRL_IFACE_DBUS|PCSC" .config
      - name: 交叉编译
        working-directory: ${{ env.WPA_DIR }}/wpa_supplicant
        env:
          PKG_CONFIG_PATH: /usr/lib/aarch64-linux-gnu/pkgconfig
          PKG_CONFIG_SYSROOT_DIR: /
        run: |
          make CC=aarch64-linux-gnu-gcc -j"$(nproc)"
          aarch64-linux-gnu-strip wpa_supplicant wpa_cli wpa_passphrase
      - name: 安全检查（禁止 libdbus/libsystemd/libpcsclite）
        working-directory: ${{ env.WPA_DIR }}/wpa_supplicant
        run: |
          readelf -d wpa_supplicant | grep -i needed
          if readelf -d wpa_supplicant | grep -qiE "libdbus|libsystemd|libpcsclite"; then
            echo "❌ 仍依赖 systemd 相关库，构建终止"; exit 1
          fi
      - name: 打包（无顶层目录）+ 唯一命名上传
        run: |
          VER="${{ github.event.inputs.wpa_version || '2.10' }}"
          PKGROOT="$PWD/pkgroot"
          rm -rf "$PKGROOT" && mkdir -p "$PKGROOT/usr/sbin" "$PKGROOT/usr/lib"
          cp -a "$WPA_DIR/wpa_supplicant/wpa_supplicant" "$WPA_DIR/wpa_supplicant/wpa_cli" "$PKGROOT/usr/sbin/"
          for lib in libnl-3.so.200 libnl-genl-3.so.200 libnl-route-3.so.200 libssl.so.3 libcrypto.so.3; do
            cp -aL "/usr/lib/aarch64-linux-gnu/$lib" "$PKGROOT/usr/lib/"
          done
          ART="wpa_supplicant-${VER}-aarch64-glibc-nosystemd-${{ github.run_number }}.tar.gz"
          tar czpf "$ART" -C "$PKGROOT" usr
          echo "ARTIFACT=$ART" >> "$GITHUB_ENV"
          tar tzf "$ART"
      - uses: actions/upload-artifact@v4
        with:
          name: ${{ env.ARTIFACT }}
          path: ${{ env.ARTIFACT }}
```

## 2) 通用模板（其它包直接套：hostapd / iw / dropbear / tcpdump ...）

文件命名：`build-<pkg>-aarch64-glibc.yml`（复制后改 `<PKG>` / `SOURCE_URL` / 配置与安装步骤）

```yaml
name: Cross-build <PKG> (aarch64/ARM64, glibc)

on:
  workflow_dispatch:
    inputs:
      pkg_version:
        description: '包版本'
        required: false
        default: '1.0'

jobs:
  cross-build-aarch64:
    runs-on: ubuntu-22.04
    env:
      PKG: <PKG>
      PKG_VER: ${{ github.event.inputs.pkg_version || '1.0' }}
      SOURCE_URL: https://example.com/<PKG>-${PKG_VER}.tar.gz
    steps:
      - uses: actions/checkout@v4
      - name: 安装交叉工具链与 arm64 开发库（按包需要增减）
        run: |
          sudo dpkg --add-architecture arm64
          sudo apt-get update
          sudo apt-get install -y --no-install-recommends \
            gcc-aarch64-linux-gnu g++-aarch64-linux-gnu \
            pkg-config make bc ca-certificates \
            libssl-dev:arm64
      - name: 下载并解压源码
        run: |
          wget -q "$SOURCE_URL" -O src.tar.gz
          tar xzf src.tar.gz
      - name: 配置 + 交叉编译（按包替换 configure/cmake/make 步骤）
        env:
          CC: aarch64-linux-gnu-gcc
          PKG_CONFIG_PATH: /usr/lib/aarch64-linux-gnu/pkgconfig
          PKG_CONFIG_SYSROOT_DIR: /
        run: |
          cd "<源码目录>"
          ./configure --host=aarch64-linux-gnu --prefix=/usr
          make -j"$(nproc)"
          aarch64-linux-gnu-strip <产出二进制>
      - name: 安全检查（禁止 systemd/dbus 等宿主依赖泄漏）
        run: |
          for b in <产出二进制路径>; do
            echo "== $b =="
            readelf -d "$b" | grep -i needed
            if readelf -d "$b" | grep -qiE "libdbus|libsystemd|libpcsclite"; then
              echo "❌ 泄漏宿主依赖，终止"; exit 1
            fi
          done
      - name: 打包（无顶层目录）+ 唯一命名上传
        run: |
          PKGROOT="$PWD/pkgroot"
          rm -rf "$PKGROOT" && mkdir -p "$PKGROOT/usr/bin" "$PKGROOT/usr/lib"
          cp -a <产出二进制> "$PKGROOT/usr/bin/"
          ART="${PKG}-${PKG_VER}-aarch64-glibc-${{ github.run_number }}.tar.gz"
          tar czpf "$ART" -C "$PKGROOT" usr
          echo "ARTIFACT=$ART" >> "$GITHUB_ENV"
      - uses: actions/upload-artifact@v4
        with:
          name: ${{ env.ARTIFACT }}
          path: ${{ env.ARTIFACT }}
```

## 命名约定（清晰辨识 + 防撞名）

| 元素 | 规则 |
|---|---|
| Workflow 文件 | `build-<pkg>-aarch64-glibc.yml` |
| Workflow `name:` | `Build <pkg> (aarch64/ARM64, glibc, [variant])` |
| 产物 | `<pkg>-<ver>-aarch64-glibc[-<variant>]-<run#>.tar.gz` |
| variant 示例 | `nosystemd`、`nodbussystemd`、`musl` |

每次构建产物名都带 `github.run_number`，TFTP/HTTP 缓存永远不会误发旧包。
