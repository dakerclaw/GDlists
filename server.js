'use strict';

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ─── App Version (Cache Busting) ─────────────────────────────────────────────
const APP_VERSION = '20260517';

// ─── Multi-source Drive config ────────────────────────────────────────────────
//
// DRIVE_SOURCES 格式（JSON 数组，写在 .env 中）：
//   DRIVE_SOURCES=[{"id":"work","name":"工作盘","keyFile":"/opt/gdlists/sa1.json","folderId":"1Abc..."},{"id":"personal","name":"个人盘","keyFile":"/opt/gdlists/sa2.json","folderId":"1Xyz..."}]
//
// 兼容旧配置（GOOGLE_SERVICE_ACCOUNT_JSON + ROOT_FOLDER_ID）：
//   如果没有 DRIVE_SOURCES，自动使用旧配置作为 id="default" 的单源
//
let DRIVE_SOURCES = [];

(function loadSources() {
  if (process.env.DRIVE_SOURCES) {
    try {
      const parsed = JSON.parse(process.env.DRIVE_SOURCES);
      if (Array.isArray(parsed) && parsed.length > 0) {
        DRIVE_SOURCES = parsed.map((s, i) => ({
          id: s.id || `source${i}`,
          name: s.name || `Drive ${i + 1}`,
          keyFile: s.keyFile,
          folderId: s.folderId || 'root'
        }));
        console.log(`[Sources] 已加载 ${DRIVE_SOURCES.length} 个 Drive 数据源`);
        return;
      }
    } catch (e) {
      console.error('[Sources] 解析 DRIVE_SOURCES 失败:', e.message);
    }
  }
  // 兼容旧单账号配置
  DRIVE_SOURCES = [{
    id: 'default',
    name: 'My Drive',
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    folderId: process.env.ROOT_FOLDER_ID || 'root'
  }];
  console.log('[Sources] 使用单账号模式（兼容旧配置）');
})();

// ─── Drive Client Pool ────────────────────────────────────────────────────────
const _driveClients = new Map();

function getDriveClient(sourceId) {
  const sourceIdStr = sourceId || DRIVE_SOURCES[0].id;
  if (_driveClients.has(sourceIdStr)) return _driveClients.get(sourceIdStr);

  const source = DRIVE_SOURCES.find(s => s.id === sourceIdStr);
  if (!source) throw new Error(`数据源 "${sourceIdStr}" 不存在`);
  if (!source.keyFile) throw new Error(`数据源 "${source.name}" 未配置 Service Account JSON 路径`);

  let credentials;
  try {
    credentials = require(path.resolve(source.keyFile));
  } catch (e) {
    throw new Error(`无法读取 Service Account 密钥文件 (${source.name}): ${source.keyFile}，错误: ${e.message}`);
  }

  const auth = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    ['https://www.googleapis.com/auth/drive']
  );

  const driveClient = google.drive({ version: 'v3', auth, timeout: 30 * 1000 });
  _driveClients.set(sourceIdStr, driveClient);
  return driveClient;
}

function getSourceRootFolder(sourceId) {
  const source = DRIVE_SOURCES.find(s => s.id === (sourceId || DRIVE_SOURCES[0].id));
  return source ? source.folderId : 'root';
}

// ─── File Cache ────────────────────────────────────────────────────────────────
const CACHE_DIR = path.join(__dirname, 'cache');
const CACHE_META_FILE = path.join(CACHE_DIR, 'meta.json');
const MAX_CACHE_SIZE = 5 * 1024 * 1024 * 1024; // 5 GB
const CACHE_TTL = 100 * 24 * 60 * 60 * 1000; // 100 天

// 确保缓存目录存在
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// 缓存索引：`${sourceId}:${fileId}` -> { path, name, size, mimeType, cachedAt }
const cacheIndex = new Map();

function loadCacheIndex() {
  try {
    if (fs.existsSync(CACHE_META_FILE)) {
      const meta = JSON.parse(fs.readFileSync(CACHE_META_FILE, 'utf8'));
      for (const [key, info] of Object.entries(meta)) {
        if (fs.existsSync(info.path)) {
          cacheIndex.set(key, info);
        }
      }
    }
    console.log(`[Cache] 已加载 ${cacheIndex.size} 个缓存文件`);
  } catch (e) {
    console.error('[Cache] 加载元数据失败:', e.message);
  }
}

