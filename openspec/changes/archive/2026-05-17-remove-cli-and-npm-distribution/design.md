## Context

Hasta este change, Rembric distribuye dos productos paralelos:

1. **Imagen Docker** (`ghcr.io/susomejias/rembric`) — ruta canónica desde `make-docker-primary-distribution` (archivado 2026-05-17). El operador corre `docker compose up -d` y administra desde el dashboard.
2. **Paquete npm** (`@susomejias/rembric` en GitHub Packages) — ruta secundaria. Habilita una CLI nativa instalable (`pnpm add -g rembric && rembric token create ...`) para "power users" en hosts con Node 20+.

La memoria de proyecto `01KRV6WEGBS9N38QFGS3S6XN73` (2026-05-17) registraba el sunset de npm como propuesta futura `sunset-npm-distribution`, con el plan de mantener la CLI viva dentro del contenedor (`docker compose exec rembric rembric ...`) como reemplazo del binario nativo. Este change descarta ese plan parcial: en lugar de migrar usuarios del binario npm al binario in-container, se elimina ambos y se canaliza toda la operación al dashboard, MCP, y endpoints HTTP que ya existen.

Estado actual relevante:

- El dashboard cubre el 100% del trabajo operador: tokens (`/dashboard/tokens`), projects (`/dashboard/projects`), sessions (`/dashboard/sessions`), consolidation (`/dashboard/consolidation`), maintenance/purge (`/dashboard/maintenance`).
- Las migraciones SQLite corren automáticamente en `src/db/client.ts` al abrir la DB. El subcomando `rembric db migrate` era vestigial desde día uno.
- `GET /healthz` está bearer-gated desde `make-docker-primary-distribution`. Sustituye a `rembric status` sin pérdida funcional.
- El bridge MCP (`plugin/bin/rembric-bridge.mjs`) consume el HTTP API del servidor — NO consume el CLI. El sunset del CLI no afecta la superficie plugin↔servidor.

Constraints:

- Repo cerrado en GitHub. Autor único. Cero consumidores externos confirmados.
- La superficie HTTP (`/api/<slug>/*`, `/admin/*`, `/healthz`), MCP (todas las herramientas `memory.*`, `project.*`), y dashboard tiene que quedar idéntica byte-a-byte.
- Los invariantes load-bearing de `CLAUDE.md` (append-only memory, scope enforcement en service layer, `topic_key` convergence, fresh-context judgment) no se tocan — el CLI nunca formó parte de ellos.

## Goals / Non-Goals

**Goals:**

- Eliminar el CLI operador (`token`, `project`, `session`, `consolidation run-now`, `db migrate`, `status`, `llm ping`) completamente, sin retirarlo a "un solo verbo".
- Eliminar el canal de publicación a npm (GitHub Packages) y todo el aparato de CI/CD asociado (job `publish` en release-please, smoke-pack, `prepack`, `publishConfig`, `bin`, `main`, `exports`).
- Renombrar `src/cli.ts` → `src/server-entrypoint.ts` y reescribirlo como un bootstrap mínimo sin commander. Quitar la dependencia `commander`.
- Repointear toda la documentación (README, CLAUDE.md, troubleshooting, agents.md, plugin READMEs y descripciones de userConfig) al dashboard.
- Mantener la imagen Docker funcional con el nuevo entrypoint, sin cambios visibles para el usuario operativo (sigue siendo `docker compose up -d`).
- Server bump `0.13.0 → 0.14.0` (breaking del CLI sin consumidores externos confirmados).

**Non-Goals:**

- NO cambiar la superficie HTTP/MCP/dashboard. Cero spec deltas en `auth`, `dashboard`, `mcp-api`, `memory`, `persistence`, `development-environment`, `hermes-agent-plugin`.
- NO bumpear los plugin manifests (Claude Code, Codex, Hermes) — el contrato plugin↔servidor (bridge MCP) no cambia.
- NO crear un endpoint dashboard de "test LLM" para reemplazar `rembric llm ping` (scope-creep contradictorio con "quitar ruido"). El troubleshooting recipe se reescribe con `curl`.
- NO preservar `src/index.ts` como API embebible (`createServer` factory). Sin npm publish no hay embebedores; los tests usan `bootstrap.ts` directamente. Es código muerto pretendiendo ser API pública.
- NO retroactivamente "deprecation"-ar el CLI. Es eliminación directa: el repo es privado, no hay deprecation path que respetar.

## Decisions

### Decision 1: Eliminar el CLI completamente vs. reducirlo a un solo verbo `start`

**Elegido:** Eliminación total. `src/cli.ts` → `src/server-entrypoint.ts` como un script de ~10 líneas que llama a `startCli()` y maneja errores.

**Alternativa considerada:** Mantener `src/cli.ts` con commander pero solo el subcomando `start` (compat con el Dockerfile actual: `ENTRYPOINT ["node", "/app/dist/cli.js"]` + `CMD ["start"]`).

