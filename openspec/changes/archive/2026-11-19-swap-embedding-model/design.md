## Context

Embeddings are computed in-process by `onnx-community/gte-multilingual-base` (305M parameters, 768 dims, CLS pooling, q8), pinned in `packages/core/src/embeddings/model-identity.json`. `memory_vec` is a `vec0` table declared `FLOAT[768]`. The data directory records the model identity; on a mismatch `ensureVectorModel` wipes the vectors and the background drain re-embeds every non-archived memory.

Several constants are calibrated against this model's cosine similarities: `VEC_THRESHOLD`, `CANDIDATE_LOW_BAND_CEILING` and `CANDIDATE_HIGH_BAND_FLOOR` in `save-time-candidates.ts`, and `RELATIVE_LEVEL_RATIO` in `hybrid-search.ts`, whose level takes the dense cosine as one component.

### Evidence

Scratch scripts on one developer machine (2 intra-op threads) against a private corpus that is not committed, with blind LLM relevance grading over pooled results. The copy's `memory_vec` was recreated at 384 dims and re-embedded; the search pipeline ran unchanged.

|                                                           | Current model     | `hs-embed-1`     |
| --------------------------------------------------------- | ----------------- | ---------------- |
| nDCG@8 / MRR, fused search                                | 0.630 / 0.739     | 0.670 / 0.793    |
| Process RSS, loaded → peak over a sample of real memories | 1313 → 2093 MB    | 1019 → 1265 MB   |
| Embed one real memory, p50 / p95 / max                    | 42 / 349 / 794 ms | 10 / 78 / 164 ms |
| ONNX artifact + tokenizer on disk                         | 340 + 17 MB       | 152 + 34 MB      |

Paired nDCG@8 difference: +0.040, bootstrap 95% CI [−0.006, +0.091]. Re-embedding ran at roughly 35 memories per second. With the constants left at their current values the new model returned 17% more text per query, which shows the relative filter is no longer calibrated.

## Goals / Non-Goals

**Goals:**

- Lower resident memory and faster save-time embedding with retrieval quality that is not lower.
- An upgrade that needs no operator action and loses no memory.

**Non-Goals:**

- Reranking (its own change, `add-search-reranker`, which lands after this one).
- Moving inference to a worker thread.
- Shortened (Matryoshka) vectors below 384 dims; the saving is in the model, not in the index.

## Decisions

### 1. Model: `hindsight-ai/hs-embed-1`, pinned, 384 dims, mean pooling

Same class of use as today (multilingual, in-process, ONNX), a third of the parameters. Queries and memories use the same input, so `embeddingInput` and `embeddingQueryInput` keep their shape. Alternatives: keep the current model, rejected on the measured memory and latency; an English-only small model, rejected because the corpus mixes languages.

### 2. Recreate `memory_vec`, do not convert

A migration drops and recreates the virtual table at `FLOAT[384]` with the same metadata columns and partition key. Vectors of two models are not comparable, so there is nothing to convert. The migration runs inside the existing runner; `memory_vec` references nothing and is referenced by nothing, so the foreign-key gate is unaffected. Alternative: a second table and a dual-read period, rejected because the lexical branch already covers the re-embed window and the drain is short.

### 3. Re-embed through the existing identity reset

Changing `modelId` in the identity file makes `ensureVectorModel` see a mismatch on first load and the drain refill the table. No new mechanism. The identity marker write stays crash-safe as specified.

### 4. Re-derive every cosine-calibrated constant from committed runs

`RELATIVE_LEVEL_RATIO` from the existing abstention sweep of the retrieval harness; `VEC_THRESHOLD` and the two band boundaries from `pnpm run eval:save-time`. A value that happens to stay the same still ships with its run. Alternative: carry the values forward, rejected because the measured token increase already shows drift.

### 5. Test embedders follow the identity file

Fake embedders and fixtures that hard-code 768 read the dimension from the identity instead, so the next model change does not repeat this edit.

## Risks / Trade-offs

- [Risk] Semantic recall is degraded on the first boot until the drain finishes → Mitigation: lexical retrieval is unaffected; progress is logged; roughly 35 memories per second in measurement.
- [Risk] Save-time candidate detection behaves differently on the new model → Mitigation: the save-time sweep must show an admissible plateau before the thresholds are fixed; task 4.3 stops the change if it does not.
- [Risk] The quality comparison is a few dozen queries with one LLM judge each, and its confidence interval includes zero → Mitigation: the committed harness floors may not drop, which is the gate that actually ships.
- [Risk] Rollback re-embeds again and a downgraded server sees a 384-dim table → Mitigation: the previous image's own migration state does not include this migration; document that rollback requires restoring the pre-upgrade backup or accepting a rebuild. Task 5.2 verifies the documented path.
- [Trade-off] Disk size is about the same once the tokenizer is counted → Accepted; the gain is memory and latency.
- [Risk] The repository ships only an int8 ONNX export named `onnx/model.onnx`, loaded as `dtype: 'fp32'` by file name → Mitigation: the identity file pins the artifact name and the dimension check refuses a wrong artifact.

## Migration Plan

1. Ship the image with the new model baked and the migration.
2. On first boot the migration recreates `memory_vec`; on first embedder load the identity reset records the new identity and the drain re-embeds.
3. Rollback: restore the automatic pre-upgrade backup, or run the previous image against the upgraded data directory and let it rebuild its own vectors after the documented step.

## Open Questions

- Does the previous image tolerate a data directory whose `memory_vec` is 384-dim, or does it need the table dropped first? Task 5.2 answers it before the rollback text is written.
