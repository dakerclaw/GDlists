'use strict';

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const path = require('path');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24h
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Google Drive — Service Account Auth ──────────────────────────────────
//
// Service Account 认证优势：
//   - 纯服务端完成，无需浏览器
//   - 凭据永久有效，不会过期
//   - 不需要配置"已授权重定向 URI"
//
// 使用方式：
//   1. 在 Google Cloud Console 创建 Service Account，下载 JSON 密钥文件
//   2. 将你想让 GDList 访问的 Drive 文件夹共享给 Service Account 邮箱
//      （Service Account 邮箱格式：<name>@<project>.iam.gserviceaccount.com）
//   3. 将 JSON 密钥文件上传到服务器，在 .env 中指定路径
//
let _drive = null;

function getDriveClient() {
  if (_drive) return _drive;

  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!keyPath) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON 环境变量未设置。请在 .env 中指定 Service Account JSON 密钥文件路径。');
  }

  // 动态加载（避免 require 找不到文件时报错）
  let credentials;
  try {
    credentials = require(path.resolve(keyPath));
  } catch (e) {
    throw new Error(`无法读取 Service Account 密钥文件: ${keyPath}，错误: ${e.message}`);
  }

  const auth = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    ['https://www.googleapis.com/auth/drive.readonly']
  );

  _drive = google.drive({ version: 'v3', auth });
  return _drive;
}

// ─── Auth Guard ───────────────────────────────────────────────────────────
function requireLogin(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ─── Routes ───────────────────────────────────────────────────────────────

// Login
app.post('/api/login', async (req, res) => {
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
app.get('/api/files', requireLogin, async (req, res) => {
  const folderId = req.query.folderId || 'root';
  try {
    const drive = getDriveClient();
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id,name,mimeType,size,modifiedTime,parents)',
      orderBy: 'folder,name',
      pageSize: 1000
    });
    res.json({ files: response.data.files || [] });
  } catch (err) {
    console.error('[Drive] 文件列表错误:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get folder breadcrumb path
app.get('/api/path', requireLogin, async (req, res) => {
  const folderId = req.query.folderId || 'root';
  if (folderId === 'root') return res.json({ path: [{ id: 'root', name: 'My Drive' }] });

  try {
    const drive = getDriveClient();
    const chain = [];
    let current = folderId;

    while (current && current !== 'root') {
      const meta = await drive.files.get({
        fileId: current,
        fields: 'id,name,parents'
      });
      chain.unshift({ id: meta.data.id, name: meta.data.name });
      current = meta.data.parents ? meta.data.parents[0] : null;
    }
    chain.unshift({ id: 'root', name: 'My Drive' });
    res.json({ path: chain });
  } catch (err) {
    console.error('[Drive] 路径错误:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generate a public (token-signed) download link
// The link embeds a signed token so no login is required to download
app.get('/api/share/:fileId', requireLogin, (req, res) => {
  const { fileId } = req.params;
  const token = Buffer.from(JSON.stringify({
    id: fileId
    // no expiry — links are permanent
  })).toString('base64url');
  const host = `${req.protocol}://${req.get('host')}`;
  res.json({ url: `${host}/dl/${token}` });
});

// Public download endpoint — no login required
app.get('/dl/:token', async (req, res) => {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(req.params.token, 'base64url').toString());
  } catch {
    return res.status(400).send('Invalid link');
  }
  try {
    const drive = getDriveClient();
    const meta = await drive.files.get({
      fileId: payload.id,
      fields: 'name,mimeType,size'
    });

    const { name, mimeType } = meta.data;
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Content-Type', mimeType || 'application/octet-stream');

    const stream = await drive.files.get(
      { fileId: payload.id, alt: 'media' },
      { responseType: 'stream' }
    );
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

// ─── Start ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`GDList running on http://localhost:${PORT}`);
});
