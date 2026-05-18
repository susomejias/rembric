## Context

Rembric was conceived as a memory layer that learns from — and replaces — a small set of public reference implementations of the same idea: `Gentleman-Programming/engram` and `rohitg00/agentmemory` are the two most cited inside the repo's OpenSpec history. During the rapid build phase of late 2026, those projects were named freely in proposals, designs, comments, and the plugin README:

- The relation taxonomy (`supersedes`, `conflicts_with`, `related`, `compatible`, `scoped`, `not_conflict`) was modelled after the same vocabulary `engram` uses, so an agent prompted for either tool would emit a compatible verdict.
- The topic-key family scheme (`preference / feedback / decision / reference`) was likewise borrowed.
- The plugin's positioning ("replaces engram / agentmemory") was the author's explicit stance — those tools were not coexisting in the author's setup, the plugin was designed to be the sole memory layer.
- The Hermes provider's `~/.rembric/.env` preload was directly inspired by `agentmemory`'s fix for its issue #250, where the same problem (systemd-launched server not propagating env to the CLI shell) had been observed and solved upstream.

All of those references made sense at the moment they were written. Three problems made them worth re-examining now:

1. **Drift made the rationale partially false.** "Cross-tool prompt portability" was never an enforced invariant — no test checks it, no spec defines it. The agent-protocol surface (tool descriptions, `initialize.instructions`, MCP framing) has diverged enough that an `engram` prompt no longer transparently maps onto Rembric's surface. Keeping the comment "matches Engram's convention so prompts emit the same vocabulary" mis-sells the level of compatibility.
2. **The product is self-standing now.** Rembric has been the author's sole memory layer for months. Continuing to define what Rembric _is not_ by naming the systems it replaces reads as defensive positioning rather than a clear product story.
3. **Names rot faster than ideas.** `engram` and `agentmemory` may rename, fork, deprecate, or change scope. The spec's "Out-of-scope behaviors" line that names them by hand becomes harder to maintain than one that describes the same constraint generically.

The cleanup is therefore not censorship — it's a rotation from "X-relative description" to "self-contained description." The technical rationale is preserved in every case; only the external project name is removed.

## Goals / Non-Goals

**Goals:**

- Replace every live mention of `engram` and `agentmemory` with a self-contained description that preserves the technical _why_ — the closed taxonomy is still justified, the systemd / EnvironmentFile case is still explained, the "sole memory layer" stance is still articulated.
- Touch exactly five files: two source comments, one plugin README, one plugin CHANGELOG entry, one active spec.
- Leave the historical record (`openspec/changes/archive/**`) untouched. Archived changes are immutable by convention; rewriting them rewrites the audit trail of _why_ past decisions were made.
- Keep marketplace discoverability: the `agent-memory` keyword in both `plugin.json` manifests is generic and stays.

**Non-Goals:**

- Removing references from the archive. Archived changes carry their own historical context; references inside them describe what was true at the time of writing.
- Renaming any constant, function, schema column, or exported symbol. The taxonomy's _contents_ (the six relation values, the four topic-key families) are unchanged — they are still the right set, the justification text is what changes.
- Removing the `agent-memory` keyword. It is a category term, not a product name.
- Touching `plugin/CHANGELOG.md` entries in already-shipped sections (`[0.2.x]` and below). The one rewrite is inside `[0.3.0] — unreleased`.
- Adding a "we used to be inspired by X" historical note. Where the cleaner description is also a more accurate description, the change is a strict improvement; commemorating the displaced wording is not necessary.

## Decisions

### Decision 1: Rewrite, don't delete

For every site, the new text preserves the same information density as the old, just routed through Rembric's own concepts instead of a cross-tool comparison. Deleting the docstrings (option "remove the entire comment") was rejected because the _what_ — "these are the six relation values, and they're a closed set" — is genuinely load-bearing rationale for a reader who lands in those files cold. Without the comment, a future contributor might propose adding a seventh relation kind without realising it's a spec-governed surface.

### Decision 2: The taxonomy comment gains an "OpenSpec change required" note

The old wording told the reader: "this set matches Engram so prompts are portable." The new wording tells the reader: "this set is closed, and extending it requires a spec change." The latter is more useful in this repo — it routes the would-be contributor to the OpenSpec workflow rather than to an external project's source. Same paragraph budget; better signal.

