#!/bin/zsh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="$HOME/.nvm"
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then source "$NVM_DIR/nvm.sh"; fi
fi
if ! command -v node >/dev/null 2>&1; then
  echo '未找到 Node.js，请先安装 Node.js 后重试。'
  read -k 1
  exit 1
fi
node runner/server.mjs &
runner_pid=$!
trap 'kill "$runner_pid" 2>/dev/null' EXIT INT TERM
for attempt in {1..60}; do
  if curl -fsS "http://127.0.0.1:${PORT:-4310}/api/bootstrap" >/dev/null 2>&1; then
    open "http://127.0.0.1:${PORT:-4310}"
    break
  fi
  if ! kill -0 "$runner_pid" 2>/dev/null; then break; fi
  sleep 1
done
wait "$runner_pid"
