#!/usr/bin/env node
// Offline retrieval evaluation.
// Usage: node eval.mjs [--dir <exchanges dir>] [--k 3] [--queries <file>] [--fixture]
//                      [--split dev|test|all] [--label-fields user,assistant,summary,keywords,entities]
//                      [--min-coverage 0.6]
// Real evaluation data stays local (eval-queries.local.json, gitignored); the synthetic
// fixture (eval-queries.fixture.json) is used by CI and when no local file exists.
//
// Labels: a query can carry an `expectedId` / `expectedIds` list (matched by row id — the
// ground truth is fixed from the pre-strip full-text backup, so it cannot self-confirm against
// the indexed fields) and/or `expectContains` (matched against `--label-fields`, default all
// retained fields). `expectIn` overrides `--label-fields` per query.
//
// `--split dev|test|all` filters queries by their `split` field (default `all`; a query without
// a split is treated as `test`). Keep weight experiments on `dev`; never tune on `test`.
// The committed `--fixture` suite is synthetic and split-neutral.
//
// `--min-coverage N` reclassifies a medium/high confidence label as low when the reported
// query coverage is below N. It only changes the false-positive/calibration reporting; ranking
// (hit@3/MRR) is untouched.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { rankExchanges, cleanUserText } from './index.js';

const args = process.argv.slice(2);
const valueOf = flag => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const k = Number(valueOf('--k')) || 3;
const home = process.env.DSH_HOME || join(homedir(), '.dsh');
const dir = valueOf('--dir') || join(home, 'storages', 'dynamic_memory', 'exchanges');
const fixtureMode = args.includes('--fixture');
const labelFields = (valueOf('--label-fields') || 'user,assistant,summary,keywords,entities')
  .split(',')
  .map(field => field.trim())
  .filter(Boolean);
const split = valueOf('--split') || 'all';
if (!['all', 'dev', 'test'].includes(split)) {
  console.error(`--split must be one of all|dev|test (got ${split})`);
  process.exit(2);
}
const minCoverage = Number(valueOf('--min-coverage'));
const coverageGate = Number.isFinite(minCoverage) && minCoverage > 0 ? minCoverage : 0;

// `fixture-4` is a summary-only row and `fixture-5` keeps its answer only in `entities`, so
// `--fixture` also covers the index-only storage shape that real data has after the strip.
const synthRows = () => {
  const now = Date.now();
  return [
    { id: 'fixture-1', sessionId: 'fixture', workspace: null, kind: 'episodic', time: now, user: '部署到 example.com 后首页返回 200', assistant: '部署完成，首页 200', summary: '部署 example.com', keywords: [], entities: ['example.com'], importance: 0.8 },
    { id: 'fixture-2', sessionId: 'fixture', workspace: null, kind: 'episodic', time: now - 86400000, user: '缓存失效要怎么处理', assistant: '缓存失效时回源并重建', summary: '缓存失效处理', keywords: [], entities: [], importance: 0.5 },
    { id: 'fixture-3', sessionId: 'fixture', workspace: null, kind: 'episodic', time: now - 2 * 86400000, user: '登录后没有跳转', assistant: '登录后跳转需要同步路由', summary: '登录跳转', keywords: [], entities: [], importance: 0.6 },
    { id: 'fixture-4', sessionId: 'fixture', workspace: null, kind: 'episodic', time: now - 3 * 86400000, user: '', assistant: '', summary: '索引化检索只保留摘要与关键词', keywords: ['索引', '检索', '摘要', '关键词'], entities: [], importance: 0.7 },
    { id: 'fixture-5', sessionId: 'fixture', workspace: null, kind: 'episodic', time: now - 4 * 86400000, user: '', assistant: '', summary: '前端下拉框自适应修复', keywords: ['下拉', '拉框', '前端', '修复'], entities: ['dropdown.vue'], importance: 0.6 },
  ];
};

let rows;
if (fixtureMode) {
  rows = synthRows();
} else {
  if (!existsSync(dir)) {
    console.error(`no memory directory at ${dir}; run the plugin first, pass --dir, or use --fixture`);
    process.exit(1);
  }
  rows = readdirSync(dir)
    .filter(file => file.endsWith('.json'))
    .map(file => {
      try {
        return JSON.parse(readFileSync(join(dir, file), 'utf8')).record;
      } catch {
        return undefined;
      }
    })
    .filter(row => row && (String(row.user || '').trim() || String(row.assistant || '').trim() || String(row.summary || '').trim()))
    .map(row => ({ ...row, user: cleanUserText(row.user) }));
}

const localQueries = new URL('./eval-queries.local.json', import.meta.url);
const fixtureQueries = new URL('./eval-queries.fixture.json', import.meta.url);
const explicitQueries = valueOf('--queries');
const queriesPath = explicitQueries || (fixtureMode ? fixtureQueries : (existsSync(localQueries) ? localQueries : fixtureQueries));
const queries = JSON.parse(readFileSync(queriesPath, 'utf8'))
  .filter(query => split === 'all' || (query.split || 'test') === split);
const positives = queries.filter(query => !query.negative);
const negatives = queries.filter(query => query.negative);

