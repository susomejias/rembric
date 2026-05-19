## Why

opencode sessions today end without a server-side summary written. The user closes opencode and the corresponding row in `sessions` stays `summary=NULL`, `status='active'` until `abandonStale` flips it many hours later. The original `add-opencode-plugin` change (archived 2026-05-19, design.md Decision 5) accepted this gap because opencode appeared to lack a reliable end-of-session event — `session.deleted` only fires on explicit UI delete, `session.idle` is per-turn, and the platform docs at `opencode.ai/docs/plugins` list no shutdown signal.

That assumption was incomplete. Inspecting the `opencode` 1.15.5 binary (`strings | grep '"server\.'`) surfaces `"server.instance.disposed"` alongside the documented `"server.connected"`. A runtime sniffer plugin confirms opencode dispatches `server.instance.disposed` through the generic `event` handler when its internal server tears down (i.e. when the user closes opencode). The event is undocumented but real and reachable from plugin code. This is the equivalent functional surface to Claude Code's `SessionEnd` hook and Codex CLI's final `Stop` invocation — a guaranteed pre-exit hook that lets us POST a summary.

With this event available, opencode users gain parity with Claude/Codex: closing opencode persists the session's transcript via `POST /api/<slug>/sessions/<id>/summary`, the dashboard shows the row with a real summary, and `abandonStale` is no longer the only path to a coherent `status` transition.

### Unified plugin flow (and the platform-shaped asymmetries we accept)

This change closes the LAST gap in a project-wide principle: **every Rembric plugin SHALL ensure the session's transcript is POSTed to Rembric at session close**, so the dashboard never shows a `summary=NULL` row for a closed session due to a missing hook. The four-client matrix after this change:

| Client       | Event                            | Endpoint                                   | Resulting `status`                |
| ------------ | -------------------------------- | ------------------------------------------ | --------------------------------- |
| Claude Code  | `SessionEnd`                     | `POST /sessions/:id/end`                   | `'ended'`                         |
| Codex CLI    | `Stop` (per-turn, last one wins) | `POST /sessions/:id/summary`               | `'active'` → `abandonStale` flips |
| Hermes Agent | `on_session_end`                 | `POST /sessions/:id/end`                   | `'ended'`                         |
| opencode     | `server.instance.disposed`       | `POST /sessions/:id/summary` (this change) | `'active'` → `abandonStale` flips |

The endpoint and resulting status asymmetries are NOT a bug — they reflect what each platform can guarantee:

- **Claude Code and Hermes Agent** expose a guaranteed "user is closing THIS session" event. `/end` is appropriate; the row transitions to `'ended'` because the platform tells us the session is permanently done.
- **Codex CLI** has no per-session close event — only `Stop` per turn. `/summary` is correct because we can't know the last Stop is final until the process exits. Status stays `'active'` until `abandonStale` flips it; the cooperating-agent `memory.session_summary({final:true})` path is the only way to reach `'ended'`.
- **opencode** has `server.instance.disposed`, which fires on process shutdown (not session-end). Sessions in opencode's own DB might be resumed in a subsequent launch; auto-`'ended'` would be wrong. Like Codex, we POST `/summary` and let `abandonStale` or the agent close the row.

This change does NOT refactor Claude/Hermes to use `/summary` instead of `/end`. That would be a BREAKING behaviour change for operators who today see those sessions auto-transition to `'ended'`, and the asymmetry is principled (the platforms tell us different things). Platforms that lack a hookable session-close event entirely (or whose hook system requires complexity disproportionate to the benefit) are explicitly out of scope for the unified flow — documented per-client in `plugin-session-protocol::Sessions MUST converge on a non-null summary`.

## What Changes

