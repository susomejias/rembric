## Context

`apps/server/src/mcp/topic-key.ts` builds a suggested `topic_key` in four steps: pick a family from the memory `type`, lowercase and filter the title's characters, drop stopwords, keep the first `MAX_KEEP_TOKENS = 6` survivors. Two of those steps are ASCII-shaped.

The load-bearing line is the character filter:

```ts
.replace(/[^a-z0-9\s-]/g, ' ')
```

Applied after `toLowerCase()` with no normalization, it replaces each non-ASCII letter with a **space**, so `admisión` becomes `admisi` + `n`. The fragment is then a token, and it spends one of the six slots — which is why the accent defect makes the truncation defect worse rather than merely coexisting with it.

Reproduced on `main`, verified directly rather than taken from the issue:

```
decision/ventilaci-n-del-rack-2x-92      preference/pr-ferenz-f-r-gr-e
decision/20  (Japanese)                  decision/20  (Cyrillic)
preference/untitled  (Korean)
```

The Korean and CJK rows are the severe case: three unrelated memories share one suggestion, and `family/untitled` is a constant. `saveWithTopicKey` supersedes the active row in the same `(scope, project_id, topic_key)` slot, so an agent adopting such a suggestion retires something unrelated.

Constraint that shapes the whole design, and which was measured before anything was written: **the library alone fixes none of the three reported Spanish rows.** With `slugify` in place but the English-only stopword set unchanged, they come out byte-identical to today (`el-disco-duro-del-vault-se`, `antes-de-levantar-un-servidor-en`, `ventilacion-del-rack-2x-92-mm`). The character filter and the stopword set are independent causes and both need fixing.

## Goals / Non-Goals

**Goals:**

- A non-ASCII word contributes one token, not several fragments.
- A non-English title's slug contains its content words.
- English titles are byte-identical to today — this must be asserted, not assumed, because it is the half that fails silently.
- No title can receive a suggestion that collides with an unrelated memory's.

**Non-Goals:**

- Changing any stored `topic_key`. There is no migration and cannot cheaply be one — see the Migration Plan.
- Changing `NEARBY_PREFIX_TOKENS` or the `occupied`/`nearby` discovery mechanism. The issue argued `nearby` degrades; measured, the effect runs the other way (leading function words make the prefix a _stickier_ bridge between paraphrases, not a broken one), and moving the prefix in the same change as the slug would make the effect unattributable.
- Making `topic_key` suggestion quality a retrieval concern. `apps/server/src/test/retrieval/` measures recall; this path is not on it, and claiming a recall gain here would be unsupported.

## Decisions

### D1 — Take the `slugify` dependency rather than hand-rolling normalization

Chosen: `slugify@1.6.9` as a runtime dependency of `apps/server`.

The alternative considered first was `String.normalize('NFD')` plus a four-entry map for the characters NFD cannot decompose (`ß`, `ø`, `æ`, `ł`). Measured, both fix the Latin cases. The library additionally transliterates **Cyrillic and Greek**, which moves two of the five degenerate cases into the supported set (`Пул соединений … до 20` goes from `decision/20` to `decision/pul-soedinenij-bazy-dannyh-uvelichen-do`), and it does so without a per-language table to maintain in this repo.

Diligence performed per `.agents/skills/npm-security-best-practices/`, since this is the posture's first convenience dependency:

| Check                          | Result                                                                                                               |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Dependencies                   | **zero**                                                                                                             |
| Tarball                        | 8 KB, five files: `LICENSE`, `slugify.js`, `slugify.d.ts`, `package.json`, `README.md`. No binaries, no build output |
| Install-time lifecycle scripts | **none** — `build`/`test` only, so no `allowBuilds` entry and the `ALLOWED_BUILD_SCRIPTS` inventory is untouched     |
| Types                          | ships its own `.d.ts`; no `@types/*` needed                                                                          |
| Licence                        | MIT                                                                                                                  |
| Maintainers                    | three, including a Node.js TSC member — bus factor above the skill's threshold                                       |
| Cooldown                       | enforced by `pnpm install` itself via `minimumReleaseAge`; 1.6.9 is long-published                                   |
| Registry origin                | registry tarball; `blockExoticSubdeps` unaffected (no transitive deps at all)                                        |

