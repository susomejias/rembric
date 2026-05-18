## Context

Rembric's dashboard is one tree (`src/dashboard/`) of server-rendered HTML + a small per-view CSS bundle resolved at build time via a content-hashed manifest (`scripts/build-css.mjs`). Three drift problems accumulated over recent changes:

1. **Nomenclature drift on the judgments queue.** The sidebar's user-facing label has been `JUDGMENTS` since the early dashboard work, but the URL (`/dashboard/relations`), the file (`src/dashboard/relations.ts`), the exported router (`createRelationsRouter`), the CSS bundle (`views/relations.css`), the page title (`Rembric Relations.`), the empty state, the column header, and the CSRF action token all said `relations`. The existing `dashboard` spec (line 331) already calls the route "Judgments" — so the URL was inconsistent with the spec, not the other way around.
2. **Stale login copy.** The login screen still said `OPERATOR DASHBOARD`, carried an `APPEND-ONLY` tagline from Rembric's first README, listed only `CLAUDE CODE · CODEX CLI · MCP CLIENTS` in the client footer (Hermes was added in `2026-05-16-add-hermes-agent-plugin` and never propagated to the login surface), had a redundant `■ ADMIN TOKEN` chip above an input that already had a `<label>`, and three security disclosure lines (`ADMIN-SCOPED TOKENS ONLY`, `STORED IN HTTPONLY COOKIE`, `PLAINTEXT SHOWN ONLY ONCE IN /TOKENS`) that belonged in `/tokens` docs, not on a login form. The h1 also had `line-height: 0.9`, which made the lime `OPERATOR` highlight box visually clip the `DASHBOARD` line below.
3. **Generic sidebar icons.** Each `NAV_ICONS` entry was a free-form geometric shape. The `memories` icon was a solid square indistinguishable from a generic "block"; `projects` was four squares (visually identical to `overview`); `maintenance` was a bar chart (which actually reads as "stats"). The icons did not communicate the section's domain at a glance.

The fixes are entirely within the presentation layer. The domain entity (a "memory relation": a row in `memory_relations` linking two `memory` rows, judged or pending) is unchanged — the dashboard rename only changes the operator-facing nomenclature for the lifecycle of those relations.

## Goals / Non-Goals

**Goals:**

- Make the dashboard self-consistent: the label, URL, file, function, CSS bundle, page copy, and CSRF action all share one name (`judgments`).
- Make the login screen reflect the current product (three plugin clients including Hermes; no stale taglines; logo present; correct headline).
- Make every sidebar icon legible at 16 × 16 and tied to the section's domain meaning.
- Preserve git history on the renamed file and CSS bundle.
- Touch zero DB schema, zero service logic, zero MCP tools, zero plugin manifests.

**Non-Goals:**

- Renaming the underlying entity (`memory_relations` table, `RelationsService`, `mcp/relations-tools.ts`). Those carry the entity name in DB-level and protocol-level contracts; renaming requires migrations + an OpenSpec change in `mcp-api` + `memory` and is out of scope here.
- Adding new dashboard pages, KPIs, or filters.
- Introducing a light theme, a logo CDN, or any frontend build pipeline beyond the existing `lightningcss` CSS step.
- Changing the dashboard's brutalist design contract (palette, type stack, spacing scale).

## Decisions

### Decision 1: Rename the URL but not the underlying entity

The boundary is: **presentation says `judgments`, persistence + protocol say `relations`.** Trade-off: a tiny vocabulary mismatch between the dashboard and the DB/MCP layers. Rationale: changing `memory_relations` requires a Drizzle migration on a live append-only DB plus a `mcp-api` spec delta (the `memory.judge` tool signature already uses the relation/judgment vocabulary); the cost outweighs the consistency win. Inside the dashboard layer the rename is total — no half-renamed file is left behind.

**Alternatives considered:**

- _Rename everything (DB + MCP + dashboard)_: rejected — out of scope and requires a different OpenSpec change covering `memory`, `mcp-api`, and `persistence` deltas plus a `memory_relations` → `memory_judgments` migration.
- _Leave the dashboard at `/dashboard/relations` and rename the sidebar label back to "Relations"_: rejected — the spec already says "Judgments" (line 331 of `openspec/specs/dashboard/spec.md`); reverting that contradicts already-published spec language.

### Decision 2: Use `git mv` for the file and CSS rename

`src/dashboard/relations.ts` → `src/dashboard/judgments.ts` and `styles/views/relations.css` → `styles/views/judgments.css` both use `git mv`. Rationale: preserves `git blame` and `git log --follow` so future readers can trace the original implementation. Doing a `Write` of new content + `rm` of the old file would break the renaming detection on some Git versions.

### Decision 3: CSS view bundle is renamed (not aliased)

`build-css.mjs` scans `styles/views/*.css` and emits one bundle per filename, then writes a manifest (`assets/styles/manifest.json`) mapping view key → bundle URL. The view key in `page-shell.ts::renderPage` defaults to `activeNav`. Since I renamed `activeNav` from `'relations'` to `'judgments'`, the build picks the new filename automatically. No alias is needed.

**Alternative considered:** keep `views/relations.css` as an alias / leave both files. Rejected — duplication invites drift; the manifest already content-hashes, so a clean rename is safer than maintaining two bundle entries.

