## REMOVED Requirements

### Requirement: Codex hook configuration

**Reason**: The requirement asserts, as its first divergence bullet, that "Codex has no `SessionEnd` event (verified against `developers.openai.com/codex/hooks`)". That is false at HEAD, and the cited URL is where the contradiction lives: it redirects to `learn.chatgpt.com/docs/hooks`, which documents `SessionEnd` as a first-class Codex event — "It runs for the main thread when you archive or delete a conversation that's still open, when Codex closes normally, or after a conversation has been idle and isn't open in any connected client for 30 minutes. It won't run for subagents." The falsehood is load-bearing rather than cosmetic: it is why Codex sessions reach `abandoned` instead of `ended`, which is the population `memory.session_resume` exists to serve, and it is asserted in a published scenario titled "Codex sessions remain active until abandoned by sweep" whose GIVEN/WHEN pair ("the user closes Codex CLI") is now precisely the case where `SessionEnd` DOES fire. A published scenario cannot be re-titled inside a `MODIFIED` block — `scripts/check-delta-freshness.mjs` fails on it and `openspec archive` refuses the merge — so the requirement is removed and re-added below under a header that names the event and its budget. Every other clause is carried over: the `PreCompact`/`PostCompact` support statement, the explicit two-matcher-group rule, the matcher-less `UserPromptSubmit` prohibition, the `Stop`-requires-JSON rule, and every scenario except the retired one.

**Migration**: Operators upgrading get one behaviour change with no action required: a Codex session that previously sat `active` for up to 24 hours before `abandonStale` retired it as `abandoned` now reaches `ended` with a transcript-derived summary when Codex closes normally. Existing `abandoned` rows are not rewritten and need no repair — they are resumable by the same route as any other terminal row. Contributors: `apps/plugin/hooks/hooks.codex.json` gains a `SessionEnd` entry, and four assertions in `apps/plugin/test/hook-manifests.test.ts` that codify the falsehood are retired (see the ADDED requirement for what replaces each).

## ADDED Requirements

### Requirement: Codex hook configuration and its `SessionEnd` budget

The repository SHALL host Codex hook configuration at `apps/plugin/hooks/hooks.codex.json`, sibling to the Claude Code plugin's `apps/plugin/hooks/hooks.json`, declaring the Codex-supported events the plugin wires: **six event types across nine handler entries**.

Codex's hook surface differs from Claude Code's in ways the platform forces, and has evolved since this requirement was first written:

- **Codex DOES have a `SessionEnd` event, and this capability previously asserted it did not.** Per `learn.chatgpt.com/docs/hooks`, it "runs for the main thread when you archive or delete a conversation that's still open, when Codex closes normally, or after a conversation has been idle and isn't open in any connected client for 30 minutes. It won't run for subagents." Its stdin carries `session_id`, `transcript_path`, `cwd`, `hook_event_name` and `reason`; `matcher` filters `reason`, whose only current value is `other`, so the entry SHALL declare no matcher. Its output is advisory — "Their output won't steer Codex or keep the thread open" — so the handler SHALL emit nothing to stdout, matching Claude Code's `SessionEnd`.
- **`SessionEnd` carries the tightest time budget of any hook on either host, and it is not the 600-second default.** Verbatim: "If `timeout` is omitted, Codex uses 600 seconds for most hooks. `SessionEnd` uses `1` second by default and supports up to `3` seconds." The plugin's shared curl helper allows a POST 3 seconds (`claude-code-plugin`, `rembric_post`), so an undeclared timeout kills the handler before its request can complete, and a declared `"timeout": 3` with an unchanged POST budget leaves nothing for reading the transcript or emitting the failure diagnostic. The entry SHALL therefore declare `"timeout": 3` — the documented maximum — AND cap its own POST at 2 seconds through the helper's budget override. Neither half is optional: the timeout alone still lets one slow request consume the whole budget, and the override alone still leaves the handler dead at one second.
- Codex DOES support `PreCompact` and `PostCompact` events as of current `codex-cli` releases; the plugin wires both. `apps/plugin/scripts/pre-compact.sh` exists and is invoked from `hooks.codex.json`'s `PreCompact` entry — any statement that it should be removed for lack of a Codex event is false.
- Codex's `SessionStart` stdin carries a `source` field and the dispatcher matches `SessionStart` matchers against it, so a `matcher: "compact"` group behaves the same way it does for Claude Code. Both matcher groups are declared **explicitly**: `startup|resume|clear` and `compact`. Neither is a default/unmatched group. Codex's documented `source` values are exactly `startup`, `resume`, `clear` and `compact`; there is no `fork` source as there is on Claude Code, so the Codex manifest SHALL NOT declare one and the divergence from `hooks.json` is the hosts', not a plugin inconsistency.
- Codex's dispatcher does NOT filter `UserPromptSubmit` by matcher; the hook fires on every prompt regardless. The manifest therefore declares NO matcher on either `UserPromptSubmit` entry, and each script self-filters internally. Declaring an advisory matcher was previously required by this capability and is now prohibited: an advisory matcher that the dispatcher ignores misleads every reader about where the filtering lives, and Claude Code's registration was deliberately made matcher-less too, so first-prompt detection sees every prompt on both clients.
- Codex's `Stop` hook REQUIRES JSON on stdout: "Stop expects JSON on stdout when it exits 0. Plain text output is invalid for this event." Per official docs.