- The opencode plugin SHALL extend its `event` dispatcher to handle `event.type === 'server.instance.disposed'`. On that event, the plugin SHALL iterate the closure-scoped `knownSessions` Set and, for each session id, POST `/api/<slug>/sessions/<id>/summary` with body `{summary, title?, final:false}` reconstructed from a per-session transcript accumulated during the session lifetime. The plugin SHALL NOT POST `/sessions/<id>/end` — the row stays `status='active'` until either the agent calls `memory.session_summary` (which sets `final:true` and locks the row) or `abandonStale` flips it. This mirrors Codex CLI's per-turn `/summary` writer semantics (`plugin-session-protocol::Codex short session captures summary via per-turn Stop`).
- The plugin SHALL re-register the `chat.message` handler (previously dropped in v1 per `add-opencode-plugin` task 3.2 because `/prompts/passive` did not exist), this time NOT as a passive prompt-capture POST but as an in-memory transcript accumulator that appends `{role:'user', text}` to a per-session message array. The accumulated array is the input to the `server.instance.disposed` flush.
- The plugin SHALL subscribe to `message.updated` to capture assistant turns. On each fire, the handler SHALL replace or append the latest `{role:'assistant', text}` to the per-session array. Deduplication and ordering follow opencode's message-id semantics (one assistant message per turn, identifiable via `output.message.id` / `output.message.role === 'assistant'`).
- The plugin MAY ALSO schedule a debounced flush during the session (per `session.idle` fires) to mirror Codex's "summary refreshes every turn" behaviour. If shipped, the debounce SHALL be ≥ 2 seconds to avoid POSTing on every keystroke, and the flush SHALL be best-effort (failure = silent stderr diagnostic, never blocks the session). The minimum-viable v1 of this change MAY defer this and rely solely on the `server.instance.disposed` flush, with the in-session-flush left as a follow-up if the `disposed` event proves unreliable under crash conditions.
- The plugin SHALL document the discovered `server.instance.disposed` event in the per-client gotchas reference (`.agents/skills/rembric-plugin-development/references/per-client-gotchas.md`). Specifically: it is NOT documented at `opencode.ai/docs/plugins/`, it is dispatched through the generic `event` handler (not as a top-level keyed property), and it was discovered via binary string inspection of `opencode-cli 1.15.5` plus runtime sniffer confirmation.
- The plugin's spec (`openspec/specs/opencode-plugin/spec.md`) SHALL be updated. The `Event handler set` requirement currently states the plugin registers exactly two handlers (`event`, `experimental.session.compacting`); this requirement is modified to include `chat.message` and `message.updated`. The `Session.created handler with sub-agent filtering` and `Session.deleted handler clears in-memory state only` requirements remain unchanged. A NEW requirement (`Server.instance.disposed flush handler`) defines the dispose-time behaviour.
- The `plugin-session-protocol` spec's `opencode short session with non-cooperating agent` scenario is modified. Today it states `sessions.summary` remains `NULL` for non-cooperating agents and waits for `abandonStale`. With this change, the scenario becomes: `sessions.summary` is set to the accumulated transcript at close time (the plugin POSTs `/summary` with `final:false`); `status` stays `active` (no `/end` POST) until `abandonStale` flips it to `'abandoned'`. The cooperating-agent scenario is unchanged.
- The plugin's transcript-accumulation behaviour is **per-session in-memory only**. There is NO persistence between opencode launches — if opencode crashes hard before `server.instance.disposed` fires, the transcript is lost. This is acceptable: the same risk exists for Claude/Codex (their bash scripts also depend on the hook firing). Documented as a known limitation in the new requirement.
- The plugin version SHALL bump from `0.7.1` to `0.8.0` (minor — new behaviour, two new handlers + one new event branch in the dispatcher, no breaking changes for existing users). All four version sources bumped in lock-step per the established invariant.
- A `plugin/CHANGELOG.md` `[0.8.0]` entry SHALL describe the dispose-flush behaviour and document `server.instance.disposed` as discovered-via-spike.
- A runtime spike SHALL be performed BEFORE final implementation to verify two assumptions about `server.instance.disposed`: (1) async handlers are awaited by opencode before actual process exit (otherwise our POST gets killed mid-flight), and (2) the opencode SDK client (`ctx.client`) is still functional at dispose time (in case we choose to fetch messages from the SDK instead of accumulating). The spike's outcome determines whether transcript reconstruction uses the SDK or the in-memory accumulator. The spike result SHALL be recorded as a comment near the top of `plugin.ts` of the form `// dispose-spike-result: awaits-async-handlers | fire-and-forget`.

## Capabilities

### New Capabilities

(None — this is an extension of existing opencode-plugin capability and a refinement of plugin-session-protocol.)

### Modified Capabilities

- `opencode-plugin`: `Event handler set` requirement is broadened from 2 handlers to 4. New `Server.instance.disposed flush handler` requirement is added. Both modifications are additive — no existing behaviour is removed.
- `plugin-session-protocol`: `Sessions MUST converge on a non-null summary when the agent cooperates OR the transcript is reachable` requirement's opencode scenarios are updated. The cooperating-agent scenario is unchanged. The non-cooperating-agent scenario is rewritten so that `sessions.summary` is non-null after close (populated by the dispose-flush) rather than `NULL` until stale-flip.

## Impact

Affected paths:

- `plugin/.opencode-plugin/plugin.ts` — new `server.instance.disposed` branch, new `chat.message` and `message.updated` handlers, per-session transcript accumulator, `// dispose-spike-result:` comment.
- `plugin/.opencode-plugin/plugin.test.ts` — unit tests for transcript accumulation, role separation, ordering, dedup of assistant-message updates, dispose-flush behaviour with mocked fetch.
- `plugin/CHANGELOG.md` — `[0.8.0]` entry.
- `plugin/.claude-plugin/plugin.json::version`, `plugin/.codex-plugin/plugin.json::version`, `plugin/.hermes-plugin/plugin.yaml::version`, `plugin/.opencode-plugin/plugin.ts::// @rembric-plugin-version` — bump `0.7.1 → 0.8.0` in lock-step.
- `openspec/specs/opencode-plugin/spec.md` — modified requirements as described above.
- `openspec/specs/plugin-session-protocol/spec.md` — modified opencode scenarios in the convergence-on-summary requirement.
- `.agents/skills/rembric-plugin-development/references/per-client-gotchas.md` — new bullet documenting `server.instance.disposed` as an undocumented opencode event reachable via the generic `event` dispatcher.
- `.agents/skills/rembric-plugin-development/references/e2e-walkthrough.md` — extended with the dispose-event verification step.

Affected invariants:

- `Append-only memory` / `Scope at service layer` / `topic_key convergence` / `Fresh-context judgment`: not touched.
- `Shared plugin logic in shared paths` (memory `01KRNZM2VFCME5HNT8N78HZW18`): honoured. The new behaviour is opencode-specific (no other client has `server.instance.disposed`), so it lives only in `plugin/.opencode-plugin/plugin.ts`. The shared bridge and dotenv lib are untouched.
- The 4-way plugin version lock-step invariant: respected via the coordinated bump.
- The dotenv-lib SoT invariant (`plugin/bin/rembric-dotenv.mjs is the single source of truth for slug parsing`): respected — this change does not touch slug-parsing.

Affected dependencies: none. The plugin uses opencode SDK methods that are already available via `ctx.client` (peer-provided by the opencode runtime); no new `package.json` entries.