### Decision 3: The CHANGELOG rewrite explains the systemd case fully

The old wording said `parity with agentmemory's fix for issue #250 (Rembric server launched by systemd never propagates env to the Hermes CLI shell)`. The new wording removes the "parity with X" framing and inlines the full case: when systemd launches the server with an `EnvironmentFile`, the server process inherits those values but the user's interactive CLI shell does not — which leaves the provider unable to find `REMBRIC_SERVER_URL` / `REMBRIC_API_TOKEN` unless the user also exports them in their shell rc. The dotenv preload closes that gap. A future reader of the CHANGELOG no longer needs to go look up issue #250 in someone else's repo to understand what was fixed.

### Decision 4: The plugin README's "Notes" bullet is rephrased toward warning, not positioning

Old: "This plugin replaces other memory tools (engram, agentmemory, etc.); it does not coexist with them. The author's setup intentionally drops them." This is two sentences: a product positioning claim, and a self-referential note about the author. New: "This plugin is designed to be the sole memory layer for the agent. It does not migrate from or coexist with other memory tools — if one is already installed, uninstall it before enabling this plugin to avoid cross-tool drift." One sentence of product stance + one sentence of operational guidance. No author-third-person, no competitor names.

### Decision 5: The active spec's non-goal becomes generic without weakening the constraint

Old: "Migration prompts or coexistence behavior with engram, agentmemory, or other memory tools. Rembric is positioned as the sole memory layer." New: "Migration prompts or coexistence behavior with other agent memory systems. Rembric is positioned as the sole memory layer for any agent it is enabled on." The normative claim ("not in scope") is unchanged; the named examples are removed; an extra clarifier ("for any agent it is enabled on") sharpens the scope of the positioning. Future readers — including future agents proposing changes — see a constraint expressed in Rembric-native terms.

### Decision 6: Archived changes stay untouched

The OpenSpec workflow treats `openspec/changes/archive/**` as an append-only record of past reasoning. The text inside an archived change documents not the current state of the world but the state of the world at the moment that change was authored. Rewriting those references to remove `engram` / `agentmemory` would falsify the historical record — a future reader trying to understand _why_ the relation taxonomy was set up this way would lose the lineage trail.

**Alternative considered:** redact all archive references in one sweeping pass for consistency. Rejected — the historical-record argument is the same argument that protects `git log` from rewriting: even if today's preference is to omit a name, that name was the actual driver of the past decision and the archive should reflect it. The cost of running a sweep is also high (many files, many backreferences) for no operational benefit.

## Risks / Trade-offs

- **[A future reader of `topic-key.ts` won't know the families originally mirrored another taxonomy]** → This is the intended trade-off. The lineage is captured in `openspec/changes/archive/**` for anyone digging into history. The live comment now reflects the property the code actually enforces (deterministic per-type mapping), not a cross-tool compatibility claim the code does not actually verify.
- **[The `claude-code-plugin` spec edit is a normative document change]** → Mitigation: the delta is purely textual. No scenario changes, no requirement added or removed, no normative SHALL flipped. The "Out-of-scope" list still contains the same set of behaviours, just described in generic language.
- **[A future grep for `engram` / `agentmemory` will only find archive hits]** → That is the goal. Operators or contributors who want the lineage can find it intact in the archive; the live surface no longer carries the names.

## Migration Plan

This change is text-only and requires no build, schema, or version coordination.

1. Merge the change. No `pnpm install`, no migration apply, no plugin version bump (the CHANGELOG entry being rewritten is itself inside `unreleased`).
2. Operators see the updated wording on next pull. No re-auth, no plugin reinstall, no spec republish required.
3. `git grep -nE 'engram|agentmemory'` over `src/`, `plugin/`, and `openspec/specs/` returns zero hits after merge; the same grep limited to `openspec/changes/archive/` keeps its historical hits.

**Rollback:** `git revert` of the merge commit. The five reverted hunks restore the named references; no other state needs unwinding.

## Open Questions

None — the scope (five live sites; archive intact; `agent-memory` keyword preserved) was settled during the explore-mode session that produced this proposal.
