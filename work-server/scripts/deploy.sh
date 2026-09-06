#!/usr/bin/env bash
# 后端一键部署（只能在本目录执行，防误把前端源码同步到服务器）
# 用法：bash scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# 目录自检：必须是 work-server 根目录（有 index.js 入口和后端 src 结构）
[ -f index.js ] && [ -d src/services ] && [ -d src/routes ] || {
  echo "✗ 目录不对：当前 $(pwd) 不是 work-server，中止（防止误同步前端源码）"
  exit 1
}

echo "→ 部署 work-server（源：$(pwd)/src）"
rsync -az src root@101.37.210.127:/opt/workapp-git/work-server/

echo "→ 重启并健康检查"
ssh root@101.37.210.127 '
  pm2 restart work-server >/dev/null 2>&1
  sleep 2
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3001/api/projects)
  if [ "$code" = "401" ] || [ "$code" = "200" ]; then
    echo "✓ 服务健康 (HTTP $code)"
  else
    echo "✗ 健康检查失败 (HTTP $code)，请立刻查 pm2 logs work-server"
    exit 1
  fi
'
echo "✓ 后端部署完成"
