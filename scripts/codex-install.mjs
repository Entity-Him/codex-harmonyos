#!/usr/bin/env node
// codex-install.mjs — Codex CLI 鸿蒙安装/验证/升级/回滚（零依赖，node 内置模块）
// 用法:
//   node codex-install.mjs install [--version 0.147.0] [--prefix ~/.codex-hm]
//   node codex-install.mjs verify
//   node codex-install.mjs update [--version 0.147.0]
//   node codex-install.mjs rollback
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HOME = process.env.HOME || '/storage/Users/currentUser';
export const NODE_BIN = process.env.NODE_BIN || '/data/service/hnp/node.org/node_v24.13.0/bin/node';
export const PYTHON_BIN = process.env.PYTHON_BIN || '/data/service/hnp/bin/python3';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'https://registry.npmjs.org/@openai/codex';
const SELF_SIGN = path.join(REPO, 'tools', 'self-sign.py');
const TEMPLATE = path.join(REPO, 'config', 'codex.config.toml');
const SIGN_TARGETS = [
  'vendor/aarch64-unknown-linux-musl/bin/codex',
  'vendor/aarch64-unknown-linux-musl/bin/codex-code-mode-host',
  'vendor/aarch64-unknown-linux-musl/codex-path/rg',
];

// ---- 纯函数（可单测） ----

export function extractProviderBlock(template) {
  const idx = template.indexOf('[model_providers.deepseek]');
  return idx >= 0 ? template.slice(idx).trimEnd() : '';
}

export function mergeConfig(existing, block) {
  if (!existing || !existing.trim()) return block;
  if (existing.includes('[model_providers.deepseek]')) return existing;
  return existing.replace(/\s+$/, '') + '\n\n' + block + '\n';
}

export async function resolveTarball(version) {
  const meta = await (await fetch(REGISTRY, { headers: { 'User-Agent': 'codex-harmonyos' } })).json();
  let ver;
  if (version && version !== 'latest') {
    ver = version.includes('linux-arm64') ? version : `${version}-linux-arm64`;
    if (!meta.versions[ver]) throw new Error(`版本 ${ver} 不存在`);
  } else {
    ver = meta['dist-tags']['linux-arm64'];
    if (!ver) throw new Error('npm 无 linux-arm64 dist-tag');
  }
  return { version: ver, url: `${REGISTRY}/-/codex-${ver}.tgz` };
}

export function readApiKey(envRef) {
  if (process.env[envRef]) return process.env[envRef];
  const cred = path.join(HOME, '.dsh', '.credentials.yaml');
  if (!fs.existsSync(cred)) return '';
  for (const line of fs.readFileSync(cred, 'utf8').split('\n')) {
    const m = line.match(new RegExp('^' + envRef + ':'));
    if (m) return line.replace(/^[^:]*:\s*/, '').trim();
  }
  return '';
}

// ---- 安装 ----

function binPath(pkg) { return path.join(pkg, SIGN_TARGETS[0]); }
function linkTarget() { return path.join(HOME, '.local', 'bin', 'codex'); }

function relink(pkg) {
  const bin = binPath(pkg);
  const link = linkTarget();
  fs.mkdirSync(path.dirname(link), { recursive: true });
  try { fs.unlinkSync(link); } catch {}
  fs.symlinkSync(bin, link);
}

function ensureConfig() {
  const cfg = path.join(HOME, '.codex', 'config.toml');
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  const block = extractProviderBlock(template);
  if (fs.existsSync(cfg)) {
    const merged = mergeConfig(fs.readFileSync(cfg, 'utf8'), block);
    fs.writeFileSync(cfg, merged);
  } else {
    fs.writeFileSync(cfg, template);
  }
}

function printEnvHint() {
  const key = readApiKey('DEEPSEEK_API_KEY');
  console.log('需要以下环境变量（已写入建议，可加入 ~/.zshrc）：');
  console.log(`  export DEEPSEEK_API_KEY=${key ? 'sk-…' + key.slice(-4) : '<未找到，请手动填入>'}   # 自动从 ~/.dsh/.credentials.yaml 读取`);
  console.log('  export SSL_CERT_FILE=/etc/ssl/certs/cacert.pem   # rustls 找不到默认根证书，必须显式指定');
  console.log('下一步: codex exec --skip-git-repo-check "你好"');
}

