# GDlists

> Google Drive 文件列表服务：登录保护 + 签名直链 + 在线预览 + 多账号多文件夹

**特性**

- 用户名 + 密码登录（bcrypt 校验、登录限流）
- 文件夹无限层级浏览、搜索、排序
- 图片 / 视频 / 音频 / PDF / 文本 / Word / Excel 在线预览
- 免登录**签名**下载链接，可复制分享；支持 Range（断点续传、PDF 分片加载）
- 服务端缓存：后台任务 + 进度显示，容量与保留期可配
- 多账号、多共享文件夹，顶部标签页切换
- Service Account 认证，无需浏览器授权

---

## 🚀 快速开始

### 第一步：准备 Google Cloud

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)，创建或选择项目
2. **创建 Service Account**
   - 左侧菜单 → **IAM 和管理** → **Service Accounts**
   - 点击「+ 创建 Service Account」→ 填写名称 → 完成
   - 进入详情 → 「密钥」→「添加密钥」→「创建新密钥」→「JSON」→ 下载文件
3. **共享 Drive 文件夹**
   - 打开要分享的 Google Drive 文件夹
   - 右键 → 「共享」→ 添加 Service Account 邮箱，权限选「查看者」
   - 邮箱格式：`xxxxx@yyyyyy.iam.gserviceaccount.com`

> ⚠️ 必须执行第 3 步。Service Account 本身没有 Drive 权限，共享后才有。

### 第二步：安装服务

```bash
curl -fsSL https://raw.githubusercontent.com/dakerclaw/GDlists/main/install.sh -o install.sh
bash install.sh
```

安装过程全交互式，会依次询问：

- 管理员用户名和密码（密码不回显）
- 每个账号的 Service Account JSON（用 nano 粘贴）
- 每个账号的根文件夹 ID（可直接粘贴 Drive URL，脚本自动提取）
- 服务端口（默认 3000）

安装结束会自动做一次健康检查。

### 第三步：访问

```
http://你的服务器IP:端口
```

> 🔒 生产环境请务必配置 HTTPS（见「安全建议」），否则登录密码会明文经过网络。

---

## ⚙️ 配置项

完整模板见 [`.env.example`](.env.example)。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务端口 |
| `SESSION_SECRET` | 必填 | 会话与链接签名密钥，**32 位以上随机串**；修改后所有人需重新登录、旧链接失效 |
| `ADMIN_USERNAME` | `admin` | 管理员用户名 |
| `ADMIN_PASSWORD_HASH` | 必填 | bcrypt 哈希，`install.sh` 自动生成 |
| `DRIVE_SOURCES` | — | 多数据源 JSON 数组（见下） |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | — | 旧版单源：SA 密钥路径 |
| `ROOT_FOLDER_ID` | — | 旧版单源：根文件夹 ID |
| `TRUST_PROXY` | `1` | 反向代理层数；直接用 Node 暴露时设为 `0` |
| `PUBLIC_URL` | 空 | 对外地址，用于生成分享链接，如 `https://drive.example.com` |
| `SESSION_TTL_HOURS` | `24` | 登录有效期 |
| `SHARE_TTL_HOURS` | `0` | 分享链接有效期，`0` = 永久 |
| `CACHE_TTL_DAYS` | `100` | 缓存保留天数 |
| `MAX_CACHE_SIZE_GB` | `5` | 缓存容量上限，超出按最旧淘汰 |
| `FILE_LIST_LIMIT` | `5000` | 单文件夹最多显示条数，防止超大目录拖垮浏览器 |

---

## 🗂️ 多账号 / 多文件夹

在 `.env` 里配置 `DRIVE_SOURCES`（JSON 数组，一行写完，示例见 [`.env.example`](.env.example)）。

| 字段 | 说明 | 必填 |
| --- | --- | --- |
| `id` | 唯一标识，字母/数字/`_`/`-`，≤32 位，用于 API 路由 | 是 |
| `name` | 标签页显示名称 | 是 |
| `keyFile` | 该账号 Service Account JSON 的绝对路径 | 是 |
| `folderId` | 该源的根文件夹 ID | 是 |

- 不同源可以共用同一个 Service Account 密钥文件，绑不同文件夹
- 只有一个源时，前端自动隐藏标签栏
- `id` 不合法或重复会在启动日志中提示并跳过该源
- 私钥文件请保持在项目目录并确保 `.gitignore` 生效（模板已包含 `sa_*.json`）

---

## 💾 缓存与分享

- **分享**：点击 🔗 生成签名下载链接并复制，默认永久有效（可用 `SHARE_TTL_HOURS` 限制）
- **缓存**：点击 💾 后服务端在后台下载到 `cache/`，按钮实时显示百分比；缓存完成后再下载走本地磁盘
- 链接中的 token 使用 HMAC-SHA256 签名，无法通过改 fileId 伪造
- 缓存命中时会以本地文件响应，支持 Range；缓存失效会自动回退为直连 Drive
- 升级到 1.1.0 后，旧版未签名的链接会失效，需要重新生成

---

## 🔒 安全建议

