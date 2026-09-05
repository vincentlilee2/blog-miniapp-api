# Blog 小程序后端 API（blog-miniapp-api）

记忆花园 Blog 微信小程序的 Express API，部署于微信云托管（CloudRun）。

- `server.js` — API 入口（/api/site|posts|posts/:slug|tags|archive + /healthz）
- `lib/` — 双数据源 store（local 直读 Blog md 联调 / data 拉远端数据包）+ markdown→HTML
- `scripts/export-miniapp.mjs` — 把 Blog 仓 md 渲染成数据包 `miniapp-data/data.json`
- `scripts/push-cos.mjs` — （备用）数据包上传腾讯云 COS
- `Dockerfile` — 云托管镜像（node:20-alpine, 端口 80）
- `DEPLOY.md` — 云托管/COS/域名/发布全流程

## 数据链路（本地侧）
`~/MyCenter/Blog`（含文章 md）→ export 数据包 → `~/MyCenter/miniapp-sync.sh`
推博客服务器 `/vincent/miniapp-data.json` → 云托管 API 拉取缓存（10min）。

## 环境变量
- `MINIAPP_MODE=local|data`（默认 local：直读 ../src/content/blog 联调；data：拉 `MINIAPP_DATA_URL`）
- `MINIAPP_DATA_URL` — data 模式数据包 https 地址
- `MINIAPP_MEDIA_ORIGIN` — 站内媒体绝对前缀（默认 https://blog.mgarden.org.cn）
- `PORT` — 监听端口（云托管注入 80；本地默认 3004）

前端：WeChatProjects/miniprogram-1（私有仓 blog-miniapp-app），调用走 wx.cloud.callContainer。
