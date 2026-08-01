## 1. Pin today's behaviour before changing it

The English rows are the half that fails silently, so they get asserted first, against the CURRENT implementation.

- [x] 1.1 In `apps/server/src/mcp/topic-key.test.ts`, add the issue's two English rows as literal expected strings taken from a run of the current code (`feedback/check-port-launching-server-minipc`, `decision/rack-ventilation-two-92-mm-intake`). These MUST stay byte-identical through the whole change; if they move, the stopword set is over-extended.
- [x] 1.2 Add failing fixtures for every case the change must fix, each as a literal: the three Spanish rows, the accented Spanish row, German (`ß`), a Nordic row (`ø`/`æ`), Cyrillic, Greek. Observe each failing and record the current output beside it.
- [x] 1.3 Add a failing fixture per degenerate case — Hangul and CJK-without-ASCII — asserting `topic_key` is null with a non-empty `reason`. Observe failing.
- [x] 1.4 Add property assertions, not just fixtures: no returned slug ends in a stopword, short high-signal tokens (`92`, `mm`, `2x`) survive, and two titles differing only in diacritics produce one key.

## 2. The dependency

- [x] 2.1 Add `slugify` to `apps/server/package.json` dependencies, pinned by the lockfile, and run `pnpm install`. Confirm `pnpm-lock.yaml` records a registry tarball with a checksum and that the dependency has no transitive deps.
- [x] 2.2 Confirm no supply-chain inventory change is needed: `slugify` declares no install-time lifecycle script, so `pnpm-workspace.yaml::allowBuilds` and `ALLOWED_BUILD_SCRIPTS` (`apps/server/src/test/supply-chain-inventory.ts`) stay untouched. Run `pnpm vitest run src/test/supply-chain-inventory.test.ts` and confirm green WITHOUT editing the inventory — if it reds, that is a finding to report, not an inventory to edit.
- [x] 2.3 Confirm the install did not weaken any knob: `.npmrc` and `pnpm-workspace.yaml` unchanged apart from nothing, and `pnpm install --frozen-lockfile` succeeds from clean.

## 3. The slug

- [x] 3.1 In `apps/server/src/mcp/topic-key.ts`, delegate character normalization to the library. The module's own private function is also called `slugify` — rename one of them (the import, e.g. `import transliterate from 'slugify'`) so the collision is not resolved by accident. Call it with `{ lower: true, strict: true }`; anything looser leaves unmapped characters in the key.
- [x] 3.2 Extend `STOPWORDS` with the Romance/Germanic particles, EXCLUDING any that is also a plausible English technical token (`die`, `no`, `si`, `do`, `da`, `der` are the known traps — design D2). Keep the set a static literal so the function stays deterministic and corpus-free.
- [x] 3.3 Report "no usable slug" from the slug builder instead of falling back to `untitled`: an empty result, or one with no alphabetic token, is the degenerate case. Do not invent a placeholder (design D3).
- [x] 3.4 Strip trailing STOPWORDS after the budget is applied, so no slug ends on a dangling particle. Stopwords only, not a length rule: a length rule would also strip `92`, `mm` and `2x` — the same objection that sinks ranking by length (design D2). Measured while implementing: a sub-3-char rule cut the trailing `20` off the Cyrillic row.
- [x] 3.5 Confirm every group-1 fixture is now green and 1.1's English rows are still byte-identical.

## 4. The tool surface

- [x] 4.1 In `apps/server/src/mcp/relations-tools.ts`, make `suggestTopicKeyOutput.topic_key` nullable and add `reason` (present only when the key is null). Keep `occupied` / `occupantId` / `nearby` shaped as they are — when there is no key there is nothing to look up, so they SHALL be absent or empty rather than computed against a placeholder.
- [x] 4.2 Update `handleSuggestTopicKey` to short-circuit on the degenerate case: no `occupied` probe, no `nearby` scan, just the null and the reason.
- [x] 4.3 Update the tool description to say a null is possible and what the agent should do (author its own key — `normalizeTopicKey` accepts Unicode). Stay inside `DESCRIPTION_MAX_LENGTH`.
- [x] 4.4 Check no caller assumes a non-null `topic_key`: `grep -rn "suggest_topic_key\|suggestTopicKey" apps/ docs/ README.md`. `apps/plugin/` must have zero hits.

## 5. Verification

