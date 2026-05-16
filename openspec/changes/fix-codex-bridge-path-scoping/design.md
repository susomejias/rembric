## Context

The previous change `2026-05-16-fix-codex-mcp-env` made the Codex MCP bridge spawn correctly by introducing `plugin/.codex-plugin/mcp.json` with `cwd: "."` + relative-path `args`. That fix is verified working end-to-end (bridge starts, MCP authenticates, tools enumerate). It introduced a known regression that was explicitly out-of-scope of that change and tracked as a follow-up: under Codex, the bridge's `process.cwd()` now points at the plugin cache dir (`~/.codex/plugins/cache/rembric/rembric/0.2.1`) because Codex's `LocalStdioServerLauncher::launch_server` applies the manifest's `cwd: "."` (normalised to `plugin_root`) as the subprocess's working directory.

The bridge's job is to read `${projectDir}/.rembric` and path-scope the MCP URL to `/mcp/<slug>`. Today the bridge resolves `projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()`. Under Codex neither source gives the user's project dir:

- `CLAUDE_PROJECT_DIR` is a Claude-Code-only convention. Codex does not set it.
- `process.cwd()` is now the plugin cache dir, not the project.

Net effect: bridge logs `No .rembric in /Users/me/.codex/plugins/cache/...; using path-less /mcp` and the entire Codex session operates in global scope, ignoring any `PROJECT_SLUG` the user dropped in their project root.

Three alternatives were explored before this design landed on the chosen approach (see Decisions below):

1. **Walk-up directory traversal** — bridge walks up from cwd looking for `.rembric`, like `git`. Rejected because the cwd is the cache dir, not anywhere near the project — walking up would find nothing or worse, traverse the Codex cache hierarchy.
2. **MCP `roots` capability** — server queries client for workspace roots. Rembric has `src/mcp/roots-discovery.ts` ready for this, but Codex's MCP client (verified in `~/.codex/log/codex-tui.log`) only advertises `elicitation` capability in `initialize`, not `roots`. No-go without Codex-side changes.
3. **Publish bridge as npm package + `npx`** — the agentmemory pattern. With `command: "npx"` there's no need for `cwd: "."`, so Codex falls back to the shell cwd. Rejected by the user: they don't want to publish anything to npm (private nor public). This option remains the architecturally cleaner long-term path if the no-publish constraint relaxes.

## Goals / Non-Goals

**Goals:**

- Restore per-project path-scoping under Codex for the common case: user runs `cd <project> && codex` from a directory that contains a `.rembric` file with a valid `PROJECT_SLUG`.
- Keep `plugin/.claude-plugin/mcp.json` and Claude Code's runtime path completely unchanged.
- Avoid introducing a new env var the user has to remember to export. Lean on existing shell conventions (`PWD`).
- Fix a latent empty-string-env bug in the bridge's resolution chain (`??` accepts `""` as set, producing a relative `.rembric` lookup that finds the wrong file).

**Non-Goals:**

