## 1. Source comments

- [x] 1.1 In `src/mcp/topic-key.ts`, replace the docstring block starting at line 8 (`Families match Engram's convention so prompts that work against either tool emit comparable keys:`) and the four-line family table with a self-contained equivalent:

  ```
  Families are scoped by memory `type` so the same fact produces
  the same key regardless of which agent is saving it:

    type           family
    --------       ---------
    user           preference
    feedback       feedback
    project        decision
    reference      reference
  ```

  Preserve the slug-from-text logic comment block beneath. Do not touch the `STOPWORDS` constant or any code below the docstring.

- [x] 1.2 In `src/db/schema/memory-relations.ts`, replace the paragraph starting at line 28 (`\`relation\` values match the Engram taxonomy so an agent prompted for either tool emits the same vocabulary:`) with:

  ```
  The six `relation` values cover the full space of verdicts an agent
  can issue over a candidate–target pair. The set is closed: new
  verdict kinds require an OpenSpec change to `memory`:
  ```

  Preserve the per-value bullets that follow (`supersedes → target is replaced by source; …`, etc.). Do not touch the `RELATION_VALUES` constant or any code below the docstring.

## 2. Plugin user-facing docs

- [x] 2.1 In `plugin/README.md`, locate the "Notes" section bullet beginning `This plugin **replaces** other memory tools` and replace the entire bullet with:

  ```
  - This plugin is designed to be the **sole memory layer** for the
    agent. It does not migrate from or coexist with other memory
    tools — if one is already installed, uninstall it before enabling
    this plugin to avoid cross-tool drift.
  ```

  Leave the surrounding two "Notes" bullets (`client-side only`, `never block a session`) untouched.

- [x] 2.2 In `plugin/CHANGELOG.md`, locate the `~/.rembric/.env` preload bullet inside the `## [0.3.0] — unreleased` / `### Added` section and replace it with:

  ```
  - **`~/.rembric/.env` preload** (Hermes provider) — fills missing
    env values via `os.environ.setdefault` at plugin import.
    Resolves the systemd case: when the Rembric server runs under
    systemd with an `EnvironmentFile`, the server process inherits
    the values but the user's Hermes CLI shell does not — leaving
    the provider unable to find `REMBRIC_SERVER_URL` /
    `REMBRIC_API_TOKEN` unless they're also exported in shell rc.
    The dotenv preload closes that gap.
  ```

  Do not modify any other CHANGELOG entry — only this single bullet inside the unreleased section.

## 3. Active spec

- [x] 3.1 In `openspec/specs/claude-code-plugin/spec.md`, insert a new `### Requirement: The plugin MUST NOT implement migration or coexistence behaviors with other agent memory systems` block at the end of the `## Requirements` section. The body and scenarios SHALL match the ADDED Requirement defined in this change's `specs/claude-code-plugin/spec.md` delta (no name-drops, formalises the previous informal non-goal).

- [x] 3.2 In the same spec file, delete the bullet item under `## Out-of-scope behaviors` beginning `Migration prompts or coexistence behavior with engram, agentmemory, or other memory tools`. The remaining bullets in that section (stdio→HTTP bridge, local stdio mode, public plugin marketplace, server-side internal changes) SHALL stay unchanged.

## 4. Verification

- [x] 4.1 Run `git grep -nE 'engram|agentmemory|agent-memory_(?!keyword)' -- src/ plugin/ openspec/specs/`. Expected result: zero hits (the `agent-memory` keyword in `plugin.json` files is the only `agent-memory` mention allowed under the live surface and lives outside `src/` and `openspec/specs/`).
- [x] 4.2 Run `git grep -nE 'engram|agentmemory' -- openspec/changes/archive/`. Expected: the pre-existing historical hits are still present and unchanged. This is the audit trail; archived references stay.
- [x] 4.3 Run `pnpm run typecheck`. Expected: passes (text-only edits).
- [x] 4.4 Run `pnpm test`. Expected: passes (no test depends on the rewritten docstrings or copy).
- [x] 4.5 Run `openspec validate cleanup-external-tool-references --strict`. Expected: passes.

## 5. Documentation deltas in this change

- [x] 5.1 `proposal.md` — written
- [x] 5.2 `design.md` — written
- [x] 5.3 `specs/claude-code-plugin/spec.md` — delta with MODIFIED requirement rewording the non-goal line
- [x] 5.4 `tasks.md` — this file
