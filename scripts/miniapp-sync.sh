#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# 小程序数据包同步：export → 推送到博客服务器（保存即发布的小程序半边）
# 由 ~/MyCenter/watch-blog.sh 在博客同步后自动调用；也可手动执行。
# 产物线上地址: https://blog.mgarden.org.cn/vincent/miniapp-data.json
# （云托管 API 以 MINIAPP_MODE=data + MINIAPP_DATA_URL 指向它）
# 依赖: BLOG_DIR(内容源 Blog 仓) + ~/MyCenter/deploy-config.json + 免密 SSH
# ─────────────────────────────────────────────────────────────
set -uo pipefail

MINIAPP_DIR="$HOME/blog-miniapp-api"
BLOG_DIR="${BLOG_DIR:-$HOME/MyCenter/Blog}"     # 内容源(export 读 md/site-config)
CONF="$HOME/MyCenter/deploy-config.json"
SSH_KEY="$HOME/.ssh/id_ed25519_mgarden"
LOG="/tmp/miniapp-sync.log"

SERVER=$(node -e "const c=require('$CONF');console.log((c.server||'').trim())" 2>/dev/null || true)
REMOTE_DIR=$(node -e "const c=require('$CONF');console.log((c.remote_dir||'').trim())" 2>/dev/null || true)

if [ -z "$SERVER" ] || [ -z "$REMOTE_DIR" ]; then
  echo "❌ deploy-config.json 缺少 server 或 remote_dir" | tee -a "$LOG"
  exit 1
fi
if [ ! -f "$SSH_KEY" ]; then
  echo "❌ SSH 私钥未找到: $SSH_KEY" | tee -a "$LOG"
  exit 1
fi
if [ ! -d "$BLOG_DIR/src/content/blog" ]; then
  echo "❌ 内容源目录不存在: $BLOG_DIR" | tee -a "$LOG"
  exit 1
fi

echo "🔄 [$(date '+%H:%M:%S')] 小程序数据包: export + 推送服务器…" | tee -a "$LOG"
cd "$MINIAPP_DIR" || exit 1
BLOG_DIR="$BLOG_DIR" node scripts/export-miniapp.mjs >>"$LOG" 2>&1 || { echo "  ✗ export 失败" | tee -a "$LOG"; exit 1; }

# 原子替换: 先传临时文件再 mv, 避免 nginx 读到半截 JSON
scp -i "$SSH_KEY" -o StrictHostKeyChecking=no data/data.json "$SERVER:$REMOTE_DIR/vincent/.miniapp-data.json.tmp" >>"$LOG" 2>&1 \
  && ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$SERVER" "mv -f $REMOTE_DIR/vincent/.miniapp-data.json.tmp $REMOTE_DIR/vincent/miniapp-data.json" >>"$LOG" 2>&1 \
  && echo "  ✓ 数据包已推送: https://blog.mgarden.org.cn/vincent/miniapp-data.json" | tee -a "$LOG" \
  || { echo "  ✗ scp/ssh 失败（检查免密 SSH / 服务器目录）" | tee -a "$LOG"; exit 1; }
