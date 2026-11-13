#!/usr/bin/env bash
#
# setup-ssh.sh — Kali Linux 一键修复并开放 SSH 服务
# 功能：
#   1. 安装 / 修复 openssh-server 服务
#   2. 写入公钥到 ~/.ssh/authorized_keys（幂等，重复执行不追加重复行）
#   3. 开启远程密码登录 与 公钥(Key)登录
#   4. 校验配置语法、启用并重启 ssh 服务，输出监听状态
#
# 用法：
#   chmod +x setup-ssh.sh
#   sudo ./setup-ssh.sh
#   # 或普通用户直接运行，脚本内部会调用 sudo 提权
#
set -euo pipefail

# ---------------------------------------------------------------------------
# 配置区
# ---------------------------------------------------------------------------
PUBKEY='ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCsK7OsENqLwuH6pTrCBiNWNI0ByZZURaV+TS6l2P6cxWZpRAgVruyDk+XQ5pY9xJHTZfF75IT+ekWXA5hBe2eO8j+fAQuKaHgvlV8fTp48wMS0LRilfrslOsyv8DsrDs2ZSaiaraj7BwEBalaumczqBM0UoelCa7OvWJDqfyYK8ihQBYBXui/jvyb3FdRA9muOLFuo+AmhIyL3UMQ1jhUxrpmhAKxs6oUjMFXBj//TpvYL7AZXz+2MfmApHYSBx7vs+NodAOf9WShSPoHkuzz3riIsN3hBx66gGRGOPL00lvPsu/GS31klFKaGm3qFcHvO3uczRsaUGj89d/jUwBNh root@linuxkit-025000000001'

SSHD_CONFIG="/etc/ssh/sshd_config"
SSHD_CONFIG_DIR="/etc/ssh/sshd_config.d"
SSHD_SERVICE="ssh"          # Kali / Debian 服务名；若为 sshd 可在下方自动兼容

# 是否允许 root 账号远程登录：
#   prohibit-password = root 仅允许 Key 登录（默认，较安全）
#   yes               = root 允许密码 + Key 登录（不推荐）
#   no                = 禁止 root 远程登录
PERMIT_ROOT="prohibit-password"

# ---------------------------------------------------------------------------
# 前置检查与提权
# ---------------------------------------------------------------------------
log()  { echo -e "\033[1;32m[*]\033[0m $*"; }
warn() { echo -e "\033[1;33m[!]\033[0m $*"; }
err()  { echo -e "\033[1;31m[x]\033[0m $*" >&2; }

if [[ "$(id -u)" -ne 0 ]]; then
    log "当前非 root，尝试使用 sudo 提权重跑..."
    exec sudo bash "$0" "$@"
fi

# 兼容服务名：部分发行版为 sshd
systemctl list-unit-files 2>/dev/null | grep -q "^sshd\.service" && SSHD_SERVICE="sshd"

# ---------------------------------------------------------------------------
# 1. 安装 / 修复 openssh-server
# ---------------------------------------------------------------------------
log "检查 openssh-server 安装状态..."
if ! dpkg -s openssh-server >/dev/null 2>&1; then
    log "未检测到 openssh-server，开始安装..."
    apt-get update -y
    DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server
else
    log "openssh-server 已安装，尝试修复依赖与配置..."
    DEBIAN_FRONTEND=noninteractive apt-get install -y --reinstall openssh-server || true
    dpkg --configure -a || true
fi

# ---------------------------------------------------------------------------
# 2. 写入公钥到 authorized_keys（幂等）
# ---------------------------------------------------------------------------
TARGET_USER="${SUDO_USER:-root}"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
[[ -z "$TARGET_HOME" || "$TARGET_HOME" == "/" ]] && TARGET_HOME="$HOME"

SSH_DIR="$TARGET_HOME/.ssh"
AUTH_KEYS="$SSH_DIR/authorized_keys"

log "配置目录：$SSH_DIR"
mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"
touch "$AUTH_KEYS"
chmod 600 "$AUTH_KEYS"

# 去掉已有换行后精确匹配，避免重复追加
if grep -qF -- "$PUBKEY" "$AUTH_KEYS"; then
    log "公钥已存在，跳过写入。"
else
    echo "$PUBKEY" >> "$AUTH_KEYS"
    log "公钥已追加到 $AUTH_KEYS"
fi

