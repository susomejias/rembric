## Why

Three published specs describing the plugin tree — `claude-code-plugin`, `codex-distribution`, `plugin-session-protocol` — contain statements that are false against the shipped tree at HEAD, and two of them **forbid behaviour the third requires**. `plugin-session-protocol:259` states, normatively:

> The Claude Code `Stop` hook SHALL NOT be wired in `apps/plugin/hooks/hooks.json`. The Claude Code `pre-compact.sh` script SHALL NOT exist. The Codex `pre-compact.sh` reference in `hooks.codex.json` SHALL be removed (there is no equivalent event in Codex).

All three clauses are false, and all three contradict another published spec. `hooks.json` wires `Stop` at lines 71–81 with `"async": true`, and `claude-code-plugin:105–114` **requires** it. `apps/plugin/scripts/pre-compact.sh` exists at mode 755 and `claude-code-plugin:189` requires it. `hooks.codex.json:51–59` wires `PreCompact`, and `codex-distribution:55` states that Codex **does** support `PreCompact`/`PostCompact`, verified against `codex-rs/hooks/src/schema.rs`. Two more scenarios (`:265`, `:266`, `:272`) repeat the prohibition. An agent treating `plugin-session-protocol` as authoritative — which this repo instructs it to do — deletes the `Stop` hook and `pre-compact.sh`, losing per-turn summary sync and pre-compaction transcript capture on **both** Claude Code and Codex. That is a spec that destroys working code.

The token-budget claims are the second cluster, and they are unsatisfiable by construction rather than merely stale. `claude-code-plugin:432` states `UserPromptSubmit` hook output is `≤30 tokens`. Measured at HEAD (UTF-8 bytes ÷ 4, one trailing newline per emitted line, 36-char UUID session id — reproduced independently for this change):

| Firing surface                              | Cap  | Measured    | Ratio         |
| ------------------------------------------- | ---- | ----------- | ------------- |
| `SessionStart` nudge                        | ≤30  | 22.5        | OK            |
| `UserPromptSubmit` turn 1                   | ≤30  | 142.3       | 4.7×          |
| `UserPromptSubmit` turn 5                   | ≤30  | 81.3        | 2.7×          |
| `UserPromptSubmit` turn 10                  | ≤30  | 140.8       | 4.7×          |
| turn 1 + a recall keyword                   | ≤30  | 165.0       | 5.5×          |
| turn 1 + keyword + `SessionStart` same turn | ≤30  | 187.5       | 6.25×         |
| `SessionStart(compact)` protocol block      | ≤120 | 138.3       | 1.15×         |
| Four command listings (always-on)           | ≤40  | ~68.8       | 1.7×          |
| Command frontmatter descriptions (each)     | ≤10  | 10.3 – 17.5 | all four over |

The root defect is not the numbers: it is that `:432` states a **flat per-turn** figure while the design fires on cadences (turn 1, every 5th, every 10th). A flat per-turn cap was never satisfiable and no test ever checked it. Amortised over a 10-turn window the real cost is 36.4 tokens/turn — a number worth governing, which no requirement states.

The reason none of this was caught is measurable. `apps/plugin/test/nudge-fixtures.test.ts:313` asserts **exactly one** budget in the entire repository:

```ts
expect(fixtures.postCompact.length).toBeLessThanOrEqual(1000);
```

1000 characters is 250 tokens — **2× looser than the spec's own ≤120** — which is precisely why 136 tokens passes CI while violating the contract. `save`, `summary`, `sessionIdTemplate` and `firstPromptRelevance` have **no** length assertion at all, despite `claude-code-plugin:341` and `:368` both requiring "a character budget … asserted in lock-step".

This was already escalated and dropped. `openspec/changes/archive/2026-07-25-reconcile-specs-with-shipped-behaviour/design.md:59–63` carries a "Verdict per finding" table with five rows marked **not carried** — recorded verdict, no task, no delta — and three of them are exactly these findings (the relevance prefetch, the matcher-gated recall hook, the ≤30-token claim). Its `tasks.md:123` states outright that `claude-code-plugin` and `codex-distribution` "have not had an end-to-end pass". Two corrections to that record, verified here: only **two** specs still claim the recall matcher (`claude-code-plugin:91`, `codex-distribution:69` — `opencode-plugin` and `hermes-agent-plugin` do **not**), and the measured token figure is higher than the ~135 it cites.

Now, because leaving it a second time means the next agent implements against it.

## What Changes

