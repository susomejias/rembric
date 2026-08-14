## Context

The end-of-turn summary reminder was added by `ground-session-summaries` and is delivered by `apps/plugin/scripts/stop-nudge.sh` as `hookSpecificOutput.additionalContext` on the `Stop` hook. Issue #343 reports the host force-ending turns with:

> A hook blocked the turn from ending 9 consecutive times — overriding and ending turn. For Stop/SubagentStop hooks, check `stop_hook_active` in the input and return success while it's true.

**The mechanism, measured** (Claude Code 2.1.232, read from the shipped executable at `~/.local/share/claude/versions/2.1.232`):

- The `Stop` runner collects `additionalContexts` into the same array it returns as `blockingErrors`, and returns `{blockingErrors: b, preventContinuation: false}` when that array is non-empty. `additionalContext` from `Stop` is therefore not a side channel — it is the block path.
- The query loop, on a non-empty `blockingErrors`, appends those messages and re-enters with `stopHookActive: true`, `stopHookBlockingCount: ms`, `transition.reason = "stop_hook_blocking"` — i.e. it re-invokes the model.
- The block counter is capped (default 8, raisable by a host env var this plugin deliberately does not document). Exceeding it yields the warning above and ends the turn — but the counter tracks CONSECUTIVE blocks only, and a continuation the model answers with a tool call resets it. Measured end-to-end against a real `claude -p` 2.1.232 session at a cadence point: the pre-change hook re-fired on 141 consecutive host continuations over 10 minutes without the cap ever engaging, because the model answered every continuation with the `memory.session_summary` tool call the reminder itself asks for (141 such calls in the nested transcript); the session ended only when an external timeout killed it. The cap therefore rescues only tool-less turns — the issue reporter's polling case — and a model that OBEYS the reminder loops unboundedly. The host cap is not a backstop for this defect; the `stop_hook_active` guard is the only bound.
- The hook's own stdin schema carries `stop_hook_active: boolean` alongside `last_assistant_message`, for both `Stop` and `SubagentStop`.

**The loop, measured against the shipped script** (counter driven through the real `prompt-nudge.sh` to a cadence point, then `stop-nudge.sh` invoked with a real transcript):

| Invocation                                   | Emitted    |
| -------------------------------------------- | ---------- |
| cadence point, `stop_hook_active: true` (×3) | 1090 bytes |
| cadence point, `stop_hook_active: false`     | 1090 bytes |
| cadence point, field absent                  | 1090 bytes |
| turn 11, off cadence (control)               | 0 bytes    |

Nothing the script consults changes between continuations: the cadence counter advances only on `UserPromptSubmit` (`prompt-nudge.sh:34`) and a continuation submits no prompt; the facts extraction reads the whole transcript, which only grows. With an 8.36 MB transcript the emitted payload is 2709 bytes (the `RBR_NUDGE_MAX_FACTS_CHARS` ceiling) and each invocation costs 790 ms of hook wall-clock — paid up to 8 times per firing turn on a path the host waits for, plus 8 model round-trips, plus one extra `/summary` POST per continuation because the whole `Stop` entry list re-runs.

**The history is the interesting part.** `archive/2026-07-12-proactive-save-nudges/design.md:39` listed Claude `Stop` as a rejected channel on "forced-continuation risk". `archive/2026-07-28-ground-session-summaries/design.md:49` (D4) overrode that on the premise that `additionalContext` "removes the loop guard from the design entirely — there is no loop to guard", and its own Open Question 1 (`:70`) recorded `stop_hook_active` as answered-but-"moot, because D4 does not block". Issue #343 is that unmeasured premise being paid for: the July-12 caution was right, and the guard D4 called moot is the fix.

## Goals / Non-Goals

**Goals**

- One firing of the reminder per cadence point, never a second on a host continuation.
- The guard costs nothing: no transcript read, no counter read, no HTTP.
- Spec text that matches the measured host behaviour, including the retraction of the "cannot hold a turn open" claim in both capabilities that carry it.
- One shared implementation for both `Stop`-registering clients.

**Non-Goals**

