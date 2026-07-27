## 1. Re-verify the ceiling before coding against it

- [x] 1.1 Confirm the truncation mechanism in the locally installed Claude Code binary is still `prompt(){ return U.length > LB ? ma(U, LB) + "… [truncated]" : U }` with `LB = 2048`. Locate it with `grep -abo 'async prompt(){return U.length>LB' <binary>` then dump ~1300 bytes preceding the offset. If the constant is no longer 2048, STOP and re-derive the cap per design D1 (ceiling minus a ~7% margin) before continuing, and update the delta spec's stated ceiling.
- [x] 1.2 Record the verified binary version in the constant's comment (currently 2.1.220) so the next reader knows what was checked and when.

## 2. Add the constant

- [x] 2.1 Export `DESCRIPTION_MAX_LENGTH = 1900` from `apps/server/src/mcp/server.ts`.
- [x] 2.2 Give it a terse comment — ONE line documenting the non-obvious why: that 2048 is a verified Claude Code ceiling (unlike `INSTRUCTIONS_MAX_LENGTH`, which is self-imposed) and that 1900 keeps a margin below it. No banner, no restatement of the signature, no reference to this change or PR. Point at the `mcp-api` requirement for the full rationale rather than reproducing it in code.
- [x] 2.3 Change NO description text. `git diff apps/server/src/mcp/server.ts` must show only the added constant and its comment — verify by confirming the diff contains no line touching a `*_DESCRIPTION` value or any inline `description:` string.

## 3. Add the guard

- [x] 3.1 In `apps/server/src/test/mcp-integration.test.ts`, add a test that issues `client.listTools()` and asserts `description.length <= DESCRIPTION_MAX_LENGTH` for EVERY returned tool (design D3: not over the five `*_DESCRIPTION` constants — 18 of 23 descriptions are inline).
- [x] 3.2 On failure the message must name the offending tool, its measured length, the cap, and the 2048 ceiling the cap protects, so the author who trips it can make the fit-or-raise decision without reading the spec first.
- [x] 3.3 Assert the guard covers every registered tool, not a hardcoded subset — e.g. assert the iterated count equals the `tools.length` from the same response, so a newly registered tool is covered automatically.
  - DEVIATION on the mechanism: `expect(measured).toHaveLength(tools.length)` is tautological (`Array.map` preserves length), so it was dropped rather than shipped as a decorative assertion. Coverage instead comes from deriving the over-cap list from the entire `tools` array plus `expect(measured.length).toBeGreaterThanOrEqual(23)`, which is the assertion that actually gates — it stops an empty or partial listing from passing vacuously.
- [x] 3.4 Measure `String.length`, never `Buffer.byteLength` (design D2). Add an assertion that a description containing multi-byte characters is measured in characters — the current `memory.save` description contains `∈`, `·` and `≤`, so `description.length < Buffer.byteLength(description, 'utf8')` holds for it and pins the unit.
- [x] 3.5 ADDED beyond the original task list, mirroring `apps/plugin/test/nudge-fixtures.test.ts`: a second test asserting the enforced cap value appears verbatim in the `mcp-api` requirement that publishes it, so a code-side bump and a spec-side bump fail together instead of drifting. It accepts either the live `openspec/specs/mcp-api/spec.md` or an unarchived delta under `openspec/changes/*/specs/mcp-api/`, because this change's delta is not merged into the live spec until archive time — the archive-time move is exactly what flips it from delta to live, and both states pass.

## 3b. Correct the `instructions` claim (design D7)

- [x] 3b.1 While verifying `LB` in task 1.1, confirm the SAME constant is applied to `getInstructions()`: `if(p && p.length > LB) f = ma(p, LB) + "… [truncated]"`. This is the evidence for the correction; if it no longer holds, drop section 3b entirely and say so in the commit body.
- [x] 3b.2 Fix the `INSTRUCTIONS_MAX_LENGTH` docstring at `apps/server/src/mcp/instructions.ts:39`: it claims "none of the four clients truncates it". Replace only that clause — Claude Code truncates at 2048 with the same `LB`; the 1000-char cap is chosen for token cost and binds first. Keep it terse; do NOT expand the docstring into a rationale block. The full argument belongs in the spec.
  - DEVIATION: two adjoining clauses were corrected, not one. The docstring's opening "Self-imposed token budget, NOT a client or protocol limit" asserts the same falsehood as "none of the four clients truncates it", so fixing only the latter would have left the docstring self-contradicting. Now reads "Self-imposed token budget, not the binding limit", matching the delta's own wording for the requirement. Still comment-only and still terse (one line net).
