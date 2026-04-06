#!/bin/bash
# GDList — Interactive One-click Installer (Service Account)
set -e

REPO="https://github.com/dakerclaw/GDlist.git"
INSTALL_DIR="/opt/gdlist"
SERVICE_NAME="gdlist"
NODE_MIN=18

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${GREEN}[✔]${NC} $*"; }
error()   { echo -e "${RED}[✘]${NC} $*" ; exit 1; }
section() { echo -e "\n${CYAN}${BOLD}── $* ──${NC}"; }
prompt()  { echo -ne "${BOLD}$*${NC} "; }

if [ ! -t 0 ]; then
  echo -e "${RED}[错误]${NC} 需要交互式终端，请先下载再运行："
  echo "  curl -fsSL https://raw.githubusercontent.com/dakerclaw/GDlist/main/install.sh -o install.sh"
  echo "  sudo bash install.sh"
  exit 1
fi
[[ $EUID -ne 0 ]] && error "请用 root 权限运行：sudo bash install.sh"

echo ""
echo -e "${CYAN}${BOLD}╔════════════════════════════════════════╗${NC}"
echo -e "${CYAN}${BOLD}║   GDList — Service Account 认证安装   ║${NC}"
echo -e "${CYAN}${BOLD}╚════════════════════════════════════════╝${NC}"
echo ""

# ── 1. 系统依赖 ──────────────────────────────────────────────────────────
section "步骤 1/5  安装系统依赖"
if command -v apt-get &>/dev/null; then PKG=apt-get
elif command -v yum &>/dev/null; then PKG=yum
elif command -v dnf &>/dev/null; then PKG=dnf
else error "不支持此系统"; fi

if ! command -v git &>/dev/null; then
  info "安装 git…"; $PKG install -y git
else
  info "git ✓"
fi

install_node() {
  info "安装 Node.js ${NODE_MIN}.x…"
  if [[ "$PKG" == "apt-get" ]]; then
    curl -fsSL https://deb.nodesource.com/setup_${NODE_MIN}.x | bash -
    apt-get install -y nodejs
  else
    curl -fsSL https://rpm.nodesource.com/setup_${NODE_MIN}.x | bash -
    $PKG install -y nodejs
  fi
}
if command -v node &>/dev/null; then
  NODE_VER=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
  if (( NODE_VER < NODE_MIN )); then install_node; else info "Node.js ${NODE_VER} ✓"; fi
else
  install_node
fi

# ── 2. 拉取代码 ───────────────────────────────────────────────────────────
section "步骤 2/5  获取代码"
if [ -d "$INSTALL_DIR/.git" ]; then
  info "检测到已有安装，正在更新…"; cd "$INSTALL_DIR"
  git fetch origin
  git reset --hard origin/main
else
  info "克隆仓库…"; git clone "$REPO" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"
npm install --omit=dev --silent
info "依赖安装 ✓"

# ── 3. 管理员账号 ─────────────────────────────────────────────────────────
section "步骤 3/5  管理员账号"
prompt "用户名 [默认 admin]:"; read -r U
ADMIN_USERNAME="${U:-admin}"
info "用户名: $ADMIN_USERNAME"

while true; do
  prompt "密码:"; read -rs P1; echo ""
  prompt "确认密码:"; read -rs P2; echo ""
  if [ "$P1" = "$P2" ] && [ -n "$P1" ]; then break; fi
  echo -e "${YELLOW}两次不一致，请重试${NC}"
done

ADMIN_HASH=$(node -e "const b=require('bcryptjs');b.hash(process.argv[1],10).then(h=>process.stdout.write(h))" "$P1")
info "密码哈希 ✓"

# ── 4. Service Account ───────────────────────────────────────────────────
section "步骤 4/5  Service Account 密钥"
echo ""
echo "  Service Account 是 Google 官方服务端认证方式："
echo "  - 无需浏览器，全程在服务器完成"
echo "  - 凭据永久有效，不会过期"
echo ""
echo "  ── 准备步骤 ─────────────────────────────────────"
echo "  1. 打开 https://console.cloud.google.com/"
echo "  2. 创建/选择项目 → IAM 和管理 → Service Accounts"
echo "  3. 创建 Service Account，下载 JSON 密钥文件"
echo "  4. 用任意方式打开下载的 JSON 文件，复制全部内容"
echo "  5. 把想访问的 Drive 文件夹共享给 Service Account 邮箱"
echo ""
echo "  即将打开编辑器，请将 JSON 内容粘贴进去并保存："
echo "  - nano: Ctrl+Shift+V 粘贴 → Ctrl+X → Y → Enter 保存"
echo ""
prompt "准备好后按回车打开编辑器…"; read -r

