#!/bin/bash
# GDlists — Interactive One-click Installer (Multi-source)
set -eo pipefail

REPO_URL="https://github.com/dakerclaw/GDlists.git"
INSTALL_DIR="/opt/gdlists"
SERVICE_NAME="gdlists"
NODE_MIN=18

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${GREEN}[✔]${NC} $*"; }
warn()    { echo -e "${YELLOW}[!]${NC} $*"; }
error()   { echo -e "${RED}[✘]${NC} $*" >&2; exit 1; }
section() { echo -e "\n${CYAN}${BOLD}── $* ──${NC}"; }
prompt()  { echo -ne "${BOLD}$*${NC} "; }

if [ ! -t 0 ]; then
  echo -e "${RED}[错误]${NC} 需要交互式终端，请先下载再运行："
  echo "  curl -fsSL https://raw.githubusercontent.com/dakerclaw/GDlists/main/install.sh -o install.sh"
  echo "  bash install.sh"
  exit 1
fi
[ "$(id -u)" -eq 0 ] || error "请用 root 权限运行：bash install.sh"

echo ""
echo -e "${CYAN}${BOLD}╔════════════════════════════════════════╗${NC}"
echo -e "${CYAN}${BOLD}║   GDlists — 多账号多文件夹 交互安装    ║${NC}"
echo -e "${CYAN}${BOLD}╚════════════════════════════════════════╝${NC}"
echo ""

# ── 1. 系统依赖 ──────────────────────────────────────────────────────────
section "步骤 1/5  安装系统依赖"
if command -v apt-get &>/dev/null; then PKG=apt-get
elif command -v dnf &>/dev/null; then PKG=dnf
elif command -v yum &>/dev/null; then PKG=yum
else error "不支持此系统（需要 apt / dnf / yum）"; fi

for dep in git curl; do
  if ! command -v "$dep" &>/dev/null; then
    info "安装 $dep…"
    $PKG install -y "$dep"
  else
    info "$dep ✓"
  fi
done

install_node() {
  info "安装 Node.js ${NODE_MIN}.x…"
  if [ "$PKG" = "apt-get" ]; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MIN}.x" | bash -
    apt-get install -y nodejs
  else
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MIN}.x" | bash -
    $PKG install -y nodejs
  fi
}
if command -v node &>/dev/null; then
  NODE_VER=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
  if [ "$NODE_VER" -lt "$NODE_MIN" ]; then install_node; else info "Node.js $(node -v) ✓"; fi
else
  install_node
fi

# ── 2. 拉取代码 ───────────────────────────────────────────────────────────
section "步骤 2/5  获取代码"
if [ -d "$INSTALL_DIR/.git" ]; then
  info "检测到已有安装，正在更新…"
  cd "$INSTALL_DIR"
  git fetch origin --prune
  DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|.*/||' || true)
  if [ -z "${DEFAULT_BRANCH:-}" ] || ! git rev-parse --verify "origin/${DEFAULT_BRANCH}" >/dev/null 2>&1; then
    if git rev-parse --verify origin/main >/dev/null 2>&1; then DEFAULT_BRANCH=main
    elif git rev-parse --verify origin/master >/dev/null 2>&1; then DEFAULT_BRANCH=master
    else error "无法确定远程默认分支，请检查 GitHub 仓库状态"; fi
  fi
  info "更新到 origin/${DEFAULT_BRANCH}…"
  git reset --hard "origin/${DEFAULT_BRANCH}"
else
  info "克隆仓库…"
  git clone "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi
info "依赖安装 ✓"

# ── 临时工具（node 负责 JSON / 哈希，避免 shell 转义问题）─────────────────
HELPER="$INSTALL_DIR/.install-helper-$$.js"
SOURCES_TMP="$INSTALL_DIR/.sources-$$.json"
cleanup() { rm -f "$SOURCES_TMP" "$HELPER"; }
trap cleanup EXIT

cat > "$HELPER" <<'NODE_HELPER'
'use strict';
const fs = require('fs');
const cmd = process.argv[2];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

