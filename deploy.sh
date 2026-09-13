#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOY_STARTED_AT=$SECONDS
DEPLOY_TIMEOUT_GIT="${DEPLOY_TIMEOUT_GIT:-180}"
DEPLOY_TIMEOUT_NPM="${DEPLOY_TIMEOUT_NPM:-300}"
DEPLOY_TIMEOUT_STOP="${DEPLOY_TIMEOUT_STOP:-30}"
DEPLOY_TIMEOUT_START="${DEPLOY_TIMEOUT_START:-30}"
export GIT_TERMINAL_PROMPT="${GIT_TERMINAL_PROMPT:-0}"
export npm_config_fetch_timeout="${npm_config_fetch_timeout:-60000}"
export npm_config_fetch_retries="${npm_config_fetch_retries:-1}"
export npm_config_audit="${npm_config_audit:-false}"
export npm_config_fund="${npm_config_fund:-false}"

timestamp() { date '+%Y-%m-%d %H:%M:%S'; }
progress() { printf '[%s] %s\n' "$(timestamp)" "$*"; }

run_step() {
  local label="$1" timeout_seconds="$2"
  shift 2
  local started=$SECONDS pid elapsed status
  progress "开始：$label（超时 ${timeout_seconds}s）"
  "$@" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    sleep 2
    elapsed=$((SECONDS - started))
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    if [ "$elapsed" -ge "$timeout_seconds" ]; then
      progress "超时：$label（${elapsed}s），正在终止任务"
      kill -TERM "$pid" 2>/dev/null || true
      sleep 3
      kill -KILL "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      progress "失败：$label 已超时"
      return 124
    fi
    progress "进行中：$label（已用 ${elapsed}s/${timeout_seconds}s）"
  done
  if wait "$pid"; then
    status=0
  else
    status=$?
  fi
  elapsed=$((SECONDS - started))
  if [ "$status" -eq 0 ]; then
    progress "完成：$label（耗时 ${elapsed}s）"
  else
    progress "失败：$label（退出码 ${status}，耗时 ${elapsed}s）"
  fi
  return "$status"
}

on_error() {
  local status=$?
  progress "部署失败（退出码 ${status}，总耗时 $((SECONDS - DEPLOY_STARTED_AT))s）"
  progress "请检查：${APP_DIR:-$HOME/relay-hub}/logs/console.log"
  exit "$status"
}
trap on_error ERR

REPO_URL="${REPO_URL:-https://github.com/bowjacon/relay-hub.git}"
APP_DIR="${APP_DIR:-$HOME/relay-hub}"

if [ -f "$APP_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$APP_DIR/.env"
  set +a
fi
PORT="${PORT:-4173}"

if ! command -v git >/dev/null 2>&1; then
  echo "需要先安装 Git" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "需要先安装 Node.js 18+ 和 npm" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "需要先安装 curl（用于确认服务已启动）" >&2
  exit 1
fi

if [ -d "$APP_DIR/.git" ]; then
  run_step "拉取 Git 更新" "$DEPLOY_TIMEOUT_GIT" git -C "$APP_DIR" pull --ff-only
elif [ -e "$APP_DIR" ]; then
  echo "目标目录已存在但不是 Git 仓库：$APP_DIR" >&2
  exit 1
else
  run_step "克隆 Git 仓库" "$DEPLOY_TIMEOUT_GIT" git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
run_step "安装 npm 依赖" "$DEPLOY_TIMEOUT_NPM" npm install --omit=dev
mkdir -p data logs
[ -f .env ] || cp .env.example .env

set -a
# shellcheck disable=SC1091
. ./.env
set +a

start_service() {
  progress "准备启动 Relay Hub"
  nohup bash -c 'while true; do RELAY_HUB_SUPERVISED=1 npm start; code=$?; if [ "$code" -ne 75 ]; then exit "$code"; fi; sleep 1; done' > logs/console.log 2>&1 &
  echo $! > .relay-hub.pid
  local pid="$(cat .relay-hub.pid)" started=$SECONDS elapsed
  while kill -0 "$pid" 2>/dev/null; do
    if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
      progress "服务已就绪：http://127.0.0.1:${PORT}（耗时 $((SECONDS - started))s）"
      return 0
    fi
    elapsed=$((SECONDS - started))
    if [ "$elapsed" -ge "$DEPLOY_TIMEOUT_START" ]; then
      progress "服务启动超时（${elapsed}s），最近日志："
      tail -n 30 logs/console.log >&2 || true
      return 124
    fi
    progress "等待服务启动（已用 ${elapsed}s/${DEPLOY_TIMEOUT_START}s）"
    sleep 2
  done
  progress "服务进程已退出，最近日志："
  tail -n 30 logs/console.log >&2 || true
  return 1
}

stop_tree() {
  local pid="$1"
  case "$pid" in
    ''|*[!0-9]*) return ;;
  esac
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    stop_tree "$child"
  done
  kill -TERM "$pid" 2>/dev/null || true
}

stop_service() {
  local started=$SECONDS elapsed
  progress "停止旧服务（超时 ${DEPLOY_TIMEOUT_STOP}s）"
  if [ -f .relay-hub.pid ]; then
    stop_tree "$(cat .relay-hub.pid)"
  fi
  for pid in $(fuser -n tcp "$PORT" 2>/dev/null || true); do
    stop_tree "$pid"
  done
  while [ -n "$(fuser -n tcp "$PORT" 2>/dev/null || true)" ]; do
    elapsed=$((SECONDS - started))
    if [ "$elapsed" -ge "$DEPLOY_TIMEOUT_STOP" ]; then
      progress "停止旧服务超时，强制释放端口 ${PORT}"
      for pid in $(fuser -n tcp "$PORT" 2>/dev/null || true); do kill -KILL "$pid" 2>/dev/null || true; done
      break
    fi
    progress "等待端口 ${PORT} 释放（已用 ${elapsed}s/${DEPLOY_TIMEOUT_STOP}s）"
    sleep 1
  done
  progress "旧服务已停止（耗时 $((SECONDS - started))s）"
}

if [ -f .relay-hub.pid ] && kill -0 "$(cat .relay-hub.pid)" 2>/dev/null; then
  if [ "${RELAY_HUB_RESTART:-0}" = "1" ]; then
    stop_service
    start_service
    progress "Relay Hub 已重启，PID $(cat .relay-hub.pid)"
  else
    progress "Relay Hub 已在运行，PID $(cat .relay-hub.pid)"
  fi
else
  if [ "${RELAY_HUB_RESTART:-0}" = "1" ] && [ -n "$(fuser -n tcp "$PORT" 2>/dev/null || true)" ]; then
    stop_service
  fi
  start_service
  progress "Relay Hub 已启动，PID $(cat .relay-hub.pid)"
fi

progress "部署完成：http://127.0.0.1:${PORT}（总耗时 $((SECONDS - DEPLOY_STARTED_AT))s）"
progress "数据目录：$APP_DIR/data"
progress "日志目录：$APP_DIR/logs"
