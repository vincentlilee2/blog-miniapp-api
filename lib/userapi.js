// 用户体系路由: 微信登录(jscode2session) + 会话 + 个人名片 CRUD + 头像上传(base64)
// 密钥 WX_APPID/WX_APPSECRET 只进环境(服务器 .env/ecosystem env), 不进代码仓
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  DATA_DIR, upsertUser, createSession, sessionOpenid,
  getCard, sanitizeCard, saveCard, getCardAvatarPath, getCardQrPaths, userExists,
  getUid, getOpenidByUid, addMessage, listMessages, addCardBox, removeCardBox, listCardBox,
  getWork, listWorksByUid, addWork, updateWork, deleteWork, reorderWorks,
  workSummary, workDetail,
  sanitizeWork, migrateLegacyWorks,
} from './db.js';

const router = express.Router();
const WX_APPID = process.env.WX_APPID || '';
const WX_APPSECRET = process.env.WX_APPSECRET || '';
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

// 头像等静态文件(nginx /miniapp-api/uploads/ → 上游 /uploads/ 已通)
router.use('/uploads', express.static(UPLOADS_DIR));

function requireAuth(req, res, next) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const openid = sessionOpenid(token);
  if (!openid) return res.status(401).json({ ok: false, error: '未登录或登录已过期' });
  req.openid = openid;
  next();
}

function cardPayload(card) {
  if (!card) return { exists: false };
  return { exists: true, card };
}

/**
 * POST /api/auth/login {code} — wx.login code 换 openid, 建/更新用户, 发 30 天会话 token
 * 返回 { token, isNew, card:{exists} }
 */
router.post('/api/auth/login', async (req, res) => {
  try {
    const code = String((req.body || {}).code || '').trim();
    if (!code) return res.status(400).json({ ok: false, error: '缺少登录凭证 code' });
    if (!WX_APPID || !WX_APPSECRET) {
      return res.status(503).json({ ok: false, error: '微信登录服务未配置' });
    }
    const qs = new URLSearchParams({
      appid: WX_APPID, secret: WX_APPSECRET, js_code: code, grant_type: 'authorization_code',
    });
    const wx = await (await fetch(`https://api.weixin.qq.com/sns/jscode2session?${qs}`)).json();
    if (!wx.openid) {
      const map = {
        40029: '登录凭证无效，请重新进入小程序',
        40125: '服务端 AppSecret 配置错误', 40013: 'AppID 配置错误', 41002: 'AppSecret 缺失',
      };
      console.error('[login] jscode2session 失败:', wx.errcode, wx.errmsg);
      return res.status(401).json({ ok: false, error: map[wx.errcode] || '微信登录失败，请稍后再试' });
    }
    const openid = wx.openid;
    const isNew = !userExists(openid);
    upsertUser(openid);
    const uid = getUid(openid);
    const token = createSession(openid);
    res.json({ ok: true, data: { token, isNew, uid, card: cardPayload(getCard(openid)) } });
  } catch (e) {
    console.error('[login] 失败:', e.message);
    res.status(500).json({ ok: false, error: '登录服务异常，请稍后再试' });
  }
});

/** GET /api/auth/me — 会话自检(前端启动时恢复登录态) */
router.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ ok: true, data: { openid: req.openid, uid: getUid(req.openid), ...cardPayload(getCard(req.openid)) } });
});

/**
 * GET /api/card/u/:uid — 公开只读名片(分享落地页用; uid 不暴露 openid)
 * 访客无需登录即可查看分享者的真实名片
 */
router.get('/api/card/u/:uid', (req, res) => {
  const openid = getOpenidByUid(String(req.params.uid || '').trim());
  const card = openid ? getCard(openid) : null;
  if (!card) {
    return res.status(404).json({ ok: false, error: '名片不存在或已删除' });
  }
  // 分享即公开名片: nickname(微信昵称) 保留——名片展示/分享标题需要, 用户主动分享即同意展示
  const uid = String(req.params.uid || '').trim();
  migrateLegacyWorks(openid, uid);
  const works = listWorksByUid(uid).map(workSummary);
  res.json({ ok: true, data: { uid, card: { ...card, works } } });
});