**Por qué:**

- `commander` parseando un único verbo es ruido conceptual. La narrativa "no hay CLI, la imagen arranca el servidor" es más limpia y honest.
- El delta real entre las dos opciones es ~5 minutos de trabajo: una línea en Dockerfile, una línea en `docker-compose.dev.yml`, un rename + reescritura corta. La "pain" del que ofrecía escape el autor en la conversación es mínima.
- Sin commander, `package.json` pierde una dependencia y `src/server-entrypoint.ts` es trivial de leer. El nombre del archivo cuenta la verdad: es el bootstrap del servidor, no una CLI.
- Cualquier futura adición de comandos operadores (improbable, dado que el dashboard cubre todo) puede reintroducir commander; no es una puerta cerrada permanentemente.

### Decision 2: `rembric llm ping` se elimina sin reemplazo dashboard

**Elegido:** Borrar el subcomando. Reescribir `docs/troubleshooting.md` para que las recetas usen `curl` directo contra el LLM endpoint configurado.

**Alternativa considerada:** Crear un endpoint `POST /admin/llm/ping` + botón en el dashboard que reproduzca la lógica de `runLlmPing` (probar el endpoint con un prompt mínimo y reportar ok/auth/network/timeout/error con códigos de salida).

**Por qué:**

- `llm ping` es una herramienta de diagnóstico dev-time, no parte del flujo operador continuo. Solo aparece en troubleshooting recipes.
- Agregar un endpoint + UI dashboard duplicaría lógica que el usuario puede ejecutar trivialmente con `curl -H "Authorization: Bearer $LLM_API_KEY" $LLM_BASE_URL/v1/models` (OpenAI-compatible). Esto es lo que ya hacen los operadores cuando depuran fuera de Rembric.
- Contradice el principio del change ("quitamos ruido"): sumar 1 endpoint admin + 1 sección en el dashboard para preservar 1 herramienta dev-time es scope creep.

### Decision 3: `src/index.ts` (package-level re-export) se borra; `src/server/index.ts::createServer` se preserva

**Elegido:** Borrar `src/index.ts` y los campos `main` / `exports` en `package.json`. Preservar `createServer` dentro de `src/server/index.ts` (la factoría interna).

**Alternativa considerada:** Borrar también la función `createServer` de `src/server/index.ts` y migrar los tests a usar `bootstrap.ts` directamente.

**Por qué:**

- Tres tests E2E (`src/test/smoke.test.ts`, `src/test/dashboard-e2e.test.ts`, `src/test/mcp-integration.test.ts`) consumen `createServer` como factoría de instancia bajo control con `env` inyectable. Migrarlos a `bootstrap.ts` directamente es churn sin valor — la firma `createServer(env)` es idéntica a `bootstrap(env)` (un thin wrapper).
- `src/index.ts` (el re-export package-level) sí es código muerto: era la superficie pública del paquete npm. Sin npm publish no hay embebedores externos. Su comentario lo describe como "kept thin... so future consumers can embed the server inside another Node process if they want" — eso es especulativo y nunca se materializó como uso externo.
- Mantener `createServer` adentro pero quitar el re-export package-level conserva el helper interno sin firmar un contrato público inexistente.
- Side-effect del cambio: actualizar el comentario doc de `src/server/index.ts` para que diga "createServer is the internal test-harness factory" en lugar de "for library embedding"; eliminar la referencia a `npx rembric` (que también muere en este change).

### Decision 4: Plugin manifests NO se bumpean