- [x] 5.1 `pnpm run typecheck` and `pnpm run lint` clean.
- [x] 5.2 `pnpm test` fully green, no test skipped or weakened. An existing red is a finding to report — in particular `relations-tools.test.ts` derives expected keys by calling the function, so it should follow silently; if it does not, say why before adjusting anything.
- [x] 5.3 Mutation-check that both halves are load-bearing: revert the stopword extension alone and confirm the Spanish rows redden while English stays green; revert the transliteration alone and confirm the accented/Cyrillic rows redden. Restore and verify byte-identical.
- [x] 5.4 Confirm the degenerate path cannot be reached with a title that has usable ASCII — a mixed title (`한국어 rack ventilation`) must still produce a key.
- [x] 5.5 Re-run the issue's full probe table and record the before/after in the commit body.

## 5b. Discovered by review: three regressions and a dead branch

- [x] 5b.1 The library deletes `.` `_` `/` instead of splitting on them, so `db/client.ts pragma` collapsed to `dbclientts-pragma`. Pre-pass maps them to spaces; three fixtures pin it.
- [x] 5b.2 The alphabetic-token check ran over ALL tokens while only six are kept, so `20 20 20 20 20 20 rack` produced `decision/20-20-20-20-20-20` — the exact shape the refusal exists to prevent. Check moved onto the kept slice.
- [x] 5b.3 `trimTrailingParticles` was dead: the stopword filter runs before the join, so no kept token can be a stopword. Its test passed with the function deleted, which is what exposed it. Function, docstring, module-docstring claim and vacuous test all removed.
- [x] 5b.4 Two duplicate stopword entries and a per-call regex literal — removed and hoisted.

## 5c. Discovered by measurement: replace the hand-curated list with the library

The hand list's exclusion policy existed only as a comment and was measurably violated — 20 of 21 English technical titles changed, losing `DOS`, `MIT`, `en`, `lo`, `Y`, `AL`/`IL`, `para`.

- [x] 5c.1 Add `stopword@3.1.5` (zero deps, MIT, no lifecycle scripts). Confirm the supply-chain inventory needs no change — it does not, verified green without editing it.
- [x] 5c.2 Declare the two arrays locally in `stopword.d.ts`: the package ships no types and `@types/stopword` is pinned to major 2.
- [x] 5c.3 Enable `eng` + `spa` only, exported as `STOPWORD_LANGUAGES`. Measured: `romance+germanic` eats `dos`/`mit`, all 60 eat `global`/`save`/`stop`, and against 120 real repo titles the wider sets change 48–56%.
- [x] 5c.4 Delete the hand-written particle list.

## 5d. The cross-language regression harness

- [x] 5d.1 A 17-row language matrix (en, es, de, fr, pt, it, da, ru, el, tr, pl, ja, zh, ko) pinning the exact key per language, so enabling a language shows its gain in the diff.
- [x] 5d.2 Pin `STOPWORD_LANGUAGES` so widening it cannot happen silently, plus an assertion that every script class the transliteration claims is represented.
- [x] 5d.3 Four cross-language properties: determinism, token/char budget, ASCII-only output, at least two tokens per key.
- [x] 5d.4 Forty protected-vocabulary assertions naming the words this codebase cannot lose (`global`, `save`, `stop`, `dos`, `mit`, `die`, `der`, …).
- [x] 5d.5 Mutation-verify the harness: enabling ten languages must redden both halves of the trade — the matrix rows that gain AND the vocabulary assertions that pay. Measured: 10 failures, 5 of each kind.

## 6. Close-out

- [x] 6.1 `/simplify` over the diff, then the correctness review; resolve findings before archiving.
- [x] 6.2 Archive via the `sdd-archiver` agent. This delta is a `MODIFIED` requirement, unlike the previous two changes — verify the merged text replaced the `memory.suggest_topic_key` requirement in full, that no neighbouring requirement was touched, and that the corrected family list no longer names types outside `MEMORY_TYPES`. The pre-change requirement text is saved at `/tmp/.../scratchpad/orig-stk.md` for the comparison.
- [x] 6.3 `pnpm run check:spec-provenance` clean.
- [ ] 6.4 Commit and push. No embargo.
- [ ] 6.5 Comment on #300: what shipped, that the library alone fixed none of the reported rows (so both halves were needed), the Greek cosmetic weakness, and the fragmentation query the reporter offered to run.
