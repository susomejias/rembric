# Tell the truth about unresolvable scopes

## Why

`resolveEffectiveScope` treats a path slug that names no project as a positively-established **global** scope:

```ts
// apps/server/src/mcp/_shared.ts:51-52
if (ctx.project) return { scope: projectScope(ctx.project.id), project: ctx.project };
if (ctx.requestedSlug !== null) return { scope: SCOPE_GLOBAL, project: null };
```

`authenticate` deliberately lets that handshake succeed — `apps/server/src/server/auth.ts:74` is `const project = pathSlug && pathSlug.length > 0 ? (projects.findBySlug(pathSlug) ?? null) : null;`, and its own docstring (`auth.ts:48`) says the tool call is what should return `project_not_found`. So `/mcp/<typo>` is a live, usable connection whose effective scope is the user's entire memory.

**Measured on `main @390170c`**, four probes plus a control, all through the built handlers with a `*` token at `/mcp/no-such-project`:

| Call                                       | Result                                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| CONTROL — `memory.save({scope:'project'})` | `project_not_found` — correct (`memory-tools.ts:775-779`)                                           |
| `memory.get('<global id>')`                | returns the global memory in full: `content`, `head`, history                                       |
| `memory.search`                            | returns global rows (the characterization test at `memory-tools.test.ts:1768` asserts exactly this) |
| `memory.capture_passive`                   | **writes** — row landed with `scope='global'`, `project_id=null`                                    |
| `memory.save_prompt`                       | **writes** — prompt landed with `project_id=null`                                                   |

The control is what makes the rest a finding rather than a broken probe: `memory.save` is the **only** tool that refuses. Everything else — reads and two write tools — falls through to global. The last two rows are new; issue #302 records the read half only, so "the write path already does the right thing" holds for `memory.save` and for nothing else.

**Amended during implementation — a THIRD write leak, found by the enumerating guard this change adds.** `memory.session_start` does not call `resolveEffectiveScope` at all; it resolves the session's project with its own ladder (`ctx.project?.id` → router entry → `null`), so the resolver fix does not reach it. Measured with the same probe shape and the same control: on `/mcp/no-such-project` with a `*` token it returned `{"scope": "global", "projectId": null}` and inserted an `agent_sessions` row, while the identical call on a resolvable slug returned `{"scope": "project", "projectId": "…"}`. It needed its own guard. This is the concrete vindication of D1's argument: the leak spread by _omission from a call-site list_, which is precisely what D4's enumeration — not a call-site audit — is there to catch.

Two requirements already in force are violated, verbatim:

- `openspec/specs/mcp-api/spec.md:24` — "`memory.search` SHALL return only memories whose `scope = 'project'` and `project_id` equals the bound project; global memories SHALL NOT be returned."
- `openspec/specs/projects/spec.md:51` — "**THEN** the `initialize` SHALL succeed (path-scoping does not enforce existence pre-tools), BUT any tool call that resolves the scope into a `project_id` SHALL respond with `project_not_found` and SHALL NOT auto-create"

So this is not a new contract; it is code that never met the one written. The contrast is sharp against the HTTP surface, where the same condition is already handled: `openspec/specs/http-api/spec.md:26` mandates `404 { ok: false, code: 'project_not_found', slug }`, implemented at `apps/server/src/server/api-router.ts:97,137,181,223`. Only MCP leaks.

Reachable through the shipped, documented setup. `.rembric` is hand-authored — `apps/plugin/README.md:134` is literally `echo "PROJECT_SLUG=my-app-slug" > .rembric` — and **nothing creates the project server-side**: `rembric-bridge.mjs:59-62` path-scopes the URL on any slug matching `SLUG_RE`, and no installer, hook or plugin code path calls `project.use({autocreate})` or the dashboard create form. So the slug in `.rembric` and the slug in the `projects` table are joined by nothing but the operator typing the same string twice. Three concrete ways they diverge:

1. A typo, or a slug written before the project was created in the dashboard.
2. `apps/plugin/README.md:143` recommends **committing** `.rembric` "when the whole team should share the same Rembric project for this repo". Every teammate who clones that repo against their own Rembric server gets a path-scoped connection to a slug that does not exist there.
3. A restore from a backup taken before the project row existed, or a fresh volume.

Note: the reachability claimed in issue #302's first comment — "a project renamed or re-slugged in the dashboard" — does **not** hold and is not the argument here. Verified: `ProjectsService.rename` (`services/projects.ts:83-90`) updates `displayName` only, `projects-repository.ts` has no slug write, and projects are archived rather than deleted. A slug is immutable once minted, by design (`db/schema/projects.ts:17-18`: "Canonical project identifier (slug). Cross-machine stable.").

In every reachable case the failure is the same: a per-project connection silently becomes a user-wide one — reads widen, and passive captures start depositing that project's material into global memory, where it is then served to every other project's connection.