**Elegido:** Server `0.13.0 → 0.14.0`. Los tres manifests del plugin (`plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `plugin/.hermes-plugin/plugin.yaml`) quedan en su versión actual.

**Alternativa considerada:** Bump de los tres manifests "por simetría" (la disciplina histórica de `make-docker-primary-distribution` los bumpeó en lockstep).

**Por qué:**

- El contrato plugin↔servidor es el bridge MCP (`plugin/bin/rembric-bridge.mjs` + hooks + manifests + scripts de sesión vía HTTP API). NINGUNA de esas superficies cambia en este change.
- La regla en `CLAUDE.md` sobre bump de plugin manifests dice: "any time you change something in `plugin/` that users need to see (scripts, hooks, mcp.json, bin/, the Hermes provider, manifests themselves), bump ALL THREE manifest versions". Las descripciones de `userConfig` que se editan en los manifests son cosméticas (texto user-facing en el wizard de instalación de Claude Code) y NO afectan el comportamiento — pero **sí son texto que el usuario lee**, por lo que técnicamente entran en "cosas que users need to see".
- Sin embargo: bumpear los plugin manifests invalida la caché de plugin de Claude Code / Codex y obliga a los usuarios (al autor) a re-instalar el plugin solo para ver texto cosmético del wizard que no aplica a su instalación ya configurada. El costo-beneficio favorece NO bumpear.
- `plugin/CHANGELOG.md` registra el cambio para audit trail sin requerir bump.

### Decision 5: Spec deltas — REMOVED para projects/sessions, MODIFIED para consolidation

**Elegido:**

- `specs/projects/spec.md`: REMOVED de "Projects MUST be creatable from a dedicated CLI subcommand" (con migration apuntando a MCP `project.create` + dashboard).
- `specs/sessions/spec.md`: REMOVED de "The CLI MUST expose `rembric session delete <id>` and `--include-deleted`" (con migration apuntando al dashboard `/dashboard/sessions`).
- `specs/consolidation/spec.md`: MODIFIED del requirement "The consolidation MUST run automatically on a schedule" — el scenario "Manual run via CLI" se reescribe como "Manual run via HTTP / dashboard". La requirement umbrella permanece.

**Alternativa considerada:** Cambio en `consolidation` como REMOVED del scenario CLI + ADDED de un nuevo scenario HTTP. OpenSpec valida deltas a nivel de requirement, no de scenario, por lo que la forma idiomática es MODIFIED con el bloque completo.

**Por qué:**

- Los dos primeros son requirements íntegramente sobre el CLI: REMOVED es la operación correcta.
- El tercero es un scenario dentro de una requirement umbrella ("consolidation corre en cron Y permite trigger manual"); la requirement sigue siendo válida, solo cambia el canal del trigger manual. MODIFIED con el bloque completo (3 scenarios) es la forma correcta.

## Risks / Trade-offs

- **[Riesgo] El autor tiene scripts personales con `docker compose exec rembric rembric token create ...`** → Mitigación: el autor confirma explícitamente en la conversación que no los usa. Si emergen post-merge, son trivialmente migrables a `curl` contra la HTTP API o al dashboard.
- **[Riesgo] El Dockerfile actual hace `ENTRYPOINT [...] + CMD ["start"]`. Cambiar a un entrypoint sin `start` requiere actualizar la imagen y compose simultáneamente.** → Mitigación: ambos archivos (`Dockerfile`, `docker-compose.dev.yml`) se tocan en el mismo commit. El smoke local del operador (`pnpm run dev:docker:up`) valida el path antes de PR.
- **[Riesgo] La caché de Docker Buildx en CI (`scope=docker-build-check-runtime`) puede servir layers viejos durante el primer build post-merge.** → Mitigación: el rename del ENTRYPOINT cambia el `RUN`/`COPY` final del Dockerfile lo suficiente como para invalidar la caché orgánicamente; en última instancia GHA workflow_dispatch puede forzarse.
- **[Riesgo] `docs/troubleshooting.md` queda con recetas `curl` sin el envoltorio ergonómico que daba `rembric llm ping` (status codes legibles, prompt mínimo).** → Trade-off aceptado: el operador (uno solo) prefiere "quitar ruido" a UX optimal en una herramienta dev-time. Si emerge dolor real, abrir un change separado para añadir endpoint admin de diagnóstico.
- **[Trade-off] Versionado: server bump minor (0.13.0 → 0.14.0) en lugar de major.** Técnicamente un breaking change del CLI justifica major, pero SemVer del lado del servidor lo manejamos por contrato del HTTP/MCP/dashboard, no por el CLI. Las versiones major se reservan para breakings de esas superficies (que NO cambian aquí). El autor es el único decisor y acepta esto.
- **[Trade-off] No se preserva `src/index.ts` como API embebible.** Si un día se quiere reintroducir, restaurar desde git history es trivial (`git show <pre-merge-sha>:src/index.ts`). El costo de tenerlo "por si acaso" hoy es código muerto firmando un contrato no testeado.

## Migration Plan

No hay migration plan operativo: el repo es privado, el autor es el único operador, no hay flota de instalaciones a migrar.

**Para el autor en su laptop tras pull del merge:**

1. `pnpm install` para sincronizar el lockfile sin `commander`.
2. Si tiene la imagen Docker vieja corriendo (`rembric` en docker compose): `docker compose down && docker compose pull && docker compose up -d`. El nuevo entrypoint arranca igual.
3. Cualquier script personal `~/bin/rembric-*.sh` que hiciera `docker compose exec rembric rembric <cmd>` deja de funcionar. Reemplazar con el dashboard o `curl` contra la HTTP API.

**Para CI tras merge:**

- `release-please` propone el bump server `0.14.0` en su próximo PR de release.
- El job `publish` (npm) ya no existe; el PR de release solo dispara `publish-docker`.
- Cualquier tag previo `v0.13.x` que el operador quiera desinstalar de GitHub Packages (`ghcr.io` y `npm.pkg.github.com`) requiere un paso manual fuera de este change (no es bloqueante).

**Rollback:** revertir el merge commit. No hay state persistido en npm registry que pertenezca solo a este change (los tarballs publicados durante 0.13.x quedan ahí como artefactos históricos; eliminarlos es opcional y manual).

## Open Questions

(ninguna — el autor confirmó todos los puntos en la conversación de explore mode)
