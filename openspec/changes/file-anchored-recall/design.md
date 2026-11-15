## Context

Prompt-time recall (`proactive-entity-recall`, implemented but not archived) extracts entities from the user's prompt and returns short lines at turn start. It never sees the files an agent reaches mid-turn.

This design was measured before it was written. The figures below come from three sources:

- a production snapshot (2026-11-12, 468 active memories in one code project);
- the Claude Code transcripts of this repository (14 sessions with file tools);
- a 64-run headless A/B. In it, `claude -p` (Sonnet) ran in plan mode with a prototype hook; the control arm ran the identical lookup and printed nothing.

What the measurements show:

- **The data exists.**
  - 53% of active memories carry a `path` entity.
  - With the matching rule below, 28.8% of the (session, file) pairs agents touched have at least one eligible memory.
- **Agents reach files through the shell.**
  - Unique tool calls: 1,866 `Bash`, 92 `Read`, 261 `Edit`, 103 `Write`.
  - Of 690 (session, file) pairs read, 565 never pass through a file tool.
  - Hooking file tools alone sees 35 pairs with memories; parsing every shell command raises that to 220.
  - `rtk` appears in 1 of 1,866 commands. Extraction does not need a command list.
- **It is cheap.**
  - Hook process plus HTTP against an instant stub: p50 27 ms. A hook that answers from its local record: 9.5 ms.
  - SQL per lookup: p50 0.007 ms.
  - Injected per session at the chosen caps: about 160 tokens at the median and about 1,500 at the maximum. One agent-initiated `memory.search` returns about 13.8 KB.
  - Between two consecutive file-tool calls, the median gap is 5.6 s.
- **It helps where the knowledge is not in the code, and did not hurt.**
  - A/B: treatment 22/22 versus control 20/22. The only difference was a title-truncation task, where both control runs truncated before redacting, violating a repository invariant that a memory states.
  - Every other value scenario was answerable from the repository, and both arms found it.
  - Three scenarios injected memories that are stale at HEAD. 0 of 6 treatment runs were misled; one flagged the memory as stale.
  - The cost difference at a warm prompt cache was within noise.

Each host's mechanism was checked against its official documentation at the installed version, and spot-checked against the installed package:

| Host        | Version | Mechanism                                                |
| ----------- | ------- | -------------------------------------------------------- |
| Claude Code | 2.1.325 | `PreToolUse` `additionalContext`, verified with a canary |
| Codex CLI   | 0.163.0 | `PreToolUse` `additionalContext`, since 0.129            |
| Pi          | 1.4.0   | `tool_result`                                            |
| Hermes      | v0.22.5 | `transform_tool_result` / `transform_terminal_output`    |
| opencode    | v2 API  | `execute.before` + session `context`                     |

Owner priority: Claude Code, then Pi, then Hermes, then opencode. Codex shares Claude Code's script.

## Goals / Non-Goals

**Goals:**

- Put the few memories that are about a file in front of the model when the agent reads that file, without the agent asking.
- Behave the same on all five clients.
- Keep the added latency to tens of milliseconds per new file and the tokens to a bounded, small budget per session.
- Fail open everywhere.

**Non-Goals:**

- Influencing an edit before it is applied. On every host the note reaches the model with or after the tool's result.
- Recall for directory-wide commands (`grep -rn x packages/`) and for `codegraph_explore`, which names symbols rather than files.
- Persisting the files a session touched. Measured, this adds 4 of 125 pairs over memories, and it can be added server-side later from the same request.
- The opencode v1 plugin API.
- Changing prompt-time recall.

## Decisions

### D1. Trigger on file tools AND on every shell command

Hook `Read|Edit|Write|MultiEdit|NotebookEdit|Bash` on Claude Code, `Bash|apply_patch` on Codex, and the equivalents elsewhere. Extract paths from any shell command by a token rule: a token containing `/` and ending in `.<ext>`, or an absolute path, capped at 5 per command.

- _Alternative: file tools only._ It sees 16% of the pairs with memories.
- _Alternative: a list of read commands_ (`cat`, `sed`, …). It misses `grep`, `rg`, `git show` and `rtk`, and it needs upkeep.
- One token rule covers all of them. The cost is that the hook also spawns on shell calls that name no file. That costs the 9.5 ms floor on a median 5.6 s gap.

### D2. One implementation of the decisions, on the server

The server owns:

