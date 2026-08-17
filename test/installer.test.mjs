import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeConfig, extractProviderBlock } from '../scripts/codex-install.mjs';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const template = fs.readFileSync(path.join(repo, 'config', 'codex.config.toml'), 'utf8');
const block = extractProviderBlock(template);

assert(block.startsWith('[model_providers.deepseek]'), 'block 应以 [model_providers.deepseek] 开头');
assert(block.includes('wire_api = "responses"'), 'block 应含 responses wire_api');

const empty = mergeConfig('', block);
assert(empty === block, '空配置应返回模板块');

const cur = 'model = "gpt-5.6-sol"\nmodel_provider = "openai"\n';
const merged = mergeConfig(cur, block);
assert(merged.startsWith(cur), '应保留用户已有配置');
assert(merged.includes('[model_providers.deepseek]'), '应追加 deepseek 块');
assert(merged.indexOf(cur) < merged.indexOf('[model_providers.deepseek]'), '用户配置应在 deepseek 块之前');

const again = mergeConfig(merged, block);
assert(again === merged, '含 deepseek 块时不应重复追加（幂等）');

console.log('installer.test 全部通过');
