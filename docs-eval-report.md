# Dynamic Memory v2.1 — Post-Strip Retrieval Evaluation

Date: 2026-11-16 · Repo: `C:\Users\one\dynamic-memory` · `index.js` not modified.

## 1. TL;DR

| Fact | Result |
|---|---|
| Pre-strip backup (2120 rows, full text) | **10/10, MRR 0.883, FP 0/8** — reproduces the historical baseline exactly |
| Current store, legacy labels (summary only) | **7/10, MRR 0.600, FP 1/8** — the apparent regression |
| Current store, migrated labels | **9/10, MRR 0.800, FP 1/8** |
| Current store, migrated labels + `--min-coverage 0.6` | **9/10, MRR 0.800, FP 0/8** |
| Remaining genuine loss | 1 query (`部署 公网 首页 200`, rank 47/2141) |

Two of the three "regressions" were eval-label artifacts caused by the plaintext strip, not ranking losses. After label migration only one real miss remains, and the false positive is removable by the coverage gate.

## 2. How measured

Datasets:
- **Before strip**: `%USERPROFILE%\.dsh\storages\dynamic_memory.backup-2.1\exchanges` — 2120 rows, 100% `user`/`assistant` plaintext (created by the strip migration; local only, not committed).
- **After strip**: default store `...\dynamic_memory\exchanges` — 2141 rows at run time, 0 plaintext rows (the store grows while agents run; metrics were stable across runs).
- **Fixture**: 5 rows, 5 positives / 2 negatives (2 rows are summary-only / entities-only).

Commands:
```bash
node eval.mjs                                   # current store, migrated labels
node eval.mjs --min-coverage 0.6                # same, gate FP labels at coverage 0.6
node eval.mjs --fixture                         # synthetic CI suite
node eval.mjs --fixture --min-coverage 0.6
node eval.mjs --dir "…\dynamic_memory.backup-2.1\exchanges"   # pre-strip re-run
node eval.mjs --dir "…\backup-2.1\exchanges" --min-coverage 0.6
node eval.mjs --queries _legacy.json --label-fields user,assistant,summary  # old label semantics
```

New `eval.mjs` options (ranking code untouched):
- `--label-fields <csv>` — fields used to locate the expected answer; default `user,assistant,summary,keywords,entities` so summary-only rows are scoreable after the strip. `--label-fields user,assistant,summary` reproduces the old (pre-migration) metric.
- `--min-coverage <n>` — a medium/high confidence label is reclassified as low when reported coverage is below `n`. Only FP/calibration accounting changes; hit@3/MRR are unchanged.
- Per-query label fields: `expectIn: ["entities"]`; id-based labels: `expectedId` / `expectedIds`.

## 3. Before/after table

| Dataset | Labels | hit@3 | MRR | FP (no gate) | FP (gate 0.6) |
|---|---|---|---|---|---|
| pre-strip backup | legacy | 10/10 | 0.883 | 0/8 | 0/8 |
| pre-strip backup | migrated | 10/10 | 0.883 | 0/8 | 0/8 |
| after strip | legacy | 7/10 | 0.600 | 1/8 | 0/8 |
| after strip | **migrated** | **9/10** | **0.800** | 1/8 | **0/8** |
| fixture (5 pos / 2 neg) | migrated | 5/5 | 1.000 | 0/2 | 0/2 |

Per-variant under migrated labels (after strip): baseline 0/10 · bm25 8/10 0.683 · +phrase 8/10 0.750 · +entity 9/10 0.800 · full 9/10 0.800. Calibration (full): high 1/1 · medium 8/9.

## 4. Label migration (before → after)

Target rows were recovered from the pre-strip backup; row ids survive the strip, so id labels are stable.

| Query | Old label | Problem after strip | New label | Pre rank | Post rank |
|---|---|---|---|---|---|
| 记忆插件 检索 印象 | `动态记忆插件已经建好` | phrase exists in **0** retained rows (summary/keywords/entities) | `expectedId: ab7320c8-…` + `expectContains: "P0 完成版"` (surviving summary of the same pre-strip row) | #1 | #1 |
| Dropdown.vue | `Dropdown.vue` matched only in summary | label survives only in `entities` (2 duplicate rows) | `expectIn: ["entities"]` | #1 | #1 |
| other 8 queries | unchanged | locatable in summary | unchanged | — | — |

No target row changed identity: both migrations point at the same exchanges the pre-strip labels pointed at. The two corrected labels were the whole difference between 7/10 and 9/10 — the ranking function and weights were not touched.

The old needle for `记忆插件 检索 印象` was unrecoverable from retained fields (0/2141 rows); matching by id is the only non-guessing migration. Fixture additions (`fixture-4` summary-only row, `fixture-5` entities-only label) make CI cover the index-only storage shape from now on.

## 5. Per-query ranks (k=3)

