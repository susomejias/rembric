# Pre-proposal state — fix-pi-ghost-sessions (pending owner gate)

Status: PENDING — product decisions not yet confirmed; `sdd-proposal` MUST NOT launch until this gate resolves.

## Confirmed so far

- Explore done: `openspec/changes/fix-pi-ghost-sessions/explore.md` (gatekeeper-validated 2026-09-13; spec quotes verified verbatim).
- Diagnosis reproduced: `apps/server/src/mcp/ghost-session-repro.test.ts` (control + weeks-long timeline, both green).
- Recommendation on the table: C = A (router-binding-first in `handleSessionStart`) + B-narrow (new sole-active-any-staleness lookup used ONLY by session_start) + D3 (one tool-description clause). Delta specs required on `sessions/spec.md:832` (no-guess) and `:874/:878` (staleness window). `expose-session-start-agent` (implemented, unarchived, owns the same description + `mcp-integration.test.ts` pins) must be coordinated.

## Owner gate questions (2026-09-13)

1. **Adopt the sole stale-but-active row (B-narrow)?** Edge: a killed client's zombie row can be adopted by a new conversation whose plugin ensure failed (mislabeled lineage, no data corruption). Alternative: A-only + D4 plugin-side call, keep minting on zero-fresh-rows.
2. **Residual mint under genuine ≥2-row ambiguity:** keep the spec-mandated mint (one extra row per ambiguity onset per transport), or delta-spec provenance-based adoption (E: adopt the out-of-band `agent!='unknown'` row)?
3. **B-wide or B-narrow:** should auto-attach (`memory.save` etc.) also adopt a sole stale row (fixes `session_id = NULL` fragmentation in one stroke, wider delta), or narrow (session_start only, smaller delta)?
4. **Post-sweep mint:** accept the weekend-idle mint (zero active rows after the 24h abandonment sweep — by design), or treat "idle < abandon window should reuse" as in-scope?
5. **Sequencing:** `expose-session-start-agent` is implemented but unarchived and owns the same tool description + integration pins. Stack this fix after its archive, or rebase now?

## Resolution

Owner decisions 2026-09-13 (all confirmed in-session):

1. **B-narrow adopted** — reuse the sole `active` row for `(tokenId, projectId)` regardless of staleness, via a NEW service lookup used only by `handleSessionStart`. Post-sweep mint (zero active rows after the 24h abandonment) accepted as by-design.
2. **Keep the spec-mandated mint under genuine ≥2-row ambiguity** — no provenance adoption (E). Combination A+B caps the residual at ~1 mint per ambiguity onset.
3. **B-narrow, not B-wide** — auto-attach (`resolveActiveSessionId` family) unchanged; `session_id = NULL` fragmentation is addressed only indirectly (no second row → no ambiguity).
4. **Sequencing: stack after `expose-session-start-agent` is archived.** That change is implemented (35/35 tasks) but unarchived and owns the same tool description + `mcp-integration.test.ts` pins. Apply MUST verify its archive state before starting.

Chosen approach for the proposal: **C = A (router-binding-first in `handleSessionStart`) + B-narrow + D3 (tool-description clause: once a session is active on this connection, do not call `session_start` again)**. Delta specs required on `sessions/spec.md` requirements at `:832` (no-guess) and `:874/:878` (staleness window scoping with the session_start carve-out named).

**AMENDMENT (owner, 2026-09-13, second gate round — multi-session safety):** the owner works with several parallel sessions in the same project and requires a hard guarantee against attaching to the wrong row. Decision: **D4' IN SCOPE** — the Pi extension binds its MCP transport to its OWN host session row by exact id (`memory.session_resume(<host-uuid>)`, id-targeted, zero guessing) after MCP init and after the first `ensure`, re-binding on transport re-init, tolerant of `not_found` (row not yet created) with retry. Consequences: (1) for Pi, binding-first short-circuits every heuristic lookup — the mixed-fresh stomp case (X resumes while Y is fresh) is closed at the root; (2) the stale-fresh / sole-active fallbacks remain only for clients that do not declare identity (Claude/Codex hooks, opencode — follow-up change); (3) `apps/plugin/.pi-plugin/` is touched → plugin release happens → the proposal's "no plugin release" criterion is replaced by the mandatory `rembric-plugin-development` e2e discipline; (4) new delta: `pi-plugin` spec requirement for the identity binding; check `mcp-api` `session_resume` contract for idempotency on an already-`active` row owned by the same token (required for the every-start call).
