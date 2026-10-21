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
- S10 Session detail uses layout A (mockup /tmp/rembric-memory-redesign/session.html): header title, status pill (Ended/Running/Deleted), agent pill, "in <project>, started <date>"; actions Copy, Share, ··· (Abandon/Delete/Undelete with existing confirmations). Left: summary (curated Markdown or escaped RAW). Rail: stats (memories, prompts, duration/running), Run timeline (started, first memory, ended/still running), Memories (5 + "Show all N"), Prompts (title + one-line excerpt, linking to prompt detail), Properties (ID, Agent, Token, Project). Deleted → notice. Copy payload unchanged.
- S11 Session card: as S9 plus three stat tiles (memories in lime, prompts, duration) under the byline.

## Tasks

- [x] T1 S1–S7 Memory detail redesign · verified at 320/390/820/1440
- [x] T2 S8–S9 Memory share image · real PNG, Markdown matrix, privacy, clipboard and accessibility verified
- [ ] T3 S10 Session detail redesign · authorized, after memory browser verification
- [ ] T4 S11 Session share image · authorized, after T3
- [ ] T5 Focused regression tests, real PNG/clipboard/download and responsive browser verification

Implementation is authorized on main. The user now authorizes committing the completed and verified memory/shared-render unit, without push, then continuing with the other detail views. All details reuse the same layout and guarded operations; Share is limited to memories, sessions and prompts. Issue #427 records future MCP image generation, excluded here. Mockups remain visual references, never simulated export implementations.

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
