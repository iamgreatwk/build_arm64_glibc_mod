#!/usr/bin/env bash
# 把本仓库的 skills/cross-build-aarch64 安装到本地 WorkBuddy/CodeBuddy skill 目录。
# 兼容：沙箱 (/root/.codebuddy/skills) 与本地 ($HOME/.codebuddy/skills)。
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/skills/cross-build-aarch64"

if [ ! -d "$SRC" ]; then
  echo "❌ 找不到 $SRC，请在仓库根目录运行本脚本"; exit 1
fi

# 探测目标目录（按优先级）
TARGET=""
for d in "$HOME/.codebuddy/skills" "/root/.codebuddy/skills" "$HOME/.config/codebuddy/skills"; do
  if [ -d "$(dirname "$d")" ]; then
    TARGET="$d"; break
  fi
done
[ -z "$TARGET" ] && TARGET="$HOME/.codebuddy/skills"

mkdir -p "$TARGET"
cp -r "$SRC" "$TARGET/"

echo "✅ 已安装到: $TARGET/cross-build-aarch64"
echo "   新会话中可直接调用 skill：cross-build-aarch64"
echo "   或说：交叉编译 wpa_supplicant 给 ARM64 / 生成 build 工作流 yml"
