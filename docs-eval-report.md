# Dynamic Memory v2.1 — Post-Strip Retrieval Evaluation

Date: 2026-11-16 · Repo: `C:\Users\one\dynamic-memory` · No source files modified.

Commands: `node eval.mjs` (real store, `%USERPROFILE%\.dsh\storages\dynamic_memory\exchanges`) and `node eval.mjs --fixture`.

## 1. Headline numbers

| Metric | Before strip (full text) | After strip (summary/keywords/entities) | Fixture before/after |
|---|---|---|---|
| hit@3 | **10/10** | **7/10** | 3/3 · 3/3 |
| MRR | **0.883** | **0.600** | 1.000 · 1.000 |
| false-positive | **0/8** | **1/8** | 0/2 · 0/2 |

Notes: after-strip numbers are live (`memory rows: 2128` at first run; the store grows with each captured turn — 2131 rows mid-analysis — metrics unchanged across runs). Before-strip figures are from CHANGELOG v1.11 (same 10 positives / 8 negatives) and are **not re-runnable**: 0/2131 rows retain plaintext, and there is no verbatim backup (only the ≤80-char `memory.md` digest). The fixture is also unrepresentative: its 3 rows still carry `user`/`assistant`, so it exercises plaintext matching and cannot detect strip regressions.

## 2. Per-query ranks (current `full` variant, k=3)

