// markdown → HTML 转换与媒体路径重写
// 博客 md 里的图片是站内相对路径(/vincent/media/...)，小程序端 <image>/mp-html 拿不到，
// 必须在服务端统一重写为绝对 https URL。

import { Marked, Renderer } from 'marked';

const PROTO_RE = /^[a-z]+:\/\//i;

/** 把站内相对路径(/xxx 或无协议)重写为绝对媒体 URL；http(s) 原样保留 */
export function absolutizeMedia(src, mediaOrigin) {
  if (!src) return src;
  if (PROTO_RE.test(src)) return src; // 已是完整 URL
  if (src.startsWith('//')) return 'https:' + src;
  return mediaOrigin.replace(/\/+$/, '') + '/' + src.replace(/^\/+/, '');
}

// 独立实例 + 覆写 image renderer（marked v15 不支持 partial renderer 覆盖，且不污染全局）
const marked = new Marked();
marked.use({
  renderer: {
    image(token) {
      const src = absolutizeMedia(token.href, mediaOriginRef.current);
      const alt = (token.text || '').replace(/"/g, '&quot;');
      return `<img src="${src}" alt="${alt}">`;
    },
  },
});

// mediaOrigin 每次调用可不同（测试/多环境），用 ref 传给 renderer
const mediaOriginRef = { current: '' };

/** 文章正文 md → HTML（图片绝对化） */
export function mdToHtml(md, { mediaOrigin } = {}) {
  mediaOriginRef.current = mediaOrigin || '';
  return marked.parse(md || '', { async: false });
}

/** 剥掉 HTML 标签取纯文本（用于无 description 时生成摘要） */
export function htmlToText(html) {
  return (html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