Every divergence below was re-verified against the shipped tree at HEAD before being written down. The count differs from the referring audit's 35 because some spec lines carry more than one false claim, and re-verification surfaced two further divergences the referring audit did not list (marked **new**).

### `plugin-session-protocol` — the spec-vs-spec contradiction

- **Strike the three false prohibitions at `:259` outright** and replace them with the shipped wiring. Not softened, not conditioned — the sentence is the single highest-consequence statement in these three specs.
- **Correct the hook-catalog scenarios.** `:264` omits `PreCompact`, `PostCompact` and `Stop`; `:265`/`:266`/`:272` assert their absence. `hooks.json` ships **6 event types / 8 handler entries**; `hooks.codex.json` ships **5 event types / 7 handler entries**.
- **new — `:249` claims Claude `SessionStart (compact)` makes "no HTTP".** `post-compact.sh:25–31` POSTs `/api/<slug>/sessions` as an idempotent session-row ensure before emitting its stdout block. The row is wrong.
- **new — the lifecycle mapping table (`:246–257`) is missing five rows**: Claude `Stop` → `POST /summary {summary, title}` with `final` **omitted**; `PreCompact` → `POST /summary {…, final:false}` on both clients; `PostCompact` → `POST /summary {…, final:false}` on both clients. Verified per script via `rembric_post` call sites. A mapping table that omits half the writes cannot serve as the cross-client contract it claims to be.
- **Raise the `:284` post-compact cap from ≤120 to ≤150 tokens** rather than trimming the text. Chosen over trimming: that block is the highest-consequence instruction in the product — it fires when the model has just lost its context — and cutting 65 characters to save 16 tokens once per compaction risks instruction-following for nothing. `claude-code-plugin:85` asserts the same cap and is fixed in lock-step.

### `claude-code-plugin` — the command catalog, the budget, and the skill's aftermath

Three calls in the command catalog **would be rejected by zod** as written:

- `:51` `memory.search({q: '$ARGUMENTS'})` — the parameter is `query` (`memory-tools.ts:78`). `commands/recall.md:5` is correct; the spec is not.
- `:52` `memory.context({limit: 10})` — `contextSchema` (`memory-tools.ts:200–212`) has no `limit`; it takes `sessions`/`prompts`/`memories`/`includeArchived`/`focus`.
- `:53` `memory.session_summary({auto: true})` — `sessionSummarySchema` (`session-tools.ts:32–36`) is `{sessionId?, summary REQUIRED, title?}`; there is no `auto`.

Promote the catalog from untestable prose into a requirement stating that every command body names only arguments its tool's zod schema accepts, and back it with a test (below). Prose bullets nobody can execute are how three impossible calls survived.