The fix also earns the right to delete a caveat that exists only because of this defect. `openspec/specs/mcp-api/spec.md:2178` currently reads: "This requirement governs the widening argument only, and therefore cannot constrain a connection whose _base_ scope is already global. A path slug that does not resolve to an existing project currently resolves to the global scope rather than to an error, so on such a connection every read is a global read and ignoring `include_global` changes nothing. That fallback is a separate defect in scope resolution, tracked outside this requirement; until it is fixed, the isolation guarantees above hold for a path-scoped connection whose slug resolves." Once the base scope can no longer be global on a path-scoped connection, the last two sentences are false and must go.

Separately, two error messages on this surface tell the agent things that are not true:

1. `memory-tools.ts:767-770` — the `scope_locked` message says "To save a user-wide memory, open a separate MCP connection at '/mcp' (no project slug) with the same token." The agent cannot do that. There is one MCP entry per client and `rembric-bridge.mjs` derives the path from `.rembric`; only the operator can add a second entry. The equivalent claim was already retracted from the other surface of the same connection — `instructions.ts:33` now reads "User-wide memory is not reachable here" — so `initialize` and the error now contradict each other. **This one is new here, not in the issue.**
2. `_shared.ts:97` — a project-pinned token on path-less `/mcp` is denied with `token scope 'project:<id>' does not authorize read on global scope`, which reads like a misconfigured token. The token names the project; the server is refusing a scope the caller never asked for and never mentions the one-call fix (`project.use({slug})`).

## What Changes

