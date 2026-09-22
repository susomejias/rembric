# Feature: migrate-to-nextjs

Owner decision (2026-09-20): **full migration to Next.js**, with **Turborepo only if packages need to be extracted**. Decision taken after three rounds of documented pushback; the record of the counter-evidence lives in Rembric memory topic `architecture-verdict-monorepo-and-framework-migration` and `architecture-mcp-framework-already-present`. This document executes the decision.

## Binding constraints discovered before planning

These are measured facts about the dependencies, not preferences. They determine the migration shape.

1. **The MCP SDK's OAuth handlers are Express middleware.** `apps/server/node_modules/@modelcontextprotocol/sdk` v1.29.0, `server/auth/handlers/*.d.ts`: 5 files import `RequestHandler` from `express`, and 4 also use `express-rate-limit` (`authorize`, `register`, `revoke`, `token`). They cannot be mounted in a Next App Router route handler. `mcpAuthRouter` is what `apps/server/src/server/http.ts:188` mounts, and its own comment says _"The router MUST be installed at the application root."_
2. **The MCP transport speaks Node, not Web.** `StreamableHTTPServerTransport.handleRequest(req: IncomingMessage, res: ServerResponse, parsedBody?)`. A Next route handler receives a Web `Request`. A bridge is required (`mcp-handler` by Vercel is exactly that bridge and is framework-agnostic).
3. **Today's server is a raw `node:http` server composing three surfaces by pathname** (`apps/server/src/server/http.ts`): `/mcp*` → MCP SDK with raw req/res; OAuth paths → a mounted Express app; everything else → Hono via `getRequestListener(honoApp.fetch)`. Next owns the request pipeline, so this composition does not survive intact.
4. **Native modules in the runtime**: `better-sqlite3`, `sqlite-vec`, `onnxruntime-node` (via `@huggingface/transformers`). Runtime is distroless (`apps/server/Dockerfile:128`) and `sharp: false` is a deliberate denial in `pnpm-workspace.yaml::allowBuilds`.

## Branch policy (owner decision, 2026-09-20)

**One branch: `migrate/nextjs`. Nothing lands on `main` until the whole migration is complete and tested.** Rationale: a half-migrated monorepo on `main` would be worse than a long-lived branch.

**Drift mitigation (mandatory):** `main` keeps moving while this branch lives — `release-please` runs there and bumps the two release components on every plugin/server release. Merge `main` into `migrate/nextjs` periodically. That is not landing on `main`; it is refusing to fall behind, and it keeps the final merge reviewable.

## Blocking decision (phase 0) — RESOLVED: Form B

Owner decision: **Form B — Next-native**, with `mcp-handler` for the MCP surface.

Rationale and cost, recorded honestly: this reimplements the OAuth protocol surface as route handlers, reusing the existing `OAuthServerProvider` (`apps/server/src/server/oauth-provider.ts`, 229 lines) and `OAuthService` (`apps/server/src/services/oauth.ts`, 377 lines). The cost is that PKCE validation, redirect/state/CSRF handling, the metadata documents, DCR and rate limiting get written by hand — i.e. exactly the surface `mcpAuthRouter` owns today.

### New prerequisite discovered from `mcp-handler`'s own README

> _"`mcp-handler` 2.x requires the MCP SDK v2 packages (`@modelcontextprotocol/server` ^2.0.0), **zod ^4.2.0**, and Node.js 20+. If you're on `@modelcontextprotocol/sdk` 1.x, use `mcp-handler` 1.x."_

Current: `@modelcontextprotocol/sdk` **1.29.0**, `zod` **3.25.76**. zod blast radius: **10 non-test files + 1 test file, 399 schema declarations** (many of them the _strict_ input schemas the MCP contract depends on).

**Consequence: the zod 3→4 + MCP SDK v2 upgrade must be its own isolated phase, never mixed with the framework migration.** If it is entangled, a failure is attributable to neither. Two sub-paths:

- **B1 — `mcp-handler@1` on SDK 1.29.0.** No major upgrade. Migration proceeds now; adapter sits on a legacy major.
- **B2 — `mcp-handler@2` on SDK v2 + zod 4.** Forward path; requires the isolated upgrade phase first.

Phase 1 is independent of this fork, so extraction proceeds without waiting.

## Target filesystem layout