// 留言防滥用: 内容 hash 10 分钟去重 + 每 IP 60s/10 条
const mRecent = new Map();
const mWindow = new Map();
function msgTooFrequent(content, ip) {
  const now = Date.now();
  const hash = crypto.createHash('md5').update(String(content).trim()).digest('hex');
  const last = mRecent.get(hash);
  if (last && now - last < 10 * 60 * 1000) return true;
  mRecent.set(hash, now);
  if (mRecent.size > 300) {
    for (const [k, t] of mRecent) if (now - t > 30 * 60 * 1000) mRecent.delete(k);
  }
  const arr = mWindow.get(ip) || [];
  while (arr.length && now - arr[0] > 60_000) arr.shift();
  if (arr.length >= 10) { mWindow.set(ip, arr); return true; }
  arr.push(now);
  mWindow.set(ip, arr);
  return false;
}

/**
 * POST /api/messages {ownerUid,name,contact,content,workId?} — 访客给名片主人留言(存储式)
 * 内容 ≤30 字; workId 存在时校验作品归属并记录作品上下文; 留言进入主人「我的 → 访客留言区」
 */
router.post('/api/messages', (req, res) => {
  try {
    const { ownerUid = '', name = '', contact = '', content = '', workId = null } = req.body || {};
    const cleanOwner = String(ownerUid).trim();
    const cleanName = String(name).trim().slice(0, 20);
    const cleanContact = String(contact).trim().slice(0, 60);
    const rawContent = String(content).trim();
    if (!cleanOwner || !getOpenidByUid(cleanOwner)) {
      return res.status(400).json({ ok: false, error: '名片主人不存在' });
    }
    if (!rawContent) return res.status(400).json({ ok: false, error: '留言内容不能为空' });
    if (rawContent.length > 30) return res.status(400).json({ ok: false, error: '每条留言不超过 30 个字' });
    const cleanContent = rawContent;
    let workTitle = '';
    const w = workId ? getWork(Number(workId)) : null;
    if (workId) {
      if (!w || w.owner_uid !== cleanOwner) {
        return res.status(400).json({ ok: false, error: '作品不存在或不属于该名片主人' });
      }
      workTitle = w.title;
    }
    const ip = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '');
    if (msgTooFrequent(cleanContent, ip)) {
      return res.status(429).json({ ok: false, error: '提交太频繁，请稍后再试' });
    }
    addMessage({
      ownerUid: cleanOwner, name: cleanName, contact: cleanContact,
      content: cleanContent, workId: w ? w.id : null, workTitle,
    });
    res.json({ ok: true, data: { delivered: true } });
  } catch (e) {
    console.error('[messages] 失败:', e.message);
    res.status(500).json({ ok: false, error: '留言失败，请稍后再试' });
  }
});

/** GET /api/messages?page=1&size=6 — 我的访客留言(鉴权, 最新在前) */
router.get('/api/messages', requireAuth, (req, res) => {
  const uid = getUid(req.openid);
  if (!uid) return res.status(404).json({ ok: false, error: '用户 uid 缺失' });
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const size = Math.min(50, Math.max(1, parseInt(req.query.size, 10) || 6));
  res.json({ ok: true, data: listMessages(uid, { page, size }) });
});

/**
 * POST /api/cardbox {uid} — 收藏他人名片到我的名片夹(幂等; 自己名片不可收藏)
 */
router.post('/api/cardbox', requireAuth, (req, res) => {
  const myUid = getUid(req.openid);
  const savedUid = String((req.body || {}).uid || '').trim();
  if (!myUid) return res.status(404).json({ ok: false, error: '用户 uid 缺失' });
  if (!savedUid || savedUid === myUid) {
    return res.status(400).json({ ok: false, error: '名片 uid 无效' });
  }
  if (!getOpenidByUid(savedUid)) return res.status(404).json({ ok: false, error: '名片不存在' });
  addCardBox(myUid, savedUid);
  res.json({ ok: true, data: { saved: true } });
});

/** DELETE /api/cardbox {uid} — 从名片夹删除收藏 */
router.delete('/api/cardbox', requireAuth, (req, res) => {
  const myUid = getUid(req.openid);
  const savedUid = String((req.body || {}).uid || '').trim();
  if (!myUid || !savedUid) return res.status(400).json({ ok: false, error: '参数缺失' });
  removeCardBox(myUid, savedUid);
  res.json({ ok: true, data: { removed: true } });
});

/**
 * GET /api/cardbox — 我的名片夹: 自己的名片(第一位) + 收藏的好友名片(最近在前)
 * 缩略字段: { uid, name(姓名||昵称), avatar }
 */
