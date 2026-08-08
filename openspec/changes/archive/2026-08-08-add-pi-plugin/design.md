# Design — add the Pi harness as a fifth client

## Context

`proposal.md` carries the motivation and the headline measurements. This document records the decisions by number (D1–D14), the constraints that bound them, and the questions deliberately left open for the owner.

Everything asserted here about Pi was measured against **Pi 0.84.1** and against this server's real MCP surface started in-process over a temporary SQLite file. No claim below is an inference from reading the harness's source or documentation unless it is labelled as one.

One arm was measured against a **real model provider** rather than a stub — an OAuth-authenticated Codex provider, model `gpt-5.6-terra`. It is the only measurement here that costs the owner money, it produced the one hard constraint this design has to obey, and D8 is its result. Nothing else in this document depends on repeating it.

**Four published requirements bound this change before it writes a line of code.**

1. **`openspec/specs/open-source-distribution/spec.md:48`**, verbatim: "References to \"npm package\", \"operator CLI\", or any other deprecated install mechanism SHALL NOT appear in the README." Written when the only npm artifact was a retired operator CLI. Documenting `pi install npm:@rembric/pi` in the README puts a live npm package name in the README, so the requirement must be modified rather than read around. D9 is the answer.
2. **`open-source-distribution/spec.md:243`–`:252`**: "**exactly two packages**", "no `node-workspace`, `linked-versions`, or other grouping plugin", "The `.release-please-manifest.json` SHALL declare exactly two entries". These sentences stay verbatim true after this change and D3 explains why; nothing here reopens `unify-plugin-release-track`.
3. **`plugin-session-protocol/spec.md:193`** (nudge text byte-identical across clients) and **`:351`** (`<private>` redaction with identical observable semantics in every client). These are the two requirements a fifth client can silently violate, and one of them is a privacy contract. D5 and D6 answer them structurally rather than by discipline.
4. **`supply-chain-hygiene/spec.md:5`**: the capability's Purpose is "what a third-party package is allowed to do to this repo" — inbound only. There is no requirement of any kind covering what **we** are allowed to publish. D11 writes it.

**One finding shapes the phase order rather than any single decision.** The refactor this change needs — extracting the client-agnostic half of `apps/plugin/.opencode-plugin/plugin.ts` — moves exactly the boundaries the existing test suite does not assert. Measured: `apps/plugin/.opencode-plugin/plugin.test.ts` is 714 lines and contains **no assertion at all** about the registration body's `agent` or `cwd`, the `prt_` id scheme, the `server.instance.disposed` flush, `session.deleted` eviction, the `Bearer` header, `body.title`, or the no-credentials path. And `grep -c stripPrivateTags apps/server/src/test/invariants.test.ts` → **0**: the single-implementation invariant covers `parseDotenv` and `SLUG_RE` only, over a hard-coded two-file list. So the extraction would be performed with its blast radius unasserted. D1 makes the safety net a phase of its own, before any code moves.

## Goals / Non-Goals

**Goals**

- A Pi user installs Rembric with one command, discovers it the way Pi users discover packages, and gets the same memory tools, the same slash commands, the same nudges and the same redaction as every other client.
- The tool surface is described in **exactly one place** — the server. The plugin enumerates nothing.
- The shared session-protocol logic exists once, and a second copy **fails CI** rather than being caught in review.
- Publishing our own package acquires a written policy in the same change that first needs one.
- The extraction of shared code is protected by tests that fail without it, proved with `scripts/mutate.mjs`.

**Non-Goals**

- **Any server-side change.** `sessions.agent` is `text('agent').notNull()` with no enum and no CHECK (`apps/server/src/db/schema/agent-sessions.ts:51`); `'pi'` is already legal. No migration, no schema change, no new MCP tool.
- **Extracting the shared plugin core into `packages/*`.** A real workspace package is the right long-term home for `rembric-plugin-core`, and this change deliberately does not go there (D2): it would make the install scripts' fetch-and-rewrite model, which every non-marketplace client depends on, a package-resolution problem instead.
- **Renaming any MCP tool.** The provider constraint measured in D8 is closed inside this client — registered names are mapped, `tools/call` carries the canonical name — so the server's dotted names stay exactly as four working clients already use them. A wire-visible rename to serve a fifth client is not needed and is rejected.
- **Measuring every model provider.** One real provider was measured and its constraint is now a design requirement rather than a hypothesis (D8). The others — Anthropic, Gemini, OpenAI in strict mode — are unmeasured, and the policy is to measure the provider that fails rather than to sanitise ahead of evidence (OQ1).
- **Publishing anything other than `@rembric/pi`.** The server, the plugin tree and the other four clients keep their existing distribution unchanged.
- **Claiming the `@rembric` npm organisation.** Operational prerequisite for the owner (OQ4), not a task in this change.

---

## Decisions

