# Design — replace `mcp-remote` with `@rembric/mcp-bridge`

## Context

`proposal.md` carries the motivation and the headline measurements. This document records the decisions by number (D1–D18), the evidence each rests on, the risks, and the questions deliberately left open.

Everything asserted here about `mcp-remote` was measured against the pinned **0.1.38** on 2026-08-15, by running the real binary against a request-logging Streamable HTTP stub, or read from its installed dist with the file and line given. Nothing below is an inference from its README.

### Glossary, and why the package is named `@rembric/mcp-bridge`

- **"the bridge"** — `@rembric/mcp-bridge`, the published client-side piece: slug resolution, URL building, diagnostics, the advisory version check, bearer injection, the transport, and the recovery.
- **`rembric-bridge.mjs`** — a legacy on-disk launcher that existing opencode configs may still name; the measured opencode `config` hook replaces that entry in memory, so this change does not copy or maintain the file.

An earlier draft treated `rembric-bridge.mjs` as a live component. The zero-dependency package now owns the transport; the file is only legacy compatibility residue and is not part of the new install path.

"Proxy" is also the weaker word for what this is. A proxy forwards; this package resolves `.rembric`, builds the path-scoped URL, runs the advisory version check **and** transports. That composite entrypoint role is what "bridge" has always meant in this repository.

The decisive argument is vocabulary continuity: the specs already name this role "the bridge" across roughly twenty normative requirements, so putting the package under that name migrates them with their wording intact instead of committing the project to a bridge/proxy glossary forever. It also keeps the `[rembric-bridge]` stderr prefix true, which every troubleshooting doc and the e2e walkthrough already grep for.

**Rejected: `@rembric/mcp-bridge`** — too vague; it names the protocol, not the thing. **Rejected: `@rembric/mcp-bridge`** — does not say what it bridges. Both stay rejected; the naming is closed.

### The verified inventory of what the third-party delegate imposes

This change is usually framed as "add a 404 retry". The reason it is worth owning the whole client side is that seven separate costs all trace to the same root — the transport is somebody else's program — and six of them **disappear** rather than needing new code.

1. **`--allow-http` on every spawn.** `mcp-remote` refuses plain HTTP by default; LAN self-hosting over `http://192.168.x.y:8787` is this project's canonical deployment, so the bridge passes the flag unconditionally (`rembric-bridge.mjs:131-141`) and `claude-code-plugin/spec.md:36` normatively requires it. With our own engine there is no flag and no clause: `fetch` does not care about the scheme.
2. **A third-party pin plus a diff-audit on every bump.** `claude-code-plugin/spec.md:279-281` requires an exact `mcp-remote@<x.y.z>` and deliberate bumps (hardened in `460c407`). The exact-pin discipline is right and is kept verbatim; what goes away is reading someone else's changelog to decide whether a bump is safe.
3. **Headers frozen at process spawn — this already killed a shipped mechanism.** `openspec/changes/archive/2026-07-12-fix-cross-session-misattribution/design.md:30` records, verbatim, that a per-connection bridge-instance-id design (a random id in a local file, forwarded as `X-Rembric-Bridge-Instance`, persisted on a new `agent_sessions.bridge_instance_id` column — implemented and e2e-tested in `ea71092`, reverted in `d1ff2c9`) had to route around the fact that "`mcp-remote`'s `--header` values are frozen at process spawn — verified by reading its source". A bridge we own has no such constraint.
4. **`clientInfo` rewriting — and the archived record of it is out of date, so state the measured form.** The same design note (`:38`) records that `mcp-remote` "always declares itself as `{name: 'mcp-remote', version}` regardless of the actual upstream host", making Claude Code, Codex and opencode server-side indistinguishable. **Measured at the pinned 0.1.38 the behaviour is a rewrite, not a replacement**: a host sending `{"name":"probe-host","version":"9.9.9"}` produces a frame carrying `{"name":"probe-host (via mcp-remote 0.1.37)","version":"9.9.9"}`. The host name survives as a prefix — and the suffix reports **0.1.37 while running 0.1.38**, i.e. the identity it appends is itself wrong. The archived conclusion is weakened but not overturned: the field is not the host's name, no exact match against it is safe, and it cannot be trusted to report the transport's own version either. The correction matters because a future change reasoning from that note would assume a stricter failure than exists.
5. **OAuth machinery on every session start, for a flow this path never uses.** Server-side request log, in order, before a single MCP frame: `GET /mcp`, `GET /.well-known/oauth-protected-resource/mcp`, `GET /.well-known/oauth-protected-resource`, `GET /.well-known/oauth-authorization-server` — **four requests and 25 ms** on loopback against a stub that 404s each probe instantly. Its stderr additionally reports `Using automatically selected callback port: 45400`: a local OAuth callback listener bound on every start.
6. **Its only mid-flight `404` semantics point somewhere else entirely.** The dist has exactly two `404` paths: OAuth metadata discovery (`chunk-65X3S4HB.js:20148,20226`) and an initial-connection transport-strategy fallback to legacy SSE, guarded by `shouldAttemptFallback` (`:20529`). A session-terminated `404` matches neither — a plausible mechanism for the measured silence, and why no configuration change could have fixed it.
7. **The wrapper itself.** `rembric-bridge.mjs` is 159 lines, of which the URL building its spec claims as its whole purpose is a minority. `:135`–`:158` is `spawn` + `stdio: 'inherit'` + `child.on('error')` + exit-code forwarding + terminating-signal re-raising: pure cost of hosting a foreign program, and one extra node process per session (`node(bridge) → npx → node(mcp-remote)`).

