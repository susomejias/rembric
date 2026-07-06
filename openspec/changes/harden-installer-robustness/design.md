# Design — harden-installer-robustness

## Context

The TUI installer is the single canonical install path (orchestrator model; root shim is a pure forwarder). Its contract lives in `openspec/specs/tui-installer/spec.md` and `.agents/skills/rembric-tui-installer/SKILL.md`. The bash hook transport `_api.sh` is shared by Claude Code and Codex. The bridge (`rembric-bridge.mjs`) is shared by Claude Code, Codex, and opencode.

## Goals / Non-Goals

**Goals:** every network interaction is bounded; every failure produces exactly one actionable diagnostic; install-time verifications fail loudly instead of deferring breakage to runtime.

**Non-Goals:**

- Plugin↔server version-compatibility negotiation (needs its own design: compatibility matrix ownership, where the floor lives, offline behavior — deferred to a future change).
- Retrying lifecycle POSTs in `_api.sh` (hooks must stay fast and never block the host; one attempt + one diagnostic line).
- Walk-up `.rembric` discovery (separate deferred change).

## Decisions

### D1: `_api.sh` diagnoses but never fails

`rembric_post` keeps `return 0` unconditionally; on curl non-zero it prints one line to stderr: `[rembric] POST <path> failed (curl rc=<rc>)`. No body capture (avoids leaking payloads into host logs), no retry. This matches opencode's `diag()` and Hermes' `_stderr()` semantics — the requirement is normative across clients.

### D2: bring_up health = authenticated `/healthz` poll

After `up -d`, poll `http://127.0.0.1:${PORT}/healthz` with `Authorization: Bearer $tok`, `--max-time 2` per attempt, ~15 attempts × 2s sleep (≈30s ceiling — first boot loads the embedding model). Success prints the existing "Up." + dashboard line (plus server version from the healthz JSON, parsed with the same minimal-sed approach used elsewhere — no jq dependency). Timeout prints a failure hint (`docker compose logs`) and exits the flow WITHOUT claiming success. POSIX sh, `set -e`-safe (poll loop ends `return 0`/`if-fi` per contract checklist item 7).

**Alternative considered:** unauthenticated TCP probe. Rejected: `/healthz` is under auth by design decision (2026-05-17); a TCP probe can't distinguish "listening" from "crashed after bind" and we hold the token anyway.

### D3: Fetch bounds

`fetch()`: `--max-time 30 --retry 2 --retry-connrefused`. Root shim curl: same. The existing `--max-time 4` release check stays as is (best-effort probe). 30s is generous for the largest artifact on slow links while still bounding the worst case under 2 minutes with retries.

### D4: Pin `mcp-remote`

Replace `mcp-remote@latest` with the exact version current at implementation time (resolve with `npm view mcp-remote version` during implementation and hard-code). The pin is a plain string in the bridge; bumping it rides normal plugin releases. `npx` caches resolved versions, so startup also gets faster/offline-safe after first run. The canonical spec's prose bullet naming `@latest` is corrected at archive-time sync (tracked in tasks as the archive note).

### D5: opencode installer verifications

- Detection: instead of `grep -q '"rembric"'` over the whole file, detect the actual MCP entry (match a `"rembric"` key inside the `mcp` object — implemented with a scoped grep/awk over the `"mcp"` block; jq is NOT a dependency we can assume).
- Post-sed assert: after rewriting the dotenv import path, `grep -qF "$DOTENV_DEST" "$PLUGIN_DEST"` or abort with a clear error. Turns silent runtime breakage into a loud install failure.

## Risks / Trade-offs

- [Risk] The healthz poll adds ~30s worst case to a failing bring-up. → Accepted: a false "Up." costs the operator far more.
- [Risk] A pinned mcp-remote misses upstream fixes. → Mitigation: version bumped deliberately with plugin releases; regression risk of `@latest` is strictly worse (unreviewed upstream release breaks all users simultaneously).
- [Trade-off] Scoped-grep detection of the opencode `mcp.rembric` key is heuristic (no jq). → Accepted because the current substring match is strictly weaker; the assert in D5 catches the residual failure mode at install time.
- [Risk] `set -e` regressions in the new poll loop kick users out of the TUI menu. → Mitigation: contract checklist item 7 pattern (`return 0` endings); headless suite exercises the path.

## Migration Plan

Plugin-track release; installer changes take effect on next `curl|sh` run (always fetched at ref). Rollback: previous plugin release.

## Open Questions

(none)
