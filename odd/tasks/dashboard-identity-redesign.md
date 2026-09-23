# Dashboard identity redesign — Overview first

Owner-approved total dashboard redesign (explored in OpenPencil, frames
`Overview · Ops v2` desktop 0:439 + `Overview · Mobile` 0:630). No SDD by owner
decision (fast iteration); OpenSpec change deferred as tech debt — tokens were
locked in `openspec/specs/dashboard/spec.md`, must be formalized before merge
to main is considered final.

## Design contract (from approved mockups)

- Dark monochrome + lime `#c6f24e` as the ONLY accent (Spectrum UI language).
- Surfaces: bg `#09090b`, card `#101012`, raised `#18181b`, borders 1px `#1f1f23`.
- Text: `#fafafa` primary, `#a1a1aa` secondary, `#71717a` muted, `#3f3f46` faint.
- Fonts: Geist (UI + display), Geist Mono (labels/meta/data), self-hosted woff2.
- Radius 16 (cards) / 12 (inputs, small cards) / 10 (buttons).
- Shell: NO sidebar. Floating command bar (logo, nav: Overview, Memories,
  Sessions, Judgments, Projects + `⌘K` search slot + avatar). Mobile: compact
  bar + drawer.
- Overview widgets (each with `view all` affordance to its page):
  1. Memory activity chart (saves/day bars lime, archived/day gray) —
     `memories.created_at` + `consolidation_ops` journal.
  2. Active sessions (featured, lime gradient + tinted border) — `sessions`.
  3. Latest judgments (3 rows, relation chips) — `memory-relations`.
  4. Consolidation health (ops journaled, last sweep, next decay, % reversible)
     — `consolidation_runs`/`consolidation_ops`.
  5. Active tokens (compact) — `tokens`.
  6. Live agent activity feed — derived from recent memories/sessions rows.
  7. System health — PRAGMA/diagnostics.
- Data rules (owner-confirmed): NO request metrics (would need event logging —
  rejected, BD must not grow); no duplicated KPIs; storage shown as auxiliary
  note only; greeting has no personal name.
- Mobile `<768px`: single column stack, sessions first, compact top bar.

## Tasks

1. [x] Branch `redesign/dashboard-identity` + this file.
2. [x] Fonts: vendor Geist + Geist Mono woff2 (400/500/600), wire in
       `app/layout.tsx` + `@theme` mapping in `globals.css`.
3. [x] Tokens: replace shadcn neutral dark with zinc monochrome + lime (keep
       `--primary` lime and `--warn`); radius 1rem.
4. [x] Shell: `command-bar.tsx` (desktop bar + mobile drawer via Sheet),
       replace `SidebarFrame` in `dashboard/layout.tsx` (nav badges preserved).
5. [x] Overview page rework to the approved layout, real queries only.
6. [x] Remaining dashboard pages: restyle pass against new tokens (mechanical
       once tokens flip — borders/radius/typography inherit).
7. [x] Responsive pass `<768px` on Overview.
8. [ ] Verify: typecheck, lint, unit tests; visual check vs mockups via
       `next dev` + browser.
9. [ ] Formalize OpenSpec change for the token unlock (tech debt, before
       merge to main is treated as final).

## Evidence log

- (filled per task with commit ids)
