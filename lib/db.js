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
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cards (
  openid     TEXT PRIMARY KEY REFERENCES users(openid),
  nickname   TEXT NOT NULL DEFAULT '',
  avatar     TEXT NOT NULL DEFAULT '',   -- 相对路径 /uploads/xxx.jpg(origin 由前端拼)
  name       TEXT NOT NULL DEFAULT '',
  company    TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL DEFAULT '',
  city       TEXT NOT NULL DEFAULT '',
  wechat     TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL DEFAULT '',
  phone      TEXT NOT NULL DEFAULT '',
  bio        TEXT NOT NULL DEFAULT '',
  works      TEXT NOT NULL DEFAULT '[]', -- JSON [{title,desc}]
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  openid     TEXT NOT NULL REFERENCES users(openid),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`);

// ─── prepared statements ───
const stmts = {
  userGet: db.prepare(`SELECT openid FROM users WHERE openid = ?`),
  userUpsert: db.prepare(
    `INSERT INTO users (openid, created_at, last_login_at) VALUES (?, ?, ?)
     ON CONFLICT(openid) DO UPDATE SET last_login_at = excluded.last_login_at`),
  sessionInsert: db.prepare(
    `INSERT INTO sessions (token, openid, created_at, expires_at) VALUES (?, ?, ?, ?)`),
  sessionFind: db.prepare(
    `SELECT s.openid, s.expires_at FROM sessions s WHERE s.token = ? AND s.expires_at > ?`),
  sessionDelete: db.prepare(`DELETE FROM sessions WHERE token = ?`),
  sessionCleanup: db.prepare(`DELETE FROM sessions WHERE expires_at < ?`),
  cardGet: db.prepare(`SELECT * FROM cards WHERE openid = ?`),
  cardUpsert: db.prepare(
    `INSERT INTO cards (openid, nickname, avatar, name, company, title, city, wechat, email, phone, bio, works, updated_at)
     VALUES (@openid, @nickname, @avatar, @name, @company, @title, @city, @wechat, @email, @phone, @bio, @works, @updated_at)
     ON CONFLICT(openid) DO UPDATE SET
       nickname=@nickname, avatar=@avatar, name=@name, company=@company, title=@title,
       city=@city, wechat=@wechat, email=@email, phone=@phone, bio=@bio, works=@works, updated_at=@updated_at`),
  cardAvatarPath: db.prepare(`SELECT avatar FROM cards WHERE openid = ?`),
};

export function userExists(openid) {
  return Boolean(stmts.userGet.get(openid));
}

export function upsertUser(openid) {
  const now = Date.now();
  stmts.userUpsert.run(openid, now, now);
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

const CARD_FIELDS = ['nickname', 'avatar', 'name', 'company', 'title', 'city', 'wechat', 'email', 'phone', 'bio'];

export function getCard(openid) {
  const row = stmts.cardGet.get(openid);
  if (!row) return null;
  const card = {};
  for (const f of CARD_FIELDS) card[f] = row[f] || '';
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
    name: cut(body.name, 40),
    company: cut(body.company, 60),
    title: cut(body.title, 40),
    city: cut(body.city, 30),
    wechat: cut(body.wechat, 60),
    email: cut(body.email, 80),
    phone: cut(body.phone, 30),
    bio: cut(body.bio, 120),
  };
  const works = Array.isArray(body.works) ? body.works.slice(0, 8) : [];
  card.works = JSON.stringify(works.map((w) => ({
    title: cut(w && w.title, 40),
    desc: cut(w && w.desc, 200),
  })).filter((w) => w.title || w.desc));
  return card;
}

export function saveCard(openid, card) {
  stmts.cardUpsert.run({ openid, ...card, updated_at: Date.now() });
}

export function getCardAvatarPath(openid) {
  const row = stmts.cardAvatarPath.get(openid);
  return row ? row.avatar : '';
}

export { DATA_DIR };
