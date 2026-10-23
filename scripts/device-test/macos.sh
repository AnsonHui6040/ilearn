#!/usr/bin/env bash
# macOS 裝置測試：./scripts/device-test/macos.sh [--mock] [--interactive] [--keep]
# 這支腳本不含任何帳密；帳密寫在 credentials.local（不會被 git 追蹤）。
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
HERE="scripts/device-test"

if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node，請先安裝 Node 22.13 以上（例如 brew install node）。" >&2
  exit 1
fi
NODE_VER="$(node -p 'process.versions.node')"
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  echo "Node 版本是 ${NODE_VER}，需要 22.13 以上。" >&2
  exit 1
fi

MOCK=0
for a in "$@"; do [ "$a" = "--mock" ] && MOCK=1; done

if [ "$MOCK" = "0" ]; then
  if [ -f "$HERE/credentials.local" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        ''|'#'*) continue ;;
        ILEARN_TEST_USERNAME=*) export ILEARN_TEST_USERNAME="${line#*=}" ;;
        ILEARN_TEST_PASSWORD=*) export ILEARN_TEST_PASSWORD="${line#*=}" ;;
      esac
    done < "$HERE/credentials.local"
  else
    cp "$HERE/credentials.example" "$HERE/credentials.local"
    chmod 600 "$HERE/credentials.local"
    echo "已建立 $HERE/credentials.local，請用文字編輯器填入學號（密碼可留空，執行時再輸入），存檔後重新執行。" >&2
    exit 1
  fi
fi

if [ ! -d node_modules ]; then
  npm ci
fi
npm run build

exec node "$HERE/run.mjs" "$@"
