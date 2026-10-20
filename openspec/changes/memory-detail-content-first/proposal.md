# Content-first dashboard details

## Why

The approved memory detail establishes a readable content-first layout. Sessions, judgments and consolidation runs need the same responsive structure without separate entity-specific layout implementations or loss of their existing data and actions.

## What changes

- Extract the current memory layout into one shared compositional `DetailLayout` and native `DetailDisclosure`, using ReactNode slots rather than entity schemas or configuration.
- Desktop: content left, 320px inspector right. Metadata and applicable review remain visible; secondary disclosures start collapsed and expanded bodies are bounded to 24rem with contained scrolling.
- Mobile: one collapsed metadata disclosure before prose; review and secondary disclosures afterward in document flow. Keep native details, document scrolling and wrapping of long prose, URLs, code and identifiers.
- Memory retains its single title, title-inclusive clipboard payload, combined details/tags, review notices, chronological predecessor snapshots and judgment links.
- Session separates visible description/curated summary from its unchanged copy payload. Uncurated summaries remain escaped preformatted text. Memories then Prompts remain semantic tables with their existing data and empty states, with horizontal overflow confined to disclosures.
- Judgment retains two primary Source/Target sections with visible memory titles, Markdown, copy controls and memory links. Reason and evidence remain escaped secondary content. The mutation still submits the opaque judgmentId, not the route relation id.
- Consolidation keeps summary and operations primary, per-operation undo next to each eligible operation, and existing whole-run undo eligibility.
- MarkdownPanel presentation, optional eyebrow and hidden-title options are opt-in; existing callers keep their defaults. Omit redundant Memory content and Session log labels, preserving useful Source/Target labels and copy buttons. Clipboard behavior is unchanged. Readable muted text uses chart-2 only inside shared detail layouts; no token changes.
- Add `/dashboard/prompts/:id` with the same shared layout, complete safe content, exact clipboard payload, metadata and existing guarded delete/restore actions. Link prompt titles from both list and session tables; View details targets the prompt rather than its session.
- Close the shared ellipsis action disclosure on outside pointer interaction or Escape without unmounting its forms or interrupting confirmation dialogs.

## Impact

Five detail pages, one shared layout, dismissible actions, opt-in Markdown presentation, scoped CSS and focused regression tests. Existing queries, ordering, server actions, authorization, CSRF guards, confirmation tones and redirect behavior remain unchanged. No backend, authentication, package or dependency changes.
