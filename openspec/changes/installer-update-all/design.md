## Context

`memory.about` has advertised `update_all = curl … | sh -s -- --action=update` since it was written — the `mcp-api` spec's own text already names "the update-all variant (`… --action=update`)" as part of the tool's contract. But `apps/plugin/install.sh`'s non-interactive dispatch required `--agent` whenever `--action` was given, so this exact command has always errored (`--agent requires --action`, a confusing message for an invocation that never passed `--agent` in the first place). Every deployed server has been telling agents to run a command that fails.

## Goals / Non-Goals

**Goals:**

- Make the advertised `update_all` command actually work: update every installed plugin with an update available, skip the rest, never error.
- Add the matching interactive menu entry so the TUI and the headless flag surface offer the same capability.
- Reconcile `memory.about`'s guidance text with the new, safer default.

**Non-Goals:**

- Not changing `--agent=<specific>,… --action=update` — that path already worked and stays exactly as-is.
- Not adding a new "force" or "dry-run" mode — `--status --json` already serves as the dry-run (it's what `print_table`/`do_status` already compute; `do_update_all` reuses the identical detection functions).

## Decisions

### D1. Reuse existing detection, add only the iteration + skip logic

`installed_version`, `available_version`, `component_key`, and `vercmp` already exist and back `--status`'s table. `do_update_all` calls the same four functions per client and switches on `vercmp`'s five possible results (`update`/`none`/`install`/`ahead`/`unknown`), calling `do_client "$c" update` only for `update` and printing a skip line for everything else. No new detection logic — the risk of "update-all disagrees with what --status shows" is structurally impossible since they share the same functions.

### D2. Trigger condition: bare `--action=update`, or the explicit `--agent=all` alias

```sh
if [ "$ARG_ACTION" = "update" ] && { [ -z "$ARG_AGENTS" ] || [ "$ARG_AGENTS" = "all" ]; }; then
  do_update_all
elif [ -n "$ARG_AGENTS" ]; then
  … existing per-agent loop, unchanged …
fi
```

`all` is recognized ONLY as an agent-list value when `--action=update`; it is not treated as a magic value for `install`/`uninstall` (installing or uninstalling "everything" unconditionally is a different, more consequential operation than "update what's outdated" and wasn't asked for — kept out of scope deliberately).

### D3. Interactive menu: one new entry, not a new screen

Adding `all — update outdated` as the first choice in the existing "Which agent?" `arrow_menu` call (rather than a new top-level menu) keeps the existing flow (status table renders immediately above the prompt) and requires no new screen-management code. Selecting it runs `do_update_all` then `pause`, exactly like every other action in that menu.

### D4. `memory.about`'s note text

The spec's existing "status-first-then-selective-update" guidance predates `update_all` having any selectivity of its own — it was written when the operator had to manually decide which agents to update. Now that `update_all` never touches an agent that doesn't need it, that advice is obsolete for the `update_all` path specifically and gets moved to describe the `subset` command (where the operator DOES pick specific agents and still benefits from checking `status` first).

## Verification

- `install.test.ts`: 4 new tests — selective update-all (1 outdated + 3 not-installed → correct split, exit 0), nothing-to-update (0 updated, 4 skipped, exit 0 — the exact case that used to error), the `--agent=all` alias, and an up-to-date agent correctly skipped as `up to date` rather than re-updated.
- Interactive path verified with a real pty (`pty.fork()`): the "all — update outdated" entry renders as the first option below the status table; selecting it runs `do_update_all` and prints the same "Updating all plugins…" / per-agent skip lines / "Done: N updated, M skipped." output as the headless path, against this machine's real installed state (claude/opencode already at the published version → correctly reported "up to date — skipped").
- `pnpm vitest run install.test.ts` (54 tests, all green), `sh -n apps/plugin/install.sh` clean.

## Migration Plan

No migration — shell script + a server-side string constant, no schema/data change. Rollback is a plain revert.