_Trade-off accepted:_ a third party's charmap now influences a convergence key, where before this repo's own tests pinned it. Mitigated by pinning fixtures for every language case, so a charmap change in a future version reddens CI instead of silently shifting suggestions. If that ever fires, the NFD fallback remains available behind the same private function.

_Known cosmetic weakness:_ Greek transliterates via a leetspeak-ish map (`θ`→`8`, `ή`→`h`), so `Ρύθμιση αερισμού για το rack` yields `ry8mish-aerismoy-gia-to-rack`. Readable enough to be a stable key, ugly enough to note. Not a reason to reject: the status quo for Greek is `rack`.

### D2 — Buy the particle data per language; own only which languages are enabled

Chosen: `stopword@3.1.5`, merging `eng` + `spa`.

A hand-curated list shipped first and was discarded by measurement. Its stated policy — "excludes any particle that is also a plausible English technical token" — existed only as a comment, was applied to the six words that came to mind, and was never swept over the list it produced. Against 21 English technical titles it lost `DOS` (dos2unix), `MIT` (the licence), `en` (en dash), `lo` (the loopback interface), `Y` (combinator), `AL`/`IL` (regions) and `para` (paravirtual). The two pinned English fixtures could not catch it because neither contains any of the added words.

The library's `eng`+`spa` is **strictly better than the hand list**: it keeps `dos` and `mit`, fixes the same three Spanish rows, and leaves the pinned English controls byte-identical. The hand list was over-broad precisely because it added German and Portuguese particles this corpus does not contain.

**Which languages, measured.** Collisions with this repo's vocabulary, by grouping:

| grouping                | words  | eats from repo vocabulary                                                                                                                                    |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `eng`+`spa`             | 163    | 17 — of which 10 are genuine English function words (`get has no all both same out up on in`) and 7 are the irreducible collision (`en do lo al un se para`) |
| `romance+germanic` (10) | 1 800  | 25 — adds `die der da mit il si dos af`                                                                                                                      |
| all 60                  | 11 919 | 29 — adds **`global`, `save`, `stop`, `one`**                                                                                                                |

Against 120 real titles taken from this repo's commit history and spec requirement names, the wider groupings change 48% and 56% of them respectively. `global` is half the scope model and `save` is the primary tool name, so the 60-language merge is disqualifying, and `romance+germanic` costs `dos`/`mit` for languages this corpus does not contain. Collisions saturate at 17 — beyond 10 languages, 10 000 more words buy no additional coverage of any collision, which is the clearest sign the ceiling is the language selection and not the list size.

**The irreducible part, stated plainly.** `en`, `un`, `se`, `al`, `lo`, `para` and `do` are simultaneously the Spanish particles the reported bug needs removed and the English tokens that must survive. No set-based rule resolves that; only context (letter case, or language detection) could, and both were rejected — case forces tokenisation before transliteration and still misses the lowercase collisions (`lo`, `en dash`, `para virtual`), while detection over an eight-word title is a heuristic that fails hardest on the short titles it would be applied to. So the seven are accepted as a known cost, pinned by fixtures, and recorded here rather than discovered later.

_Alternative: rank tokens by length or rarity instead of filtering._ Rejected, and this repo already rejected it — `archive/2026-06-27-add-recall-projection-and-batch-get/design.md` Decision 4 resolves against dropping short tokens because "dropping them entirely is exactly what kills CJK". Measured here too: ranking by length discards `92`, `mm` and `2x`, the discriminating specs of the rows this change exists to fix.

_Alternative: a trailing-particle trim._ Implemented, then deleted — review proved it dead. The stopword filter runs before the join, so no token in the kept set can be a stopword and the trim could never fire; its only reachable effect was on a mid-word truncation artifact. Its test passed with the function removed, which is what exposed it.

### D3 — Refuse to suggest rather than emit a placeholder

Chosen: `topic_key: null` plus a `reason`.

`slugify` returns the empty string for Hangul and a bare `20` for the CJK rows, so the degenerate case is detected exactly (`slug === ''`, or a slug with no alphabetic token) rather than heuristically. Returning null is the only option that removes false convergence, because every alternative still hands the agent a key that another memory can be handed too.

_Alternative: family prefix only (`preference/`)._ Rejected — a half-formed key the agent may copy verbatim.

_Alternative: a content hash suffix (`preference/ko-3f9a2c`)._ Collision-free and deterministic, and it always returns something. Rejected because the key is human-facing on the dashboard and a hash says nothing about the topic; a null with a reason moves the authorship to the agent, which can write a meaningful Unicode key that `normalizeTopicKey` already accepts.