### Published requirements that bind this change before it writes a line of code

1. **`claude-code-plugin/spec.md:26`–`:31`** — the MCP server entry SHALL use `command: "node"` with `args: ["${CLAUDE_PLUGIN_ROOT}/bin/rembric-bridge.mjs"]`, and the plugin SHALL NOT use a direct `type: "http"` entry. D5 modifies the first and leaves the second true for a different reason.
2. **`claude-code-plugin/spec.md:33`–`:42`** — the bridge contract end to end, including "purely a URL-building entrypoint". D4 re-homes it.
3. **`codex-distribution/spec.md:88`–`:128`** — `command: "node"`, `args: ["./bin/rembric-bridge.mjs"]`, `cwd: "."`, `env_vars: [REMBRIC_SERVER_URL, REMBRIC_API_TOKEN, PWD]`, and the recorded reason: Codex `env_clear()`s, so there is no implicit inheritance. D14 is the risk this creates.
4. **`opencode-plugin/spec.md:38`–`:56`** — `apps/plugin/bin/rembric-dotenv.mjs` is normatively "the only place where the slug regex … and the dotenv parser live in JS/TS form across the entire repository". D8 moves the location, not the property.
5. **`hermes-agent-plugin/spec.md:423`–`:434`** — the slug cascade: `.rembric` first, then `REMBRIC_PROJECT_SLUG`, validated against the slug regex, no parent-directory walk. D9 adopts the same precedence in the bridge so the two do not diverge.
6. **`supply-chain-hygiene/spec.md:279`** — zero runtime dependencies is the default and any entry must be justified in the proposal that introduces it. D12 is that justification, with the cost measured.
7. **`open-source-distribution/spec.md:271,273`** — `extra-files` carriers enumerated exhaustively, "exactly two packages" normative. D11 keeps both true.
8. **`pi-plugin/spec.md:23,448-450`** — why an npm-published artifact lives inside `apps/plugin/`, and the cost `.pi-plugin/` accepted **because it declares no runtime dependency**. D10 takes the location and refuses the cost.

### One finding shapes the phase order rather than any single decision

