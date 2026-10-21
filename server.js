'use strict';

require('dotenv').config();

const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pipeline } = require('stream');

const { createTokenCodec } = require('./lib/token');
const { parseRange } = require('./lib/range');

// ─── 基础配置 ────────────────────────────────────────────────────────────────
const APP_VERSION = '20261021';
const PORT = Number(process.env.PORT) || 3000;
const BASE_PATH = path.join(__dirname);
const INDEX_PATH = path.join(BASE_PATH, 'public', 'index.html');

// 反向代理层数：默认 1（nginx）；设为 0 表示不信任任何代理头
const TRUST_PROXY = process.env.TRUST_PROXY === '0'
  ? false
  : (Number(process.env.TRUST_PROXY) || 1);

// 对外访问地址（可选），用于生成分享链接；不填则用请求头推导
const PUBLIC_URL = String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');

const CACHE_DIR = path.join(BASE_PATH, 'cache');
const CACHE_META_FILE = path.join(CACHE_DIR, 'meta.json');
const MAX_CACHE_SIZE = (Number(process.env.MAX_CACHE_SIZE_GB) || 5) * 1024 ** 3;
const CACHE_TTL = (Number(process.env.CACHE_TTL_DAYS) || 100) * 24 * 60 * 60 * 1000;
const CACHE_CLEAN_INTERVAL = 6 * 60 * 60 * 1000;

const FILE_LIST_LIMIT = Number(process.env.FILE_LIST_LIMIT) || 5000;
const SHARE_TTL_MS = (Number(process.env.SHARE_TTL_HOURS) || 0) * 60 * 60 * 1000;
const SESSION_TTL_MS = (Number(process.env.SESSION_TTL_HOURS) || 24) * 60 * 60 * 1000;
const SESSION_COOKIE = 'gdl_session';

// ─── 密钥 ────────────────────────────────────────────────────────────────────
const rawSecret = process.env.SESSION_SECRET;
if (!rawSecret || rawSecret === 'change-this-to-a-random-secret' || rawSecret.length < 16) {
  console.warn('[安全] SESSION_SECRET 未设置或强度不足，本次启动将使用随机密钥；重启后登录状态与分享链接会全部失效');
}
const SESSION_SECRET = rawSecret && rawSecret.length >= 16
  ? rawSecret
  : crypto.randomBytes(32).toString('hex');
const tokens = createTokenCodec(SESSION_SECRET);

// ─── 多数据源配置 ────────────────────────────────────────────────────────────
// DRIVE_SOURCES=[{"id":"work","name":"工作盘","keyFile":"/opt/gdlists/sa1.json","folderId":"1Abc..."}]
// 兼容旧配置：GOOGLE_SERVICE_ACCOUNT_JSON + ROOT_FOLDER_ID（作为 id=default 的单源）

function normalizeSources(list) {
  const out = [];
  const seen = new Set();
  (Array.isArray(list) ? list : []).forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') return;
    const id = String(raw.id || `source${i}`).trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
      console.warn(`[Sources] 忽略数据源 #${i + 1}：id 只能包含字母/数字/下划线/短横线，且不超过 32 位`);
      return;
    }
    if (seen.has(id)) {
      console.warn(`[Sources] 忽略重复数据源 id: ${id}`);
      return;
    }
    seen.add(id);
    out.push({
      id,
      name: String(raw.name || `Drive ${i + 1}`),
      keyFile: raw.keyFile,
      folderId: String(raw.folderId || 'root'),
    });
  });
  return out;
}

let DRIVE_SOURCES = [];

(function loadSources() {
  if (process.env.DRIVE_SOURCES) {
    try {
      DRIVE_SOURCES = normalizeSources(JSON.parse(process.env.DRIVE_SOURCES));
      if (DRIVE_SOURCES.length > 0) {
        console.log(`[Sources] 已加载 ${DRIVE_SOURCES.length} 个 Drive 数据源`);
        return;
      }
      console.warn('[Sources] DRIVE_SOURCES 为空或格式不合法，回退到旧单源配置');
    } catch (e) {
      console.error('[Sources] 解析 DRIVE_SOURCES 失败（将回退旧单源配置）:', e.message);
    }
  }

  DRIVE_SOURCES = normalizeSources([{
    id: 'default',
    name: 'My Drive',
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    folderId: process.env.ROOT_FOLDER_ID || 'root',
  }]);
  console.log('[Sources] 使用单账号模式（兼容旧配置）');
})();

