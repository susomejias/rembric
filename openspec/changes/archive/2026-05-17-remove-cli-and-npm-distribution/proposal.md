## Why

Después de archivar `make-docker-primary-distribution` (2026-05-17), Docker es la ruta canónica y el dashboard cubre el 100% del trabajo operador (tokens, projects, sessions, consolidation, maintenance/purge). El CLI `rembric` quedó como una tercera vía de hacer lo mismo — un wrapper thin sobre los services que cada cambio en proyectos / sesiones / consolidación obliga a mantener en lockstep — y el canal de publicación a npm (GitHub Packages) duplica la disciplina de release sin consumidores externos: el repo es privado, soy el único operador, y la memoria de proyecto `01KRV6WEGBS9N38QFGS3S6XN73` (2026-05-17) ya registraba el sunset de npm como propuesta futura. Este change materializa ese sunset y va un paso más allá eliminando también el CLI operador, dejando una sola narrativa: "no hay CLI, la imagen Docker arranca el servidor; el operador usa el dashboard".

## What Changes

- **BREAKING (CLI):** Eliminar todos los subcomandos del CLI operador (`rembric token`, `project`, `session`, `consolidation run-now`, `db migrate`, `status`, `llm ping`). Sin reemplazo directo — el dashboard, el MCP server, y el endpoint `POST /admin/consolidation/run` ya cubren todos los casos. `rembric llm ping` queda huérfano sin reemplazo dashboard: el `docs/troubleshooting.md` se reescribe usando `curl` contra el LLM endpoint.
- **BREAKING (entrypoint):** Renombrar `src/cli.ts` → `src/server-entrypoint.ts` reescrito como ~5-10 líneas que invocan `startCli()` directamente. Se quita la dependencia `commander` (~1 verbo no justifica el parser). `Dockerfile` ENTRYPOINT y `docker-compose.dev.yml` se actualizan para apuntar al nuevo archivo. `CMD ["start"]` desaparece.
- **BREAKING (distribución):** Eliminar la publicación a npm en GitHub Packages. Borrar el job `publish` de `release-please.yml` (mantener `release-please` + `publish-docker`). Borrar el step "Smoke test (install tarball + npx rembric llm ping)" de `ci.yml`. Borrar `scripts/smoke-pack.mjs`. Quitar `publishConfig`, `bin`, `main`, `exports`, `files`, `prepack` de `package.json`. Borrar `src/index.ts` (factory `createServer` embebible — sin consumidores npm, código muerto).
- **Docs:** Repointear todas las menciones de subcomandos CLI en `README.md`, `CLAUDE.md`, `docs/troubleshooting.md`, `docs/agents.md`, `plugin/README.md`, `plugin/.hermes-plugin/README.md`, y las descripciones de `userConfig` en los 3 plugin manifests (`plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `plugin/.hermes-plugin/plugin.yaml`) hacia el dashboard (`/dashboard/tokens`, `/dashboard/projects`, `/dashboard/sessions`, `/dashboard/consolidation`).
- **Versionado:** Server bump `0.13.0 → 0.14.0` (minor; breaking del CLI pero sin consumidores externos confirmados). Plugin manifests **NO** se bumpean — la superficie del bridge MCP es el contrato plugin↔servidor y no cambia. `plugin/CHANGELOG.md` registra el cambio sin bump.
- **NO toca:** API HTTP (`/api/<slug>/*`, `/admin/*`, `/healthz`), MCP server y herramientas, dashboard, schema de DB, hooks de plugin, bridge MCP. La superficie pública del servidor para agentes y operadores queda idéntica.

## Capabilities

### New Capabilities

(ninguna)

### Modified Capabilities

- `projects`: ELIMINA la requirement "The CLI MUST expose `rembric project create <slug>` and `rembric project list`". MCP `project.*` y `/dashboard/projects` cubren el caso.
- `sessions`: ELIMINA la requirement "The CLI MUST expose `rembric session delete <id>` and `--include-deleted`". `/dashboard/sessions` con soft-delete modal + toggle include-deleted cubre el caso.
- `consolidation`: MODIFICA el scenario "WHEN an operator runs `rembric consolidation run-now`" para apuntar al botón del dashboard `/dashboard/consolidation` y al endpoint HTTP `POST /admin/consolidation/run`, que son los paths reales hoy.

**SIN spec deltas en:** `auth`, `dashboard`, `mcp-api`, `memory`, `persistence`, `development-environment`, `hermes-agent-plugin`. La superficie HTTP/MCP/dashboard no cambia.

## Impact

- **Código eliminado:**
  - `src/cli/{token,project,session,consolidation,db-migrate,server-status,llm-ping}-cli.ts` (7 wrappers)
  - `src/cli/cli.test.ts`
  - `src/index.ts` (factory embebible)
  - `scripts/smoke-pack.mjs`
- **Código renombrado / reducido:** `src/cli.ts` → `src/server-entrypoint.ts` (de ~150 líneas con commander a ~10 sin parser).
- **Dependencias:** Quita `commander` de `package.json`.
- **CI/CD:** Reduce `release-please.yml` (un job menos), simplifica `ci.yml` (un step menos), elimina el script smoke-pack.
- **Docker:** Cambia ENTRYPOINT del runtime stage y CMD del dev stage en `Dockerfile` + `docker-compose.dev.yml`.
- **Docs:** Reescritura de ~10-15 referencias dispersas; sección "Operating the CLI" en `README.md` se elimina; sección "Running without Docker" se elimina.
- **Plugin tree:** Solo cambian las descripciones cosméticas de `userConfig` en los 3 manifests — el bridge, los hooks, y los scripts compartidos quedan intactos. NO requiere bump de plugin manifests (Claude Code, Codex CLI, y Hermes consumirán la misma versión sin cache invalidation).
- **Riesgo operador:** Cualquier script personal en `migrate-to-docker.local.txt` o equivalente que invoque `docker compose exec rembric rembric ...` se rompe — pero el autor es el único usuario, y el corte está prevenido en este proposal.
- **Spec invariants tocados:** Ninguno (los invariantes load-bearing de `CLAUDE.md` — append-only memory, scope enforcement en service layer, topic_key convergence, fresh-context judgment — NO se tocan).
