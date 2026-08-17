# Changelog

## [0.28.5](https://github.com/susomejias/rembric/compare/server-v0.28.4...server-v0.28.5) (2026-08-17)


### Features

* **sessions:** gate session nudges on the server ([6be7568](https://github.com/susomejias/rembric/commit/6be7568be5e9c6e079ef11de227a452d4c93ae28))
* **sessions:** merge curated session-summary writes section-wise ([1e843e1](https://github.com/susomejias/rembric/commit/1e843e110dd289653402ad683485e36b16bbbc61))
* **sessions:** retire session_summary_versions ([d62b7b3](https://github.com/susomejias/rembric/commit/d62b7b3c0f42483916e41bcba5313942543b13cf))


### Bug Fixes

* **dashboard:** format sessions.css and cover CSS in lint-staged ([9b4b2eb](https://github.com/susomejias/rembric/commit/9b4b2ebbbc19d26b6045f8b072f74a3b5886895a))
* **plugin:** harden the no-jq hook JSON parsers ([e1f0d60](https://github.com/susomejias/rembric/commit/e1f0d60b69ca7617f3e52e983c18364fe023b180))
* **plugin:** stop the turn report from killing its caller, and share the tool latch ([c370621](https://github.com/susomejias/rembric/commit/c370621bff3729c85e76dc5f2f6769cc74ac1b76))
* **sessions:** anchor last_work_at on a dedicated turn-report column ([2f05769](https://github.com/susomejias/rembric/commit/2f0576952d737ea7f4b8153e878d7f7b45a5a69c))
* **sessions:** close audited defects on the session-summary nudge path ([4f3399d](https://github.com/susomejias/rembric/commit/4f3399d3836f1c42a78d80e21ad5a30d6b5a3c13))
* **sessions:** except the turn anchor from the monotonicity clause ([9f73d97](https://github.com/susomejias/rembric/commit/9f73d979ec0dc4c8423b9c036975858e214a5034))
* **sessions:** stamp last_work_at with the turn's start, not the report ([6a00b3a](https://github.com/susomejias/rembric/commit/6a00b3afba71136f6758d1baa59f3cd423819ed8))


### Documentation

* **openspec:** archive retire-summary-versions ([7847705](https://github.com/susomejias/rembric/commit/784770516ce5aa643294228848a19f6990e3556a))

## [0.28.4](https://github.com/susomejias/rembric/compare/server-v0.28.3...server-v0.28.4) (2026-08-15)


### Features

* **plugin:** own the MCP bridge transport ([64ef334](https://github.com/susomejias/rembric/commit/64ef3344320c021ccc14da7b213c2e796e0fc638))


### Bug Fixes

* **mcp:** evict stale per-transport router and transport state ([ee5de52](https://github.com/susomejias/rembric/commit/ee5de5243b932c35839107a4296bcae7ecdcec10)), closes [#328](https://github.com/susomejias/rembric/issues/328)
* **mcp:** refuse an unknown mcp-session-id with 404, fix a stale docstring ([faf67fc](https://github.com/susomejias/rembric/commit/faf67fc365e1ae91c3031bb4557c0fa4cf076915))
* **mcp:** report the resolved agent on memory.session_start ([9f32810](https://github.com/susomejias/rembric/commit/9f328104a4613af61d22a602e7114c97d1cd1535))
* **plugin:** harden bridge recovery and upgrades ([dd495aa](https://github.com/susomejias/rembric/commit/dd495aa947d8b531b7285e05a9a75132c0a45c4d))


### Documentation

* **openspec:** archive own the mcp bridge ([9b5f976](https://github.com/susomejias/rembric/commit/9b5f9760c177f259440684341f56bf2e3af1094c))


### Reverts

* drop the evict-stale-transport-state mechanism ([#328](https://github.com/susomejias/rembric/issues/328)) ([88a4468](https://github.com/susomejias/rembric/commit/88a4468e953c667e2a4c6ab573409187c6c5d310))

## [0.28.3](https://github.com/susomejias/rembric/compare/server-v0.28.2...server-v0.28.3) (2026-08-13)


### Bug Fixes

* **sessions:** enforce Markdown summary headings ([c44d389](https://github.com/susomejias/rembric/commit/c44d3894b3fe82c69dd178d9eab4ef89a90641aa))

## [0.28.2](https://github.com/susomejias/rembric/compare/server-v0.28.1...server-v0.28.2) (2026-08-13)


### Features

* **dashboard:** list session summary version history on the detail page ([48310c8](https://github.com/susomejias/rembric/commit/48310c8e8344c2c9bb99134c6cddcb762142c89d))
* **dev-seed:** give a seeded session two curated summary versions ([1a64a61](https://github.com/susomejias/rembric/commit/1a64a61ea691068e8bf2662ce0ed16894de201b7))
* **plugin:** tell a resumed process to read the stored summary once ([da386cb](https://github.com/susomejias/rembric/commit/da386cb0d91cdc987a4142d455ced626e7bc286a))
* **sessions:** add session_summary_versions table and append-on-write ([c984608](https://github.com/susomejias/rembric/commit/c98460883afc5b5f150cb40f3f4a544ba3493187))
* **sessions:** budget the Stop reminder correctly, direct verbatim copying of facts ([d57b1b8](https://github.com/susomejias/rembric/commit/d57b1b8f6fea20eaff87080a4ed6f597ff6547ed))
* **sessions:** rewrite model-facing summary text for replace-and-rewrite ([733ddd5](https://github.com/susomejias/rembric/commit/733ddd53a483c9b6acd91aa7cc8dcf0a2ad6f49d))
* **sessions:** version titles and expose recent versions via session_get ([0563260](https://github.com/susomejias/rembric/commit/0563260bcded49498aad650abce41e438cd6145d))


### Bug Fixes

* **dashboard:** tolerate prettier-wrapped whitespace in summary-history test assertions ([29ce7c1](https://github.com/susomejias/rembric/commit/29ce7c1dc4af3bb90e670b8577fc7f553d42c91c))
* **server:** create the fixture TMPDIR instead of assuming it exists ([0e3fa76](https://github.com/susomejias/rembric/commit/0e3fa76e4249c6919681c984788ea4eed09ebc25))
* **sessions:** stop opencode's post-compaction instruction from storing the compacted window ([9da6d33](https://github.com/susomejias/rembric/commit/9da6d3315d19bb0557dc5595b0619390d7dce4c2))

## [0.28.1](https://github.com/susomejias/rembric/compare/server-v0.28.0...server-v0.28.1) (2026-08-10)


### Features

* **pi:** render tool results collapsed by default ([906b596](https://github.com/susomejias/rembric/commit/906b59609c21c9d92966f6b82a36737f674a1570)), closes [#333](https://github.com/susomejias/rembric/issues/333)

## [0.28.0](https://github.com/susomejias/rembric/compare/server-v0.27.3...server-v0.28.0) (2026-08-09)


### ⚠ BREAKING CHANGES

* **sessions:** `ended_at` is now write-once per terminal transition rather than per row, and is cleared on resume. Preserving it preserved nothing — every writer matches `status='active'` and overwrites it at the next close — while leaving five read surfaces reporting an `Ended` timestamp on a live row. The discarded value is reported once, as `previousEndedAt` in the resume response, and is not retained.

### Features

* **sessions:** return a closed session to active ([63cd3bc](https://github.com/susomejias/rembric/commit/63cd3bc62e315eeb7ef3c7923673c4fab4a084ef)), closes [#326](https://github.com/susomejias/rembric/issues/326)

## [0.27.3](https://github.com/susomejias/rembric/compare/server-v0.27.2...server-v0.27.3) (2026-08-09)


### Bug Fixes

* **mcp:** give the roots-discovery state an owner, and refresh under a tool call ([a679cde](https://github.com/susomejias/rembric/commit/a679cdee255dc5334be371f1d1c1cf6ea3c31714))
* **mcp:** route roots/list over the tool call's own stream so it is delivered ([7ec53fe](https://github.com/susomejias/rembric/commit/7ec53fe926cc67ce8c361b59312f67189cdc3d01))

## [0.27.2](https://github.com/susomejias/rembric/compare/server-v0.27.1...server-v0.27.2) (2026-08-09)


### Bug Fixes

* **dashboard:** name every client on every surface, and pin the one that drifted ([b9b7418](https://github.com/susomejias/rembric/commit/b9b74186e9244a32fe7ab15c43a6ddf14b915447))
* **mcp:** name Pi in the session_start description an agent reads each session ([25bd6d2](https://github.com/susomejias/rembric/commit/25bd6d21aa938cfe9eb8494e05e1d149efb9fb24))
* **mcp:** stop save_prompt firing on every session's first turn ([965e1fc](https://github.com/susomejias/rembric/commit/965e1fc3c46b5c20899a631103cb741548441fb2))
* **sessions:** refuse a soft-deleted row at the write, not only at the boundary ([7754fbb](https://github.com/susomejias/rembric/commit/7754fbbc58af1a6b2b3e6b6c9ab6bf3463dd328c))
* **test:** derive the shared-helper invariant from the core, not a hand list ([bc2b6f7](https://github.com/susomejias/rembric/commit/bc2b6f70dfb767582b156bdaea16718e418394eb))


### Refactor

* **sessions:** retire the summarize() back-compat wrapper ([749703a](https://github.com/susomejias/rembric/commit/749703ab6b0131d894a96c89cd50dac0d34551c6))

## [0.27.1](https://github.com/susomejias/rembric/compare/server-v0.27.0...server-v0.27.1) (2026-08-08)


### Features

* **plugin:** add the Pi harness as a fifth client ([083ebb0](https://github.com/susomejias/rembric/commit/083ebb045a6f4c59ff9a6bd3d89111dea6ba4e5e))


### Refactor

* **plugin:** extract the shared session-protocol core ([6b68e8d](https://github.com/susomejias/rembric/commit/6b68e8d0e834cc9da4808a8e3e0bb6b6b280c7cc))


### Documentation

* cut the comments that restate code or repeat the spec ([4745b3d](https://github.com/susomejias/rembric/commit/4745b3dda8056e4e42937ce4dc16a8112e0ae7e9))
* five clients, and what makes the fifth different ([533a8b0](https://github.com/susomejias/rembric/commit/533a8b0643b027de9f2527ab8d74482750001340))

## [0.27.0](https://github.com/susomejias/rembric/compare/server-v0.26.0...server-v0.27.0) (2026-08-06)


### ⚠ BREAKING CHANGES

* **scope:** Scope has one arm. Every construction site in the tree and in the retrieval harness moves with it. No wire contract and no schema change.

### Features

* **corpus:** let seed-volumetric build a skewed multi-project corpus ([b296db2](https://github.com/susomejias/rembric/commit/b296db2f27185b7f497a42ed2b2269c3b0503c29))
* **mcp:** build the widened search scope at one authorized site ([83bbd7d](https://github.com/susomejias/rembric/commit/83bbd7df76f0d3bcd3e3a709503e1bfc876e02f0))
* **mcp:** let memory.search read the other projects a token may reach ([01e10b8](https://github.com/susomejias/rembric/commit/01e10b8e2c6f8de626b47d3060bf089adaea05d4))
* **scope:** add the search-only scope a write cannot hold ([b94f73b](https://github.com/susomejias/rembric/commit/b94f73bba3d5c62a9a6fad96878ba738e2743872))
* **search:** let the search path alone accept a widened scope ([963dcbe](https://github.com/susomejias/rembric/commit/963dcbeec31e653130d4f0ba389b34126787c039))
* **search:** name every authorized partition in one kNN, and order the page totally ([64e3c71](https://github.com/susomejias/rembric/commit/64e3c7162d542c334d1b205f48ef0d09df771404))
* **search:** serve the entity branch from every project the scope names ([62c7566](https://github.com/susomejias/rembric/commit/62c7566eb23f7024c56745e0e5489d8e9bd17bde))
* **search:** serve the lexical and listing reads from the whole scope ([576340a](https://github.com/susomejias/rembric/commit/576340a830172a5af8a85f8b071a93eabb6573ee))


### Bug Fixes

* **consolidation:** stop the undo path from attempting a doomed reactivation ([d4d219a](https://github.com/susomejias/rembric/commit/d4d219a352fa652d37fb0e71d3060ce11c31d637))
* **mcp:** widen across_projects' second trigger to the condition its spec states ([d8e997e](https://github.com/susomejias/rembric/commit/d8e997e9fc65bd5a5f4fb0515e3ca4af2f083a9b))
* **search:** draw the candidate window per project, not once across the union ([ccc10b2](https://github.com/susomejias/rembric/commit/ccc10b2011ef8d71b06903a0f0326a8261503dba))
* **test:** replace a raw NUL that made a test file binary to grep ([bb64085](https://github.com/susomejias/rembric/commit/bb6408570c376fcc6872537ba677e5f01724e9b1))


### Refactor

* **db:** let the scope clause builders address a set of projects ([6b46f1c](https://github.com/susomejias/rembric/commit/6b46f1c2d97d2472254c61bc40c3257a384ce2a0))
* **db:** let the scope clause builders take the Scope, not its id ([83c2002](https://github.com/susomejias/rembric/commit/83c2002996508d1e9c040ea929757e5af58b5805))
* **mcp:** delete the scope checks the collapse left always-true ([d0f6e0c](https://github.com/susomejias/rembric/commit/d0f6e0c288c6bc684e345a7d2961d4db737b2fcc))
* **scope:** collapse Scope to its project arm ([bcfa172](https://github.com/susomejias/rembric/commit/bcfa172b933ebbfd44509e75c1d09c986e7adb88))
* **search:** let the hybrid search options carry the scope value ([508a7f5](https://github.com/susomejias/rembric/commit/508a7f58181da050909bd19e192f19e6fc305b68))
* **test:** give findFreePort one definition in the test barrel ([c5b3cdb](https://github.com/susomejias/rembric/commit/c5b3cdb0234c28f730e91f896dead364d34f379c))

## [0.26.0](https://github.com/susomejias/rembric/compare/server-v0.25.2...server-v0.26.0) (2026-08-05)


### ⚠ BREAKING CHANGES

* **mcp:** correction to the earlier note about the removed `include_global` and `scope` input properties: because every tool input schema is strict, a client that still sends either property is refused with JSON-RPC -32602 as an unknown property — it is NOT ignored. Pinned by the every-tool refusal test in `mcp-integration.test.ts`.
* **mcp:** MCP tool calls carrying a property the tool does not declare are now refused with JSON-RPC -32602 instead of having the property silently dropped. No Rembric client sends one — the bridge forwards frames untouched, session lifecycle is HTTP, and the four clients' slash commands name only declared arguments — but a third-party client or a hand-written tool call that passed an extra key will now fail.
* **mcp:** `memory.search`'s `include_global` and `memory.save`'s `scope` input properties are removed from the published tool schemas, and the `project_suggestion_pending` error code is retired (remedy applied: remove the field or claim). A client that still sends either property has it ignored; reads and writes address exactly one project.
* **db:** `MigrateResult` no longer carries `reports` or `skipped`, and `DbHandle` no longer carries `migrations`. The migration report reaches the operator on the `[migrate]` stream instead of the `[bootstrap]` banner.
* **db:** the global scope is retired in the database. Previously-global memories, entity rows, sessions and prompts move to the default project, and a rolled-back image reads an empty global partition with the rows reachable under the default project's slug instead.
* **mcp:** three published MCP output schemas lose a required field. `memory.context` returns 9 keys instead of 10 (`clamped` removed); `memory.search_prompts` returns 3 instead of 4 (`clamped` removed); `memory.doctor`'s `db` block returns 3 instead of 4 (`open` removed). `PromptsService.searchByScope`'s `SearchByScopeResult` drops `clamped` too. `memory.get({ids})` rows gain `reviewState`, `reviewAfter`, `reviewEscalated` and `replaces`. Measured consumer set for the removed fields is zero: no hit under apps/plugin, docs, README or CONTRIBUTING, and no typed client.
* **mcp:** `project.list` renames its per-project `memoryCount` field to `activeMemoryCount`, and the number now counts only memories whose `status` is `active`. Any consumer parsing the old key gets an absent field rather than a plausible wrong number. Zero in-tree consumers: no hits under `apps/plugin/`, `docs/` or `README.md`, and there is no typed client.
* **mcp:** an MCP connection at /mcp/<slug> whose slug names no existing project is now refused with `project_not_found` on every tool that resolves scope, instead of silently operating in the global scope. Deployments where a stale or hand-authored `.rembric` points at a slug with no matching project row will start seeing refusals where reads and writes previously appeared to work — those calls were reading and writing user-wide memory. Recover by creating the project (dashboard, or `project.use({slug, autocreate: true})`) or by correcting the slug; the refusal carries `suggestedSlugs[]` for near misses. There is no flag that restores the old fallback.

### Features

* **auth:** authorize a token by its scope string OR its project membership ([81ac47a](https://github.com/susomejias/rembric/commit/81ac47a322acd922c10bc828af157632711faee9))
* **dashboard:** mint a token for the set of projects the operator ticked ([9acb3f7](https://github.com/susomejias/rembric/commit/9acb3f7880efc21a36f186784177d2387a803135))
* **db:** read and write token project membership from the tokens repository ([4651898](https://github.com/susomejias/rembric/commit/4651898191977a2f46a42c4cff1863658a69e99c))
* **db:** record which projects a set-scoped token reaches ([bb4bc7a](https://github.com/susomejias/rembric/commit/bb4bc7a10157be1842409fcf01c149af22092496))
* **db:** repoint previously-global memories onto a default project ([82c1dfe](https://github.com/susomejias/rembric/commit/82c1dfe8a7d5a10a71f016a0be91c76de0cc5806))
* **mcp:** refuse unknown tool arguments instead of stripping them ([2ebb5a3](https://github.com/susomejias/rembric/commit/2ebb5a33b819147e002515630cbfe7b2ef4db1b3))
* **mcp:** remove include_global and memory.save's scope argument ([a018392](https://github.com/susomejias/rembric/commit/a01839223430095be3dfb6499652ca3f179fb2cd))
* **mcp:** report the relevance gate's verdict truthfully ([8d84822](https://github.com/susomejias/rembric/commit/8d848222f1057cf616d844e16d67ee8d767bc865))
* **self-update:** let the operator raise the upgrader's health wait ([1113dd3](https://github.com/susomejias/rembric/commit/1113dd38579e957b087e18d2b66e13318285a248))


### Bug Fixes

* **consolidation:** re-anchor the lazy sweep and empty-session purge ([db438a8](https://github.com/susomejias/rembric/commit/db438a88b855d2c43008e1196ad8c5b644b9d328))
* **dashboard:** mint the token the operator asked for ([0cbf249](https://github.com/susomejias/rembric/commit/0cbf249b4113cdfbbf20071e3d0567bd59236b56)), closes [#307](https://github.com/susomejias/rembric/issues/307) [#309](https://github.com/susomejias/rembric/issues/309)
* **dashboard:** render the project, not a scope that no longer exists ([7f8398e](https://github.com/susomejias/rembric/commit/7f8398e0b97c6c2d7e5ea08016d63388d99b9b5c))
* **dashboard:** roll back autocreated projects when a mint is refused ([73be694](https://github.com/susomejias/rembric/commit/73be6943431e421b070094115fc455253bd35df7))
* **db:** make the repointing migration survivable, and report it once ([2a70eee](https://github.com/susomejias/rembric/commit/2a70eeeb87034fc1f512635308e6f36db88f619a))
* **mcp:** count only active memories in project.list ([39912ac](https://github.com/susomejias/rembric/commit/39912acd2fd64d1dfb1168a8ba93ac4ee4aa3bb8))
* **mcp:** forbid what the delta meant, and pin the refusals verbatim ([85eb794](https://github.com/susomejias/rembric/commit/85eb7944950e382c87d0104f4f6f88bc7a1b5e0a))
* **mcp:** refuse an unresolvable path slug instead of falling back to global ([640dfab](https://github.com/susomejias/rembric/commit/640dfab75ea94921e71cc89c63e43d3433931d1a))
* **mcp:** say which population memory.doctor's counters cover ([54e867a](https://github.com/susomejias/rembric/commit/54e867ab09ff6df11b5e7b57de1a2be696c7c496)), closes [#306](https://github.com/susomejias/rembric/issues/306)
* **mcp:** stop blaming the gate for a page the caller paged past ([701920c](https://github.com/susomejias/rembric/commit/701920cc1bbd30ce865c23a64fbd37231e2d30d0))
* **mcp:** stop naming a scope the server does not have ([61776bb](https://github.com/susomejias/rembric/commit/61776bb750752be4b4c8ca1604f3b8595b369712))
* **mcp:** stop pinning the default project as if the agent had chosen it ([70781bf](https://github.com/susomejias/rembric/commit/70781bfb1854cfd86e71cd4f0aed4b6a82976d8f))
* **mcp:** stop promising what the tools do not do ([b1d0b81](https://github.com/susomejias/rembric/commit/b1d0b81d4388d43714d3c108cc72057a0077a8b9))
* **openspec:** reconcile four published claims against measured behaviour ([e25df0d](https://github.com/susomejias/rembric/commit/e25df0d6e636d377870505588635de3fcfae058e))
* **openspec:** reconcile the gateShortened delta with the rule the code implements ([ee76b22](https://github.com/susomejias/rembric/commit/ee76b220dec505a9eee9ee65678ba2dba2392e84))
* **seed:** put the default project back after a --reset wipe ([8f093f5](https://github.com/susomejias/rembric/commit/8f093f5cef20d69a00b37d03a7ef0913e2530436))
* **seed:** wipe token memberships so --reset can drop tokens and projects ([d19ec4a](https://github.com/susomejias/rembric/commit/d19ec4ad80def294814b2d18447efbcde5aa7894))


### Refactor

* **auth:** give the set-arm grammar one writer and one reader ([b86fa4b](https://github.com/susomejias/rembric/commit/b86fa4b042a40effae16e1a2b6ed211287deca05))
* **mcp:** dispatch the denial remedy once instead of inside the pinned one ([991d751](https://github.com/susomejias/rembric/commit/991d7511d5dc726a7827ca833202bf407fdca7d1))
* **mcp:** name the search verdict once, so both surfaces cannot drift ([a1a29a0](https://github.com/susomejias/rembric/commit/a1a29a0b496fab1fc77bdd95d28243ef215612f6))
* **mcp:** resolve path-less connections to the default project ([b4e709a](https://github.com/susomejias/rembric/commit/b4e709a7eebf5bb2cadceb2c91a491eeb54cc9de))


### Documentation

* **mcp:** correct the ignored-vs-refused release note for the removed properties ([9cb5571](https://github.com/susomejias/rembric/commit/9cb5571961e242b00203bbe08d90984e2b35011a))

## [0.25.2](https://github.com/susomejias/rembric/compare/server-v0.25.1...server-v0.25.2) (2026-08-01)


### Bug Fixes

* **mcp:** gate the project→global search widening on connection and token ([1f070bc](https://github.com/susomejias/rembric/commit/1f070bc8b2bb318ff88e0a993e7c498d190a8885))
* **mcp:** suggest topic keys beyond ASCII, and refuse rather than collide ([cebc9c2](https://github.com/susomejias/rembric/commit/cebc9c248eee561c15c8c613bdc7188bd7aeb668))
* **memory:** refuse a supersedes verdict when either endpoint is retired ([b5f8366](https://github.com/susomejias/rembric/commit/b5f8366d7c3a0fead743e50eae7ae31776ce5b0b))
* **memory:** withhold pending judgments whose endpoint is retired ([b354f37](https://github.com/susomejias/rembric/commit/b354f37291f4094fa2367eebc77b020b97842db4)), closes [#298](https://github.com/susomejias/rembric/issues/298)
* **openspec:** reconcile three claims the pending-queue change left stale ([4f7adff](https://github.com/susomejias/rembric/commit/4f7adff8113e351549a644cafe5c513024e5b87d))

## [0.25.1](https://github.com/susomejias/rembric/compare/server-v0.25.0...server-v0.25.1) (2026-07-30)


### Features

* **scripts:** commit the volumetric seeding harness ([c69aae6](https://github.com/susomejias/rembric/commit/c69aae6e32668462c063766024f0a537bcd6e2da))


### Bug Fixes

* **entities:** fair-share the entities[] bound across kinds instead of by kind name ([dba5b91](https://github.com/susomejias/rembric/commit/dba5b91078661fa714d41865b114165cb5392890))
* **entities:** stop the rarity gate blocking entities too sparse to saturate ([c4c2b03](https://github.com/susomejias/rembric/commit/c4c2b03756d52f5dbc50cd5ae250bb9b845342f3))
* **mcp:** give the annotation response an aggregate budget and bound its reason ([14c2c18](https://github.com/susomejias/rembric/commit/14c2c18b1e0f686b23bb4d0f0a1bc6762b9e2def))
* **supply-chain:** pin the install-time execution surface instead of describing it ([749c7b7](https://github.com/susomejias/rembric/commit/749c7b78c30133d93a71512e8bc749009fdef3b0))


### Performance

* **db:** drop five indexes no query predicate can serve ([b4f69f4](https://github.com/susomejias/rembric/commit/b4f69f4c92c02b4004f7b24d108aa186b2b4bb5b))
* **db:** index and rewrite the hot query paths measured by tune-hot-query-paths ([a9a9737](https://github.com/susomejias/rembric/commit/a9a9737597d21e8a38ddbfeb50f1224471872a78))
* **memory:** walk the replaces ancestry in one query instead of one per hop ([1645540](https://github.com/susomejias/rembric/commit/16455400f2aa8854d0e2340218a184be8267f322))

## [0.25.0](https://github.com/susomejias/rembric/compare/server-v0.24.14...server-v0.25.0) (2026-07-29)


### ⚠ BREAKING CHANGES

* **mcp:** `entitiesTruncated` is removed from every memory-returning MCP response rather than deprecated alongside `entitiesTotal`. Shipping both would violate, in the same response object, the no-companion-boolean clause this change is modelled on. Grep found zero consumers — no test, no template, no plugin file, and no published spec named it.

### Features

* **dashboard:** order a memory's judgments, and withdraw the graph view ([00d8dde](https://github.com/susomejias/rembric/commit/00d8dde00a4f5680310eccbce686f2defcb80fc3))
* **mcp:** order relation annotations and report how many exist ([a660548](https://github.com/susomejias/rembric/commit/a660548f6b9b94d62e403b3ca49d29d558042b2c))
* **mcp:** report how many save-time candidates detection produced ([7960d87](https://github.com/susomejias/rembric/commit/7960d8766a3e80656650fd2ea1b8658ed326591e))


### Bug Fixes

* **entities:** bring three reads into line with their published specs ([db37a97](https://github.com/susomejias/rembric/commit/db37a974246c6efd826f45828c4743ce595aab0c))
* **entities:** measure entity rarity over the active population ([9ac8602](https://github.com/susomejias/rembric/commit/9ac86022170c259ee1cd1aaaa6e622a14369f581))


### Performance

* **server:** bound embedder threads and container resources ([80d173d](https://github.com/susomejias/rembric/commit/80d173d52f2860c665849e139c751b0fb92c86e3))


### Refactor

* **mcp:** replace entitiesTruncated with a true entitiesTotal ([a235c97](https://github.com/susomejias/rembric/commit/a235c97be8d153978b219224c6d7142a56d481de))
* **server:** apply the cleanup and review findings ([a01d051](https://github.com/susomejias/rembric/commit/a01d0511f8e355f5e26f1dab0c2e3aeb7ab6dc92))

## [0.24.14](https://github.com/susomejias/rembric/compare/server-v0.24.13...server-v0.24.14) (2026-07-28)


### Features

* **mcp:** report the pending-judgment total and make the queue drainable ([29874ea](https://github.com/susomejias/rembric/commit/29874eaf7c41932f6eb479ab57ff9c000a707d78))
* **memory:** enable the relative-level filter at its swept value ([e4c77ad](https://github.com/susomejias/rembric/commit/e4c77ada92c1d420394711b97df75ce5b6fb1bac))
* **memory:** give both recall gates a bounded relevance level ([e73be39](https://github.com/susomejias/rembric/commit/e73be397d0cd5ce4d5466096399494891073fab2))
* **sessions:** enrich the summary rubric and give it one source ([357ac56](https://github.com/susomejias/rembric/commit/357ac5634de9b9f46ab8d816d7767c8493f9a3a9))
* **sessions:** move the summary reminder to the end of the turn, grounded in facts ([77564be](https://github.com/susomejias/rembric/commit/77564be5c4cfb3907c515867ed4d176446925113))


### Bug Fixes

* **ci:** run the provenance history replay where the history exists ([b45af18](https://github.com/susomejias/rembric/commit/b45af18c1b70afe2eb502154ff5ee97fbbb108e2))
* **dev:** keep the dev stack off the published production image tag ([1b41583](https://github.com/susomejias/rembric/commit/1b415838d1272d08c8d5a2254a107ab6e9b30f3e))
* **embeddings:** stop a failed vector reset from destroying the index and blocking boot ([6854e5d](https://github.com/susomejias/rembric/commit/6854e5dcb450b995201d6d42d26be9d5b153a35f))
* **entities:** stop the extractor indexing prose, and stop one kind eating the budget ([32a6c6f](https://github.com/susomejias/rembric/commit/32a6c6fece6d78298002e89616709947abed1b1b))
* **sessions:** close a fact-injection hole and three more review findings ([9170804](https://github.com/susomejias/rembric/commit/917080452c1399d80c359a9eb00b283e8cf08d4d))
* **sessions:** close the five findings the review left open ([78e304e](https://github.com/susomejias/rembric/commit/78e304ec2d898626798776b0867b4395449365e8))
* **sessions:** keep the END of an oversized summary, not the beginning ([ca67603](https://github.com/susomejias/rembric/commit/ca676038114f191c9c89c425119caddcaf2c248e))
* **sessions:** let a closed session write the summary it never got to write ([74ce04f](https://github.com/susomejias/rembric/commit/74ce04f036f02f361ef5b38e745e86f8fc659216))

## [0.24.13](https://github.com/susomejias/rembric/compare/server-v0.24.12...server-v0.24.13) (2026-07-25)


### Features

* **dashboard:** compact the entity kind counters and lead with an all-kinds card ([fba6ea7](https://github.com/susomejias/rembric/commit/fba6ea7dcb0899d0d599a2d14a794622a49d2bbb))
* **entities:** add four kinds, fix two mis-extractions, version the recipe ([48b7c58](https://github.com/susomejias/rembric/commit/48b7c58921248ed4bda7037af4b4758744b36c68))
* **eval:** add offline retrieval evaluation harness ([65ed3d6](https://github.com/susomejias/rembric/commit/65ed3d65ac2ea50f6934219a95370b44840765a5))
* **memory-entities:** add deterministic entity index for exact-address retrieval ([3baff49](https://github.com/susomejias/rembric/commit/3baff4992ae98257412ce624fbb5ec8917442d01))
* **memory:** constrain the verdict domain, index archived rows, unify type lists ([76b1ca3](https://github.com/susomejias/rembric/commit/76b1ca37743483bcd2700a6263f255ea089240f7))
* **memory:** separate access from usefulness — stop search touching, add refutation ([c6fdde5](https://github.com/susomejias/rembric/commit/c6fdde5d34508352f054acd7de4ccb4e9147937e))
* **recall:** add relevance channel, abstention, diversity cap, and procedural memory type ([6840d67](https://github.com/susomejias/rembric/commit/6840d6741293aa11cbb0f0380f39653a71456720))


### Bug Fixes

* **dashboard:** answer 403 instead of 500 when a post body is not a form ([86374ff](https://github.com/susomejias/rembric/commit/86374ff0d3634479b9a42594100f58f18903c1fc))
* **dashboard:** clamp the page query param so a huge value cannot 500 a view ([51ef0d1](https://github.com/susomejias/rembric/commit/51ef0d14f57a37c346fe5e423a0577bb69e17a8a))
* **dashboard:** style the entities filter checkbox and unstick the rebuild button ([323e7c6](https://github.com/susomejias/rembric/commit/323e7c65c384d16e78b8272d434d237f419eed46))
* **db:** bound the purge, correct the entity-links schema, and stabilise plans ([bb6acc1](https://github.com/susomejias/rembric/commit/bb6acc1f1b8837180db2ac8fbf8b7a9d156c297a))
* **dev:** override the dev stack healthcheck away from the distroless node path ([d91e65b](https://github.com/susomejias/rembric/commit/d91e65baa75a2bc4aada2d0a4895428db03894c6))
* **entities:** harden extraction patterns against ReDoS and non-terminal suffixes ([f450f82](https://github.com/susomejias/rembric/commit/f450f8287efa9c0049be2cb940e28e193a40d1a2))
* **entities:** persist the recipe marker before truncating the index ([fc6e2ff](https://github.com/susomejias/rembric/commit/fc6e2ff63b7efe1b2616e41266ee35b9be4172ce))
* **entities:** stop one oversized memory wedging the backfill drain forever ([ec29908](https://github.com/susomejias/rembric/commit/ec29908561ed167e98a61f002feb3c5e10f8d179))
* **mcp:** admit the kind discriminator in memory.doctor's lastRunOps ([3fab747](https://github.com/susomejias/rembric/commit/3fab747ddeb21a181ee9238f6992f17994bd0721))
* **mcp:** make the entity and topic_key contracts true, and record refutation ([46d5ded](https://github.com/susomejias/rembric/commit/46d5dedce49e147d2d60b6888c356c69974c59c6))
* **memory:** correct escalation timing and surface refuted rows in the review queue ([921c1ff](https://github.com/susomejias/rembric/commit/921c1ff5666e4d4d86e3a314d142404b0a660ded))
* **memory:** drop entity rows before purging their memory ([4a345e0](https://github.com/susomejias/rembric/commit/4a345e06c958f479c5d6498f16ab2c261e953b3f))
* **memory:** honour the documented "any but archived" status default ([1814f7b](https://github.com/susomejias/rembric/commit/1814f7bde1555de16f309bbccab31c983c4fd61c))
* **memory:** keep escalation out of the decay axis and surface it at read time ([ab7a5f6](https://github.com/susomejias/rembric/commit/ab7a5f6b7dc727e1e8dc692b45e6e6a4097093ac))
* repair 10 audited defects across sessions, consolidation, and memory retrieval ([cfb5c04](https://github.com/susomejias/rembric/commit/cfb5c047d88335495b5b7e42136dee84cc0cb6f0))
* **retrieval:** correct inverted FTS similarity and undersized rank window ([6b12ee6](https://github.com/susomejias/rembric/commit/6b12ee61df39f31173aa465e505345476c176426))
* **retrieval:** ship the diversity cap disabled until the eval can see it ([57b39a2](https://github.com/susomejias/rembric/commit/57b39a20de1b62e075c68ba7c0dec8e0afb2bc40))


### Performance

* **db:** index the review-axis confirmation subqueries ([f20b8fa](https://github.com/susomejias/rembric/commit/f20b8fabef6bdd2c6293ba9963297880260b2a8a))

## [0.24.12](https://github.com/susomejias/rembric/compare/server-v0.24.11...server-v0.24.12) (2026-07-20)


### Features

* **mcp:** add memory.archive tool for agent-initiated retirement ([6b8c8c9](https://github.com/susomejias/rembric/commit/6b8c8c9c0733892d1694e8224df303675f2ac31f))

## [0.24.11](https://github.com/susomejias/rembric/compare/server-v0.24.10...server-v0.24.11) (2026-07-17)


### Bug Fixes

* **update-check:** pick the highest server semver instead of trusting GitHub's release order ([f460927](https://github.com/susomejias/rembric/commit/f4609279dabb8f8e55848d3e8d8cba88955cc558))

## [0.24.10](https://github.com/susomejias/rembric/compare/server-v0.24.9...server-v0.24.10) (2026-07-17)


### Features

* **self-update:** reclaim stale upgrader containers and dangling images before each update ([4f3b6ea](https://github.com/susomejias/rembric/commit/4f3b6ea31faa323230611235b762eb3bfb6c20fd)), closes [#282](https://github.com/susomejias/rembric/issues/282)

## [0.24.9](https://github.com/susomejias/rembric/compare/server-v0.24.8...server-v0.24.9) (2026-07-17)


### Features

* **installer:** update-all — action=update with no --agent updates every outdated plugin ([a188587](https://github.com/susomejias/rembric/commit/a188587c7dffd31a0920beca327eaf1cd025d733)), closes [#262](https://github.com/susomejias/rembric/issues/262)


### Bug Fixes

* **dashboard:** escape prompt tags/project slug (XSS), sanitize search-box FTS queries ([0ea09a2](https://github.com/susomejias/rembric/commit/0ea09a28c3b3e05aa43cfd57336acc1c4a6ee694))
* **db:** close FTS5 dangling-posting leak, memory_vec status race, embed-worker polling ([74fbe18](https://github.com/susomejias/rembric/commit/74fbe181afbd835c3eb324ad6a093b9e282c3829))
* **server:** unify internal-error handling, close session-route project bypass ([3cb64f4](https://github.com/susomejias/rembric/commit/3cb64f4654e5bf9072432332032c83afa9f8782f))


### Performance

* **auth:** cache verified token lookups, skip scrypt on repeat requests ([009720d](https://github.com/susomejias/rembric/commit/009720dfaf222f5d427ffe701198796ff94248ed)), closes [#266](https://github.com/susomejias/rembric/issues/266)
* **db:** materialize memory_replaces derived edge table ([94d98cf](https://github.com/susomejias/rembric/commit/94d98cff97a892835b8a56bd04a5954110924630))
* **db:** tune connection pragmas, index recentForContext, rewrite purge predicate ([6d839f7](https://github.com/susomejias/rembric/commit/6d839f78cc4cb92abbebb1db0eed08e5325b39c4))

## [0.24.8](https://github.com/susomejias/rembric/compare/server-v0.24.7...server-v0.24.8) (2026-07-16)


### Bug Fixes

* **consolidation:** keep topic_key convergence on undo + UNIQUE index ([9aa5d13](https://github.com/susomejias/rembric/commit/9aa5d13f527ef77333191da57ffc3861f12f4328))
* **mcp:** harden scope/authz on compare, sessionId, and timeline ([3cc9324](https://github.com/susomejias/rembric/commit/3cc9324d0c846a54df1f70a3767abab7ad813350))

## [0.24.7](https://github.com/susomejias/rembric/compare/server-v0.24.6...server-v0.24.7) (2026-07-15)


### Bug Fixes

* **plugin:** correct awk transcript fallback (regexp constant as function arg) ([10fca8b](https://github.com/susomejias/rembric/commit/10fca8bced5614240695320cab3c59b4ef7f610f))

## [0.24.6](https://github.com/susomejias/rembric/compare/server-v0.24.5...server-v0.24.6) (2026-07-13)


### Features

* **mcp:** reinforce explicit sessionId across session-attaching tools ([b14368d](https://github.com/susomejias/rembric/commit/b14368d8c6814840f1c4b88eca5e24c185f84191))

## [0.24.5](https://github.com/susomejias/rembric/compare/server-v0.24.4...server-v0.24.5) (2026-07-13)


### Bug Fixes

* **server:** truncate over-length session summary/title instead of rejecting ([6d77846](https://github.com/susomejias/rembric/commit/6d7784632f28127c89061c6c85278c5f0add0114))

## [0.24.4](https://github.com/susomejias/rembric/compare/server-v0.24.3...server-v0.24.4) (2026-07-12)


### Features

* **plugin:** calibrate curation nudges + Hermes per-turn title parity ([db3092e](https://github.com/susomejias/rembric/commit/db3092ed3e14b5a589661c99d15bf6737aecad65))

## [0.24.3](https://github.com/susomejias/rembric/compare/server-v0.24.2...server-v0.24.3) (2026-07-12)


### Features

* **server:** resolve MCP session auto-attachment via bridge instance id ([ea71092](https://github.com/susomejias/rembric/commit/ea71092cec61c9c1b27ce637bc8d7036021f1fcb))


### Bug Fixes

* **server:** stop guessing which concurrent session an MCP write belongs to ([75534f7](https://github.com/susomejias/rembric/commit/75534f77dcc6283642de435ddcb1d1b8d58a376a))
* **server:** stop purging sessions with a genuine but uncurated summary ([28bc9e3](https://github.com/susomejias/rembric/commit/28bc9e3a86c393076620151e1f8f270093e97ea3))

## [0.24.2](https://github.com/susomejias/rembric/compare/server-v0.24.1...server-v0.24.2) (2026-07-12)


### Bug Fixes

* **server:** close session context-pollution gap and harden session lifecycle ([961f7d0](https://github.com/susomejias/rembric/commit/961f7d04932efad7c12d2919a2ca9c0cf532003a))
* **server:** document merge-commit requirement for release-please ([011564e](https://github.com/susomejias/rembric/commit/011564e1366da8ab0e6a94e5c8a4e31a77dc7896))

## [0.24.1](https://github.com/susomejias/rembric/compare/server-v0.24.0...server-v0.24.1) (2026-07-12)


### Features

* improve recall ranking and cross-client plugin parity ([#228](https://github.com/susomejias/rembric/issues/228)) ([42e9809](https://github.com/susomejias/rembric/commit/42e98093c6ea7c9364dcd3eddbd605379368ffd8))


### Bug Fixes

* **mcp:** stabilize roots-discovery flake on slow CI ([#226](https://github.com/susomejias/rembric/issues/226)) ([d62d254](https://github.com/susomejias/rembric/commit/d62d25436a7476e5fbab65f2d991814c71aa79d3))

## [0.24.0](https://github.com/susomejias/rembric/compare/server-v0.23.0...server-v0.24.0) (2026-07-11)


### ⚠ BREAKING CHANGES

* **server:** migration 0017 revokes all existing OAuth access/refresh tokens, so OAuth clients must re-authorize once. Static bearer tokens are unaffected.

### Features

* **server:** harden API/MCP/OAuth auth surface ([#224](https://github.com/susomejias/rembric/issues/224)) ([589b245](https://github.com/susomejias/rembric/commit/589b24580ae62b222c82a931b4596134bb79cd35))

## [0.23.0](https://github.com/susomejias/rembric/compare/server-v0.22.2...server-v0.23.0) (2026-07-08)


### ⚠ BREAKING CHANGES

* **mcp:** tool calls with insufficient token scope now fail with forbidden.

### Features

* **dashboard:** cross-navigation, sessions filters, shared helpers, SHOWING fix ([#219](https://github.com/susomejias/rembric/issues/219)) ([dc65213](https://github.com/susomejias/rembric/commit/dc65213e625b9636d91d93cb4e85265ac20620e3))
* **mcp:** enforce token authorization across the MCP tool surface ([#215](https://github.com/susomejias/rembric/issues/215)) ([4425d51](https://github.com/susomejias/rembric/commit/4425d51797eac6e057fbe9c9a4c9140571f8280b))


### Bug Fixes

* **mcp:** require write authorization for project.use autocreate ([#223](https://github.com/susomejias/rembric/issues/223)) ([f320036](https://github.com/susomejias/rembric/commit/f320036c91a0b17dae0b568c490224ec141976f7))
* **plugin:** redact &lt;private&gt; spans in bash and python clients ([#216](https://github.com/susomejias/rembric/issues/216)) ([c83bdcb](https://github.com/susomejias/rembric/commit/c83bdcb168bb3969c2471bf26b1aba1b309aa76b))


### Performance

* **server:** partition-pruned save-time knn, bounded sampling, fair scoped orphaning ([#218](https://github.com/susomejias/rembric/issues/218)) ([e89fb79](https://github.com/susomejias/rembric/commit/e89fb79e35284ed9a41f6b5e2e507dddab8dc608))

## [0.22.2](https://github.com/susomejias/rembric/compare/server-v0.22.1...server-v0.22.2) (2026-07-07)

### Bug Fixes

- **mcp:** align session summary cap description ([#212](https://github.com/susomejias/rembric/issues/212)) ([0a7b591](https://github.com/susomejias/rembric/commit/0a7b5914cfd14b829948f73ae264d1c9411a0af7))

## [0.22.1](https://github.com/susomejias/rembric/compare/server-v0.22.0...server-v0.22.1) (2026-06-27)

### Features

- **consolidation:** type-aware decay thresholds ([#203](https://github.com/susomejias/rembric/issues/203)) ([0acb6c2](https://github.com/susomejias/rembric/commit/0acb6c2fb7668a44f64b316c4c8f93a94fa69917))
- **dashboard:** true filtered totals on list pages ([#204](https://github.com/susomejias/rembric/issues/204)) ([6615fc0](https://github.com/susomejias/rembric/commit/6615fc0dc2d4a9f7567c7f8efdf6ef5e65dad4cb))
- **mcp:** batch judgment + dismissed-candidate suppression ([#201](https://github.com/susomejias/rembric/issues/201)) ([09bae6d](https://github.com/susomejias/rembric/commit/09bae6d23a5198dcac3b9a54c34489792a24a9f1))
- **mcp:** memory.search projection + batch get + FTS unification ([#202](https://github.com/susomejias/rembric/issues/202)) ([0a347ac](https://github.com/susomejias/rembric/commit/0a347ac7324af71daec0db96656d37aca04ca684))

### Bug Fixes

- **server:** dashboard, mcp, and consolidation correctness quick wins ([#200](https://github.com/susomejias/rembric/issues/200)) ([e28e015](https://github.com/susomejias/rembric/commit/e28e0151dd444049921b3760d1e793851b0ef9c6))

## [0.22.0](https://github.com/susomejias/rembric/compare/server-v0.21.24...server-v0.22.0) (2026-06-23)

### ⚠ BREAKING CHANGES

- memory.save rejects calls without a title, and deployments re-embed the whole corpus once on first boot (search stays available via the lexical branch throughout the backfill).

### Features

- required, searchable memory titles ([#196](https://github.com/susomejias/rembric/issues/196)) ([90c57ce](https://github.com/susomejias/rembric/commit/90c57ce7875955f9fab499d4af3000438956f7e8))

## [0.21.24](https://github.com/susomejias/rembric/compare/server-v0.21.23...server-v0.21.24) (2026-06-23)

### Features

- **dashboard:** render memory/session/prompt/judgment content as markdown ([#194](https://github.com/susomejias/rembric/issues/194)) ([2f71269](https://github.com/susomejias/rembric/commit/2f71269e33823a56b5e58a67154304ed22d6dded))

## [0.21.23](https://github.com/susomejias/rembric/compare/server-v0.21.22...server-v0.21.23) (2026-06-20)

### Refactor

- **consolidation:** remove LLM-era residue and tidy the journal schema ([#188](https://github.com/susomejias/rembric/issues/188)) ([7e7382f](https://github.com/susomejias/rembric/commit/7e7382fafdbbf5e4eb04ae393f302378fa607454))
- **mcp:** organize tool handlers one domain per module ([#189](https://github.com/susomejias/rembric/issues/189)) ([7027a39](https://github.com/susomejias/rembric/commit/7027a39a688c7fcc7fa8012933181480fa443e04))

## [0.21.22](https://github.com/susomejias/rembric/compare/server-v0.21.21...server-v0.21.22) (2026-06-20)

### Bug Fixes

- **ci:** prefetch + cache embedding model so the real-embedder test resolves offline ([#186](https://github.com/susomejias/rembric/issues/186)) ([f29f9c8](https://github.com/susomejias/rembric/commit/f29f9c8358d20eeac4ad6373346d3efe21c1f70a))

## [0.21.21](https://github.com/susomejias/rembric/compare/server-v0.21.20...server-v0.21.21) (2026-06-16)

### Documentation

- **server:** clarify memory.search is hybrid + paginable in tool description ([#172](https://github.com/susomejias/rembric/issues/172)) ([68144d3](https://github.com/susomejias/rembric/commit/68144d363a69cafcf9f88efb4605896bc4b67882))

## [0.21.20](https://github.com/susomejias/rembric/compare/server-v0.21.19...server-v0.21.20) (2026-06-16)

### Features

- **server:** lower memory.search default result count 20→8 ([#170](https://github.com/susomejias/rembric/issues/170)) ([e4989db](https://github.com/susomejias/rembric/commit/e4989db041e56aeac614b99cd43989cef6b84131))

## [0.21.19](https://github.com/susomejias/rembric/compare/server-v0.21.18...server-v0.21.19) (2026-06-16)

### Features

- **server:** hybrid semantic search in memory.search (dense + FTS, RRF) ([#168](https://github.com/susomejias/rembric/issues/168)) ([c131619](https://github.com/susomejias/rembric/commit/c131619ff3cde4814eaf63f02ea621aeef0ef030))

## [0.21.18](https://github.com/susomejias/rembric/compare/server-v0.21.17...server-v0.21.18) (2026-06-16)

### Features

- **server:** MCP tool annotations + output schemas ([#165](https://github.com/susomejias/rembric/issues/165)) ([98dc493](https://github.com/susomejias/rembric/commit/98dc493029f74108bab22590601da47d8db29ab8))

## [0.21.17](https://github.com/susomejias/rembric/compare/server-v0.21.16...server-v0.21.17) (2026-06-15)

### Bug Fixes

- **server:** echo OAuth scope vocabulary in /token + ChatGPT connector docs ([#163](https://github.com/susomejias/rembric/issues/163)) ([4a76535](https://github.com/susomejias/rembric/commit/4a76535a34b1ad6639282b352bda37254f980aaf))

## [0.21.16](https://github.com/susomejias/rembric/compare/server-v0.21.15...server-v0.21.16) (2026-06-15)

### Features

- **server:** OAuth 2.1 authorization server for remote MCP connectors ([#161](https://github.com/susomejias/rembric/issues/161)) ([d47d2d8](https://github.com/susomejias/rembric/commit/d47d2d8448023eaa9ef5b8669bcc6debce45506e))

## [0.21.15](https://github.com/susomejias/rembric/compare/server-v0.21.14...server-v0.21.15) (2026-06-14)

### Bug Fixes

- **self-update:** use absolute /nodejs/bin/node in distroless image ([#158](https://github.com/susomejias/rembric/issues/158)) ([5277100](https://github.com/susomejias/rembric/commit/5277100da02850b1e2ee9c1aee9bf39809dbb786))

## [0.21.14](https://github.com/susomejias/rembric/compare/server-v0.21.13...server-v0.21.14) (2026-06-14)

### Performance

- **ci:** native per-arch docker builds (no QEMU) + slim distroless runtime ([#156](https://github.com/susomejias/rembric/issues/156)) ([8d17d14](https://github.com/susomejias/rembric/commit/8d17d14b3c0efe0c2298ea2594d8440d0e2db767))

## [0.21.13](https://github.com/susomejias/rembric/compare/server-v0.21.12...server-v0.21.13) (2026-06-14)

### Features

- strengthen the memory protocol nudge (proactive save/recall/summarize) across all four clients ([#153](https://github.com/susomejias/rembric/issues/153)) ([c18d4b5](https://github.com/susomejias/rembric/commit/c18d4b58526d9d672e2083809c001750e1c2a52f))

## [0.21.12](https://github.com/susomejias/rembric/compare/server-v0.21.11...server-v0.21.12) (2026-06-14)

### Features

- **dashboard:** surface review state on /dashboard/memories ([#149](https://github.com/susomejias/rembric/issues/149)) ([7b3ea4e](https://github.com/susomejias/rembric/commit/7b3ea4eb2bd192dcf2466d436b2e153c22e18b57))
- **mcp:** trim memory.context default list sizes ([#142](https://github.com/susomejias/rembric/issues/142)) ([7a8edfd](https://github.com/susomejias/rembric/commit/7a8edfd51b9f62dbda8390fe03e44e3ee5d13c79))
- **memory:** derived review state (needs_review) axis ([#141](https://github.com/susomejias/rembric/issues/141)) ([f0f4347](https://github.com/susomejias/rembric/commit/f0f4347dc408366f8798ab08be5e24fa3de42df3))

## [0.21.11](https://github.com/susomejias/rembric/compare/server-v0.21.10...server-v0.21.11) (2026-06-13)

### Features

- **mcp:** add memory.about update-guidance tool ([#129](https://github.com/susomejias/rembric/issues/129)) ([0a57244](https://github.com/susomejias/rembric/commit/0a572448fa45dee149de7d1a05d85515ff6f8cd5))

## [0.21.10](https://github.com/susomejias/rembric/compare/server-v0.21.9...server-v0.21.10) (2026-06-13)

### Features

- **plugin:** unified TUI installer for server + all clients ([#122](https://github.com/susomejias/rembric/issues/122)) ([3be359a](https://github.com/susomejias/rembric/commit/3be359aec1cc97a1d1623b30db76212a82fb2d59))

## [0.21.9](https://github.com/susomejias/rembric/compare/server-v0.21.8...server-v0.21.9) (2026-06-08)

### Features

- **server:** expose session title in memory.context ([#120](https://github.com/susomejias/rembric/issues/120)) ([8becbbd](https://github.com/susomejias/rembric/commit/8becbbd18c053836126510eb8198f205955a99cf))

## [0.21.8](https://github.com/susomejias/rembric/compare/server-v0.21.7...server-v0.21.8) (2026-06-07)

### Features

- **server:** rename memory.get_session → memory.session_get (+ docs) ([#118](https://github.com/susomejias/rembric/issues/118)) ([2a9958d](https://github.com/susomejias/rembric/commit/2a9958df9885b9da9c6717eefeda2a38b9514b04))

## [0.21.7](https://github.com/susomejias/rembric/compare/server-v0.21.6...server-v0.21.7) (2026-06-07)

### Features

- **server:** bound memory.context snippets + server-side summary cap & memory.get_session ([#116](https://github.com/susomejias/rembric/issues/116)) ([2572a81](https://github.com/susomejias/rembric/commit/2572a81c84ea6cf54c9a968118e8b7d9102966ea))

## [0.21.6](https://github.com/susomejias/rembric/compare/server-v0.21.5...server-v0.21.6) (2026-06-07)

### Refactor

- **server:** extract repository layer (confine all SQL to src/db/) ([#114](https://github.com/susomejias/rembric/issues/114)) ([b8f68c2](https://github.com/susomejias/rembric/commit/b8f68c24d0408573aee0b35d2264e31011be8ba2))

## [0.21.5](https://github.com/susomejias/rembric/compare/server-v0.21.4...server-v0.21.5) (2026-06-07)

### Features

- **server:** align consolidation dashboard with the deterministic sweep ([#111](https://github.com/susomejias/rembric/issues/111)) ([dcc8299](https://github.com/susomejias/rembric/commit/dcc829937821ff8a812d4349364ddd14c98d69f7))

## [0.21.4](https://github.com/susomejias/rembric/compare/server-v0.21.3...server-v0.21.4) (2026-06-07)

### Features

- **server:** manual update check from the dashboard ([#109](https://github.com/susomejias/rembric/issues/109)) ([88321fe](https://github.com/susomejias/rembric/commit/88321fe065ead06eb549c3c8b1d56fc89f8b80e8))

## [0.21.3](https://github.com/susomejias/rembric/compare/server-v0.21.2...server-v0.21.3) (2026-06-06)

### Features

- **server:** drop dashboard table id columns and sort active sessions first ([#107](https://github.com/susomejias/rembric/issues/107)) ([cc84a2b](https://github.com/susomejias/rembric/commit/cc84a2bd233cf7e147c3bbaad84799de95a0a084))

## [0.21.2](https://github.com/susomejias/rembric/compare/server-v0.21.1...server-v0.21.2) (2026-06-06)

### Features

- **server:** one-click self-update from the dashboard ([#106](https://github.com/susomejias/rembric/issues/106)) ([ad152db](https://github.com/susomejias/rembric/commit/ad152db139cc28f4660506b74ed432635381238c))
- **server:** show server version in dashboard brand ([#104](https://github.com/susomejias/rembric/issues/104)) ([168220c](https://github.com/susomejias/rembric/commit/168220c99e5fe0ac0a96afe540bbc566ae9a2937))

## [0.21.1](https://github.com/susomejias/rembric/compare/server-v0.21.0...server-v0.21.1) (2026-06-05)

### Bug Fixes

- **server:** retry model bake on HF 429 + optional hf_token build secret ([#101](https://github.com/susomejias/rembric/issues/101)) ([36b3b5c](https://github.com/susomejias/rembric/commit/36b3b5c09c599699388e973f3527f3fb3514bd01))

## [0.21.0](https://github.com/susomejias/rembric/compare/server-v0.20.1...server-v0.21.0) (2026-06-05)

### ⚠ BREAKING CHANGES

- **server:** env vars OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_EMBEDDING_MODEL, EMBEDDING_PROVIDER, EMBEDDING_ENABLED, CANDIDATE_VEC_THRESHOLD and CANDIDATE_FTS_THRESHOLD are removed (ignored with the boot warning). memory.doctor embeddings block is now { model, backlog }. Embeddings are always on: lazy in-process model (ONNX q8, 768 dims), model-identity marker wipes stale vectors and the drain re-embeds resumably; similarity thresholds become engine constants (vec 0.70 sandbox-calibrated, distribution telemetry on drain).
- **server:** env vars LLM_PROVIDER, OPENAI_MODEL, CONSOLIDATION_ENABLED, CONSOLIDATION_CRON and CONSOLIDATION_BATCH_SIZE are removed (ignored with a boot warning). memory.doctor drops the llm block. Decay + pending-relation orphaning now run as a throttled deterministic sweep on session start; aged pendings surface in memory.context.pendingJudgments[] for agent-side memory.judge, and are orphaned after JUDGMENT_ORPHAN_DEADLINE_MS (14d).

### Features

- **server:** deterministic consolidation — remove chat LLM and cron ([#97](https://github.com/susomejias/rembric/issues/97)) ([b43fbdb](https://github.com/susomejias/rembric/commit/b43fbdb1783cca3486013576d8acd30461f621dd))
- **server:** in-process embeddings — gte-multilingual-base baked into the image ([#99](https://github.com/susomejias/rembric/issues/99)) ([70a0915](https://github.com/susomejias/rembric/commit/70a0915b00adfc0aa2f3c33c8b378b360262b17a))

## [0.20.1](https://github.com/susomejias/rembric/compare/server-v0.20.0...server-v0.20.1) (2026-05-22)

### Bug Fixes

- **server:** disable foreign_keys around migrations to unblock parent-table rebuilds ([#93](https://github.com/susomejias/rembric/issues/93)) ([28f93cf](https://github.com/susomejias/rembric/commit/28f93cf91378dad4b963ca03e5c57802c790abab))

## [0.20.0](https://github.com/susomejias/rembric/compare/server-v0.19.0...server-v0.20.0) (2026-05-22)

### ⚠ BREAKING CHANGES

- **sessions:** cap session.summary at 2000 chars (DB CHECK + reject/truncate) ([#87](https://github.com/susomejias/rembric/issues/87))

### Features

- **plugin:** wire pre/post-compact hooks + opencode recall paridad ([#88](https://github.com/susomejias/rembric/issues/88)) ([e78b4e4](https://github.com/susomejias/rembric/commit/e78b4e43813b14138ff7c53d20d54ee9ad4d8c9b))
- **sessions:** cap session.summary at 2000 chars (DB CHECK + reject/truncate) ([#87](https://github.com/susomejias/rembric/issues/87)) ([0af3b8a](https://github.com/susomejias/rembric/commit/0af3b8a36e4125c021fb5e6df811486016b24c73))

### Bug Fixes

- **plugin:** point per-client install URLs at apps/plugin after monorepo restructure ([#75](https://github.com/susomejias/rembric/issues/75)) ([bd26271](https://github.com/susomejias/rembric/commit/bd2627178e65ac46c8488d3e7b9cd3e405b489b2))

## [0.19.0](https://github.com/susomejias/rembric/compare/server-v0.18.1...server-v0.19.0) (2026-05-21)

### Features

- **dashboard:** replace pending tile with recent judgments + detail view ([#74](https://github.com/susomejias/rembric/issues/74)) ([be80ab8](https://github.com/susomejias/rembric/commit/be80ab8f2213515e7942339461fdbce8dc352b1e))
- **server:** add operator surface for curated user prompts ([#73](https://github.com/susomejias/rembric/issues/73)) ([5950667](https://github.com/susomejias/rembric/commit/5950667dd81ece2d549782266d69f26bf71887b2))
- **sessions:** filter empty sessions from memory.context recentSessions ([#71](https://github.com/susomejias/rembric/issues/71)) ([5ed921a](https://github.com/susomejias/rembric/commit/5ed921a193e203adef44dfb9f1518a0ed60a2d4e))

## [0.18.1](https://github.com/susomejias/rembric/compare/server-v0.18.0...server-v0.18.1) (2026-05-21)

### Bug Fixes

- **docker:** use pnpm deploy for runtime image to resolve workspace deps ([#69](https://github.com/susomejias/rembric/issues/69)) ([80f710c](https://github.com/susomejias/rembric/commit/80f710cb1d3bec88d948391d4ac4a7e8c8d75dfd))

## [0.18.0](https://github.com/susomejias/rembric/compare/server-v0.17.0...server-v0.18.0) (2026-05-20)

### ⚠ BREAKING CHANGES

- public plugin install URLs move from .../main/plugin/.<client>-plugin/install.sh to .../main/apps/plugin/.<client>-plugin/install.sh. Old URLs return 404. Marketplace pointers in .claude-plugin/marketplace.json (source) and .codex-plugin/marketplace.json (source.path) change from "./plugin" to "./apps/plugin". Release-please tags now use component-prefixed format (server-vX.Y.Z, claude-code-vX.Y.Z, etc.); legacy vX.Y.Z tags stay in history but no new ones are minted.

### Features

- restructure monorepo to apps/+packages layout ([#62](https://github.com/susomejias/rembric/issues/62)) ([368d4cc](https://github.com/susomejias/rembric/commit/368d4ccaba983a3eb1d445f20b91faab5c05e05a))

## [0.17.0](https://github.com/susomejias/rembric/compare/v0.16.0...v0.17.0) (2026-05-19)

### Features

- **plugin:** opencode session summary on dispose + auto-config opencode.json ([#60](https://github.com/susomejias/rembric/issues/60)) ([9f7fbe4](https://github.com/susomejias/rembric/commit/9f7fbe4401b57d934f10aa51c2b62c88ede13d7f))

## [0.16.0](https://github.com/susomejias/rembric/compare/v0.15.1...v0.16.0) (2026-05-19)

### Features

- **plugin:** add opencode plugin ([#56](https://github.com/susomejias/rembric/issues/56)) ([081dc23](https://github.com/susomejias/rembric/commit/081dc23749a1031ed5e6371744eb9e07ed1764b9))
- **plugin:** curl-pipe-sh install for opencode + README supported-agents grid ([#58](https://github.com/susomejias/rembric/issues/58)) ([52eddf2](https://github.com/susomejias/rembric/commit/52eddf20f52bfa83e22424c0343f2f80619624a6))

## [0.15.1](https://github.com/susomejias/rembric/compare/v0.15.0...v0.15.1) (2026-05-18)

### Documentation

- add admin dashboard screenshots section to README ([#53](https://github.com/susomejias/rembric/issues/53)) ([b6869f4](https://github.com/susomejias/rembric/commit/b6869f45f114967c45a9358fe13c1e8ab2fc8686))
- replace git clone with curl in Docker Quickstart ([#51](https://github.com/susomejias/rembric/issues/51)) ([12d4193](https://github.com/susomejias/rembric/commit/12d4193c5ce3877ee18efcb8783750211f348850))

## [0.15.0](https://github.com/susomejias/rembric/compare/v0.14.2...v0.15.0) (2026-05-18)

### Features

- initial public release of Rembric ([b161006](https://github.com/susomejias/rembric/commit/b161006fce6ada0f3c3d04f92cc7b29300a0dcff))
