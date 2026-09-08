// 用户体系路由: 微信登录(jscode2session) + 会话 + 个人名片 CRUD + 头像上传(base64)
// 密钥 WX_APPID/WX_APPSECRET 只进环境(服务器 .env/ecosystem env), 不进代码仓
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  DATA_DIR, upsertUser, createSession, sessionOpenid,
  getCard, sanitizeCard, saveCard, getCardAvatarPath, getCardQrPaths, userExists,
  getUid, getOpenidByUid, addMessage, listMessages,
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
  res.json({ ok: true, data: { uid: req.params.uid, card } });
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
 * POST /api/messages {ownerUid,name,contact,content} — 访客给名片主人留言(存储式)
 * 内容 ≤30 字; 留言进入主人「我的 → 访客留言区」
 */
router.post('/api/messages', (req, res) => {
  try {
    const { ownerUid = '', name = '', contact = '', content = '' } = req.body || {};
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
    const ip = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '');
    if (msgTooFrequent(cleanContent, ip)) {
      return res.status(429).json({ ok: false, error: '提交太频繁，请稍后再试' });
    }
    addMessage({ ownerUid: cleanOwner, name: cleanName, contact: cleanContact, content: cleanContent });
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

/** GET /api/card/me — 自己的名片(无则 {exists:false}) */
router.get('/api/card/me', requireAuth, (req, res) => {
  res.json({ ok: true, data: cardPayload(getCard(req.openid)) });
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