- **`resolveEffectiveScope` stops manufacturing a global scope from an unresolvable slug.** When `ctx.requestedSlug !== null` and `ctx.project === null`, it refuses with `project_not_found` instead of returning `SCOPE_GLOBAL`. Fixing it in the resolver rather than per-handler is the decision: 19 of the 23 registered tools resolve scope and only `memory.save` currently guards, so a per-handler fix would have to be repeated 18 times and re-repeated for every tool added afterwards. One resolver, one refusal, uniform across reads and writes.
- **The refusal reuses the message the write path already ships** (`memory-tools.ts:778`: `project '<slug>' does not exist; create it from the dashboard or call project.use({slug, autocreate: true})`) rather than inventing a second wording. There is no new ergonomics decision to make here — the remedy was chosen, shipped and documented when the write guard landed, and it works from a path-scoped connection: `project-tools.ts:89` rejects `project.use` only when the requested slug **differs** from the path slug, so `project.use({slug: <the path slug>, autocreate: true})` is a legal escape hatch. `project.use`, `project.list`, `project.current` and `memory.about` do not resolve scope, so the connection is never bricked.
- **The refusal carries `suggestedSlugs[]`.** `openspec/specs/projects/spec.md:122` already requires it on "any other resolution path" that returns `project_not_found`; `project-tools.ts:121-123` and `session-tools.ts:144-146` comply, `memory-tools.ts:776-779` does not. Adding new `project_not_found` sites without it would multiply an existing non-compliance, so the shared helper supplies it and the write path picks it up in the same pass. This requires `DomainError` to be able to carry a structured payload — `errToMcp` currently drops the third `mcpError` argument for thrown domain errors.
- **The `scope_locked` message stops promising a second connection.** It aligns with the wording already approved for the other surface of the same connection (`instructions.ts:33`, "User-wide memory is not reachable here"). No behaviour change; `code: 'scope_locked'` and the requirement that the message name the bound project (`mcp-api:31`) are untouched.
- **The `forbidden` message on a project-pinned token names the way out** — `project.use({slug})` or reconnecting at `/mcp/<slug>`. No behaviour change. This is issue #302's own "Alternative, cheaper" option, taken deliberately in place of its primary proposal.
- **NOT changing: the scope default for a project-pinned token on path-less `/mcp`.** The issue's primary proposal (resolve to the token's own project) is out of scope. It has a working workaround, it moves `memory.save({scope:'project'})` from `project_required` to a silent write, and it interacts with the `pendingSuggestionGate` (`memory-tools.ts:791-798`) in a way that needs its own evidence. Recorded in `design.md` §Rejected.
- **The characterization test is inverted, not deleted.** `memory-tools.test.ts:1768` (`KNOWN DEFECT #302 …`) asserts the wrong behaviour on purpose and says so in its own comment: "This test SHOULD FAIL once #302 is fixed — invert it there rather than deleting it."
- Spec drift corrected in the same pass: `openspec/specs/mcp-api/spec.md:47` mandates resolution "via `projects.findOrCreate(slug)`". **`findOrCreate` has not existed in production code since the `add-sessions-and-research-tools` change** — `grep -rn findOrCreate apps/server/src` returns zero hits, and `openspec/specs/projects/spec.md:106-113` records its removal. The spec is the side that is wrong.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mcp-api`: four requirements change.
  1. _Path-scoped connections MUST enforce strict project isolation_ — gains the unresolvable-slug clause, so the isolation contract covers a slug that names nothing instead of being silent about it.
  2. _The MCP endpoint MUST support path-based project scoping_ — `projects.findOrCreate(slug)` corrected to `findBySlug(slug)`, and the "creating it if needed" scenario corrected, since auto-create on read is forbidden by `projects:113`.
  3. _Scope-sensitive tools MUST share the single async scope resolver_ — the shared resolver gains its refusal behaviour and the requirement that every tool routed through it surfaces that refusal as a structured `mcpError`, not an escaped exception.
  4. _`include_global` MUST be ignored unless the connection is authorized for global reads_ — the `:2178` caveat is deleted.
     Plus one added requirement covering the two error messages, so "the message must not promise something unreachable" is a checkable contract rather than a code comment.

Checked and deliberately **not** given a delta:

- `projects` — `projects/spec.md:51` and `:122` already require exactly this behaviour and this payload. This change implements them; restating an unchanged requirement in a delta would be noise at archive time. The fact that the code violated an in-force requirement is recorded here and in `design.md`, which is where it belongs.
- `http-api` — `http-api/spec.md:23-26` already mandates `404 project_not_found` on an unknown slug and the router already does it. Nothing on the HTTP surface changes.
- `memory` — the `memory` capability governs `MemoryService` and `Scope` at the service layer. This change is entirely upstream of it, in MCP scope resolution; no service behaviour, no query, no `Scope` semantics change.
- `sessions` — `sessions/spec.md:273` requires the `memory.session_start` `scope_locked` message to clarify the path-scoping. That message (`session-tools.ts:139`) makes no false promise and is untouched. `memory.session_start` on an unresolvable slug does change (it will refuse instead of creating a global session), but that is the shared-resolver requirement in `mcp-api`, not a sessions-contract change.
- `auth` — `auth.ts` keeps letting the handshake succeed. That is deliberate and specified (`projects:51`); moving the rejection to `initialize` would be a different change with a worse failure mode (no structured tool error, no `suggestedSlugs`).

## Impact

**Durable invariants.** Append-only is untouched (no `DELETE`, no `content` `UPDATE`). Scope-at-the-service-layer is untouched and reinforced: `Scope` stays a compiler-enforced parameter, and this change removes the one place that fabricated one. `topic_key` convergence, fresh-context judgment and derived-never-stored review state are all unaffected. No SQL is added, so the `db/`-confinement invariant is untouched.

**Code:**

- `apps/server/src/mcp/_shared.ts` — `resolveEffectiveScope` refuses; `assertAuthorized` gains the project-pinned remedy hint.
- `apps/server/src/services/errors.ts` — `DomainError` gains an optional structured payload so `suggestedSlugs[]` survives the throw.
- `apps/server/src/mcp/errors.ts` — `errToMcp` forwards that payload.
- `apps/server/src/mcp/memory-tools.ts` — the `scope_locked` message; the direct `resolveEffectiveScope` calls in `handleSearch:928`, `handleGet:1066`, `handleConfirm:1187`, `handleArchive:1232` move inside their existing `try`; the write-path `project_not_found` at `:776` routes through the shared helper and gains `suggestedSlugs[]`.
- `apps/server/src/mcp/observability-tools.ts:190` and `apps/server/src/mcp/prompt-tools.ts:103` — the two unguarded write call sites found by probe.
- `apps/server/src/mcp/session-tools.ts` — `memory.session_start`'s own guard (the third leak, above) and `deps` forwarded to `assertAuthorized`.
- `apps/server/src/services/tokens.ts` — `pinnedProjectId()`, next to `isAuthorized` so the token-scope grammar stays parsed in one place.
- `apps/server/src/mcp/memory-tools.test.ts:1768` — the characterization test, inverted.
- `apps/server/src/mcp/session-scope-resolution.test.ts:314` — a second test that characterized the same fallback, re-pointed at the refusal.
- `apps/server/src/mcp/unresolvable-slug.test.ts` — new: the enumerating guard plus the read/write/recovery/message cases. Not `invariants.test.ts`, which constructs no `McpServer`.
- `docs/troubleshooting.md:124` ("Open a second connection at `/mcp` for user-wide writes.") and `docs/agents.md:19` — both restate the retracted claim.

**Existing installations.** No migration, no schema change, no new column, no index. Nothing derived needs invalidating: `memory_fts`, `memory_vec` and the three entity tables are untouched, since no row is written, moved or re-scoped. Rollback is a plain image downgrade with no data step.

The behaviour change **is** visible on first boot after upgrade, and deliberately so: a deployment whose `.rembric` names a slug that no longer exists goes from silently reading and writing user-wide memory to `project_not_found` on every memory tool. That is the fix working, but it is a live-traffic transition and the release notes must say so, with the three remedies (correct the `.rembric` slug, create the project from the dashboard, or `project.use({slug, autocreate: true})`).

Global rows that a previously-leaking connection already wrote stay exactly where they are. Append-only forbids re-scoping them and this change does not attempt it; `content` is never updated and `scope` is not a lifecycle field. Operators who suspect a stale-slug connection can find them in the dashboard by `scope=global` plus the capture window.

**Plugin tree.** No client-facing change. `apps/plugin/` is not touched — the bridge already derives its path from `.rembric` and does not interpret error codes.

Related: issue #302 (both comments), GHSA-cc4j-ch4r-9pf5, change `gate-global-widening-on-authorization`.