Aligned with the official create-turbo structure and Vercel's monorepo guidance. Verified sources are cited inline; anything unverified is marked as such rather than presented as convention.

### Verified conventions

| Convention          | Verified fact                                                                                                                                                                                                                                         | Source                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Structure           | `apps/docs`, `apps/web`, `packages/ui`                                                                                                                                                                                                                | turborepo.com `/docs/crafting-your-repository/structuring-a-repository` |
| Naming              | Internal packages take a namespace prefix (`@repo/...`, `@acme/...`). Rembric already uses `@rembric/`, so the prefix is `@rembric/`                                                                                                                  | same page                                                               |
| `turbo.json` key    | **`tasks`**, not `pipeline` (2.x)                                                                                                                                                                                                                     | turborepo.com `/docs/reference/configuration`                           |
| Docker              | `turbo prune <app> --docker` → `./out/json` (install layer) + `./out/full` (source); build from the monorepo root: `docker build -f apps/web/Dockerfile .`; runner copies `.next/standalone`, `.next/static`, `public`; `CMD node apps/web/server.js` | turborepo.com `/docs/guides/tools/docker`                               |
| Monorepo standalone | Tracing root defaults to the project directory, so files outside it are excluded. `outputFileTracingRoot` MUST point at the monorepo root                                                                                                             | nextjs.org `/docs/app/api-reference/config/next-config-js/output`       |

**Unverified, confirm at implementation time:** the `create-turbo` template additionally ships `packages/eslint-config` and `packages/typescript-config` as separate packages. Confirm with a scratch `pnpm create turbo` before adopting that split.

### Current

```text
rembric/
├── apps/
│   ├── server/          everything: server + dashboard + mcp + db + services + embeddings
│   ├── plugin/          5 clients (Claude, Codex, Hermes, opencode, Pi)
│   │   └── mcp-bridge/  published npm package
│   └── landing/         static, esbuild, Cloudflare Pages
├── packages/            EMPTY
├── scripts/             14 CI / spec / mutate / npm-publish files
└── openspec/
```

### Target

```text
rembric/
├── apps/
│   ├── web/                                   NEW: Next.js, owns every HTTP surface
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── layout.tsx                 root shell (today templates.ts:shell)
│   │   │   │   ├── globals.css                core CSS (tokens/base/atoms/layout/patterns/content)
│   │   │   │   ├── healthz/route.ts           GET /healthz
│   │   │   │   ├── mcp/[[...path]]/route.ts   /mcp, /mcp/<slug>  (mcp-handler)
│   │   │   │   ├── .well-known/
│   │   │   │   │   ├── oauth-authorization-server/route.ts
│   │   │   │   │   └── oauth-protected-resource/route.ts
│   │   │   │   ├── {authorize,token,register,revoke}/route.ts   replace mcpAuthRouter
│   │   │   │   ├── api/[slug]/                today /api/:slug/...
│   │   │   │   │   ├── sessions/route.ts
│   │   │   │   │   ├── sessions/[id]/{summary,end,resume,turn,recall-hints}/route.ts
│   │   │   │   │   ├── memory/recall/route.ts
│   │   │   │   │   └── debug/counters/route.ts
│   │   │   │   └── dashboard/
│   │   │   │       ├── layout.tsx             sidebar + mob-bar + modal host
│   │   │   │       ├── page.tsx               /dashboard
│   │   │   │       ├── memories/{page,[id]/page}.tsx
│   │   │   │       ├── sessions/{page,[id]/page}.tsx
│   │   │   │       ├── {prompts,judgments,consolidation,projects,tokens,maintenance,update,entities}/page.tsx
│   │   │   │       ├── login/page.tsx
│   │   │   │       └── oauth/consent/page.tsx
│   │   │   ├── components/                    today dashboard/components.ts (737 L)
│   │   │   ├── lib/                           auth, rate-limit, session-router, validation
│   │   │   └── styles/views/*.module.css      today styles/views/*.css
│   │   ├── public/                            logo, favicon, statics
│   │   ├── next.config.ts                     serverExternalPackages + outputFileTracingRoot
│   │   ├── Dockerfile                         the one published at the end
│   │   └── package.json
│   ├── server/          LIVES until phase 6, then deleted
│   ├── plugin/          UNTOUCHED
│   └── landing/         UNTOUCHED
├── packages/
│   ├── ui/              shared React components (create-turbo convention)
│   ├── db/              SQL CONFINEMENT BOUNDARY
│   │   ├── src/{client,migrate,diagnostics,query-tokenizer,index}.ts
│   │   ├── src/schema/
│   │   ├── src/repositories/
│   │   ├── src/migrations/*.sql               FILENAMES IMMUTABLE
│   │   └── drizzle.config.ts
│   ├── core/            services, consolidation, embeddings
│   └── mcp/             tools, server factory, transport manager
├── scripts/             UNTOUCHED
├── openspec/            UNTOUCHED
└── turbo.json           NEW
```