switch (cmd) {
  case 'secret':
    process.stdout.write(require('crypto').randomBytes(32).toString('hex'));
    break;

  case 'hash': {
    const bcrypt = require('bcryptjs');
    const password = process.env.GD_ADMIN_PASSWORD || '';
    if (!password) throw new Error('密码为空');
    process.stdout.write(bcrypt.hashSync(password, 10));
    break;
  }

  case 'sa-email': {
    const key = readJson(process.argv[3]);
    if (!key.client_email) throw new Error('JSON 中缺少 client_email');
    process.stdout.write(key.client_email);
    break;
  }

  case 'add-source': {
    const file = process.argv[3];
    const list = fs.existsSync(file) ? readJson(file) : [];
    list.push({
      id: process.argv[4],
      name: process.argv[5],
      keyFile: process.argv[6],
      folderId: process.argv[7],
    });
    fs.writeFileSync(file, JSON.stringify(list));
    process.stdout.write(String(list.length));
    break;
  }

  case 'list':
    process.stdout.write(JSON.stringify(readJson(process.argv[3])));
    break;

  case 'preview': {
    readJson(process.argv[3]).forEach((s, i) => {
      console.log(`  [${i + 1}] id=${s.id} | name=${s.name} | folder=${s.folderId}`);
    });
    break;
  }

  case 'validate-env': {
    const text = fs.readFileSync(process.argv[3], 'utf8');
    const env = {};
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      env[line.slice(0, eq)] = line.slice(eq + 1);
    }
    const sources = JSON.parse(env.DRIVE_SOURCES || 'invalid');
    if (!Array.isArray(sources) || sources.length === 0) throw new Error('DRIVE_SOURCES 为空');
    for (const s of sources) {
      if (!s.id || !s.folderId) throw new Error(`数据源 ${s.id || '?'} 缺少 id / folderId`);
      if (!s.keyFile || !fs.existsSync(s.keyFile)) throw new Error(`数据源 ${s.id} 的密钥文件不存在: ${s.keyFile}`);
    }
    if (!env.ADMIN_PASSWORD_HASH) throw new Error('缺少 ADMIN_PASSWORD_HASH');
    if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET 无效');
    if (!/^\d+$/.test(env.PORT || '')) throw new Error('PORT 无效');
    process.stdout.write(String(sources.length));
    break;
  }

  default:
    throw new Error('未知命令: ' + cmd);
}
NODE_HELPER

echo "[]" > "$SOURCES_TMP"

# ── 3. 管理员账号 ─────────────────────────────────────────────────────────
section "步骤 3/5  管理员账号"
if [ -f "$INSTALL_DIR/.env" ]; then
  warn "检测到已有 .env，继续将覆盖原有配置"
fi

prompt "用户名 [默认 admin]:"; read -r INPUT_USER || true
ADMIN_USERNAME="${INPUT_USER:-admin}"
info "用户名: $ADMIN_USERNAME"

while true; do
  prompt "密码:"; read -rs P1; echo ""
  prompt "确认密码:"; read -rs P2; echo ""
  if [ -n "$P1" ] && [ "$P1" = "$P2" ]; then break; fi
  warn "两次输入不一致或为空，请重试"
done

ADMIN_HASH=$(GD_ADMIN_PASSWORD="$P1" node "$HELPER" hash)
unset P1 P2
info "密码哈希 ✓"

# ── 4. 多账号多文件夹配置 ─────────────────────────────────────────────────
section "步骤 4/5  多账号多文件夹配置"