function saveCacheIndex() {
  try {
    const obj = Object.fromEntries(cacheIndex);
    fs.writeFileSync(CACHE_META_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('[Cache] 保存元数据失败:', e.message);
  }
}

function cleanCache() {
  try {
    const now = Date.now();
    let totalSize = 0;
    const toDelete = [];

    for (const [key, info] of cacheIndex) {
      totalSize += info.size;
      if (now - info.cachedAt > CACHE_TTL) {
        toDelete.push(key);
      }
    }

    for (const key of toDelete) {
      const info = cacheIndex.get(key);
      if (fs.existsSync(info.path)) fs.unlinkSync(info.path);
      cacheIndex.delete(key);
      console.log(`[Cache] 删除过期文件: ${info.name}`);
    }
    saveCacheIndex();

    while (totalSize > MAX_CACHE_SIZE && cacheIndex.size > 0) {
      let oldest = null;
      let oldestTime = Infinity;
      for (const [key, info] of cacheIndex) {
        if (info.cachedAt < oldestTime) {
          oldestTime = info.cachedAt;
          oldest = key;
        }
      }
      if (oldest) {
        const info = cacheIndex.get(oldest);
        totalSize -= info.size;
        if (fs.existsSync(info.path)) fs.unlinkSync(info.path);
        cacheIndex.delete(oldest);
        console.log(`[Cache] 清理空间，删除: ${info.name}`);
      }
    }
    saveCacheIndex();
  } catch (e) {
    console.error('[Cache] 清理失败:', e.message);
  }
}

async function cacheFile(sourceId, fileId) {
  const cacheKey = `${sourceId}:${fileId}`;
  if (cacheIndex.has(cacheKey)) return cacheIndex.get(cacheKey);

  const drive = getDriveClient(sourceId);
  const meta = await drive.files.get({ fileId, fields: 'name,mimeType,size' });
  const { name, mimeType } = meta.data;
  const safeName = name.replace(/[<>:"/\\|?*]/g, '_');
  const cachedFileName = `${sourceId}_${fileId}_${encodeURIComponent(safeName)}`;
  const cachedPath = path.join(CACHE_DIR, cachedFileName);

  console.log(`[Cache] 下载中: ${name} (${sourceId})`);

  const response = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );

  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(cachedPath);
    let size = 0;
    response.data.on('data', (chunk) => { size += chunk.length; });
    response.data.pipe(writeStream);
    writeStream.on('finish', () => {
      const info = { path: cachedPath, name, mimeType, size, cachedAt: Date.now() };
      cacheIndex.set(cacheKey, info);
      saveCacheIndex();
      console.log(`[Cache] 完成: ${name} (${(size / 1024 / 1024).toFixed(2)} MB)`);
      resolve(info);
    });
    writeStream.on('error', reject);
    response.data.on('error', reject);
  });
}

// ─── Preview Stream (直接流式，不缓存) ────────────────────────────────────
// token 中包含 sourceId（可选，默认第一个源）
app.get('/pv2/:token', async (req, res) => {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(req.params.token, 'base64url').toString());
  } catch {
    return res.status(400).json({ error: 'Invalid token' });
  }

  const { id: fileId, sourceId } = payload;

  try {
    const drive = getDriveClient(sourceId);
    const meta = await drive.files.get({ fileId, fields: 'name,mimeType,size' });
    const { name, mimeType, size } = meta.data;

    res.setHeader('Content-Type', mimeType || 'application/pdf');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);

    const range = req.headers['range'];
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : size - 1;
      const chunkSize = end - start + 1;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', chunkSize);
      res.status(206);
      const dlRes = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream', headers: { Range: `bytes=${start}-${end}` } }
      );
      dlRes.data.pipe(res);
    } else {
      const dlRes = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream' }
      );
      dlRes.data.pipe(res);
    }
  } catch (err) {
    console.error('[Preview] 流式预览失败:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── Security: Login Rate Limiter ────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: '登录尝试过于频繁，请 15 分钟后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Middleware ────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
}));

