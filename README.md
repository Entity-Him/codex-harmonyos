# Codex on HarmonyOS — 鸿蒙一键移植包

让人人可复刻的方案：在鸿蒙 PC 上跑起 OpenAI Codex CLI，直连 DeepSeek 或 OpenAI。零二进制、零原生模块、纯文本工具链，一个脚本装好。

已实测：本机跑通 `codex-cli 0.147.0`（linux-arm64），DeepSeek 直连 `https://api.deepseek.com`（Responses API，**不带 /v1**），默认模型 `deepseek-v4-flash`。

## 1. 简介

鸿蒙系统环境与常规 Linux 差异大，官方 Codex CLI 无法直接安装。本仓库提供一套**纯文本方案**（sh + Node.js + Python，全部零依赖），把 Codex CLI 移植到鸿蒙 PC：

- 安装器从 npm registry 直下 `@openai/codex` 的 `linux-arm64` 平台 tarball
- 用自签名工具给 ELF 注入 `.codesign` 段，绕过鸿蒙 execve 代码签名校验
- 软链 `~/.local/bin/codex`，配好 `config.toml` 即可用
- 升级/回滚/校验一条命令搞定

## 2. 为什么需要

鸿蒙系统的限制让「正常」安装方式全部失效，本仓库逐条给出解法：

| 鸿蒙限制 | 后果 | 本仓库解法 |
| --- | --- | --- |
| execve 代码签名校验 | 未签名 ELF 直接 `EACCES`，无法执行 | `tools/self-sign.py` 注入 `.codesign` 段（自签名） |
| `node -p process.platform` = `openharmony` | npm 平台检测失败，`npm i` 装不上 | 安装器直下平台 tarball（`linux-arm64` dist-tag） |
| rustls/reqwest 找不到默认根证书 | HTTPS 握手失败，`error sending request` | `SSL_CERT_FILE` 显式指定 |
| 无编译器 / 无系统 bubblewrap / `/tmp` 只读 / 硬链接 EPERM | 常规编译、沙箱、临时文件、安装方案不可用 | 纯文本方案逐一绕开（见「限制」章） |

## 3. 安全声明

本仓库值得你审阅后再用，先说清它做了什么、不做什么：

- **仓库全部为纯文本/纯 JS/纯 Python**，不含可执行二进制与原生模块，任何一行都能直接看。
- **不删除/不加密/不外传你的数据**。安装器只读 `~/.dsh/.credentials.yaml` 里的 API Key 用于注入环境变量提示，不落盘、不上传。
- **不注册系统服务**。不写 systemd / 服务表 / 开机自启，装完即走。
- **不要求 root**。全程以普通用户身份运行，所有写入都在你的家目录下：`~/.codex-hm/`（安装与备份）、`~/.local/bin/`（软链）、`~/.codex/`（配置）。
- **不改系统路径**。不碰 `/usr`、`/etc` 等系统目录，卸载即还原。
- **网络行为最小**。只在安装/对话/更新时访问 npm registry、api.deepseek.com、api.openai.com，无其他外联。
- **完全可审阅**。无混淆、无二进制、无动态下发脚本。
- **可逆卸载**：删掉软链 + 删 `~/.codex-hm/` + 恢复 `~/.codex/config.toml` 即完全还原。

## 4. 快速开始

```sh
# 1. 安装（下载 tarball → 签名 → 软链 → 合并配置）
sh scripts/codex-install.sh install

# 2. 配环境变量（安装器也会打印提示；DEEPSEEK_API_KEY 可自动从 ~/.dsh/.credentials.yaml 读取）
export DEEPSEEK_API_KEY=sk-xxx
export SSL_CERT_FILE=/etc/ssl/certs/cacert.pem   # rustls 找不到默认根证书，必须显式指定

# 3. 校验（版本 + 对话探活）
sh scripts/codex-install.sh verify

# 4. 开聊
codex exec --skip-git-repo-check "你好"
```

> 非 git 目录需加 `--skip-git-repo-check`；`SSL_CERT_FILE` 建议写进 `~/.zshrc`。

## 5. 工具链

`sh scripts/codex-install.sh <子命令>`，自动定位 node/python3 后委托 `scripts/codex-install.mjs`：

