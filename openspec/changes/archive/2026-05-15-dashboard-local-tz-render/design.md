## Context

Every dashboard page renders timestamps through one helper, `formatTs(d)` in `src/dashboard/templates.ts:231`, which returns `YYYY-MM-DD HH:MM:SS UTC`. Storage is `integer('created_at', { mode: 'timestamp_ms' })` (UTC ms since epoch); services write `new Date()`; the MCP tools serialize via `Date.prototype.toJSON()` (ISO with `Z`). The dashboard layout (`shell()` in `templates.ts:191`) injects a single `<head>` block reused by every page.

Call sites for `formatTs` confirmed by grep (read-only, no manual fan-out needed):

| Page                                                      | File                             | Lines                      |
| --------------------------------------------------------- | -------------------------------- | -------------------------- |
| Memories list / detail / project rows                     | `src/dashboard/memories.ts`      | 114, 257, 295              |
| Sessions list / detail / soft-delete banner / memory rows | `src/dashboard/sessions.ts`      | 89, 90, 242, 268, 272, 310 |
| Projects list                                             | `src/dashboard/projects.ts`      | 49                         |
| Consolidation runs / ops / detail                         | `src/dashboard/consolidation.ts` | 67, 68, 152, 173, 177      |
| Relations list                                            | `src/dashboard/relations.ts`     | 139                        |
| Tokens list                                               | `src/dashboard/tokens.ts`        | 45, 46                     |

All consumers route through `formatTs`. That is the single seam; the design exploits it.

## Goals / Non-Goals

**Goals:**

- Every timestamp visible in the dashboard renders in the operator's browser TZ + locale.
- The change is one-helper-deep — no per-page refactors, no per-row JS hook calls.
- No degradation when JS is disabled or fails: the operator still sees a legible, UTC-labelled timestamp.
- The convention "always go through `formatTs`" is documented in `CLAUDE.md` and persisted as a rembric project memory so future contributors and agents can't bypass it without noticing.

**Non-Goals:**

- Touching the SQLite schema, service-layer `new Date()` calls, or MCP wire format.
- Per-user TZ preferences stored server-side.
- An `Intl.RelativeTimeFormat` "2 minutes ago" view (could come later, out of scope).
- A build pipeline / bundler — the script stays inline in the SSR shell.

## Decisions

### Decision 1: `<time datetime="…Z">` + client-side `Intl.DateTimeFormat`

`formatTs` becomes:

```ts
export function formatTs(d): SafeHtml {
  // …null/NaN guard returns raw('—') unchanged…
  const iso = date.toISOString(); // 2026-05-15T16:35:12.345Z
  const fallback = iso.replace('T', ' ').slice(0, 19) + ' UTC';
  return raw(`<time datetime="${iso}" data-rembric-ts>${escape(fallback)}</time>`);
}
```

Return type changes from `string` to `SafeHtml` (already used elsewhere in the same file — `statusPill`, `scopePill`). Callers already interpolate the result inside `html\`…\``tagged templates that accept`SafeHtml`; the value is the same shape, so no per-call-site edits are required beyond verifying the templates re-render.

A small inline script in `shell()`'s `<head>` upgrades every matching element on `DOMContentLoaded`:

```html
<script>
  (function () {
    function upgrade() {
      var nodes = document.querySelectorAll('time[data-rembric-ts][datetime]');
      var fmt = new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
      for (var i = 0; i < nodes.length; i++) {
        var iso = nodes[i].getAttribute('datetime');
        var d = new Date(iso);
        if (!isNaN(d.getTime())) nodes[i].textContent = fmt.format(d);
      }
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', upgrade);
    } else {
      upgrade();
    }
    // HTMX swaps inject new content; re-upgrade after each swap.
    document.body && document.body.addEventListener('htmx:afterSwap', upgrade);
  })();
</script>
```

The script is idempotent: it rewrites `textContent` from `datetime` every time, so re-running on the same nodes after an HTMX swap is safe.