for (const source of DRIVE_SOURCES) {
  if (!source.keyFile) {
    console.error(`[Sources] "${source.name}" 未配置 Service Account JSON 路径（keyFile）`);
  } else if (!fs.existsSync(path.resolve(source.keyFile))) {
    console.error(`[Sources] 密钥文件不存在: ${source.keyFile}`);
  }
}
if (DRIVE_SOURCES.length === 0) {
  console.error('[Sources] 没有任何可用数据源，服务退出');
  process.exit(1);
}

// ─── Drive 客户端 ────────────────────────────────────────────────────────────
const _driveClients = new Map();

function getSource(sourceId) {
  const id = sourceId || DRIVE_SOURCES[0].id;
  return DRIVE_SOURCES.find(s => s.id === id) || null;
}

/** 从请求参数解析数据源；非法时返回 null */
function resolveSource(rawSourceId) {
  return getSource(typeof rawSourceId === 'string' && rawSourceId ? rawSourceId : DRIVE_SOURCES[0].id);
}

function getDriveClient(source) {
  if (_driveClients.has(source.id)) return _driveClients.get(source.id);
  if (!source.keyFile) throw new Error(`数据源 "${source.name}" 未配置 Service Account JSON 路径`);

  let credentials;
  try {
    credentials = JSON.parse(fs.readFileSync(path.resolve(source.keyFile), 'utf8'));
  } catch (e) {
    throw new Error(`无法读取 Service Account 密钥文件 (${source.name}): ${source.keyFile} — ${e.message}`);
  }
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error(`Service Account 密钥文件缺少 client_email / private_key (${source.name})`);
  }

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });

  // 元数据请求 30s 超时；媒体下载单独关闭超时（见 pipeDrive）
  const client = google.drive({ version: 'v3', auth, timeout: 30 * 1000 });
  _driveClients.set(source.id, client);
  return client;
}

async function getMeta(drive, fileId, fields = 'name,mimeType,size') {
  const res = await drive.files.get({ fileId, fields, supportsAllDrives: true });
  return res.data;
}

/**
 * 用 Drive 里文件夹的真实名称作为数据源显示名。
 * 取不到（无权限/网络异常）时保留 DRIVE_SOURCES 里的配置值。
 */
async function refreshSourceNames() {
  await Promise.all(DRIVE_SOURCES.map(async (source) => {
    try {
      const meta = await getMeta(getDriveClient(source), source.folderId, 'name');
      const name = String(meta.name || '').trim();
      if (name && name !== source.name) {
        console.log(`[Sources] ${source.id} 显示名: "${source.name}" -> "${name}"`);
        source.name = name;
      }
    } catch (e) {
      console.warn(`[Sources] 读取 "${source.name}" 的文件夹名称失败，沿用配置值: ${e.message}`);
    }
  }));
}

// ─── Token / 会话 ────────────────────────────────────────────────────────────
function signFileToken(fileId, sourceId) {
  const payload = { typ: 'file', id: fileId, sourceId };
  if (SHARE_TTL_MS > 0) payload.exp = Date.now() + SHARE_TTL_MS;
  return tokens.sign(payload);
}

function verifyFileToken(raw) {
  const payload = tokens.verify(raw);
  if (!payload || payload.typ !== 'file' || typeof payload.id !== 'string' || !payload.id) return null;
  return payload;
}

function getSession(req) {
  const raw = req.cookies && req.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const payload = tokens.verify(raw);
  if (!payload || payload.typ !== 'session' || typeof payload.u !== 'string') return null;
  return payload;
}

function issueSession(req, res, username) {
  res.cookie(SESSION_COOKIE, tokens.sign({
    typ: 'session',
    u: username,
    exp: Date.now() + SESSION_TTL_MS,
  }), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

function clearSession(req, res) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    path: '/',
  });
}

function requireLogin(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: '登录已过期，请重新登录' });
  req.user = session.u;
  next();
}

