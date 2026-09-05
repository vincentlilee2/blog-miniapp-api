// 数据源抽象：local（本地直读 md 联调）| data（云上拉 COS 数据包，内存缓存 + 定时刷新）
// 对外统一返回「已过滤 + 已排序 + 相对路径」的原始数据，URL 绝对化在 API 层做。
//
// 环境变量：
//   MINIAPP_MODE        local(默认) | data
//   MINIAPP_DATA_URL    mode=data 时必填：COS 上 data.json 的 https 地址
//   MINIAPP_REFRESH_MS  数据包刷新间隔，默认 600000(10min)
//   BLOG_DIR            local 模式 Blog 仓根目录，默认 miniapp/ 的上一级

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { fileURLToPath } from 'node:url';
import { mdToHtml, htmlToText, absolutizeMedia } from './markdown.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODE = process.env.MINIAPP_MODE || 'local';
const REFRESH_MS = Number(process.env.MINIAPP_REFRESH_MS || 600000);
// 站内媒体绝对前缀（文章图片 / 封面 / 头像都基于它拼 https URL）
const MEDIA_ORIGIN = (process.env.MINIAPP_MEDIA_ORIGIN || 'https://blog.mgarden.org.cn').replace(/\/+$/, '');

// ─── 可见性过滤：小程序只读 published=true 且非 audience=private 且未 miniapp:false 的文章 ───
function isVisible(post) {
  return post.published !== false && post.audience !== 'private' && post.miniapp !== false;
}

function fmtDate(d) {
  if (!d) return '';
  if (d instanceof Date) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  return String(d).slice(0, 10);
}

/** 归一化文章对象（兼容 gray-matter Date 与字符串两种 date） */
function normalizePost(raw) {
  const fm = raw.data || {};
  return {
    slug: raw.slug,
    title: fm.title || raw.slug,
    description: fm.description || '',
    date: fmtDate(fm.date || raw.date || ''),
    tags: Array.isArray(fm.tags) ? fm.tags.filter((t) => typeof t === 'string' && t.trim()) : [],
    cover: fm.cover || '',
    coverPosition: fm.coverPosition || '',
    published: fm.published !== false,
    audience: fm.audience || 'public',
    miniapp: fm.miniapp !== false,
    content: raw.content || '',
  };
}

// ─── LocalStore：直读 Blog 仓 md（本地开发/联调用）───
class LocalStore {
  constructor(blogDir) {
    this.blogDir = blogDir;
    this.contentDir = path.join(blogDir, 'src', 'content', 'blog');
    this.sitePath = path.join(blogDir, 'site-config.json');
  }

  _loadAll() {
    if (!fs.existsSync(this.contentDir)) return [];
    return fs
      .readdirSync(this.contentDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const raw = fs.readFileSync(path.join(this.contentDir, f), 'utf-8');
        const { data, content } = matter(raw);
        return normalizePost({ slug: f.replace(/\.md$/, ''), data, content });
      });
  }

  listPosts() {
    return this._loadAll().filter(isVisible).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  getPost(slug) {
    const p = this._loadAll().find((x) => x.slug === slug);
    if (!p || !isVisible(p)) return null;
    return p;
  }

  getSite() {
    let site = { author: {} };
    if (fs.existsSync(this.sitePath)) {
      try {
        site = JSON.parse(fs.readFileSync(this.sitePath, 'utf-8'));
      } catch {
        site = { author: {} };
      }
    }
    return absolutizeSite(site);
  }
}

/** site-config 里白名单媒体字段绝对化（avatar/头像/二维码等） */
function absolutizeSite(site) {
  const a = site.author || {};
  const abs = (v) => absolutizeMedia(v, MEDIA_ORIGIN);
  const out = {
    ...site,
    author: {
      ...a,
      avatar: abs(a.avatar),
      avatarOg: abs(a.avatarOg),
      card: a.card
        ? { ...a.card, wechatQr: abs(a.card.wechatQr), officialQr: abs(a.card.officialQr) }
        : undefined,
    },
  };
  return out;
}

