#!/usr/bin/env node
// Reproducible retrieval stress benchmark (before/after for the rank hot path).
//
// Usage:
//   node --expose-gc bench-stress.mjs [--sizes 2000,10000,20000,50000] [--queries 30] [--json]
//
// For every size it builds synthetic memory rows (deterministic), warms the index once,
// then runs `--queries` distinct queries through rankExchanges and reports:
//   avgMs     average wall time per query after warm-up (index build excluded)
//   buildMs   first-call cost (index construction + first query)
//   heapUsed  total JS heap after the run (MB)
//   heapDelta heap growth caused by the index/caches over the rows (MB)
//   rss       process RSS at measurement (MB)
// The same script runs against the old scan implementation and the optimized index, so
// the numbers are directly comparable.
import { rankExchanges, bumpRankEpoch, currentRankEpoch, currentRankEditEpoch, invalidateRow } from './index.js';

const args = process.argv.slice(2);
const valueOf = flag => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const sizes = String(valueOf('--sizes') || '2000,10000,20000,50000')
  .split(',')
  .map(value => Math.max(10, Number(value) || 0))
  .filter(Boolean);
const queryCount = Math.max(1, Number(valueOf('--queries')) || 30);
const jsonOutput = args.includes('--json');

// Deterministic PRNG (mulberry32) so every run uses identical rows and queries.
const prng = seed => () => {
  seed |= 0;
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const WORDS = [
  '部署', '缓存', '失效', '登录', '跳转', '路由', '索引', '检索', '摘要', '关键词',
  '画像', '观察', '推断', '证据', '会话', '记忆', '注入', '审计', '隔离', '权限',
  '测试', '压测', '性能', '内存', '插件', '面板', '移动端', '自托管', '服务器', '公网',
  '备份', '恢复', '迁移', '归档', '删除', '清理', '同步', '队列', '并发', '锁',
  '日志', '错误', '异常', '重试', '超时', '配置', '环境', '版本', '发布', '回滚',
  'example.com', 'example.org', 'dynamic_memory', 'rankExchanges', 'bm25', 'lru',
  'cache', 'index', 'token', 'postings', 'memory', 'agent', 'workspace', 'session',
  'deploy', 'rollback', 'release', 'metric', 'latency', 'heap', 'rss', 'fixture',
];
const ENTITIES = ['example.com', 'example.org', 'example.net', 'dynamic_memory', 'rankExchanges', 'dropdown.vue'];

const pick = (random, list, count) => Array.from({ length: count }, () => list[Math.floor(random() * list.length)]);

function makeRows(count, random) {
  const now = Date.now();
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const words = pick(random, WORDS, 6 + Math.floor(random() * 6));
    const user = words.slice(0, 3 + Math.floor(random() * 3)).join(' ');
    const assistant = words.slice(3).join(' ');
    const summary = words.slice(0, 2 + Math.floor(random() * 3)).join(' ');
    const entities = random() < 0.25 ? [ENTITIES[Math.floor(random() * ENTITIES.length)]] : [];
    const row = {
      id: `bench-${index}`,
      sessionId: `session-${index % 500}`,
      workspace: null,
      kind: 'episodic',
      time: now - index * 60000,
      updatedAt: now - index * 60000,
      user,
      assistant,
      summary,
      keywords: words.slice(0, 2),
      entities,
      importance: 0.3 + random() * 0.5,
      accessCount: 0,
      lastAccessAt: null,
      supersededBy: null,
      archivedAt: random() < 0.05 ? now - 86400000 : null,
      history: [],
    };
    rows.push(row);
  }
  return rows;
}

function makeQueries(random) {
  return Array.from({ length: queryCount }, () => `${pick(random, WORDS, 1)[0]} ${pick(random, WORDS, 1)[0]}`);
}

const mb = bytes => Number((bytes / 1024 / 1024).toFixed(1));
const collect = () => {
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const usage = process.memoryUsage();
  return { heap: usage.heapUsed, rss: usage.rss };
};

