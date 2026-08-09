# Name every client on every surface

## Why

`fix-stale-client-count-surfaces` archived yesterday with an acceptance criterion that was **count-shaped when the defect is enumeration-shaped**. Its scenario (`openspec/specs/pi-plugin/spec.md:436-438`) greps `four clients|FOUR clients|all four`. By construction that grep cannot see:

1. **The `"three"` family.** `plugin-session-protocol/spec.md:167` still reads `to cover all three clients uniformly`; `dashboard/spec.md:895` still reads `Footer lists all three plugin clients plus generic MCP`.
2. **Enumerations carrying no number at all.** `apps/landing/public/llms.txt:11` lists `Claude Code, Codex CLI, Hermes Agent, opencode, ChatGPT` and omits Pi — while `:21` of the same file lists all five. The file contradicts itself and no count grep can tell.
3. **Claims about _which_ clients get a mechanism.** `docs/agents.md:38` and `docs/troubleshooting.md:105` both say only Claude Code and Codex CLI honour `initialize.instructions`. Pi does too: `apps/plugin/.pi-plugin/index.ts:322-325` appends `mcp.instructions()` to `event.systemPrompt` in `beforeAgentStart`.

Two of these are worse than stale prose. `apps/server/src/mcp/instructions.ts:4-9` has the count right and the **mechanism wrong twice** in the same comment: it names Hermes Agent among the clients whose host injects the block, which `openspec/specs/hermes-agent-plugin/spec.md:81` flatly denies — _"Hermes does NOT consume the MCP server's `initialize.instructions` block"_ — and it says Pi's copy "lands in that extension's `initialize` result rather than in the harness's prompt", which `index.ts:323` contradicts. The same false Hermes claim is **published spec text** at `plugin-session-protocol/spec.md:180`, so two requirements in `openspec/specs/` have disagreed with each other since 2026-06-14.

And `.github/ISSUE_TEMPLATE/bug.yml:56-70` makes a stranger pay for the drift. Its `Client` dropdown is `required: true` and offers `Claude Code`, `Codex CLI`, `Hermes Agent`, `Other MCP client`, `Dashboard only`, `Server-side / no client involved`, `N/A`. **opencode and Pi are absent**, so a user of either first-class client must file themselves as "Other MCP client" — a required field that miscategorises a bundled client as a third-party one on every bug report, wrong since opencode landed in May 2026.