// 根路径：注入版本号 + 多源配置（仅暴露 id/name，不暴露密钥路径）
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(htmlPath, 'utf8', (err, content) => {
    if (err) return res.status(500).send('Error loading index');
    const sourcesForClient = JSON.stringify(
      DRIVE_SOURCES.map(s => ({ id: s.id, name: s.name }))
    );
    let updated = content.replace(
      /var APP_VERSION = '[^']*';/,
      `var APP_VERSION = '${APP_VERSION}';`
    );
    updated = updated.replace(
      /var DRIVE_SOURCES = \[\];/,
      `var DRIVE_SOURCES = ${sourcesForClient};`
    );
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.type('html').send(updated);
  });
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Auth Guard ───────────────────────────────────────────────────────────
function requireLogin(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ─── Routes ───────────────────────────────────────────────────────────────

// GET /api/sources — 返回可用数据源列表
app.get('/api/sources', requireLogin, (req, res) => {
  res.json({
    sources: DRIVE_SOURCES.map(s => ({ id: s.id, name: s.name, folderId: s.folderId }))
  });
});

// Login
app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  const validUser = process.env.ADMIN_USERNAME || 'admin';
  const validHash = process.env.ADMIN_PASSWORD_HASH;
  if (!validHash) {
    return res.status(500).json({ error: 'Server not configured (missing ADMIN_PASSWORD_HASH)' });
  }
  const userOk = username === validUser;
  const passOk = await bcrypt.compare(password, validHash);
  if (userOk && passOk) {
    req.session.authenticated = true;
    req.session.username = username;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Invalid username or password' });
});

// Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Auth status
app.get('/api/auth', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// List files in a folder
// GET /api/files?folderId=xxx&sourceId=yyy
app.get('/api/files', requireLogin, async (req, res) => {
  const sourceId = req.query.sourceId || DRIVE_SOURCES[0].id;
  const rootFolderId = getSourceRootFolder(sourceId);
  const folderId = req.query.folderId || rootFolderId;

  try {
    const drive = getDriveClient(sourceId);
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id,name,mimeType,size,modifiedTime,parents)',
      orderBy: 'folder,name',
      pageSize: 1000
    });
    res.json({ files: response.data.files || [], sourceId });
  } catch (err) {
    console.error('[Drive] 文件列表错误:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get folder breadcrumb path
// GET /api/path?folderId=xxx&sourceId=yyy
app.get('/api/path', requireLogin, async (req, res) => {
  const sourceId = req.query.sourceId || DRIVE_SOURCES[0].id;
  const rootFolderId = getSourceRootFolder(sourceId);
  const folderId = req.query.folderId || rootFolderId;

  if (folderId === rootFolderId) {
    try {
      const drive = getDriveClient(sourceId);
      if (rootFolderId === 'root') {
        const srcName = DRIVE_SOURCES.find(s => s.id === sourceId)?.name || 'My Drive';
        return res.json({ path: [{ id: rootFolderId, name: srcName }] });
      }
      const meta = await drive.files.get({ fileId: rootFolderId, fields: 'id,name' });
      return res.json({ path: [{ id: rootFolderId, name: meta.data.name }] });
    } catch {
      return res.json({ path: [{ id: rootFolderId, name: 'My Drive' }] });
    }
  }

  try {
    const drive = getDriveClient(sourceId);
    const chain = [];
    let current = folderId;
    while (current && current !== rootFolderId) {
      const meta = await drive.files.get({ fileId: current, fields: 'id,name,parents' });
      chain.unshift({ id: meta.data.id, name: meta.data.name });
      current = meta.data.parents ? meta.data.parents[0] : null;
    }
    try {
      const srcName = DRIVE_SOURCES.find(s => s.id === sourceId)?.name || 'My Drive';
      const rootName = rootFolderId === 'root' ? srcName
        : (await drive.files.get({ fileId: rootFolderId, fields: 'name' })).data.name;
      chain.unshift({ id: rootFolderId, name: rootName });
    } catch {
      chain.unshift({ id: rootFolderId, name: 'My Drive' });
    }
    res.json({ path: chain });
  } catch (err) {
    console.error('[Drive] 路径错误:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generate a direct share link
// GET /api/link/:fileId?sourceId=yyy
app.get('/api/link/:fileId', requireLogin, async (req, res) => {
  const { fileId } = req.params;
  const sourceId = req.query.sourceId || DRIVE_SOURCES[0].id;
  try {
    const drive = getDriveClient(sourceId);
    const meta = await drive.files.get({ fileId, fields: 'name,size' });
    const token = Buffer.from(JSON.stringify({ id: fileId, sourceId })).toString('base64url');
    const host = `${req.protocol}://${req.get('host')}`;
    res.json({ url: `${host}/dl/${token}`, name: meta.data.name, size: meta.data.size });
  } catch (err) {
    console.error('[Link] 生成链接失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Cache file to server
// GET /api/cache/:fileId?sourceId=yyy
app.get('/api/cache/:fileId', requireLogin, async (req, res) => {
  const { fileId } = req.params;
  const sourceId = req.query.sourceId || DRIVE_SOURCES[0].id;
  try {
    const info = await cacheFile(sourceId, fileId);
    const token = Buffer.from(JSON.stringify({ fileId, sourceId, name: info.name, cached: true })).toString('base64url');
    const host = `${req.protocol}://${req.get('host')}`;
    res.json({
      status: 'cached',
      url: `${host}/cache/${token}`,
      name: info.name,
      size: info.size,
      message: `缓存完成 (${(info.size / 1024 / 1024).toFixed(2)} MB)`
    });
  } catch (err) {
    console.error('[Cache] 缓存失败:', err.message);
    res.status(500).json({ status: 'error', error: '缓存失败: ' + err.message });
  }
});

// Cache status
// GET /api/cache-status/:fileId?sourceId=yyy
app.get('/api/cache-status/:fileId', requireLogin, (req, res) => {
  const { fileId } = req.params;
  const sourceId = req.query.sourceId || DRIVE_SOURCES[0].id;
  const cacheKey = `${sourceId}:${fileId}`;
  if (cacheIndex.has(cacheKey)) {
    const info = cacheIndex.get(cacheKey);
    res.json({ cached: true, size: info.size, cachedAt: info.cachedAt });
  } else {
    res.json({ cached: false });
  }
});

// Share (legacy, keeps backward compat)
// GET /api/share/:fileId?sourceId=yyy
app.get('/api/share/:fileId', requireLogin, async (req, res) => {
  const { fileId } = req.params;
  const sourceId = req.query.sourceId || DRIVE_SOURCES[0].id;
  const cacheKey = `${sourceId}:${fileId}`;

  if (cacheIndex.has(cacheKey)) {
    const info = cacheIndex.get(cacheKey);
    const token = Buffer.from(JSON.stringify({ fileId, sourceId, name: info.name, cached: true })).toString('base64url');
    const host = `${req.protocol}://${req.get('host')}`;
    return res.json({
      status: 'cached',
      url: `${host}/cache/${token}`,
      name: info.name,
      size: info.size,
      message: '文件已在缓存中，可直接下载'
    });
  }

  try {
    const info = await cacheFile(sourceId, fileId);
    const token = Buffer.from(JSON.stringify({ fileId, sourceId, name: info.name, cached: true })).toString('base64url');
    const host = `${req.protocol}://${req.get('host')}`;
    res.json({
      status: 'cached',
      url: `${host}/cache/${token}`,
      name: info.name,
      size: info.size,
      message: `文件已缓存 (${(info.size / 1024 / 1024).toFixed(2)} MB)`
    });
  } catch (err) {
    console.error('[Cache] 缓存失败:', err.message);
    res.status(500).json({ status: 'error', error: '文件缓存失败: ' + err.message });
  }
});

// Serve cached file
app.get('/cache/:token', async (req, res) => {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(req.params.token, 'base64url').toString());
  } catch {
    return res.status(400).send('Invalid token');
  }

  const { fileId, sourceId: payloadSourceId } = payload;
  const sourceId = payloadSourceId || DRIVE_SOURCES[0].id;
  const cacheKey = `${sourceId}:${fileId}`;

  if (cacheIndex.has(cacheKey)) {
    const info = cacheIndex.get(cacheKey);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(info.name)}`);
    res.setHeader('Content-Type', info.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', info.size);
    return res.sendFile(info.path);
  }

  // 缓存已失效 → 自动回退到直连 Drive
  console.log(`[Cache] 缓存已失效，回退直链: ${fileId} (${sourceId})`);
  try {
    const drive = getDriveClient(sourceId);
    const meta = await drive.files.get({ fileId, fields: 'name,mimeType,size' });
    const { name: fileName, mimeType, size } = meta.data;
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader('Content-Type', mimeType || 'application/octet-stream');
    if (size) res.setHeader('Content-Length', size);
    const dlRes = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
    dlRes.data.pipe(res);
  } catch (err) {
    console.error('[Cache] 回退直链失败:', err.message);
    if (!res.headersSent) res.status(502).send('文件下载失败，请重新获取链接');
  }
});

// Generate preview token
// GET /api/preview/:fileId?sourceId=yyy
app.get('/api/preview/:fileId', requireLogin, (req, res) => {
  const { fileId } = req.params;
  const sourceId = req.query.sourceId || DRIVE_SOURCES[0].id;
  const token = Buffer.from(JSON.stringify({ id: fileId, sourceId })).toString('base64url');
  const host = `${req.protocol}://${req.get('host')}`;
  getDriveClient(sourceId).files.get({ fileId, fields: 'name,size' })
    .then(({ data }) => {
      res.json({ token, url: `${host}/pv2/${token}`, name: data.name, size: data.size || 0 });
    })
    .catch(() => {
      res.json({ token, url: `${host}/pv2/${token}`, name: '', size: 0 });
    });
});

// Public inline preview (legacy /pv/)
app.get('/pv/:token', async (req, res) => {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(req.params.token, 'base64url').toString());
  } catch {
    return res.status(400).send('Invalid token');
  }
  const sourceId = payload.sourceId || DRIVE_SOURCES[0].id;
  try {
    const drive = getDriveClient(sourceId);
    const meta = await drive.files.get({ fileId: payload.id, fields: 'name,mimeType,size' });
    const { name, mimeType } = meta.data;
    const disposition = mimeType.startsWith('text/')
      || mimeType === 'application/json'
      || mimeType.startsWith('image/')
      || mimeType === 'application/pdf'
      || mimeType.startsWith('video/')
      || mimeType.startsWith('audio/')
      ? 'inline' : 'attachment';
    res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Content-Type', mimeType || 'application/octet-stream');
    const stream = await drive.files.get({ fileId: payload.id, alt: 'media' }, { responseType: 'stream' });
    stream.data.pipe(res);
  } catch (err) {
    console.error('[Drive] 预览错误:', err.message);
    res.status(500).send('Preview failed: ' + err.message);
  }
});

// Binary preview data
// GET /api/preview-data/:fileId?sourceId=yyy
app.get('/api/preview-data/:fileId', requireLogin, async (req, res) => {
  const { fileId } = req.params;
  const sourceId = req.query.sourceId || DRIVE_SOURCES[0].id;
  try {
    const drive = getDriveClient(sourceId);
    const meta = await drive.files.get({ fileId, fields: 'name,mimeType,size' });
    const { name, mimeType } = meta.data;
    const EXPORT_TYPES = {
      'application/vnd.google-apps.document': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.google-apps.spreadsheet': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.google-apps.presentation': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    const exportMime = EXPORT_TYPES[mimeType];
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Content-Type', exportMime || mimeType);
    const stream = exportMime
      ? await drive.files.export({ fileId, mimeType: exportMime }, { responseType: 'stream' })
      : await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
    stream.data.pipe(res);
  } catch (err) {
    console.error('[Drive] preview-data error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Public download endpoint
app.get('/dl/:token', async (req, res) => {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(req.params.token, 'base64url').toString());
  } catch {
    return res.status(400).send('Invalid link');
  }
  const sourceId = payload.sourceId || DRIVE_SOURCES[0].id;
  try {
    const drive = getDriveClient(sourceId);
    const meta = await drive.files.get({ fileId: payload.id, fields: 'name,mimeType,size' });
    const { name, mimeType } = meta.data;
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Content-Type', mimeType || 'application/octet-stream');
    const stream = await drive.files.get({ fileId: payload.id, alt: 'media' }, { responseType: 'stream' });
    stream.data.pipe(res);
  } catch (err) {
    console.error('[Drive] 下载错误:', err.message);
    res.status(500).send('Download failed: ' + err.message);
  }
});

// Fallback → SPA index
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Init & Start ─────────────────────────────────────────────────────────────
loadCacheIndex();
setInterval(cleanCache, 6 * 60 * 60 * 1000); // 每 6 小时清理一次

app.listen(PORT, () => {
  console.log(`GDlists running on http://localhost:${PORT}`);
  console.log(`已配置 ${DRIVE_SOURCES.length} 个数据源: ${DRIVE_SOURCES.map(s => s.name).join(', ')}`);
});
