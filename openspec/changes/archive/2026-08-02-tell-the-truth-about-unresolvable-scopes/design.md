# Design — tell the truth about unresolvable scopes

## Context

One function decides what scope every MCP tool call operates in: `resolveEffectiveScope` (`apps/server/src/mcp/_shared.ts:49-66`). It uses `SCOPE_GLOBAL` in three places, and only two of them are legitimate. The third — `if (ctx.requestedSlug !== null) return { scope: SCOPE_GLOBAL, project: null };` at `:52` — converts "the caller asked to be confined to a project I cannot find" into "the caller may see everything". That is the whole defect.

Two structural facts shape the fix.

**Fact 1 — the resolver has 11 call sites in 5 modules, and their error handling is not uniform.** Verified on `main @390170c`:

| Call site                                                                                                                                                                      | Wrapped in `try`/`errToMcp`?                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| all 16 `requireScope(deps, …)` sites (`memory-tools:1309,1510`, `session-tools:222,269,351`, `relations-tools:155,231,313`, `observability-tools:256,266`, `prompt-tools:166`) | yes, every one                                                          |
| `memory-tools.ts:928` (`handleSearch`)                                                                                                                                         | **no** — the `try` starts on the next line                              |
| `memory-tools.ts:1066` (`handleGet`)                                                                                                                                           | **no**                                                                  |
| `memory-tools.ts:1187` (`handleConfirm`)                                                                                                                                       | **no**                                                                  |
| `memory-tools.ts:1232` (`handleArchive`)                                                                                                                                       | **no**                                                                  |
| `observability-tools.ts:190` (`capture_passive`)                                                                                                                               | **no**                                                                  |
| `prompt-tools.ts:103` (`save_prompt`)                                                                                                                                          | **no**                                                                  |
| `memory-tools.ts:786` (`handleSave`)                                                                                                                                           | n/a — the `isPathScoped()` guards at `:764` and `:775` return before it |

So a resolver that throws would escape six handlers. `mcp-api:1396` requires errors to arrive as `mcpError` — `isError: true` with a JSON `{ ok: false, code, message }` body. An exception escaping into the SDK produces an error result with no machine-readable `code`, which is a different and worse contract.

**Fact 2 — the recovery path does not go through the resolver.** `project.use`, `project.list`, `project.current` (`project-tools.ts`) and `memory.about` never call `resolveEffectiveScope`, so refusing there cannot brick the connection. And `project-tools.ts:89` rejects `project.use` on a path-scoped connection only when the requested slug **differs** from the path slug — so `project.use({slug: '<the path slug>', autocreate: true})` is legal from exactly the connection that is now refusing, which is what makes the write path's existing message a correct instruction for reads too.

Current state of the evidence: see `proposal.md` for the five measured probes plus control.

## Goals / Non-Goals

**Goals:**

- An unresolvable path slug SHALL never resolve to the global scope, on any tool, read or write.
- The refusal SHALL arrive as a structured `mcpError` with `code: 'project_not_found'` and `suggestedSlugs[]`, at every tool routed through the resolver.
- Two error messages stop asserting things that are false or unhelpful.
- The characterization test at `memory-tools.test.ts:1768` flips from asserting the defect to asserting the fix.
- `openspec/specs/mcp-api/spec.md` stops naming a function that does not exist and stops carrying a caveat that no longer applies.

**Non-Goals:**

- Changing what a project-pinned token resolves to on path-less `/mcp` (see §Rejected).
- Rejecting an unknown slug at `initialize` / `authenticate`.
- Re-scoping or cleaning up global rows a previously-leaking connection already wrote.
- Any change to `MemoryService`, `Scope` semantics, SQL, schema, or `apps/plugin/`.

## Decisions

### D1 — Refuse inside `resolveEffectiveScope`, not per handler

`resolveEffectiveScope` throws `DomainError('project_not_found', …)` when `ctx.requestedSlug !== null && ctx.project === null`.

_Why not per handler:_ 19 of the 23 registered tools resolve scope (all but `memory.about`, `project.use`, `project.list`, `project.current`), and exactly one of the 19 — `memory.save` — guards today. Repeating the guard 18 times means 18 chances to get it wrong and a 19th every time a tool is added — which is precisely how `capture_passive` and `save_prompt` ended up writing global rows while `save` refused. The resolver is the single place that already knows both `requestedSlug` and `project`, and `mcp-api:1495` ("Scope-sensitive tools MUST share the single async scope resolver") already establishes it as the one authority.