- **`:59` contradicts its own body.** The requirement is titled "SHALL ship exactly four hooks"; `:61` immediately and correctly enumerates six event types. Rename to the shipped shape (6 event types / 8 handler entries) and state the handler count explicitly, since Codex's trust prompt counts handlers.
- **`:91` claims a `UserPromptSubmit` matcher.** `hooks.json:23–31` declares **none**, deliberately: `prompt-search.sh:2–5` says so in the file ("matcher-less; … first-prompt detection needs to see every prompt"). Fixed alongside `codex-distribution:69`.
- **`:93` "Behaviour unchanged from prior spec"** describes a script that now emits **two independent nudges on two independent triggers** (a recall keyword on any turn; the session's first prompt, tracked by its own counter dir `rembric-relevance-prefetch`, separate from `prompt-nudge.sh`'s `rembric-turnnudge`). Replace the cross-reference with the behaviour.
- **`:113`/`:165–171` is an unresolved conditional in a published contract** — "IF validated … IF validation shows `async` does not decouple … per-session counter file". Shipped took a **third** path: `async: true` IS declared (`hooks.json:77`) **and** `stop-sync.sh:91` daemonizes via `_sync >/dev/null 2>&1 &` + `disown`. No counter file exists, so scenario `:165–171` specifies behaviour that does not ship, and the load-bearing mechanism — the `>/dev/null 2>&1` redirect, without which an inherited pipe FD keeps the host waiting regardless of how fast the parent exits — is recorded nowhere. Resolve the conditional, delete the counter-file scenario, specify the redirect.
- **`:335–347`/`:354–357` require a relevance prefetch that does not exist.** `prompt-search.sh` makes **no network call at all** — it sources `_api.sh` but never calls `rembric_post`, and emits one fixed instruction (`:16`) byte-identical whether or not any memory exists. The unreachable-server scenario describes a code path that cannot be reached. **Amend the spec; do not build the feature** (see D1).
- **Everything downstream of the skill's removal.** `:414` says bootstrap is "guided by the `rembric-memory` skill" and `:237` scopes a scenario to "markdown files under `apps/plugin/.claude-plugin/skills/`". The skill was removed — the same spec says so at `:44–45` — and the directory does not exist. `:424` "Skill description ≤35 tokens" and `:430` "Skill body ≤500 tokens" are **vacuous**. Worse: the `:426` "Total: ≤75 tokens" and `:436` "~100 tokens" always-on figures are satisfied **only because** the 35-token line is vacuous; the four command listings alone measure ~68.8.
- **`:404` contradicts `:33` in the same file.** `:404` says the bridge checks `${CLAUDE_PROJECT_DIR}/.rembric` if set, "otherwise `${process.cwd()}/.rembric`". `:33` correctly specifies the three-step chain `CLAUDE_PROJECT_DIR` → `PWD` → `process.cwd()`, matching `rembric-bridge.mjs:33–41`. The `PWD` step is load-bearing for Codex (`codex-distribution:168–174` depends on it). `:404` is stale and must not be the line a reader trusts.
- **The `_api.sh` contract is stale in three ways.** `:184` says `rembric_post` issues `curl -sf`; `_api.sh:78–85` uses `curl -s` (**not** `-f`) plus `-w '\n%{http_code}'`, and logs a stderr diagnostic on any non-2xx — a deliberate observability choice `-f` would defeat. `:186` omits three shipped, load-bearing functions: `rembric_read_project_slug` (`:45`), `rembric_turn_count` (`:101`, the atomic append-and-count-bytes counter both nudge scripts depend on), `rembric_prompt_from_stdin_json` (`:138`). `:189` calls `_transcript.sh` "(unchanged)" while it has gained `rembric_redact_private` (`:51`), the mandatory redaction choke point `post-compaction.sh:30` routes the compaction summary through. The redaction **behaviour** is properly contracted in `plugin-session-protocol:306–330`; what is wrong here is only the stale enumeration, which is why a reader of `claude-code-plugin` alone cannot discover the choke point exists.
- **`:189` carries a second unresolved OR** — "SHALL select the codex_cli variants OR (preferred) dispatch on `$1`". Shipped dispatches on `$1` (`pre-compact.sh:31,50`). Resolve it.
- **Missing budget lines for `SessionEnd` (0 tokens) and `PostCompact` (0 tokens)**, both of which ship as pure side effects.

### `codex-distribution` — substantially more accurate; six defects

State this plainly rather than implying uniform rot: the version-carrier section (`:189–194`) is **fully correct and current** under the unified `plugin` track, the entire Codex MCP-config requirement (`:140–187`) is correct including the `PWD` forwarding rationale and the `env_clear` citations, and the marketplace block (`:25–46`) is correct.

- **`:64` "two matcher groups — one for the default/unmatched case"** — `hooks.codex.json:5` declares an explicit `"matcher": "startup|resume|clear"`, not a default group.
- **`:64` lists `UserPromptSubmit` once**; two entries ship (`prompt-search.sh` and `prompt-nudge.sh`, `:23–39`).
- **`:69` "SHALL declare the matcher …"** — `hooks.codex.json:23–39` declares none on either entry. The self-filter rationale in the rest of `:69` is **correct** and is kept; only the manifest requirement is struck.
- **`:16` requires an `author` block "matching the Claude Code manifest"** — `.codex-plugin/plugin.json:7` has `author.url = https://github.com/susomejias` against `.claude-plugin/plugin.json:8`'s `https://github.com/susomejias/rembric`. Replace the untestable word "matching" with the enumerated field set, and align `author.url` so the tightened requirement is true (see D4).
- **`:76` "differing ONLY in the transcript parser and stdout contract"** — `stop-sync.sh` also differs in the `final` field (`:35–39` sends `"final":false` for Codex, **omits** it for Claude) and in execution model (Codex synchronous and required to `printf '{}'`; Claude daemonized).
- **Add what both specs are silent on: `/rembric:*` commands are Claude-Code-only.** Verified: commands are auto-discovered from `apps/plugin/commands/*.md` with **no** `commands` field in `.claude-plugin/plugin.json`, and `.codex-plugin/plugin.json` declares only `mcpServers` (`:18`) and `hooks` (`:19`). A reader of either spec today has no way to learn that Codex users get no slash commands.

### The tests, which are the point

