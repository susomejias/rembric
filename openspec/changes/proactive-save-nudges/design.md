# Design — proactive save nudges

## Context

Sessions end under-saved because the server's one-shot SAVE instruction gets buried and no client reinforces it per turn. Each client already has ONE proven, model-facing injection channel it uses for recall; this change adds a throttled SAVE reminder on that same channel. All mechanics are the provider's real hooks/APIs — no polling, no timers.

## Decision 1 — Injection channel per client

| Client      | Channel                                                     | Why                                                                                                                                                               |
| ----------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `PostToolUse` hook → `hookSpecificOutput.additionalContext` | Only structured `additionalContext` reaches the model on PostToolUse (verified against `code.claude.com/docs/en/hooks.md`); plain stdout is logged, not injected. |
| Codex CLI   | `PostToolUse` hook → same `additionalContext` shape         | Codex injects `additionalContext` too. Note: Codex renders it as a visible developer message, so the nudge must stay terse.                                       |
| opencode    | `chat.message` → `output.parts.push({type:'text'})`         | The exact channel already shipping for the recall nudge — stable, non-experimental.                                                                               |
| Hermes      | `prefetch()` return + `on_turn_start` `remaining_tokens`    | `prefetch`'s return is injected as `<memory-context>` every turn; `on_turn_start` exposes `remaining_tokens` to detect imminent compaction.                       |

### Rejected channels (confirmed dead ends)

- **Codex `Stop`** — cannot inject context; its only outputs are `decision:"block"` (whose `reason` becomes a forced next user message) or `continue:false`. Using it to force a save loops the turn — high annoyance.
- **opencode `experimental.chat.system.transform`** — mutations to `output.system` are silently discarded (upstream issue closed "not planned"). Non-operational.
- **`tui.showToast` / `session.idle`** — user-facing / observation-only; neither reaches the model.
- **Claude `Stop` hook** — deliberately not wired (the `claude-code-plugin` spec records the forced-continuation risk); PostToolUse is the safer per-turn channel.

## Decision 2 — Throttle, because the failure mode has a mirror image

The bug is _under_-saving; the naive fix (_over_-nudging) is just as bad. Each nudge is gated:

- **Claude/Codex** — fire only after write-shaped tools (`Edit`/`Write`/`MultiEdit`/`NotebookEdit`), and only every **8th** such call per session (a counter file in `${TMPDIR}/rembric-savenudge/<session>`). Read-only tools never nudge.
- **opencode** — every **5th** non-subagent user turn (in-memory `Map<sessionId, count>`).
- **Hermes** — a terse hint every **3rd** turn (normal cadence) PLUS a one-shot urgent reminder when `remaining_tokens` first drops below the floor.

Cadence constants live at the top of each file as named constants so they are trivially tunable after real-world observation.

## Decision 3 — One shared `post-tool.sh` for both shell clients

Per the plugin single-copy discipline, Claude and Codex share `apps/plugin/scripts/post-tool.sh`; the platform delta stays at the manifest level (Claude declares a tool-name `matcher`, Codex ignores matchers so the script self-filters on `tool_name`). The script emits nothing but the `additionalContext` JSON, needs no server URL/token, and fails safe: an unknown/absent tool name simply exits 0 (no nudge), so a Codex stdin-shape quirk causes silence, never noise. **The Codex path (its exact `tool_name` values + that `additionalContext` is actually injected) is e2e-gated** — the same operator-gated verification pattern used for opencode, since Codex is not installed in CI.

## Decision 4 — Nudge copy: terse, English, imperative

The copy matches `instructions.ts::BASE` and the existing recall nudge (English, `rembric:`-prefixed so Codex's `looks_like_json` heuristic doesn't flag it):

- Normal: `rembric: if recent work produced a decision, fix, or discovery, call memory.save now (title ≤100 + content).`
- Urgent (Hermes pre-compaction): `rembric: context is about to compact — save anything important with memory.save NOW before it's lost.`

## Decision 5 — Hermes pre-compaction: heuristic floor, fire once

`on_turn_start` reads `remaining_tokens` (when Hermes supplies it in kwargs). Below `_COMPACTION_TOKEN_FLOOR` (20 000, a conservative heuristic documented as tunable) it arms an urgent flag; the next `prefetch` emits the urgent reminder and marks itself warned so it fires **once** per session, not every turn thereafter. The flag resets on session end/switch. This is the single highest-value nudge — it fires exactly when un-saved context is about to be lost, and almost never otherwise.

## Decision 6 — Pure-plugin, no server change

Every nudge is a static client-local string. A server-side variant (appending a save-hint to the `/memory/recall` `formatted` field, which Hermes pipes through for free) was considered and deferred: it couples a write-side nudge to the recall endpoint and only benefits one client automatically. Keeping v1 pure-plugin keeps the blast radius inside `apps/plugin/` and each client independently tunable.