_Why throw rather than return a discriminated union._ A union (`{ ok: true, scope, project } | { ok: false, code, message, suggestedSlugs }`) would be compiler-enforced, which is the house style for `Scope` and is genuinely the stronger option in the abstract. Rejected because every one of the 11 call sites must turn that variant into the identical `mcpError`, so the union buys a compile error in exchange for 11 near-identical branches, and it would also change the signature `requireScope` and 16 call sites depend on. The exhaustiveness the union would provide is bought instead by D4, which tests the property directly (every registered scope-sensitive tool returns the structured refusal) rather than trusting a shape. `Scope` itself remains compiler-enforced end to end: nothing gains an optional or nullable `Scope`, and the change strictly _removes_ a site that fabricated one.

### D2 — `DomainError` gains an optional structured payload, so `suggestedSlugs[]` survives

`errToMcp` (`apps/server/src/mcp/errors.ts:26-29`) maps a `DomainError` to `mcpError(err.code, err.message)` and drops the third argument entirely, so a thrown error cannot carry a payload today. `DomainError` gets an optional `details?: Record<string, unknown>` and `errToMcp` forwards it.

_Why bother:_ `openspec/specs/projects/spec.md:122` — "When a `project.use({slug})` or **any other resolution path** returns `project_not_found`, the response SHALL include `suggestedSlugs: string[]`". Two of the three existing sites comply (`project-tools.ts:121-123`, `session-tools.ts:144-146`); `memory-tools.ts:776-779` does not. Adding ~14 new `project_not_found` sites that also omit it would turn a single non-compliance into a systemic one — the exact "spec and code silently disagree" failure this repo has been bitten by. So the resolver supplies the suggestions from `deps.projects.findSimilarSlugs`, and the write path at `memory-tools.ts:776` routes through the same helper and picks them up.

_Alternative rejected:_ leave `suggestedSlugs` out and note the gap. Rejected — it makes the change knowingly ship a violation of an in-force requirement.

_Alternative rejected:_ a bespoke `ProjectNotFoundError` subclass carrying the field. Rejected — `errToMcp` would need a second `instanceof` branch, and every other structured error (`project_switch_requires_confirm`, `session_active_must_end`, `project_suggestion_pending`) has the same latent need. One optional field on `DomainError` covers all of them.

_Constraint this imposes:_ `deps.projects` is optional on `ScopeResolutionDeps` (`_shared.ts:23-25`). When absent, the refusal still fires with `suggestedSlugs: []` — never with a global scope. The suggestions are advisory; the refusal is not.

### D3 — The six unguarded call sites move inside their existing `try`

No new `try` blocks: `handleSearch`, `handleGet`, `handleConfirm`, `handleArchive`, `handleCapturePassive` and `handleSavePrompt` each already have one, starting one to five lines after the resolver call, and each already ends in `return errToMcp(err)`. The resolver call moves in.

`handleGet` and `handleConfirm` do argument validation (`provide exactly one of 'id' or 'ids'`) between the resolver call and the `try`. Moving the resolver in reorders those two checks: an unresolvable slug will now be reported before a malformed argument. That is the right order — the connection is unusable regardless of the arguments — but it is a visible reordering and gets its own scenario so it is a decision on the record rather than an accident.

### D4 — The guard is proven by enumerating every registered tool, not by grep

A lexical invariant ("every `resolveEffectiveScope` call is inside a `try` whose `catch` returns `errToMcp`") is brittle to write and easy to satisfy vacuously. Instead: a table-driven test invokes **every** registered MCP tool on a `/mcp/<unresolvable-slug>` context with a `*` token and asserts each response is either the structured `project_not_found` envelope or is on a short, explicitly-justified exemption list (`memory.about`, `project.use`, `project.list`, `project.current` — the recovery path from D-context Fact 2).

The table is derived from the registered tool list rather than hand-written, so a tool added later without a decision fails the test instead of silently inheriting a fallback. This is the mechanism that replaces the compile error D1 declined.

