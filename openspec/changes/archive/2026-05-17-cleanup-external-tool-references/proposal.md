## Why

Rembric's living codebase, plugin documentation, and the active `claude-code-plugin` spec all carry name-drop references to two specific third-party memory tools (`engram`, `agentmemory`). The references entered the repo as legitimate context — they explained the lineage of design decisions (the relation taxonomy and the topic-key family scheme were intentionally borrowed; the README positioned Rembric as a replacement; the spec's non-goals named the projects it doesn't migrate from). Today, two factors make those references worth re-thinking:

1. **Rationale rot.** A comment like "matches Engram's convention so prompts work against either tool" tells a future reader something Rembric does NOT actually guarantee any more — Rembric's protocol-instructions, tool surface, and judgment vocabulary have diverged enough that cross-tool prompt portability is not a maintained invariant. The comment's _what_ (the relation values are these six, the topic-key families are these four) is still load-bearing; the _why_ it cites is misleading.
2. **Brand surface.** The README and the active spec mention competitors by name in the "what this isn't" positioning. The author's stance has been "the plugin replaces those systems," but the explicit name-drop reads as marketing-against-X rather than a clear product statement, and the spec's non-goal becomes brittle as those projects evolve and rename.

This change rewrites every live mention of `engram` and `agentmemory` to an abstract description that preserves the technical rationale — the _what_ and the _why-Rembric-decided-this-way_ — without naming the projects. Five files in total. Archived OpenSpec changes (`openspec/changes/archive/**`), which document past reasoning at the moment it happened, are intentionally untouched: rewriting them would rewrite the historical record.

The `agent-memory` keyword in both `plugin.json` manifests is intentionally preserved — it is the generic category term users search marketplaces for, not a product name.

## What Changes

- **Rewrite the docstring in `src/mcp/topic-key.ts`** (the `Families match Engram's convention` block). New wording explains the family map (`user→preference`, `feedback→feedback`, `project→decision`, `reference→reference`) as a deterministic per-`type` mapping that ensures the same fact produces the same key across agents — without claiming cross-tool portability.

- **Rewrite the relation-taxonomy docstring in `src/db/schema/memory-relations.ts`** (the `relation values match the Engram taxonomy` block). New wording explains the six values as the closed universe of verdicts and adds the OpenSpec-change requirement for extending the set, replacing the cross-tool-vocabulary justification.

- **Rewrite `plugin/README.md`** (the "Notes" bullet that says `This plugin replaces other memory tools (engram, agentmemory, etc.)`). New wording: positions Rembric as the sole memory layer per agent and warns against parallel installations of any memory tool, without naming alternatives.

- **Rewrite the `0.3.0 — unreleased` CHANGELOG entry** in `plugin/CHANGELOG.md` (the `parity with agentmemory's fix for issue #250` bullet). New wording fully describes the systemd / EnvironmentFile case the dotenv preload addresses, making the _why_ legible without citing an external issue.

- **Rewrite the non-goal line in `openspec/specs/claude-code-plugin/spec.md`** (the `Migration prompts or coexistence behavior with engram, agentmemory, or other memory tools` bullet under "Out-of-scope behaviors"). New wording keeps the normative intent ("Rembric is the sole memory layer; no migration/coexistence features for other memory systems") without specific names.

- **Leave untouched**:
  - `agent-memory` keyword in `plugin/.claude-plugin/plugin.json` and `plugin/.codex-plugin/plugin.json`. This is a generic search term, not a product name.
  - `openspec/changes/archive/**` (any reference inside an archived change). These are immutable artefacts of past reasoning.
  - Test files, fixtures, or DB seed data. No references found there.

## Capabilities

### New Capabilities

<!-- none — this is a documentation hygiene change -->

### Modified Capabilities

- `claude-code-plugin`: one MODIFIED requirement under "Out-of-scope behaviors" — the non-goal line about migration/coexistence with other memory tools is reworded to drop specific project names while preserving the normative intent. No new requirement; no scenario changes; no behaviour changes.

## Impact

- **Affected code (text-only)**: `src/mcp/topic-key.ts` (docstring), `src/db/schema/memory-relations.ts` (docstring), `plugin/README.md` (one bullet under Notes), `plugin/CHANGELOG.md` (one bullet inside the unreleased section).
- **Affected specs**: `openspec/specs/claude-code-plugin/spec.md` — one line under "Out-of-scope behaviors".
- **Unaffected**: every constant value, function signature, exported symbol, DB schema, migration, MCP tool, plugin manifest field (including the `keywords` array), test, route, hook script. Zero behaviour change.
- **Externally visible**: the `plugin/README.md` line that operators read on GitHub becomes more product-focused and less competitor-focused. No public spec contract changes.
- **Tests**: none change. Typecheck passes (text-only). Full `pnpm test` passes (no test depends on the docstrings or README copy).
- **Plugin version bump**: NOT required. The visible plugin behaviour is unchanged; only docs / changelog wording shifts (and the changelog entry being reworded is itself in the `unreleased` section).
