## Implementation

- [x] Add failing order, single-title and history-disclosure regression tests before implementation.
- [x] Reorganize memory detail into a reading column and scoped responsive inspector with one combined Details and tags disclosure.
- [x] Reduce mobile title size and use the compact Copy label to bring prose earlier on narrow viewports.
- [x] Preserve metadata, links, chronological snapshots, mutation guards and archive confirmation.
- [x] Retain title-inclusive Markdown copying through an optional backward-compatible copy payload.
- [x] Keep the panel heading screen-reader-only rather than removing it from the accessibility tree.
- [x] Force only desktop metadata/review visible; keep predecessor and judgment disclosures collapsed with native markers and bound expanded desktop bodies to 24rem without losing links.
- [x] Scope readable muted text to the existing chart-2 token without changing identity tokens.
- [x] Run focused memory, session and judgment dashboard regression tests, including all links across twelve secondary entries.

## Four-page shared layout extension

- [x] Extract the current dirty memory implementation into one compositional layout and native disclosure component.
- [x] Replace memory-specific layout selectors with shared metadata/content/secondary regions.
- [x] Migrate memory and session first, preserving copy payloads, escaped raw summaries, semantic session tables and action guards.
- [x] Migrate judgment and consolidation second, retaining visible Source/Target headings and primary operations with adjacent undo.
- [x] Capture failing page-composition tests before each migration unit and focused passing tests afterward.
- [x] Cover session lifecycle action eligibility, raw/curated/empty content, semantic tables and revoked-token metadata; judgment opaque-id submission and closed states; consolidation mixed/empty/reverted operations and scope fallback.
- [x] Format edited files and run diff whitespace checks.
- [x] Extend the active proposal and delta spec to all four pages without editing canonical specs.
- [x] Parent: verify all four routes at 320px and 1440px, including long-token wrapping, metadata visibility and collapsed secondary behavior.
- [x] Parent: verify native expanded secondary bodies are bounded/contained on desktop and normal document flow on mobile, including horizontal session-table overflow.
- [x] Parent: exercise clipboard payloads and mutation confirmation form association after shared extraction.
- [x] Parent: re-run accessibility checks, especially Source/Target titles and unique page headers.
- [x] Make the shared table scroll container keyboard-focusable, with a failing session regression before the fix and successful ArrowRight scrolling afterward.

Post-extraction browser checks passed on all four routes at both widths. The session fixture contained twelve memories and two prompts; the consolidation fixture contained active, terminal and reverted operations. Desktop secondary bodies stayed within 384px, while mobile bodies had no vertical height limit. Four native clipboard writes succeeded, and five confirmation dialogs retained their originating form, CSRF field and record identifier; cancellation preserved the records. The empty run offered no undo.

Axe found no violations within `.detail-layout` after the table focus fix. Contrast checks for clipped content and the non-text ellipsis remained incomplete. A separate whole-page scan reported contrast violations in the unchanged global navigation and footer, outside this change. The table focus regression went from one failure and ten passes to seventeen passes across session and consolidation tests.

## Requested navigation and interaction followups

- [x] Add a shared-layout prompt detail route with full safe content, metadata, exact clipboard payload and the existing guarded lifecycle actions.
- [x] Link prompt titles from the main list and session table; make View details target the prompt itself, including unlinked/deleted prompts.
- [x] Remove redundant Memory content and Session log eyebrows without removing copy buttons or useful Source/Target labels.
- [x] Add an accessible action disclosure with outside-pointer and Escape dismissal while keeping its forms mounted.
- [x] Run prompt/list/session regressions, including full titles, null metadata, unsafe content, deleted and missing states.
- [x] Verify final menu dismissal, trigger focus and confirmation cancellation in the running application.
- [x] Verify prompt detail navigation from both tables, responsive rendering, scoped accessibility and exact clipboard contents.
- [x] Run typecheck, lint, the web suite, strict OpenSpec validation and whitespace checks after the followups.

Prompt navigation tests were captured red before implementation (seven failures and twenty passes), then green (twenty-eight passes). Removing the memory eyebrow was red with one failure and six passes, then green with seven passes. The original ellipsis was reproduced red in Chrome because clicking the page heading left it open. The final implementation reuses installed Radix Popover, keeps forms mounted with forceMount, and hides only its closed panel. Confirmation-count tests target actual alert-dialog triggers rather than every dialog-like popover.

Final browser checks passed outside click, Escape, trigger focus, CSRF/id form association and confirmation cancellation. Prompt links from both session and main list reached the complete detail. At 320px and 1440px there was no page overflow and scoped axe found no violations; native clipboard writing preserved the full original prompt. Redundant visible labels were absent. The checker used its own visible window because headless cancellation could retain a closed animation node; the user's original browser was not resized or navigated. Typecheck, lint, 1262 passing web tests (6 skipped), strict OpenSpec validation and whitespace checks passed.

## Prior memory-only parent verification (before shared extraction)

- [x] Verify desktop metadata/review visibility, collapsed secondary panels, bounded expanded bodies and normal mobile disclosure flow at 320px and wider viewports.
- [x] Re-run axe for contrast and heading accessibility after the scoped fixes.
- [x] Verify long topic keys, URLs and code wrap without horizontal page overflow.
- [x] Exercise clipboard, ellipsis disclosure, confirm and archive dialog in the isolated visual environment.

Browser checks at 320px and 1440px passed. Five judgments start collapsed; their expanded desktop body measures 384px with 615px of scrollable content and all five entries retained. Mobile uses document flow. Axe reported zero violations in the memory detail at both widths; contrast checks for clipped rows and the non-text ellipsis remained incomplete. Copy preserved the title, archive cancellation preserved active status, and confirmation incremented the count.
