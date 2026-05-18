## Why

After enabling `plugin_hooks` and approving the 4 plugin hooks via `/hooks` review (documented in the previous change), Codex hooks finally fire — but two of them immediately fail with `error: hook returned invalid session start JSON output` and `error: hook returned invalid user prompt submit JSON output`. The other two (`PreCompact`, `Stop`) emit empty stdout and succeed silently.

Surface diagnosis pointed at "Codex requires structured JSON on hook stdout", which would have been a meaningful refactor (every script wrapped in `printf '{"hookSpecificOutput":{"additionalContext":"..."}}'`). Reading `codex-rs/hooks/src/events/{session_start,user_prompt_submit,compact,stop}.rs` reveals the actual contract is much more permissive:

```rust
// Preserve plain-text context support without treating malformed JSON as context.
} else if output_parser::looks_like_json(&run_result.stdout) {
    status = HookRunStatus::Failed;
    // → "hook returned invalid ... JSON output"
} else {
    let additional_context = trimmed_stdout.to_string();
    // → injected into agent context as plain text
}
```

And `looks_like_json`:

```rust
pub(crate) fn looks_like_json(stdout: &str) -> bool {
    let trimmed = stdout.trim_start();
    trimmed.starts_with('{') || trimmed.starts_with('[')
}
```

Codex's heuristic: "if stdout starts with `{` or `[`, assume JSON; otherwise treat as plain text and inject into agent context". Empty stdout is a third silent-OK case.

Our `session-start.sh` and `prompt-search.sh` emit:

- `[rembric] If this is a continuation of recent work, call memory.context before responding.`
- `[rembric] User intent: recall. Call memory.search with the user keywords before responding.`

Both start with `[`. Codex thinks "JSON array attempt" → tries to parse → fails → reports the misleading `invalid ... JSON output` error. The `[rembric]` cosmetic badge — a `console.log()`-style tag we adopted for visual grouping — is what trips the parser.

The fix is one character per script: drop the leading `[`. The badge becomes `rembric:` (colon-separated, ASCII-only, no leading `[` or `{`). Both clients accept plain-text stdout, so the same string works under Claude Code without change.

## What Changes

- **`plugin/scripts/session-start.sh`** — change the final nudge from `[rembric] If this is a continuation of recent work, call memory.context before responding.` to `rembric: If this is a continuation of recent work, call memory.context before responding.`
- **`plugin/scripts/prompt-search.sh`** — change the nudge from `[rembric] User intent: recall. Call memory.search with the user keywords before responding.` to `rembric: User intent: recall. Call memory.search with the user keywords before responding.`
- **`plugin/.codex-plugin/plugin.json`** + **`plugin/.claude-plugin/plugin.json`** — bump `version` from `0.2.2` to `0.2.3` in lockstep (CLAUDE.md rule for any user-visible `plugin/` change).
- **`plugin/CHANGELOG.md`** — `[0.2.3] — unreleased` entry capturing the fix and pinning the exact Codex source link (`looks_like_json` in `codex-rs/hooks/src/engine/output_parser.rs`).
- **`openspec/specs/claude-code-plugin/spec.md`** (via change delta) — Hook catalog SessionStart and UserPromptSubmit nudge literals updated to the new bracket-free strings. A new invariant added under "Hook script invariants": script stdout SHALL NOT begin with `{` or `[`, so Codex's `looks_like_json` heuristic treats it as plain-text additional_context. Cite Codex source so future contributors don't re-introduce the bracket prefix.

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `claude-code-plugin`: Hook catalog specifies the exact nudge strings for SessionStart and UserPromptSubmit. Those strings change from `[rembric] ...` to `rembric: ...`. A new invariant covering hook-script stdout shape is added to "Hook script invariants" so the rule is discoverable when contributors add new hooks.

## Impact

- **Touched paths**: `plugin/scripts/session-start.sh`, `plugin/scripts/prompt-search.sh`, `plugin/.codex-plugin/plugin.json`, `plugin/.claude-plugin/plugin.json`, `plugin/CHANGELOG.md`. Five files. Diff total well under 20 lines.
- **Untouched**: `plugin/.{claude,codex}-plugin/mcp.json`, `plugin/bin/rembric-bridge.mjs`, `plugin/hooks/hooks.{json,codex.json}`, `plugin/scripts/_api.sh`, `plugin/scripts/pre-compact.sh` (no stdout), `plugin/scripts/session-stop.sh` (no stdout), CLAUDE.md, docs/agents.md, README.md.
- **End-user impact (Codex)**: after `codex plugin marketplace upgrade rembric` and a Codex restart, the 4 hooks fire AND succeed. SessionStart POSTs to `/api/<slug>/sessions` (visible at `/dashboard/sessions`); SessionStart's nudge string is now injected as additional context the agent sees on its first turn. UserPromptSubmit's recall nudge likewise injects when the user matches the recall regex. End-to-end: Rembric session lifecycle works under Codex for the first time.
- **End-user impact (Claude Code)**: the visible nudge changes from `[rembric] If this is a continuation...` to `rembric: If this is a continuation...`. Same content, slightly different prefix. No behavioural change beyond the cosmetic.
- **Cache invalidation**: version bump from `0.2.2` to `0.2.3` forces a fresh cache pull on next `marketplace upgrade` for both clients. Without the bump, the old scripts would stay cached and the fix would be silent for existing users.
- **Out-of-scope follow-ups identified during exploration**:
  1. _Plugin skills_ (`/plugins` panel shows "No plugin skills"). Separate decision about token-budget vs `initialize.instructions` duplication.
  2. _Optional structured JSON output for hooks that want to block, change context, etc._ The plain-text path covers our current use case (additional_context nudges); if a future hook needs to issue a block decision or update the agent's input, we'd emit JSON for that specific hook. Not needed today.