// ─── DataStore：拉取 COS 数据包（云托管生产模式）───
// 数据包结构(由 scripts/export-miniapp.mjs 生成)：
// { posts:[摘要], details:{slug:{...meta,contentHtml,description}}, tags:[], archive:[], site:{} }
class DataStore {
  constructor(dataUrl) {
    this.dataUrl = dataUrl;
    this.data = null;
    this.lastFetch = 0;
  }

  async _ensure() {
    const now = Date.now();
    if (this.data && now - this.lastFetch < REFRESH_MS) return this.data;
    const res = await fetch(this.dataUrl, { headers: { 'Cache-Control': 'no-cache' } });
    if (!res.ok) {
      // 拉取失败但有旧缓存 → 继续服务旧数据（博客内容不关键，别因 COS 抖动全挂）
      if (this.data) {
        console.warn(`[store] 数据包刷新失败 ${res.status}，沿用旧缓存`);
        this.lastFetch = now;
        return this.data;
      }
      throw new Error(`数据包拉取失败: HTTP ${res.status} ${this.dataUrl}`);
    }
    this.data = await res.json();
    this.lastFetch = now;
    console.log(`[store] 数据包已加载 ${Object.keys(this.data.details || {}).length} 篇`);
    return this.data;
  }

  async listPosts() {
    const d = await this._ensure();
    return (d.posts || []).map((p) => ({ ...p, content: '' })).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  async getPost(slug) {
    const d = await this._ensure();
    const p = (d.details || {})[slug];
    return p ? { ...p } : null;
  }

  async getSite() {
    const d = await this._ensure();
    return absolutizeSite(d.site || { author: {} });
  }
}

let store;
if (MODE === 'data') {
  if (!process.env.MINIAPP_DATA_URL) throw new Error('MINIAPP_MODE=data 时须设置 MINIAPP_DATA_URL');
  store = new DataStore(process.env.MINIAPP_DATA_URL);
} else {
  const blogDir = process.env.BLOG_DIR || path.resolve(__dirname, '..', '..');
  store = new LocalStore(blogDir);
}

// ─── 统一数据入口（async，两种模式一致）───
export async function listPosts() {
  const list = await store.listPosts();
  return list.map((p) => ({
    slug: p.slug,
    title: p.title,
    description: p.description || '',
    date: p.date,
    tags: p.tags,
    cover: absolutizeMedia(p.cover, MEDIA_ORIGIN),
    coverPosition: p.coverPosition,
  }));
}

export async function getPost(slug) {
  const p = await store.getPost(slug);
  if (!p) return null;
  // 详情正文：local 模式现转 HTML；data 模式数据包已带 contentHtml
  const contentHtml = p.contentHtml || mdToHtml(p.content || '', { mediaOrigin: MEDIA_ORIGIN });
  const description = p.description || htmlToText(contentHtml).slice(0, 120);
  return {
    slug: p.slug,
    title: p.title,
    description,
    date: p.date,
    tags: p.tags,
    cover: absolutizeMedia(p.cover, MEDIA_ORIGIN),
    coverPosition: p.coverPosition,
    contentHtml,
  };
}

export async function getSite() {
  return store.getSite();
}

export async function getTags() {
  const posts = await listPosts();
  const map = new Map();
  for (const p of posts) for (const t of p.tags) map.set(t, (map.get(t) || 0) + 1);
  return [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

export async function getArchive() {
  const posts = await listPosts();
  const map = new Map(); // month -> posts
  for (const p of posts) {
    const month = (p.date || '').slice(0, 7);
    if (!month) continue;
    if (!map.has(month)) map.set(month, []);
    map.get(month).push({ slug: p.slug, title: p.title, date: p.date });
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([month, items]) => ({ month, posts: items }));
}
