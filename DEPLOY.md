# Blog 小程序 API — 部署指南（微信云托管 CloudRun）

架构：**小程序 → 云托管(本目录 Express API) → 博客服务器数据包**
内容数据源：本地 `Blog/src/content/blog/*.md`（`~/MyCenter/Blog`，经 `BLOG_DIR` 显式指向）→ `scripts/export-miniapp.mjs` 生成数据包 →
`scripts/miniapp-sync.sh`(由 watch-blog.sh 自动调用) 推送到博客服务器 → API 启动/每 10 分钟拉取并缓存。
发新文章免重新部署：保存即发布管线自动完成。

> 原 COS 方案（`scripts/push-cos.mjs` + `~/.miniapp-cos.env`）保留备用，
> 若日后想数据包独立于博客服务器，配置凭据后改走 push-cos 即可。

## 1. 创建微信云托管环境与服务

1. 微信开发者工具打开 miniprogram 项目 → 工具栏点「云托管」→ 按引导开通（选按量计费，有免费额度）
2. 创建环境（如 `blog-prod`）→ 创建服务（如 `blog-api`）
3. 部署方式选 **Dockerfile**（本目录已带），上传本目录（zip 或本地目录）
4. 服务配置：端口 **80**（Dockerfile 已 EXPOSE 80）

## 2. 小程序端调用方式（免域名方案）

小程序端 API 调用走 **`wx.cloud.callContainer()`** 云网关通道——不需要 request 合法域名、
不需要自定义/备案域名，体验版与正式版均可用（个人主体小程序的合规解法）。

- 前端 `api/request.js`：`wx.cloud.callContainer({ config:{env}, path, header:{'X-WX-SERVICE': 服务名} })`
- ⚠️ 坑：**必须带 `X-WX-SERVICE` header 指定服务名**，否则报 `-601031 INVALID_PATH`
- 图片 `<image>` 直接加载网络图不受域名白名单限制；`wx.previewImage` 在体验版实测可用
- 若日后走正式版公网直连（wx.request + 自定义域名），才需要 request/downloadFile 白名单，
  且域名备案主体须与小程序主体一致（个人小程序不能用公司备案域名）

## 3. 数据包发布通道（博客服务器）

数据包由 `本仓 scripts/miniapp-sync.sh` 推送到博客服务器（`watch-blog.sh` 构建后自动调用，
也可手动 `bash 本仓 scripts/miniapp-sync.sh`）。线上地址固定为：
`https://blog.mgarden.org.cn/vincent/miniapp-data.json`

前置：`~/MyCenter/deploy-config.json` 有 server/remote_dir/domain，免密 SSH 正常
（与博客站点同步同一套，watch-blog 能推 dist 即可推数据包）。
验证：浏览器打开上面的 URL 能看到 JSON。

## 4. 云托管环境变量（服务配置 → 环境变量）

| 变量 | 值 |
|---|---|
| `MINIAPP_MODE` | `data` |
| `MINIAPP_DATA_URL` | `https://blog.mgarden.org.cn/vincent/miniapp-data.json` |

（`MINIAPP_MEDIA_ORIGIN` 可省略，默认 `https://blog.mgarden.org.cn`，与现有文章图片路径一致）

改完环境变量 → 服务 → 重启实例/重新部署。

## 5. 验证清单

```bash
curl https://<云托管域名>/healthz        # {ok:true, mode:"data"}
curl https://<云托管域名>/api/posts      # 文章列表
curl https://<云托管域名>/api/posts/hello-world   # 详情含 contentHtml
```

小程序端：config.js 指向云托管域名后，模拟器/真机（去掉「不校验合法域名」勾选）应全通。

## 常见问题

- **发文章后小程序没更新**：数据包 10 分钟缓存，等刷新或看 `miniapp-push.sh` 日志是否成功上传
- **图片裂**：downloadFile 合法域名漏配 / 图片是 http 明文
- **部署后 /api 404**：确认部署的是 miniapp/ 目录（server.js 在根），且服务端口 80
- **npm ci 失败**：Dockerfile 已设 npmmirror 源；若仍失败在服务配置里加环境变量 `NPM_CONFIG_REGISTRY=https://registry.npmmirror.com`
