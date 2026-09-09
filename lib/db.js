// 用户/名片/会话 数据层 —— better-sqlite3 单文件库(DATA_DIR/app.db, WAL)
// 库文件 gitignored(data/); 表: users / cards / sessions
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  openid        TEXT PRIMARY KEY,
  uid           TEXT,                    -- 对外分享 id(随机短串, 不暴露 openid)
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cards (
  openid     TEXT PRIMARY KEY REFERENCES users(openid),
  nickname   TEXT NOT NULL DEFAULT '',
  avatar     TEXT NOT NULL DEFAULT '',   -- 相对路径 /uploads/xxx.jpg(origin 由前端拼)
  wechat_qr  TEXT NOT NULL DEFAULT '',   -- 个人微信二维码(选填)
  official_qr TEXT NOT NULL DEFAULT '',  -- 公众号二维码(选填)
  name       TEXT NOT NULL DEFAULT '',
  company    TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL DEFAULT '',
  city       TEXT NOT NULL DEFAULT '',
  wechat     TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL DEFAULT '',
  phone      TEXT NOT NULL DEFAULT '',
  bio        TEXT NOT NULL DEFAULT '',
  blog       TEXT NOT NULL DEFAULT '',   -- 记忆花园博客链接(选填)
  xiaohongshu TEXT NOT NULL DEFAULT '',  -- 小红书(选填)
  weibo      TEXT NOT NULL DEFAULT '',   -- 微博(选填)
  works      TEXT NOT NULL DEFAULT '[]', -- JSON [{title,desc}]
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  openid     TEXT NOT NULL REFERENCES users(openid),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_uid  TEXT NOT NULL,              -- 名片主人(分享 uid)
  name       TEXT NOT NULL DEFAULT '',
  contact    TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cardbox (
  user_uid   TEXT NOT NULL,              -- 收藏者 uid
  saved_uid  TEXT NOT NULL,              -- 被收藏的名片 uid
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_uid, saved_uid)
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_messages_owner ON messages(owner_uid, id DESC);
CREATE INDEX IF NOT EXISTS idx_cardbox_user ON cardbox(user_uid, created_at DESC);
`);

// 存量库迁移: 二维码选填列 + 社交三列(2026-09-08)
for (const col of ['wechat_qr', 'official_qr', 'blog', 'xiaohongshu', 'weibo']) {
  const has = db.prepare(`SELECT COUNT(*) c FROM pragma_table_info('cards') WHERE name = ?`).get(col).c > 0;
  if (!has) db.exec(`ALTER TABLE cards ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
}
// users.uid(对外分享 id)
{
  const has = db.prepare(`SELECT COUNT(*) c FROM pragma_table_info('users') WHERE name = 'uid'`).get().c > 0;
  if (!has) db.exec(`ALTER TABLE users ADD COLUMN uid TEXT`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_uid ON users(uid) WHERE uid IS NOT NULL`);
}

// ─── prepared statements ───
const stmts = {
  userGet: db.prepare(`SELECT openid, uid FROM users WHERE openid = ?`),
  userUpsert: db.prepare(
    `INSERT INTO users (openid, uid, created_at, last_login_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(openid) DO UPDATE SET last_login_at = excluded.last_login_at`),
  userUidSet: db.prepare(`UPDATE users SET uid = ? WHERE openid = ?`),
  openidByUid: db.prepare(`SELECT openid FROM users WHERE uid = ?`),
  sessionInsert: db.prepare(
    `INSERT INTO sessions (token, openid, created_at, expires_at) VALUES (?, ?, ?, ?)`),
  sessionFind: db.prepare(
    `SELECT s.openid, s.expires_at FROM sessions s WHERE s.token = ? AND s.expires_at > ?`),
  sessionDelete: db.prepare(`DELETE FROM sessions WHERE token = ?`),
  sessionCleanup: db.prepare(`DELETE FROM sessions WHERE expires_at < ?`),
  cardGet: db.prepare(`SELECT * FROM cards WHERE openid = ?`),
  cardUpsert: db.prepare(
    `INSERT INTO cards (openid, nickname, avatar, wechat_qr, official_qr, name, company, title, city, wechat, email, phone, bio, blog, xiaohongshu, weibo, works, updated_at)
     VALUES (@openid, @nickname, @avatar, @wechat_qr, @official_qr, @name, @company, @title, @city, @wechat, @email, @phone, @bio, @blog, @xiaohongshu, @weibo, @works, @updated_at)
     ON CONFLICT(openid) DO UPDATE SET
       nickname=@nickname, avatar=@avatar, wechat_qr=@wechat_qr, official_qr=@official_qr,
       name=@name, company=@company, title=@title,
       city=@city, wechat=@wechat, email=@email, phone=@phone, bio=@bio,
       blog=@blog, xiaohongshu=@xiaohongshu, weibo=@weibo, works=@works, updated_at=@updated_at`),
  cardAvatarPath: db.prepare(`SELECT avatar FROM cards WHERE openid = ?`),
  msgInsert: db.prepare(
    `INSERT INTO messages (owner_uid, name, contact, content, created_at) VALUES (?, ?, ?, ?, ?)`),
  msgListByOwner: db.prepare(
    `SELECT id, name, contact, content, created_at FROM messages WHERE owner_uid = ? ORDER BY id DESC LIMIT ? OFFSET ?`),
  msgCountByOwner: db.prepare(`SELECT COUNT(*) c FROM messages WHERE owner_uid = ?`),
  cardboxAdd: db.prepare(
    `INSERT OR IGNORE INTO cardbox (user_uid, saved_uid, created_at) VALUES (?, ?, ?)`),
  cardboxDel: db.prepare(`DELETE FROM cardbox WHERE user_uid = ? AND saved_uid = ?`),
  cardboxList: db.prepare(
    `SELECT saved_uid FROM cardbox WHERE user_uid = ? ORDER BY created_at DESC LIMIT 200`),
};

// 生成对外分享 uid(不暴露 openid; 冲突重试)
function genUid() {
  const ABC = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  const bytes = crypto.randomBytes(10);
  for (let i = 0; i < bytes.length; i++) s += ABC[bytes[i] % ABC.length];
  return s;
}

export function userExists(openid) {
  return Boolean(stmts.userGet.get(openid));
}

export function upsertUser(openid) {
  const now = Date.now();
  const row = stmts.userGet.get(openid);
  let uid = row ? row.uid : null;
  if (!uid) {
    for (let i = 0; i < 5; i++) {
      uid = genUid();
      if (!stmts.openidByUid.get(uid)) break;
      uid = null;
    }
    uid = uid || genUid();
    if (row) stmts.userUidSet.run(uid, openid);
  }
  stmts.userUpsert.run(openid, row ? row.uid : uid, now, now);
}

/** 取/确保用户对外 uid */
export function getUid(openid) {
  const row = stmts.userGet.get(openid);
  return row ? row.uid || '' : '';
}

/** uid → openid(公开名片路由用); 无则 null */
export function getOpenidByUid(uid) {
  const row = uid ? stmts.openidByUid.get(uid) : null;
  return row ? row.openid : null;
}

/** 给名片主人留言(新: 存储式, 非邮件) */
export function addMessage({ ownerUid, name = '', contact = '', content = '' }) {
  const r = stmts.msgInsert.run(ownerUid, name, contact, content, Date.now());
  return r.lastInsertRowid;
}

export function listMessages(ownerUid, { page = 1, size = 6 } = {}) {
  const p = Math.max(1, page | 0);
  const s = Math.min(50, Math.max(1, size | 0));
  const total = stmts.msgCountByOwner.get(ownerUid).c;
  const rows = stmts.msgListByOwner.all(ownerUid, s, (p - 1) * s);
  return {
    list: rows,
    total,
    page: p,
    size: s,
    hasMore: p * s < total,
  };
}

/** 名片夹: 收藏(幂等) / 删除 / 列表(最近收藏在前) */
export function addCardBox(userUid, savedUid) {
  stmts.cardboxAdd.run(userUid, savedUid, Date.now());
}

export function removeCardBox(userUid, savedUid) {
  stmts.cardboxDel.run(userUid, savedUid);
}

export function listCardBox(userUid) {
  return stmts.cardboxList.all(userUid).map((r) => r.saved_uid);
}

export function createSession(openid, ttlMs = 30 * 24 * 3600 * 1000) {
  const now = Date.now();
  stmts.sessionCleanup.run(now); // 顺手清过期会话
  const token = crypto.randomBytes(24).toString('hex');
  stmts.sessionInsert.run(token, openid, now, now + ttlMs);
  return token;
}

/** 校验 Bearer token → openid | null */
export function sessionOpenid(token) {
  if (!token) return null;
  const row = stmts.sessionFind.get(token, Date.now());
  return row ? row.openid : null;
}

export function revokeSession(token) {
  if (token) stmts.sessionDelete.run(token);
}

const CARD_FIELDS = ['nickname', 'avatar', 'name', 'company', 'title', 'city', 'wechat', 'email', 'phone', 'bio', 'blog', 'xiaohongshu', 'weibo'];
// API 字段(驼峰) → DB 列(snake): 仅命名不一致的列需列出
const COL_MAP = { wechatQr: 'wechat_qr', officialQr: 'official_qr' };

export function getCard(openid) {
  const row = stmts.cardGet.get(openid);
  if (!row) return null;
  const card = {};
  for (const f of CARD_FIELDS) card[f] = row[f] || '';
  for (const [camel, col] of Object.entries(COL_MAP)) card[camel] = row[col] || '';
  try { card.works = JSON.parse(row.works || '[]'); } catch { card.works = []; }
  card.updatedAt = row.updated_at;
  return card;
}

/** 字段白名单 + 截断清洗; works 仅保留 {title,desc} 字符串, 最多 8 项 */
export function sanitizeCard(body = {}) {
  const cut = (s, n) => String(s ?? '').trim().slice(0, n);
  const card = {
    nickname: cut(body.nickname, 30),
    avatar: cut(body.avatar, 200),
    wechatQr: cut(body.wechatQr, 200),
    officialQr: cut(body.officialQr, 200),
    name: cut(body.name, 40),
    company: cut(body.company, 60),
    title: cut(body.title, 40),
    city: cut(body.city, 30),
    wechat: cut(body.wechat, 60),
    email: cut(body.email, 80),
    phone: cut(body.phone, 30),
    bio: cut(body.bio, 120),
    blog: cut(body.blog, 300),
    xiaohongshu: cut(body.xiaohongshu, 200),
    weibo: cut(body.weibo, 200),
  };
  const works = Array.isArray(body.works) ? body.works.slice(0, 8) : [];
  card.works = JSON.stringify(works.map((w) => ({
    title: cut(w && w.title, 40),
    desc: cut(w && w.desc, 200),
  })).filter((w) => w.title || w.desc));
  return card;
}

export function saveCard(openid, card) {
  stmts.cardUpsert.run({
    openid,
    ...card,
    wechat_qr: card.wechatQr || '',
    official_qr: card.officialQr || '',
    updated_at: Date.now(),
  });
}

export function getCardQrPaths(openid) {
  const row = stmts.cardGet.get(openid);
  if (!row) return { wechatQr: '', officialQr: '' };
  return { wechatQr: row.wechat_qr || '', officialQr: row.official_qr || '' };
}

export function getCardAvatarPath(openid) {
  const row = stmts.cardAvatarPath.get(openid);
  return row ? row.avatar : '';
}

export { DATA_DIR };