### D5 — `scope_locked` message: align with `instructions.ts`, keep the code

Wording becomes, in substance: _this connection is path-scoped to project `<slug>`; global writes are not permitted and user-wide memory is not reachable here; save this as a project memory instead, or ask your operator to add a path-less `/mcp` entry._

Checked against every constraint on this message before changing it:

- `mcp-api:31` — "a message naming the bound project". Satisfied; the slug is interpolated as today.
- `sessions:273` governs a **different** message (`session-tools.ts:139`, `memory.session_start` with a mismatched `project` arg), which makes no false promise and is untouched.
- No spec mandates the "open a separate MCP connection" sentence. Nothing in `openspec/specs/` prescribes this message's body beyond naming the project.

_Why it is false:_ each client has one MCP entry, and `rembric-bridge.mjs` derives the URL path from `.rembric`. The agent cannot mint a second entry; only the operator can. `instructions.ts:33` already retracted the equivalent claim ("User-wide memory is not reachable here"), so today `initialize` and the error contradict each other on the same connection. Naming the operator as the actor is the honest form.

### D6 — `forbidden` message: name the remedy where the caller can act on it

`assertAuthorized` (`_shared.ts:91-100`) gains an optional `deps` parameter. When the target scope is global, the check failed, the connection is not path-scoped, and the token is pinned to exactly one project, the message appends the remedy: `project.use({slug})` or reconnect at `/mcp/<slug>`.

_Why the optional parameter:_ `assertAuthorized` reads only `getRequestContext()`, which carries `token.projectId` but no slug. Resolving the id to a slug needs `ProjectsService`. Every production call site already has `deps` in hand (all 16 `requireScope` sites by construction, and the six direct sites from D3), so the slug is always available in practice; the parameter stays optional so the function keeps working in tests and in `project-tools.ts:128` without ceremony. When it is absent the message still names the remedy, just with the project id rather than the slug.

_Alternative rejected:_ put the hint in `requireScope` only. Rejected — the six tools the issue's own table lists as returning `forbidden` (`memory.context`, `memory.search`, …) include four that call `assertAuthorized` directly, so the hint would be missing from exactly the calls that report the problem.

### D7 — `mcp-api:47` corrected to `findBySlug`, and why `findOrCreate` would be the wrong fix

`grep -rn findOrCreate apps/server/src` → zero hits. The method was removed by `add-sessions-and-research-tools` and `openspec/specs/projects/spec.md:106-113` records the replacement. `mcp-api:47` was never updated, and its scenario at `:52` still says "creating it if needed" — which directly contradicts `projects/spec.md:113`: "auto-create on read is forbidden". The spec is internally inconsistent and the code is right.

Recording why the other direction is not an option, since "make the spec true by implementing `findOrCreate`" is the tempting read of the drift:

1. It would run at the **auth layer**, before any authorization decision. Any `*` token could mint an arbitrary project row by requesting an arbitrary URL — project creation by GET, with no `write` check. `project.use({slug, autocreate:true})` deliberately gates that on `isAuthorized(ctx.scope, 'write', …)` (`project-tools.ts:107`) _before_ inserting.
2. It converts a typo into a silently-created empty project. The operator gets a `projects` list polluted with near-misses, and the agent gets an empty but "working" scope — a silent data-loss shape, because saves succeed into a project nobody will look at.
3. It would break `projects/spec.md:51`, which is the requirement this change exists to honour.

### Rejected — resolving a project-pinned token on path-less `/mcp` to its own project

Issue #302's primary proposal. Out of scope by decision, not oversight:

- There is a working, one-call workaround (`project.use({slug})`), and `project-tools.ts:128` already authorizes it against the token's own project id.
- It moves `memory.save({scope:'project'})` on a path-less connection from `project_required` to a silent write into the token's project. `project_required` is a specified contract (`mcp-api:63`, `projects:61`) with a message that names two remedies; changing what it does is the actual decision in that proposal, not the scope default.
- It interacts with the roots-discovery suggestion gate (`memory-tools.ts:791-798`): a token-derived project silently outranking a pending suggestion the agent has not acted on is a behaviour that needs its own evidence, and `mcp-api:1012` is a requirement it would have to be reconciled against.

