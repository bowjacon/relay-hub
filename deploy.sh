#!/usr/bin/env bash
set -Eeuo pipefail

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

if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
elif [ -e "$APP_DIR" ]; then
  echo "目标目录已存在但不是 Git 仓库：$APP_DIR" >&2
  exit 1
else
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
npm install --omit=dev
mkdir -p data logs
[ -f .env ] || cp .env.example .env

set -a
# shellcheck disable=SC1091
. ./.env
set +a

start_service() {
  nohup bash -c 'while true; do RELAY_HUB_SUPERVISED=1 npm start; code=$?; if [ "$code" -ne 75 ]; then exit "$code"; fi; sleep 1; done' > logs/console.log 2>&1 &
  echo $! > .relay-hub.pid
  sleep 1
  if ! kill -0 "$(cat .relay-hub.pid)" 2>/dev/null; then
    echo "Relay Hub 启动失败，请查看 $APP_DIR/logs/console.log" >&2
    exit 1
  fi
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
  if [ -f .relay-hub.pid ]; then
    stop_tree "$(cat .relay-hub.pid)"
  fi
  for pid in $(fuser -n tcp "$PORT" 2>/dev/null || true); do
    stop_tree "$pid"
  done
  sleep 1
  for pid in $(fuser -n tcp "$PORT" 2>/dev/null || true); do
    kill -KILL "$pid" 2>/dev/null || true
  done
}

if [ -f .relay-hub.pid ] && kill -0 "$(cat .relay-hub.pid)" 2>/dev/null; then
  if [ "${RELAY_HUB_RESTART:-0}" = "1" ]; then
    stop_service
    start_service
    echo "Relay Hub 已重启，PID $(cat .relay-hub.pid)"
  else
    echo "Relay Hub 已在运行，PID $(cat .relay-hub.pid)"
  fi
else
  if [ "${RELAY_HUB_RESTART:-0}" = "1" ] && [ -n "$(fuser -n tcp "$PORT" 2>/dev/null || true)" ]; then
    stop_service
  fi
  start_service
  echo "Relay Hub 已启动，PID $(cat .relay-hub.pid)"
fi

echo "Relay Hub 已部署：http://127.0.0.1:${PORT}"
echo "数据目录：$APP_DIR/data"
echo "日志目录：$APP_DIR/logs"
