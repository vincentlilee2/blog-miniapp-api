// 生成小程序 API 数据包 miniapp-data/data.json（发布管线用，本地运行）
// 用法: node scripts/export-miniapp.mjs
// 产出: { posts:[摘要], details:{slug:{meta,contentHtml}}, tags:[], archive:[], site:{} }
// 注意: site-config.json 与文章均为私人内容 → miniapp-data/ 已 gitignore, 绝不进开源仓

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { fileURLToPath } from 'node:url';
import { mdToHtml, htmlToText } from '../lib/markdown.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BLOG_DIR = process.env.BLOG_DIR || path.resolve(__dirname, '..', '..');
const CONTENT_DIR = path.join(BLOG_DIR, 'src', 'content', 'blog');
const SITE_PATH = path.join(BLOG_DIR, 'site-config.json');
const OUT_DIR = path.join(BLOG_DIR, 'miniapp-data');
const MEDIA_ORIGIN = (process.env.MINIAPP_MEDIA_ORIGIN || 'https://blog.mgarden.org.cn').replace(/\/+$/, '');

function fmtDate(d) {
  if (!d) return '';
  if (d instanceof Date) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return String(d).slice(0, 10);
}

const files = fs.existsSync(CONTENT_DIR) ? fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith('.md')) : [];
const posts = files
  .map((f) => {
    const raw = fs.readFileSync(path.join(CONTENT_DIR, f), 'utf-8');
    const { data, content } = matter(raw);
    return {
      slug: f.replace(/\.md$/, ''),
      data,
      content,
    };
  })
  .map(({ slug, data, content }) => {
    const post = {
      slug,
      title: data.title || slug,
      description: data.description || '',
      date: fmtDate(data.date),
      tags: Array.isArray(data.tags) ? data.tags.filter((t) => typeof t === 'string') : [],
      cover: data.cover || '',
      coverPosition: data.coverPosition || '',
      published: data.published !== false,
      audience: data.audience || 'public',
      // 小程序开关：miniapp:false 的文章不进小程序数据包（博客站点不受影响）
      miniapp: data.miniapp !== false,
      content,
    };
    return post;
  })
  .filter((p) => p.published !== false && p.audience !== 'private' && p.miniapp !== false)
  .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

// 详情: 正文转 HTML（图片绝对化），description 兜底取正文纯文本前 120 字
const details = {};
for (const p of posts) {
  const contentHtml = mdToHtml(p.content, { mediaOrigin: MEDIA_ORIGIN });
  details[p.slug] = {
    slug: p.slug,
    title: p.title,
    description: p.description || htmlToText(contentHtml).slice(0, 120),
    date: p.date,
    tags: p.tags,
    cover: p.cover,
    coverPosition: p.coverPosition,
    contentHtml,
  };
}

// 摘要列表（不带正文与内部字段）
const list = posts.map(({ content, miniapp, ...meta }) => meta);

// tags / archive
const tagMap = new Map();
for (const p of posts) for (const t of p.tags) tagMap.set(t, (tagMap.get(t) || 0) + 1);
const tags = [...tagMap.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

const monthMap = new Map();
for (const p of posts) {
  const month = p.date.slice(0, 7);
  if (!month) continue;
  if (!monthMap.has(month)) monthMap.set(month, []);
  monthMap.get(month).push({ slug: p.slug, title: p.title, date: p.date });
}
const archive = [...monthMap.entries()]
  .sort((a, b) => (a[0] < b[0] ? 1 : -1))
  .map(([month, items]) => ({ month, posts: items }));

const site = fs.existsSync(SITE_PATH) ? JSON.parse(fs.readFileSync(SITE_PATH, 'utf-8')) : { author: {} };

fs.mkdirSync(OUT_DIR, { recursive: true });
const out = { exportedAt: new Date().toISOString(), posts: list, details, tags, archive, site };
fs.writeFileSync(path.join(OUT_DIR, 'data.json'), JSON.stringify(out));
console.log(`[export-miniapp] ✅ ${posts.length} 篇可见文章 → ${OUT_DIR}/data.json (${(fs.statSync(path.join(OUT_DIR, 'data.json')).size / 1024).toFixed(1)} KB)`);
