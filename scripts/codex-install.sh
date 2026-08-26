#!/bin/sh
# codex-install.sh — sh 包装，自动定位 node/python3 并委托 codex-install.mjs
# 用法: sh scripts/codex-install.sh install|verify|update|rollback [--version X] [--prefix DIR]

# NODE_BIN: 优先外部传入，其次 PATH 里的 node，最后回退 HarmonyOS 开发环境路径
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node 2>/dev/null)"
fi
if [ -z "$NODE_BIN" ] && [ -x /storage/Users/currentUser/deveco/deveco_tools/node/bin/node ]; then
  NODE_BIN=/storage/Users/currentUser/deveco/deveco_tools/node/bin/node
fi
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: 找不到 node。请安装 Node.js，或设置 NODE_BIN 环境变量。" >&2
  exit 1
fi

# PYTHON_BIN: 优先外部传入，其次 PATH 里的 python3，最后回退 HarmonyOS 路径
if [ -z "$PYTHON_BIN" ]; then
  PYTHON_BIN="$(command -v python3 2>/dev/null)"
fi
if [ -z "$PYTHON_BIN" ] && [ -x /data/service/hnp/bin/python3 ]; then
  PYTHON_BIN=/data/service/hnp/bin/python3
fi
if [ -z "$PYTHON_BIN" ]; then
  PYTHON_BIN=python3
fi
export PYTHON_BIN

DIR=$(cd "$(dirname "$0")" && pwd)
exec "$NODE_BIN" "$DIR/codex-install.mjs" "$@"