// ─── 文件缓存 ────────────────────────────────────────────────────────────────
const EXPORT_TYPES = {
  'application/vnd.google-apps.document': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.google-apps.spreadsheet': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.google-apps.presentation': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const cacheIndex = new Map(); // `${sourceId}:${fileId}` -> { path, name, mimeType, size, cachedAt }
const cacheJobs = new Map();  // `${sourceId}:${fileId}` -> { status, received, total, error, startedAt }

fs.mkdirSync(CACHE_DIR, { recursive: true });

const cacheKey = (sourceId, fileId) => `${sourceId}:${fileId}`;

function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function saveCacheIndex() {
  try {
    writeFileAtomic(CACHE_META_FILE, JSON.stringify(Object.fromEntries(cacheIndex), null, 2));
  } catch (e) {
    console.error('[Cache] 保存元数据失败:', e.message);
  }
}

function loadCacheIndex() {
  try {
    if (fs.existsSync(CACHE_META_FILE)) {
      const meta = JSON.parse(fs.readFileSync(CACHE_META_FILE, 'utf8'));
      for (const [key, info] of Object.entries(meta)) {
        if (info && typeof info.path === 'string' && fs.existsSync(info.path)) cacheIndex.set(key, info);
      }
    }
    console.log(`[Cache] 已加载 ${cacheIndex.size} 个缓存文件`);
  } catch (e) {
    console.error('[Cache] 加载元数据失败:', e.message);
  }
}

function removeCacheFile(info) {
  if (!info || !info.path) return;
  try {
    fs.rmSync(info.path, { force: true });
  } catch (e) {
    console.error('[Cache] 删除文件失败:', e.message);
  }
}

function totalCacheSize() {
  let total = 0;
  for (const info of cacheIndex.values()) total += Number(info.size) || 0;
  return total;
}

function cleanCache() {
  try {
    const now = Date.now();

    // 1. 清理条目：文件丢失 / 已过期
    for (const [key, info] of [...cacheIndex]) {
      if (!fs.existsSync(info.path)) {
        cacheIndex.delete(key);
        continue;
      }
      if (now - (Number(info.cachedAt) || 0) > CACHE_TTL) {
        removeCacheFile(info);
        cacheIndex.delete(key);
        console.log(`[Cache] 删除过期文件: ${info.name}`);
      }
    }

    // 2. 按容量淘汰最旧的（此处才统计体积，避免把已删文件算进去）
    let total = totalCacheSize();
    while (total > MAX_CACHE_SIZE && cacheIndex.size > 0) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [key, info] of cacheIndex) {
        const t = Number(info.cachedAt) || 0;
        if (t < oldestTime) { oldestTime = t; oldestKey = key; }
      }
      if (!oldestKey) break;
      const info = cacheIndex.get(oldestKey);
      total -= Number(info.size) || 0;
      removeCacheFile(info);
      cacheIndex.delete(oldestKey);
      console.log(`[Cache] 超出容量上限，删除: ${info.name}`);
    }

    // 3. 清理孤立文件与残留的 .part（只处理明确失效的）
    const referenced = new Set([...cacheIndex.values()].map(i => i.path));
    for (const name of fs.readdirSync(CACHE_DIR)) {
      const full = path.join(CACHE_DIR, name);
      if (full === CACHE_META_FILE || referenced.has(full)) continue;
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (!stat.isFile()) continue;
      const age = now - stat.mtimeMs;
      if (name.endsWith('.part') ? age > 6 * 60 * 60 * 1000 : age > 60 * 60 * 1000) {
        fs.rmSync(full, { force: true });
        console.log(`[Cache] 清理孤立文件: ${name}`);
      }
    }

    // 4. 清理过期的失败任务
    for (const [key, job] of [...cacheJobs]) {
      if (job.status !== 'running' && now - (job.finishedAt || job.startedAt) > 10 * 60 * 1000) {
        cacheJobs.delete(key);
      }
    }

    saveCacheIndex();
  } catch (e) {
    console.error('[Cache] 清理失败:', e.message);
  }
}

function cacheFlags(fileId, sourceId) {
  const key = cacheKey(sourceId, fileId);
  const info = cacheIndex.get(key);
  if (info) return { cached: true, cachePercent: 100 };
  const job = cacheJobs.get(key);
  if (job && job.status === 'running') {
    return {
      cached: false,
      cachePercent: job.total ? Math.min(99, Math.floor((job.received / job.total) * 100)) : null,
    };
  }
  return { cached: false, cachePercent: null };
}