const results = [];
for (const size of sizes) {
  const random = prng(0x9E3779B9 ^ size);
  const rows = makeRows(size, random);
  const queries = makeQueries(prng(0xC0FFEE ^ size));
  let version = currentRankEpoch();
  let editVersion = currentRankEditEpoch();
  const base = collect();
  // First call builds the index (or the per-row fallback caches); timing it separately.
  const buildStart = process.hrtime.bigint();
  rankExchanges(rows, { query: queries[0] || '部署', limit: 10, rankVersion: version, rankEditVersion: editVersion });
  const buildMs = Number((Number(process.hrtime.bigint() - buildStart) / 1e6).toFixed(2));
  const start = process.hrtime.bigint();
  for (const query of queries) rankExchanges(rows, { query, limit: 10, rankVersion: version, rankEditVersion: editVersion });
  const avgMs = Number((Number(process.hrtime.bigint() - start) / 1e6 / queries.length).toFixed(2));
  const after = collect();
  // Invalidation cost: appending one captured row is incremental; an edit forces a rebuild.
  rows.push(makeRows(1, prng(0xABCDEF ^ size))[0]);
  bumpRankEpoch();
  version = currentRankEpoch();
  const appendStart = process.hrtime.bigint();
  rankExchanges(rows, { query: queries[0] || '部署', limit: 10, rankVersion: version, rankEditVersion: editVersion });
  const appendMs = Number((Number(process.hrtime.bigint() - appendStart) / 1e6).toFixed(2));
  rows[0].summary = `edited ${size}`;
  invalidateRow(rows[0]);
  version = currentRankEpoch();
  editVersion = currentRankEditEpoch();
  const editStart = process.hrtime.bigint();
  rankExchanges(rows, { query: queries[0] || '部署', limit: 10, rankVersion: version, rankEditVersion: editVersion });
  const editRebuildMs = Number((Number(process.hrtime.bigint() - editStart) / 1e6).toFixed(2));
  results.push({
    rows: size,
    queries: queries.length,
    buildMs,
    avgMs,
    appendMs,
    editRebuildMs,
    heapUsedMB: mb(after.heap),
    heapDeltaMB: mb(after.heap - base.heap),
    rssMB: mb(after.rss),
  });
  // Let the next size start from a clean-ish heap.
  rows.length = 0;
}

if (jsonOutput) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log(`rankExchanges stress: ${sizes.join('/')} rows, ${queryCount} queries each, limit=10`);
  console.log('rows     buildMs   avgMs    appendMs  editRebuild  heapUsed   heapDelta   rss');
  for (const row of results) {
    console.log(`${String(row.rows).padEnd(8)} ${String(row.buildMs).padEnd(9)} ${String(row.avgMs).padEnd(8)} ${String(row.appendMs).padEnd(9)} ${String(row.editRebuildMs).padEnd(12)} ${String(`${row.heapUsedMB} MB`).padEnd(10)} ${String(`${row.heapDeltaMB} MB`).padEnd(11)} ${row.rssMB} MB`);
  }
}

// --verify: the incremental append path and the edit-triggered rebuild must return
// exactly the same ranking as a fresh index over a new rows array.
if (args.includes('--verify')) {
  const rows = makeRows(200, prng(7));
  const array = [...rows];
  let version = currentRankEpoch();
  let editVersion = currentRankEditEpoch();
  const run = (target, query, v, e) => rankExchanges(target, { query, limit: 5, rankVersion: v, rankEditVersion: e })
    .matches.map(match => match.id).join(',');
  const fail = message => {
    console.error(`FAIL ${message}`);
    process.exitCode = 1;
  };
  array.push(makeRows(1, prng(11))[0]);
  bumpRankEpoch();
  version = currentRankEpoch();
  const appended = run(array, '部署 缓存', version, editVersion);
  const freshAppend = run([...array], '部署 缓存');
  if (appended !== freshAppend) fail('incremental append path diverged from a fresh index');
  array[0].summary = '量子 纠错 专属摘要';
  invalidateRow(array[0]);
  version = currentRankEpoch();
  editVersion = currentRankEditEpoch();
  const edited = run(array, '量子 纠错', version, editVersion);
  const freshEdit = run([...array], '量子 纠错');
  if (edited !== freshEdit) fail('edit-triggered rebuild diverged from a fresh index');
  if (!process.exitCode) console.log('verify: append path and edit rebuild match a fresh index');
}