KEY_PATH="${INSTALL_DIR}/service-account-key.json"

# 确保编辑器可用
if command -v nano &>/dev/null; then
  EDITOR_CMD="nano"
elif command -v vi &>/dev/null; then
  EDITOR_CMD="vi"
else
  $PKG install -y nano; EDITOR_CMD="nano"
fi

# 打开编辑器让用户粘贴 JSON
touch "$KEY_PATH" && chmod 600 "$KEY_PATH"
$EDITOR_CMD "$KEY_PATH"

# 验证文件非空
if [ ! -s "$KEY_PATH" ]; then
  error "文件为空，请重新运行安装并粘贴 JSON 内容。"
fi

# 验证 JSON 格式并提取 SA 邮箱
SA_EMAIL=$(node -e "
  try {
    const k = JSON.parse(require('fs').readFileSync('$KEY_PATH','utf8'));
    if (!k.client_email) { console.error('缺少 client_email 字段'); process.exit(1); }
    console.log(k.client_email);
  } catch(e) { console.error('JSON 解析失败: ' + e.message); process.exit(1); }
" 2>&1) || error "JSON 内容无效：${SA_EMAIL}"

echo ""
info "Service Account 邮箱: $SA_EMAIL"
echo -e "  ${YELLOW}⚠  请将 Drive 文件夹共享给以上邮箱，否则 GDList 无法读取任何文件！${NC}"
prompt "确认已共享（或稍后再共享），按回车继续…"; read -r

# ── 5. 写入配置并启动 ─────────────────────────────────────────────────────
section "步骤 5/5  写入配置并启动"
prompt "端口 [默认 3000]:"; read -r PORT; PORT="${PORT:-3000}"

SESSION_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")

cat > "$INSTALL_DIR/.env" << ENVEOF
PORT=${PORT}
SESSION_SECRET=${SESSION_SECRET}
ADMIN_USERNAME=${ADMIN_USERNAME}
ADMIN_PASSWORD_HASH=${ADMIN_HASH}
GOOGLE_SERVICE_ACCOUNT_JSON=${INSTALL_DIR}/service-account-key.json
ENVEOF

chmod 600 "$INSTALL_DIR/.env"
info ".env 已写入（权限 600）✓"

NODE_BIN=$(which node)
cat > /etc/systemd/system/${SERVICE_NAME}.service << SVCEOF
[Unit]
Description=GDList – Google Drive file listing
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=${NODE_BIN} ${INSTALL_DIR}/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" &>/dev/null
systemctl restart "$SERVICE_NAME"
sleep 2

if systemctl is-active --quiet "$SERVICE_NAME"; then
  info "服务已启动 ✓"
else
  echo -e "${YELLOW}[!]${NC} 服务启动异常，请检查日志：journalctl -u ${SERVICE_NAME} -n 50"
fi

SERVER_IP=$(curl -s --connect-timeout 3 ifconfig.me 2>/dev/null || echo 'YOUR_SERVER_IP')
echo ""
echo -e "${GREEN}${BOLD}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}║          安装完成！                     ║${NC}"
echo -e "${GREEN}${BOLD}╚════════════════════════════════════════╝${NC}"
echo ""
echo -e "  访问地址: ${BOLD}http://${SERVER_IP}:${PORT}${NC}"
echo -e "  用户名:   ${BOLD}${ADMIN_USERNAME}${NC}"
echo -e "  ${YELLOW}SA 邮箱: ${SA_EMAIL}（需已共享 Drive 文件夹）${NC}"
echo ""
echo "  systemctl status gdlist   # 查看状态"
echo "  journalctl -u gdlist -f   # 查看日志"
echo "  bash ${INSTALL_DIR}/install.sh   # 重新配置"
