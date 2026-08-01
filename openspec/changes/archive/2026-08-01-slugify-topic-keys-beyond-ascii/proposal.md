## Why

`memory.suggest_topic_key` mangles any title that is not plain ASCII, and for a non-English one it truncates before the words that identify the topic. Reproduced verbatim on `main`:

```
Ventilación del rack: 2x 92 mm de admisión…  →  decision/ventilaci-n-del-rack-2x-92
Präferenz für Größe der Fenster              →  preference/pr-ferenz-f-r-gr-e
データベースの接続プールを20に増やした            →  decision/20
Пул соединений базы данных увеличен до 20     →  decision/20
한국어 선호 설정                                →  preference/untitled
```

Two independent defects, both in one function:

1. **`slugify` is ASCII-only.** `topic-key.ts` replaces every non-ASCII character with a _space_, so accented words split into fragments and each fragment then consumes one of the six token slots. The accent defect feeds the truncation defect.
2. **`STOPWORDS` is English-only.** Spanish function words survive, eat the budget, and the slug stops before the discriminating terms — often on a dangling `se` or `en`.

The third row above is the worst: three unrelated memories in three languages suggest the SAME key, and Korean suggests `family/untitled`. An agent that adopts such a suggestion drives `saveWithTopicKey` to atomically supersede an unrelated active row. That is false convergence, the opposite of what `topic_key` exists to produce.

Non-English is a supported case, not an aspiration: the compiled-in embedder is `gte-multilingual-base` and `openspec/specs/memory/spec.md` carries a committed cross-lingual retrieval scenario with a Spanish query.

## What Changes

- **`slugify` (npm, 1.6.9) becomes a runtime dependency of `apps/server`**, replacing the hand-rolled `[^a-z0-9\s-]` filter. Measured against the real package: it transliterates Latin diacritics, `ß`→`ss`, `ø`/`æ`, plus Cyrillic and Greek. Zero dependencies, 8 KB, five files, no install-time lifecycle scripts (so no `allowBuilds` entry and no change to the `ALLOWED_BUILD_SCRIPTS` inventory), MIT, three maintainers, ships its own types.
- The library deletes `.` `_` `/` rather than splitting on them, so a pre-pass maps them to spaces. Without it `db/client.ts pragma` collapses to `dbclientts-pragma` — a regression on this repo's own domain, caught by review and now pinned.
- **`stopword` (npm, 3.1.5) supplies the particle lists, per language, replacing the hand-written English-only set.** Measured: the transliteration library ALONE fixes none of the three reported Spanish rows — they come out byte-identical to today, because the truncation is caused by surviving function words, not by the character filter. Both halves are required; neither suffices.
- **Only `eng` + `spa` are enabled, and that is a measured choice rather than a default.** Every wider grouping eats vocabulary this codebase depends on: `romance+germanic` (1 800 words) swallows `dos` and `mit`, and all 60 languages (11 919 words) swallow **`global`, `save` and `stop`**. Against 120 real titles from this repo's own history the wider sets change 48–56% of them. Enabling a language is therefore pinned by an executable assertion, not a comment.
- A hand-curated list was written first and discarded: measured against 21 English technical titles it lost `DOS`, `MIT`, `en`, `lo`, `Y`, `AL`/`IL` and `para`, because its exclusion policy existed only as a comment. The library's `eng`+`spa` is strictly better — it keeps `dos` and `mit` — which is the argument for buying the data and owning only the language selection.
- **A title that yields no usable slug SHALL produce no suggestion.** `memory.suggest_topic_key` returns `topic_key: null` plus a machine-readable `reason`, instead of `family/untitled` or `family/20`. This is the half that removes false convergence: `normalizeTopicKey` already accepts Unicode, so the agent can author its own key.
- Cyrillic and Greek stop being degenerate — they transliterate to usable slugs — so the refusal path narrows to CJK and Hangul, which no transliteration table covers.
- **BREAKING** for the tool's response shape: `topic_key` becomes nullable. No stored data changes; `topic_key` is caller-supplied and free-form, and no code path derives it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mcp-api`: the `memory.suggest_topic_key` requirement changes — the response's `topic_key` becomes nullable with an accompanying `reason`, and the slug's character handling becomes normative (transliterate rather than strip). Its stale family list is corrected in the same pass: it advertises `architecture/*`, `bug/*`, `pattern/*`, `config/*` and `discovery/*`, none of which are valid `MEMORY_TYPES`, which makes two of its scenarios unsatisfiable — verified, the zod enum rejects those types.
  No `supply-chain-hygiene` delta: the requirements already in force govern this addition (registry-only, install cooldown, frozen lockfile, and the executable `allowBuilds` inventory). `slugify` needs no `allowBuilds` entry, so the inventory is untouched. The diligence performed is recorded in `design.md` rather than as a new requirement.

## Impact

Durable invariants: none touched. The suggestion is advisory — `memory.save` never derives a `topic_key` (`memory-tools.ts` passes `args.topic_key ?? null`), and `normalizeTopicKey` is trim + 128-char cap + NUL check. Append-only, scope enforcement and judgment freshness are unaffected.

Code:

- `apps/server/package.json` + `pnpm-lock.yaml` — the two new dependencies.
- `apps/server/src/mcp/stopword.d.ts` — `stopword@3` ships no types and `@types/stopword` is pinned to major 2, so the two arrays this module reads are declared locally rather than typed against a different major.
- `apps/server/src/mcp/topic-key.ts` — the private `slugify` delegates character normalization to the library (rename to avoid the name collision), `STOPWORDS` grows, and the function reports "no usable slug" rather than falling back to `untitled`.
- `apps/server/src/mcp/relations-tools.ts` — `suggestTopicKeySchema`'s output shape (`topic_key` nullable, `reason` added), and `handleSuggestTopicKey`.

Blast radius is narrow and was verified: the private `slugify` is module-scoped and shared with nothing — not the project-slug validators (`services/projects.ts`, the two `SLUG_RE`s in `server/`), not the plugin's `readRembricSlug`, and the `rembric-dotenv.mjs` single-implementation invariant covers only `parseDotenv` and `SLUG_RE`. Nothing under `apps/plugin/` reaches this path, so no client surface is involved.

One cost the reporter ruled out that is real but bounded: a memory already saved under an old suggestion keeps its key, and the new suggestion's `nearby` prefix will not `LIKE`-match it — a one-time fragmentation of existing non-English topics. There is no migration: `topic_key` is never `UPDATE`d anywhere, and `memory_topic_key_active_uidx` makes a bulk rewrite unsafe (two keys normalising to one collide, demonstrated). The topics heal naturally on their next save.

Related: issue #300.