### Decision 4: Column header `relation` → `verdict`

The judgment-queue table column shows the kind of judged outcome (`not_conflict`, `supersedes`, `related`, `compatible`, `scoped`, `conflicts_with`, `pending`). Under the old "relations" framing, "relation" was the right column name. Under the "judgments" framing, the verdict the operator (or the LLM judge) returned is the right framing — hence `verdict`. The cell value is unchanged; only the header label changes.

**Alternative considered:** keep `relation`. Rejected — keeping a column header that uses the renamed entity-layer term would re-introduce the inconsistency the rename was meant to remove.

### Decision 5: One icon (memories / brain) breaks the all-rectangles convention

Every other `NAV_ICONS` entry uses `<rect>` only (some with `fill="none"` outlining). The new `memories` icon uses `<path>` with bezier curves for the two-lobe cerebrum silhouette and two small convolution marks per hemisphere. Rationale: a 16-px brain made purely of axis-aligned rectangles ends up looking like stacked bookshelves or a chip — exactly what the prior attempt produced and what the operator rejected. A curved silhouette + central fissure + small convolutions is the minimum vocabulary to read as "brain." This is the only exception; `judgments`, `consolidation`, `projects`, `tokens`, and `maintenance` stay rect-only (with one `<polygon>` per icon for the `consolidation` diagonals and the small flat triangular arrowhead — diagonal shapes can't be axis-aligned rectangles, but they remain flat / monochrome).

**Alternatives considered:**

- _Stack of horizontal slabs ("memory chip")_: rejected — operator said it didn't read as cerebro.
- _Cluster of nodes connected by lines (neural-network metaphor)_: rejected — reads as "graph" or "network", not "memory."

### Decision 6: Wrench (not trash can) for `maintenance`

The maintenance page (`/dashboard/maintenance`) today only exposes two physical-purge operations. A trash can would map literally to that. The wrench was chosen instead because: (a) the page's `MAINTENANCE` label is generic and the page may grow to include non-purge operator tasks; (b) "wrench" is the universal cross-app maintenance icon and avoids the implicit message "this page only deletes things"; (c) at 16 px the wrench is buildable with 4 rectangles (handle + top tine + back + bottom tine forming a C-shaped open jaw).

### Decision 7: Login logo placement

The transparent logo is rendered at 56 / 48 / 40 px (desktop / tablet / phone) inside the brand block in the top-left of the left pane, right next to the `REMBRIC / SELF-HOSTED` mono text. An earlier iteration placed it in the right pane (above the form). Operator preferred the top-left placement: it reads as a brand mark rather than a watermark, and it keeps the right pane purely about the auth form.

### Decision 8: `line-height` on the headline

`.login-stage h1` had `line-height: 0.9` (desktop) and `0.95` (mobile). The lime `hl-lime` background pad on the highlighted word is `padding: 0 0.25em 0.05em 0.25em`, so with a line-box smaller than the glyph height, the highlight box overflows into the next line and visually clips `DASHBOARD`. Setting `line-height: 1.35` (desktop) / `1.3` (tablet+phone) restores a normal line-box, the highlight clears the next line cleanly, and the headline reads correctly at every viewport. The visual rhythm is slightly looser; this was an explicit operator preference ("dale un poco de espaciado, aparece pegado").

## Risks / Trade-offs

- **[Bookmarks to `/dashboard/relations` 404 after deploy]** → Mitigation: the URL is internal-only (the dashboard binds to `127.0.0.1` and is not published anywhere); any operator hitting the old URL gets a 404 and finds the new URL from the sidebar within seconds. No redirect added — keeping the URL set minimal.
- **[Vocabulary mismatch between dashboard ("judgments") and DB / MCP / docs ("relations")]** → Mitigation: documented explicitly in `proposal.md` Impact section and `design.md` Decision 1; operators reading both the dashboard and the MCP tool reference will see both terms. A future change can unify them with a migration.
- **[A future contributor edits the icon SVG and breaks the only-curves exception rule]** → Mitigation: the rule is documented inline in the design doc and in this design.md (Decision 5); if it matters more later, a lint rule scanning `NAV_ICONS` for non-rect elements per key could be added — not done in this change.
- **[The CSS manifest rebuild step is required after the rename]** → Mitigation: `pnpm run build` (which runs `build:css` then `tsc`) handles it; the rebuild was verified locally and the manifest now emits `views/judgments.<hash>.css`.

## Migration Plan

This change is non-destructive and requires no DB migration.

1. Merge the change. The Drizzle schema, all services, all MCP tools, and the plugin manifests are untouched — no `pnpm db:generate`, no migration apply, no plugin version bump.
2. Operators with active dashboard sessions remain signed in. The session cookie path (`/dashboard`) and the auth middleware are unchanged.
3. Existing bookmarks to `/dashboard/relations` return 404; operators navigate to JUDGMENTS from the sidebar.
4. The CSS bundle URL changes content-hash on rebuild (because the file was renamed and the contents are different). Cache-busting works as before — browsers fetch the new bundle on first load.

**Rollback:** `git revert` of the merge commit. Because the change is purely additive on the presentation layer and the DB / service / MCP contracts are unchanged, rollback is risk-free.

## Open Questions

None — all decisions confirmed with the operator during the work session.