`apps/plugin/scripts/session-end.sh` SHALL take an optional agent-name argument selecting the per-client transcript parser, exactly as `pre-compact.sh <agent>` already does (`claude-code` default, `codex-cli` selecting the `*_codex_cli` helpers). There SHALL be no `session-end.codex.sh`. Both manifests SHALL pass the argument explicitly, so `hooks.json`'s invocation becomes `session-end.sh claude-code` rather than the bare form.

`abandonStale` remains the net for every Codex close where `SessionEnd` does not fire — subagent threads, a SIGKILL, or a handler killed by its 1–3 second budget before its POST landed. The steady state it covers is narrower than this capability previously claimed, not gone.

The authoritative table of which hook POSTs what for both clients is `plugin-session-protocol`'s lifecycle mapping, which also carries the cross-client rule that every ensure of a session id is followed once per process by `POST /api/<slug>/sessions/<id>/resume`.

#### Scenario: Hook event coverage

- **WHEN** `apps/plugin/hooks/hooks.codex.json` is loaded
- **THEN** the `hooks` object SHALL declare exactly these six event types and no others: `SessionStart`, `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`, `SessionEnd`
- **AND** those six SHALL carry exactly nine handler entries in total
- **AND** `SessionStart` SHALL declare exactly two matcher groups, with the literal matchers `startup|resume|clear` and `compact`
- **AND** `UserPromptSubmit` SHALL declare exactly two entries, invoking `prompt-search.sh` and `prompt-nudge.sh`, and NEITHER SHALL carry a `matcher` key
- **AND** the `hooks` object SHALL NOT contain `PostToolUse`
- **AND** every hook entry SHALL be `type: "command"` — Codex does not support `type: "mcp_tool"` for hooks
- **AND** the `startup|resume|clear` `SessionStart` group SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh codex-cli` (reused from the Claude Code plugin; the `agent` arg differs)
- **AND** the `SessionStart` `"compact"` matcher group SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/post-compact.sh codex-cli` (the same script Claude Code's `SessionStart(compact)` hook uses)
- **AND** the `PreCompact` hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/pre-compact.sh codex-cli`
- **AND** the `PostCompact` hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/post-compaction.sh`
- **AND** the `SessionEnd` hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-end.sh codex-cli`

#### Scenario: The four assertions that codified the false claim are retired and replaced

- **WHEN** `apps/plugin/test/hook-manifests.test.ts` is read at HEAD
- **THEN** `expect(codexHooks.SessionEnd).toBeUndefined()` SHALL be gone, replaced by an assertion that the entry exists, declares `"timeout": 3` and carries no `matcher` key
- **AND** the event-type set assertion SHALL name six events including `SessionEnd`, not five
- **AND** the handler-count assertion SHALL be `9`, not `8`
- **AND** the ordered invocation list for `hooks.codex.json` SHALL include `SessionEnd command scripts/session-end.sh codex-cli`, and the list for `hooks.json` SHALL read `SessionEnd command scripts/session-end.sh claude-code`
- **AND** each assertion SHALL still be an exact set or exact count, never a containment check — a `toContain` cannot catch a manifest claiming an event is absent, which is the defect class that produced this requirement

#### Scenario: The SessionEnd handler fits inside the event's budget

- **WHEN** `hooks.codex.json`'s `SessionEnd` entry is read
- **THEN** it SHALL declare `"timeout": 3`
- **AND** it SHALL set the shared helper's POST budget to a value strictly below that timeout, so a hanging server yields the failed-POST stderr diagnostic rather than a handler killed with no record
- **AND** the control SHALL pass in the same run: the entry's timeout SHALL NOT be raised above `3`, which the host does not honour for this event

#### Scenario: A normally-closed Codex session reaches `ended`

- **GIVEN** a Codex session of N turns whose `Stop` hook posted `/summary` each turn
- **WHEN** Codex closes normally and `SessionEnd` fires with a readable `transcript_path`
- **THEN** the handler SHALL POST `/api/<slug>/sessions/<id>/end` with `{summary, title, final:false}`, or `{}` when the transcript is unreadable or parses empty
- **AND** the row SHALL be `status='ended'` with `ended_at` set
- **AND** the handler SHALL emit nothing to stdout, because Codex documents `SessionEnd` output as advisory and it cannot reach the model

#### Scenario: A Codex close where SessionEnd does not fire still reaches a terminal state

- **GIVEN** a Codex session terminated by SIGKILL, or running as a subagent thread (for which the host documents that `SessionEnd` does not run)
- **WHEN** the process disappears
- **THEN** the row SHALL remain `status='active'`
- **AND** the `abandonStale` job (running per `SESSION_ABANDON_AFTER_MS`, default 24h) SHALL flip it to `status='abandoned'`
- **AND** the row's `summary` and `title` SHALL reflect the most recent `Stop`'s POST

#### Scenario: A resumed Codex conversation re-attaches its memories

- **GIVEN** a Codex session `<S>` whose row is `ended` (normal close) or `abandoned` (sweep)
- **WHEN** the operator reopens that conversation and Codex fires `SessionStart` with `source: "resume"` for the same `session_id`
- **THEN** `session-start.sh` SHALL POST the ensure and then `POST /api/<slug>/sessions/<S>/resume`
- **AND** the row SHALL be `status='active'` with `ended_at IS NULL`
- **AND** a subsequent `memory.save` on that conversation's MCP transport SHALL persist a non-null `session_id`
- **AND** the control SHALL pass in the same run: the same `memory.save` without the resume persists `session_id = NULL`

#### Scenario: Codex Stop wires to a per-turn summary writer

- **WHEN** the `Stop` hook fires (which it does once per agent turn under Codex semantics)
- **THEN** the hook's FIRST entry SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/stop-sync.sh codex-cli` — the same script Claude Code's `Stop` hook invokes with `claude-code` in its own first entry, diverging in exactly THREE ways selected by that agent-name argument: (1) the transcript parser (`*_codex_cli` vs `*_claude_code`), (2) the stdout contract (Codex MUST `printf '{}'`; Claude Code MUST emit nothing), and (3) the `final` field (Codex sends `"final":false` explicitly; Claude Code OMITS the key entirely). It also diverges in execution model, which the agent argument selects rather than the caller: Codex runs synchronously because it has no documented async escape hatch and must emit its JSON before exiting, while Claude Code daemonizes the body into a detached, output-redirected subshell
- **AND** the script SHALL read `session_id`, `cwd`, and `transcript_path` from stdin
- **AND** SHALL read `${cwd}/.rembric` for the slug
- **AND** SHALL read `transcript_path` if readable, format it via `_transcript.sh`, derive a title from the first non-empty assistant message (≤100 chars)
- **AND** SHALL POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/summary` with body `{"summary": "<formatted>", "title": "<derived>", "final": false}` — note: `/summary` NOT `/end`, because Codex `Stop` is per-turn and the session must stay `active` for the next turn to keep updating
- **AND** SHALL emit `'{}'` to stdout (Codex requires JSON on Stop stdout; plain text is invalid per docs)
- **AND** SHALL exit zero even on internal error

#### Scenario: Only one copy of stop-sync.sh exists

- **WHEN** the plugin tree is inspected
- **THEN** `apps/plugin/scripts/stop-sync.sh` SHALL exist exactly once and be referenced by both `hooks.json` and `hooks.codex.json`
- **AND** no `stop-sync.codex.sh` variant SHALL exist

#### Scenario: Only one copy of session-end.sh exists

- **WHEN** the plugin tree is inspected
- **THEN** `apps/plugin/scripts/session-end.sh` SHALL exist exactly once and be referenced by both `hooks.json` and `hooks.codex.json`
- **AND** no `session-end.codex.sh` variant SHALL exist
- **AND** the per-client transcript parser SHALL be selected by the agent-name argument, not by a second script

#### Scenario: Codex Stop output without JSON would fail the hook

- **GIVEN** a script that POSTs `/summary` correctly but emits plain text to stdout
- **WHEN** Codex receives that stdout
- **THEN** Codex SHALL flag the hook output as invalid (per the "Stop expects JSON" contract) and the hook SHALL be considered failed for that turn

#### Scenario: prompt-search.sh self-filters on Codex

- **GIVEN** the `UserPromptSubmit` hook fires on Codex for a prompt that does NOT match the recall-intent keywords, on a turn that is not the session's first
- **WHEN** `prompt-search.sh` runs (invoked on every prompt, because no matcher is declared and Codex's dispatcher would ignore one anyway)
- **THEN** the script SHALL detect the non-match against the prompt text from stdin and exit without emitting either line
- **AND** on Claude Code the same matcher-less registration and the same self-filter SHALL produce byte-identical behaviour, since the filtering lives entirely in the script on both clients

#### Scenario: Compaction hooks are all correctly wired

- **WHEN** the repository is at HEAD
- **THEN** `apps/plugin/scripts/pre-compact.sh`, `apps/plugin/scripts/post-compaction.sh`, and `apps/plugin/scripts/post-compact.sh` SHALL all exist and be executable
- **AND** `hooks.codex.json` SHALL reference `pre-compact.sh` from its `PreCompact` entry, `post-compaction.sh` from its `PostCompact` entry, and `post-compact.sh` from its `SessionStart` `"compact"` matcher group

#### Scenario: Codex's Stop carries the end-of-turn reminder as a second entry

- **WHEN** `hooks.codex.json`'s `Stop` handlers are read in order
- **THEN** the second SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/stop-nudge.sh codex-cli`
- **AND** it SHALL be the same single script Claude Code invokes with no agent argument, diverging only in the stdout contract: Codex requires a JSON object on every invocation, so a silent turn SHALL emit `{}` where Claude Code emits nothing
- **AND** no `stop-nudge.codex.sh` variant SHALL exist
