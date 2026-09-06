// 记忆花园 Blog 小程序 API —— 微信云托管 CloudRun 部署入口
// 本地联调: node server.js  (默认 local 模式直读 Blog 仓 md, 端口 3004)
// 云上: MINIAPP_MODE=data MINIAPP_DATA_URL=<COS data.json> node server.js
// 健康检查: GET /healthz
// 留言: POST /api/guestbook —— SMTP 邮件回传(SMTP_USER/SMTP_PASS/SMTP_TO 环境变量, 不进代码)

import express from 'express';
import nodemailer from 'nodemailer';
import crypto from 'node:crypto';
import { listPosts, getPost, getSite, getTags, getArchive } from './lib/store.js';

const app = express();
const PORT = Number(process.env.PORT || process.env.MINIAPP_PORT || 3004);

app.use(express.json({ limit: '2mb' }));

// ─── 访客留言 SMTP 配置(环境变量注入, 密钥不进仓) ───
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_TO = process.env.SMTP_TO || SMTP_USER;
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.qq.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const smtpEnabled = Boolean(SMTP_USER && SMTP_PASS && SMTP_TO);
// 防滥用(内存级, 轻量): 内容 hash 10 分钟去重 + 全局每分钟 20 条上限
const gbRecent = new Map();
const gbWindow = [];
const GB_DEDUP_MS = 10 * 60 * 1000;

function tooFrequent(content) {
  const now = Date.now();
  const hash = crypto.createHash('md5').update(String(content).trim()).digest('hex');
  const last = gbRecent.get(hash);
  if (last && now - last < GB_DEDUP_MS) return true;
  gbRecent.set(hash, now);
  if (gbRecent.size > 200) { // 防 Map 无限增长: 清半小时前的
    for (const [k, t] of gbRecent) if (now - t > 30 * 60 * 1000) gbRecent.delete(k);
  }
  // 全局窗口限速: 最近 60s 最多 20 条
  while (gbWindow.length && now - gbWindow[0] > 60_000) gbWindow.shift();
  if (gbWindow.length >= 20) return true;
  gbWindow.push(now);
  return false;
}

function escapeText(s) {
  return String(s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}

let transporter = null;
if (smtpEnabled) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

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

/**
 * POST /api/guestbook — 访客留言(私信通道): 校验 → 限流 → SMTP 邮件回传
 * body: { name?, contact?, content }
 */
app.post('/api/guestbook', async (req, res) => {
  try {
    const { name = '', contact = '', content = '' } = req.body || {};
    const cleanName = String(name).trim().slice(0, 30);
    const cleanContact = String(contact).trim().slice(0, 120);
    const cleanContent = String(content).trim();

    if (!cleanContent) {
      return res.status(400).json({ ok: false, error: '留言内容不能为空' });
    }
    if (cleanContent.length > 500) {
      return res.status(400).json({ ok: false, error: '留言请控制在 500 字以内' });
    }
    if (!smtpEnabled || !transporter) {
      console.error('[guestbook] SMTP 未配置(SMTP_USER/SMTP_PASS/SMTP_TO)');
      return res.status(503).json({ ok: false, error: '留言服务暂不可用，请稍后再试' });
    }
    if (tooFrequent(cleanContent)) {
      return res.status(429).json({ ok: false, error: '提交太频繁，请稍后再试' });
    }

    const subject = `💬 记忆花园留言 · ${cleanName || '匿名访客'}`;
    const text = [
      `来自「记忆花园 Blog」微信小程序的访客留言：`,
      ``,
      `称呼：${cleanName || '(未填写)'}`,
      `联系方式：${cleanContact || '(未填写)'}`,
      ``,
      `留言内容：`,
      cleanContent,
      ``,
      `— 访客从小程序「我的 → 给 Vincent 留言」提交，请通过其留下的联系方式回复`,
    ].join('\n');

    await transporter.sendMail({
      from: `"记忆花园小程序" <${SMTP_USER}>`,
      to: SMTP_TO,
      subject,
      text,
    });
    console.log(`[guestbook] 留言已邮件送达: ${cleanName || '匿名'} (${cleanContent.length}字)`);
    res.json({ ok: true, data: { delivered: true } });
  } catch (e) {
    console.error('[guestbook] 发送失败:', e.message);
    res.status(500).json({ ok: false, error: '留言发送失败，请稍后再试' });
  }
});

// 404 → 带状态码的错误要落成 404 而非 500
app.use((err, req, res, next) => {
  if (err.status === 404) return res.status(404).json({ ok: false, error: err.message });
  return res.status(500).json({ ok: false, error: err.message });
});

app.listen(PORT, () => {
  console.log(`[miniapp-api] http://127.0.0.1:${PORT}  mode=${process.env.MINIAPP_MODE || 'local'}`);
});