**Why this over alternatives:**

| Alternative                                                                                   | Rejected because                                                                                                                                                  |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server-side `Intl.DateTimeFormat` with a single fixed TZ via env var (`REMBRIC_DASHBOARD_TZ`) | Forces all operators into one TZ; bad for distributed teams; adds config surface.                                                                                 |
| Per-user TZ preference stored in `dashboard_sessions`                                         | New schema, new endpoint, new form. Massive cost for a render-only problem.                                                                                       |
| Hand-formatted local string on the client (no `Intl`)                                         | Bad i18n; reinvents wheels; locale-month names are a pain. `Intl.DateTimeFormat` ships in every browser the dashboard already targets (HTMX + Pico is post-2018). |

### Decision 2: Keep UTC as the no-JS fallback text content

Operators occasionally hit the dashboard from environments with strict CSP or pre-render snapshots (tests, screenshots, accessibility tools). The current UTC string is unambiguous and machine-parseable; keeping it as the initial `textContent` means the worst-case render is "exactly today's behaviour" — never blank, never `Invalid Date`.

### Decision 3: Convention codified in `CLAUDE.md` + rembric memory

Two storage locations on purpose:

- `CLAUDE.md` (project file, checked in): the contract for human reviewers and agents that read the project file. Add a short subsection under the existing dashboard-related guidance: "Dashboard timestamps MUST go through `formatTs` from `src/dashboard/templates.ts`; never inline `toISOString()` / `toLocaleString()` / hand-formatted strings in templates. The helper emits `<time data-rembric-ts>` and a client script localizes it."
- `rembric` project memory (`memory.save`, `type=feedback`, scope=project): the contract for agents that recall via rembric instead of (or before) reading `CLAUDE.md`. The same wording, plus the rationale (TZ correctness + single-seam upgrade path).

Belt-and-braces is intentional: agents converge on either source.

### Decision 4: Cover HTMX swaps

The memories filter form, sessions filter form, and consolidation run detail use HTMX partial swaps. Without re-running the upgrader, swapped rows render the SSR UTC fallback. The script listens for `htmx:afterSwap` (a documented HTMX event) and re-upgrades. HTMX is already loaded by the layout; no new dependency.

## Risks / Trade-offs

- **[Risk]** Tests that assert on the literal string `" UTC"` in dashboard HTML output break. → **Mitigation**: those assertions are intentionally outdated; update them to match the new `<time datetime="…">…UTC</time>` shape. Identified by `grep -rn '" UTC"' src/dashboard/` in tasks.
- **[Risk]** `formatTs` return type changes from `string` to `SafeHtml`. → **Mitigation**: all known call sites are inside `html\`…\``tagged templates already accepting`SafeHtml`; the type-checker will catch any leaked `+` concatenation usage. Add one test pinning the new return type.
- **[Risk]** Operators on legacy browsers without `Intl.DateTimeFormat` (none expected — Pico.css/HTMX already require modern browsers). → **Mitigation**: the SSR fallback is the safety net; failure mode is "user sees UTC", not "user sees nothing".
- **[Trade-off]** The dashboard no longer renders identical HTML across machines (textContent depends on browser TZ post-upgrade). Visual regression diffs that depend on `textContent` will need to mock the TZ. We accept this; the `datetime` attribute is deterministic and good enough for snapshot tests if needed.

## Migration Plan

1. Land all changes behind a single PR. No DB migration. No env var.
2. Rollback: revert the PR. Behaviour returns to UTC-only. No data side effects.
3. Communication: mention in the next release notes / changelog ("Dashboard now renders local time").

## Open Questions

- Should `formatTs(null)` also return `SafeHtml` (currently `raw('—')` semantics)? → Yes, for type uniformity. Documented in tasks.
- Should the script also pick up `<time>` elements without `data-rembric-ts`? → No. The marker keeps us from upgrading unrelated `<time>` elements that future code might emit with a different intent.