### Route mapping (measured, not invented)

Current paths read from `apps/server/src/server/{dashboard-router,api-router,http}.ts`:

| Today                                                                                                         | After                                                        |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `/healthz`                                                                                                    | `app/healthz/route.ts`                                       |
| `/mcp`, `/mcp/<slug>`                                                                                         | `app/mcp/[[...path]]/route.ts`                               |
| `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`                            | `app/.well-known/*/route.ts`                                 |
| `OAUTH_EXACT_PATHS` (`/authorize`, `/token`, `/register`, `/revoke`)                                          | `app/<path>/route.ts`                                        |
| `/api/:slug/sessions`, `/api/:slug/sessions/:id/{summary,end,resume,turn,recall-hints}`                       | `app/api/[slug]/sessions/...`                                |
| `/api/:slug/memory/recall`, `/api/:slug/debug/counters`                                                       | `app/api/[slug]/{memory,d}/...`                              |
| `/dashboard/{,memories,sessions,prompts,judgments,consolidation,projects,tokens,maintenance,update,entities}` | `app/dashboard/<view>/page.tsx`                              |
| `/dashboard/login`, `/dashboard/logout`, `/dashboard/oauth/consent`, `/dashboard/_sidebar/toggle`             | `app/dashboard/{login,logout,oauth/consent,_sidebar/toggle}` |
| `/dashboard/assets/*`                                                                                         | `apps/web/public/*` + `next/font/local` for fonts            |

### Traps this layout exposes

Next does not solve these on its own:

1. **`migrations/*.sql` are not JS.** Next traces module dependencies, not `.sql` files. If nothing copies them explicitly, `readdirSync(migrationsDir)` throws. Fail-loud, but they must be copied by hand and resolved by absolute path, not by guessing from the bundle's `import.meta.url`.
2. **`/models` (onnxruntime) is a large binary** that Next neither traces nor bundles. Today the Dockerfile copies it explicitly (`COPY --from=builder /models ./models`). Under standalone output this must be redone, or covered by `outputFileTracingIncludes`.
3. **`better-sqlite3`, `sqlite-vec`, `onnxruntime-node` are native** → `serverExternalPackages` in `next.config.ts` is mandatory, plus a connection singleton that survives HMR.
4. **Next's `public/` is not content-hashed.** The spec today requires fonts served with `Cache-Control: immutable`. Native answer: **`next/font/local`**, which self-hosts, hashes and preloads. This is an improvement over the current `@font-face` setup, not a compromise.
5. **`data.db` in WAL mode drags `data.db-wal` and `data.db-shm`.** Direct consequence for the no-data-loss rule: **snapshots MUST use `VACUUM INTO`, never `cp`.** Copying only the `.db` leaves behind committed transactions that live in the WAL. `VACUUM INTO` already exists at `apps/server/src/db/diagnostics.ts:87`.

### Transition state

Phases 1-5 keep both apps alive:

```text
apps/
├── server/   serving production, untouched
└── web/      growing route by route
```

Owner rule applies here: **the two MUST NEVER point at the same `REMBRIC_DATA_DIR`.** Under `journal_mode = WAL` two writers on one file do not corrupt it, but they interleave writes and produce `SQLITE_BUSY`. Separate directories, separate ports, and every local smoke runs against a **copy**, never the real volume.

The failure mode to blind against: if the new Dockerfile loses `ENV REMBRIC_DATA_DIR=/data` or changes `WORKDIR`, the container creates an empty `data.db` in its ephemeral layer and the dashboard renders empty **with no error at all**. Nothing was deleted, but from the operator's side it is indistinguishable from data loss.

## Data safety (governing constraint, outranks everything else)

