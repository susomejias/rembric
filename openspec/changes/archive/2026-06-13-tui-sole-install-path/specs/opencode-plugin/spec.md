## MODIFIED Requirements

### Requirement: README documents the two-step install

`apps/plugin/.opencode-plugin/README.md` SHALL lead with the **TUI installer** as the primary install/upgrade path (the root `install.sh` shim, canonical URL `.../main/install.sh`, or `--agent=opencode`).

Below that, under an explicitly-labelled "Manual install" heading, the README SHALL document the manual install in exactly two steps in this order:

1. Run `bash install.sh` (or `curl ... | bash` shorthand if the operator publishes one).
2. Paste the printed MCP snippet into `~/.config/opencode/opencode.json` (or the project's `./opencode.json`), filling in `<REMBRIC_SERVER_URL>` and `<REMBRIC_API_TOKEN>`. Restart opencode.

The README SHALL include:

- An "Update" section explaining that opencode does not cache plugins by version, so updating means re-running the installer (the TUI's opencode update, or re-running `install.sh`, which overwrites the installed files).
- A "Verify" section showing how to confirm the install: opening opencode in a `.rembric`-equipped repo, opening a session, observing one `[rembric] session.created` stderr line in opencode's debug logs.
- A "Troubleshooting" section listing the three most likely failure modes: missing `.rembric` (plugin silently no-ops the session POST), missing env vars in the MCP block (bridge exits 1 and opencode shows a connection error), opencode version older than the supported floor (handler API mismatch).

The README SHALL NOT include an "npm install" path.

#### Scenario: README leads with the TUI, manual two-step follows

- **WHEN** the file is read top-to-bottom
- **THEN** the first install instruction SHALL be the TUI installer
- **AND** under a "Manual install" heading the two manual steps SHALL appear in order: step 1 (run install.sh) before step 2 (paste MCP snippet)
- **AND** no section mentions npm