`evict-stale-transport-state` (#328) built roughly 1600 lines behind a merge gate its own design named as unverifiable from inside the repo, measured the gate last, failed it, and was reverted whole (`ba555da`). The two salvageable pieces — the server's `404` (`c2affef`) and the Pi client's retry-once (`ea09360`) — survived only because they were independently defensible. This change inverts that order: the gate is phase 1, it is a throwaway prototype of the **engine only**, and failing it abandons the proposal with nothing to revert. The integration work (D4–D9) starts only after the gate passes.

## Goals / Non-Goals

**Goals**

- A tool call that today hangs after a server restart instead succeeds, transparently, with no user action.
- The server records the host's **real** `clientInfo`.
- One client-side piece, shaped as it would have been designed from scratch: no wrapper whose only justification was a foreign engine.
- Every cost in the inventory above that can be deleted is deleted, not carried forward.
- The recovery behaviour is a standing CI test over the real stdio→bridge→server chain.
- Existing installs keep working across the transition without the user doing anything.

**Non-Goals**

- **OAuth in any form.** Bearer-only. `mcp-remote`'s largest subsystem is the one we most want gone; re-adding it by increments is the failure mode this non-goal exists to block.
- **A general-purpose `mcp-remote` replacement.** The compatibility matrix is this server × the stdio clients this repo ships. No SSE-transport fallback, no legacy-endpoint probing, no transport-strategy flags.
- **Any server change.** The `404` at `http.ts:386-392` is already correct and already shipped.
- **Server-side use of the improved `clientInfo`.** This change makes it accurate; consuming it (D17) is another change.
- **Moving `rembric-plugin-core.mjs`.** Only the dotenv module moves, because only slug resolution becomes the bridge's job. Session-protocol logic must stay out of a transport (D8).
- **Maintaining a launcher for every opencode install.** The measured config hook handles existing launcher entries in memory, so the installer no longer copies or removes a launcher.
- **Retiring `mcp-remote` from the ecosystem.** The upstream PR is goodwill and an exit path, not a dependency of this change.

---

## Decisions

### D1 — Phase 1 is a throwaway prototype of the engine, behind an explicit STOP

A ~100-line prototype (the two SDK transports piped, plus the `404` wrapper) is driven by a **real** Claude Code against `pnpm run dev:docker:up`, and must clear four arms: roots discovery resolving a project; a normal tool call; **a server restart mid-session followed by a tool call that recovers via re-init**; and the server observing the host's real `clientInfo.name`. The third arm is the one that hangs today, so it doubles as the failing-repro-first.

The gate tests the **engine**, deliberately — not slug resolution, not the manifests, not the launcher. Those are integration work with known mechanics; what is unknown is whether the SDK's transports can be piped this way at all while preserving `clientInfo`, and whether recovery actually works against a real host.

If any arm fails, the proposal is abandoned and nothing further is built. This is the direct lesson of #328 (`ba555da`), whose merge gate was measured after ~1600 lines existed. A prototype in the scratchpad has no sunk cost — and it must live in the scratchpad, not under `apps/server/src/`, because a probe file there reds `tsc` project-wide.

**Alternative rejected: prototype with a stub server instead of the real stack.** The stub already proved the _negative_ (mcp-remote goes silent). What is unproven is the _positive_ against a real host and a real server — roots discovery, path scoping, and a genuine restart.

### D2 — A raw message pipe, not an SDK `Client`+`Server` pair

The obvious composition — instantiate the SDK's `Client` against the remote and its `Server` against stdio, and bridge the two — is what `mcp-remote` does, and it is why `clientInfo` gets stamped with the bridge's identity: an SDK `Client` performs its own `initialize` and declares itself. The requirement that the server sees the host's real `clientInfo` therefore selects the architecture: the bridge pipes messages, letting the host's `initialize` through **verbatim**, and owns session state only to the extent the recovery needs (the current `mcp-session-id` and the last `initialize` frame).

With the SDK this was a hypothesis about its transport classes, and a named STOP arm rather than an assumption. **Superseded by D2b: with no SDK there is no second handshake at all**, so verbatim passthrough is a property of the architecture rather than something to verify. Measured: a manual pipe through `measurements/prototype-zerodep.mjs` delivered `clientInfo=zerodep-probe@7.7` to the server unchanged (`measurements/gate-arms12-zerodep.log`).

### D2b — Zero runtime dependencies, not one exact-pinned SDK

D2 selected a message pipe; this decides what implements it. The SDK was specified first and dropped on measurement: it installs 93 packages / 25 MB against `mcp-remote`'s 80 / 7.0 MB (`npm install --ignore-scripts`, clean directory, 2026-08-15), because `express`, `hono`, `cors`, `jose`, `eventsource` and `express-rate-limit` are `dependencies` rather than peers. A replacement that installs more than the thing it replaces defeats part of its own purpose, and none of that surface is reachable from a stdio proxy.

What must be owned instead is smaller than it first appears — newline-delimited stdio framing, `fetch` with a bearer header, and `data:` line parsing — because this server offers no resumable streams (no `Last-Event-ID`) and the bridge speaks no OAuth. `.pi-plugin/index.ts` already ships that surface with `dependencies: {}`.

**Alternative rejected: bundle the SDK to report zero dependencies.** That is vendoring, and it hides the version from a consumer's advisory tooling — the exact blind spot that made confirming `mcp-remote`'s `404` behaviour a matter of reading `chunk-65X3S4HB.js`. First-party code has no upstream version for tooling to miss, so it does not inherit that objection.

**The risk this decision takes on** is that a future protocol revision must be implemented by hand rather than inherited from an SDK upgrade. Bounded by the same reasoning: the `2026-07-28` revision removes sessions, the GET stream and server-initiated requests, which makes a proxy strictly simpler, not harder.

**Alternative rejected: substitute our own `clientInfo` naming the real host**, derived from an env var the manifest sets. It would work, and it is worse: it is a second place where client identity is authored, it drifts from what the host actually declared, and it re-creates the class of defect the measurement above exposed.

### D3 — One piece, because the second one had no independent reason

The bridge is not a layer; it is a wrapper. Its spec calls it "purely a URL-building entrypoint" (`:37`) and its own code contradicts that in the only way a wrapper can: roughly half of it is process plumbing for the program it wraps. Once we own the engine, keeping the split would mean maintaining `spawn`/`stdio`/`error`/`exit`/`signal` handling and an extra node process per session to achieve nothing a single process cannot.

The test is counterfactual and it is the whole argument: **if the engine had always been ours, nobody would have written a wrapper to build a URL for it.** So the wrapper goes, and what survives (D6) survives for a compatibility reason that is explicitly not a design reason.

**Alternative rejected: keep the bridge as the "stable entrypoint" and let the bridge stay a pure transport.** It sounds conservative and it is not: it preserves an extra process, an extra failure surface, and a second place where the URL and the environment contract are authored — a split that would have to be explained forever, since its historical cause would no longer be visible in the code.

### D4 — The bridge contract is re-homed, not deleted

Every behaviour `claude-code-plugin/spec.md:33-42` requires still exists; it just belongs to a different component. The delta **removes** the bridge-contract section from `claude-code-plugin` with an explicit migration pointer, and `mcp-bridge` restates each behaviour as its own requirement: the `CLAUDE_PROJECT_DIR > PWD > process.cwd()` chain with empty-string skipping, `.rembric` parsing, slug validation, the path-scoped URL, the fall-back-never-abort rule, the one-line stderr diagnostic naming the resolution source, and the missing-env fail-fast.

Two behaviours are **not** carried over, and the delta says so rather than letting them lapse silently: the child-process machinery (nothing is spawned any more) and `--allow-http` (D7).

### D5 — Client manifests spawn `npx` directly, and the pin is a carrier

`.claude-plugin/mcp.json` becomes `command: "npx"`, `args: ["-y", "@rembric/mcp-bridge@<pin>"]`, with the same `env` block sourcing `${user_config.server_url}` and `${user_config.api_token}`. `.codex-plugin/mcp.json` becomes the same command with its existing `cwd: "."` and `env_vars` list — `PWD` stays essential, because Codex's spawn semantics put `process.cwd()` at the plugin cache dir, which is not the user's project.

Both manifests ship inside the plugin tree, so a plugin update replaces them atomically with the pin they name. This is what makes the manifest form safe: the pin and the package version are written by the same release.

`claude-code-plugin/spec.md:31`'s prohibition on a direct `type: "http"` entry stays true, and its stated reason ("the bridge mediates traffic so that the URL can be path-scoped") is restated in terms of the bridge rather than deleted — path scoping per directory is still why a stdio child exists at all.

### D6 — opencode upgrades legacy launchers in memory

The measured opencode plugin API provides a `config` hook. When `mcp.rembric` exists, the hook replaces only its in-memory `command` with `['npx', '-y', '@rembric/mcp-bridge@<plugin version>']` and preserves the environment and unrelated settings. An existing `opencode.json` that names `~/.config/rembric/bin/rembric-bridge.mjs` therefore upgrades without a file rewrite or a copied launcher.

Fresh installs still print the pinned npx snippet; the installer never creates or edits `opencode.json`. A legacy launcher file is user-owned compatibility residue, not a release carrier, and is not copied or removed by this change.

### D7 — Plain HTTP with no flag; no arguments at all

The bridge takes **no** command-line arguments. `REMBRIC_SERVER_URL`, `REMBRIC_API_TOKEN` and the optional `REMBRIC_PROJECT_SLUG` all arrive through the environment, which every host already supplies. This closes the local-disclosure hole in the current design — `rembric-bridge.mjs:142-143` puts the token in the child's argument vector, readable via `ps` and `/proc/<pid>/cmdline` — and it removes the argument-parsing surface entirely.

There is no scheme check and no `--allow-http`: refusing `http://` for a LAN deployment that is this project's canonical shape would be wrong, and a flag whose value never varies is not a control.

**Alternative rejected: accept an optional positional URL override.** Nothing needs it once the environment carries the base URL and the slug, and an override would be a second way to express the endpoint, diverging from the first the moment one of them changes.

### D8 — `rembric-dotenv.mjs` moves into the package; `rembric-plugin-core.mjs` does not

Slug resolution becomes the bridge's job, so the module must ship in the bridge's tarball. Moving it keeps the property `opencode-plugin/spec.md:38-56` actually cares about — **exactly one** JS/TS implementation of the dotenv parser and the slug regex — and changes only where that one implementation lives. The opencode plugin and the Pi extension import it from the new path; bash (`_api.sh`) and Python (Hermes) keep their own under the standing cross-language rule.

`rembric-plugin-core.mjs` stays at `apps/plugin/bin/`. It is session-protocol logic — nudges, redaction, the session HTTP client — and the bridge must not touch any of it. A transport that imported the session protocol would be a transport that has opinions about payloads, which is the property D16 depends on.

**Consequence to plan for, not discover:** three tracked places name the old path as a literal — `invariants.test.ts:814` (`REMBRIC_DOTENV_MJS`, asserted present in the scanned set at `:914`), `scripts/pi-package.mjs`'s `PACKABLE_IMPORT` regex `^\.{1,2}\/bin\/([\w.-]+\.mjs)$`, and `.opencode-plugin/install.sh`'s fetch URL plus its `sed` rewrite and `grep -qF` guard. The last is the dangerous one: the installer's guard checks exactly one destination literal, so a missed rewrite makes it **exit 0 having written a plugin that cannot load**, and the install test suite stays green because nothing in it ever loads the installed plugin.

### D9 — Slug precedence: `.rembric`, then `REMBRIC_PROJECT_SLUG`, then path-less

With no URL argument, a client that has no per-directory `.rembric` needs some way to express a default project — and Hermes is exactly that client: its `requires_env` already collects `REMBRIC_PROJECT_SLUG` and its cascade (`hermes-agent-plugin/spec.md:423-434`) already fixes the precedence as `.rembric` first, env var second, with the slug regex validating each candidate and a non-matching candidate falling through rather than aborting.

The bridge adopts that same precedence rather than inventing a second one. This is an addition relative to today's bridge, which reads only `.rembric`; it is recorded as an addition, with its reason, rather than slipped in. No parent-directory walk: only the resolved project directory is checked, matching the existing rule.

### D10 — `apps/plugin/mcp-bridge/`, and a real workspace member

**Location** is forced: release-please attributes a release to a component by the paths of the commits under that component's `path`, so a package outside `apps/plugin/` would never _cause_ a `plugin` release and its version carrier would move only when something unrelated did — the lock-step guarantee `open-source-distribution/spec.md:273` exists to provide.

**Workspace membership diverges from the `.pi-plugin/` precedent, deliberately.** `pi-plugin/spec.md:23` accepts being outside `pnpm-workspace.yaml::packages` — unlinted, unreached by `pnpm -r` — and the sentence that makes it acceptable is that the extension "SHALL therefore declare **no runtime dependencies**". This package deliberately keeps zero runtime dependencies, and its recovery logic needs executable tests with mutation gates. The Docker image is unaffected — both install lines filter with `--filter @rembric/server...` (`apps/server/Dockerfile:26,95`).

**The directory name is load-bearing in one non-obvious way.** `invariants.test.ts:901` derives "is this a client" from the pattern `^apps/plugin/\.[\w-]+-plugin/`, and every file matching it must import `rembric-plugin-core.mjs`. The bridge must not — so the directory must **not** be named `.<something>-plugin/`. `mcp-bridge/` satisfies that and reads correctly next to `bin/`, `hooks/`, `scripts/`.

### D11 — Four pin carriers, one component, and the tag-versus-publish window accepted

The pin appears in `.claude-plugin/mcp.json`, `.codex-plugin/mcp.json`, the opencode hook and printed snippet, and — as the package's own `version` — `mcp-bridge/package.json`. The executable invariant covers the non-JSON hook surface. `.release-please-manifest.json` keeps exactly two entries; the bridge is a carrier, exactly as `@rembric/pi` is, and the `publish-npm` job gains a second publish step under the same gate and OIDC identity.

**Accepted consequence, stated rather than hidden:** merging the release PR pushes the bumped pin to `main` _before_ the `publish-npm` job has published that version, so for one workflow run `main` names a version the registry does not yet have. The exposure is bounded to that window and to users installing from `main` inside it; the failure is loud (`npx` cannot resolve) rather than silent. **Alternative rejected: pin N−1**, always one release behind — it removes the window and permanently guarantees the code we ship is not the code we just released.

### D12 — SUPERSEDED by D2b: no runtime dependencies

This decision specified `@modelcontextprotocol/sdk` as the single exact-pinned runtime dependency, justified as the protocol's reference implementation that this repo already ships. It was reversed on measurement — the SDK installs 93 packages / 25 MB against `mcp-remote`'s 80 / 7.0 MB, so the replacement would have installed more than the delegate it removes. See D2b for the decision that stands, including why hand-rolling is not the bundling alternative this decision had correctly rejected.

Kept as a heading rather than deleted so the `supply-chain-hygiene` exception it once claimed is visibly withdrawn.

### D13 — Recovery: 404 only, once, handshake only, and nothing else replayed

On an HTTP `404` to a request that carried an `mcp-session-id`: drop the id, send a fresh `InitializeRequest` plus `notifications/initialized`, retry the original request once. The semantics and their justification come from `ea09360`, which shipped them for the Pi client with green-then-red mutation proofs:

- **`404` alone.** `401`/`403`/`429`/`5xx` keep failing unchanged. A `401` retried is a credential problem retried; a `429` retried is the rate limit ignored.
- **Never a loop.** A second failure propagates. A bounded loop and an unbounded one have the same failure signature under a server that is genuinely gone; the bounded one only delays it.
- **Retrying a write is safe** because the refusal happens at the transport boundary (`http.ts:386-392`) before any tool handler runs, so the original call cannot have been half-applied. This property belongs to _our_ server and is stated as the reason so a future reader re-checks it rather than generalising it.
- **Only the handshake is replayed.** Prior tool calls are never re-sent.
- **`initialize` itself carries no session id**, so a `404` to it is not a recovery case and cannot recurse.

**What is deliberately not restored:** a `project.use` pin made during the session is server-side session state, and the re-initialized session does not have it. Path-scoped connections (`/mcp/<slug>`, what the bridge builds whenever a slug resolves) are unaffected because the scope is re-derived from the unchanged URL. A path-less `/mcp` connection re-resolves through roots discovery, and a `project.use` pin is lost. Silently restoring it would mean replaying tool calls, which this decision forbids for good reason — so the honest move is to specify the gap.

### D14 — Two mechanical unknowns gate the manifest switch, each with a fallback

Both are verified **before** the manifests are switched, because both fail in ways that are hard to see afterwards.

**(a) Can release-please write a pin embedded in a JSON `args` array?** Its `generic` updater is annotation-driven and JSON carries no comments; its JSON updaters write a key's value, not a substring inside an array element. If neither can rewrite `"@rembric/mcp-bridge@0.29.0"` in place, a pin that release-please cannot write is a pin that silently rots. **Fallbacks, in order:** (1) verify the pinned release-please-action's actual capability first; (2) if unsupported, add a CI assertion that every pin substring equals `apps/plugin/package.json::version`, converting silent rot into a red build; (3) if that is judged too manual, the manifests spawn a one-line in-plugin launcher carrying the pin as a JS constant — the annotation form `.opencode-plugin/plugin.ts` already uses. Fallback 3 reintroduces a tiny wrapper for Claude and Codex and nothing else; it is recorded so the integration is not abandoned wholesale if the mechanism does not cooperate.

**(b) Does `npx` resolve under Codex's spawn semantics?** `codex-distribution/spec.md:90` records that Codex `env_clear()`s and that `env_vars` is the only channel, with no implicit inheritance. `npx` needs a resolvable `PATH` both to be found and to spawn `node` itself. `command: "node"` works today; that is not evidence that `command: "npx"` will. **Fallback:** add `PATH` to the `env_vars` list — a minimal, documented change — and if that is insufficient, fallback 3 above applies to Codex alone.

### D15 — The advisory version check moves, unchanged, and stays a single implementation

One fire-and-forget `GET /healthz`, warn-never-block, silent on any failure, floor bumped with plugin releases — the behaviour `rembric-bridge.mjs:85-124` implements today, now living in the bridge because that is where the client side lives. It remains exactly one implementation: nothing else issues it, and the opencode config hook does not.

The bridge imposes **no hard floor**. Against a server predating `c2affef` — which returned `400` for an unknown session id, the SDK's own response for an uninitialized pair — the recovery path never fires and behaviour degrades to exactly today's, never worse.

**Skew, in context.** Plugin↔server skew is pre-existing and by design: two independent release tracks (`open-source-distribution/spec.md:266-275`). `mcp-remote` was a **third** skew axis outside both tracks — its behaviour changed on its own schedule, and #106 is what that looks like. Folding the transport into the plugin track via the pin collapses three axes into two. What keeps thin-transport skew safe at all is MCP's runtime negotiation — tools discovered by `tools/list`, protocol version agreed in `initialize` — and the bridge staying transport-only is what preserves that property.

### D16 — The A/B becomes a standing test, hermetic and offline

With the source in-repo, the whole chain — a stdio client, the bridge, and an HTTP server that terminates sessions — runs in-process under vitest with no `npx` and no network. The 2026-08-15 experiment therefore becomes a permanent regression test, with the control arm (a `401` that must **not** trigger re-init) in the same file. Each guard is proved with `scripts/mutate.mjs`: making the retry unconditional on status must red the `401` arm, and turning the retry into a loop must red the second-failure arm — the same two gates `ea09360` used and recorded.

The real-host arms (D1) stay manual and are recorded with their provenance in `tasks.md`; vitest can prove the bridge's behaviour but not that a real host drives it that way.

### D17 — Follow-ups are recorded here and built nowhere

Each becomes materially cheaper once the bridge exists, and each is load-bearing enough to need its own OpenSpec change. **None is in scope.**

- **Server-side client disambiguation from the now-exact `clientInfo`.** Would revisit `findActiveForTransport`'s deliberate give-up-under-ambiguity rule (`agent-sessions-repository.ts:144-154`) and the misattribution family settled by `archive/2026-07-12-fix-cross-session-misattribution/`, and would make that change's reverted bridge-instance-id mechanism (`ea71092`/`d1ff2c9`) permanently unnecessary. Touches scope and session attachment — both load-bearing.
- **A bridge-answered `roots/list` for hosts that do not advertise the roots capability.** Would resolve the unknown recorded in #329 for the stdio clients and improve first-run UX, since path-less `/mcp` could resolve correctly without a `.rembric` file. It also means the bridge _answering_ a request rather than forwarding it — a genuine widening of its charter that forfeits part of D15's argument, and must be made on its own terms.
- **Removing stale opencode launcher files.** Deferred as user cleanup; the config hook means no repository signal is needed to stop using them.
- **Re-opening #328's transport eviction.** This change fixes the client half of its blocker; the decision to evict again is separate.

### D18 — Windows is unverified, and says so

There is no Windows CI in this repo. The package adds no platform-specific code of its own, but "should work" is not a measurement. The compatibility matrix records Windows as unverified with that reason, and reports are triaged reactively. Claiming coverage we have not run is the failure mode this repo's evidence rule exists to prevent.

## Risks / Trade-offs

- **[Risk] release-please cannot write a pin embedded in a JSON `args` array** (D14a) → **Mitigation**: the manifests use release-please JSON carriers and the executable pin invariant catches drift; the opencode hook carries the same version alongside its package version.
- **[Risk] `npx` does not resolve under Codex's `env_clear()` spawn** (D14b) → **Mitigation**: verified before the switch; forward `PATH` in `env_vars` if the measured host requires it. There is no launcher fallback in this change.
- **[Risk] The dotenv move silently breaks the opencode installer** (D8) → **Mitigation**: `install.sh`'s `sed` rewrite and its `grep -qF` guard are updated in the **same commit** as the move, and an install round-trip that actually loads the installed plugin is part of e2e. The known failure mode is exit 0 with an unloadable plugin and a green test suite.
- **[Risk] An existing opencode install breaks on upgrade** → **Mitigation**: the measured config hook replaces the legacy command in memory; a regression test exercises an existing launcher config while asserting the file remains byte-identical.
- **[Risk] The prototype clears its arms but a client not driven at the gate behaves differently.** Codex CLI cannot be safely driven: an authenticated Codex reaches the _real_ production Rembric through an account-level connector regardless of `CODEX_HOME`/env isolation (incident recorded 2026-08-10). → **Mitigation**: Claude Code and opencode are driven for real; Codex is recorded as unverified **with that reason stated**. Note this risk is larger than in the two-piece design: Codex's manifest changes, so it is no longer true that Codex inherits an untouched shared file.
- **[Risk] Verbatim `initialize` passthrough is not achievable by the bridge engine** → **Mitigation**: the D1 gate arm is measured before the package is treated as complete. Failing it stops the change rather than triggering a workaround that re-authors `clientInfo`.
- **[Trade-off] The wire protocol is owned rather than inherited** (D2b) → **Accepted because** the surface is bounded (stdio framing, `fetch`, `data:` parsing — no resumability, no OAuth, no server half), `.pi-plugin/` already carries it with `dependencies: {}`, and the only mechanism without precedent there was measured working at the gate. The alternatives were a dependency that installs 93 packages / 25 MB against the replaced delegate's 80 / 7.0 MB, or bundling, which destroys the consumer's view of the version. Install weight drops to one package, and four fewer HTTP requests plus one fewer process per session are measured at the gate.
- **[Trade-off] The repo now publishes and maintains the whole client side.** → **Accepted because** it is already maintaining the _consequences_ of one it does not control: a hang after every restart, four wasted requests and an OAuth callback port per session start, a rewritten `clientInfo`, frozen headers that killed a shipped mechanism, and an upstream issue unanswered for 14 months. The upstream PR keeps the retirement path open.
- **[Trade-off] Existing opencode configs can retain a stale launcher path.** → **Accepted because** the measured config hook upgrades the entry in memory while preserving the user's file and avoiding a config migration.
- **[Risk] `main` briefly pins a version the registry does not yet have** (D11) → **Mitigation**: one workflow run, loud failure, and the `publish-npm` job is release-blocking. The first release after this change lands is verified end to end by a task.
- **[Risk] A `project.use` pin is lost across recovery on path-less connections** (D13) → **Mitigation**: specified rather than hidden, and it does not affect the default shape (a resolved slug → `/mcp/<slug>` → scope re-derived from the URL).
- **[Risk] The bridge's sources fall under the shared-helper invariant scan** (`invariants.test.ts:878-986`, whose git pathspec `apps/plugin/*.mjs` matches across directories) and collide on a name `rembric-plugin-core.mjs` owns → **Mitigation**: `diag` and `truncate` are the realistic collisions for a program that writes stderr diagnostics; the delta puts the bridge in scope by contract, so a collision is a red build rather than a silent second copy.
- **[Risk] Windows regressions surface only from user reports** (D18) → **Mitigation**: stated as a known limitation in the compatibility matrix and the package README, not implied away.

## Migration Plan

There is no data migration, no schema change, and no derived-data invalidation. The rollout is a plugin release, and it differs by client:

1. **Claude Code / Codex CLI** — the manifest ships with the plugin, so `<client> plugin update` replaces `mcp.json` and the pin together. The next session start spawns `npx -y @rembric/mcp-bridge@<pin>`; `npx` downloads it once and caches it. No configuration change, no re-authentication.
2. **opencode, existing install** — `opencode.json` may still name `~/.config/rembric/bin/rembric-bridge.mjs`; the plugin's config hook replaces that command in memory with the exact npx package command. The file is untouched.
3. **opencode, new install** — `install.sh` prints the exact npx form and never creates `opencode.json`; the user pastes it when desired.
4. **Hermes** — the config block is documented rather than shipped, so a one-line edit to `~/.hermes/config.yaml` is required. The old block keeps working (badly) until they change it; the README's block is what changes in this repo.
5. **A user on the old plugin** keeps spawning `mcp-remote@0.1.38`. Nothing breaks and nothing improves.

**Rollback** is a plugin release reverting the manifests and the bridge. The published `@rembric/mcp-bridge` versions stay on the registry — a publish is not revertible, which is why `supply-chain-hygiene`'s outbound half is the stricter one — but nothing consumes them once the pins point elsewhere.

## Open Questions

1. **Does the config hook replace every existing `mcp.rembric` command?** Default taken: **yes**. The measured compatibility requirement is keyed by the named server entry, and preserving its environment and other fields avoids making assumptions about how the old launcher was configured.
2. **Should the bridge send an explicit `DELETE` on shutdown to terminate its session server-side?** The spec permits it and it would let the server reclaim a transport promptly — #328's whole subject. Default taken: **not in this change.** It is a behaviour change on the server's session lifecycle, it interacts with an issue already reverted once, and it would put a second unproven mechanism behind the same gate.
3. **RESOLVED by D2b: no SDK version is pinned, because there is no SDK dependency.** This question asked which exact `@modelcontextprotocol/sdk` version to pin (the lockfile resolved `1.29.0`, the measurements used `1.30.0`). It is moot: the package declares an empty `dependencies` object. Kept as a numbered entry so the question is visibly answered rather than silently dropped.

4. **What happens to legacy launcher files?** They are left untouched as user-owned files. No install or uninstall action depends on them after the config hook is loaded.