export async function cmdInstall({ version, prefix }) {
  const root = prefix || path.join(HOME, '.codex-hm');
  const { version: ver, url } = await resolveTarball(version);
  const pkg = path.join(root, `codex-${ver}`, 'package');
  const marker = path.join(root, `codex-${ver}`, '.installed');

  if (fs.existsSync(marker)) {
    relink(pkg);
    ensureConfig();
    console.log(`✅ 已安装 codex ${ver}（幂等跳过），重新软链`);
    printEnvHint();
    return;
  }

  fs.mkdirSync(path.join(root, `codex-${ver}`), { recursive: true });
  const tgz = path.join(root, `codex-${ver}.tgz`);
  console.log(`⬇ 下载 ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));

  console.log('📦 解压');
  const r0 = spawnSync('tar', ['-xzf', tgz, '-C', path.join(root, `codex-${ver}`)], { stdio: 'inherit' });
  if (r0.status !== 0) throw new Error('tar 解压失败');
  fs.unlinkSync(tgz);

  console.log('✍ 签名（self-sign.py 注入 .codesign 段）');
  for (const rel of SIGN_TARGETS) {
    const f = path.join(pkg, rel);
    if (!fs.existsSync(f)) { console.warn('  跳过缺失:', rel); continue; }
    const orig = f + '.orig';
    if (fs.existsSync(orig)) fs.copyFileSync(orig, f); else fs.copyFileSync(f, orig);
    const r = spawnSync(PYTHON_BIN, [SELF_SIGN, f], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`签名失败: ${rel}`);
  }
  fs.writeFileSync(marker, 'ok');

  relink(pkg);
  ensureConfig();
  console.log(`✅ 安装完成 codex ${ver} -> ${binPath(pkg)}`);
  printEnvHint();
}

// ---- 校验 ----

export function cmdVerify() {
  const link = linkTarget();
  if (!fs.existsSync(link)) { console.error('❌ 未安装（无软链，先 install）'); process.exit(1); }
  const r1 = spawnSync(link, ['--version'], { encoding: 'utf8' });
  const ver = (r1.stdout || '').trim().split('\n')[0] || (r1.stderr || '').trim().split('\n')[0];
  console.log('版本:', ver);
  if (r1.status !== 0) { console.error('❌ 二进制不可执行（未签名或签名失效，跑 install/update 重签）'); process.exit(1); }
  if (!process.env.SSL_CERT_FILE) process.env.SSL_CERT_FILE = '/etc/ssl/certs/cacert.pem';
  if (!process.env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = readApiKey('DEEPSEEK_API_KEY');
  if (!process.env.DEEPSEEK_API_KEY) { console.warn('⚠️ 可执行，但缺 DEEPSEEK_API_KEY（配 ~/.dsh/.credentials.yaml 或 export）'); process.exit(0); }
  const r2 = spawnSync(link, ['exec', '--skip-git-repo-check', '只回两个字：收到'], { encoding: 'utf8', env: process.env, cwd: HOME });
  if (r2.status === 0 && (r2.stdout || '').includes('收到')) { console.log('✅ 对话探活通过'); }
  else { console.warn('⚠️ 探活异常:', (r2.stdout || r2.stderr || '').slice(-300)); process.exit(1); }
}

function backupDir(root) {
  return path.join(root, '.codex-backups', new Date().toISOString().replace(/[:.]/g, '-'));
}

export function cmdUpdate({ version, prefix }) {
  const root = prefix || path.join(HOME, '.codex-hm');
  const cur = fs.readdirSync(root)
    .filter((d) => d.startsWith('codex-') && fs.statSync(path.join(root, d)).isDirectory());
  if (cur.length) {
    const bk = backupDir(root);
    fs.mkdirSync(bk, { recursive: true });
    for (const dir of cur) {
      const pkg = path.join(root, dir, 'package');
      for (const rel of SIGN_TARGETS) {
        const f = path.join(pkg, rel);
        if (fs.existsSync(f)) {
          fs.copyFileSync(f, path.join(bk, rel.replace(/\//g, '__')));
        }
      }
    }
    console.log(`📦 已备份当前 ${cur.join(', ')} 到 ${bk}`);
  }
  cmdInstall({ version, prefix }).then(() => cmdVerify());
}

export function cmdRollback({ prefix }) {
  const root = prefix || path.join(HOME, '.codex-hm');
  const bks = fs.existsSync(path.join(root, '.codex-backups'))
    ? fs.readdirSync(path.join(root, '.codex-backups')).sort() : [];
  if (!bks.length) { console.error('❌ 无可用备份'); process.exit(1); }
  const bk = path.join(root, '.codex-backups', bks[bks.length - 1]);
  const dirs = fs.readdirSync(root)
    .filter((d) => d.startsWith('codex-') && fs.statSync(path.join(root, d)).isDirectory())
    .sort();
  const pkg = path.join(root, dirs[dirs.length - 1], 'package');
  let restored = false;
  for (const rel of SIGN_TARGETS) {
    const src = path.join(bk, rel.replace(/\//g, '__'));
    const dst = path.join(pkg, rel);
    if (fs.existsSync(src)) { fs.copyFileSync(src, dst); restored = true; }
  }
  if (!restored) { console.error('❌ 备份内容为空'); process.exit(1); }
  relink(pkg);
  console.log(`↩ 已从 ${bk} 恢复签名二进制`);
  cmdVerify();
}

// ---- CLI 入口 ----

const argv = process.argv.slice(2);
const cmd = argv[0];
const args = { version: null, prefix: null };
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === '--version') args.version = argv[++i];
  if (argv[i] === '--prefix') args.prefix = argv[++i];
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (cmd === 'install') cmdInstall(args).catch((e) => { console.error('❌', e.message); process.exit(1); });
  else if (cmd === 'verify') cmdVerify();
  else if (cmd === 'update') cmdUpdate(args);
  else if (cmd === 'rollback') cmdRollback(args);
  else { console.error('用法: install|verify|update [--version]|rollback [--prefix]'); process.exit(2); }
}
