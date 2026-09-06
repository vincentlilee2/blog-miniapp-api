#!/usr/bin/env bash
# 本地启动 Blog 小程序 API(3004) —— 供 ~/MyCenter/start.sh 调用
# SMTP 凭据从同仓 .env 读取(600, 已 gitignore, 不进仓); 缺凭据服务照起(留言接口回 503)
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$DIR/.env"
  set +a
fi
exec env BLOG_DIR="$HOME/MyCenter/Blog" node "$DIR/server.js"