This change takes the issue's own "Alternative, cheaper" instead (D6): improve the message, change no behaviour. The two halves of #302 are the same fallback in opposite directions, but only one of them is a leak; the other is a dead end with a documented way out. Shipping the leak fix should not wait on the ergonomics decision.

## Risks / Trade-offs

- **[Risk] A deployment whose `.rembric` names a renamed/deleted slug goes from working-but-wrong to visibly broken on the first boot after upgrade.** Every memory tool returns `project_not_found`. → Mitigation: the refusal message already names the three remedies (correct the slug, create it from the dashboard, `project.use({slug, autocreate: true})`), `suggestedSlugs[]` names the likely intended project by Levenshtein distance, and the recovery tools (`project.*`, `memory.about`) stay reachable. The release notes must call this out — it is the one user-visible transition in the change.
- **[Trade-off] Throwing from the resolver is not compiler-enforced.** A future call site can forget the `try`. → Accepted because D4 tests the property at the tool boundary for every registered tool, which catches the omission that a type would only catch at the one new site — and catches it for tools added by someone who never read this design.
- **[Risk] Reordering argument validation after scope resolution in `memory.get`/`memory.confirm` changes which error a malformed call on an unresolvable slug receives** (`project_not_found` instead of `invalid_input`). → Mitigation: specified explicitly with its own scenario, so it is a contract rather than a surprise. No client branches on `invalid_input` there.
- **[Trade-off] Global rows already written by a leaking connection are left in place.** → Accepted because append-only forbids re-scoping them (`content` is never `UPDATE`d, `scope` is not a lifecycle field) and no heuristic can reliably distinguish them from legitimate user-wide memories. Recorded in `proposal.md` with the dashboard filter that finds them.
- **[Trade-off] `DomainError` grows a field.** → Accepted; one optional property, additive, and it retires the reason `errToMcp` could not carry the payload that three existing sites already build by hand.
- **[Risk] A `*`-token deployment that has been _relying_ on `/mcp/<anything>` behaving as `/mcp`** — e.g. a hand-written MCP entry with a stale slug that has been quietly serving user-wide memory for months, which the operator experiences as "it worked yesterday". → Mitigation: same remedies as the first risk; there is no supported configuration this removes, since `mcp-api:24` and `projects:51` never permitted it.

## Migration Plan

No data migration. No schema change, no new column or index, nothing derived to invalidate — `memory_fts`, `memory_vec` and the three entity tables are regenerable from `memory` and no `memory` row is written, moved or re-scoped by this change.

Deploy: plain image upgrade. First boot after upgrade needs no step; the only transition is in live request handling, described under Risks.

Rollback: plain image downgrade, no data step, no forward-only migration. The previous version resumes the leak — which is the whole point of shipping the release note.

## Open Questions

1. **Should `docs/troubleshooting.md` grow a `project_not_found` section?** The change corrects the two lines that are now wrong (`troubleshooting.md:124`, `agents.md:19`). Whether the new failure mode deserves its own troubleshooting entry is an editorial call left to the applier; the tasks include it as an item rather than a requirement, because a spec cannot usefully mandate a doc section.
2. **Should the bridge or the installer close the gap that produces an unresolvable slug in the first place?** Nothing joins the slug in `.rembric` to a row in `projects` except the operator typing it twice (see `proposal.md` §Why). A bridge-side pre-flight, or an installer step that creates the project, would prevent the condition rather than report it. Deliberately not decided here: it is a plugin change across four clients, it needs its own evidence about what the bridge may do at connect time, and it does not reduce the need for the server to refuse. Left open, not defaulted.

Settled with a default rather than parked:

- **Distinguishing "slug never existed" from "slug was renamed"** is not a question: slugs are immutable. `ProjectsService.rename` (`services/projects.ts:83-90`) writes `displayName`, `projects-repository.ts` has no slug write, and projects are archived rather than deleted. One undifferentiated `project_not_found` with `suggestedSlugs[]` is the whole answer.
- **Whether an archived project's slug should behave like an unresolvable one.** No — it already has its own path, and it is upstream of this change: `auth.ts:76-82` throws `AuthError('project_archived', …, 403)` at the handshake. Untouched.
