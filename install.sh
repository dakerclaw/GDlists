#!/bin/bash
# GDlists — Interactive One-click Installer (Multi-source)
set -e

REPO="https://github.com/dakerclaw/GDlists.git"
INSTALL_DIR="/opt/gdlists"
SERVICE_NAME="gdlists"
NODE_MIN=18

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${GREEN}[✔]${NC} $*"; }
error()   { echo -e "${RED}[✘]${NC} $*" ; exit 1; }
section() { echo -e "\n${CYAN}${BOLD}── $* ──${NC}"; }
prompt()  { echo -ne "${BOLD}$*${NC} "; }
warn()    { echo -e "${YELLOW}[!]${NC} $*"; }

if [ ! -t 0 ]; then
  echo -e "${RED}[错误]${NC} 需要交互式终端，请先下载再运行："
  echo "  curl -fsSL https://raw.githubusercontent.com/dakerclaw/GDlists/main/install.sh -o install.sh"
  echo "  bash install.sh"
  exit 1
fi
[[ $EUID -ne 0 ]] && error "请用 root 权限运行：bash install.sh"

echo ""
echo -e "${CYAN}${BOLD}╔════════════════════════════════════════╗${NC}"
echo -e "${CYAN}${BOLD}║   GDlists — 多账号多文件夹 交互安装    ║${NC}"
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

# ── 4. 多账号多文件夹配置 ─────────────────────────────────────────────────
section "步骤 4/5  多账号多文件夹配置"

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
echo "  ── 操作说明 ─────────────────────────────────────"
echo "  每个账号可添加多个根文件夹（分别绑定同一个 SA）"
echo "  输入文件夹 ID 后按回车，直接回车表示该账号文件夹输入完毕"
echo "  全部账号配置完后选择端口，然后启动服务"
echo ""

# 确保编辑器可用
if command -v nano &>/dev/null; then
  EDITOR_CMD="nano"
elif command -v vi &>/dev/null; then
  EDITOR_CMD="vi"
else
  $PKG install -y nano; EDITOR_CMD="nano"
fi

# 全局配置数组（node 可直接操作的临时文件）
SOURCES_TMP="/tmp/gdlists_sources_$$.json"
echo "[]" > "$SOURCES_TMP"

# 账号序号
ACCOUNT_NUM=1

collect_one_account() {
  local acc_num=$1
  local key_file sa_email folder_num fid src_id

  echo ""
  echo -e "${BOLD}══════════ 账号 #${acc_num} ══════════${NC}"
  echo "请准备好 Service Account JSON 文件内容，然后按回车打开编辑器"
  prompt "准备好后按回车…"; read -r

  key_file="${INSTALL_DIR}/sa_${acc_num}.json"
  touch "$key_file" && chmod 600 "$key_file"
  $EDITOR_CMD "$key_file"

  if [ ! -s "$key_file" ]; then
    error "文件为空，请重新运行安装并粘贴 JSON 内容。"
  fi

  sa_email=$(node -e "
    const k = JSON.parse(require('fs').readFileSync('$key_file','utf8'));
    if (!k.client_email) { console.error('缺少 client_email'); process.exit(1); }
    console.log(k.client_email);
  " 2>&1) || error "JSON 内容无效：${sa_email}"

  echo ""
  info "Service Account 邮箱: $sa_email"
  echo -e "  ${YELLOW}⚠  请将 Drive 文件夹共享给以上邮箱（权限：查看者）${NC}"
  echo "  文件夹 ID 获取：打开 Drive 目标文件夹，复制 URL 中 /folders/ 后面的字符串"
  echo ""

  # 为当前账号收集多个根文件夹
  folder_num=1

  while true; do
    if [ $folder_num -eq 1 ]; then
      prompt "账号 #${acc_num} - 文件夹 #${folder_num} ID（直接回车跳过此账号）:"
    else
      prompt "账号 #${acc_num} - 文件夹 #${folder_num} ID（直接回车完成此账号）:"
    fi
    read -r fid

    if [ -z "$fid" ]; then
      if [ $folder_num -eq 1 ]; then
        echo -e "  ${YELLOW}该账号未输入任何文件夹，已跳过${NC}"
        return 1  # 跳过此账号
      else
        break  # 正常结束此账号
      fi
    fi

    src_id="acc${acc_num}f${folder_num}"

    # 追加到临时 JSON 文件
    node -e "
      const fs = require('fs');
      const arr = JSON.parse(fs.readFileSync('$SOURCES_TMP','utf8'));
      arr.push({id:'$src_id', name:'账号${acc_num}-文件夹${folder_num}', keyFile:'$key_file', folderId:'$fid'});
      fs.writeFileSync('$SOURCES_TMP', JSON.stringify(arr));
    "

    info "已添加: $src_id → $fid"
    folder_num=$((folder_num + 1))
  done

  return 0
}

while true; do
  collect_one_account "$ACCOUNT_NUM"
  echo ""
  prompt "是否添加更多账号？(直接回车继续添加，输入 n 完成配置):"
  read -r more
  if [ "$more" = "n" ] || [ "$more" = "N" ]; then
    break
  fi
  ACCOUNT_NUM=$((ACCOUNT_NUM + 1))
done

# 读取最终配置
ALL_SOURCES_JSON=$(cat "$SOURCES_TMP")
rm -f "$SOURCES_TMP"

SOURCE_COUNT=$(node -e "console.log(JSON.parse('$ALL_SOURCES_JSON').length)")

if [ "$SOURCE_COUNT" = "0" ]; then
  error "未配置任何数据源，请重新运行安装。"
fi

info "共配置 $SOURCE_COUNT 个数据源"

# 预览配置
echo ""
echo "  ── 配置预览 ─────────────────────────────────────"
node -e "
  const arr = JSON.parse('$ALL_SOURCES_JSON');
  arr.forEach((s, i) => console.log('  [' + (i+1) + '] id=' + s.id + ' | name=' + s.name + ' | folder=' + s.folderId));
"
echo "  ───────────────────────────────────────────────"

# ── 5. 写入配置并启动 ─────────────────────────────────────────────────────
section "步骤 5/5  写入配置并启动"
prompt "端口 [默认 3000]:"; read -r PORT; PORT="${PORT:-3000}"

SESSION_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")

# 转义 JSON 字符串用于 heredoc（转义 \ 和 "）
SOURCES_ESCAPED=$(echo "$ALL_SOURCES_JSON" | node -e "
  const chunks = [];
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => {
    const str = Buffer.concat(chunks).toString();
    const escaped = str.replace(/\\\\/g, '\\\\\\\\').replace(/\"/g, '\\\\\"');
    process.stdout.write(escaped);
  });
")

cat > "$INSTALL_DIR/.env" << ENVEOF
PORT=${PORT}
SESSION_SECRET=${SESSION_SECRET}
ADMIN_USERNAME=${ADMIN_USERNAME}
ADMIN_PASSWORD_HASH=${ADMIN_HASH}
DRIVE_SOURCES=${SOURCES_ESCAPED}
ENVEOF

chmod 600 "$INSTALL_DIR/.env"
info ".env 已写入（权限 600）✓"

NODE_BIN=$(which node)
cat > /etc/systemd/system/${SERVICE_NAME}.service << SVCEOF
[Unit]
Description=GDlists – Google Drive file listing
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
echo ""
echo "  systemctl status gdlists   # 查看状态"
  echo "  journalctl -u gdlists -f   # 查看日志"
  echo "  bash ${INSTALL_DIR}/install.sh   # 重新配置"