function safeFileBase(name) {
  const cleaned = String(name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return encodeURIComponent((cleaned || 'file').slice(0, 60));
}

async function downloadToCache(source, fileId, job) {
  const drive = getDriveClient(source);
  const meta = await getMeta(drive, fileId);
  const name = meta.name || fileId;
  const mimeType = meta.mimeType || 'application/octet-stream';

  if (EXPORT_TYPES[mimeType]) {
    throw new Error('Google 原生文档不支持缓存，请先导出为 Office/PDF 格式');
  }

  const declaredSize = meta.size ? Number(meta.size) : 0;
  if (declaredSize > MAX_CACHE_SIZE) {
    throw new Error(`文件大小超过缓存上限 (${(MAX_CACHE_SIZE / 1024 ** 3).toFixed(1)} GB)`);
  }
  job.total = declaredSize;

  const hash = crypto.createHash('sha1').update(fileId).digest('hex').slice(0, 10);
  const finalPath = path.join(CACHE_DIR, `${source.id}_${hash}_${safeFileBase(name)}`);
  const tmpPath = `${finalPath}.part`;

  const upstream = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream', timeout: 0 }
  );

  let received = 0;
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmpPath);
      upstream.data.on('data', (chunk) => {
        received += chunk.length;
        job.received = received;
      });
      pipeline(upstream.data, out, (err) => (err ? reject(err) : resolve()));
    });

    if (declaredSize && received !== declaredSize) {
      console.warn(`[Cache] 大小不一致（声明 ${declaredSize}，实际 ${received}）: ${name}`);
    }
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    fs.rm(tmpPath, { force: true }, () => {});
    throw err;
  }

  const info = { path: finalPath, name, mimeType, size: received, cachedAt: Date.now() };
  cacheIndex.set(cacheKey(source.id, fileId), info);
  saveCacheIndex();
  console.log(`[Cache] 完成: ${name} (${(received / 1024 / 1024).toFixed(2)} MB)`);
  return info;
}

function startCacheJob(source, fileId) {
  const key = cacheKey(source.id, fileId);
  const info = cacheIndex.get(key);
  if (info && fs.existsSync(info.path)) return { started: false };
  const running = cacheJobs.get(key);
  if (running && running.status === 'running') return { started: false };

  const job = { status: 'running', received: 0, total: 0, error: null, startedAt: Date.now() };
  cacheJobs.set(key, job);
  console.log(`[Cache] 开始缓存: ${fileId} (${source.id})`);

  downloadToCache(source, fileId, job)
    .then(() => { cacheJobs.delete(key); })
    .catch((err) => {
      job.status = 'error';
      job.error = err.message;
      job.finishedAt = Date.now();
      console.error(`[Cache] 缓存失败 (${source.id}:${fileId}):`, err.message);
    });

  return { started: true };
}

function cacheStatus(source, fileId) {
  const key = cacheKey(source.id, fileId);
  const info = cacheIndex.get(key);
  if (info && fs.existsSync(info.path)) {
    return { cached: true, status: 'done', size: info.size, cachedAt: info.cachedAt, percent: 100 };
  }
  const job = cacheJobs.get(key);
  if (!job) return { cached: false, status: 'idle', percent: null };
  const percent = job.total ? Math.min(100, Math.round((job.received / job.total) * 100)) : null;
  return {
    cached: false,
    status: job.status,
    received: job.received,
    total: job.total || null,
    percent,
    error: job.error,
  };
}

// ─── 流式转发 ────────────────────────────────────────────────────────────────
function contentDisposition(type, filename) {
  const name = String(filename || 'file');
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file';
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function pipeToResponse(upstream, res, label) {
  pipeline(upstream, res, (err) => {
    if (!err) return;
    if (err.code === 'ERR_STREAM_PREMATURE_CLOSE' || err.code === 'EPIPE') return; // 客户端主动断开
    console.error(`[Stream] ${label} 传输中断:`, err.message);
  });
}

async function pipeDrive(req, res, { fileId, source, disposition }) {
  const drive = getDriveClient(source);
  const meta = await getMeta(drive, fileId);

  const name = meta.name || fileId;
  const isExport = !!EXPORT_TYPES[meta.mimeType];
  const mimeType = isExport ? EXPORT_TYPES[meta.mimeType] : (meta.mimeType || 'application/octet-stream');
  const size = !isExport && meta.size ? Number(meta.size) : null;

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', contentDisposition(disposition, name));
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  if (size) res.setHeader('Accept-Ranges', 'bytes');

  let range = null;
  if (size) {
    range = parseRange(req.headers.range, size);
    if (range === 'invalid') {
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.status(416).json({ error: '请求的 Range 无效' });
    }
  }

  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    res.setHeader('Content-Length', range.end - range.start + 1);
  } else if (size) {
    res.setHeader('Content-Length', size);
  }

  const options = { responseType: 'stream', timeout: 0 };
  if (range) options.headers = { Range: `bytes=${range.start}-${range.end}` };

  const upstream = isExport
    ? await drive.files.export({ fileId, mimeType }, { responseType: 'stream', timeout: 0 })
    : await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, options);

  pipeToResponse(upstream.data, res, `${disposition} ${fileId}`);
}

