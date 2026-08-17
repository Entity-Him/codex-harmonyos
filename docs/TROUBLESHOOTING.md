# Codex on HarmonyOS — 故障排查

每条 = 现象 + 原因 + 解决。都解决不了时，先跑 `sh scripts/codex-install.sh verify` 拿版本与探活结果再反馈。

## 1. `Permission denied` / EACCES 无法执行

- **现象**：执行 `codex` 或 `~/.local/bin/codex` 报 `Permission denied`（EACCES），文件明明有执行权限却跑不起来。
- **原因**：鸿蒙 execve 会做 ELF 代码签名校验，未注入 `.codesign` 段的二进制直接返回 EACCES。
- **解决**：跑 `sh scripts/codex-install.sh install`：未安装或换版本时会全量下载并签名；若同版本已装被幂等跳过，删 `~/.codex-hm/codex-<版本>/.installed` 标记后重跑 install 强制重装签名，或对目标二进制手动运行 `tools/self-sign.py`（先 `llvm-objcopy --remove-section .codesign` 剥旧段）。

## 2. 报 `error sending request`（HTTPS）

- **现象**：`codex exec` 或对话时报 `error sending request`，通常是 HTTPS 握手失败。
- **原因**：Codex 使用 rustls/reqwest，找不到系统默认根证书，无法建立 TLS 连接。
- **解决**：`export SSL_CERT_FILE=/etc/ssl/certs/cacert.pem`（可加入 `~/.zshrc` 持久化）。

## 3. 非 git 目录报 git 错误

- **现象**：在普通目录（非 git 仓库）跑 `codex exec` 报 git 相关错误，无法开始对话。
- **原因**：codex 默认要求在 git 仓库内执行，用于感知改动上下文。
- **解决**：`codex exec --skip-git-repo-check "你好"`，跳过 git 仓库检查。

## 4. 警告 `could not find bubblewrap`

- **现象**：启动时出现 `could not find bubblewrap` 警告。
- **原因**：鸿蒙系统不自带 bubblewrap 沙箱工具。
- **解决**：无害。codex 会回退到内置 bwrap 沙箱，忽略即可。

## 5. 警告 `Model metadata for ... not found`

- **现象**：出现 `Model metadata for <模型名> not found` 警告。
- **原因**：本地没有该模型的元数据文件。
- **解决**：无害。codex 回退到默认 model metadata，不影响对话，忽略即可。

## 6. 升级后 `codex --version` 仍旧版

- **现象**：执行 update/install 升级后，`codex --version` 显示的仍是旧版本号。
- **原因**：`~/.local/bin/codex` 软链没有更新到新版本二进制（或指向了旧安装目录）。
- **解决**：重跑 `sh scripts/codex-install.sh install`（幂等，会重新软链）或 `sh scripts/codex-install.sh update`，然后 `codex --version` 复核。

## 7. 签名工具在 `/dev/shm` 掉电丢

- **现象**：此前依赖 `/dev/shm` 下的签名工具，掉电/重启后工具消失、无法重签。
- **原因**：`/dev/shm` 是易失内存文件系统，断电即清空。
- **解决**：本仓库已 vendor `tools/self-sign.py`（离线可用），勿依赖 `/dev/shm`。

## 8. 手动 `cp` 覆写 `~/.codex-hm/.../bin/codex` 报 EPERM

- **现象**：升级/回滚后，手动 `cp` 直接覆写 `~/.codex-hm/.../bin/codex` 报 `EPERM`（Operation not permitted）。
- **原因**：鸿蒙 HMFS 会密封已执行的 ELF，禁止直接写入目标文件；但 rename 覆盖是允许的。
- **解决**：回滚子命令已自动用「写临时文件 + rename」绕过（`cp 源 临时文件 && mv 临时文件 目标`）。手动改文件也请用同样两步：先写临时文件，再 `mv` 覆盖。
