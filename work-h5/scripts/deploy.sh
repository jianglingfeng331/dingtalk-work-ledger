#!/usr/bin/env bash
# 前端一键部署（只能在本目录执行，防误把目录/文件搞错）
# 用法：bash scripts/deploy.sh
# 注意：rsync 不带 --delete，旧 hash 资源必须保留（钉钉webview缓存的旧index.html依赖它们）
set -euo pipefail
cd "$(dirname "$0")/.."

# 目录自检：必须是 work-h5 根目录（vite 工程）
[ -f vite.config.js ] && [ -d src/views ] || {
  echo "✗ 目录不对：当前 $(pwd) 不是 work-h5，中止"
  exit 1
}

echo "→ 构建前端（$(pwd)）"
npm run build

echo "→ 同步 dist（增量，保留旧资源）"
rsync -az dist root@101.37.210.127:/opt/workapp-git/work-h5/

echo "→ 验证线上 bundle"
ssh root@101.37.210.127 '
  bundle=$(curl -s http://127.0.0.1:3001/ | grep -o "index-[A-Za-z0-9_-]*\.js" | head -1)
  if [ -n "$bundle" ]; then echo "✓ 前端部署完成，线上 bundle: $bundle"; else echo "⚠ 未能读到线上 bundle，请手工检查"; exit 1; fi
'
