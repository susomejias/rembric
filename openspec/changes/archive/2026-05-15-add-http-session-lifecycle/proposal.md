## Why

`/dashboard/sessions` siempre muestra "Active (0)" porque ninguna pieza del plugin (Claude Code o Codex) abre nunca una sesión: el hook `SessionStart` sólo emite un nudge a `memory.context`, las `initialize.instructions` del MCP no mencionan `memory.session_start`, y los tools del MCP están deferred en Claude Code (el agente ni siquiera los ve sin un `ToolSearch` previo). Como efecto colateral, el hook `PreCompact` declarado como `mcp_tool` con `memory.session_summary({auto:true})` falla silenciosamente — el schema actual exige `summary: string`, el argumento `auto:true` quedó en el spec pero nunca se implementó. Resultado: zero observabilidad de sesiones, zero summaries de pre-compactación, y `memory.save` queda huérfano de `session_id`.

La solución de Engram (proyecto de referencia con 3.5k stars que resuelve el mismo problema) es no depender del agente: los hooks `type: command` leen el `session_id` que el cliente pasa por stdin y POSTean directo a un endpoint HTTP del servidor. Funciona cross-client (Claude Code, Codex, Cursor, etc.) porque sólo requiere ejecutar comandos.

## What Changes

- **Nuevos endpoints HTTP** path-scoped junto a `/mcp`, `/dashboard`, `/admin`:
  - `POST /api/<slug>/sessions { id, cwd? }` — upsert idempotente de sesión.
  - `POST /api/<slug>/sessions/:id/summary { summary }` — escribe summary y cierra.
  - `POST /api/<slug>/sessions/:id/end` — cierra sin summary.
  - Mismo `Authorization: Bearer <token>` que MCP (reutiliza literalmente `authenticate()`).
- **No-schema-change** (revised after the persistence FK analysis): `agent_sessions.id` permanece como `TEXT PRIMARY KEY` global. Acepta ids cliente-provistos con validación regex `/^[A-Za-z0-9_-]{8,128}$/`. Colisiones cross-token (~10^-36 con UUIDs/ULIDs) se detectan al nivel app (SELECT antes de INSERT) y se rechazan con código `id_collision`. La FK `memory.session_id REFERENCES sessions(id)` permanece intacta. Cero migración SQL.
- **`AgentSessionsService.start()`** acepta `id?: string` opcional. Con id: `INSERT OR IGNORE` + return existing (idempotente; PostCompact puede re-llamar). Sin id (back-compat para `memory.session_start` MCP): mint ULID como hoy.
- **Plugin `session-start.sh`** engordado (~25 LOC): lee `$INPUT.session_id` y `$INPUT.cwd` de stdin, lee `.rembric` para `PROJECT_SLUG`, hace `curl POST /api/<slug>/sessions`. Mantiene el nudge actual.
- **Plugin `pre-compact.sh`** nuevo (reemplaza el `mcp_tool` actual): lee summary/transcript de stdin, POSTea a `/api/<slug>/sessions/:id/summary`. Elimina el bug `auto:true` por obsolescencia.
- **Plugin `session-stop.sh`** nuevo + nuevo hook `Stop` async: POST `/api/<slug>/sessions/:id/end`.
- **Codex `hooks.codex.json`** equivalente: `SessionStart` engordado y `Stop` análogos (Codex no soporta `PreCompact` así que ese path no se replica).
- Tools MCP (`memory.session_start`, `memory.session_end`, `memory.session_summary`) **preservadas sin cambios** — siguen funcionando para clientes que no usen hooks.

## Capabilities

### New Capabilities

- `http-api`: superficie HTTP no-MCP autenticada con bearer token (mismo que `/mcp`). Vehículo para que hooks de clientes (Claude Code, Codex, futuros) gestionen lifecycle de sesiones sin pasar por el wire protocol MCP. Empieza con tres endpoints (`POST /api/<slug>/sessions`, `.../summary`, `.../end`); diseñada para crecer (e.g. `/observations/passive` cuando se añada SubagentStop).

### Modified Capabilities

- `sessions`: el id de sesión deja de ser server-minted obligatorio. Acepta id cliente-provisto con validación. PK compuesta `(token_id, id)`. Idempotencia explícita en `start()`.
- `persistence`: migración `agent_sessions` para PK compuesta + FK compuesta en `memory`. Append-only contract preservado.
- `claude-code-plugin`: `SessionStart` pasa de nudge a hook gordo HTTP; `PreCompact` pasa de `mcp_tool` a `command`; nuevo hook `Stop`.
- `codex-distribution`: `SessionStart` análogo al de Claude; nuevo hook `Stop`; `PreCompact` se queda como nudge informativo (Codex no soporta el evento de forma equivalente).
- `mcp-api`: aclarar que `memory.session_start` queda como path alternativo (no obligatorio) para clientes sin hook HTTP; comportamiento sin cambios.

## Impact

- **Código nuevo (~100 LOC)**:
  - `src/server/api-router.ts` — Hono router para `/api`.
  - 3 nuevos scripts en `plugin/scripts/` (session-start engordado, pre-compact, session-stop) + helper compartido `_api.sh`.
- **Código modificado (~15 LOC)**:
  - `src/server/http.ts` — montaje del router en Hono app.
  - `src/services/agent-sessions.ts::start` — acepta id opcional, idempotent, rechazo cross-token.
  - `plugin/hooks/hooks.json` y `plugin/hooks/hooks.codex.json` — nuevos hooks declarados.
  - `src/mcp/tools.ts` — fallback "most-recent-active session" para attachment de memorias.
- **Tests (~6)**:
  - E2E HTTP: upsert idempotente, validación de id, token wrong scope rejected, summary cierra sesión, cross-token id_collision rejected.
  - Service unit: idempotencia same-token, rechazo cross-token, regex validation.
- **Migración**: ninguna. La FK existente `memory.session_id REFERENCES sessions(id)` queda intacta. El append-only contract se preserva (rows nunca son DELETE; status flips intactos).
- **No afecta**: `MemoryService`, `RelationsService`, `ProjectsService`, consolidation, embeddings, dashboard router (excepto que ahora muestra sesiones reales), `.rembric` parsing, path-scoping `/mcp/<slug>`.
