## ADDED Requirements

### Requirement: Dashboard details SHALL share a compositional content-first layout

Memory, session, judgment and consolidation detail pages SHALL use one shared compositional layout with ReactNode content, metadata, secondary, notice and action slots rather than entity field schemas or registries. Each page SHALL render one page title, a back link and an accessible native ellipsis action disclosure when actions apply. Notices SHALL precede the responsive content grid. Desktop SHALL place primary content left of a 320px inspector. Metadata and applicable review details SHALL be visible on desktop. Mobile SHALL place one initially collapsed metadata disclosure before primary content, with review and secondary disclosures afterward.

Secondary disclosures SHALL start collapsed at both widths, retain native summary markers, and preserve every existing entry and link. Their expanded desktop bodies SHALL have a maximum height of 24rem with overflow scrolling and contained overscroll. Mobile expanded bodies SHALL remain in document flow without a height limit or nested vertical scrolling. No resize hooks, sticky inspector or separate document-scroll architecture SHALL be introduced. Shared detail body text SHALL be readable at 16px, long prose/URLs/code/identifiers SHALL wrap, and muted text SHALL use the existing chart-2 token only within these pages without changing global tokens.

MarkdownPanel reading presentation and visually hidden titles SHALL be opt-in. Existing list/update callers SHALL retain their default presentation and clipboard behavior. Hiding the redundant memory/session panel title SHALL NOT hide the judgment Source/Target memory titles.

#### Scenario: Reading at narrow and desktop widths

- **WHEN** an operator opens any of the four detail pages at 320px or 1440px
- **THEN** the page SHALL use the same shared regions and one page title
- **AND** the metadata disclosure SHALL precede prose in mobile document order
- **AND** desktop metadata SHALL remain visible beside the primary content
- **AND** secondary disclosures SHALL start collapsed, bound expanded desktop bodies and retain mobile document flow without horizontal page overflow

### Requirement: Memory detail SHALL preserve context and mutation safeguards

Memory detail SHALL show its title once, lifecycle status and applicable review or superseded warnings before content. Its combined Details and tags disclosure SHALL contain all metadata followed by a semantic Tags section. Applicable review SHALL follow content on mobile and remain visible in the desktop inspector. The title-inclusive Markdown copy control SHALL retain the compact label Copy and its redundant panel title SHALL remain available to assistive technology.

All existing metadata, confirmation count, source, topic key, creation and last-seen timestamps, replaces ids including unresolved ids, successor links and judgment/counterpart links SHALL remain available. Predecessors SHALL retain chronological title, content snapshot, status and timestamp information in compact lists. Review timing SHALL remain omitted when inapplicable. Confirmation SHALL appear exactly once, archive SHALL remain active-only, and existing no-project/scope guards and archive confirmation SHALL remain unchanged.

#### Scenario: Reading history without losing actions

- **WHEN** a memory has predecessors, a successor, touching judgments or stale review
- **THEN** all existing links, snapshots, timestamps and notices SHALL remain reachable in their current order
- **AND** confirmation and archive SHALL retain their existing eligibility, server guards and confirmation-dialog behavior

### Requirement: Session detail SHALL separate reading content from its copy payload

Session primary content SHALL show its description without repeating a description used as its page title, and its curated summary as Markdown. Uncurated summary text SHALL remain escaped preformatted text with a RAW indicator, never interpreted as Markdown. A session without a summary SHALL retain meaningful visible content. The existing Markdown copy payload SHALL remain unchanged, including title, description, curated summary, Run metadata and prompt excerpts, while inspector-only metadata and prompt excerpts SHALL NOT be duplicated into the visible prose.

Status, agent, project, revoked-token suffix, timestamps, duration and counts SHALL remain available in metadata. Memories and Prompts SHALL remain semantic tables in that order inside secondary disclosures, retaining current data, memory links, timestamps, tags and empty states. No prompt links SHALL be invented. Horizontal table overflow SHALL remain confined within the disclosure, not the page. Active nondeleted sessions SHALL offer abandon and delete, other nondeleted sessions delete, and deleted sessions undelete only. The soft-delete warning, form context, CSRF/DomainError guards, confirmation tones and encoded flash redirects SHALL remain unchanged.

#### Scenario: Inspecting a session and its captured records

- **WHEN** an operator opens a curated, raw or empty session
- **THEN** summary text SHALL retain its corresponding Markdown, escaped preformatted or empty-state treatment
- **AND** Memories and Prompts tables SHALL follow primary content without replacing tables with cards or introducing prompt links
- **AND** lifecycle actions SHALL match current deletion/status eligibility

### Requirement: Judgment detail SHALL keep both compared memories primary

Source and Target SHALL remain two primary sections, each with a visible memory title, Markdown content, its own copy control and memory link. Status, verdict, confidence, actor, timestamps and the opaque judgmentId SHALL remain in the inspector. Reason SHALL remain escaped plain text; evidence SHALL remain escaped pretty JSON with malformed-value fallback, and both MAY use secondary disclosures. Pending-only orphan actions SHALL retain danger confirmation and guarded submission of row.judgmentId even though the route uses row.id. Closed judgments SHALL retain their nonactionable explanation.

#### Scenario: Reviewing a pending comparison

- **WHEN** an operator opens a pending judgment
- **THEN** both memory sections SHALL remain primary and visibly titled
- **AND** orphan submission SHALL use the opaque judgment identifier, not the relation route identifier
- **AND** closing the judgment SHALL remove the action without losing the closed-state explanation

### Requirement: Consolidation detail SHALL keep operations primary

Summary and operations SHALL remain primary content, not collapsed disclosures. Started/finished timestamps, resolved scope with fallback, and operation count SHALL remain in metadata. Each eligible operation SHALL retain adjacent warn-confirmed undo with its hidden opId; terminal or reverted operations SHALL remain nonactionable. Whole-run undo SHALL retain its current eligibility, hidden runId and danger confirmation. Affected and created memory links, reasoning, applied time and empty state SHALL remain available. Queries, mutations and purged-row, terminal and partial-undo error behavior SHALL remain unchanged.

#### Scenario: Inspecting mixed operation states

- **WHEN** a run contains active, terminal and reverted operations
- **THEN** all operations SHALL remain visible in primary content with their existing links and applied timestamps
- **AND** only currently eligible operations SHALL offer adjacent undo
- **AND** whole-run undo SHALL follow the existing active-operation condition without changing server error handling
