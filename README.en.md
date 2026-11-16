# Dynamic Memory for DeepSeek Harness

Durable long-term memory for a Harness agent: it keeps an evidence layer, user and assistant portraits, a calibrated retriever, and a small cognition layer (consolidation drafts, recompute, disclosure policy). It only adds what is missing from the context window; it does not re-inject the current conversation.

- **Evidence first**: observations are separated into `observed / self_reported / inferred / corrected`. Inferred claims need a confidence and at least one alternative explanation. User corrections always win; contradictions are kept, not silently merged.
- **No fixed personality taxonomy**: the plugin stores guesses with sources and confidence, not labels. Portrait facets are configurable (`facets`, `assistantFacets`); nothing forces “introvert/extrovert” style buckets.
- **Language-neutral core**: all runtime text comes from locale packs (`locale/messages.*.json`); word lists, disclosure defaults and facet labels are data, not code. Chinese is a supported locale, not a hard dependency.
- **Time-aware**: observation scope (transient/situational/durable) is derived on read; TTL only stops injection, it never deletes. Inferred confidence decays from the last corroboration.
- **Disclosure policy**: `proactive / if_asked / never`; sensitive or transient items default to `if_asked` and are marked “tone only” in context.
- **Safe by default**: delete cascades to references, dispose awaits in-flight writes before closing storage, capture can be paused.

## Install (Preview)

This is a Cordis **bundle plugin** for DeepSeek Harness, not a standalone app.

1. Clone the repository.
2. Install the repository path as a bundle into your Harness profile (plugin manager `install_bundle`).
3. Reload, then run `/dmem stats`; `storage: durable` confirms persistence. Data lives in `$DSH_HOME/storages/dynamic_memory/`.

Release channels: Preview (`main` + tags) → installable bundle → Stable (npm later; `package.json` is currently `private: true`). **Not released**: no Release, not Latest, npm not pushed.
License: AGPL-3.0-only (see [LICENSE](./LICENSE)). Memory data is never stored in the repo; real evaluation data is local-only and gitignored.

## Verify

```bash
node test.mjs          # 52 pure-function checks
node test-host.mjs     # 93 lifecycle checks against an in-memory mock host
node eval.mjs --fixture # synthetic evaluation (no personal data)
```

## Docs

- [DOCS.md](./DOCS.md) — architecture, data model, injection/retrieval rules, upgrade roadmap (Chinese).
- [CHANGELOG.md](./CHANGELOG.md) — version history.
- [README.md](./README.md) — Chinese README (primary).
- [CONTRIBUTING.md](./CONTRIBUTING.md) — contribution rules (Chinese).

## Configuration highlights

`locale` (`auto` by default: detect from the latest user message; set `en`/`zh` to force), `facets`, `assistantFacets`, `capture`, `mention` defaults are derived from scope/type/sensitivity, `ttlTransientDays` / `ttlSituationalDays`, `inferenceHalfLifeDays`, `portraitBudget`, `observationBudget`.

## v2.1 Index-only capture (done, unreleased)

Positioning: **Harness sessions are the only source of plaintext; the plugin stores a local derived index.** It is not an encryption product and has no cloud sync.

- **Stored**: summary, keywords, entities, time, `textHash` (SHA-256, verification only), `pointer` (sessionId + time). New rows keep `user`/`assistant` as empty strings (`retainText: false` is the default).
- **Not stored**: plaintext copies of user/assistant turns; no application-level encryption or passphrase (privacy relies on full-disk encryption and file permissions). Existing rows were already stripped: 2120 rows, ~2.9M characters freed.
- **Reading the original text**: a search hit is hydrated by reading the local Harness session via its pointer — pairing by `textHash`, then summary prefix, then a unique time-window candidate; snippets by default, full turns with `full=true`.
- **Current state (real-machine spot check)**: hydration **19/20 = 95%**. The one failure is explicit and never fabricated: a repeated "继续"-style prompt whose row cannot be uniquely located among 54 candidates in its session — `sourceAvailable: false`, empty text, `hydrationError: no matching user message (54 candidates)`; a no-match, not ambiguous, not an unreadable session. Summary/keywords/entities still match in retrieval.
- **Rollback (limited)**: `memory.md` is exported automatically before stripping, but it is a **readable archive** (portraits, observations, 30 latest impressions with at most 80 chars of user text), not a byte-exact backup of all 2120 rows. For a literal restore use a pre-strip storage snapshot (copy `$DSH_HOME/storages/dynamic_memory/`); `/dmem export` likewise stays at summary level.
- Migration is available both as a tool action and as `/dmem migrate mode=strip confirm=true` (shared implementation; exports memory.md first, refuses without `confirm=true`; destructive).

## Known limits

- No embeddings: synonym paraphrases can still miss; retrieval is lexical (CJK bigrams + word scripts + entities).
- Identity continuity is evidence, not authentication.
- Consolidation drafts require ≥3 distinct sessions; a sparse store will produce none.
- Chinese is fully reviewed; English/other locales are functional (prompts, labels, word lists, tokenizer fallback) but need native-speaker polish.