- Changing which channel the reminder uses, or its cadence, its rubric text, or its payload bound.
- Adding a `SubagentStop` entry (none exists today).
- Touching opencode, Pi or Hermes: verified they inject nudges at turn start only (`plugin.ts:235`, `index.ts:378`, `__init__.py:515`) and their end-of-turn handlers only schedule HTTP flushes, so none can re-enter.
- Establishing whether Codex actually delivers `hookSpecificOutput` on `Stop` (see Open Questions).

## Decisions

### D1 — Honour the host's `stop_hook_active`, rather than building a second loop guard

The guard the host already provides is exactly the semantics needed ("this response was generated to satisfy this hook"), it is sent by both hook clients under the same name, and reading it is one line. Alternatives considered:

- **A private per-turn statefile, or a counter derived from the transcript's assistant-message count.** Rejected: it reimplements a flag both hosts already send, adds per-session state to a script whose only state today is the shared counter, and any derived signal still fires at least once before it converges — leaving a two-continuation floor instead of a one-continuation ceiling.
- **Move the reminder to a channel that genuinely does not continue the turn.** Rejected because there isn't one on this event: `additionalContext` is measurably the block path, and the sibling entry's `async: true` model is fire-and-forget by the host's contract and cannot contribute feedback at all (already recorded in `claude-code-plugin`'s `Stop` subsection).
- **Withdraw the end-of-turn reminder and keep only the start-of-turn nudge.** Rejected: `ground-session-summaries` exists because a start-of-turn reminder is advice about future work, and the defect here is a one-line omission, not a flaw in the placement.
- **Raise the host's block cap.** Rejected twice over: it is a host-side workaround that hides our defect, and it outlives the bug in every operator's environment. It is not used and is not documented anywhere in this change's output.

### D2 — The guard is the first decision in the script, before the config gate, the counter and the transcript

Placement is a performance decision with a measured number: on an 8.36 MB transcript a re-entry costs 790 ms of hook wall-clock today versus 5 ms with the guard in front (same fixture, same machine, three runs each; per-invocation hook wall-clock, not an end-to-end turn figure). Ordering config-gate-first would be behaviourally identical — both paths reach `_emit_nothing` — so the earliest position is chosen purely because it is the cheapest, and a test asserts the source order so a later edit cannot silently move the guard behind the parse.

### D3 — Fail open toward FIRING, which is the opposite direction to every other fail-open here

An absent, `null` or unparseable flag is treated as `false`. The requirement's other fail-opens (unreadable counter, missing transcript, unavailable parser) all resolve to silence; this one must not, because treating an unknown flag as `true` would silence the reminder permanently on any host or client that does not send the field, and a missing reminder is invisible whereas a loop announces itself. The blast radius of the chosen direction on such a host is the pre-change behaviour — which the e2e measurement showed is NOT reliably bounded by the host cap (a tool-answering model resets its consecutive counter) — but both hook hosts document the field, so no known client pays it; the direction is chosen for the clients that exist, not because the fallback is cheap.

### D4 — One shared `_api.sh` extractor, jq-first with a sed fallback, mirroring `rembric_session_ensure`

`rembric_stop_hook_active_from_stdin_json` echoes `true`, `false`, or nothing, using the same `if .x == true … elif .x == false … else ""` jq expression `rembric_session_ensure` uses for `.created` (`_api.sh:131-135`) and the same `sed -n 's/…\(true\|false\).*/\1/p' | head -n1` shape as the other stdin extractors. Both arms were measured against nine payloads — real `true`/`false`, absent, `null`, unparseable, empty, and three adversarial ones where the model's `last_assistant_message` quotes the flag itself — and they agree on all nine. The reason the regex arm is safe is worth recording because it is not obvious and was initially assumed to be a defect: valid JSON escapes inner quotes, so the byte sequence `"stop_hook_active"` cannot appear inside a string value, and the prose collision the fallback appears vulnerable to cannot occur. Its one measured divergence is a payload with a nested duplicate key (`{"stop_hook_active":false,"extra":{"stop_hook_active":true}}` → greedy sed `true`, jq `false`); the host emits no such payload, and jq is preferred anyway.

### D5 — This is a spec correction, not only a code fix, and the requirement's header is renamed