# 属主归位（sudo 运行时可能被写成 root 属主）
chown "$(id -u "$TARGET_USER"):$(id -g "$TARGET_USER")" "$SSH_DIR" "$AUTH_KEYS"

# ---------------------------------------------------------------------------
# 3. 修改 sshd 配置：开启密码登录 + 公钥登录
# ---------------------------------------------------------------------------
backup_config() {
    local cfg="$1"
    if [[ -f "$cfg" && ! -f "${cfg}.bak.$(date +%Y%m%d%H%M%S)" ]]; then
        cp -a "$cfg" "${cfg}.bak.$(date +%Y%m%d%H%M%S)"
        log "已备份配置：${cfg}.bak.$(date +%Y%m%d%H%M%S)"
    fi
}

set_sshd_option() {
    # set_sshd_option <配置文件> <关键字> <值>
    local cfg="$1" key="$2" val="$3"
    mkdir -p "$(dirname "$cfg")"
    touch "$cfg"
    backup_config "$cfg"

    # 注释掉所有同名有效行（含前导空格/注释行），再追加一行生效配置
    sed -i -E "s/^[#[:space:]]*${key}\b.*/# &/I" "$cfg"
    echo "${key} ${val}" >> "$cfg"
    log "配置 $cfg : ${key} = ${val}"
}

# 主配置文件
set_sshd_option "$SSHD_CONFIG" "PasswordAuthentication" "yes"
set_sshd_option "$SSHD_CONFIG" "PubkeyAuthentication"   "yes"
set_sshd_option "$SSHD_CONFIG" "PermitRootLogin"       "$PERMIT_ROOT"
set_sshd_option "$SSHD_CONFIG" "ChallengeResponseAuthentication" "yes"
set_sshd_option "$SSHD_CONFIG" "UsePAM"                  "yes"

# Kali / 云镜像常通过 sshd_config.d 下的 drop-in 覆盖主配置，需同步放开
if [[ -d "$SSHD_CONFIG_DIR" ]]; then
    # 常见的覆盖文件：50-cloud-init.conf / 60-cloudimg-settings.conf
    for dropin in "$SSHD_CONFIG_DIR"/*.conf; do
        [[ -f "$dropin" ]] || continue
        if grep -Eq '^\s*#?\s*PasswordAuthentication\s+no' "$dropin"; then
            warn "检测到 $dropin 强制关闭密码登录，写入覆盖配置..."
            set_sshd_option "$dropin" "PasswordAuthentication" "yes"
        fi
    done
    # 统一写入一份兜底 drop-in，确保主配置不被反向覆盖
    set_sshd_option "$SSHD_CONFIG_DIR/99-enable-auth.conf" "PasswordAuthentication" "yes"
    set_sshd_option "$SSHD_CONFIG_DIR/99-enable-auth.conf" "PubkeyAuthentication"   "yes"
fi

# ---------------------------------------------------------------------------
# 4. 校验配置语法，启用并重启服务
# ---------------------------------------------------------------------------
log "校验 sshd 配置语法..."
if ! /usr/sbin/sshd -t; then
    err "sshd 配置语法校验失败，请检查上方备份文件后回滚。"
    exit 1
fi

log "启用并重启 $SSHD_SERVICE 服务..."
systemctl enable "$SSHD_SERVICE"
systemctl restart "$SSHD_SERVICE"

sleep 1
if systemctl is-active --quiet "$SSHD_SERVICE"; then
    log "SSH 服务运行正常。"
else
    err "SSH 服务未正常运行，日志如下："
    journalctl -u "$SSHD_SERVICE" --no-pager -n 30 || true
    exit 1
fi

# ---------------------------------------------------------------------------
# 5. 输出状态与连接信息
# ---------------------------------------------------------------------------
echo
log "===== SSH 服务状态 ====="
systemctl --no-pager --full status "$SSHD_SERVICE" | head -n 8 || true

echo
log "===== 监听端口 ====="
ss -tlnp 2>/dev/null | grep -E ':22\b' || warn "未在 22 端口检测到监听。"

echo
log "===== 本机 IP ====="
hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^$' || true

echo
log "完成。远程可使用以下方式连接："
echo "    密码登录： ssh <用户名>@<本机IP>"
echo "    公钥登录： ssh -i <私钥路径> <用户名>@<本机IP>"
echo
warn "提示：若仍无法密码登录，请检查防火墙(ufw/iptables)是否放行 22 端口。"
#（注：内容由AI生成）