1. **必须启用 HTTPS**：`deploy/nginx.conf.example` 提供了反向代理模板
2. `SESSION_SECRET` 使用随机值，不要提交到仓库
3. `.env` 权限 600，Service Account JSON 权限 600
4. 不要把服务直接暴露在公网 3000 端口；用 nginx/Caddy 反代并限制来源
5. 定期查看日志：`journalctl -u gdlists -f`

已内置的安全措施：

- Drive 权限仅申请 `drive.readonly`
- 登录页 15 分钟 10 次限流，成功登录不计入
- 会话 cookie：`HttpOnly` + `SameSite=Lax`，HTTPS 下自动 `Secure`
- 安全响应头：CSP、`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、HSTS
- 下载/预览 token 带 HMAC 签名与防时序攻击比较
- 文件名校验与转义，前端不使用内联事件处理器

---

## 🔧 安装后管理

```bash
systemctl status gdlists         # 查看状态
journalctl -u gdlists -f         # 实时日志
systemctl restart gdlists        # 重启
bash /opt/gdlists/install.sh     # 重新配置（会覆盖 .env）
curl -s localhost:3000/api/health  # 健康检查
```

---

## 📦 更新指南

```bash
cd /opt/gdlists
git fetch origin
git reset --hard origin/main
npm ci --omit=dev                # 有 package-lock.json
systemctl restart gdlists
journalctl -u gdlists -n 20 --no-pager
```

更新后浏览器强制刷新（Ctrl+Shift+R）。

**版本号**：`server.js` 的 `APP_VERSION` 会在启动时注入前端，同时用于 PDF.js 等 CDN 资源的缓存刷新；`public/index.html` 顶部的值只是本地直开时的兜底。

> ⚠️ `git reset --hard` 会丢弃服务器上的本地改动；缓存目录、`.env`、私钥文件都在 `.gitignore` 中，不受影响。

---

## 🗑️ 卸载指南

```bash
systemctl stop gdlists
systemctl disable gdlists
rm /etc/systemd/system/gdlists.service
systemctl daemon-reload
rm -rf /opt/gdlists     # 含缓存与私钥，请提前备份
```

---

## 📁 项目结构

```
gdlists/
├── server.js                 # Express 后端
├── lib/
│   ├── token.js              # HMAC 签名 token
│   └── range.js              # HTTP Range 解析
├── public/index.html         # 前端（原生 HTML/CSS/JS，零构建）
├── deploy/nginx.conf.example # 反向代理 + HTTPS 模板
├── tools/
│   ├── test-helpers.mjs      # lib 单元测试
│   └── smoke.mjs             # 启动真实进程的冒烟测试
├── install.sh                # 交互式安装脚本
├── package.json
└── .env.example
```

---

---

## ❓ 常见问题

**Q：显示「此文件夹为空」？**
A：文件夹没有共享给对应 Service Account 邮箱，或 `folderId` 填错了。

**Q：文件列表只有一部分？**
A：单目录超过 `FILE_LIST_LIMIT`（默认 5000）会被截断，页面顶部会提示。

**Q：PDF 预览打不开？**
A：PDF.js 从 cdnjs 加载，服务器或浏览器需能访问 `cdnjs.cloudflare.com`；否则会提示 CDN 不可用。

**Q：分享链接 400「链接无效或已过期」？**
A：链接由当前 `SESSION_SECRET` 签名；改过密钥或从旧版本升级后需要重新生成。

**Q：想更换密码？**
A：重新运行 `bash /opt/gdlists/install.sh`，或手动改 `.env` 里的 `ADMIN_PASSWORD_HASH` 后重启。

**Q：如何获取文件夹 ID？**
A：打开 Drive 文件夹，复制 URL 中 `/folders/` 后面的字符串；也可以直接把整个 URL 粘给安装脚本。

**Q：团队盘（Shared Drive）能用吗？**
A：可以。列表与下载请求都带了 `supportsAllDrives` / `includeItemsFromAllDrives`，只需把团队盘文件夹共享给 SA 邮箱。

---

## 📝 更新记录

### 1.1.0（2026-10-20）

- 修复：安装脚本写入 `DRIVE_SOURCES` 时被错误转义导致启动后所有接口失败
- 修复：安装脚本在跳过账号时因 `set -e` 直接退出
- 修复：PDF 预览只能显示前 3 页
- 修复：文件名可注入 HTML（XSS）、含单引号时分享按钮失效
- 修复：文本预览大小限制失效、Range 后缀请求返回错误头
- 修复：文件列表超过 1000 条被静默截断
- 安全：下载 token 改为 HMAC 签名；会话改为签名 cookie（不再使用内存 store）
- 安全：仅申请 `drive.readonly`；新增 CSP 等安全头；`/api/sources` 不再下发 folderId
- 性能：缓存改为后台任务 + 进度；并发缓存去重；列表自带缓存状态（不再 N 次轮询）
- 性能：统一 Drive 流式转发，支持错误处理与客户端断开清理；缓存清理逻辑修正
- 工程：新增 `lib/` 单元测试与冒烟测试、`/api/health`、优雅退出、`package-lock.json`