- **Per-fixture budget assertions** for `save`, `summary`, `sessionIdTemplate` (rendered with a 36-char id), `firstPromptRelevance`, and the recall and `SessionStart` nudges, derived from the amended caps — plus realigning the `postCompact` assertion from 1000 characters to the amended cap. This is the artifact that makes every number above self-defending.
- **A spec-vs-manifest test** asserting the exact hook event set and handler count of `hooks.json` and `hooks.codex.json`, and the **matcher-less** registration of both `UserPromptSubmit` entries, so `claude-code-plugin:59`/`:91` and `codex-distribution:64`/`:69` cannot re-drift.
- **A command-argument test** asserting each `commands/*.md` body names only arguments present in the corresponding zod schema — the class of defect that produced `q`, `limit` and `auto`, caught at build time.

### Deliberately not done

- **The relevance prefetch is not built** (D1).
- **The `sessionId` nudge is not cut** (D2) — measurement shows it does not achieve the cap anyway, and it is the only attachment mechanism under concurrent sessions.
- **Nudge text is trimmed only where a measurement supports it and no instruction weakens** (D6); the change prefers restating caps over trimming.

## Capabilities

### New Capabilities

_None._ This change corrects and completes three existing contracts and adds the tests that hold them.

### Modified Capabilities

- `plugin-session-protocol`: strike the three false prohibitions at `:259`; correct both hook-catalog scenarios to the shipped event/handler sets; correct the `SessionStart (compact)` "no HTTP" row and add the five missing lifecycle-mapping rows; raise the post-compact cap to ≤150 tokens.
- `claude-code-plugin`: rename and correct the hook-catalog requirement; make the `UserPromptSubmit` registration matcher-less and describe `prompt-search.sh`'s two triggers; resolve the `Stop`-cadence conditional to the shipped `async` + daemonization and delete the counter-file scenario; replace the relevance-prefetch requirement with the shipped nudge; promote the command catalog and the token budget from prose into testable requirements (per-firing-turn ceiling + amortised budget + per-line caps, unit pinned); correct the `_api.sh`/`_transcript.sh` enumerations and `rembric_post`'s flags; resolve the `pre-compact.sh` dispatch OR; drop the vacuous skill budgets and the two dead skill references.
- `codex-distribution`: correct the `SessionStart` matcher description, the `UserPromptSubmit` entry count and its matcher requirement; enumerate the manifest fields that must agree instead of "matching"; state the three ways `stop-sync.sh` diverges per client; add the requirement that `/rembric:*` commands are Claude-Code-only.

## Impact

**Specs** (merged at archive, not edited by this change): `openspec/specs/plugin-session-protocol/spec.md`, `openspec/specs/claude-code-plugin/spec.md`, `openspec/specs/codex-distribution/spec.md`. Three prose sections of `claude-code-plugin` sit **above** `## Requirements` and are therefore outside the delta format's reach — `## Command catalog` (`:47–55`), `## Token budget` (`:420–436`), and `## Project slug selection`'s `:404`/`:414`. The first two are promoted into requirements by the deltas; `:404`/`:414` are corrected in place at apply time by an explicit task (see D5).

**Tests** (the substance of the code change): `apps/plugin/test/nudge-fixtures.test.ts` (per-fixture budgets; realign `:313`), plus two new files under `apps/plugin/test/` for the manifest and command-argument assertions.

**Plugin tree**: `apps/plugin/.codex-plugin/plugin.json` (`author.url` alignment only). Any edit under `apps/plugin/` bumps the single unified `plugin` release component (tag `plugin-v*`); it does **not** rebuild the server image. If any nudge text changes, it is a four-client lock-step surface and the `rembric-plugin-development` skill's `pnpm run dev:docker:up` e2e pass is mandatory.

**Docs**: `docs/agents.md`, Codex section — one added statement that `/rembric:*` is Claude-Code-only, required by the new `codex-distribution` requirement.

**Not touched**: no server source, no migrations, no DB schema, no dashboard. No load-bearing invariant is affected — this change adds no MCP tool, touches no design token, and reads nothing from `ctx.project`. `apps/plugin/scripts/*.sh` are read-only inputs unless D6's measurement justifies a text trim.

**Existing installations**: nothing to migrate. There is no persisted state, no derived data to invalidate, and no first-boot behaviour. Rollback is a revert of the tests plus one JSON field. The only user-visible consequence of any nudge-text trim would be different instruction text on the next session start — no upgrade coupling, since hooks are read from the installed plugin tree at each invocation.
