# GDList

> Google Drive 文件列表服务，带登录保护和免密下载链接

**特性：** 用户名+密码登录 · 文件夹无限层级导航 · 免登录下载 · Service Account 永久认证 · **支持多账号多 Drive 文件夹**

---

## 🚀 快速开始

### 第一步：准备 Google Cloud

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)，创建或选择项目
2. **创建 Service Account**
   - 左侧菜单 → **IAM 和管理** → **Service Accounts**
   - 点击「+ 创建 Service Account」→ 填写名称 → 完成
   - 进入详情 → 「密钥」→「添加密钥」→「创建新密钥」→「JSON」→ 下载文件
3. **共享 Drive 文件夹**
   - 打开你要分享的 Google Drive 文件夹
   - 右键 → 「共享」→ 添加 Service Account 邮箱
   - 邮箱格式：`xxxxx@yyyyyy.iam.gserviceaccount.com`

> ⚠️ **必须执行第 3 步！** Service Account 本身无权访问 Drive，必须共享文件夹才有权限。

### 第二步：安装服务

```bash
curl -fsSL https://raw.githubusercontent.com/dakerclaw/GDlist/main/install.sh -o install.sh
bash install.sh
```

安装过程全交互式，会依次询问：
- 管理员用户名和密码
- Service Account JSON 文件（粘贴内容）
- 根目录文件夹 ID
- 服务端口（默认 3000）

### 第三步：访问使用

```
http://你的服务器IP:端口
```

---

## 📋 部署前检查清单

- [ ] 已下载 Service Account JSON 密钥文件
- [ ] 已将 Drive 文件夹共享给 Service Account 邮箱
- [ ] 准备好要分享的 Drive 文件夹 ID（URL 中 `/folders/` 后面的字符串）
- [ ] 服务器系统为 Ubuntu/Debian/CentOS/Rocky Linux

---

## 🔧 安装后管理

```bash
systemctl status gdlist        # 查看运行状态
journalctl -u gdlist -f         # 实时查看日志
systemctl restart gdlist       # 重启服务
bash /opt/gdlist/install.sh    # 重新配置
```

---

## 📦 更新指南

### 自动更新（推荐）

```bash
cd /opt/gdlist
git fetch origin
git reset --hard origin/main    # 如果默认分支是 main
# 或
git reset --hard origin/master  # 如果默认分支是 master
npm install --omit=dev
systemctl restart gdlist
```

### 手动更新

如果服务器上 git 没有配置用户，或网络无法访问 GitHub：

1. 在本地修改代码
2. 手动上传 `server.js`、`public/index.html`、`package.json`、`install.sh` 等文件到服务器 `/opt/gdlist/`
3. 执行 `npm install --omit=dev && systemctl restart gdlist`

### 更新后必做

1. 查看日志确认启动成功：`journalctl -u gdlist -n 10 --no-pager`
2. 浏览器强制刷新（Ctrl+Shift+R）确保加载最新前端
3. 测试文件列表、下载、PDF 预览是否正常

### 版本号说明

前端版本号由 `server.js` 和 `public/index.html` 顶部的 `APP_VERSION` 控制，两者必须一致。更新代码时同步修改，例如从 `20260414` 改为 `20260415`。版本号变化会强制浏览器刷新 CDN 资源（PDF.js 等）。

---

## 🗑️ 卸载指南

### 步骤一：停止服务

```bash
systemctl stop gdlist
systemctl disable gdlist
```

### 步骤二：删除服务与文件

```bash
# 删除 systemd 服务文件
rm /etc/systemd/system/gdlist.service
systemctl daemon-reload

# 删除项目文件（包括所有缓存）
rm -rf /opt/gdlist
```

> ⚠️ 这会删除所有缓存文件（`cache/` 和 `preview-cache/`），如果缓存中有重要数据请提前备份。

### 步骤三：确认清理完毕

```bash
# 检查进程是否已停止
ps aux | grep gdlist

# 检查端口是否已释放
ss -tlnp | grep 3000

# 检查文件是否已删除
ls /opt/gdlist
```

---

## 🗂️ 多账号 / 多 Drive 文件夹

GDList 支持在单个服务中同时挂载多个 Google 账号的多个共享文件夹，登录后通过顶部标签页切换。

### 配置方式

在 `.env` 中用 `DRIVE_SOURCES`（JSON 数组）代替旧的单源配置：

```env
# 多源模式（推荐）
DRIVE_SOURCES=[{"id":"work","name":"工作盘","keyFile":"/opt/gdlist/sa-work.json","folderId":"1AbcWorkFolderId"},{"id":"personal","name":"个人盘","keyFile":"/opt/gdlist/sa-personal.json","folderId":"1XyzPersonalFolderId"},{"id":"team","name":"团队共享","keyFile":"/opt/gdlist/sa-team.json","folderId":"1TeamFolderId"}]
```

| 字段 | 说明 | 是否必填 |
|------|------|----------|
| `id` | 唯一标识符，用于 API 路由（英文数字横线） | 必填 |
| `name` | 显示名称，出现在标签页上 | 必填 |
| `keyFile` | 该账号对应的 Service Account JSON 绝对路径 | 必填 |
| `folderId` | 此源的根文件夹 ID | 必填（不能用 'root'） |

### 兼容旧单源配置

如果 `.env` 中没有 `DRIVE_SOURCES`，继续使用旧配置：

```env
GOOGLE_SERVICE_ACCOUNT_JSON=/opt/gdlist/service-account.json
ROOT_FOLDER_ID=1AbcFolderId
```

### 操作流程

1. 为每个账号/文件夹分别准备 Service Account JSON 文件，上传到服务器
2. 将各文件夹共享给对应的 Service Account 邮箱（查看器权限即可）
3. 在 `.env` 中填写 `DRIVE_SOURCES`
4. 重启服务：`systemctl restart gdlist`
5. 登录后，顶部出现数据源标签栏（单源时自动隐藏）

> 💡 每个数据源独立使用各自的 Service Account 凭据，账号之间完全隔离。

---

## 📁 项目结构

```
gdlist/
├── server.js              # Express 后端
├── install.sh             # 交互式安装脚本
├── package.json
└── public/
    └── index.html         # 前端（纯原生 HTML/CSS/JS，零依赖）
```

---

## ⚙️ 技术细节

| 项目 | 说明 |
|------|------|
| 认证方式 | Google Service Account（JWT 签名），凭据永久有效 |
| Drive 权限 | 仅 `drive.readonly` 最小权限 |
| 下载链接 | base64url 签名，默认 72 小时有效 |
| 会话管理 | express-session + HttpOnly Cookie，24 小时 |
| 前端 | 单 HTML 文件，无任何外部依赖 |

---

## ❓ 常见问题

**Q: 显示"找不到文件"？**
A: Drive 文件夹没有共享给 Service Account 邮箱。请执行上述「第一步：准备 Google Cloud」的第 3 步。

**Q: 想更换密码？**
A: 重新运行 `bash /opt/gdlist/install.sh`。

**Q: 下载链接过期了？**
A: 重新登录后点击文件即可生成新链接。

**Q: 如何获取文件夹 ID？**
A: 打开目标 Drive 文件夹，复制 URL 中 `/folders/` 后面的字符串（问号前）。