function sendDriveError(res, err) {
  const rawCode = err && (err.code || (err.response && err.response.status));
  const code = Number(rawCode);
  const status = code === 404 ? 404 : (code === 403 ? 403 : 502);
  const message = status === 404
    ? '文件不存在或无权访问'
    : status === 403
      ? '无权访问该文件'
      : `读取文件失败: ${err && err.message ? err.message : '未知错误'}`;
  console.error(`[Drive] ${message}`);
  if (!res.headersSent) res.status(status).json({ error: message });
  else res.end();
}

function baseUrl(req) {
  return PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

// ─── Express 应用 ────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.sheetjs.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob: https://cdnjs.cloudflare.com",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(cookieParser());

// ─── 页面 ────────────────────────────────────────────────────────────────────
let indexHtml = null;

function renderIndex() {
  if (indexHtml) return indexHtml;
  const template = fs.readFileSync(INDEX_PATH, 'utf8');
  const sourcesJson = JSON.stringify(DRIVE_SOURCES.map(s => ({ id: s.id, name: s.name })));
  indexHtml = template
    .replace(/var APP_VERSION = '[^']*';/, `var APP_VERSION = '${APP_VERSION}';`)
    .replace(/var DRIVE_SOURCES = \[\];/, `var DRIVE_SOURCES = ${sourcesJson};`);
  return indexHtml;
}

function serveIndex(req, res) {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(renderIndex());
  } catch (e) {
    console.error('[Index] 读取模板失败:', e.message);
    res.status(500).type('text').send('页面加载失败');
  }
}

app.get('/', serveIndex);
app.get('/index.html', serveIndex);

// ─── 登录限流 ────────────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  message: { error: '登录尝试过于频繁，请 15 分钟后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── 认证 ────────────────────────────────────────────────────────────────────
app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const validUser = process.env.ADMIN_USERNAME || 'admin';
  const validHash = process.env.ADMIN_PASSWORD_HASH;

  if (!validHash) return res.status(500).json({ error: '服务未配置（缺少 ADMIN_PASSWORD_HASH）' });
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error: '请输入用户名和密码' });
  }

  let passOk = false;
  try {
    passOk = await bcrypt.compare(password, validHash);
  } catch {
    passOk = false;
  }

  if (username === validUser && passOk) {
    issueSession(req, res, username); // 登录即签发新 cookie，避免会话固定
    return res.json({ ok: true, username });
  }
  res.status(401).json({ error: '用户名或密码错误' });
});

app.post('/api/logout', (req, res) => {
  clearSession(req, res);
  res.json({ ok: true });
});

app.get('/api/auth', (req, res) => {
  const session = getSession(req);
  res.json({ authenticated: !!session, username: session ? session.u : null });
});

// ─── 健康检查（无需登录，不含敏感信息）───────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: APP_VERSION,
    uptime: Math.round(process.uptime()),
    sources: DRIVE_SOURCES.length,
    cache: { files: cacheIndex.size, bytes: totalCacheSize() },
    activeJobs: [...cacheJobs.values()].filter(j => j.status === 'running').length,
  });
});

// ─── 数据源 ──────────────────────────────────────────────────────────────────
app.get('/api/sources', requireLogin, (req, res) => {
  // 只暴露 id / name，不下发 folderId
  res.json({ sources: DRIVE_SOURCES.map(s => ({ id: s.id, name: s.name })) });
});