The common cause is not carelessness. Of the twelve surfaces this change touches, **exactly one was pinned by a published requirement** (the issue template's client list). Nothing pinned the rest, so they drifted, and the login footer drifted for a year with **zero** test coverage: `git grep -c "clients" apps/server/src/test/dashboard-e2e.test.ts` returns `0`.

## What Changes

**The login footer, and the spec that never described it.** `apps/server/src/server/dashboard-router.ts:803-810` renders the client list. It now reads `CLAUDE CODE`, `OPENCODE`, `CODEX CLI`, `PI`, `HERMES`, `MCP CLIENTS` — Pi added (it was the only client missing) and `MCP CLIENTS` moved from between `CODEX CLI` and `HERMES` to last. Last is a **rule a future client can follow** (five plugin clients, then the generic entry); the previous position was not a rule, just where it landed.

The delta adopts today's code order rather than restoring the spec's, because the spec's order is a fossil rather than a constraint — verified from history, not inferred. `git log -L 890,900:openspec/specs/dashboard/spec.md` returns exactly one commit, `b161006` (initial public release, 2026-05-18), when the repo had exactly three plugin clients, so `all three` and `four labelled spans` were both correct then. The code was deliberately reordered one day later by `52eddf2`, whose body reads verbatim "Dashboard login footer reordered: CLAUDE CODE / OPENCODE / CODEX CLI / MCP CLIENTS / HERMES", and which touched **no** file under `openspec/`. The spec never followed the code; there is nothing to restore.

- **`dashboard` delta — `REMOVED` + `ADDED`, not `MODIFIED`.** The defect is partly in a **scenario title** (`Footer lists all three plugin clients plus generic MCP`), and a `MODIFIED` block cannot rename one. Measured against the real gates, eight arms, with a control: `MODIFIED` fails `check-delta-freshness.mjs` with _"published scenario(s) absent from the delta — archive will refuse"_ and `openspec archive` aborts with _"current spec contains scenario(s) not present in the modified block"_ — this is what reddened CI earlier in this session. `## RENAMED Requirements` works in the CLI but trips `check-delta-freshness.mjs`, which contains **zero** occurrences of the string `RENAMED` and splits on `'## MODIFIED Requirements'` (`scripts/check-delta-freshness.mjs:77`). `REMOVED` + `ADDED` with the **same** header is rejected by `openspec validate` (_"Requirement present in both ADDED and REMOVED"_), so the header must change too — which suits, because the header is where `client-support footer` becomes something that names the clients.
- **`plugin-session-protocol` delta — `REMOVED` + `ADDED`, same mechanism, for the same reason** (`all three clients` is in the **requirement header**). The re-added body also drops the false Hermes claim at `:180` and replaces it with what is verified per client, so the two published requirements stop contradicting each other.
- **`open-source-distribution` delta — plain `## MODIFIED`.** The issue template's client list lives in a **scenario body**, not a title (`Scenario: Issue template surfaces in the new-issue UI`), so no rename is needed. The scenario gains a per-client obligation instead of a parenthetical enumeration that goes stale on the next client.
- **Nine non-spec surfaces corrected**, none of which any requirement governs: `SECURITY.md:76-80` (stale paths `src/` → `apps/server/src/`, `plugin/` → `apps/plugin/`, and a declared scope naming only the Claude Code / Codex / Hermes marketplaces — the published security policy), `docs/docker.md:15,39` (two ASCII diagrams), `docs/agents.md:38`, `docs/troubleshooting.md:105`, `apps/landing/public/llms.txt:11`, `apps/plugin/.hermes-plugin/README.md:120`, `apps/plugin/.opencode-plugin/README.md:67` ("all clients" while omitting Pi, which does read `.rembric`), `apps/server/src/mcp/instructions.ts:4-9`, `apps/server/src/scripts/seed-volumetric.ts:409` (`AGENTS` omits `pi`).
- **`.github/PULL_REQUEST_TEMPLATE.md:39` stops asking for a manual version bump.** It is stale on three axes — the paths lost their `apps/` prefix, "all three manifests" counts three against five carriers, and, substantively, it **instructs contributors to do something that is now wrong**: under the unified `plugin` release track, release-please's `extra-files` move every carrier in lock-step and a contributor hand-bumps nothing. This is not a count fix. It gets no spec scenario — see design D6.
- **This change carries its own acceptance criterion, enumeration-shaped.** It flags any tracked line naming three or more of the five clients while omitting at least one. Measured at HEAD it returns 55 lines, of which the sub-family carrying a universalising phrase (`all clients`, `every client`, `supported client`, …) is 6 — and after this change every one of those 6 must be a legitimate subset statement or historically scoped. The old count-shaped grep sees **none** of them.

## Capabilities

**New Capabilities**: none.

**Modified Capabilities**:

- `dashboard` — the login-view requirement is renamed (count-free header and scenario title) and its footer list becomes the six labelled spans the code renders, with the order stated as a rule.
- `plugin-session-protocol` — the `initialize.instructions` requirement is renamed count-free, and its rationale stops claiming Hermes consumes that surface.
- `open-source-distribution` — the issue template's `Client` field must offer every bundled client, not a frozen list of three.

## Impact

No runtime behaviour changes except the login page's rendered HTML, one build-time comment, and one dev-seed constant. No schema, no migration, no MCP tool added or removed, no plugin file touched. `seed-volumetric.ts::AGENTS` gaining `pi` changes only synthetic dev data, never production rows.

**Existing installations**: nothing to migrate. No table is read or written, no derived table (`memory_fts`, `memory_vec`, the three entity tables) is invalidated, first boot after upgrade behaves identically, and rollback is a plain image revert — the login page renders the old list again and nothing else differs.

Two costs are accepted rather than hidden. `REMOVED` + `ADDED` **relocates** each renamed requirement to the end of its published spec file at archive time (see design D2), and it removes those requirements from `check-delta-freshness`'s protection entirely, because that gate only inspects `MODIFIED` blocks — so the carried-through scenarios must be proven byte-identical by hand (task 5.4).