Owner rule: existing installations MUST NOT break, and under NO circumstances may database data be lost. UI defects can be fixed afterwards; data loss cannot. Every phase is gated on this.

### The measured silent-failure mechanism

`apps/server/src/db/client.ts`:

```text
~line 44   if (!opts.readonly && !existsSync(opts.dataDir)) mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 })
~line 52   const sqlite = new Database(join(opts.dataDir, 'data.db'), ...)
```

`better-sqlite3` **creates an empty database file if it does not exist**, and the directory is created first if missing. So if `REMBRIC_DATA_DIR` resolves elsewhere after the migration, the server opens a fresh empty `data.db` and starts normally. Nothing is deleted — the real database is still on disk — but the process reads and WRITES a different file. In Docker, if the volume is not mounted at the expected path, those writes land in the container's ephemeral layer and vanish on recreate. The operator sees an empty dashboard and no error.

`apps/server/src/config.ts` ~line 52: `REMBRIC_DATA_DIR: z.string().default(join(homedir(), '.rembric'))`. The default depends on `os.homedir()`, which is unreliable under distroless with `USER 10001:10001`. The production image sets `ENV REMBRIC_DATA_DIR=/data` and `VOLUME ["/data"]` (`WORKDIR /app`); that ENV is what keeps an existing operator's data reachable.

### Two properties already present, to preserve

- `apps/server/src/db/migrate.ts` ~line 95 calls `readdirSync(opts.migrationsDir)` with no try/catch, so a missing migrations directory **throws loudly**. Do not weaken this into a silent skip.
- `apps/server/src/db/diagnostics.ts` ~line 87 exposes `VACUUM INTO`, the correct snapshot primitive.

### Critical detail about migration identity

The `_migrations` table records the migration **filename** only (`INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)`). Renaming a migration file therefore makes the runner **re-apply** it. Migration filenames MUST NOT change during the move — only their directory may.

### WAL and snapshots

The connection runs `journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout = 5000`. In WAL mode committed transactions live in `data.db-wal` alongside `data.db`. Therefore **snapshots MUST use `VACUUM INTO`, never `cp`** — copying only the `.db` leaves committed transactions behind.

### Requirements

- **DS1** — This change SHALL NOT alter how `REMBRIC_DATA_DIR` or the `data.db` filename resolve. The resolved absolute database path and whether the file already existed SHALL be logged at startup, converting a silent failure into a visible one.
- **DS2** — Migration discovery SHALL be proven equivalent across the move: a test SHALL assert the discovered set of `*.sql` files — count, filenames and content hashes — is identical before and after. Migration filenames SHALL NOT change.
- **DS3** — The production image SHALL preserve `ENV REMBRIC_DATA_DIR=/data` and `VOLUME ["/data"]`, and the runtime user SHALL retain read/write access. Verified by an image smoke that mounts a seeded volume and reads a known row back (operator-only).
- **DS4** — `apps/web` and `apps/server` SHALL NEVER point at the same `REMBRIC_DATA_DIR` simultaneously. Separate directories, separate ports, every local smoke against a copy.
- **DS5** — A `VACUUM INTO` snapshot SHALL be taken before the new code applies any migration against a real data directory.
- **DS6** — This change SHALL introduce no destructive migration and SHALL NOT edit, renumber or rename any migration file.

## Scope decisions

