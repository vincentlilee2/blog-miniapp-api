// 记忆花园 Blog 小程序 API —— 微信云托管 CloudRun 部署入口
// 本地联调: node server.js  (默认 local 模式直读 Blog 仓 md, 端口 3004)
// 云上: MINIAPP_MODE=data MINIAPP_DATA_URL=<COS data.json> node server.js
// 健康检查: GET /healthz

import express from 'express';
import { listPosts, getPost, getSite, getTags, getArchive } from './lib/store.js';

const app = express();
const PORT = Number(process.env.PORT || process.env.MINIAPP_PORT || 3004);

app.use(express.json({ limit: '2mb' }));

// 统一包装 { ok, data } + 缓存头（内容低频变化，客户端可缓存 60s）
function wrap(handler) {
  return async (req, res) => {
    try {
      const data = await handler(req);
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ ok: true, data });
    } catch (e) {
      console.error(`[api] ${req.method} ${req.path} 失败:`, e.message);
      return res.status(e.status === 404 ? 404 : 500).json({ ok: false, error: e.message });
    }
  };
}

app.get('/healthz', (req, res) => res.json({ ok: true, name: 'blog-miniapp-api', mode: process.env.MINIAPP_MODE || 'local' }));

/** GET /api/site — 作者/名片信息 */
app.get('/api/site', wrap(async () => getSite()));

/** GET /api/posts?page=1&size=10&tag=xxx — 文章列表(可见文章,按日期倒序) */
app.get('/api/posts', wrap(async (req) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const size = Math.min(50, Math.max(1, parseInt(req.query.size, 10) || 10));
  const tag = typeof req.query.tag === 'string' ? req.query.tag.trim() : '';
  let posts = await listPosts();
  if (tag) posts = posts.filter((p) => p.tags.includes(tag));
  const total = posts.length;
  const list = posts.slice((page - 1) * size, page * size);
  return { list, total, page, size, hasMore: page * size < total };
}));

/** GET /api/posts/:slug — 文章详情(正文 HTML) */
app.get('/api/posts/:slug', wrap(async (req) => {
  const post = await getPost(req.params.slug);
  if (!post) {
    const err = new Error('文章不存在');
    err.status = 404;
    throw err;
  }
  return post;
}));

/** GET /api/tags — 标签聚合 [{name,count}] */
app.get('/api/tags', wrap(async () => getTags()));

/** GET /api/archive — 按月归档 */
app.get('/api/archive', wrap(async () => getArchive()));

// 404 → 带状态码的错误要落成 404 而非 500
app.use((err, req, res, next) => {
  if (err.status === 404) return res.status(404).json({ ok: false, error: err.message });
  return res.status(500).json({ ok: false, error: err.message });
});

app.listen(PORT, () => {
  console.log(`[miniapp-api] http://127.0.0.1:${PORT}  mode=${process.env.MINIAPP_MODE || 'local'}`);
});
