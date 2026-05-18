## REMOVED Requirements

### Requirement: Projects MUST be creatable from a dedicated CLI subcommand

**Reason**: El CLI operador completo se elimina en este change. La cobertura de creación de proyectos pasa a (a) la herramienta MCP `project.create` (ya implementada en `src/mcp/project-tools.ts`) y (b) el formulario CSRF-protected del dashboard `/dashboard/projects` (requirement separado "The dashboard `/dashboard/projects` page MUST surface an always-visible creation form" que NO se toca en este change).

**Migration**:

- Para creación interactiva de proyectos: usar el formulario en `/dashboard/projects` (operador autenticado).
- Para creación programática desde un agente: usar la herramienta MCP `project.create` con un token bearer válido contra `/mcp` o `/mcp/<slug>`.
- Para creación programática desde shell scripts del operador: usar `curl -X POST` contra el HTTP API (`POST /api/admin/projects` con el admin token; ver `src/server/api-router.ts`).
- El listado de proyectos (`rembric project list`) tiene equivalentes idénticos en el dashboard (`/dashboard/projects` lista active + archived inline) y en la herramienta MCP `project.list`.
- Los exit codes y errores del CLI (`invalid_slug` → exit 2, conflict → exit 1, success → exit 0) ya tienen equivalentes en los DomainErrors del service layer; ambos los reusan.
