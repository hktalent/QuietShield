#!/bin/bash
# qshield_ctl.sh — QuietShield + 51pwn 服务栈的启动 / 状态 / 监测 / 恢复
#
# tmux 会话 quietshield 三个窗口：
#   server   Server.py（前台守护，退出即自动拉起）
#   stack    startAllSs.sh 周期自愈（check 失败才 start）
#   monitor  本地 + 公网健康监测，异常时自动恢复并落日志
#
# 用法:
#   qshield_ctl.sh start | stop | restart | status | check | monitor
#   qshield_ctl.sh supervise-server | supervise-stack   （tmux 窗口内部使用）
#
# 可调环境变量:
#   QS_PYTHON   python 解释器（默认 anaconda3 的 python3，缺省退回 PATH 里的 python3）
#   INTERVAL    监测间隔秒数（默认 60）
#   STACK_INTERVAL  栈自愈检查间隔秒数（默认 120）

set -u

QS_DIR="/Users/51pwn/MyWork/QuietShield"
STACK_DIR="/Users/51pwn/MyWork/goSqlite_gorm"
START_ALL="$STACK_DIR/startAllSs.sh"
SESSION="quietshield"
SELF="$QS_DIR/qshield_ctl.sh"
PORT=8808
LOCAL_URL="https://127.0.0.1:${PORT}"
PUBLIC_URL="https://zs.51pwn.com"
CF_CONTAINER="51pwn-cloudflared"
LOG_FILE="$HOME/Library/Logs/QuietShield/guard.log"
INTERVAL="${INTERVAL:-60}"
STACK_INTERVAL="${STACK_INTERVAL:-120}"

if [ -n "${QS_PYTHON:-}" ]; then
    PY="$QS_PYTHON"
elif [ -x /Users/51pwn/anaconda3/bin/python3 ]; then
    PY=/Users/51pwn/anaconda3/bin/python3
else
    PY="$(command -v python3 || echo python3)"
fi

mkdir -p "$(dirname "$LOG_FILE")"

log() {
    echo "[qshield $(date '+%F %T')] $*" | tee -a "$LOG_FILE"
}

is_ok_code() {
    case "$1" in
        2*|3*) return 0 ;;
        *)     return 1 ;;
    esac
}

local_code()  { curl -k -s -o /dev/null -m 8  -w '%{http_code}' "$LOCAL_URL"  2>/dev/null || echo 000; }
public_code() { curl -s   -o /dev/null -m 15 -w '%{http_code}' "$PUBLIC_URL" 2>/dev/null || echo 000; }

port_pid() {
    lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t 2>/dev/null | head -1
}

cf_running() {
    [ "$(docker inspect -f '{{.State.Running}}' "$CF_CONTAINER" 2>/dev/null)" = "true" ]
}

session_exists() { tmux has-session -t "$SESSION" 2>/dev/null; }

window_exists() {
    tmux list-windows -t "$SESSION" -F '#{window_name}' 2>/dev/null | grep -qx "$1"
}

# ---------- 服务守护 ----------

supervise_server() {
    cd "$QS_DIR" || { log "目录不存在: $QS_DIR"; return 1; }
    while :; do
        "$PY" ./Server.py
        log "Server.py 退出(code=$?)，3s 后重启"
        sleep 3
    done
}

supervise_stack() {
    cd "$STACK_DIR" || { log "目录不存在: $STACK_DIR"; return 1; }
    while :; do
        if ! sh "$START_ALL" check >/dev/null 2>&1; then
            log "服务栈检查失败，触发自愈: startAllSs.sh"
            sh "$START_ALL" 2>&1 | tail -n 20
            log "自愈流程结束"
        fi
        sleep "$STACK_INTERVAL"
    done
}

# ---------- 控制命令 ----------

ensure_session() {
    if ! session_exists; then
        tmux new-session -d -s "$SESSION" -n server "$SELF supervise-server"
        log "已创建 tmux 会话 $SESSION"
    fi
    window_exists server  || tmux new-window -t "$SESSION" -n server  "$SELF supervise-server"
    window_exists stack   || tmux new-window -t "$SESSION" -n stack   "$SELF supervise-stack"
    window_exists monitor || tmux new-window -t "$SESSION" -n monitor "$SELF monitor"
}

