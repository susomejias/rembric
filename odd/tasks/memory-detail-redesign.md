# Memory and session detail redesign + image share (direction A · Ficha)

Redesign `/dashboard/memories/[id]` to match the approved mockup `/tmp/rembric-memory-redesign/mockup.html` (direction A).
Other detail pages (session, prompt, judgment, consolidation) follow later, after this one is approved in the browser.

## Specs

- S1 Layout A: document left, shared context rail right (300px desktop). Header = Memories/topic breadcrumb, one title, lifecycle status and byline, prominent tags, then Copy / Share / applicable Confirm / active-only Archive directly. Memory type is in Properties, not a project-looking badge. Desktop header/content spacing is 24px before and after the divider; mobile spacing stays unchanged.
- S2 Rail order: Review → History → flat Judgments → Properties (Type, Topic, Scope, Source, Confirmations, ID). Judgments and Properties start collapsed at every viewport; counts remain visible. Tags are not repeated in Properties.
- S3 Large data: History shows first version, "+ N intermediate versions" (expands in place), previous version, current, successor. Judgments: pending first, then at most 3 more, then "Show all N judgments" expanding in place. Tags: show 6, then "+N" chip expanding in place. No nested scroll, no sticky rail.
- S4 States: needs_review → orange full-width notice with Confirm (Confirm appears once, only in the notice); superseded → neutral notice "Replaced on <date> by <successor link>", Review section hidden, Confirm hidden; archive stays active-only.
- S5 Mobile (< ~760px): single column; rail follows content; Judgments and Properties are initially collapsed. Sticky bottom actions Copy / Share / applicable Confirm / Archive fit at 320/390px without page overflow; code scroll stays local.
- S6 Labels in sentence case (no tracked uppercase eyebrows) on this page; keep existing zinc/lime/Geist tokens (no token changes).
- S7 Preserve: all data/links (predecessor/successor/judgment/counterpart links, unresolved replaces ids), copy payload `# title\n\ncontent`, confirm/archive server actions, CSRF/guards, ConfirmSubmit archive dialog, justConfirmed status message.

- S8 Share as image: one format, 1080px wide and minimum height 1080px, growing for complete selected content. Real generated PNG preview; Content/Summary, Project name and session-only Stats toggles. Supported native file sharing, real download and capability-gated image copy. Generation stays local, errors are explicit, no upload. Format selector and simulated actions are removed.
- S9 Card: approved Constelación style, dark zinc with decorative network only above the title. Brand, centered Memory/Session label and date, 76px title, byline, memory tags, then full readable content aligned at x80. No green content rule or decorative side rails. Tags have a lime # and light name centered inside bordered pills. Preserve fonts/spacing; section headings stay normal case and image links have no underline. Use the same ReactMarkdown/GFM renderer as views, with local Tailwind export styling, not another text-layout engine. RAW session content stays literal.
- S10 Session detail uses the shared Ficha layout. Header: title, lifecycle status/agent/project/start metadata (agent in the primary lime shadcn Badge), Copy and Share with direct applicable Abandon/Delete/Undelete controls and existing confirmations. Main content remains curated Markdown or escaped RAW, with the original copy payload. Rail: Stats → one chronological History → collapsed Properties. History tells the recorded sequence using start, prompts, memories and reliable existing lifecycle milestones; it does not repeat separate capture tables or invent prompt-to-memory causality. With more than five captures, show the first two and last three, with the counted middle expanding inline in chronological position. Keep 50–100+ memories compact, no nested vertical scroll or new event store; do not infer resumes from lastActivityAt. Each item occupies at most two lines (title/date); move type, status, tags, excerpts and out-of-run context into the focusable/clickable dot tooltip. Active dots are lime, Superseded dots reuse warning orange, other captures are zinc and lifecycle dots use a neutral ring. Expansion continues the same rail/column, without a container dot. Preserve metadata/links, all server guards and the deleted warning; counts replace redundant NO PROMPT/MEMORY messages. Do not add a Summary heading above content or fabricate duration for a terminal/deleted session without endedAt.
- S11 Session card: as S9 plus three stat tiles (memories in lime, prompts, duration) under the byline.

