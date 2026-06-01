#!/usr/bin/env bash
#
# setup-telegram-bot-api.sh — build + install the official telegram-bot-api
# server locally (it is NOT on Homebrew). Companion to polygram's optional
# config.bot.apiRoot, for 2 GB file send/receive. localhost-only.
#
# Prereqs YOU must do first (cannot be automated — needs your Telegram login):
#   - Get api_id + api_hash from https://my.telegram.org → "API development tools"
#
# This script only builds the binary. After it finishes, follow the printed
# steps to wire the launchd job + polygram config. See docs/0.12.0-file-send.md.

set -euo pipefail

PREFIX="${1:-/opt/homebrew}"
DATA_DIR="$HOME/.telegram-bot-api"
BUILD_DIR="$(mktemp -d)"

echo "==> telegram-bot-api setup"
echo "    install prefix: $PREFIX"
echo "    data dir:       $DATA_DIR"
echo "    build dir:      $BUILD_DIR"

# 1. Build deps (Telegram's documented macOS path).
echo "==> installing build deps via Homebrew (gperf cmake openssl)"
brew install gperf cmake openssl zlib || true

# 2. Clone + build (TDLib-based; the official repo bundles the build steps).
echo "==> cloning tdlib/telegram-bot-api"
git clone --recursive https://github.com/tdlib/telegram-bot-api.git "$BUILD_DIR/telegram-bot-api"
cd "$BUILD_DIR/telegram-bot-api"
mkdir -p build && cd build

OPENSSL_ROOT="$(brew --prefix openssl)"
echo "==> cmake (OpenSSL at $OPENSSL_ROOT) — this compiles TDLib, takes several minutes"
cmake -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX:PATH="$PREFIX" \
      -DOPENSSL_ROOT_DIR="$OPENSSL_ROOT" \
      ..
cmake --build . --target install -j"$(sysctl -n hw.ncpu)"

# 3. Data dirs.
mkdir -p "$DATA_DIR/tmp"

echo
echo "==> DONE. Binary installed: $PREFIX/bin/telegram-bot-api"
"$PREFIX/bin/telegram-bot-api" --version || true
echo
echo "Next steps (manual — needs your api_id/api_hash):"
echo "  1. Edit ops/telegram-bot-api.plist.example:"
echo "       - replace API_ID_HERE / API_HASH_HERE with your my.telegram.org values"
echo "       - confirm the binary path ($PREFIX/bin/telegram-bot-api)"
echo "  2. cp ops/telegram-bot-api.plist.example ~/Library/LaunchAgents/com.telegram.bot-api.plist"
echo "  3. launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.telegram.bot-api.plist"
echo "  4. Verify it's up:  curl -s http://localhost:8081/  (expect a Telegram error JSON, not connection-refused)"
echo "  5. In ~/.polygram/config.json set:  \"bot\": { ..., \"apiRoot\": \"http://localhost:8081\" }"
echo "  6. Restart polygram:  launchctl kickstart -k gui/\$(id -u)/com.polygram.shumorobot"
echo "     Boot log should print: [polygram] using local Telegram Bot API server: http://localhost:8081"
echo
echo "Cleanup build dir: rm -rf $BUILD_DIR"