echo ""
echo "  Service Account 是 Google 官方服务端认证方式："
echo "  - 无需浏览器，全程在服务器完成"
echo "  - 凭据长期有效，不会过期"
echo ""
echo "  ── 准备步骤 ─────────────────────────────────────"
echo "  1. 打开 https://console.cloud.google.com/"
echo "  2. 创建/选择项目 → IAM 和管理 → Service Accounts"
echo "  3. 创建 Service Account，下载 JSON 密钥文件"
echo "  4. 用任意方式打开下载的 JSON 文件，复制全部内容"
echo "  5. 把想访问的 Drive 文件夹共享给 Service Account 邮箱（查看者权限）"
echo ""
echo "  ── 操作说明 ─────────────────────────────────────"
echo "  每个账号可绑定多个根文件夹（同一个 SA）"
echo "  文件夹 ID 可以直接粘贴 Drive URL，脚本会自动提取"
echo "  直接回车表示该账号文件夹输入完毕"
echo ""

if command -v nano &>/dev/null; then
  EDITOR_CMD="nano"
elif command -v vi &>/dev/null; then
  EDITOR_CMD="vi"
else
  $PKG install -y nano
  EDITOR_CMD="nano"
fi

extract_folder_id() {
  local value="$1"
  if [[ "$value" =~ /folders/([A-Za-z0-9_-]+) ]]; then
    value="${BASH_REMATCH[1]}"
  elif [[ "$value" =~ [\?\&]id=([A-Za-z0-9_-]+) ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  printf '%s' "$value"
}

collect_one_account() {
  local acc_num="$1"
  local key_file="${INSTALL_DIR}/sa_${acc_num}.json"
  local sa_email folder_num fid

  echo ""
  echo -e "${BOLD}══════════ 账号 #${acc_num} ══════════${NC}"
  echo "请准备好 Service Account JSON 文件内容，按回车后用 ${EDITOR_CMD} 粘贴，保存退出"
  prompt "准备好后按回车…"; read -r || true

  touch "$key_file"
  chmod 600 "$key_file"
  $EDITOR_CMD "$key_file"

  if [ ! -s "$key_file" ]; then
    error "密钥文件为空，请重新运行安装并粘贴 JSON 内容"
  fi

  sa_email=$(node "$HELPER" sa-email "$key_file" 2>&1) || {
    rm -f "$key_file"
    error "JSON 内容无效：${sa_email}"
  }

  echo ""
  info "Service Account 邮箱: $sa_email"
  echo -e "  ${YELLOW}⚠  请将 Drive 文件夹共享给以上邮箱（权限：查看者）${NC}"
  echo "  文件夹 ID 获取：打开 Drive 目标文件夹，复制 URL 中 /folders/ 后面的字符串"
  echo ""

  folder_num=1
  while true; do
    if [ "$folder_num" -eq 1 ]; then
      prompt "账号 #${acc_num} - 文件夹 #${folder_num} ID（直接回车跳过此账号）:"
    else
      prompt "账号 #${acc_num} - 文件夹 #${folder_num} ID（直接回车完成此账号）:"
    fi
    read -r fid || true

    if [ -z "$fid" ]; then
      if [ "$folder_num" -eq 1 ]; then
        warn "该账号未输入任何文件夹，已跳过"
        return 0
      fi
      break
    fi

    fid=$(extract_folder_id "$fid")
    if ! [[ "$fid" =~ ^[A-Za-z0-9_-]{10,}$ ]]; then
      warn "文件夹 ID 看起来不合法（通常 20 位以上字母/数字/下划线/短横线）：$fid"
      continue
    fi

    local src_id="acc${acc_num}f${folder_num}"
    local src_name="账号${acc_num}-文件夹${folder_num}"
    node "$HELPER" add-source "$SOURCES_TMP" "$src_id" "$src_name" "$key_file" "$fid" >/dev/null
    info "已添加: ${src_id} → ${fid}"
    folder_num=$((folder_num + 1))
  done
  return 0
}

ACCOUNT_NUM=1
while true; do
  collect_one_account "$ACCOUNT_NUM" || true
  echo ""
  prompt "是否添加更多账号？（直接回车继续，输入 n 完成配置）:"
  read -r MORE || true
  if [ "$MORE" = "n" ] || [ "$MORE" = "N" ]; then
    break
  fi
  ACCOUNT_NUM=$((ACCOUNT_NUM + 1))
done

SOURCE_COUNT=$(node "$HELPER" list "$SOURCES_TMP" | node -e "
  const chunks = [];
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => process.stdout.write(String(JSON.parse(Buffer.concat(chunks).toString()).length)));
")

if [ "$SOURCE_COUNT" = "0" ]; then
  error "未配置任何数据源，请重新运行安装"
fi

info "共配置 ${SOURCE_COUNT} 个数据源"
echo ""
echo "  ── 配置预览 ─────────────────────────────────────"
node "$HELPER" preview "$SOURCES_TMP"
echo "  ───────────────────────────────────────────────"

# ── 5. 写入配置并启动 ─────────────────────────────────────────────────────
section "步骤 5/5  写入配置并启动"
while true; do
  prompt "端口 [默认 3000]:"; read -r INPUT_PORT || true
  PORT="${INPUT_PORT:-3000}"
  if [[ "$PORT" =~ ^[0-9]+$ ]]; then break; fi
  warn "端口必须是数字"
done

SESSION_SECRET=$(node "$HELPER" secret)
ALL_SOURCES_JSON=$(node "$HELPER" list "$SOURCES_TMP")

# 直接写入原始 JSON：不要做 shell 转义，否则 dotenv 里会带上反斜杠导致解析失败
umask 077
{
  printf 'PORT=%s\n' "$PORT"
  printf 'TRUST_PROXY=1\n'
  printf 'SESSION_SECRET=%s\n' "$SESSION_SECRET"
  printf 'ADMIN_USERNAME=%s\n' "$ADMIN_USERNAME"
  printf 'ADMIN_PASSWORD_HASH=%s\n' "$ADMIN_HASH"
  printf 'DRIVE_SOURCES=%s\n' "$ALL_SOURCES_JSON"
} > "$INSTALL_DIR/.env"
chmod 600 "$INSTALL_DIR/.env"

SOURCE_COUNT=$(node "$HELPER" validate-env "$INSTALL_DIR/.env") || error ".env 校验失败，请检查配置"
info ".env 已写入并校验通过（权限 600，${SOURCE_COUNT} 个数据源）✓"

NODE_BIN=$(command -v node)
cat > "/etc/systemd/system/${SERVICE_NAME}.service" << SVCEOF
[Unit]
Description=GDlists – Google Drive file listing
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
Environment=NODE_ENV=production
ExecStart=${NODE_BIN} ${INSTALL_DIR}/server.js
Restart=always
RestartSec=3
LimitNOFILE=65535
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" &>/dev/null
systemctl restart "$SERVICE_NAME"

HEALTHY=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then HEALTHY=1; break; fi
  sleep 1
done

if [ "$HEALTHY" = "1" ]; then
  info "服务已启动并通过健康检查 ✓"
else
  warn "服务未通过健康检查，请查看日志：journalctl -u ${SERVICE_NAME} -n 50 --no-pager"
fi

SERVER_IP=$(curl -s --connect-timeout 3 ifconfig.me 2>/dev/null || echo 'YOUR_SERVER_IP')
echo ""
echo -e "${GREEN}${BOLD}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}║          安装完成！                     ║${NC}"
echo -e "${GREEN}${BOLD}╚════════════════════════════════════════╝${NC}"
echo ""
echo -e "  访问地址: ${BOLD}http://${SERVER_IP}:${PORT}${NC}"
echo -e "  用户名:   ${BOLD}${ADMIN_USERNAME}${NC}"
echo ""
echo -e "  ${YELLOW}⚠ HTTP 为明文传输，登录密码会以明文经过网络。${NC}"
echo -e "  ${YELLOW}  建议配置 nginx + HTTPS，示例见 deploy/nginx.conf.example${NC}"
echo ""
echo "  systemctl status ${SERVICE_NAME}    # 查看状态"
echo "  journalctl -u ${SERVICE_NAME} -f    # 查看日志"
echo "  bash ${INSTALL_DIR}/install.sh      # 重新配置"