### D1 — The safety net is phase 1, before a single line of code moves

The extraction (phase 2) turns seven behaviours into parameters or shared code: the registration body's `agent`, the registration body's `cwd`, the `prt_` id scheme, the dispose flush, `session.deleted` eviction, the `Bearer` header, and `body.title`. **Measured: `plugin.test.ts`'s 714 lines assert none of them.** A refactor across an unasserted boundary is a refactor whose correctness nobody can check, and the failure mode is not a red test — it is a client silently registering sessions under the wrong `agent`, discovered weeks later in the dashboard.

Phase 1 therefore adds those assertions to the **pre-extraction** code, where they must pass, and each new guard is proved with `scripts/mutate.mjs` (weaken the condition, confirm the test naming it goes red). `CLAUDE.md` records that three tests in one session passed while proving nothing and only mutation found them; that is the reason this is a phase and not a bullet inside phase 2.

Phase 1 also widens the single-implementation invariant, because `stripPrivateTags` becomes the second cross-client helper and the current invariant would not notice a second copy. Two properties are required, not one: an **asserted count** (so a vacuous empty match cannot pass) and a **file list derived from `git grep`** rather than hard-coded (so a new client's file is scanned on the day it is added, not on the day someone remembers to add it to the list).

**Rejected: extract first, add tests after.** It reverses the only ordering in which the tests mean anything — a test written against post-extraction code asserts what the extraction did, not what the code did before it.

### D2 — The shared core lives at `apps/plugin/bin/rembric-plugin-core.mjs`, beside the existing shared module, and ships with a hand-written `.d.mts`

`apps/plugin/bin/rembric-dotenv.mjs` is already the precedent: a plain `.mjs` module in `bin/`, imported by the bridge with a relative path, fetched to an absolute installed path by each client's `install.sh` and rewritten in place by `sed`. The core follows it exactly, which means the install scripts change shape not at all — only count.

It is `.mjs` rather than `.ts` because `apps/plugin` has no build step and no typecheck: its `package.json` declares no `scripts` at all. A `.ts` core would need a compiler in the install path for two of the four existing clients. The companion `rembric-plugin-core.d.mts` is therefore hand-written and is the **only** thing giving the two TypeScript clients (opencode's `plugin.ts`, Pi's `index.ts`) type checking over the shared surface — including the property that makes D4 work, `agent` being required.

**Rejected: `packages/plugin-core/` as a workspace package.** It is the better long-term home and `CLAUDE.md` already stages `packages/*` for "future extractions". It is rejected **now** because every non-marketplace client installs by fetching individual files over HTTPS and rewriting import paths; a workspace package would either have to be published (a second npm artifact, in the change that is introducing the first) or flattened at install time anyway (the same fetch-and-rewrite, with an extra indirection). Recorded as the natural follow-up once more than one published package exists.

### D3 — `@rembric/pi` is a version carrier, not a release-please component

`release-please-config.json` gains one `extra-files` entry on the existing `apps/plugin` package: `".pi-plugin/package.json"`. Nothing else changes. `.release-please-manifest.json` keeps its two entries, `separate-pull-requests` stays `true`, and no grouping plugin is introduced — so `open-source-distribution/spec.md:243`–`:252` stay verbatim true.

This is not a stylistic preference. The six-component + `node-workspace` model was retired by `unify-plugin-release-track` **after** its cascade and anchor-tag fragility produced phantom release PRs. A per-client component for a fifth client would reintroduce the exact structure that failed, and the failure mode is a release process that opens PRs nobody asked for — the most expensive kind of regression in a repo where releases are otherwise fully automated.

The consequence, stated so nobody reads it as an accident: **a Pi-only fix bumps the shared plugin version, and so bumps the number printed by all four other clients.** The CHANGELOG, scoped by conventional commit, says what actually changed. That trade was already made and recorded for four clients; the fifth inherits it.

### D4 — `agent` is a required parameter of the shared core with no default

In the extracted core, the session-registration call takes `agent` as a mandatory argument. No default, no fallback, no `?? 'opencode'`.

A default here has an unusually bad failure shape. `sessions.agent` is written once, at registration, and memory is append-only: a session registered under the wrong agent is wrong **permanently**, across every dashboard view and every session query, with no repair verb. A missing argument must therefore be a compile error in the two typed clients (via the `.d.mts`) and an immediately-visible runtime failure in any untyped consumer — not a value that quietly works.

**Rejected: `agent = 'opencode'` as the default** to keep the opencode call site unchanged. It optimises one diff line against a class of silent, irreversible data corruption.

### D5 — Location is `apps/plugin/.pi-plugin/`, and the alternative's exact cost is recorded

Two candidate locations, and the deciding factor is a mechanism, not a taste.

**Chosen: `apps/plugin/.pi-plugin/`.** A path without a leading slash is prefixed with the component's own `path` (`apps/plugin`), so the version carrier is the plain string `".pi-plugin/package.json"` — the same shape as the four entries already there, requiring no `type`, no `..`, and no behaviour that four releases have not already exercised. Path resolution is not, however, what decides the location — release attribution is, and that is the argument below.

**Rejected: `packages/pi/` — and not because the carrier could not be written from there, which would be false.** Every `extra-files` path passes through `addPath` (`src/strategies/base.ts:758`–`:774` of `release-please@17.6.0`, the version `googleapis/release-please-action@v5` pins in its lockfile), and a path with a **leading slash** takes the branch that strips the slashes and resolves the remainder against the **repo root** — so `"/packages/pi/package.json"` genuinely does point outside the component. Release-please's own `'updates extra files'` test covers that branch. It is real behaviour, and it is **undocumented**: neither `docs/customizing.md` nor `schemas/config.json` mentions it. What is genuinely impossible is escaping by **traversal**: the same function throws `illegal pathing characters in path` on any `..` segment, and has since 2022. So "cannot leave the component" is wrong; "cannot leave the component with `..`" is right.

The rejection rests on a different mechanism, and a stronger one: **release-please attributes a release to a component by the paths of the commits that fall under that component's `path`.** With the package at `packages/pi/`, a commit touching only `packages/pi/**` would not bump the `plugin` component at all. A leading-slash `extra-files` entry would still write the new version into that file whenever a release happened for some other reason — but the directory would never _cause_ a release. For a client whose version must move in lock-step with the other four, that breaks exactly the guarantee the location exists to preserve: the fifth client could change without any client's version moving. Under `apps/plugin/` the directory is inside the component's `path`, so a change to the fifth client produces a plugin release just as a change to any of the other four does. This attribution is a **mechanism derived from how release-please's manifest mode is designed to work — not something measured here**; the `addPath` behaviour above is what was read in the source.

**What `packages/pi/` would have bought, recorded so this can be reopened on evidence if the release model ever changes.** Gained there, absent here:

- A genuine workspace member. `pnpm-workspace.yaml:7` already declares `'packages/*'`; the directory exists today containing nothing but `packages/.gitkeep`, so the glob is live and empty.
- `pnpm -r run typecheck` (`package.json:15`) and `pnpm -r run test` (`package.json:18`) would reach it, and the former is what CI runs (`.github/workflows/ci.yml:113`).
- **ESLint would actually lint it.** Nothing in `eslint.config.js:8`–`:24` ignores `packages/**`, whereas `apps/plugin/*/**` (`eslint.config.js:17`) matches dot-directories: measured on the closest existing analogue, `npx eslint apps/plugin/.opencode-plugin/plugin.ts` reports `File ignored because of a matching ignore pattern`. So `.pi-plugin/` ships **unlinted**, in the same condition as the fourth client's TypeScript.

Required in exchange, which is why the win is not free:

- Its own `tsconfig.json`. There is no root `tsconfig.json` and no `apps/plugin/tsconfig.json` — `apps/server/tsconfig.json` is the only one. Measured: a `.ts` file placed under `packages/` fails ESLint with `was not found by the project service` until a tsconfig includes it, so the lint win is conditional on that file existing.
- Its own `vitest.config.ts` (`apps/server/vitest.config.ts` is likewise the only one).
- A line in `.github/workflows/ci.yml`. CI does **not** invoke the root `test` script: it runs `pnpm --filter @rembric/server run test:coverage` and the Hermes suite explicitly (`.github/workflows/ci.yml:125`–`:126`), so tests under `packages/*` would exist and never execute in CI until that job is edited.

**Cost accepted, and it is a real cost:** `apps/plugin/.pi-plugin/` matches neither glob in `pnpm-workspace.yaml` (`apps/*`, `packages/*`), so `pnpm install` does not link it and any `dependencies` it declares are not installed by the repo's own install. This is not a new condition — `apps/plugin/.claude-plugin/package.json` is in it today, and its `"@rembric/plugin": "workspace:*"` dependency is consequently dead letter. D7 (zero runtime dependencies) is what makes the cost harmless rather than merely tolerable.

### D6 — The extension speaks MCP itself and discovers tools at runtime

Pi has no MCP client — verbatim from its own documentation, `packages/coding-agent/docs/usage.md:303`: _"It intentionally does not include built-in MCP…"_. So `rembric-bridge.mjs`, whose entire job is to present a stdio MCP server to a host that already speaks MCP, has no consumer here.

The extension therefore holds a Streamable HTTP MCP client against `${REMBRIC_SERVER_URL}/mcp/<slug>` with `Authorization: Bearer`, calls `tools/list`, and for each returned tool calls `pi.registerTool` with a provider-safe name derived from the tool's own (D8), the tool's `description` and its `inputSchema` as `parameters`, proxying `execute` to `tools/call` under the canonical name.

The measured properties that make this safe rather than merely convenient:

- **23 tools discovered and registered**, and a proxied `memory.save` wrote a row confirmed by an independent `memory.get`, with a fabricated-id control returning `not_found`.
- **The 23 real `inputSchema` objects use only** `$schema additionalProperties description enum items maxItems maxLength maximum minItems minLength minimum properties required type`. **Zero** `$ref`, `definitions`, `anyOf`, `oneOf`, `allOf`, `format` or `default`. Pi's validator accepts all of them and **discriminates**: valid input passes; an unknown property, an invalid enum member and a missing `required` field each reject. `parameters` accepts raw JSON Schema with no cast under TS strict.
- **Pi validates arguments against our schema before invoking `execute`** and returns the validation error to the model as the tool result. Combined with the server's own `.strict()` schemas, `additionalProperties: false` is enforced twice and the server never sees a malformed argument object.

The load-bearing consequence is that **the plugin contains no list of tools**. Adding, renaming or removing a server tool needs no plugin change and cannot desynchronise, because there is nothing to synchronise. That is a stronger guarantee than the one-copy discipline `CLAUDE.md` enforces by grep elsewhere in the tree.

**Rejected: a hand-written tool list** (23 duplicated schemas, guaranteed to drift). **Rejected: forking the bridge** (no consumer for its transport). **Rejected: waiting for the harness to add MCP** (its absence is documented as intentional, not pending).

### D7 — Zero runtime dependencies in the published package

Measured: for **local-path** installs Pi does **not** run `npm install`; for `npm:` and `git:` specs it does. So a dependency either travels in the tarball or is absent in local-path installs — an install shape the TUI's own development and testing paths use.

Two options were weighed.

1. **Bundle an MCP client library into the tarball.** Works for every install shape. Costs: third-party runtime code on every user's machine, inside a package we publish, in a repo whose stated posture is default-deny lifecycle scripts and a 3-day install cooldown for anything we consume. A dependency we ship is a dependency our users cannot decline.
2. **Speak MCP over `fetch` directly and declare no runtime dependency.** The wire surface actually needed is small and fully exercised by the verified round trip: `initialize`, `notifications/initialized`, `tools/list`, `tools/call`. Costs: our own transport code to maintain, and Streamable HTTP session-id handling to get right.

**Chosen: option 2.** The supply-chain posture is the tie-breaker and it is not close: this repo's whole inbound policy is about minimising third-party code execution, and the first thing it publishes should not push third-party code onto users who did not ask for it. The Pi core packages go in `peerDependencies` with range `"*"` and are **not** bundled — they are the host, present by construction, and a version range would be a compatibility claim we have measured at exactly one version.

**Consequence to state plainly:** the transport becomes ours to keep working. The mitigation is that it is exercised end to end by `apps/plugin/.pi-plugin/plugin.test.ts` against the real in-process server, which is a stronger test than any of the four existing clients has for its MCP path.

### D8 — Tools are registered under a provider-safe name and proxied to the canonical one

**This is a measured constraint, not a precaution.** Against a real provider — an OAuth-authenticated Codex provider, model `gpt-5.6-terra` — registering the server's 23 tools under their canonical dotted names makes the provider refuse the **entire** request:

> `Codex error: [StringParam] [tools[4].name] [invalid_string] Invalid 'tools[4].name': string does not match pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'.`

The harness exits 1 and **not one** tool is usable. The failure shape is what makes this non-negotiable rather than a nice-to-have: the client is **inert, not degraded** — no partial surface, no fallback, nothing a user can work around. The harness performs no validation or normalisation of the name in `registerTool`, so the dot reaches the provider intact.

**The discriminating control:** the identical run with the tool payload suppressed (`--no-tools`) exits 0. That isolates the tool definitions as the cause and rules out credentials, network and harness. Re-running with `.`→`_` applied **at registration**, keeping the canonical name for the call, exits 0 — and a model-directed tool call completes the round trip to the server under its canonical name (a `proxied` event in the evidence).

**So the mapping lives in the registry.** `pi.registerTool` receives the safe name; the extension retains the canonical one and issues `tools/call` with it, so the server only ever sees its own tool names. The earlier finding that dotted names survive the harness's local pipeline — `registerTool`, the wire payload, `tool_calls`, the session file, `--continue`, the `--tools` allowlist — is still true and is still why **no server-side rename is needed**. It was measured against a stub provider, so it simply never reached the layer that constrains.

**Rejected as unworkable, not merely as worse: a `before_provider_request` hook that rewrites the outgoing payload.** A hook that sanitises only what goes out leaves the model naming the sanitised tool in its `tool_call`; the harness then resolves that name against its **own registry**, where nothing is registered under it. The tool cannot be dispatched at all — this is a broken design, not a weaker one. Sanitising a name must therefore be visible to the registry, which is to say it belongs at registration. The hook remains the right place for a future **payload** repair, and only that.

**`$schema` is not touched.** The same run showed the provider accepting the `inputSchema` **verbatim**: the draft-07 `$schema` key the harness forwards inside `parameters`, `additionalProperties: false`, and the `"strict": false` the harness adds itself, all accepted. Stripping `$schema` was the other half of the previously-planned sanitiser and is now **prohibited as speculative** — a transform nobody can show is needed, applied to a payload measured to be acceptable. Should some other provider reject a forwarded schema key, `before_provider_request` is the correct place for that repair, and the repair must be justified by a measurement against the provider that rejected it, not by symmetry with this one.

### D9 — The README's npm prohibition is narrowed to the mechanism it was written about

`open-source-distribution/spec.md:48` forbids the phrase "npm package" in the README. It was written to stop the README advertising a **retired install mechanism for the server** — the operator CLI installable from npm, deleted by `archive/2026-05-17-remove-cli-and-npm-distribution` (`proposal.md:9`, `tasks.md:8.1`/`6.1`/`6.5`/`6.6`). Its scenario at `:62` names the exact regression it guards: the phrase "One npm package".

Documenting `pi install npm:@rembric/pi` is not that regression. The delta therefore narrows the prohibition to what it was defending — **npm as an install path for the Rembric server, or as a substitute for the TUI installer** — while permitting a named npm package that is a **supported client's own install command**, subject to the existing rule that the TUI leads and per-client commands live under the manual/advanced heading.

**Rejected: leave `:48` alone and word the README to avoid the phrase.** That is the failure mode `CLAUDE.md` calls out directly — code and docs quietly disagreeing with a contract nobody updated. If the rule is now wrong, the rule changes.

### D10 — No version pin in the documented install command

Measured against the harness's documented behaviour: a package spec that names a version is treated as **pinned**, and pinned extensions are **skipped** by both `pi update --extensions` and `pi update --all`.

So the canonical documented command is `pi install npm:@rembric/pi`, with no version. Documenting `@rembric/pi@0.24.0` would freeze that user at 0.24.0 permanently, with the update command reporting success and doing nothing — a silent, indefinite failure. The `--ref=<tag>` pinning the TUI offers for other clients has no counterpart here and the delta says so rather than implying one.

### D11 — Publishing acquires a written policy, in the same change that first publishes

`supply-chain-hygiene/spec.md:5` is inbound-only by design. Publishing opens an outbound surface with **no** requirement covering it: nothing says the artifact must carry provenance, nothing says the publish credential may not be a long-lived token, nothing says the tarball contents are bounded. Practices 11–13 of `.agents/skills/npm-security-best-practices/SKILL.md` are the doctrine and are inert today only because nothing is published.

The new outbound requirement fixes four properties: provenance is mandatory; the credential is trusted-publishing OIDC (`id-token: write`) and **never** a long-lived `NPM_TOKEN`; tarball contents are bounded by a `files` allowlist asserted by `npm pack --dry-run`; and a package **we** publish declares no lifecycle scripts of its own.

That last one deserves its own sentence, because it is the measured surprise. Whether a `prepack` script runs **depends on the cwd of the publish command** — the project `.npmrc` is resolved from the nearest `package.json`, so the root's `ignore-scripts=true` does not cover a package published from its own directory, but does cover one published from the root. Measured with both controls. A build step whose execution depends on where it was invoked from is not a build step; it is a coin flip that produces either a correct tarball or a tarball missing its shared resources, with no error either way.

**So: no `prepack`.** Shared resources are materialised into `.pi-plugin/` by an **explicit CI step** before publish, `files` bounds what ships, and `npm pack --dry-run` is asserted against an expected file list so a missing resource fails the job instead of shipping. **Rejected: keep `prepack` and pin the publish cwd** — it works, and it makes a security-relevant behaviour depend on a working directory that a future workflow edit can change without anyone noticing.

### D12 — Pi is a third TUI backend, and the version-detection promise is honoured or explicitly withdrawn

`tui-installer/spec.md:11` fixes the orchestrator at two backends: per-client scripts (opencode, Hermes) and marketplace CLIs (Claude Code, Codex). Pi is neither — its install is the client's own CLI against a public registry (`pi install npm:@rembric/pi`), which is closer to the marketplace backend but resolves against npm rather than a repo-side manifest.

`:170` is the harder constraint. It fixes four version-detection adapters and states that the status table's "update available" **never lies**. A fifth row whose installed version is guessed would break that promise for every client, because a table with one unreliable row is an unreliable table.

The delta therefore requires the Pi row to do one of exactly two things:

1. Read the installed version from a **deterministic on-disk location** whose contents are established by measurement (matching the JSON/YAML/comment adapters the other four use), or
2. Report the installed version as **explicitly unknown** and the recommended action as one that is correct under ignorance — the idempotent reinstall, printed as the `--action` verb that performs it (`install`, see D15) — with the table saying "unknown", never "up to date".

Guessing is prohibited. Which of the two applies is OQ2, because it depends on a filesystem layout that must be measured on a real install rather than inferred; the **recorded default is (2)**, since it is always available and never lies.

### D13 — The nudge and redaction contracts grow structurally, not by discipline

`plugin-session-protocol/spec.md:193` requires the nudge strings byte-identical across clients, sourced from `apps/plugin/test/nudge-fixtures.json`; `:351` requires `<private>` redaction with identical observable semantics in every client. A fifth client that misses either is a calibration hole and a privacy hole respectively.

Both are answered by D2's shared core rather than by adding a fifth copy: the nudge constants and `stripPrivateTags` move into `rembric-plugin-core.mjs`, so the fifth client is byte-identical **by construction** and there is no fifth implementation to keep in step. The widened invariant from D1 is what stops a sixth client, or a well-meaning refactor, from reintroducing a copy.

Two consequential repairs come with it. The TS redaction arm currently lives at `apps/plugin/.opencode-plugin/plugin.test.ts:655-714`, asserts **indirectly** (it drives a whole session and inspects the POST body), and runs **12 of the 13** fixtures — it filters `f.input !== ''`, because the indirect path cannot express the empty-input case. It moves to `apps/plugin/test/redaction.test.ts` beside the bash and Python arms, calls the function directly, and runs all **13**. And the delta records this client's session close as **awaited** rather than best-effort, plus the one edge where it is not (D14).

### D14 — The awaited-shutdown finding is recorded as a contract, and its exception with it

Measured: `session_shutdown` is `await runner.emit(...)` with no timeout. A 300 ms `await fetch` completes; a 10 s one completes; a full MCP `tools/call` issued from inside the handler completes. SIGTERM and SIGHUP both reach it. Control that must fail: SIGKILL runs nothing.

So this client does **not** need the fire-and-forget dispose flush opencode needs (`plugin.ts::disposeFlushFireAndForget`, whose comment records that opencode kills the subprocess before async handlers finish). The extracted core exposes both an awaited flush and the fire-and-forget variant; opencode keeps the latter, Pi uses the former. Writing the fire-and-forget path into the fifth client "for symmetry" would degrade a guarantee we measured, for no reason.

The exception is recorded in the same requirement rather than in a comment: **Ctrl-C does not fire `session_shutdown` in either mode.** In print mode SIGINT is not registered — `dist/modes/print-mode.js:32` reads `const signals = ["SIGTERM"]`, with SIGHUP wired separately. The interactive TUI was then measured directly, because an unmeasured "probably fine" is worse than an admitted gap: under a pty with keys delivered at t=4 s and stdin held open until t=14 s, Ctrl-C left the handler firing at **13.6 s** — the stdin EOF, byte-identical to the no-keys control — while Ctrl-D fired it at **3.6 s**.

The instrument matters more than the result here. The first version of this probe closed stdin immediately after sending the key, and reported Ctrl-C as working; the control that must fail (send nothing) produced byte-identical evidence, proving the probe measured the EOF rather than the key. Separating the arms in _time_ rather than in _whether the event occurs_ is what made it discriminate, and the Ctrl-D arm is what proves the byte channel was live. Ctrl-D, SIGTERM and SIGHUP are all awaited; Ctrl-C and SIGKILL are not.

### D15 — One state vocabulary, one verb vocabulary, and one mapping between them

The fifth row introduced a state the four existing ones never produced — present, but with no installed version readable anywhere — and the first cut printed it in the status table as `reinstall`. That is not a verb `--action` accepts, and the consequence was reproduced by execution, not read: with a `pi` on `PATH` and no manifest on disk, the table recommended `reinstall`, and `--agent=pi --action=reinstall` **exited 0 having run nothing while printing the post-install "Next" steps**, or, with `--yes`, died as `install.sh: 805: cmd: parameter not set`. The root cause is not the label: `--action` was never validated, so an unrecognised verb left `cmd` unassigned and both `case` ladders that consume it (`client_cli_cmds`, and `do_server`'s `update`-or-else test) fell through. **A POSIX `sh` `case` with no matching arm exits 0**, which is what turns every one of these into a silent success rather than an error.

The decision has three parts, and the first is what makes the other two checkable:

1. **A closed verb set, validated in the parser.** `ACTIONS='install update uninstall'` is the single definition, and `--action` is refused at parse time — before the banner, before any file is written — exactly as `--port` already is. `--server`, which has no uninstall backend, additionally refuses `uninstall` rather than treating it as install. Both `case` ladders gain a `*)` arm as defence in depth behind the parser.
2. **One state → verb mapping.** `client_state` yields the state (`install | none | update | ahead | unreadable`); `state_action` is the only place a state becomes a recommendation (`install`/`unreadable` → `install`, `update` → `update`, everything else → nothing). The status table's ACTION column and update-all's force hint both print its output, so **no surface can recommend a verb the parser would refuse** — and the table can be followed literally.
3. **`--status --json`'s `action` field keeps carrying the _state_, not the verb.** So the vocabulary is: on human surfaces `ACTION` names the `--action` to run (or a state label — `up to date`, `ahead`, `-` — when there is nothing to run); on the machine surface `action` names the detected state, and the human form is derived from it by `state_action`.

**Rejected: renaming the JSON field to `state` and giving `action` the verb.** It is the tidier naming, and it is refused for two independent reasons. It loses information: `install` (not installed) and `unreadable` (installed, version unreadable) both map to the verb `install`, and both already carry `installed: null`, so a consumer could no longer tell them apart from the payload at all. And the field's vocabulary is pinned outside this change — `openspec/specs/tui-installer/spec.md:285` and `openspec/specs/mcp-api/spec.md:1564` both enumerate it, and `apps/server/src/mcp/about-tool.ts:36` repeats it verbatim to every agent — so the rename is a three-surface edit in a capability this change is not otherwise touching. Recorded here so a later reader finds the asymmetry deliberate.

## Risks / Trade-offs

- **[Known constraint — measured, and closed by the design] A real provider rejects the canonical dotted tool name outright.** Measured against an OAuth-authenticated Codex provider (model `gpt-5.6-terra`): the dotted names make the provider refuse the whole tools payload, the harness exits 1, and **no** tool is usable — inert, not degraded. Discriminating control: the same run with the tool payload suppressed exits 0, which rules out credentials, network and harness. → **Closed by D8, not mitigated by caution:** the `.`→`_` mapping lives in `pi.registerTool` and the canonical name is retained for `tools/call`, which the same run measured round-tripping. This entry stays here after closure deliberately — a future reader who finds the registered names mapped needs to know a provider put them there, not a preference — and it records what the same run **cleared**: the `inputSchema` travels verbatim, `$schema`, `additionalProperties: false` and the harness's own `"strict": false` all accepted, so nothing is stripped. **Residual, deliberately unmeasured:** every other provider (OQ1).
- **[Risk] The extraction ships a broken opencode install that exits 0.** `install.sh:78` rewrites one import literal by `sed` and its guard at `:82` `grep -qF`s only that one destination; with a second shared import, the installer writes a plugin that cannot load and **reports success**, while `install.test.ts:251-265` stays green because nothing in the suite ever loads the installed plugin. → **Mitigation:** the second `fetch_file`, the second `sed`, the guard extended to **both** destinations, the uninstall target, and the core added to the idempotency check land in the **same commit** as the extraction — and the guard extension is mutation-proved (remove one destination from the guard, the test naming it must go red).
- **[Risk] The new `plugin.test.ts` is written and never runs.** `apps/server/vitest.config.ts::include` lists per-client globs literally; a missing glob produces a green suite that executes none of the new tests. → **Mitigation:** the glob is a task in the same phase as the file, and phase 3 asserts the executed-test count moved.
- **[Risk] A Ctrl-C loses the session close, in both print and interactive mode.** → **Mitigation:** not fixable from our side; recorded in the spec as a known edge with its evidence, so a future reader diagnoses it in minutes instead of suspecting our HTTP path. The per-turn flush already keeps the server's summary current, so the loss is bounded at one turn. The extension's README states it, and names Ctrl-D as the clean exit.
- **[Risk] An npm publish cannot be undone.** No unpublish after 72 hours or once a dependent exists, and the gallery listing publicly displays download counts and recency — an abandoned package advertises its own abandonment. → **Mitigation:** the `files` allowlist plus the asserted `npm pack --dry-run` make the first tarball's contents a reviewed artifact rather than a surprise; the version is the already-moving unified plugin version, so a bad publish is superseded by the next release rather than needing removal.
- **[Risk] The `@rembric` npm organisation may not be available.** Zero published packages does not prove the name is free; only an attempt to create it does. → **Mitigation:** OQ4 makes it an owner prerequisite that blocks the publish job alone. Every other phase — the safety net, the extraction, the extension, the tests, the TUI, the docs — lands and is useful regardless, since a local-path install exercises the whole extension.
- **[Trade-off] A Pi-only fix bumps the version printed by all four other clients.** → **Accepted because** the alternative reintroduces the per-component structure whose cascade and anchor fragility produced phantom release PRs and was retired by `unify-plugin-release-track`. The CHANGELOG, scoped by conventional commit, carries the truth about what changed.
- **[Trade-off] `.pi-plugin/` is not a pnpm workspace member, so `pnpm -r` does not reach it, declared dependencies are not installed by the repo's own install, and ESLint ignores it entirely (`eslint.config.js:17`).** → **Accepted because** the alternative puts the client outside the `plugin` component's `path`, where a Pi-only commit would no longer trigger a plugin release at all and the lock-step guarantee would be lost (D5 — a leading-slash `extra-files` entry _can_ write a carrier outside the component; what breaks is release attribution, not reachability). The condition already exists for `.claude-plugin/package.json`, and D7's zero-runtime-dependency rule removes the only thing the missing linkage would have mattered for. What the alternative would have bought — workspace membership, `pnpm -r` reach, real lint — is enumerated with its own costs in D5.
- **[Trade-off] We own an MCP transport implementation instead of consuming a library.** → **Accepted because** D7's supply-chain reasoning is decisive for the first package this repo publishes, the required wire surface is four methods, and it is covered end to end against the real server — better coverage than any existing client's MCP path.
- **[Trade-off] Five clients means every protocol change touches five places or the shared core.** → **Accepted because** the shared core plus the widened single-implementation invariant convert that from a discipline problem into a CI failure. The residual cost is real and permanent; it is the price of the client.

## Migration Plan

**Server and data: nothing.** No migration file, no schema change, no first-boot work on upgrade, no derived-data invalidation (`memory_fts`, `memory_vec` and the three entity tables are untouched and need no regeneration). `sessions.agent` already accepts `'pi'` (`apps/server/src/db/schema/agent-sessions.ts:51`). A populated installation with hundreds of memories is unaffected by this change: it adds a client, not a behaviour. Server rollback is unaffected because the server is unchanged.

**Existing clients.** All four keep working across the extraction, and the risk is entirely in the install scripts, not in the plugin logic. The opencode install path is the one that changes shape (a second fetched file, a second `sed`, a widened guard); its round-trip is covered by `install.test.ts` and by the local install layer of the installer e2e playbook, and the extraction commit is required to keep both green.

**Rollback.** Everything except the publish is an ordinary revert: the extension is additive, and the extraction is revertible as long as the install-script change reverts with it (they are one commit precisely so that this holds). The npm publish is the asymmetric step — it cannot be withdrawn after 72 hours or once a dependent exists — which is why it is the **last** phase and gated on the release, not on the merge.

**Order of operations for the first publish.** The `@rembric` organisation must exist before the job can succeed (OQ4). The job is gated on `apps/plugin--release_created`, so it fires on the next plugin release after it lands; a first run against a non-existent scope fails the job without affecting the release or the tag.

## Open Questions

1. **Which other model providers reject our tool definitions, and do we go looking or wait for a report?** The general provider question is **answered**, so this is no longer a hole. One real provider was measured — an OAuth-authenticated Codex provider, model `gpt-5.6-terra` — with two results: it refuses the canonical dotted names outright (whole request rejected, harness exit 1, nothing usable, isolated by a suppressed-payload control that exits 0), and it accepts the `inputSchema` verbatim, `$schema` and `additionalProperties: false` included. D8 turns the first into a registration-time mapping and the second into a prohibition on stripping anything. What remains genuinely open is **coverage**: Anthropic, Gemini and OpenAI in strict mode have not been measured. The policy this change adopts is **not to sanitise speculatively** — a provider-specific transform is written when a measurement against that provider demands it, because an unproven transform is code nobody can justify and the wrong one is indistinguishable from the right one until something fails. **Owner decision: whether to spend a second provider credential on widening that coverage before the publish phase, or to wait for the first report and measure then.**
2. **Where does the installed Pi extension version come from on disk?** D12 fixes the contract to two permitted behaviours and records the default as "report unknown, recommend the idempotent reinstall". If a deterministic on-disk manifest exists, option (1) is strictly better and the spec's scenario changes from "reports unknown" to "reads the version". This needs a measurement on a real install, which belongs to the TUI phase — not a judgement call.
3. **Does the extension expose an explicit connectivity diagnostic, or stay silent when credentials are absent?** Every existing client fails silently-but-diagnosably (one stderr line, per `plugin-session-protocol/spec.md`'s failed-POST requirement). The default is to match that exactly. The open part is whether an _interactive_ harness warrants something more visible on first run, which is a UX judgement the owner should make rather than a technical one — and it is deliberately not settled here because guessing wrong produces either noise in every session or a silent misconfiguration.
4. **Is the `@rembric` npm organisation available, and who owns it?** Operational, not technical: 0 published packages does not prove the name is free. This must be attempted by the owner before the publish job can succeed, and it also decides whether 2FA/publish-access settings need configuring alongside trusted publishing. Blocks phase 4 only.
5. **Does the gallery listing want anything beyond the `pi-package` keyword and the README?** Measured: the keyword is the **only** listing requirement and there is no admission process; the README is the gallery card and `pi.image` can point at the raw URL of `apps/landing/public/assets/logo-transparent.png`. Left open only because a card's _presentation_ (badges, screenshots, ordering) is an editorial choice with no correct answer, and the default — the README as it stands — is adequate.