| Query | Pre-strip | Post-strip | Finding |
|---|---|---|---|
| 移动端上传 文件选择器 | hit | #2 | Hit retained; older multi-topic row loses to a newer near-duplicate |
| 登录 没跳转 | hit | #1 | no change |
| 用户隔离 旧数据 归属 | hit | #1 | 19 duplicate summary rows; first match #1 |
| 动态记忆 起源 聊天机器人 | hit | #1 | no change |
| 上下文压缩 丢信息 | hit | #1 | no change |
| 语音 第三方 TTS 暂停 | hit | #1 | no change |
| cloud.lenv.top 上传 文件夹 | hit | #2 | Hit only because `entityWeight=0.9`; entity ablation drops it |
| **部署 公网 首页 200** | hit | **miss (rank 47)** | Genuine content loss (see 2a) |
| **记忆插件 检索 印象** | hit | **miss (unscoreable)** | Label phrase deleted by strip (see 2b) |
| **Dropdown.vue** | hit | **miss (true rank #1)** | Metric defect — label only in `entities` (see 2c) |

Only the deployment query is a real ranking loss; the other two misses are calibration artifacts of the stripped corpus.

### 2a. Genuine loss: `部署 公网 首页 200`
- Expected row `791d31c5` rank **47/2131**, score 0.822 vs top-3 scores 1.590 / 1.377 / 1.369 — needs a 1.93× boost, far beyond any weight setting (max importance/recency ratio ≈1.04).
- Its retained summary is 114 chars (`extractiveSummary` = first 90 user chars + first 60 assistant chars, `index.js:50-60`; 68.8% of rows also hit the 160-keyword cap). Token audit: `200` in keywords only, `部署` in summary+keywords, **`公网`/`首页` in no retained field**. Those tokens sat past the 90+60-char cut.
- Top-1 (`4fb7ca87`, score 1.590) has summary "接入公网…公网首页和状态接口都已验证可达" — i.e. retrieval returned a semantically valid row; the eval label demands the old multi-topic row.
- Oracle: append only `公网 首页` to that row's summary → **rank #1** (1.593). So the loss is coverage, not scoring.

### 2b. Unscoreable label: `记忆插件 检索 印象`
`expectContains = "动态记忆插件已经建好"` occurs in **0** retained rows (summary, keywords, entities). Any ranking is unmeasurable; the pre-strip hit cannot be reproduced or verified. (The only "已经建好" row is an unrelated git-repo exchange.)

### 2c. Metric defect: `Dropdown.vue`
Ranking is correct: top-1 `0249338c` hits the phrase in entities + `phraseHit=1`, summary is the dropdown fix. But `hitRank()` checks only user/assistant/summary, and the needle survives only in `entities` (2 rows) — so a correct #1 is scored as a miss.

### 2d. False positive: `rust 所有权 生命周期`
Common Chinese bigrams (`所有`/`生命`/`周期`) match at coverage **0.59**; the gate is `coverage >= 0.5`, so it is labelled medium despite `rust` being absent. All 10 positives have coverage ≥ **0.71**. Raising the gate to 0.6 flips exactly this negative (low) and loses no positive label: **FP 1/8 → 0/8**.

## 3. Offline variants (offline only, via exported `rankExchanges`; `index.js` untouched)

| Variant | hit@3 | MRR | FP/8 | ranks |
|---|---|---|---|---|
| current (defaults) | 7/10 | 0.600 | 1/8 | [2,1,1,1,1,-,1,-,2,-] |
| summary-title duplication (`user=summary`) | 7/10 | 0.600 | 1/8 | unchanged |
| keyword boost ×3 | 7/10 | 0.600 | 1/8 | unchanged |
| entityWeight 2.0 | 7/10 | 0.600 | 1/8 | unchanged |
| entityWeight 0 (ablation) | 6/10 | 0.550 | 1/8 | cloud → miss |
| timeBoost 0 + importanceWeight 0 | 7/10 | 0.583 | 1/8 | cloud → #3 |
| phraseWeight 0 / importanceWeight 5 (also tested) | 7/10 | 0.600 | 1/8 | unchanged |

Conclusion: **no weight-only variant improves post-strip results**. Current defaults are already optimal; `entityWeight` is load-bearing for dotted-host queries, and recency+importance contribute positively (removing both costs 0.017 MRR and one rank). More summary/keyword term weight (duplication, ×3 boost) changes nothing because the missing decision terms do not exist anywhere in the scored row.

## 4. Best available improvement and exact expected gain

| Change (no `index.js` edit required for 1-2) | hit@3 | MRR | FP/8 | Delta vs measured |
|---|---|---|---|---|
| measured baseline | 7/10 | 0.600 | 1/8 | — |
| 1. Label migration: match summary, else keywords/entities | **8/10** | **0.700** | 1/8 | +1 hit, +0.100 MRR |
| 2. + confidence gate `coverage >= 0.6` | 8/10 | 0.700 | **0/8** | +1 FP fixed |
| 3. Upper bound if retention keeps `公网/首页`-class tokens | **9/10** | **0.800** | 0/8 | +2 hits, +0.200 MRR |

Residual: even with 1+3, `记忆插件 检索 印象` cannot be scored (ground truth destroyed), so 10/10 is not verifiable on the current corpus; the remaining 0.083 MRR gap is partly explained by that and by duplicate-summary crowding (1768/2131 rows share a summary with another row, max 19 copies).

## 5. Recommended next step (no code changed here)
1. **Fix the eval before tuning retrieval**: use stable `expectedId` (or check summary+keywords+entities) for ground truth, and add a summary-only fixture to CI — the current fixture cannot see the strip.
2. Raise the confidence coverage gate from 0.5 to **0.6** (recovers FP 0/8 at zero hit cost).
3. For retention (next code change): keep assistant-side/index tokens beyond the first 60 chars and don't cap the retrieval token set at 160 (or store a second, longer retrieval-token field, not plaintext). Oracle shows this recovers the one genuine loss to #1. Re-run `eval.mjs` with ids fixed before/after.
4. Since no weight tuning helps, don't spend cycles on `phraseWeight`/`importanceWeight`; keep `entityWeight=0.9`, `timeBoost=0.4`, `importanceWeight=0.4`.

Limitations: live store grows during runs; before-strip figures are historical (CHANGELOG v1.11), not re-measured; the oracle is an upper bound, not a shipped behavior; duplicate rows mean label matching can pick any copy.