cmd_start() {
    ensure_session
    sleep 2
    local code
    code=$(local_code)
    if is_ok_code "$code"; then
        log "启动完成：本地 ${LOCAL_URL} -> ${code}"
    else
        log "启动后本地探测仍异常(${code})，请看 tmux: tmux attach -t $SESSION"
    fi
    cloud_status
}

cmd_stop() {
    session_exists && tmux kill-session -t "$SESSION" && log "已关闭 tmux 会话 $SESSION"
    local pid
    pid=$(port_pid)
    if [ -n "$pid" ]; then
        kill "$pid" 2>/dev/null && log "已停止 Server.py (pid=$pid)"
    fi
}

cmd_restart() {
    cmd_stop
    sleep 2
    cmd_start
}

cloud_status() {
    if cf_running; then
        log "cloudflared 容器 $CF_CONTAINER 运行中"
    else
        log "cloudflared 容器 $CF_CONTAINER 未运行"
    fi
}

cmd_status() {
    echo "== quietshield 状态 =="
    if session_exists; then
        echo "tmux 会话      : 存在（$(tmux list-windows -t "$SESSION" -F '#{window_name}' | paste -sd' ' -)）"
    else
        echo "tmux 会话      : 缺失"
    fi

    local pid code pcode
    pid=$(port_pid)
    echo "Server.py      : ${pid:-未运行}（端口 ${PORT}）"
    code=$(local_code)
    echo "本地 ${LOCAL_URL}  : ${code}"
    pcode=$(public_code)
    echo "公网 ${PUBLIC_URL} : ${pcode}"

    if cf_running; then
        echo "cloudflared    : $CF_CONTAINER 运行中"
    else
        echo "cloudflared    : $CF_CONTAINER 未运行"
    fi

    echo "-- 服务栈容器 --"
    docker ps -a --format '  {{.Names}}\t{{.Status}}' \
        --filter name=51pwn-platform --filter name=51pwn-nginx \
        --filter name=51pwn-cloudflared --filter name=e2e_chat \
        --filter name=ws-scrcpy-home --filter name=strategy-web 2>/dev/null
    echo "日志           : $LOG_FILE"
}

cmd_check() {
    local fail=0 code pcode
    code=$(local_code)
    pcode=$(public_code)
    is_ok_code "$code"  || { echo "FAIL 本地 ${LOCAL_URL} -> ${code}"; fail=1; }
    is_ok_code "$pcode" || { echo "FAIL 公网 ${PUBLIC_URL} -> ${pcode}"; fail=1; }
    cf_running          || { echo "FAIL 容器 ${CF_CONTAINER} 未运行"; fail=1; }
    [ "$fail" -eq 0 ] && echo "OK 本地=${code} 公网=${pcode}"
    return "$fail"
}

cmd_monitor() {
    log "监测启动（间隔 ${INTERVAL}s），日志: $LOG_FILE"
    while :; do
        local code pcode pid
        code=$(local_code)
        pcode=$(public_code)

        if ! is_ok_code "$code"; then
            log "本地异常 code=${code}，重启 Server.py"
            pid=$(port_pid)
            [ -n "$pid" ] && kill "$pid" 2>/dev/null
            ! session_exists && ensure_session
        fi

        if ! is_ok_code "$pcode"; then
            log "公网异常 code=${pcode}，执行 startAllSs.sh 自愈"
            sh "$START_ALL" 2>&1 | tail -n 15
        fi

        if is_ok_code "$code" && is_ok_code "$pcode"; then
            log "ok local=${code} public=${pcode}"
        fi
        sleep "$INTERVAL"
    done
}

case "${1:-}" in
    start)            cmd_start ;;
    stop)             cmd_stop ;;
    restart)          cmd_restart ;;
    status)           cmd_status ;;
    check)            cmd_check ;;
    monitor)          cmd_monitor ;;
    supervise-server) supervise_server ;;
    supervise-stack)  supervise_stack ;;
    *)
        echo "用法: $0 {start|stop|restart|status|check|monitor}" >&2
        exit 2
        ;;
esac