- suffix generation;
- the ambiguity check;
- eligibility, ranking, formatting, the byte bound and dedupe.

Clients only extract paths, make them repo-relative, list same-name siblings, remember what they sent, and render.

- _Alternative: compute candidates in every client._ That is three implementations (bash, JavaScript, Python) of the subtle part.
- _Alternative: let the server judge ambiguity from stored path entities alone._ Measured worse: 26 vs 29 hit files. Historical paths stored in memories (`apps/server/...`) make unique files look ambiguous, while unrelated `*/spec.md` noise gets through. Ambiguity needs the real tree.

### D3. Siblings from `git ls-files` by file name, capped at 64

The client runs one `git ls-files -- '*/<name>' '<name>'` per new file. That measured 4–7 ms; most names return 1–4 paths. It sends the list only when it has at most 64 entries.

- `spec.md` returns 557 paths (48 KB). Above the cap, every short suffix is ambiguous anyway, so sending nothing correctly falls back to the exact path.
- _Alternative: upload the whole tracked-file list once per session_ (≈100 KB, with server state per session). Rejected: it is heavier than the per-file query it would save.

### D4. Exact path plus unique suffixes of at least two segments

Measured hit rates over the touched files:

| Rule                                  | Hit rate                          |
| ------------------------------------- | --------------------------------- |
| Exact path only                       | 22.4%                             |
| Suffixes of 3+ segments               | 24.8%                             |
| Any 2+ segment suffix                 | 34.4%, with the `X/spec.md` noise |
| **Unique 2+ segment suffix (chosen)** | **28.8%**                         |

A bare file name is never tried.

### D5. Rank by fewest linked paths, then newest

A memory that names two files is more likely to be about each of them than one that lists forty. Blind-judged top-3 usefulness on the files with more than three matches: 11/27 by specificity, 7/27 newest-first, 8/27 by type priority.

- _Alternative: mention density._ It tied with specificity, but it needs the content scanned.

### D6. Payload: one window, then titles; a date and a review marker on every line

- The first memory gets title, id, date and a 300-character window around the file's mention. The others get title, id and date.
- `needs review` is appended when the derived review state says so, so the model can weigh a stale memory.
- The block is bounded at 1,024 bytes.
- Titles alone carried the actionable fact in only 7 of 19 useful memories.
- `memory.search`'s prefix `snippet` contains the mention in only 11 of 52, so the window is cut around the mention.
- Window only on the first memory gives the same 89% coverage of useful memories as windows on all three, at about a third fewer tokens.

### D7. Caps: 3 memories per file, 10 files per session

Coverage vs tokens frontier on the 14 sessions:

| Configuration                     | Coverage of useful memories | Tokens/session, median | Tokens/session, max |
| --------------------------------- | --------------------------- | ---------------------- | ------------------- |
| **3 per file, 10 files (chosen)** | 89%                         | ≈160                   | ≈1,500              |
| 3 per file, 20 files              | 100% (+4 useful memories)   | —                      | ≈3,000              |
| 1 per file, 10 files              | 63%                         | —                      | —                   |

The session cap is enforced by the server and announced with `exhausted`, so clients stop calling. A 1,000-file synthetic session stays at the cap.

### D8. Dedupe: per path on the client, per memory id on the server, released on resume

- The client remembers the paths it sent and never re-sends one. That is the 70% saving on unique calls, and it collapses an edit burst on one file to one request.
- The server dedupes by memory id, so a memory linked to two files appears once. The state lives in an LRU bounded at 500 sessions, released on end, soft-delete and resume.
- Resume is what every post-compaction path already calls (Claude Code and Codex `post-compact.sh`), so a compacted conversation can be told again.
- _Alternative: a re-check TTL of X minutes._ Measured over 2,177 hook firings:

| Rule                      | HTTP calls | Re-injections |
| ------------------------- | ---------- | ------------- |
| Once per session (chosen) | 690        | 0             |
| TTL 10 min                | 977        | 113           |
| TTL 1 min                 | 1,242      | 243           |

The TTL buys mid-session memories from other sessions, which happened once in nine sessions.

- _Alternative: share the prompt-time recall dedupe set._ It would couple this change to an unarchived one, and it keys on entities, not memories.

### D9. Exclude memories saved by the calling session

Of the memories saved mid-session about a file the session touched, 12 came from that same session and 1 from another. The agent wrote its own, so echoing them back is noise.

### D10. Eligible types follow prompt-time recall