- **MCP lives in BOTH places, split by layer (decided 2026-09-20).** `packages/mcp` owns the protocol DOMAIN — tool definitions (~4.6k lines incl. `memory-tools.ts`), the `McpServer` factory, scope resolution (`_shared.ts`, `roots-discovery.ts`), instructions. It knows nothing about HTTP; it couples only to the SDK and `packages/core`. `apps/web` owns the TRANSPORT as a thin `app/mcp/[[...path]]/route.ts` bridging Web `Request` through the SDK v2's native `createMcpHandler` (measured: the handler ships INSIDE `@modelcontextprotocol/server@2.0.0` — `mcp-handler` is redundant, one more dependency deleted), reading the slug from `params.path[0]`. **Route stays `/mcp` (owner decision, zero adaptation):** mcp-handler's own docs state it does not inspect the request pathname (`/api/mcp` is a convention, not a requirement), and Next App Router serves root-level handlers (`app/mcp/[[...path]]` covers both `/mcp` and `/mcp/<slug>`). Keeping `/mcp` costs ZERO: no client-config changes, no `projectIdFromResource` constant change (`path.startsWith('/mcp/')`), no path-scoping spec delta. The `/api/mcp` alternative was considered for namespace consistency with `/api/<slug>/sessions` (real but aesthetic) and rejected: it buys no function and costs client re-pointing + resolver constant + spec delta. Decisive reason: during the transition BOTH servers must serve `/mcp` from the same package, so the MCP cutover is incremental rather than big-bang. Secondary: the MCP tool tests (e.g. `memory-tools.test.ts`, 68 KB) run against services without Next. Deletion note: `apps/server/src/mcp/transport.ts` (the hand-rolled `McpTransportManager`) is expected to DIE in the porting phase — `createMcpHandler` + `verifyBearerToken` replace it; the OAuth authorization server (mcpAuthRouter on SDK 1.x) STAYS: v2 removed `OAuthServerProvider` (v2 only verifies tokens via `verifyBearerToken` — our AS issues codes/tokens via the consent flow), and the two SDK majors coexist by package name (`@modelcontextprotocol/sdk` 1.x + `@modelcontextprotocol/server` 2.0.0).
- **`apps/landing` stays static and untouched.** It is HTML/CSS + esbuild deployed to Cloudflare Pages; its entire value is being static. Next.js would add a runtime to a site with no data, no auth and no interactivity — nothing for the framework to leverage. Owner asked whether it should also move to Next; decided no (2026-09-20).
- **Deferred opportunity — `packages/brand`.** The webfonts are duplicated byte-for-byte between the dashboard (`apps/server/src/dashboard/public/assets/fonts/`) and the landing (`apps/landing/public/assets/fonts/`): `space-grotesk-700`, `inter-400` and `jetbrains-mono-400` all md5-identical. Extracting a brand package (fonts + tokens + logo) consumed by both is the correct fix and fits the monorepo shape, but it is NOT part of this migration — it would widen an already large change. Revisit after the port lands, when `next/font/local` also needs a canonical font source.

## Process model in apps/web (the consolidation/updater question, 2026-09-20)

Owner question: how do the consolidation cron and the updater fit the Next server? Answers, per component:

- **Bootstrap → `instrumentation.ts` `register()`** — Next's official once-per-boot hook replaces `apps/server/src/server/bootstrap.ts`: open the DB (migrations run inside createDb — live-proven: the standalone smoke applied all 37), banner, process state. Nothing invented; it is the framework's bootstrap surface.
- **Consolidation sweep → NO cron exists to port.** The sweep is deterministic and throttled on session activity ("no cron" is a documented design decision, not an accident): its trigger is a service call in the request path, not a timer. Both servers invoke it from their MCP/API routes identically, so the ported routes fire it unchanged. If a time-based sweep is ever wanted, it is a separate script + OS scheduler — not invented now.
- **Updater → split in two.** (a) The version check (dashboard badge) ports trivially: a server component calls the same update-check service. (b) The self-upgrade orchestrator LEAVES the app: a process replacing itself while serving is fragile; in Docker (the primary distribution) the upgrade is pulling the new image, and in the TUI (non-Docker) flow `install.sh`/upgrade-helper already own the swap at the deployment layer. The port DELETES the in-process orchestrator from the served app.
- **Embedder → unchanged.** Lazy `loadEmbedder()` (dynamic import, measured single occurrence) fires when a route uses embeddings; `/models` reaches the process via the Docker COPY (absolute path, immune to tracing). The standalone onnxruntime-binding tracing hole is the port's next packaging task (measured by the tracing worker as the same class as sqlite-vec, UNVERIFIED until a route wires the embedder).

## UI STACK (owner decision, 2026-09-20): shadcn/ui + Tailwind v4, total redesign

Owner decision after the hand-rolled-CSS recommendation: **shadcn/ui, maximum use of its components, keep the color theme**. This supersedes the hand-rolled-CSS recommendation — under the governing objective ("maximum framework leverage, best possible end state"), the 3.8k-line CSS rewrite is work the identity redesign does anyway.

Key fact that makes it fit: shadcn is NOT a black-box dependency — components are COPIED into `apps/web/src/components/ui/` and owned/edited by the repo. Its theming is CSS variables, so the color theme maps directly:

