#!/usr/bin/env node
// Offline retrieval evaluation over the real memory store.
// Usage: node eval.mjs [--dir <exchanges dir>] [--k 3]
// Positive queries report hit@k and MRR; negative queries (negative: true) report
// how often the retriever claims medium/high confidence for something not in memory.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { rankExchanges, cleanUserText } from './index.js';

const args = process.argv.slice(2);
const dirIndex = args.indexOf('--dir');
const kIndex = args.indexOf('--k');
const k = kIndex >= 0 ? Number(args[kIndex + 1]) || 3 : 3;
const home = process.env.DSH_HOME || join(homedir(), '.dsh');
const dir = dirIndex >= 0 ? args[dirIndex + 1] : join(home, 'storages', 'dynamic_memory', 'exchanges');

if (!existsSync(dir)) {
  console.error(`no memory directory at ${dir}; run the plugin first or pass --dir`);
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
  .filter(row => row && typeof row.user === 'string' && typeof row.assistant === 'string' && row.assistant.trim())
  .map(row => ({ ...row, user: cleanUserText(row.user) }));

const queries = JSON.parse(readFileSync(new URL('./eval-queries.json', import.meta.url), 'utf8'));
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

function hitRank(list, expectContains) {
  const needle = expectContains.toLowerCase();
  for (let index = 0; index < list.length; index += 1) {
    if (`${list[index].user}\n${list[index].assistant}`.toLowerCase().includes(needle)) return index + 1;
  }
  return 0;
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
  const ranks = variants.map(variant => ({ name: variant.name, rank: hitRank(variant.run(query.query, k).matches, query.expectContains) }));
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
    const result = variant.run(query.query, k);
    const label = result.confidence?.label ?? 'n/a';
    const isFalsePositive = label === 'medium' || label === 'high';
    if (isFalsePositive) totals.get(variant.name).falsePositives += 1;
    return `${variant.name}: ${isFalsePositive ? 'FP' : 'ok'}`;
  });
  lines.push(`${query.query.padEnd(24, ' ')} | ${verdicts.join(' | ')}  [negative]`);
}

console.log(`memory rows: ${rows.length}, positive: ${positives.length}, negative: ${negatives.length}, k=${k}`);
console.log(lines.join('\n'));
console.log('');
const n = positives.length;
for (const variant of variants) {
  const total = totals.get(variant.name);
  console.log(`${variant.name.padEnd(9, ' ')} hit@${k}: ${total.hits}/${n}  MRR: ${(total.mrr / n).toFixed(3)}  false-positive: ${total.falsePositives}/${negatives.length}`);
}