_Trade-off:_ the response shape changes (`topic_key` nullable, `reason` added), which is why this needs a `MODIFIED` requirement rather than an additive one.

### D4 — The coverage trade is guarded by an executable matrix, not by prose

A per-language fixture table (17 rows: en, es, de, fr, pt, it, da, ru, el, tr, pl, ja, zh, ko) pins the exact key each language produces, alongside a pinned `STOPWORD_LANGUAGES`, four cross-language property assertions (determinism, budget, ASCII-only output, at least two tokens), and 40 protected-vocabulary assertions naming the words this codebase cannot afford to lose.

Verified by mutation: enabling ten languages reddens **ten** assertions and separates the two halves of the trade — five matrix rows show which languages gained, and `keeps dos` / `keeps mit` / `keeps die` / `keeps der` show what was paid for it, in one run. That is the guard the hand-curated list lacked, and the reason its policy failure went unnoticed.

## Risks / Trade-offs

- [Risk] English suggestions shift silently, and nothing would notice → Mitigation: the English rows from the issue are pinned as literal expected strings and asserted byte-identical to today's output. This is the assertion that must fail loudest if the stopword set is over-extended.
- [Risk] A `slugify` version bump changes a transliteration and moves suggested keys → Mitigation: per-language fixtures pin the output, so the bump reddens CI. The repo's bot-driven-updates-under-review requirement already prevents an unreviewed bump.
- [Trade-off] `topic_key` becomes nullable in the tool's response → Accepted: the alternative is a placeholder that can collide, and no caller derives a key automatically, so a null is a signal rather than a failure.
- [Trade-off] Existing non-English keys fragment away from new suggestions → Accepted, bounded, and unmigratable (see below).
- [Risk] The curated stopword list is wrong for a language nobody here reads → Accepted: coverage is explicitly imperfect, and a missing particle degrades the slug rather than breaking it.

## Migration Plan

**None, and deliberately so.** Two facts make a bulk rewrite unsafe, both verified:

1. `topic_key` is never `UPDATE`d anywhere in the codebase — the only repository reference is a read. It is effectively immutable after insert, the same class as `content`.
2. `memory_topic_key_active_uidx` (migration `0018`) is a UNIQUE index over `(scope, COALESCE(project_id,''), topic_key)` where `status='active'`. Two differently-phrased Spanish titles that today produce different keys can normalise to the same key after this change, so an `UPDATE` would hit `UNIQUE constraint failed` — demonstrated with two active rows. If it did not fail, the result would be two active rows in one topic slot, breaking convergence outright.

So existing topics keep their keys and heal on their next save: the new suggestion mints a new key and the old slot simply stops receiving updates. The cost is that `occupied`/`nearby` will not bridge an old key to a new suggestion for those topics — a one-time fragmentation, scoped to non-English topics that already carry a suggested key. Its size is one query away on a populated instance and is recorded as an open question rather than guessed at.

Rollback is reverting the commit plus removing the dependency; no stored data is touched either way.

## Open Questions

1. **How many existing keys does the fragmentation actually touch?** Unmeasured here — this instance's corpus is not representative. On a populated deployment: `SELECT count(*) FROM memory WHERE status='active' AND topic_key IS NOT NULL AND substr(topic_key, instr(topic_key,'/')+1) GLOB '{el,la,de,del,un,antes,en,se}-*'`. Near-zero closes the question; a large number would argue for having `nearby` probe a legacy-shaped prefix for one release.
2. **Slavic particles are not in the list, so a Cyrillic slug can still end on one.** Measured: `Пул соединений базы данных увеличен до 20` yields `pul-soedinenij-bazy-dannyh-uvelichen-do` — usable, and a large improvement on today's `decision/20`, but ending on the transliterated `до`. It cannot be fixed by adding `do` to the set, because `do` is a plausible English technical token and D2's rule excludes those. A script-conditional list (apply Slavic particles only when the source contained Cyrillic) is feasible and deterministic, but it is language detection for a script this corpus does not contain, so it is deferred rather than built. Revisit if a Cyrillic corpus appears.
3. **Is the Greek transliteration acceptable as a stable key**, or should Greek join the refusal path? It produces a usable, deterministic slug, so the default is to accept it; the counter-argument is that `ry8mish` is not recognisable to a Greek reader either.
