# Tasks — replace `mcp-remote` with `@rembric/mcp-bridge`

**Phase 1 is a gate, not a warm-up.** It is a throwaway prototype of the **engine only**, in the scratchpad, driven by a real Claude Code against a real stack, and it must clear four arms. **If any arm fails, STOP: the proposal is abandoned and nothing in phases 2–11 is built.** This ordering is the direct lesson of `evict-stale-transport-state` (#328), which built roughly 1600 lines before measuring the merge gate its own design had named as unverifiable from inside the repo, failed it, and was reverted whole (`ba555da`). Sunk cost is what makes a late gate hard to honour; a scratchpad prototype has none.

**Phase 2 is a second gate, for two mechanical unknowns** (design D14). Both are verified against real hosts **before** any manifest is switched, because both fail in ways that are hard to see afterwards, and both have recorded fallbacks. Do not skip ahead to phase 5 with these open.

**Glossary, used consistently below**: **the bridge** = `@rembric/mcp-bridge`, the published client-side piece. **the launcher** = `apps/plugin/bin/rembric-bridge.mjs` after this change — a deprecated ~10-line file kept only for pre-existing opencode configs.

**Three standing hazards for every phase:**

- **Probe files go in the scratchpad, never under `apps/server/src/`.** A stray probe there reds `tsc --noEmit` project-wide and blocks every pre-commit in the repo. The scratchpad is tmpfs — copy measurements out before the session ends.
- **`pnpm run dev:docker:up` runs `seed-dev --reset` on every boot**, from inside the container command where `package.json` does not show it. Never point it at a corpus you want to keep.
- **Never drive a real authenticated Codex CLI.** An authenticated Codex process reaches the real production Rembric through an account-level connector regardless of `CODEX_HOME` or environment isolation (incident recorded 2026-08-10). Codex is recorded as unverified with that reason — but note phase 2 still needs a Codex answer for `npx` resolution, which is obtainable **without** credentials (see 2.4).

---

## 1. GATE A — engine prototype, with an explicit STOP

Nothing in this phase is committed. Work in the scratchpad only.

- [ ] 1.1 Write a ~100-line prototype: the MCP SDK's stdio-server transport and Streamable-HTTP-client transport piped together as a **raw message pipe** (design D2), plus the `404` wrapper (D13). Bearer from `REMBRIC_API_TOKEN`. Install the SDK in a scratchpad directory, not in the repo.
- [ ] 1.2 Bring up `pnpm run dev:docker:up`; capture the `demo-writer` token from `docker logs rembric-dev` (the compose attach mode buffers stdout, so do not grep the log file). Create a scratch project dir with `PROJECT_SLUG=demo` in `.rembric`.
- [ ] 1.3 Drive a **real** `claude` CLI against the prototype, following the `rembric-plugin-development` skill's "Driving a real Claude Code" rails: isolated `CLAUDE_CONFIG_DIR` (never `HOME`), credentials copied with `install -m 600` and **never read or echoed**, `--mcp-config <scratch>.json --strict-mcp-config`, `--model claude-haiku-4-5-20251001`, `--allowedTools` scoped to the one MCP tool the probe needs, and an external `timeout` on every run. Purge the copied credentials in teardown.
- [ ] 1.4 **Arm A — roots discovery resolves a project.** With a path-less `/mcp` endpoint, confirm the connection resolves to a project via roots discovery and that `project.current` names it.
- [ ] 1.5 **Arm B — a normal tool call round-trips.** Against the path-scoped `/mcp/demo` endpoint, a `memory.save` succeeds and the row is present in `data-dev/data.db`. Control that must pass: `memory.get` on a fabricated id returns `not_found`.
- [ ] 1.6 **Arm C — the failing repro, then the recovery.** With a live session, restart the server (`docker restart rembric-dev`), then issue a tool call. It MUST recover: the server log shows a fresh `initialize` and the call returns a result. **This is the case that hangs today** — run the same sequence through the current `mcp-remote` chain first and record the hang (expected: `Execution error`, external `timeout` kill, exit 124), so the treatment has a failing control.
- [ ] 1.7 **Arm D — `clientInfo` passthrough.** Confirm the server observes the host's real `clientInfo.name` (expected `claude-code`, exact), **not** a bridge-authored or bridge-suffixed name. Record the exact observed string. If verbatim passthrough is not achievable with the SDK's transport classes as published, that is a STOP condition (D2) — do NOT work around it by re-authoring `clientInfo`.
- [ ] 1.8 **Measurement — session-start chatter, one named instrument.** Instrument: _server-side elapsed time and request count from the transport's first HTTP request to the `initialize` POST_. Record it for both arms. Baseline already measured 2026-08-15 for `mcp-remote@0.1.38` against a stub: 4 requests (`GET /mcp`, three `.well-known` GETs) and 25 ms before the first MCP frame. Do not mix this instrument with any end-to-end figure.
- [ ] 1.9 **Measurement — `npx` cold-start delta, end to end.** With a cleared npx cache, time `npx -y mcp-remote@0.1.38 …` and `npx -y <local tarball of the prototype> …` to first MCP frame. Label it explicitly as end-to-end; it is the user-visible cost of the 80→97 package / 7.0→24 MB install-tree growth measured in D12, partly offset by the four requests and the extra process that disappear.
- [ ] 1.10 **GATE A DECISION.** Record every arm's outcome with its provenance in this file. **If A, B, C or D failed, STOP here**: write the outcome into the change folder, close the proposal, and build nothing.

## 2. GATE B — the two mechanical unknowns, before any manifest changes

Both are cheap, both are blocking, and both have fallbacks recorded in design D14. Answer them in the scratchpad.

- [ ] 2.1 **Can release-please write a pin embedded in a JSON `args` array?** Its `generic` updater is annotation-driven and JSON carries no comments; its JSON updaters write a key's value, not a substring inside an array element. Test against the **pinned** `googleapis/release-please-action` version this repo uses, not against current docs.
- [ ] 2.2 Record the answer and pick the fallback if needed, in this order: (1) native support; (2) a CI assertion that every `@rembric/mcp-bridge@<x.y.z>` substring equals `apps/plugin/package.json::version`, turning silent rot into a red build; (3) the manifests spawn a one-line in-plugin launcher carrying the pin as a JS constant — the annotation form `.opencode-plugin/plugin.ts` already uses. Fallback 3 reintroduces a small launcher for Claude and Codex; it preserves everything else about the integration and is not a reason to abandon it.
- [ ] 2.3 **Does `npx` resolve under Codex's `Command::env_clear()` spawn semantics?** `command: "node"` working today is **not** evidence: `npx` must itself be locatable and must locate `node`. Read `codex-rs/rmcp-client/src/utils.rs::create_env_for_mcp_server` and `stdio_server_launcher.rs::launch_server` to determine what the curated env contains.
- [ ] 2.4 Verify 2.3 empirically **without credentials**: a Codex install with no authenticated account can still be pointed at a local plugin whose `mcp.json` spawns `npx`, and the question — does the program resolve — is answered by whether the process starts, which needs no model call and no server data. This is how the Codex answer is obtained without violating the standing hazard. If `npx` does not resolve, add `PATH` to `env_vars` and re-verify; if that is still insufficient, apply fallback 3 for Codex.
- [ ] 2.5 **GATE B DECISION.** Record both answers and the chosen mechanism here. Phase 5 does not start until this is written down.

## 3. The package skeleton

**Before editing any `package.json`, `.npmrc`, `pnpm-workspace.yaml`, lockfile, CI install step, or Dockerfile install layer, consult `.agents/skills/npm-security-best-practices/` and `CONTRIBUTING.md#adding-a-dependency`.** This phase touches the workspace manifest, the lockfile and a published manifest; the repo's posture is default-deny and the skill is the mandatory consulting point.

- [ ] 3.1 Create `apps/plugin/mcp-bridge/` with `package.json` (`name: "@rembric/mcp-bridge"`, `type: "module"`, `version` matching the current plugin version, `files` allowlist, one `bin` entry, **no** `private`, **no** lifecycle script of any kind), `cli.mjs`, `bridge.mjs`, `slug.mjs`, `README.md`. The directory name MUST NOT match `\.[\w-]+-plugin` — that pattern is how `invariants.test.ts:901` decides a file is a session client and must import `rembric-plugin-core.mjs`.
- [ ] 3.2 Declare `@modelcontextprotocol/sdk` as the sole runtime dependency at an **exact** version — no `^`, `~`, `>=`, `*` or `x`. Pick a version that satisfies `pnpm-workspace.yaml::minimumReleaseAge` (4320 minutes) and dedupes with `apps/server`'s resolution (currently `1.29.0`). **Record the chosen version number in this file**, not just "the current one".
- [ ] 3.3 Add `apps/plugin/mcp-bridge` to `pnpm-workspace.yaml::packages` and run `pnpm install`. Verify the lockfile change is confined to the new member and its dedupe, and that `pnpm install --frozen-lockfile` then succeeds from clean.
- [ ] 3.4 Add un-ignore entries for the new directory to `eslint.config.js`'s ignore list (`:16`–`:24` currently un-ignores only `apps/plugin/bin` and `apps/plugin/.*-plugin/*.ts`, so the package is invisible to lint until added). Confirm with `pnpm run lint` that the new files are actually linted — introduce a deliberate lint error, see it reported, remove it.
- [ ] 3.5 Add the package's test glob to `apps/server/vitest.config.ts::include` (`:31`–`:39` lists per-client globs literally). Confirm with a deliberately failing placeholder test that the file is actually executed, then remove it. A test file that is never run is the failure mode this task exists to prevent.
- [ ] 3.6 Verify `npx` resolves the executable with no bin-name argument: `npm pack`, then `npx -y ./<tarball>` in a clean directory with the required env set, and confirm the process starts. If the scoped-package bin resolution is ambiguous, rename the bin key rather than documenting a `--package` workaround.

## 4. The bridge itself

- [ ] 4.1 **Move `rembric-dotenv.mjs`** from `apps/plugin/bin/` to `apps/plugin/mcp-bridge/`. In the **same commit**, update every tracked literal that names the old path: `invariants.test.ts:814` (`REMBRIC_DOTENV_MJS`, asserted present in the scanned set at `:914`), `scripts/pi-package.mjs`'s `PACKABLE_IMPORT` regex `^\.{1,2}\/bin\/([\w.-]+\.mjs)$`, `apps/plugin/.opencode-plugin/plugin.ts`, `apps/plugin/.pi-plugin/index.ts`. Add it to the package's `files` allowlist.
- [ ] 4.2 Implement the raw message pipe (D2): the host's frames, including `initialize` and its `clientInfo`, pass through **verbatim** in both directions. No SDK `Client` performing its own handshake, no identity substitution, no tool-name or payload rewriting.
- [ ] 4.3 Implement project-directory resolution (`CLAUDE_PROJECT_DIR > PWD > process.cwd()`, empty-string values skipped with `||` semantics) and the slug cascade: validated `.rembric` `PROJECT_SLUG`, then validated `REMBRIC_PROJECT_SLUG`, then path-less. An invalid candidate falls through with a diagnostic; nothing aborts. No parent-directory walk. Import `parseDotenv`/`SLUG_RE` from the moved module — never redefine them.
- [ ] 4.4 Emit the startup diagnostic `[rembric-bridge] projectDir=<dir> (from <source>) url=<url>`. **Keep the `[rembric-bridge]` prefix**: the e2e walkthrough and the troubleshooting docs already grep for it, and preserving it is part of why the package took this name.
- [ ] 4.5 Read the bearer from `REMBRIC_API_TOKEN`; accept **no** command-line arguments. Fail fast on a missing `REMBRIC_SERVER_URL` or `REMBRIC_API_TOKEN`: exactly one stderr line naming the variable, non-zero exit, zero HTTP requests. No stderr output anywhere may contain the token's value.
- [ ] 4.6 Port the advisory `/healthz` version check from `rembric-bridge.mjs:85-124` unchanged in behaviour: one fire-and-forget request, 2 s timeout, warn-never-block, silent on any failure. It must not delay the connection.
- [ ] 4.7 Implement the `404` recovery (D13): discard the session id, send `InitializeRequest` + `notifications/initialized`, retry the original request **once**. `404` only; `401`/`403`/`429`/`5xx` propagate unchanged; a second failure propagates; a request carrying no session id (notably `initialize`) is not a recovery case; only the handshake is replayed.
- [ ] 4.8 Confirm by inspection and by test that the bridge issues **zero** requests to any `.well-known` path, binds no listening socket, and makes exactly one `/healthz` request per session start.
- [ ] 4.9 Write the package README with the compatibility matrix: each entry states how it was verified (host, arms, date) or that it is unverified with the reason. Codex CLI and Windows are the two mandated unverified entries. The Codex entry must state that its **manifest changes in this change**, so it is _not_ true that Codex inherits an untouched shared file. Comments in this package follow repo policy: one line for a non-obvious why, never a banner — rationale lives in `openspec/specs/mcp-bridge/spec.md`.

## 5. Manifests, and the deprecated launcher

Do not start this phase until GATE B (phase 2) is recorded.

- [ ] 5.1 Switch `apps/plugin/.claude-plugin/mcp.json` to `command: "npx"`, `args: ["-y", "@rembric/mcp-bridge@<pin>"]`, keeping the `env` block sourcing `${user_config.server_url}` and `${user_config.api_token}`. No URL, no `--header`, no `--allow-http`.
- [ ] 5.2 Switch `apps/plugin/.codex-plugin/mcp.json` to the same command, keeping `cwd: "."` and `env_vars` (with `PWD`, and with `PATH` if GATE B found it necessary). No `env` field — Codex would treat literal map values as overrides that clobber `env_vars`.
- [ ] 5.3 **Rewrite `apps/plugin/bin/rembric-bridge.mjs` to the ~10-line launcher**: spawn `npx -y @rembric/mcp-bridge@<pin>`, inherit stdio, pass the environment through, forward the exit code, re-raise a terminating signal. Nothing else — no `.rembric` read, no URL building, no `/healthz`, no slug regex.
- [ ] 5.4 Update `apps/plugin/test/rembric-bridge.test.ts`: its stub currently intercepts `npx mcp-remote …` (`:14`, `:23`, `:117`). Assert the launcher's argv positively — `-y` plus the pinned specifier — and **negatively** that no URL, no `--header` and no `--allow-http` appear, and that the token is not in the argument list.
- [ ] 5.5 Update `apps/plugin/.opencode-plugin/install.sh`: fetch the dotenv module from its new path; copy the launcher for backward compatibility; rewrite **both** shared imports and extend the `grep -qF` guard to cover **both** destinations; print the `npx` MCP snippet instead of the `node <path>` one. Update `uninstall.sh`'s removal targets to match. **This is the known-dangerous edit**: a guard checking one destination lets the installer exit 0 having written a plugin that cannot load, with the suite green because nothing loads the installed plugin.
- [ ] 5.6 Verify the whole `git diff` for phase 5 is small and legible: two manifests, one file reduced to a launcher, one test, two install scripts. If the launcher grew logic, it is wrong.

## 6. Tests, and mutation proof for every guard

- [ ] 6.1 Build the hermetic full-chain harness: a stdio client, the bridge, and an in-process HTTP server that terminates sessions — no `npx`, no network. This is the 2026-08-15 A/B turned into a standing test (D16).
- [ ] 6.2 Test: `tools/call` → `404` → re-init → retry → success, with the host observing no error. Assert the exact frame sequence the bridge emitted.
- [ ] 6.3 Test (control that must fail without the guard): a `401` on a session-carrying request triggers **no** re-init and **no** retry, and propagates.
- [ ] 6.4 Test: a `404` on the retried request propagates; no third attempt, no second `InitializeRequest`.
- [ ] 6.5 Test: a `404` to a request with no session id (`initialize`) propagates and does not recurse.
- [ ] 6.6 Test: `clientInfo` sent by the stdio client is byte-identical to what the HTTP server receives, for `name` and `version` both.
- [ ] 6.7 Test: against a server answering `400` for an unknown session id, the recovery never fires and the error propagates — the pre-`c2affef` skew case (D15).
- [ ] 6.8 Test the slug cascade: `.rembric` beats `REMBRIC_PROJECT_SLUG`; the env var applies when no `.rembric` resolves; an invalid `.rembric` slug falls through to the env var with a diagnostic and no abort; neither present yields path-less `/mcp`; the project-dir chain skips an empty-string `CLAUDE_PROJECT_DIR`.
- [ ] 6.9 Test: the bearer is present on every request and absent from every stderr line; and, driven as a real subprocess, absent from `/proc/<pid>/cmdline`.
- [ ] 6.10 **Mutate every guard, one condition at a time**, with `node scripts/mutate.mjs --file … --spec … --mutation … --with …`, and record which test went red for each. At minimum, reproducing the two gates `ea09360` used: making the retry **unconditional on status** must red 6.3's `401` arm; turning the retry into a **bounded loop** must red 6.4's second-failure arm. Also prove: removing the no-session-id exemption reds 6.5; substituting the bridge's own `clientInfo` reds 6.6; swapping the slug cascade order reds 6.8; changing `||` to `??` in the project-dir chain reds the empty-string arm. A guard whose test stays green on both sides of the mutation is not covered — that is the default outcome, not the exception.
- [ ] 6.11 Respect the mutation harness's limitation: `scripts/mutate.mjs` drives vitest, which ignores type errors. Any guard that is a _type_ guard must be verified with a hand `tsc` widen/restore loop instead, recorded as such.

## 7. Release, publishing and invariants

**Re-consult `.agents/skills/npm-security-best-practices/` before editing the workflow.**

- [ ] 7.1 Add the carriers to `release-please-config.json`'s `plugin` `extra-files`, using whatever GATE B settled: `mcp-bridge/package.json`, plus the three pin sites (`.claude-plugin/mcp.json`, `.codex-plugin/mcp.json`, `bin/rembric-bridge.mjs`). Keep `.release-please-manifest.json` at exactly two entries and the config at exactly two packages.
- [ ] 7.2 Add `scripts/mcp-bridge-package.mjs` with an `assert-pack` command mirroring `scripts/pi-package.mjs`'s: `npm pack --dry-run`'s file list asserted against an expected set, failing on both a missing and an unexpected path. It must catch a missing `rembric-dotenv.mjs`, which would publish a package whose slug resolution cannot load.
- [ ] 7.3 Add the publish step to `.github/workflows/release-please.yml`'s existing `publish-npm` job: same `plugin_release_created` gate, same `id-token: write` OIDC identity, `npm publish --provenance --access public`. **No `NPM_TOKEN`, ever.**
- [ ] 7.4 Add an invariant asserting every `@rembric/mcp-bridge@<x.y.z>` specifier in the tree equals `apps/plugin/package.json::version`. Mutate one pin and confirm the suite reds. This is the executable check the spec requires where a file format cannot carry a release-please annotation.
- [ ] 7.5 Generalise the published-package invariants in `apps/server/src/test/invariants.test.ts` (`:988`–`:1042` are written around the single constant `PI_PACKAGE_JSON`): derive the set of published packages rather than hard-coding one path, and assert per package a `files` allowlist, no forbidden lifecycle key, and no `private`. Prove it with a mutation: adding a `prepack` to the **new** package must red the suite.
- [ ] 7.6 Add an invariant asserting the new package's `dependencies` has exactly one entry whose value carries no range operator. Mutate it (`1.29.0` → `^1.29.0`) and confirm the suite reds.
- [ ] 7.7 Confirm the shared-helper scan reaches the new package and that it defines nothing `rembric-plugin-core.mjs` owns — `diag` and `truncate` are the live collisions. Prove it: add `function diag` to a bridge source, see the suite red, remove it.
- [ ] 7.8 Confirm the new package is **not** treated as a session client: the invariant's client-detection pattern must not match it, and it must not be required to import the protocol core.
- [ ] 7.9 Verify the Docker image is unaffected: `apps/server/Dockerfile:26,95` install with `--filter @rembric/server...`. Build the image and confirm the size is unchanged within noise and the new package is absent from `/prod-out`.

## 8. Documentation

- [ ] 8.1 `apps/plugin/README.md:185,187` — replace the `mcp-remote` description, and re-state the first-launch download cost with the number measured in 1.9 rather than the "~5–15 s" inherited from the old package.
- [ ] 8.2 `apps/plugin/.opencode-plugin/README.md:99` — update the troubleshooting line naming `mcp-remote`, and document both shapes: the `npx` form for new installs and the launcher path for pre-existing ones.
- [ ] 8.3 `apps/plugin/.hermes-plugin/README.md:62,73` and `docs/agents.md:246` — replace the `mcp_servers.rembric` block. It must name `@rembric/mcp-bridge@<exact version>` (never `@latest`), pass **only** `-y` and the specifier, take the bearer from the forwarded environment, and express the slug as `REMBRIC_PROJECT_SLUG` rather than a `/mcp/<slug>` URL suffix. Also fix the stale `plugin/bin/` path.
- [ ] 8.4 `docs/agents.md:370` and `:520` — update the opencode troubleshooting line, and rewrite the "Any other MCP client" stdio-only paragraph so it no longer recommends `mcp-remote` as "the same package the Rembric plugin's bridge wraps".
- [ ] 8.5 Update the `rembric-plugin-development` skill's `e2e-walkthrough.md` where it drives the transport: the expected diagnostic line still holds (the `[rembric-bridge]` prefix is preserved), but the `opencode.json` snippet and the `node <path>` invocation change.
- [ ] 8.6 Confirm `git ls-files apps/plugin/` still shows exactly one copy of each shared resource — in particular exactly one `rembric-dotenv.mjs`, at its new path.

## 9. End-to-end validation per the plugin skill

Follow `.agents/skills/rembric-plugin-development/references/e2e-walkthrough.md`. Each result is recorded here with its provenance — host, arms, date — not attributed to the suite.

- [ ] 9.1 **Claude Code (real).** Repeat arms A–D from phase 1 against the built package installed the way a user gets it, through the real manifest. Same isolation rails as 1.3.
- [ ] 9.2 **opencode, fresh install (real).** `PLUGIN_SRC`/`BIN_SRC` install from the local checkout, paste the printed `npx` snippet, then `opencode mcp list --print-logs --log-level DEBUG`. Expect the `[rembric-bridge]` diagnostic, a successful connect, and a tool count matching the server's `registerTool` call sites (**derive** the count from `apps/server/src/mcp/server.ts`; do not hard-code it). Then restart the server mid-session and confirm the recovery.
- [ ] 9.3 **opencode, upgrade path (real) — the arm that is easy to skip and is exactly why the launcher exists.** Create an install using the **pre-change** installer (from `git HEAD~`), so `opencode.json` names `~/.config/rembric/bin/rembric-bridge.mjs`. Then run the new installer **without touching `opencode.json`** and confirm the session still connects through the launcher. Testing only fresh installs would miss the entire population the launcher serves.
- [ ] 9.4 **Codex CLI — record as UNVERIFIED with the reason** for the session-level arms, per the standing hazard. The `npx`-resolution question is separately answered in 2.4 without credentials; say which parts are verified and which are not, rather than collapsing them.
- [ ] 9.5 **Hermes — config-block only.** Verify the documented `mcp_servers.rembric` block works by running it by hand against the dev stack, including that `REMBRIC_PROJECT_SLUG` resolves and that a per-directory `.rembric` overrides it.
- [ ] 9.6 **Windows — record as UNVERIFIED with the reason** (no Windows CI; the package adds no platform-specific code and leans on the SDK's transports, which is an argument, not a measurement).
- [ ] 9.7 Clear leftover `active` session rows between e2e runs. The resolver returns "sole match or nothing", so one un-ended session from an earlier arm silently poisons attribution in every later one — a probe already failed this way once and the failure was mistaken for a defect.

## 10. Verification and release

- [ ] 10.1 `pnpm run typecheck` · `pnpm run lint` · `pnpm test` all green. `pnpm run eval` is not required — retrieval is untouched.
- [ ] 10.2 `pnpm run check:spec-provenance` green (it compares `origin/main...HEAD`; CI is the gate).
- [ ] 10.3 Run the `rembric-tui-installer-e2e` playbook. The installer itself is unchanged, but the per-client install scripts it orchestrates are not — `install.test.ts` headless plus the local install round-trips.
- [ ] 10.4 **Real Docker smoke against pre-existing seeded data.** Standing requirement for anything touching MCP or production behaviour: bring up the stack, exercise the plugin path, and confirm the corpus is intact afterwards. Remember `dev:docker:up` reseeds on boot — smoke a corpus you created inside the same run.
- [ ] 10.5 **Operator-only: verify the first release end to end.** After the release PR merges, confirm (a) the `plugin-vX.Y.Z` tag, (b) `@rembric/mcp-bridge@X.Y.Z` published **with provenance**, (c) all three pin sites at that commit naming exactly `X.Y.Z`, and (d) `@rembric/pi@X.Y.Z` published in the same run. The window in which `main` names an unpublished version (D11) closes here; a failed publish job is release-blocking.
- [ ] 10.6 Update issue #348 with the outcome: the client half of its blocker is now fixed, and record whether that changes the standing for #328's eviction (it does not re-enable it — that is a separate change).

## 11. Parallel, non-blocking

- [ ] 11.1 **Upstream PR to `geelen/mcp-remote`**, referencing issue #106: implement the spec's session-terminated → re-init MUST. Written in English. Independent of every other phase — it neither blocks nor is blocked by this change, and it is the only path by which `@rembric/mcp-bridge` could ever be retired. Link the PR here when opened.

## 12. Deferred and explicitly rejected — recorded so they are not silently lost

- [ ] 12.1 Record as **deferred, own change**: server-side client disambiguation using the now-exact `clientInfo`, which would revisit `findActiveForTransport`'s give-up-under-ambiguity rule (`agent-sessions-repository.ts:144-154`) and make the reverted bridge-instance-id mechanism (`ea71092`/`d1ff2c9`) permanently unnecessary. Load-bearing: it touches scope and session attachment.
- [ ] 12.2 Record as **deferred, own change**: a bridge-answered `roots/list` for hosts that do not advertise the capability (#329). It would let path-less `/mcp` resolve correctly without `.rembric`, but it means the bridge _answering_ a request rather than forwarding one — a real widening of its charter that forfeits part of D15's argument.
- [ ] 12.3 Record as **deferred, own change**: removing the opencode launcher, once existing `opencode.json` files have turned over. Needs a signal that they have, which this change does not provide.
- [ ] 12.4 Record as **deferred, own change**: re-opening #328's transport eviction. This change fixes the client half of its blocker; the decision to evict again is separate.
- [ ] 12.5 Record as **deferred**: sending an explicit `DELETE` on shutdown to terminate the session server-side (design Open Question 2). Permitted by the spec and useful to #328, but a second unproven mechanism does not belong behind this change's gate.
- [ ] 12.6 Record as **rejected**: bundling the SDK to reach zero runtime dependencies (D12) — it hides the dependency from a consumer's advisory tooling. Rejected: pinning at N−1 to close the tag-versus-publish window (D11) — it permanently guarantees we ship code other than what we just released. Rejected: accepting an optional positional URL override (D7) — a second way to express the endpoint that diverges the moment one changes. Rejected: having `install.sh` rewrite an existing `opencode.json` (D6) — a much larger promise than this change should make. Rejected: the package names `@rembric/mcp` (too vague) and `@rembric/bridge` (does not say what it bridges).
- [ ] 12.7 Record the correction to the archived note at `openspec/changes/archive/2026-07-12-fix-cross-session-misattribution/design.md:38`. It states that `mcp-remote` "always declares itself as `{name: 'mcp-remote', version}`"; measured at the pinned 0.1.38 the behaviour is a **rewrite** — `"<host> (via mcp-remote 0.1.37)"` — so the host name survives as a prefix, and the appended version is itself wrong. The conclusion (the field is not the host's name; no exact match against it is safe) stands. A future change reasoning from that note would otherwise assume a stricter failure than exists.