- [x] 3b.3 Do NOT change `INSTRUCTIONS_MAX_LENGTH`'s value, the instruction text, or `instructions.test.ts`. Verify: `pnpm vitest run apps/server/src/mcp/instructions.test.ts` passes untouched, and `git diff apps/server/src/mcp/instructions.ts` shows comment lines only.
- [x] 3b.4 Note for the archiver: the delta carries this as a MODIFIED requirement with the full block copied, so archive-time sync replaces `mcp-api/spec.md`'s existing block wholesale. Confirm the copied block still matches HEAD before archiving — if `:719`'s requirement changed meanwhile, re-copy it and re-apply the one-clause edit rather than letting the stale copy overwrite it.

## 4. Evidence gate — prove the test can fail

- [x] 4.1 Temporarily pad the `memory.search` description past 1900 characters (it is 1817 today, so ~90 characters of filler suffice) and run `pnpm vitest run apps/server/src/test/mcp-integration.test.ts`. Confirm RED, and confirm the failure message names `memory.search` and its length.
- [x] 4.2 Also confirm the padded description still passes every EXISTING substring assertion in that file — this demonstrates the gap the guard closes: content assertions read `tool.description` (untruncated) and cannot detect that `prompt()` would cut the tail.
- [x] 4.3 Revert the padding. Confirm GREEN at HEAD. Record both observed lengths (padded and reverted) in the commit body.
  - Observed: padded `memory.search` = 1,903 chars (RED, message named the tool and the length); reverted = 1,817 chars (GREEN, 44/44). Also mutated the cap constant to 1899 to prove task 3.5's drift guard fails when no requirement publishes the value; restored to 1900. NOT recorded in a commit body — this session was instructed not to commit; the evidence is in the session report instead.
- [x] 4.4 No Docker smoke required, and state why in the commit body: the claim is arithmetic ("this string is shorter than 1900 characters"), not behavioural. No migration, no HTTP surface, no MCP wire change, no production behaviour — the constant is read only by a test and `tools/list` bytes are identical before and after. This is a deliberate exception to the standing real-Docker-smoke requirement, justified by a zero-runtime-delta diff, not an omission.
  - No Docker smoke was run. `git diff` is a test file plus a constant plus two comment lines; `tools/list` bytes are unchanged (confirmed by re-measuring the 48,623 B payload in task 5.1, identical to design.md).

## 5. Record the measurements

- [x] 5.1 Confirm the design.md measurement table still reproduces on the current tree: 23 tools, `result.tools` 48,623 B, `outputSchema` 18,388 B (37.8%), `inputSchema` 11,363 B, `annotations` 2,624 B, model-visible `{name, description, input_schema}` 26,001 B, tool-level prose 13,103 chars, per-argument `describe()` prose 4,019 chars, prose share of model-visible 66.4%. Reproduce with a throwaway test that stands up `createMcpServer` over an in-memory transport and calls `tools/list`; DELETE the throwaway before commit (it is measurement, not a regression test).
- [x] 5.2 Confirm the per-tool table: `memory.search` 1,817 (83 chars under the 1900 cap), `memory.save` 1,172, `memory.confirm` 1,099, and every other tool ≤ 991. If `memory.search` has moved, update design.md rather than silently shipping a stale number.
- [x] 5.3 If any figure has drifted, update design.md and say so in the commit body. Do not adjust the cap to accommodate drift without the D1 margin reasoning.
  - Zero drift. Every figure reproduced exactly: 23 tools, 48,623 / 18,388 / 11,363 / 2,624 / 26,001 B, 13,103 + 4,019 prose chars, 17,252 prose bytes, 993 instructions chars, 699 chars resident under deferral, and the whole per-tool table (`memory.search` 1,817 · `memory.save` 1,172 · `memory.confirm` 1,099 · next 991 · rest ≤ 904). design.md needed no edit. The throwaway harness was deleted.