function tokens(text) {
  const out = [];
  const lower = String(text || '').toLowerCase();
  for (const match of lower.matchAll(/[a-z0-9_]{2,}/g)) out.push(match[0]);
  for (const run of lower.match(/[\u3400-\u9fff]+/g) || []) {
    if (run.length <= 2) out.push(run);
    else for (let index = 0; index + 2 <= run.length; index += 1) out.push(run.slice(index, index + 2));
  }
  return out;
}

function baselineRank(query, limit) {
  const terms = [...new Set(tokens(query))];
  return rows
    .map(row => {
      const haystack = `${row.user}\n${row.assistant}`.toLowerCase();
      return { row, score: terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0) };
    })
    .filter(hit => hit.score > 0)
    .sort((left, right) => right.score - left.score || right.row.time - left.row.time)
    .slice(0, limit)
    .map(hit => hit.row);
}

function fieldText(row, field) {
  const value = row[field];
  return Array.isArray(value) ? value.join('\n') : String(value ?? '');
}

function hitRank(list, query) {
  const wanted = query.expectedId ?? query.expectedIds;
  if (wanted) {
    const ids = new Set(Array.isArray(wanted) ? wanted : [wanted]);
    for (let index = 0; index < list.length; index += 1) {
      if (ids.has(list[index].id)) return index + 1;
    }
    return 0;
  }
  const needle = String(query.expectContains || '').toLowerCase();
  if (!needle) return 0;
  const fields = Array.isArray(query.expectIn) && query.expectIn.length ? query.expectIn : labelFields;
  for (let index = 0; index < list.length; index += 1) {
    const haystack = fields.map(field => fieldText(list[index], field)).join('\n').toLowerCase();
    if (haystack.includes(needle)) return index + 1;
  }
  return 0;
}

function effectiveLabel(result) {
  const confidence = result.confidence || {};
  const label = confidence.label ?? 'n/a';
  if (coverageGate && (label === 'medium' || label === 'high') && !(Number(confidence.coverage) >= coverageGate)) return 'low';
  return label;
}

const variants = [
  { name: 'baseline', run: (query, limit) => ({ matches: baselineRank(query, limit), confidence: { label: 'n/a' } }) },
  { name: 'bm25', run: (query, limit) => rankExchanges(rows, { query, limit, timeBoost: 0, phraseWeight: 0, impressionWeight: 0, entityWeight: 0, importanceWeight: 0 }) },
  { name: '+phrase', run: (query, limit) => rankExchanges(rows, { query, limit, timeBoost: 0, impressionWeight: 0, entityWeight: 0, importanceWeight: 0 }) },
  { name: '+entity', run: (query, limit) => rankExchanges(rows, { query, limit, timeBoost: 0, impressionWeight: 0 }) },
  { name: 'full', run: (query, limit) => rankExchanges(rows, { query, limit }) },
];

const totals = new Map(variants.map(variant => [variant.name, { hits: 0, mrr: 0, falsePositives: 0 }]));
const lines = [];

for (const query of positives) {
  const ranks = variants.map(variant => ({ name: variant.name, rank: hitRank(variant.run(query.query, k).matches, query) }));
  for (const { name, rank } of ranks) {
    const total = totals.get(name);
    if (rank) {
      total.hits += 1;
      total.mrr += 1 / rank;
    }
  }
  lines.push(`${query.query.padEnd(24, ' ')} | ${ranks.map(({ name, rank }) => `${name}: ${rank ? `#${rank}` : '-'}`).join(' | ')}`);
}

for (const query of negatives) {
  const verdicts = variants.map(variant => {
    const label = effectiveLabel(variant.run(query.query, k));
    const isFalsePositive = label === 'medium' || label === 'high';
    if (isFalsePositive) totals.get(variant.name).falsePositives += 1;
    return `${variant.name}: ${isFalsePositive ? 'FP' : 'ok'}`;
  });
  lines.push(`${query.query.padEnd(24, ' ')} | ${verdicts.join(' | ')}  [negative]`);
}

const gateNote = coverageGate ? `, min-coverage: ${coverageGate}` : '';
console.log(`memory rows: ${rows.length}${fixtureMode ? ' (fixture)' : ''}, positive: ${positives.length}, negative: ${negatives.length}, k=${k}, split: ${split}, label-fields: ${labelFields.join('+')}${gateNote}`);
console.log(lines.join('\n'));
console.log('');
const n = positives.length;
for (const variant of variants) {
  const total = totals.get(variant.name);
  console.log(`${variant.name.padEnd(9, ' ')} hit@${k}: ${total.hits}/${n}  MRR: ${(total.mrr / n).toFixed(3)}  false-positive: ${total.falsePositives}/${negatives.length}`);
}

// Calibration: does the reported confidence label actually predict a hit?
// Labels here are the native ones; `--min-coverage` applies to false-positive accounting only.
const fullVariant = variants.find(variant => variant.name === 'full');
const calibration = new Map();
for (const query of positives) {
  const result = fullVariant.run(query.query, k);
  const label = result.confidence?.label ?? 'n/a';
  const bucket = calibration.get(label) || { hits: 0, total: 0 };
  bucket.total += 1;
  if (hitRank(result.matches, query)) bucket.hits += 1;
  calibration.set(label, bucket);
}
const calibrationText = [...calibration.entries()]
  .sort(([left], [right]) => String(left).localeCompare(String(right)))
  .map(([label, bucket]) => `${label} ${bucket.hits}/${bucket.total}`)
  .join(' · ');
console.log(`calibration (full): ${calibrationText}`);