Only `project`, `feedback` and `procedural`. In the judged sample this drops two useless `reference` notes and one useful one, out of 30 useful memories. It keeps the two recall paths consistent.

### D11. Sub-agents are skipped

Prompt-time recall already skips sub-agent sessions. On Claude Code a sub-agent's hooks carry the parent's `session_id`, so recalling into the sub-agent would spend the parent's dedupe on a context the parent never sees.

- _Accepted trade-off:_ an Explore sub-agent that reads a file gets no note.

### D12. Per-host delivery follows each host's documented mechanism

| Host        | Delivery                                                                | Reason                                                                                            |
| ----------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Claude Code | `additionalContext`, documented as arriving "alongside the tool result" | —                                                                                                 |
| Codex       | JSON-only `additionalContext`, never `permissionDecision`               | A 0.163 test shows an `allow` without `updatedInput` invalidates the output and drops the context |
| Pi          | `tool_result` content append, returning `structuredContent` unchanged   | Pi's `tool_call` cannot add text and fails closed                                                 |
| Hermes      | `transform_tool_result` / `transform_terminal_output`                   | `pre_tool_call` cannot add text and fails closed                                                  |
| opencode v2 | `execute.before` to capture and fetch, `context` to deliver             | The v1 route (mutating `tool.execute.after`) is undocumented and excluded                         |

### D13. Bounded, fail-open budgets

POST budgets:

- 0.3 s for bash, against a 2 s host hook timeout. `prompt-hints.sh` uses 0.2 s at turn start; file recall waits on a tool, not on the first token.
- 500 ms for the JavaScript core, matching recall hints.
- 0.5 s for Python.

Every failure, including a `404` from a server without the route, produces no output and an exit or return that lets the tool proceed.

### D14. A usage counter, so production can confirm the numbers

The route records firings and lines per token next to the existing recall counter. The post-release check (tokens per session, firings, latency) uses it, with no transcript collection.

## Risks / Trade-offs

- **[Risk] Parallel hooks race on Claude Code's per-session record** (the host runs a turn's tool hooks concurrently). → Append-only, line-at-a-time writes under a lock directory. A lost update only repeats a request, which the server's memory-id dedupe absorbs. Covered by a concurrent-run test, and by an independent verifier on that PR (high-risk item 4).
- **[Risk] A stale memory steers the agent wrong.** → The A/B saw 0 of 6 misled. Lines carry the date and `needs review`, and the code the agent reads in the same step wins.
- **[Risk] Notes that merely mention the file are noise.** Precision measured 58% of shown memories useful, and 22 of 29 hit files had at least one useful line. → Specificity ranking, the 3-per-file cap and the 1 KB bound keep the cost of a miss small.
- **[Risk] Hermes' tool results are JSON strings.** Appending text naively may break a consumer. → A spike against the installed Hermes fixes the form before implementation. The spec requires the result to stay valid JSON.
- **[Risk] Codex 0.163 reports the turn's `cwd`, not the command's.** → Paths are resolved against the turn `cwd` and dropped unless tracked there. Commands that `cd` elsewhere lose their notes until Codex 0.166+.
- **[Trade-off] The hook spawns on every shell call.** Accepted because the floor is 9.5 ms against a 5.6 s median gap, and a matcher cannot see inside the command.
- **[Trade-off] A file named both in a prompt and later in a tool call can surface twice,** once as a prompt-time title line and once as a file note. Accepted to keep the two dedupe states independent of an unarchived change.
- **[Trade-off] Directory-wide shell reads and `codegraph_explore` get no notes.** Accepted: they name no file.

## Migration Plan

Stacked PRs:

1. This OpenSpec change.
2. The server.
3. Claude Code and Codex.
4. Pi.
5. Hermes.
6. opencode v2.

The server ships first in the `server` release track. Each plugin PR ships in the unified `plugin` track. A plugin that reaches a server without the route gets `404` and stays silent, so the two tracks can release in either order.

Rollback: a plugin release that reverts the hook entries or handlers, or a server release that removes the route. Clients degrade to silence either way. No data is written, so nothing needs reverting.

## Open Questions

- The exact JSON-preserving form of a Hermes `read_file` / `terminal` result with the note appended. Resolved by the Hermes PR's spike and recorded there.
- Whether, after release, the production counter confirms the measured median of about 160 tokens per session. If it exceeds about 300, or the hook p95 exceeds 50 ms, the caps are revisited in a follow-up change.