## 6. Verification

- [x] 6.1 `pnpm run typecheck`
- [x] 6.2 `pnpm run lint`
- [x] 6.3 `pnpm test` — full suite green, including the pre-existing `mcp-integration.test.ts` description-substring assertions and `apps/server/src/test/invariants.test.ts`.
- [x] 6.4 `pnpm run eval` NOT required: retrieval is untouched (no ranking, scoring, or query-path change).
- [x] 6.5 (One untracked folder unrelated to this change is present and predates this session: `openspec/changes/enforce-spec-archive-provenance/`, mtime Jul 26.) Confirm `git status` shows changes ONLY in `apps/server/src/mcp/server.ts`, `apps/server/src/mcp/instructions.ts` (comment only), `apps/server/src/test/mcp-integration.test.ts`, and this change folder. No plugin file, no spec file under `openspec/specs/` (the delta is applied at archive time, not now), no migration.
- [x] 6.6 `openspec validate guard-tool-description-truncation --strict` green.

## 7. Deliberately deferred — do not silently lose these

- [x] 7.1 **REJECTED, not deferred: cutting description prose.** Design D4. Recoverable duplication is ~420 chars strict / ~1,500 generous (2.5–8.9% of prose, 115–410 tokens); the `sessionId` bloc is redundant BY SPEC DESIGN (`mcp-api/spec.md:786`, rationale repeated at `:334`); cutting means amending eight requirements; and the justifying claim is behavioural and unmeasurable here — `apps/server/src/test/retrieval/` measures retrieval quality given a query, not tool selection or argument filling. Do not reopen without a tool-selection harness.
- [x] 7.2 **REJECTED: `_meta["anthropic/alwaysLoad"]`.** Design D5. Pinning moves prose INTO resident context, increasing per-turn tokens; its only benefit is tool selection, which is unmeasurable here.
- [x] 7.3 **DEFERRED (own change): verify deferral and truncation in Codex CLI, opencode and Hermes.** Design Q1. Unresolvable with the tools at hand. Needs an instrumented proxy in front of `/mcp` capturing what each client sends and how it renders what it receives — which would settle the token question for all four clients at once. This change is correct regardless of the answer.
- [x] 7.4 **DEFERRED with a stated default: capping per-argument `describe()` strings.** Design Q2. Default is NO cap — 4,019 chars total, no verified client ceiling, `inputJSONSchema` passes through with no length comparison. Revisit only if a client is found to truncate it.
- [x] 7.5 **NOTED, no action: the "~31 KB of tools/list resident every turn" figure is wrong** at `archive/2026-07-25-improve-recall-relevance/design.md:14`, `archive/2026-07-25-add-entity-index/proposal.md:21`, and `archive/2026-07-25-add-entity-index/design.md:31` (design D6: wrong magnitude, `outputSchema` is a 37.8% minority not "the larger half", and Claude Code defers so only ~0.7 KB of names is resident). All three are archived, none is in a live spec — do NOT amend archived changes. The correction lives in this change's design.md so a future change cites the real table.
- [x] 7.6 **NOT deferred — handled in section 3b:** the false "no client enforces" claim about `instructions`, in both the live spec and the code comment.

## 8. Land it in order

- [ ] 8.1 NOT DONE — the applying session was instructed not to commit or push, so ordering against `rescore-relevance-abstention` is the committer's call. Nothing implemented here blocks either order; the collision is a red test, not a merge conflict. Land this change BEFORE or ALONGSIDE `openspec/changes/rescore-relevance-abstention/`. That change reworks abstention semantics against a `memory.search` description with 83 chars of cap headroom, while `mcp-api/spec.md:191` requires the abstention instruction to live in that description. Landing after it means the collision is discovered as an unexplained CI failure instead of a decision.
- [ ] 8.2 NOT DONE — no commit was made (instructed). Conventional Commits; never bypass hooks. Suggested subject: `test(mcp): guard tool descriptions against the 2048-char client truncation ceiling`.