- **Kept (as theme tokens)**: the lime brand → `--primary` (fill role), the light-surface accent (olive ~#5f8309) → a semantic text token, warn/danger semantic tokens, dark + light modes via the `.dark` class, fonts self-hosted via `next/font/local` (Space Grotesk / Inter / JetBrains Mono → shadcn font variables).
- **The identity-A glass layer (liquid-glass chrome) is hand-CSS on top** — no library provides it; it is a custom utility/component layer above shadcn's theming.
- **Deleted by the redesign**: `dashboard/styles/core/{atoms,layout,patterns,content}.css` bodies replaced by shadcn components; `components.ts` HTML-string helpers become React components; the locked brutalist token contract in the dashboard spec is REWRITTEN by the identity change (that was the precondition).
- **Added (supply-chain-checked at install: all pure JS, no lifecycle scripts; cooldown per policy)**: `tailwindcss` v4 (CSS-first `@theme`), `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `@radix-ui/*` per adopted component.
- **Client data**: React Query stays scoped (polling, search, optimistic actions); data-dense tables via RSC + shadcn Table; native `<dialog>` retained where it suffices.
- The identity OpenSpec change carries this decision: it REWRITES the dashboard capability's visual contract (locked brutalist tokens die — the precondition), fixes the UI stack, and defines the glass layer. Unblocks the dashboard port.

## Midday design reference (owner request, 2026-09-20)

The owner reviewed midday-ai/midday and wants its design lines replicated with the Rembric accent palette. Cloned to /tmp/midday-review for reference. The 7 design lines to adopt:

1. **Hover-expand sidebar with rounded corners** — narrow by default (70px, icons only), expands to 240px on hover with `duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]`. Rounded `rounded-tl-[10px] rounded-bl-[10px]` on the sidebar container (Midday's visual signature). Replaces the click-toggle.
2. **Sheets for detail views** — memory/session/token details as slide-over panels (shadcn `Sheet`), not separate routes. Keeps list context visible.
3. **Column-specific table skeletons** — `SkeletonCell` per column type matching the table structure, not a generic spinner.
4. **Command palette (Cmd+K)** — global search modal for navigating to any view, memory, or project.
5. **Per-table empty states with CTAs** — contextual with illustration + create button, not generic text.
6. **`useSuspenseQuery` + Suspense boundaries** — TanStack Query v5 for the interactive islands; skeleton renders automatically.
7. **Fixed sidebar + inset content container** — the content lives in a rounded container inset from the sidebar, creating visual separation.

NOT adopted: tRPC (RSC + Server Actions instead), Midday's AI chat (not Rembric), the time tracker (not applicable), the Tauri desktop shell.

## Tasks

### Phase 0 — decision and scaffolding

- [ ] 0.1 Record the Form A / Form B decision before any code is written.
- [ ] 0.2 Create branch `migrate/nextjs` from `main`; confirm the tree is clean.
- [ ] 0.3 Open the OpenSpec change (mandatory: this alters load-bearing invariants and the whole HTTP surface).

### Phase 1 — extract packages (no behaviour change)

- [ ] 1.1 Extract `packages/db` (schema + repositories + diagnostics) from `apps/server/src/db/`.
- [ ] 1.2 Extract `packages/core` (services, consolidation, embeddings) from `apps/server/src/{services,consolidation,embeddings}/`.
- [ ] 1.3 Extract `packages/mcp` (tools + server factory + transport manager) from `apps/server/src/mcp/`.
- [ ] 1.4 Extract `packages/config` (shared tsconfig / eslint / prettier).
- [ ] 1.5 Rewire `apps/server` to import from the packages; suite stays green.

### Phase 2 — Turborepo

- [ ] 2.1 Add `turbo.json` with the build/typecheck/test/lint task graph and `outputs`.
- [ ] 2.2 Add the supply-chain ceremony for the new dependency (`allowBuilds`, `minimumReleaseAge`, skill consulted per AGENTS.md).
- [ ] 2.3 Verify affected-only execution works and record the measured delta.

Note: phase 1 creates the dependency graph that makes phase 2 meaningful. `apps/server/tsconfig.json` sets `rootDir: "./src"`, so extracted packages need their own tsconfig and `dist` — build order starts to matter, which is precisely what Turborepo's task graph is for.

### Phase 2b — MCP SDK v2 + zod 4 (prerequisite for `mcp-handler@2`)

- [ ] 2b.1 Decide B1 vs B2.
- [ ] 2b.2 If B2: upgrade `zod` 3→4 across the 399 schema declarations as an isolated change with its own tests green.
- [ ] 2b.3 If B2: upgrade `@modelcontextprotocol/sdk` 1.29.0 → v2; re-verify all five clients.
- [ ] 2b.4 Adopt `mcp-handler` at the version matching the chosen SDK major.

### Phase 3 — Next.js shell

- [ ] 3.1 Scaffold `apps/web` (App Router, TypeScript) consuming `packages/core`.
- [ ] 3.2 Prove the native-module path: `serverExternalPackages` for `better-sqlite3` / `sqlite-vec` / `onnxruntime-node`, and a connection singleton that survives HMR.
- [ ] 3.3 Port `/healthz` and one dashboard route end to end as the smoke.

### Phase 4 — runtime and delivery

- [ ] 4.1 Multi-stage Dockerfile with Next standalone output on distroless nodejs22.
- [ ] 4.2 Resolve the `sharp` question (either avoid `next/image`, or re-open the `allowBuilds` decision deliberately).
- [ ] 4.3 Verify healthcheck, volume, and `REMBRIC_*` env wiring in the image.

### Phase 5 — dashboard

- [ ] 5.1 Establish the CSS story against the locked dashboard spec (two hashed bundles, no `<style>` in body, whitespace-minified HTML).
- [ ] 5.2 Port the shell, sidebar, mobile bar and modal.
- [ ] 5.3 Port the 13 views, plus login and oauth-consent.
- [ ] 5.4 Rewrite the 98 `expect(html...)` assertions in the 15 dashboard test files.

### Phase 6 — HTTP surface

- [ ] 6.1 Port `/api/<slug>/sessions*` and the debug/recall endpoints to route handlers.
- [ ] 6.2 Port MCP via `mcp-handler`; verify the five clients against it.
- [ ] 6.3 Port OAuth per the phase 0 decision.
- [ ] 6.4 Retire `apps/server`.

### Close

- [ ] C.1 Full suite green, image builds, installer e2e passes.
  - [x] Remove the temporary `@rembric/*` source mappings from `apps/web/tsconfig.json`.
  - [x] Build workspace package declarations before CI lint without duplicating typecheck.
  - [x] Verify lint/typecheck from a no-`dist` checkout and build the web Docker runtime.
- [ ] C.2 Update `AGENTS.md` and the affected specs.
- [ ] C.3 Archive the OpenSpec change.

## Evidence log

| Task           | Command run                                                          | Result                                                                   |
| -------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| reconnaissance | `grep -l "from 'express'" $SDK/server/auth/handlers/*.d.ts \| wc -l` | 5 handlers are Express middleware                                        |
| reconnaissance | `grep -rln "from 'zod'" apps/server/src --include=*.ts`              | 10 non-test + 1 test file; 399 zod schemas                               |
| reconnaissance | `node -e "require('zod/package.json').version"`                      | zod 3.25.76; SDK 1.29.0 — `mcp-handler@2` needs zod ^4.2.0               |
| reconnaissance | `cat apps/server/tsconfig.json`                                      | `rootDir: "./src"` — blocks in-place package extraction                  |
| reconnaissance | `cat apps/server/drizzle.config.ts`                                  | `schema`/`out` relative to `apps/server/src/db` — moves with the package |
| reconnaissance | import-site count                                                    | `apps/server/src/db` is imported from 110 non-test + 155 test sites      |
| reconnaissance | `grep -A2 "handleRequest(req" $SDK/.../streamableHttp.d.ts`          | `IncomingMessage, ServerResponse` — Node raw                             |
| baseline       | `pnpm run build` (cold)                                              | 2.36 s                                                                   |
| baseline       | `pnpm run typecheck`                                                 | 2.92 s                                                                   |
| baseline       | `pnpm test`                                                          | 152.96 s, 3033 tests (2 pre-existing failures on macOS, see below)       |

Baseline note: `bridge.test.ts:329` reads `/proc/<pid>/cmdline` and cannot pass on macOS (no platform gate in the file); `bridge.test.ts:811` is load-dependent and passes in isolation. Neither is caused by this work.