router.get('/api/cardbox', requireAuth, (req, res) => {
  const myUid = getUid(req.openid);
  if (!myUid) return res.status(404).json({ ok: false, error: '用户 uid 缺失' });
  const list = [];
  const mine = getCard(getOpenidByUid(myUid));
  if (mine) {
    list.push({ uid: myUid, self: true, name: mine.name || mine.nickname || '', avatar: mine.avatar || '' });
  }
  for (const savedUid of listCardBox(myUid)) {
    const openid = getOpenidByUid(savedUid);
    const c = openid ? getCard(openid) : null;
    if (!c) continue;
    list.push({ uid: savedUid, self: false, name: c.name || c.nickname || '', avatar: c.avatar || '' });
  }
  res.json({ ok: true, data: { list } });
});

/**
 * POST /api/upload {data:dataURL} — 通用图片上传(作品图文等; ≤1MB, png/jpeg/webp) → {path}
 */
router.post('/api/upload', requireAuth, (req, res) => {
  try {
    const data = String((req.body || {}).data || '');
    const m = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(data);
    if (!m) return res.status(400).json({ ok: false, error: '图片格式不支持(需 png/jpeg/webp)' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 5 * 1024 * 1024) return res.status(400).json({ ok: false, error: '图片不能超过 5MB' });
    const ext = { png: '.png', jpeg: '.jpg', jpg: '.jpg', webp: '.webp' }[m[1]];
    const file = `${req.openid.replace(/[^a-zA-Z0-9_-]/g, '')}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, file), buf);
    res.json({ ok: true, data: { path: `/uploads/${file}` } });
  } catch (e) {
    console.error('[upload] 失败:', e.message);
    res.status(500).json({ ok: false, error: '上传失败，请稍后再试' });
  }
});

/** GET /api/works — 我的作品列表(摘要, 已按用户拖动顺序) */
router.get('/api/works', requireAuth, (req, res) => {
  const uid = getUid(req.openid);
  if (!uid) return res.status(404).json({ ok: false, error: '用户 uid 缺失' });
  res.json({ ok: true, data: { list: listWorksByUid(uid).map(workSummary) } });
});

/** POST /api/works/order {ids:[...]} — 保存拖动后的顺序(本用户作品按序重排) */
router.post('/api/works/order', requireAuth, (req, res) => {
  const uid = getUid(req.openid);
  const ids = Array.isArray((req.body || {}).ids) ? (req.body || {}).ids : [];
  if (!uid) return res.status(404).json({ ok: false, error: '用户 uid 缺失' });
  if (!ids.length) return res.status(400).json({ ok: false, error: 'ids 不能为空' });
  reorderWorks(uid, ids.slice(0, 100));
  res.json({ ok: true, data: { saved: true } });
});

/** POST /api/works {title,desc,media:[{img,text}≤5]} — 发布作品/项目 */
router.post('/api/works', requireAuth, (req, res) => {
  const uid = getUid(req.openid);
  if (!uid) return res.status(404).json({ ok: false, error: '用户 uid 缺失' });
  const clean = sanitizeWork(req.body || {});
  if (!clean.title) return res.status(400).json({ ok: false, error: '作品/项目名称不能为空' });
  const id = addWork({ ownerUid: uid, ...clean });
  res.json({ ok: true, data: { id } });
});

/** PUT /api/works/:id — 编辑自己的作品(整体替换) */
router.put('/api/works/:id', requireAuth, (req, res) => {
  const uid = getUid(req.openid);
  const clean = sanitizeWork(req.body || {});
  if (!clean.title) return res.status(400).json({ ok: false, error: '作品/项目名称不能为空' });
  if (!uid || !updateWork(Number(req.params.id), uid, clean)) {
    return res.status(404).json({ ok: false, error: '作品不存在或无权修改' });
  }
  res.json({ ok: true, data: { updated: true } });
});

/** DELETE /api/works/:id — 删除自己的作品 */
router.delete('/api/works/:id', requireAuth, (req, res) => {
  const uid = getUid(req.openid);
  if (!uid || !deleteWork(Number(req.params.id), uid)) {
    return res.status(404).json({ ok: false, error: '作品不存在或无权删除' });
  }
  res.json({ ok: true, data: { deleted: true } });
});

/** GET /api/works/:id — 作品展示页(公开; 含图文明细与主人信息) */
router.get('/api/works/:id', (req, res) => {
  const row = getWork(Number(req.params.id));
  if (!row) return res.status(404).json({ ok: false, error: '作品不存在或已删除' });
  const openid = getOpenidByUid(row.owner_uid);
  const card = openid ? getCard(openid) : null;
  const ownerName = card ? card.name || card.nickname || '' : '';
  const work = workDetail(row);
  work.ownerName = ownerName;
  res.json({ ok: true, data: { work } });
});

/** GET /api/card/me — 自己的名片(无则 {exists:false}); 作品改读作品表(懒迁移旧内嵌) */
router.get('/api/card/me', requireAuth, (req, res) => {
  const uid = getUid(req.openid);
  if (uid) migrateLegacyWorks(req.openid, uid);
  const card = getCard(req.openid);
  if (!card) return res.json({ ok: true, data: { exists: false } });
  const works = uid ? listWorksByUid(uid).map(workSummary) : [];
  res.json({ ok: true, data: { exists: true, card: { ...card, works } } });
});

/** PUT /api/card/me — 整体保存名片(表单全量提交; 白名单+截断) */
router.put('/api/card/me', requireAuth, (req, res) => {
  const card = sanitizeCard(req.body || {});
  saveCard(req.openid, card);
  res.json({ ok: true, data: { exists: true, card: getCard(req.openid) } });
});

/** POST /api/card/avatar {data: dataURL} — 头像上传(≤800KB, png/jpeg/webp), 存卡内相对路径 */
router.post('/api/card/avatar', requireAuth, (req, res) => {
  try {
    const data = String((req.body || {}).data || '');
    const m = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(data);
    if (!m) return res.status(400).json({ ok: false, error: '头像格式不支持(需 png/jpeg/webp)' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 800 * 1024) return res.status(400).json({ ok: false, error: '头像不能超过 800KB' });
    const ext = { png: '.png', jpeg: '.jpg', jpg: '.jpg', webp: '.webp' }[m[1]];
    const file = `${req.openid.replace(/[^a-zA-Z0-9_-]/g, '')}_${Date.now()}${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, file), buf);
    // 清旧头像(best-effort)
    const old = getCardAvatarPath(req.openid);
    if (old.startsWith('/uploads/')) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, path.basename(old))); } catch { /* 忽略 */ }
    }
    const avatar = `/uploads/${file}`;
    // 经 sanitizeCard 归一化(works 重新序列化)再覆盖头像字段
    const card = sanitizeCard(getCard(req.openid) || {});
    saveCard(req.openid, { ...card, avatar });
    res.json({ ok: true, data: { avatar } });
  } catch (e) {
    console.error('[avatar] 上传失败:', e.message);
    res.status(500).json({ ok: false, error: '头像上传失败，请稍后再试' });
  }
});