- Walk-up traversal of the filesystem to find `.rembric` from a starting point. Out of scope — if a user launches `codex` from a subdirectory of their project, they hit path-less `/mcp` (same as today's behaviour for a user without `.rembric`). Walk-up can be added in a future change without breaking this one.
- `REMBRIC_PROJECT_DIR` as an explicit override env var. YAGNI. Add only if a real user reports a PWD-doesn't-work scenario.
- Windows-specific behaviour. The bridge has no Windows tests today; this change does not introduce any new platform-specific code.
- Publishing the bridge as an npm package. Out of scope by user decision.
- Codex hooks display ("No plugin hooks" panel issue) — that's Codex's hook-trust UX, separate concern.

## Decisions

### 1. Add `PWD` as a middle fallback in the bridge's resolution chain

**Decision.** Change `plugin/bin/rembric-bridge.mjs`:

```js
// before
const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

// after
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd();
```

Precedence chain reasoning:

- **`CLAUDE_PROJECT_DIR` first** — Claude Code sets this to the workspace root. We do NOT want PWD to override it (under Claude Code, PWD might be wherever the user launched the app from, which may differ from the workspace).
- **`PWD` middle** — POSIX shell convention. Set by `bash`, `zsh`, `fish`, etc. to the current working directory of the shell that spawned the process. Under Codex, the shell that ran `codex` sets PWD, Codex inherits it in its own process env, and (with `env_vars: ["PWD"]` in our manifest) Codex forwards it to the bridge subprocess.
- **`process.cwd()` last** — final safety net. Under Codex this is the plugin cache (useless) but under unusual launchers without a shell it might be the user's home dir or wherever the launcher invoked from. Better than crashing.

**Alternatives considered:**

- **`??` keep the existing operator** with PWD added. Rejected — `??` treats only `null`/`undefined` as nullish, so `CLAUDE_PROJECT_DIR=""` (empty string but "set") passes through and produces `path.join("", ".rembric") === ".rembric"` (relative to process cwd). With `||`, empty strings skip cleanly. Tiny bug fix that comes free with the operator change.
- **Walk up from `CLAUDE_PROJECT_DIR || PWD || cwd()` to find `.rembric`**. Adds a few lines and meaningfully helps users who launch from a subdirectory. But it ALSO changes Claude Code's behaviour — if a parent dir has its own `.rembric` (monorepo scenario), Claude Code today wouldn't walk into it; with the new logic it might. Risk of surprise scope change. Defer.
- **Codex-only branch**: detect Codex via some env var and apply different logic. Considered: there's no clean "I'm running under Codex" signal in env. Avoid client-detection inside the bridge.

### 2. Add `PWD` to `env_vars` in `plugin/.codex-plugin/mcp.json`

**Decision.** Update the Codex MCP config from:

```json
"env_vars": ["REMBRIC_SERVER_URL", "REMBRIC_API_TOKEN"]
```

to:

```json
"env_vars": ["REMBRIC_SERVER_URL", "REMBRIC_API_TOKEN", "PWD"]
```

**Why mandatory.** `codex-rs/rmcp-client/src/stdio_server_launcher.rs::launch_server` calls `Command::env_clear()` then chains `DEFAULT_ENV_VARS` + names from `env_vars`. `DEFAULT_ENV_VARS` is `HOME, LOGNAME, PATH, SHELL, USER, __CF_USER_TEXT_ENCODING, LANG, LC_ALL, TERM, TMPDIR` — no `PWD`. So unless we name `PWD` in `env_vars`, the bridge subprocess simply doesn't see it. Verified earlier in this repo's investigation (the previous change's spec deltas already cite the same source files).

**Alternatives considered:**

- **`{ name: "PWD", source: "local" }` long form.** The `McpServerEnvVar` enum (in `codex-rs/config/src/mcp_types.rs`) accepts both forms. Short form is equivalent for our case (`source` defaults to `local`). No reason to be verbose.
- **Add `PWD` to `DEFAULT_ENV_VARS` upstream in Codex.** Out of scope — we don't control Codex.

### 3. Update bridge startup diagnostic to report which source won

**Decision.** Replace today's `[rembric-bridge] cwd=<dir> url=<url>` with `[rembric-bridge] projectDir=<dir> (from <source>) url=<url>` where `<source>` is one of `CLAUDE_PROJECT_DIR`, `PWD`, or `process.cwd()`.

**Why.** Future debugging of "why isn't path-scoping working?" should not require reading the bridge source. The line shows which env var (or none) supplied the directory. Zero runtime cost, ~30 chars more in stderr.

**Alternatives considered:**

- **Keep `cwd=<dir>` for backward compatibility with anyone grepping logs.** Rejected — `cwd` is now actively misleading (it's `projectDir`, possibly NOT `process.cwd()`). Renaming clarifies the contract. We do not know of external log scrapers depending on this string.

### 4. Version bump 0.2.1 → 0.2.2 in BOTH manifests

**Decision.** Both `plugin/.claude-plugin/plugin.json` and `plugin/.codex-plugin/plugin.json` move to `0.2.2`. Patch bump (bug fix, no behavioural change to Claude Code, no API/contract changes).

**Why both.** CLAUDE.md rule: any `plugin/` change visible to users requires both manifests to bump in lockstep. Without the bump, `codex plugin marketplace upgrade rembric` reports "already at the latest version" and the user has to uninstall+reinstall to recover. We saw this exact failure mode in the previous change's verification.

**Why patch not minor.** No new feature surface, no new contract. The proposal-level contract for `claude-code-plugin`'s bridge changes (PWD step added) is internal to the bridge — observable only via the stderr diagnostic. End-user behaviour under Claude Code: identical. End-user behaviour under Codex: previously-broken path-scoping starts working in a specific scenario. That's a fix, not a feature.

## Risks / Trade-offs

**[User launches `codex` from a non-project dir or subdirectory] → falls back to path-less `/mcp` (global scope).**
Mitigation: documented in `docs/agents.md` Codex section. Same as today's behaviour for any user without `.rembric` in cwd. No regression vs. current state. A future walk-up change can address this if reported.

**[User uses a shell that doesn't set `PWD`] → `PWD` is unset, bridge falls back to `process.cwd()` (plugin cache).**
Mitigation: same as today (broken path-scoping). Common shells (`bash`, `zsh`, `fish`) all set `PWD`. Power users with nu/PowerShell would see no improvement but also no regression. `REMBRIC_PROJECT_DIR` can be added as an explicit override in a follow-up if anyone reports.

**[User launches `codex` via Spotlight/Raycast/launcher without a shell] → `PWD` unset.**
Same mitigation as above. macOS launchers typically inherit the user's default shell env, but launchers that don't (rare) hit this path.

**[Stale `PWD` from a shell config quirk] → bridge picks up a wrong directory.**
Theoretical. If the user has manually exported `PWD` to something unrelated to their actual cwd, the bridge will look there. Diagnosed via the new `(from PWD)` annotation in the stderr line.

**[Claude Code subtle behaviour change because of the `??` → `||` switch]** if `CLAUDE_PROJECT_DIR` ever arrives as `""`.
Mitigation: this is strictly a fix. Today empty-string `CLAUDE_PROJECT_DIR` produces a path-less `.rembric` resolution against process cwd, which is itself a bug — silently looking in the wrong place. After the fix, the empty value cleanly falls through to PWD or `process.cwd()`. No legitimate behaviour relies on the buggy path.

**[Marketplace cache regeneration]** — Codex regenerates the plugin cache from the marketplace git clone on each `codex` launch. Mid-session edits to the cache do not survive. Verification therefore requires a real `marketplace upgrade rembric` after push, not a cache patch.

## Migration Plan

1. Land the change on `main` (version 0.2.2 in both manifests).
2. Existing Codex users: `codex plugin marketplace upgrade rembric` followed by `codex` restart. Cache regenerates at version 0.2.2; bridge picks up the new resolution logic; with `PWD` forwarded, path-scoping works if the user launched `codex` from their project root and that root contains `.rembric` with a valid `PROJECT_SLUG`.
3. Existing Claude Code users: no action needed. The plugin's Claude Code path is byte-for-byte identical apart from the version field.
4. New installs: get the corrected bridge by default.

**Empirical smoke test** (post-push, on the maintainer machine):

1. Push `0.2.2` to `main`.
2. `codex plugin marketplace upgrade rembric`.
3. Confirm `.rembric` exists at this repo root with `PROJECT_SLUG=rembric`.
4. Restart `codex` from this repo's directory.
5. Tail `~/.codex/log/codex-tui.log`. Expected: `[rembric-bridge] projectDir=/Users/jesus.mejias/Desktop/rembric (from PWD) url=http://192.168.20.48:8787/mcp/rembric`.
6. Trigger a tool call. Confirm response routes to the `rembric` project on the server side (not global).

**Rollback.** If the change causes any regression, revert the bridge file + the env_vars entry + the version bumps in a single commit. Users who already pulled `0.2.2` would need another `marketplace upgrade` to drop back to `0.2.1` once a `0.2.3` revert is published.

## Open Questions

- **Does Codex forward `PWD` reliably across macOS shell launchers (iTerm, Terminal.app, tmux)?** Empirical answer expected from the smoke test. If yes, this design holds. If not, we need `REMBRIC_PROJECT_DIR` follow-up.
- **Does the bridge need to log a warning when `PWD` exists but the resolved directory has no `.rembric`, vs. when no source produced a directory at all?** Today's diagnostic conflates "no `.rembric` found" with "couldn't resolve a project dir". With the new `(from <source>)` annotation, the operator can distinguish. No code change beyond what's already in this design.
