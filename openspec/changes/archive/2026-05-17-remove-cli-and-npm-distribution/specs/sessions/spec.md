## REMOVED Requirements

### Requirement: The CLI MUST expose `rembric session delete <id>` and `--include-deleted`

**Reason**: El CLI operador completo se elimina en este change. La cobertura de soft-delete y de listado-con-deleted pasa al dashboard `/dashboard/sessions`, que ya implementa:

- Modal CSRF-protected con `data-confirm` por fila para soft-delete (requirement separado "The dashboard MUST surface Delete + Undelete actions per session" que NO se toca en este change).
- Toggle `?include_deleted=1` para mostrar la sección "Deleted" beneath the Active table.
- Vista de detalle `/dashboard/sessions/:id` que renderiza el estado deleted y el botón Undelete cuando aplica.

**Migration**:

- Para soft-delete interactivo de una sesión: usar el botón `Delete` en la fila del listado en `/dashboard/sessions` (modal de confirmación con `data-confirm-tone="warn"`).
- Para inspeccionar soft-deleted sessions: visitar `/dashboard/sessions?include_deleted=1`.
- Para soft-delete programático desde shell scripts del operador: usar `curl -X POST` con admin token contra el endpoint dashboard `POST /dashboard/sessions/<id>/delete` (incluyendo el CSRF token obtenido en una visita previa). La superficie HTTP dedicada `/api/admin/sessions/:id` puede agregarse en un change futuro si emerge necesidad real — NO se incluye aquí (scope creep).
- El comportamiento "session no encontrada" que antes producía exit non-zero ahora se manifiesta como una 404 del dashboard.
