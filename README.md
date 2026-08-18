# cross-build-aarch64 — ARM64 交叉编译与部署工具集

为 OnePlus 3（postmarketOS / buildroot，ARM64 aarch64）等嵌入式设备交叉编译 Linux 网络工具，
固化了 wpa_supplicant 的完整方法：**去 D-Bus/systemd 依赖、EAP 保留、无顶层目录打包、防撞名**。

## 目录结构

```
.
├── .github/workflows/
│   ├── build-wpa_supplicant-aarch64-glibc.yml   # wpa_supplicant 专用 CI（运行时拉源码，空仓库即可跑）
│   └── cross-build-aarch64-template.yml         # 通用模板，复制改名 build-<pkg>-aarch64-glibc.yml 即可套用
├── skills/
│   └── cross-build-aarch64/                     # WorkBuddy/CodeBuddy 可调用的 skill
│       ├── SKILL.md                             # 核心方法 + D-Bus→systemd 坑 + 部署 + Gotchas
│       ├── references/workflows.md             # 现成工作流（wpa_supplicant + 通用模板全文）
│       └── scripts/
│           ├── build-wpa_supplicant.sh          # 本地等价编译脚本（amd64 Ubuntu）
│           └── cross-build-template.sh          # 本地通用编译模板
├── install-skill.sh                             # 把 skills/ 安装到本地 ~/.codebuddy/skills/
└── .gitignore
```

## 两种用法

### A) GitHub Actions 编译（推荐，零本地环境）

1. 把这个仓库 push 到 GitHub（空仓库也行，源码由 CI 运行时 `wget` 拉取，无需 fork 上游）。
2. **Actions** → 选 `Build wpa_supplicant (aarch64/ARM64, glibc, no D-Bus/systemd)` → **Run workflow**（可填版本，默认 2.10）。
3. 跑完到 **Artifacts** 下载 `wpa_supplicant-<ver>-aarch64-glibc-nosystemd-<run#>.tar.gz`。
4. TFTP 传到设备（`tftp -g` 拉新名文件，避免缓存旧包）：
   ```bash
   busybox tftp -g -l /tmp/<artifact>.tar.gz -r <artifact>.tar.gz <SERVER_IP>
   tar tzf /tmp/<artifact>.tar.gz | head -1    # 必须是 usr/，否则拉错旧包
   cd /tmp && tar -xzf <artifact>.tar.gz -C /
   /usr/sbin/wpa_supplicant -v                 # 不再报 libsystemd.so.0
   ```

> 通用模板 `cross-build-aarch64-template.yml` 复制改名后，把 `<PKG>` / `SOURCE_URL` / 配置与编译步骤替换，即可编译 hostapd / iw / dropbear / tcpdump 等。

### B) 让 AI 助手直接调用 skill

```bash
./install-skill.sh        # 把 skills/cross-build-aarch64 装到本地 skill 目录
```

安装后，新会话里只要说"交叉编译 wpa_supplicant 给 ARM64 / 生成 build 工作流 yml"，助手即可直接调用该 skill。

## 命名约定（清晰辨识 + 防撞名）

| 元素 | 规则 |
|---|---|
| Workflow 文件 | `build-<pkg>-aarch64-glibc.yml` |
| Workflow `name:` | `Build <pkg> (aarch64/ARM64, glibc, [variant])` |
| 产物 | `<pkg>-<ver>-aarch64-glibc[-<variant>]-<run#>.tar.gz` |
| variant 示例 | `nosystemd`、`nodbussystemd`、`musl` |

每次构建产物名都带 `github.run_number`，TFTP/HTTP 缓存永远不会误发旧包。

## 关键踩坑（已固化进 skill）

| 现象 | 根因 | 解法 |
|---|---|---|
| `libsystemd.so.0 not found` | D-Bus 启用 → libdbus → libsystemd | 编译关 `CONFIG_CTRL_IFACE_DBUS*` + `CONFIG_PCSC`，依赖只留 libnl/libssl/libcrypto |
| 解压出 `wpa-eap-.../` 顶层文件夹 | tar 包带了顶层目录前缀 | 打包用 `tar -C pkgroot usr` 去前缀 |
| 重新 tftp 仍跑旧行为 | server 上同名旧文件 | 每次产物强制唯一命名 |
| 连到错误 SSID | `update_config=1` 把别的网络写回 conf | conf 设 `update_config=0`，只留目标网络 |

## 设备端 EAP 连接示例（JNU-Secure / PEAP-MSCHAPv2）

```ini
# /tmp/ent.conf
ctrl_interface=/var/run/wpa_supplicant
ctrl_interface_group=0
update_config=0
network={
  ssid="JNU-Secure"
  key_mgmt=WPA-EAP
  eap=PEAP
  identity="你的账号"
  password="你的密码"
  phase2="auth=MSCHAPV2"
  phase1="peapver=0"
}
```

```bash
mkdir -p /var/run/wpa_supplicant
/usr/sbin/wpa_supplicant -i wlan0 -c /tmp/ent.conf -B
udhcpc -i wlan0
wpa_cli -i wlan0 status    # 看 wpa_state=COMPLETED
```
