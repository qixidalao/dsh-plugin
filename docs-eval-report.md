# Dynamic Memory — Retrieval Evaluation (post-strip)

Date: 2026-11-16 · Repo: `dynamic-memory` · `index.js` not modified in this task.

## 1. Current authoritative numbers

Measured 2026-11-16 with `node eval.mjs` (current store, 2288 index rows at run time):

| Dataset | Split | Labels | hit@3 | MRR | FP | FP with `--min-coverage 0.6` |
|---|---|---|---|---|---|---|
| after strip | all | expectedId | **9/10** | **0.750** | 1/8 | **0/8** |
| after strip | dev | expectedId | 4/5 | 0.800 | 0/4 | 0/4 |
| after strip | test | expectedId | 5/5 | 0.700 | 1/4 | 0/4 |
| pre-strip backup | all | expectedId | 10/10 | 0.883 | 0/8 | 0/8 |
| pre-strip backup | dev | expectedId | 5/5 | 0.867 | 0/4 | 0/4 |
| pre-strip backup | test | expectedId | 5/5 | 0.900 | 0/4 | 0/4 |
| synthetic fixture | — | text (synthetic) | 5/5 | 1.000 | 0/2 | 0/2 |

Commands:

```bash
node eval.mjs                      # after strip, all queries
node eval.mjs --min-coverage 0.6
node eval.mjs --split dev          # tuning set
node eval.mjs --split test         # holdout
node eval.mjs --fixture            # public synthetic CI smoke
node eval.mjs --dir <backup-dir>   # pre-strip full-text snapshot
```

**MRR is unified at 0.750.** The previous report said 0.800; that figure came from an earlier, smaller store snapshot in which one target ranked one position higher — repeated runs after the store grew prints 0.750. This matches CHANGELOG (9/10, MRR 0.750). For reference, the retired text-label metric read lower (7/10, 0.600); those labels were circular and are no longer authoritative.

Diagnostic variants on the shipped default (not tuning): bm25 7/10, MRR 0.650; +phrase 8/10, 0.700; +entity 9/10, 0.750; no variant beats the default. One genuine miss remains (see §5).

## 2. Ground truth: `expectedId`, not searchable fields

Old labels were literals matched against `summary`/`keywords`/`entities` — the same fields retrieval scores. That is a self-confirming loop: a query "passes" when its wording survives in an indexed field, not when the right exchange is retrieved.

New basis: for each query, the answer set is the exchange ids whose **pre-strip plaintext** (local backup of 2120 rows) contained the original label literal. `eval.mjs` matches these ids against the ranked results; it no longer depends on the current text fields for real-set labels. All 10 real positives now use `expectedIds`; two labels needed migration because their literals did not survive the strip (one was removed entirely, one survived only in `entities`). The committed fixture keeps synthetic text labels — its data is synthetic, so circularity is harmless there.

## 3. Dev/test separation

The local labeled set (gitignored, never committed) now carries a `split` field: 5 positives + 4 negatives in `dev`, 5 positives + 4 negatives in `test`. `eval.mjs --split dev|test|all` filters it; unknown values exit non-zero. Rule: weight experiments and any tuning use `dev` only; `test` is run once after a design is frozen and never used for selection. The synthetic `--fixture` suite is the public, split-neutral CI smoke test.

This report's dev figures are explicitly labeled; test figures are holdout-only observation.

## 4. Privacy cleanup (this task)

Removed from the committed report:
- all 10 real query strings and their per-query ranks;
- the real false-positive sample and its wording;
- the real deployment domain (replaced by generic wording);
- the local Windows home-directory path.

Kept only aggregate hit@3/MRR/FP counts, split totals, and generic commands. The local labeled query file is gitignored (`eval-queries.local.json` was already in `.gitignore`; no change needed) and is not part of any commit. No real query/domain/home path from the evaluated set remains in this report.

**Still outstanding, outside this task's write scope** (needs an owner / Lead decision):
1. Git history still contains the earlier committed report with the real data; history rewrite is the Lead's call.
2. Other tracked docs (`CHANGELOG.md`, `DOCS.md`, `PLAN.md`, `README.md`, `README.en.md`) mention one real query in their eval notes — follow-up cleanup needed.
3. `ui/verify-dshgo.mjs` contains a local machine path (not eval data, but same class of leak).

## 5. Known gaps

- **The one genuine retrieval loss remains:** a multi-topic exchange whose expected terms fall outside the 90+60-character extractive summary (rank 47 in a 2288-row store). It is a coverage gap, not a scoring issue; labels now prove it via id rather than text.
- `expectedId` ground truth requires the local pre-strip backup; it is not reproducible from the repository alone.
- `test` holds only 5 positives and a single effective false-positive sample; per-split numbers are indicative, not statistically strong.
- `--min-coverage` is an eval-side reclassification only; the native confidence gate in `index.js` is still 0.5 (no code change here).
- Ranked lists can contain capture duplicates (identical summaries), so "the" expected exchange may appear as several ids — the answer set includes all of them.

## 6. Changed in this task

- `eval.mjs`: documented id-based labels and added `--split dev|test|all` (plus usage text); ranking untouched.
- `docs-eval-report.md`: this sanitized report.
- Local labeled query file: migrated to `expectedIds` + split, gitignored, not committed.
- `eval-queries.fixture.json`: unchanged (already synthetic/public).

Commit is local (`test(eval):`), not pushed.
