#!/bin/sh
# codex-install.sh — sh 包装，自动定位 node/python3 并委托 codex-install.mjs
# 用法: sh scripts/codex-install.sh install|verify|update|rollback [--version X] [--prefix DIR]
NODE_BIN="${NODE_BIN:-/data/service/hnp/node.org/node_v24.13.0/bin/node}"
export PYTHON_BIN="${PYTHON_BIN:-/data/service/hnp/bin/python3}"
DIR=$(cd "$(dirname "$0")" && pwd)
exec "$NODE_BIN" "$DIR/codex-install.mjs" "$@"
