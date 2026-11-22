## Why

Hermes can retain RAW transcript fallbacks while a useful conversational session never receives a periodic curation reminder: the current server policy requires observed tool use. Empty bot-session reports need a separate gateway reproduction; eager primary registration alone does not establish their cause.

## What Changes

- Make completed conversational turns eligible for the existing server-authored summary notice, with the same single 25-minute minimum interval and permission to skip when nothing changed.
- Preserve truthful `usedTools` observations and tool-only `last_work_at`; derive reminder activity from the existing previous-turn-report anchor, without a schema change or client curation state.
- Preserve asynchronous report/next-prefetch delivery, opening/resumed-read instructions, explicit session identity before MCP writes, RAW fallback and curated-write precedence.
- Gate any empty-session registration or flush change on an actual gateway reproduction and a supported host API. Idle/cache eviction is not a conversation boundary. No speculative lifecycle patch is included.
- Separate deterministic server/provider checks from pending gateway/model acceptance; reminders do not guarantee model cooperation or a curated summary.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `session-nudges`: Replace tool-work eligibility with completed-turn activity while retaining server ownership and cadence.
- `sessions`: Clarify existing timestamp semantics under conversational eligibility; no new column or backfill.
- `http-api`: Permit `usedTools:false` reports to return notices without altering the wire schema or access guards.
- `hermes-agent-plugin`: Specify conversational notice delivery and evidence gates for empty-session lifecycle changes.
- `plugin-session-protocol`: Preserve fallback/curated precedence and distinguish deterministic delivery from gateway acceptance.

## Impact

Expected runtime surfaces for a later implementation: `packages/core/src/services/{agent-sessions,session-nudge}.ts` and their co-located tests; `apps/web/src/test/api-router.test.ts`; `apps/plugin/.hermes-plugin/tests/{test_prefetch_and_sync_turn,test_tool_observation,test_lifecycle_calls,test_resumed_read}.py`. Provider runtime `apps/plugin/.hermes-plugin/__init__.py` is conditional on a reproduced adapter defect, not required for server eligibility.

The shared server policy affects Claude Code, Codex CLI, Hermes, opencode, Pi and any caller of the turn endpoint, not just Hermes. Chat-only sessions can now receive at most one notice per floor. No dependency, installer, credential, release, dashboard, transport or MCP schema changes. Append-only memory, service-layer scope enforcement, `topic_key`, fresh-context judgment, session lifecycle, final precedence and historical rows remain unchanged. This proposal stages artifacts only; it does not implement or claim deployment of these behaviors.
