## Context

The dashboard session detail view already passes curated summary content through `mdBody`, so valid Markdown headings render as separate sections. The stored content is flat because the model is taught a flat schema: `Goal · Accomplished · Decisions+why · Verified+how · Unfinished+why · Files` appears across the eight files enumerated by `apps/server/src/test/invariants.test.ts::"the session-summary rubric has one source"`.

Those eight files are two server surfaces (`instructions.ts`, `server.ts`) and six shared-plugin resources (`prompt-nudge.sh`, `stop-nudge.sh`, `post-compact.sh`, `commands/summary.md`, `rembric-plugin-core.mjs`, and Hermes's `__init__.py`). They cover all five clients by reuse: Claude Code and Codex share bash hooks, opencode and Pi import the JS/TS core, and Hermes carries the fixture-pinned Python form. The current invariant catches drift in section names and order but makes the wrong flat representation canonical.

Replacing the old 80-byte section fragment with the proposed 203-byte directive adds 123 bytes wherever it appears. Against current measured fixtures this makes `summary` 382 bytes (from 259), `postCompact` 683 bytes (from 560), and `endOfTurnRubric` 821 bytes (from 698). Blind interpolation also makes the binding MCP initialize variant 1113 characters (from 990), over its 1000-character self-imposed cap. The design therefore has to change wording and budgets deliberately rather than treating this as a search-and-replace.

## Goals / Non-Goals

**Goals:**

- Teach every server and plugin summary surface the same six exact `##` headings, in the same order, each on its own line in the summary the model writes.
- Keep the five clients in lock-step through existing shared files and cross-language fixture pins.
- Make flat dot-separated guidance and partial/reordered/extended heading lists fail tests.
- Keep MCP instruction and tool-description client ceilings valid and update plugin token budgets from measurements.
- Verify the client-to-server-to-dashboard result against the real Docker dev stack.

**Non-Goals:**

- Enforcing or rewriting summary Markdown in the service, MCP handler, HTTP handler, database, or dashboard.
- Migrating historical summaries or re-rendering stored data.
- Changing summary precedence, version history, truncation, cadence, lifecycle, transport, or dashboard Markdown rendering.
- Creating five client-specific copies or changing any installer/configuration path.

## Decisions

### D1 — The canonical contract is six exact level-2 Markdown headings

The canonical directive names, in order, `## Goal`, `## Accomplished`, `## Decisions+why`, `## Verified+how`, `## Unfinished+why`, and `## Files`, and explicitly says each belongs on its own line and never in one paragraph. The server continues to accept free-form text.

Chosen over server-side canonicalisation because rewriting model-authored Markdown would change stored source content, create merge/truncation questions, and hide noncompliance. Chosen over dashboard heuristics because `mdBody` already renders correct Markdown and guessing section boundaries from punctuation would make presentation compensate for malformed source.

### D2 — One canonical phrase is pinned across the existing eight-file surface set

`SUMMARY_SECTIONS` remains the TypeScript source used by the two server surfaces. Bash, the shared JS/TS plugin core, the summary command, and Hermes keep language/runtime-appropriate copies, but `nudge-fixtures.json`, client tests, and the invariant pin them to the same phrase. The eight-file enumeration remains exact and continues to derive completeness from tracked files.

The implementation SHALL update every occurrence in a listed file, not merely make the file contain one passing occurrence: Hermes and the JS/TS core each emit the rubric through more than one path. Tests SHALL reject the old bare `Goal · … · Files` fragment anywhere in those surfaces and reject a missing, reordered, renamed, or appended heading.

Rejected: importing a TypeScript constant from bash or Python. Cross-runtime loading is more complexity than the existing fixture pin and would make plugin delivery depend on server source layout. Rejected: per-client wording, because all five clients express the same protocol and the shared tree exists specifically to prevent such drift.

### D3 — Preserve MCP ceilings; raise only measured plugin caps

The `memory.session_summary` description grows from 1175 to approximately 1298 characters and remains below `DESCRIPTION_MAX_LENGTH = 1900`, so its cap is unchanged.

Blindly expanding `initialize.instructions` reaches 1113 characters. The implementation SHALL reclaim at least 113 characters from surrounding SAVE/RECALL/SUMMARIZE prose while preserving every published obligation, and SHALL keep both scoped and unscoped variants at or below 1000 characters. Raising `INSTRUCTIONS_MAX_LENGTH` is rejected: the published rule explicitly says future prose must be reclaimed first, and the larger client ceiling is not a reason to increase always-present token cost.

The shared plugin text cannot retain every current cap. With the exact directive the measured targets are:

| Surface                       | Measured after replacement |                     New cap |
| ----------------------------- | -------------------------: | --------------------------: |
| `summary` fixture             |                  382 bytes |                   400 bytes |
| `postCompact` fixture         |                  683 bytes |                   700 bytes |
| turn 1 with recall            |            about 783 bytes |      800 bytes / 200 tokens |
| divergent-counter firing turn |            about 903 bytes |      960 bytes / 240 tokens |
| ten-turn amortised            |     about 42.6 tokens/turn | unchanged at 45 tokens/turn |

`endOfTurnRubric` remains uncapped and is re-measured (821 bytes) only as evidence. The implementation SHALL calculate final numbers from emitted fixture bytes and record those values; if wording changes the draft figures, caps may move only to the smallest round boundary that still leaves a testable margin. The post-compaction and summary per-line caps must be updated in the same commit as their text.

Rejected: retaining the old caps by abbreviating the contract to bare `##` tokens. The bug is not just absent hash marks; models must be told the headings are exact and belong on separate lines. Rejected: raising unrelated caps or the amortised ceiling, which the measured change still satisfies.

### D4 — Tests assert semantics and emitted text, not dashboard internals

The server invariant SHALL continue to enumerate all eight files, but its canonical value becomes the complete heading directive. Fixture tests SHALL compare the actual bash output, shared JS/TS exports, Hermes hints/system block, command text, post-compaction block, and end-of-turn rubric against the contract. At least one mutation/regression arm SHALL prove that restoring the old flat fragment fails.

A renderer unit change is rejected because the renderer is already correct and a test focused only on `mdBody` would stay green while every emitter remained wrong. Dashboard verification belongs at the acceptance boundary: persist a canonical summary and observe six rendered heading sections.

### D5 — End-to-end verification covers all five delivery paths through shared resources

After unit/spec gates pass, start `pnpm run dev:docker:up` against the seeded data and exercise the summary-instruction path for Claude Code, Codex CLI, Hermes, opencode, and Pi. Shared-host paths may use the repository's supported direct handler/hook invocation where an interactive client cannot be automated, but each client must be named with the exact path exercised and any unavailable real CLI disclosed.

The smoke SHALL also submit a summary containing the six headings through the real MCP/session path, read it back, and fetch the session detail page to verify six separate `<h2>` sections in order. A flat dot-separated control SHALL not produce those six sections. This confirms the intended client → server → SQLite → dashboard outcome without changing the renderer.

## Risks / Trade-offs

- **[Trade-off] The per-turn summary nudge becomes 123 bytes larger and is paid on turn 1 and every tenth turn.** → Accepted because the existing flat instruction directly causes malformed curated output; measured amortised cost remains under the existing 45-token/turn ceiling.
- **[Risk] Reclaiming MCP instruction prose could silently drop a SAVE, RECALL, scope, session-id, or update obligation.** → Mitigate with existing semantic substring tests plus explicit scoped/unscoped length and protocol assertions.
- **[Risk] A model may still ignore the requested Markdown format.** → Mitigate by making every delivery surface unambiguous and lock-step; storage remains permissive so a weak client is not blocked. This change specifies instruction behavior, not guaranteed model obedience.
- **[Risk] A new model-facing surface can evade the tracked-file grep until staged.** → Retain the invariant's documented tracked-files-only caveat, stage plugin files before the focused invariant run, and include a mutation proof for completeness.
- **[Trade-off] Historical flat summaries remain flat.** → Accepted because their original section boundaries cannot be recovered reliably, and mutating source summaries would violate the no-rewrite scope of this bug fix.

## Migration Plan

No database or data migration is required. Deploy the server and unified plugin releases in either order: each side independently improves the guidance it owns, and there is no wire-format dependency. Existing `sessions.summary` and `session_summary_versions` rows remain byte-identical; derived tables are untouched.

Rollback reverts guidance and fixture-budget changes only. It does not make any stored summary unreadable and requires no cleanup. The implementation smoke SHALL run against pre-existing seeded Docker data and confirm row counts/data survive unchanged apart from the deliberately-created smoke session.

## Open Questions

None. The heading names/order, advisory enforcement boundary, eight-file surface set, budget policy, and five-client e2e obligation are fixed for this change.