| Query | Pre-strip | Post-strip (migrated) | Status |
|---|---|---|---|
| 移动端上传 文件选择器 | #1 | #2 | hit, one rank worse (newer duplicate summary wins) |
| 登录 没跳转 | #1 | #1 | hit |
| 用户隔离 旧数据 归属 | #1 | #1 | hit |
| 动态记忆 起源 聊天机器人 | #1 | #1 | hit |
| 上下文压缩 丢信息 | #1 | #1 | hit |
| **部署 公网 首页 200** | **#3** | **miss (rank 47)** | **the only real loss** |
| 语音 第三方 TTS 暂停 | #2 | #1 | improved |
| 记忆插件 检索 印象 | #1 | #1 | hit (label migrated) |
| cloud.lenv.top 上传 文件夹 | #1 | #2 | hit |
| Dropdown.vue | #1 | #1 | hit (label migrated to entities) |

## 6. Coverage gate validation

| Run | hit@3 | MRR | FP |
|---|---|---|---|
| after strip, no gate | 9/10 | 0.800 | 1/8 |
| after strip, `--min-coverage 0.6` | 9/10 | 0.800 | **0/8** |
| backup, no gate | 10/10 | 0.883 | 0/8 |
| backup, `--min-coverage 0.6` | 10/10 | 0.883 | 0/8 |
| fixture, gate / no gate | 5/5 | 1.000 | 0/2 |

The single FP is `rust 所有权 生命周期` (coverage 0.59: common bigrams `所有`/`生命`/`周期` match, `rust` does not). All 10 positives have coverage ≥ 0.71, so the 0.6 gate loses no positive label — verified, not assumed. Gate 0.5 (current native behavior) keeps the FP.

## 7. The one genuine loss: `部署 公网 首页 200`

- Expected row `791d31c5` ranks **47/2141** (score 0.822 vs top-3 1.590 / 1.377 / 1.369) — a 1.93× shortfall no weight can bridge.
- Retained summary is 114 chars: `extractiveSummary` = first 90 user chars + first 60 assistant chars (`index.js:50-60`, ≤160 total); 68.8% of rows also hit the 160-keyword cap. Token audit for the target: `200` keyword-only, `部署` summary+keyword, **`公网`/`首页` in no retained field** — they sat past the 90+60 cut.
- Top-1 (`4fb7ca87`) summary literally says "接入公网…公网首页和状态接口都已验证可达": retrieval returns a semantically valid row, but the label demands the old multi-topic exchange.
- Oracle: appending only `公网 首页` to the target's summary makes it **rank #1** (score 1.593). This bounds the value of the retention fix at +1 hit@3, MRR 0.800 → up to 0.900 (exact post-fix MRR depends on final ranks).

## 8. Ranking-weight variants (re-tested offline, legacy labels)

| Variant | hit@3 | MRR | Note |
|---|---|---|---|
| current defaults | 7/10 | 0.600 | — |
| summary-title duplication (`user=summary`) | 7/10 | 0.600 | no change |
| keyword boost ×3 | 7/10 | 0.600 | no change |
| entityWeight 2.0 | 7/10 | 0.600 | no change |
| entityWeight 0 (ablation) | 6/10 | 0.550 | loses `cloud.lenv.top` |
| timeBoost 0 + importanceWeight 0 | 7/10 | 0.583 | loses one rank |

No weight-only variant improves post-strip results, because the missing decision tokens do not exist in the scored row. Keep `entityWeight=0.9`, `timeBoost=0.4`, `importanceWeight=0.4`.

## 9. Recommended next steps

1. **Keep the migrated labels** (default all-field matching + `expectedId` for strip-destroyed labels); the old summary-only metric is reproducible via `--label-fields user,assistant,summary`.
2. **Adopt `coverage >= 0.6`** in the confidence gate (eval flag proves FP 1/8 → 0/8 with zero positive-label loss; requires the later `index.js` change).
3. **For the retention fix**, keep assistant-side/index tokens beyond the first 60 chars and stop truncating the retrieval token set at 160 (or store a second longer token field). Oracle says this restores the last hit; re-run `eval.mjs` before/after with the id labels.
4. Don't spend cycles on BM25 weight tuning; no variant moved the numbers.

## 10. Limitations

- The pre-strip backup lives only on this machine (`dynamic_memory.backup-2.1`); re-running the before column requires it.
- `eval-queries.local.json` is gitignored by design; the migration is recorded here, while the committed fixture now covers the summary-only and entities-only shapes synthetically.
- The store is live (2128 → 2141 rows during analysis); repeated runs gave identical metrics, but exact MRR can drift with future captures.
- 1768/2141 rows share their summary with another row (max 19 copies), so label ranks can be non-unique; the per-query ranks above were stable across runs.
- The 0.900 MRR for recommendation 3 is an oracle upper bound, not a shipped result.

Changed in this task: `eval.mjs`, `eval-queries.fixture.json`, `docs-eval-report.md`. No `index.js` edits; commit is local (`test(eval):`), not pushed.