// ─── 文件列表 ────────────────────────────────────────────────────────────────
app.get('/api/files', requireLogin, async (req, res) => {
  const source = resolveSource(req.query.sourceId);
  if (!source) return res.status(400).json({ error: '数据源不存在' });

  const folderId = String(req.query.folderId || source.folderId).replace(/[^A-Za-z0-9_-]/g, '') || source.folderId;

  try {
    const drive = getDriveClient(source);
    const files = [];
    let pageToken;
    let truncated = false;

    do {
      const response = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id,name,mimeType,size,modifiedTime,parents)',
        orderBy: 'folder,name',
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      for (const file of response.data.files || []) {
        if (files.length >= FILE_LIST_LIMIT) { truncated = true; break; }
        files.push({ ...file, ...cacheFlags(file.id, source.id) });
      }

      pageToken = response.data.nextPageToken;
    } while (pageToken && !truncated);

    if (truncated) console.warn(`[Drive] 文件夹 ${folderId} 文件数超过 ${FILE_LIST_LIMIT}，已截断`);
    res.json({ files, sourceId: source.id, truncated, limit: FILE_LIST_LIMIT });
  } catch (err) {
    sendDriveError(res, err);
  }
});

// ─── 面包屑 ──────────────────────────────────────────────────────────────────
app.get('/api/path', requireLogin, async (req, res) => {
  const source = resolveSource(req.query.sourceId);
  if (!source) return res.status(400).json({ error: '数据源不存在' });

  const rootId = source.folderId;
  const folderId = String(req.query.folderId || rootId).replace(/[^A-Za-z0-9_-]/g, '') || rootId;

  try {
    const drive = getDriveClient(source);
    const chain = [];
    let current = folderId;
    let depth = 0;

    while (current && current !== rootId && depth < 50) {
      const meta = await getMeta(drive, current, 'id,name,parents');
      chain.unshift({ id: meta.id, name: meta.name });
      current = meta.parents && meta.parents[0];
      depth += 1;
    }

    let rootName;
    if (rootId === 'root') {
      rootName = source.name;
    } else {
      try {
        rootName = (await getMeta(drive, rootId, 'name')).name;
      } catch {
        rootName = source.name;
      }
    }
    chain.unshift({ id: rootId, name: rootName });

    res.json({ path: chain });
  } catch (err) {
    sendDriveError(res, err);
  }
});

// ─── 分享链接 ────────────────────────────────────────────────────────────────
app.get('/api/link/:fileId', requireLogin, async (req, res) => {
  const source = resolveSource(req.query.sourceId);
  if (!source) return res.status(400).json({ error: '数据源不存在' });

  try {
    const drive = getDriveClient(source);
    const meta = await getMeta(drive, req.params.fileId, 'name,size,mimeType');
    res.json({
      url: `${baseUrl(req)}/dl/${signFileToken(req.params.fileId, source.id)}`,
      name: meta.name,
      size: meta.size || 0,
      mimeType: meta.mimeType,
    });
  } catch (err) {
    sendDriveError(res, err);
  }
});

// ─── 缓存：启动任务（不阻塞请求）─────────────────────────────────────────────
function handleStartCache(req, res) {
  const source = resolveSource(req.query.sourceId);
  if (!source) return res.status(400).json({ error: '数据源不存在' });

  try {
    const { started } = startCacheJob(source, req.params.fileId);
    res.json({ ok: true, started, ...cacheStatus(source, req.params.fileId) });
  } catch (err) {
    res.status(500).json({ error: `缓存失败: ${err.message}` });
  }
}

app.post('/api/cache/:fileId', requireLogin, handleStartCache);
app.get('/api/cache/:fileId', requireLogin, handleStartCache);  // 兼容旧前端（返回任务状态）
app.get('/api/share/:fileId', requireLogin, handleStartCache);  // 旧接口：同样触发后台缓存任务

app.get('/api/cache-status/:fileId', requireLogin, (req, res) => {
  const source = resolveSource(req.query.sourceId);
  if (!source) return res.status(400).json({ error: '数据源不存在' });
  res.json(cacheStatus(source, req.params.fileId));
});

// ─── 预览 ────────────────────────────────────────────────────────────────────
app.get('/api/preview/:fileId', requireLogin, async (req, res) => {
  const source = resolveSource(req.query.sourceId);
  if (!source) return res.status(400).json({ error: '数据源不存在' });

  try {
    const drive = getDriveClient(source);
    const meta = await getMeta(drive, req.params.fileId, 'name,size,mimeType');
    const token = signFileToken(req.params.fileId, source.id);
    res.json({
      token,
      url: `${baseUrl(req)}/pv2/${token}`,
      name: meta.name,
      size: Number(meta.size) || 0,
      mimeType: meta.mimeType,
    });
  } catch (err) {
    sendDriveError(res, err);
  }
});