## Tasks

- [x] T1 S1–S7 Memory detail redesign · verified at 320/390/820/1440
- [x] T2 S8–S9 Memory share image · real PNG, Markdown matrix, privacy, clipboard and accessibility verified
- [x] T3 S10 Session detail redesign · compact History, actual 102-capture browser fixture and guarded lifecycle actions verified
- [x] T4 S11 Session share image · actual Stats/privacy/content toggles and native PNG clipboard/download verified
- [x] T5 Final global regression after the last controls · typecheck, lint, full workspace suites, OpenSpec, diff-check, 23 mutations, production build and actual browser/PNG checks pass

Implementation is authorized on main. The memory/shared-render unit was committed without push. The user now authorizes committing the verified radius and session units and pushing all three units to main, including the last primary agent-badge refinement. Further detail-view commits are not authorized by this delivery instruction. All details reuse the same layout and guarded operations; Share is limited to memories, sessions and prompts. Issue #427 records future MCP image generation, excluded here. Mockups remain visual references, never simulated export implementations.

## Delivery units

- `f14dce03ff96290b0b43bb40e90af5624a44ef53` — shared control radii, viewport-bounded/clickable tooltips and optional disclosure previews, with their tests. This unit has 317 changed lines and is independently applicable before the session page.
- `feat(dashboard): add compact Ficha session history and sharing` — this session feature unit contains the session route, its paired detail/XSS regressions and the active proposal/ODD evidence. It exceeds the usual 400-line review budget because the complete chronology, RAW/copy, action and 102-capture regression cases stay with the behavior; coverage is not removed to shrink the diff.
- Rollback the session unit before the shared-control unit. Both are presentation-only: no schema, stored content, query scope or mutation guards change. The memory/renderer commit `831e588612c9b3bdd3095eebfeee0eb13f444fe0` remains independent.
- Evidence: final workspace suites (1359 web tests passed, 6 skipped), 73 focused checks after the primary-agent badge, 23 guard mutations plus the badge-variant mutation, production build 5/5, four viewport sizes, 102 captured records and native lifecycle/clipboard/PNG probes.

## Log

- L1 "Necesito que me hagas un rediseño completo de las página de detalle, layout y diseño general, empezamos por la de memoria y luego ya continuamos cuando tengamos la primera bien diseñada, antes de ponernos con ello necesito ver un mockuo de como quedaría antes de implementar"
- L2 Judgments grouping proposal rejected: "Nahh déjalos como estaba" — tags made more visible instead.
- L3 Large-data handling and responsive fixes approved in mockup. "ok, creo que me quedo con la dirección A, la de ficha"
- L4 "pero no implementes todavía"
- L5 "ahora me gustaría crear un diseño para compartir la memoria mediante una composición visual en png con el share nativo, hazme el mockup de esto también y ya dejamos cerrado todo el diseño"
- L6 "haremos los mismo para la sesión, mismo layout que hemos planteado para la vista de detalle y si podemos hacer mismo del share que vamos a hacer para memoria"
- L7 "ok, pero necesito que sea mas minimalista quitando el version, confirmed etc, además se debe de ver todo el contenido no sombrearlo"
- L8 "prueba con un contenido largo para ver como queda, además necesito que sea como mas visual, el copy project memory - rembric tampoco me cuadra dale un ojo"
- L9 "ehh ok, pero hazlo mas visual no me termina de convencer ese banner/header" → three header options in mockup (Red / Ondas / Lomo), pending choice.
- L10 "ok, me gusta algo mas pero dale otra vuelta" → Póster and Constelación added.
- L11 "ok, nos quedamos con la versión de constelación"
- L12 "aunque los tags los movería arriba en memoria/sesiones con mucho contenido igual se pierden un poco abajo del todo no?"
- L13 "ok, en la parte de sesión mete también la opción para ocultar la parte de los contadores de memorias, prompts etc"
- L14 "ok, pues con esto listo vamos a implementar no? si hay alguna duda me preguntas" — authorization replaces the earlier pause. Memory first, then session; no other detail redesign in this unit.
