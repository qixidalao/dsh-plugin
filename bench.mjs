#!/usr/bin/env node
// Retrieval performance benchmark: cold vs warm search latency and output size.
// Usage: node bench.mjs [--dir <exchanges dir>] [--runs 5]
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { rankExchanges, cleanUserText, snippetOf } from './index.js';

const args = process.argv.slice(2);
const dirIndex = args.indexOf('--dir');
const runsIndex = args.indexOf('--runs');
const runs = runsIndex >= 0 ? Math.max(1, Number(args[runsIndex + 1]) || 5) : 5;
const home = process.env.DSH_HOME || join(homedir(), '.dsh');
const dir = dirIndex >= 0 ? args[dirIndex + 1] : join(home, 'storages', 'dynamic_memory', 'exchanges');

if (!existsSync(dir)) {
  console.error(`no memory directory at ${dir}`);
  process.exit(1);
}

const rows = readdirSync(dir)
  .filter(file => file.endsWith('.json'))
  .map(file => {
    try {
      return JSON.parse(readFileSync(join(dir, file), 'utf8')).record;
    } catch {
      return undefined;
    }
  })
  .filter(row => row && typeof row.assistant === 'string' && row.assistant.trim())
  .map(row => ({ ...row, user: cleanUserText(row.user) }));

const queries = [
  '移动端上传 文件选择器',
  '登录 没跳转',
  '用户隔离 旧数据',
  '上下文压缩',
  '部署 公网 200',
  'example.com',
  'Dropdown.vue',
  '语音 第三方 TTS',
  '动态记忆 插件',
  'AIOS 自托管',
  'OneBot 集成',
  '多用户隔离',
];

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

const time = fn => {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
};

const cold = queries.map(query => time(() => rankExchanges(rows, { query, limit: 10 })));
const warm = [];
for (let run = 0; run < runs; run += 1) {
  for (const query of queries) warm.push(time(() => rankExchanges(rows, { query, limit: 10 })));
}

const sample = rankExchanges(rows, { query: 'P0 完成版 BM25 检索', limit: 3 });
const terms = [...new Set(sample.searchedTerms)];
const compactBytes = Buffer.byteLength(JSON.stringify(sample.matches.map(match => ({
  id: match.id,
  time: match.time,
  score: match.score,
  reasons: match.reasons,
  user: snippetOf(match.user, terms, 400),
  assistant: snippetOf(match.assistant, terms, 400),
}))));
const fullBytes = Buffer.byteLength(JSON.stringify(sample.matches));

console.log(`rows: ${rows.length}, queries: ${queries.length}, warm runs: ${runs}`);
console.log(`cold  p50: ${percentile(cold, 50).toFixed(1)} ms  p95: ${percentile(cold, 95).toFixed(1)} ms`);
console.log(`warm  p50: ${percentile(warm, 50).toFixed(1)} ms  p95: ${percentile(warm, 95).toFixed(1)} ms`);
console.log(`result size: compact ${(compactBytes / 1024).toFixed(1)} KB vs full ${(fullBytes / 1024).toFixed(1)} KB (${((compactBytes / fullBytes) * 100).toFixed(0)}%)`);