`plugin-session-protocol`'s requirement is titled "…and MUST NEVER interrupt" and its body asserted that the channel "cannot hold a turn open"; `claude-code-plugin:454` justified re-admitting `Stop` on the same sentence. Leaving either in place while the code honours a loop guard would publish a contract the code disagrees with, so the title moves to what is now true — the reminder MUST NOT re-enter once the host has continued the turn — and both bodies carry the measurement. The header change uses `## RENAMED Requirements` with the `## MODIFIED Requirements` block carrying the new header, which is well-defined: `openspec` applies `RENAMED → REMOVED → MODIFIED → ADDED` (verified in `dist/core/specs-apply.js`), and `MODIFIED` refuses to drop any scenario the current spec has, so every existing scenario is reproduced verbatim. The surviving assertion "SHALL NOT emit an interrupting decision" is kept and sharpened (no `decision` key, no stop reason): it is still true, and it was never what bounded the loop.

### D6 — Nothing in the hook manifests changes, and the other three clients are out of scope

`hooks.json` and `hooks.codex.json` both put the same `stop-nudge.sh` second on `Stop`, so the shared-script fix covers both `Stop`-registering clients with no manifest edit; the ordered `(script, async)` pair pinned by `apps/plugin/test/hook-manifests.test.ts:79-89` stays as it is. No `SubagentStop` entry exists in either manifest, so nothing is specified about it — but if one is ever added, the host sends the same flag on that event and the same guard applies.

## Risks / Trade-offs

- [Trade-off] The reminder still costs ONE host continuation per cadence point → Accepted because on this host that is what delivering it at all costs, and the alternative is not delivering it. Bounded and now stated in the spec rather than denied by it; if the extra model turn every ten turns is later judged too expensive, the honest fix is to move the reminder off `Stop`, not to weaken the guard.
- [Risk] A host that does not send `stop_hook_active` keeps looping → Mitigated by the direction of D3 only in the sense that behaviour is unchanged there, not improved — and the e2e measurement removed the comfort that the host cap backstops it (the cap counts consecutive tool-less blocks only; an obedient model loops unboundedly). Both hook hosts document the field, so no known client is in this state; a new client would have to demonstrate the field before wiring a model-facing `Stop` output.
- [Risk] The sed fallback decides the guard on a jq-less host → Mitigated by measurement: both arms agree on all nine probed payloads, including the three adversarial ones, and the single divergence needs a payload shape the host does not emit.
- [Risk] A future edit reorders the script and puts the guard behind the 790 ms parse → Mitigated by a source-order assertion in `apps/plugin/test/stop-nudge.test.ts`, plus the mutation gate that proves the guard's own tests fail without it.
- [Risk] Codex re-prompts for hook trust after the plugin version bump, so the reminder does not run until re-trusted → Accepted: unverified, and fail-open in the safe direction (no reminder, no loop).
- [Trade-off] The change publishes a retraction of a claim this repo made in two specs → Accepted because the alternative is a contract that contradicts the code, and the retraction is bounded to what was measured: nothing is claimed about hosts older than 2.1.232.

## Migration Plan

No migration. No schema, HTTP, MCP or dashboard surface is touched, and no derived data (`memory_fts`, `memory_vec`, entity tables) needs invalidating. The change ships as a `plugin`-track version bump, which is also what makes it visible to Claude Code's version-keyed plugin cache; operators pick it up through the TUI installer or their client's plugin update. The first stop event of a turn behaves exactly as before; only continuations change. Rollback reinstates the loop and nothing else.

## Open Questions

- **Does Codex deliver `hookSpecificOutput` on `Stop` at all?** Its documented `Stop` output contract is "Common output fields" plus `decision`/`reason`; `additionalContext` is documented for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse` and `SubagentStart`, but NOT for `Stop` — while `codex-distribution:355-359` asserts that channel for the second `Stop` entry. If the reminder is silently dropped there, the guard is harmless on Codex and the real defect is a separate one. Unverified against a running Codex; deliberately out of scope, and worth its own issue rather than an expansion of this change.
- **Did an older Claude Code host deliver this channel without continuing the turn?** Undetermined. Only 2.1.232 was measured, so no host regression is claimed anywhere in this change; the spec text says exactly that.
- **Should the reminder keep costing one continuation?** Default: yes, and say so plainly in the spec. Revisiting it means moving the reminder off `Stop`, which is a different change with its own measurement.
