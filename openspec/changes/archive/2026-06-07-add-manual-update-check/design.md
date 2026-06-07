# Design: add-manual-update-check

## Context

`UpdateCheckService` (`apps/server/src/services/update-check.ts`) already has a public, awaitable `refresh()` that ignores the 24-hour interval, dedupes concurrent calls (`inflight`), and is ETag-aware — a no-change re-check is a `304`. What's missing is purely surface: no dashboard action invokes it, and `refresh()` cannot tell the caller whether it actually reached GitHub (the silent-failure contract makes `null` mean both "no newer release" and "fetch failed").

Discoverability gap: the brand-block slot rendered by `updateShellExtras` (`update-modal.ts`) returns `badge: null` when no update is known, and `/dashboard/update` is not in `NAV` — the page's "UP TO DATE" state is reachable only by typing the URL. The exact scenario this change targets (operator learns a release shipped, wants to force the check) happens _before_ any badge exists.

Prior art in this dashboard genre (Portainer, Pi-hole, Arcane — the original UX reference): the version/update affordance lives in the brand/footer block and links to the updates surface.

## Goals / Non-Goals

**Goals:**

- Operator can force a release check from the dashboard and see an honest outcome (update found / still up to date / check failed).
- `/dashboard/update` is always reachable from the shell via the brand-block slot.
- Zero behavior change for the automatic path: same cadence, same silent-failure contract, same badge when an update is known.

**Non-Goals:**

- No change to one-click execution, capability detection, or the modal.
- No persistence of check state (stays in-memory, as decided in the original change's D5).
- No nav item for the update page (rarely-visited page; the brand slot is the entry point).
- No rate limiting beyond what already exists (`inflight` dedupe) — single-operator authenticated surface.

## Decisions

### D1 — Force-check reports outcome; the silent-failure contract stays scoped to the automatic path

`UpdateCheckService` gains `checkNow(): Promise<{ outcome: 'update' | 'none' | 'error'; info: UpdateInfo | null }>` (and a `lastCheckedAt` accessor). Internally `doRefresh` records whether the fetch succeeded; `checkNow` forces a refresh and maps the result. `peek()` and the background kick are untouched — automatic failures stay silent per spec.

- _Alternative: reuse `refresh()` as-is and flash "still up to date" on `null`._ Rejected: on an air-gapped or rate-limited host the button would claim "up to date" when it never reached GitHub — a manual action must not lie about having checked.
- _Alternative: surface errors everywhere (drop silent failure)._ Rejected: the silent contract exists for unattended deployments; only an explicit operator action earns an error message.

### D2 — `POST /dashboard/update/check` + redirect with outcome query param

New route in `update.ts` following the `/start` pattern exactly: session guard, `readFormAndVerifyCsrf` (action `update.check`), `await deps.updates.checkNow()`, redirect to `/dashboard/update?checked=<outcome>` for `none`/`error` (plain redirect for `update` — the refreshed cache makes the GET render the full "Update Available" view via the middleware's `peek()`). The GET handler maps `checked=none` to an info flash ("Checked — still up to date") and `checked=error` to an error flash ("The check could not reach GitHub..."), mirroring the existing `?err=` mapping.

- _Alternative: HTMX partial swap instead of POST-redirect-GET._ Rejected: the update page is plain SSR today; PRG reuses the flash machinery and survives the "found an update" case (full re-render into a different view) without special-casing.

### D3 — Persistent brand-block slot: badge when update known, quiet link otherwise, nothing when disabled

`updateShellExtras` currently returns `badge: null` when there is no update state. It will instead render a quiet `UP TO DATE ›` link (`href="/dashboard/update"`, muted styling, same slot/position as the lime badge) — completing the half-built component rather than turning the decorative `v<version>` text into a hidden link. Three states:

| Check state                    | Slot renders                                       |
| ------------------------------ | -------------------------------------------------- |
| newer version known            | existing lime `UPDATE v<latest>` badge (unchanged) |
| no update known, check enabled | quiet `UP TO DATE ›` link                          |
| `REMBRIC_UPDATE_CHECK=off`     | nothing                                            |

The disabled case renders nothing because "UP TO DATE" would be a claim the server cannot make (it never checks), and the operator explicitly opted out of update UX. This requires the shell to distinguish "no update" from "check disabled": `UpdateCheckService` exposes `enabled` (trivial getter), threaded through the router middleware alongside the existing state.

- _Alternative: make the `<small>v…</small>` brand text a link._ Rejected: zero affordance — a decorative label that is secretly clickable is an easter egg, not UI.
- _Alternative: permanent NAV item under ADMIN._ Rejected: a fixed nav entry for a page that says "up to date" 95% of the time is noise; the sidebar already carries 7+ items.
- _Alternative: render the quiet link even when disabled._ Rejected: dishonest label, and the operator who set `REMBRIC_UPDATE_CHECK=off` asked for exactly this absence.

New CSS class for the quiet state in `dashboard/styles/` (locked design tokens, no inline styles), reusing the `.sb-update` layout with a muted variant.

### D4 — CHECK NOW placement and the last-checked line

The button lives only on `/dashboard/update`'s up-to-date state (where the cadence text already is), as a CSRF-protected form. No `data-confirm` — the action is read-only and reversible (one conditional GET). A "Last checked" line renders via `formatTs(lastCheckedAt)` when a check has run this process lifetime; omitted otherwise (fresh boot). When the check is disabled, the button and line are replaced by the existing disabled-note copy.

- _Alternative: also add a re-check affordance on the "Update Available" view._ Rejected: once an update shows, re-checking adds nothing (a newer-still release within the same window is an edge case not worth a button); the next 24h cycle or a page on the new version covers it.

## Risks / Trade-offs

- **[Risk] Manual checks burn the anonymous GitHub rate limit (60 req/h/IP) if hammered.** → ETag makes unchanged responses `304` (still counted, but the button is behind auth on a single-operator dashboard, and `inflight` dedupes concurrency). Accepted without a cooldown; revisit only if real deployments report 403s.
- **[Risk] `checked=error` flash on hosts where the automatic check also fails (air-gapped) may read as "something is broken".** → Copy states it plainly ("could not reach GitHub — this is expected on air-gapped hosts") and links nothing; no log noise added.
- **[Trade-off] `lastCheckedAt` resets on every container restart (in-memory).** → Accepted: consistent with the original D5 decision (no persistence for check state); the line simply doesn't render until the first check.
- **[Trade-off] The quiet slot adds a permanent element to the sidebar for a rarely-needed action.** → Accepted: it doubles as the only discovery path to `/dashboard/update` and replaces nothing — the slot was already reserved for the badge.

## Migration Plan

Nothing migrates. Pure additive dashboard surface; deployments see the quiet link after updating. Rollback = previous image.

## Open Questions

- Exact quiet-link label (`UP TO DATE ›` vs `UPDATES ›`) — decided at implementation against the brutalist style; user explicitly wants to iterate on the rendered UI.