| 子命令 | 作用 | 常用参数 |
| --- | --- | --- |
| `install` | 下载 `linux-arm64` tarball → self-sign 签名 → 软链 → 合并 `config.toml`（幂等：同版本已装则跳过下载/签名，仅重链） | `--version 0.147.0`、`--prefix ~/.codex-hm` |
| `verify` | 校验二进制可执行 + `--version` + 对话探活 | — |
| `update` | 先备份当前签名二进制，再安装新版本并校验 | `--version` |
| `rollback` | 从最近一次备份恢复签名二进制（自动用「写临时文件 + rename」绕过 HMFS 密封） | `--prefix` |

> 若签名失效需重签：删 `~/.codex-hm/codex-<版本>/.installed` 标记后重跑 install，会强制全量重装并重签。

通用参数：

- `--version <版本>`：指定版本号（默认取 npm 的 `linux-arm64` dist-tag，即最新）
- `--prefix <目录>`：安装根目录（默认 `~/.codex-hm`）

安装器会同时给 `codex`、`codex-code-mode-host`、`rg` 三个 `aarch64-unknown-linux-musl` 二进制签名。

## 6. 配置

模板在 `config/codex.config.toml`，安装器会把 deepseek provider 段合并进 `~/.codex/config.toml`（已存在则跳过，不覆盖你已有配置）。

默认使用 DeepSeek 自定义 provider：

```toml
model = "deepseek-v4-flash"
model_provider = "deepseek"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com"   # Responses API，不带 /v1
env_key = "DEEPSEEK_API_KEY"
wire_api = "responses"
```

切到 OpenAI 内置后端（gpt 系列）——注释切换：

```toml
# model = "gpt-5.6-sol"
# model_provider = "openai"
# 环境变量: OPENAI_API_KEY=sk-...
```

## 7. 鸿蒙适配细节

**签名机制原理**：鸿蒙 execve 校验 ELF 的 `.codesign` 段（fs-verity 风格）。`tools/self-sign.py`（Python3，仅用 `hashlib`）给 ELF 末尾注入 4KB 对齐的 `.codesign` 段，写入 merkle 根哈希 + descriptor + SHA-256 签名，以 `FLAG_SELF_SIGN` 让验签侧按自签名识别。与上游 binary-sign-tool 产物在段级等价。

**何时需重签**：升级后新二进制未签名，必须重签。安装器的 `install` 在首次安装或换版本时从全新 tarball 解压（天然无旧段）后即签名；同版本已装则幂等跳过，仅重链。`update` 备份旧签名二进制以便回滚。注意 `self-sign.py` 只加签、不剥旧段，手动重签同一文件前需先 `llvm-objcopy --remove-section .codesign <elf>`。

## 8. 限制

- **无系统 bubblewrap**：用 codex 内置 bwrap，启动警告 `could not find bubblewrap` 无害。
- **无编译器**：本仓库纯文本方案不依赖编译；如需编译请另备工具链。
- **`/tmp` 只读**：所有临时文件写入安装目录（`~/.codex-hm/`），不碰 `/tmp`。
- **硬链接 EPERM**：鸿蒙禁硬链接，本方案一律用软链/复制。
- **`/dev/shm` 掉电丢**：内存文件系统断电即清空，签名工具已 vendor 为 `tools/self-sign.py`，勿依赖 `/dev/shm`。
- **HMFS 密封已执行 ELF**：升级/回滚后手动 `cp` 覆写 `bin/codex` 会报 `EPERM`，回滚子命令已自动用「写临时文件 + rename」绕过（详见 TROUBLESHOOTING 第 8 条）。

## 9. 许可证与致谢

- 本仓库：**MIT**（见 [LICENSE](./LICENSE)）。
- `tools/self-sign.py`：来自 [hqzing/ohos-bst-light](https://github.com/hqzing/ohos-bst-light)（MIT），vendored 供离线使用。
- Codex 本体：[openai/codex](https://github.com/openai/codex)（Apache-2.0）。

## 10. 更新记录

### 2026-08-17 — 首发：鸿蒙一键移植包

- 安装/校验/升级/回滚四子命令，幂等可复跑
- 直连 DeepSeek（Responses API，不带 /v1），默认模型 `deepseek-v4-flash`
- 自签名 `.codesign` 段绕开 execve 签名校验
- 平台 tarball 直下，绕开 npm 平台检测失败
- `SSL_CERT_FILE` 显式指定，绕开 rustls 缺根证书
- vendor `tools/self-sign.py`，摆脱 `/dev/shm` 易失依赖