// Office / Google 文档预览数据（Google 原生格式自动导出为 Office 格式）
app.get('/api/preview-data/:fileId', requireLogin, async (req, res) => {
  const source = resolveSource(req.query.sourceId);
  if (!source) return res.status(400).json({ error: '数据源不存在' });

  try {
    await pipeDrive(req, res, { fileId: req.params.fileId, source, disposition: 'inline' });
  } catch (err) {
    sendDriveError(res, err);
  }
});

// ─── 公共访问（签名 token）───────────────────────────────────────────────────
function resolvePublicRequest(req, res) {
  const payload = verifyFileToken(req.params.token);
  if (!payload) {
    res.status(400).json({ error: '链接无效或已过期' });
    return null;
  }
  const source = getSource(payload.sourceId);
  if (!source) {
    res.status(400).json({ error: '链接对应的数据源不存在' });
    return null;
  }
  return { payload, source };
}

app.get('/pv2/:token', async (req, res) => {
  const ctx = resolvePublicRequest(req, res);
  if (!ctx) return;
  try {
    await pipeDrive(req, res, { fileId: ctx.payload.id, source: ctx.source, disposition: 'inline' });
  } catch (err) {
    sendDriveError(res, err);
  }
});

app.get('/dl/:token', async (req, res) => {
  const ctx = resolvePublicRequest(req, res);
  if (!ctx) return;
  try {
    await pipeDrive(req, res, { fileId: ctx.payload.id, source: ctx.source, disposition: 'attachment' });
  } catch (err) {
    sendDriveError(res, err);
  }
});

app.get('/cache/:token', async (req, res) => {
  const ctx = resolvePublicRequest(req, res);
  if (!ctx) return;

  const info = cacheIndex.get(cacheKey(ctx.source.id, ctx.payload.id));
  if (info && fs.existsSync(info.path)) {
    res.setHeader('Content-Type', info.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition('attachment', info.name));
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    return res.sendFile(info.path, (err) => {
      if (!err) return;
      console.error('[Cache] 发送本地文件失败:', err.message);
      if (!res.headersSent) res.status(500).end();
    });
  }

  console.log(`[Cache] 缓存已失效，回退直连: ${ctx.payload.id} (${ctx.source.id})`);
  try {
    await pipeDrive(req, res, { fileId: ctx.payload.id, source: ctx.source, disposition: 'attachment' });
  } catch (err) {
    sendDriveError(res, err);
  }
});

// ─── 静态资源与兜底 ──────────────────────────────────────────────────────────
app.use(express.static(path.join(BASE_PATH, 'public'), { index: false }));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: '接口不存在' });
  serveIndex(req, res);
});

// ─── 启动与退出 ──────────────────────────────────────────────────────────────
loadCacheIndex();
cleanCache();
const cacheTimer = setInterval(cleanCache, CACHE_CLEAN_INTERVAL);

// 文件夹可能在 Drive 里被改名：每 6 小时重新同步一次数据源显示名
const nameTimer = setInterval(() => {
  refreshSourceNames().catch((e) => console.warn('[Sources] 同步文件夹名称失败:', e.message));
}, 6 * 60 * 60 * 1000);
nameTimer.unref();

let server;

(async () => {
  // 启动时先读取真实文件夹名（最多等 8 秒；失败不影响启动，沿用配置名）
  await Promise.race([
    refreshSourceNames(),
    new Promise((resolve) => setTimeout(resolve, 8000)),
  ]).catch((e) => console.warn('[Sources] 同步文件夹名称失败:', e.message));

  server = app.listen(PORT, () => {
    console.log(`GDlists running on http://localhost:${PORT} (version ${APP_VERSION})`);
    console.log(`已配置 ${DRIVE_SOURCES.length} 个数据源: ${DRIVE_SOURCES.map(s => s.name).join(', ')}`);
    console.log(`缓存目录: ${CACHE_DIR}（上限 ${(MAX_CACHE_SIZE / 1024 ** 3).toFixed(1)} GB，保留 ${Math.round(CACHE_TTL / 86400000)} 天）`);
  });
})();

function shutdown(signal) {
  console.log(`[App] 收到 ${signal}，正在关闭…`);
  clearInterval(cacheTimer);
  clearInterval(nameTimer);
  saveCacheIndex();
  if (server) server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('[Fatal] 未处理的 Promise 拒绝:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Fatal] 未捕获异常:', err);
  process.exit(1);
});
