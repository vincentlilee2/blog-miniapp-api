// 用户体系路由: 微信登录(jscode2session) + 会话 + 个人名片 CRUD + 头像上传(base64)
// 密钥 WX_APPID/WX_APPSECRET 只进环境(服务器 .env/ecosystem env), 不进代码仓
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  DATA_DIR, upsertUser, createSession, sessionOpenid,
  getCard, sanitizeCard, saveCard, getCardAvatarPath, userExists,
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
    const token = createSession(openid);
    res.json({ ok: true, data: { token, isNew, card: cardPayload(getCard(openid)) } });
  } catch (e) {
    console.error('[login] 失败:', e.message);
    res.status(500).json({ ok: false, error: '登录服务异常，请稍后再试' });
  }
});

/** GET /api/auth/me — 会话自检(前端启动时恢复登录态) */
router.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ ok: true, data: { openid: req.openid, ...cardPayload(getCard(req.openid)) } });
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

export default router;
