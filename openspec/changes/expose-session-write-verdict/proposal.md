## Why

`memory.session_summary` on a terminal (ended/abandoned) row that already carries a curated summary silently discards the write while returning `ok:true`. The handler echoes the stored row — `summary`, `summaryFinal`, `title`, `titleFinal` — and the caller cannot distinguish "your write landed" from "your write was silently discarded by the first-curated-stands precedence rule". Verified today by a vitest probe at the real MCP handler boundary:

- Second curated write on an abandoned, already-final row → response `ok:true`, `summaryFinal:true`, echoes the STORED (old) summary; row unchanged.
- Same second write on an active row → lands (last-final-wins).
- A terminal row WITHOUT a prior summary → accepts the late curated write.

The caller has no way to tell applied from terminal-final discard. This matters because `memory.session_summary` is the only tool whose write outcome on a terminal row is ambiguous: `memory.session_end` is explicitly a no-op there (returning existing `ended_at`), and `memory.session_start` already reports `reused` to distinguish adoption from fresh-mint.

## What Changes

- **Report the write verdict on `memory.session_summary`.** Add a REQUIRED `applied: z.boolean()` to `sessionSummaryOutput` and a conditional `discardReason: z.string().optional()` carrying `'terminal_final'` when the write was skipped by the terminal first-curated-stands rule. The service layer (`writeSummary` → `writeTerminalFields` → `precedenceSet`) must signal whether the write landed — the handler cannot infer it from the returned row, because the same stored row is returned in both cases. Rejected: (a) returning an error on discard — the current contract says terminal writes SHALL NOT be rejected, and the plugin nudge instructs agents to call this tool on every terminal path; (b) changing the precedence rule itself — first-curated-stands on terminal rows is correct by design (no `replaces` chain for sessions, so losing a curated handoff is unrecoverable).
- **Surface the same verdict on `memory.session_end`.** The same silent no-op pattern exists: `end()` on a terminal row returns the existing row with `endedAt`, and the handler reports `ok:true`. Adding `applied: z.boolean()` to `sessionEndOutput` makes both session-lifecycle write tools consistent. The precedent: `memory.session_start` already surfaces an outcome legible in `reused`.
- **Update the session_summary tool description** to state that a terminal row keeps its first curated summary and that `memory.session_resume` is the way back.
- **Delta-spec the `mcp-api` capability** with updated `sessionSummaryOutput` and `sessionEndOutput` schema requirements, updated scenarios, and a new scenario covering the terminal-final-discard case.
- **Fold the temporary reproduction probe** (apps/server/src/mcp/session-371-probe.test.ts) into proper regression tests in the co-located test file and delete the probe.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mcp-api`: MODIFIED requirement "The MCP server MUST expose four session-lifecycle tools" — `sessionSummaryOutput` gains `applied: z.boolean()` and optional `discardReason`; `sessionEndOutput` gains `applied: z.boolean()`; the description requirement is updated; new scenarios cover the terminal-final-discard case and the end no-op case; the existing "last-final-wins" scenario is clarified to scope the claim to active rows.

## Impact

- MCP surface: `apps/server/src/mcp/session-tools.ts` — `sessionSummaryOutput` gains `applied: z.boolean()`, `discardReason: z.string().optional()`; `sessionEndOutput` gains `applied: z.boolean()`; `handleSessionSummary` and `handleSessionEnd` must populate them from the service return.
- Service: `apps/server/src/services/agent-sessions.ts` — `writeSummary` and `end` must signal whether the write landed (via a return shape change or a side-channel flag on the returned row). The `writeTerminalFields` method currently returns the existing row on no-op; it must distinguish this case.
- Tests: `apps/server/src/mcp/session-tools.test.ts`, `apps/server/src/test/mcp-integration.test.ts` (required-field pins and description-length pins), plus deleting `apps/server/src/mcp/session-371-probe.test.ts`.
- Tool description: `apps/server/src/mcp/server.ts` — `memory.session_summary` and `memory.session_end` descriptions gain the `applied` field in their `Returns:` list and the terminal-summary clause.
- Specs merged at archive time: `openspec/specs/mcp-api/spec.md`.
- Deliberately untouched: the precedence rule in `precedenceSet`, the `plugin-session-protocol` capability, `apps/plugin/` (no plugin code changes), the dashboard.
- Existing installations: no migration, no schema change, no derived-data invalidation. First boot after upgrade returns one more field on two tools; nothing persisted depends on it. Rollback removes the fields and restores the silent discard.