/**
 * POST /api/card/qr {type:'wechatQr'|'officialQr', data: dataURL} — 二维码图上传(选填, ≤800KB)
 * 存卡内对应字段 wechatQr/officialQr(相对路径)
 */
router.post('/api/card/qr', requireAuth, (req, res) => {
  try {
    const type = String((req.body || {}).type || '');
    if (type !== 'wechatQr' && type !== 'officialQr') {
      return res.status(400).json({ ok: false, error: 'type 只能是 wechatQr 或 officialQr' });
    }
    const data = String((req.body || {}).data || '');
    const m = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(data);
    if (!m) return res.status(400).json({ ok: false, error: '二维码图片格式不支持(需 png/jpeg/webp)' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 800 * 1024) return res.status(400).json({ ok: false, error: '二维码图片不能超过 800KB' });
    const ext = { png: '.png', jpeg: '.jpg', jpg: '.jpg', webp: '.webp' }[m[1]];
    const file = `${req.openid.replace(/[^a-zA-Z0-9_-]/g, '')}_${type}_${Date.now()}${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, file), buf);
    // 清旧图(best-effort)
    const old = getCardQrPaths(req.openid)[type];
    if (old.startsWith('/uploads/')) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, path.basename(old))); } catch { /* 忽略 */ }
    }
    const qrPath = `/uploads/${file}`;
    const card = sanitizeCard(getCard(req.openid) || {});
    saveCard(req.openid, { ...card, [type]: qrPath });
    res.json({ ok: true, data: { type, path: qrPath } });
  } catch (e) {
    console.error('[qr] 上传失败:', e.message);
    res.status(500).json({ ok: false, error: '二维码上传失败，请稍后再试' });
  }
});

export default router;
