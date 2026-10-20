// 冒烟测试：启动真实服务进程，走一遍关键路由（不需要真实 Google 凭据）
// 运行：node tools/smoke.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bcrypt = require('bcryptjs');

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const TEMP = path.join(root, '.smoke');
const USER = 'smoke-admin';
const PASSWORD = 'smoke-password-123';

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✔ ${name}`);
}
async function check(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    console.error(`  ✘ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

fs.rmSync(TEMP, { recursive: true, force: true });
fs.mkdirSync(TEMP, { recursive: true });
const keyFile = path.join(TEMP, 'sa.json');
fs.writeFileSync(keyFile, JSON.stringify({
  type: 'service_account',
  client_email: 'smoke@example.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n',
}));

const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(PORT),
    TRUST_PROXY: '0',
    SESSION_SECRET: 'smoke-secret-0123456789abcdef0123456789',
    ADMIN_USERNAME: USER,
    ADMIN_PASSWORD_HASH: bcrypt.hashSync(PASSWORD, 4),
    DRIVE_SOURCES: JSON.stringify([{ id: 'test', name: '测试源', keyFile, folderId: 'folder1234567890' }]),
    MAX_CACHE_SIZE_GB: '1',
    CACHE_TTL_DAYS: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', d => { serverLog += d.toString(); });
child.stderr.on('data', d => { serverLog += d.toString(); });

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('服务启动超时:\n' + serverLog);
}

let cookie = '';
function authHeaders(extra = {}) {
  return { ...extra, ...(cookie ? { Cookie: cookie } : {}) };
}

async function main() {
  await waitForServer();
  console.log('health & 首页');

  await check('GET /api/health 返回 ok', async () => {
    const r = await fetch(`${BASE}/api/health`);
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.equal(d.ok, true);
    assert.equal(d.version, '20261020');
    assert.equal(d.sources, 1);
  });

  await check('GET / 注入版本号与数据源', async () => {
    const r = await fetch(`${BASE}/`);
    const html = await r.text();
    assert.equal(r.status, 200);
    assert.match(html, /var APP_VERSION = '20261020';/);
    assert.match(html, /var DRIVE_SOURCES = \[\{"id":"test","name":"测试源"\}\];/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(r.headers.get('content-security-policy') || '', /default-src 'self'/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });

  await check('GET /index.html 也注入配置（不再返回裸模板）', async () => {
    const html = await (await fetch(`${BASE}/index.html`)).text();
    assert.match(html, /var DRIVE_SOURCES = \[\{"id":"test"/);
  });

  await check('未知 /api 路由返回 JSON 404', async () => {
    const r = await fetch(`${BASE}/api/not-exist`);
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error, '接口不存在');
  });

  console.log('认证');

  await check('未登录访问受保护接口返回 401', async () => {
    const r = await fetch(`${BASE}/api/files`);
    assert.equal(r.status, 401);
  });

  await check('错误密码返回 401', async () => {
    const r = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USER, password: 'wrong' }),
    });
    assert.equal(r.status, 401);
  });

  await check('缺少字段返回 400 而不是 500', async () => {
    const r = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
  });

  await check('正确密码登录并下发 HttpOnly 会话 cookie', async () => {
    const r = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASSWORD }),
    });
    assert.equal(r.status, 200);
    const setCookie = r.headers.get('set-cookie') || '';
    assert.match(setCookie, /gdl_session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    cookie = setCookie.split(';')[0];
  });

  await check('/api/auth 返回登录用户', async () => {
    const d = await (await fetch(`${BASE}/api/auth`, { headers: authHeaders() })).json();
    assert.equal(d.authenticated, true);
    assert.equal(d.username, USER);
  });

  await check('伪造会话 cookie 无效', async () => {
    const r = await fetch(`${BASE}/api/auth`, { headers: { Cookie: 'gdl_session=forged.token' } });
    assert.equal((await r.json()).authenticated, false);
  });

  await check('/api/sources 不泄露 folderId', async () => {
    const d = await (await fetch(`${BASE}/api/sources`, { headers: authHeaders() })).json();
    assert.deepEqual(d.sources, [{ id: 'test', name: '测试源' }]);
  });

  await check('非法 sourceId 返回 400', async () => {
    const r = await fetch(`${BASE}/api/files?sourceId=nope`, { headers: authHeaders() });
    assert.equal(r.status, 400);
  });

  await check('Drive 凭据无效时返回 502 而不是崩溃', async () => {
    const r = await fetch(`${BASE}/api/files`, { headers: authHeaders() });
    assert.equal(r.status, 502);
    assert.ok((await r.json()).error);
  });

  console.log('公开链接');

  await check('伪造下载 token 返回 400', async () => {
    const r = await fetch(`${BASE}/dl/eyJpZCI6ImFiYyJ9.deadbeef`);
    assert.equal(r.status, 400);
  });

  await check('旧版未签名 token 不再被接受', async () => {
    const legacy = Buffer.from(JSON.stringify({ id: 'abc', sourceId: 'test' })).toString('base64url');
    const r = await fetch(`${BASE}/cache/${legacy}`);
    assert.equal(r.status, 400);
  });

  console.log('缓存任务');

  await check('缓存任务异步启动并最终进入 error 状态', async () => {
    const start = await fetch(`${BASE}/api/cache/file123`, { method: 'POST', headers: authHeaders() });
    assert.equal(start.status, 200);
    const first = await start.json();
    assert.equal(first.ok, true);
    assert.equal(first.started, true);

    let status = null;
    for (let i = 0; i < 30; i += 1) {
      await new Promise(r => setTimeout(r, 150));
      status = await (await fetch(`${BASE}/api/cache-status/file123`, { headers: authHeaders() })).json();
      if (status.status === 'error') break;
    }
    assert.equal(status.status, 'error');
    assert.ok(status.error);
  });

  await check('任务失败后允许重新启动', async () => {
    const r = await fetch(`${BASE}/api/cache/file123`, { method: 'POST', headers: authHeaders() });
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.started, true);
  });

  console.log('退出');

  await check('登出后会话失效', async () => {
    await fetch(`${BASE}/api/logout`, { method: 'POST', headers: authHeaders() });
    const cookieHeader = (await fetch(`${BASE}/api/logout`, { method: 'POST', headers: authHeaders() })).headers.get('set-cookie') || '';
    assert.match(cookieHeader, /gdl_session=;/);
    const d = await (await fetch(`${BASE}/api/auth`, { headers: { Cookie: 'gdl_session=' } })).json();
    assert.equal(d.authenticated, false);
  });
}

try {
  await main();
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  child.kill();
  fs.rmSync(TEMP, { recursive: true, force: true });
  console.log(`\n${passed} 项通过${process.exitCode ? '，存在失败项' : ''}`);
}
