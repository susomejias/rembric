## ADDED Requirements

### Requirement: Dashboard details SHALL share a compositional content-first layout

Memory, session, prompt, judgment and consolidation detail pages SHALL use one shared compositional layout with ReactNode content, metadata, secondary, notice and action slots rather than entity field schemas or registries. Each page SHALL render one page title, a back link and an accessible ellipsis action disclosure when actions apply. The action disclosure SHALL close on a pointer interaction outside it or Escape, returning focus to its trigger on Escape. Portalled confirmation dialogs SHALL retain their originating forms while open; closing the action disclosure SHALL NOT unmount those forms or submit them. Notices SHALL precede the responsive content grid. Desktop SHALL place primary content left of a 320px inspector. Metadata and applicable review details SHALL be visible on desktop. Mobile SHALL place one initially collapsed metadata disclosure before primary content, with review and secondary disclosures afterward.

Secondary disclosures SHALL start collapsed at both widths, retain native summary markers, and preserve every existing entry and link. Their expanded desktop bodies SHALL have a maximum height of 24rem with overflow scrolling and contained overscroll. Mobile expanded bodies SHALL remain in document flow without a height limit or nested vertical scrolling. No resize hooks, sticky inspector or separate document-scroll architecture SHALL be introduced. Shared detail body text SHALL be readable at 16px, long prose/URLs/code/identifiers SHALL wrap, and muted text SHALL use the existing chart-2 token only within these pages without changing global tokens.

MarkdownPanel reading presentation and visually hidden titles SHALL be opt-in. Existing list/update callers SHALL retain their default presentation and clipboard behavior. Hiding the redundant memory/session/prompt panel title SHALL NOT hide the judgment Source/Target memory titles. Redundant visible eyebrows such as Memory content, Session log and Prompt content SHALL be omitted. Useful Source/Target and summary/operation labels and copy buttons SHALL remain.

#### Scenario: Reading at narrow and desktop widths

- **WHEN** an operator opens any of the five detail pages at 320px or 1440px
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

Status, agent, project, revoked-token suffix, timestamps, duration and counts SHALL remain available in metadata. Memories and Prompts SHALL remain semantic tables in that order inside secondary disclosures, retaining current data, memory links, timestamps, tags and empty states. Prompt titles SHALL link to their detail route at `/dashboard/prompts/:id`. Horizontal table overflow SHALL remain confined within the disclosure, not the page. Active nondeleted sessions SHALL offer abandon and delete, other nondeleted sessions delete, and deleted sessions undelete only. The soft-delete warning, form context, CSRF/DomainError guards, confirmation tones and encoded flash redirects SHALL remain unchanged.

#### Scenario: Inspecting a session and its captured records

- **WHEN** an operator opens a curated, raw or empty session
- **THEN** summary text SHALL retain its corresponding Markdown, escaped preformatted or empty-state treatment
- **AND** Memories and Prompts tables SHALL follow primary content without replacing tables with cards, and prompt titles SHALL link to their detail pages
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


### Requirement: Prompt detail SHALL be reachable from every prompt row

Prompt titles in the prompts list and the session Prompts table SHALL link to `/dashboard/prompts/:id`. Every prompt list row's View details action SHALL target its prompt, including prompts without a session and soft-deleted prompts. Existing list expansion, session links, filters and lifecycle actions SHALL remain available.

The detail SHALL use the shared content-first layout and show the complete stored prompt safely, one page title, an exact original-content copy payload, status, id, project, agent, tags, creation time, optional session and predecessor prompt links. Missing optional metadata SHALL use a neutral fallback. Unknown ids SHALL return notFound. Soft-deleted content SHALL remain inspectable with a deletion notice and restore only; other prompts SHALL offer the existing guarded delete action with its existing confirmation. Existing server actions SHALL be reused without new mutation logic.

#### Scenario: Following a captured prompt

- **WHEN** an operator follows a prompt title from the list or a session
- **THEN** its detail SHALL show the complete prompt rather than a table excerpt or the session detail
- **AND** copy SHALL preserve the exact stored content, including whitespace
- **AND** unsafe HTML and links SHALL NOT execute

#### Scenario: Inspecting a deleted or unknown prompt

- **WHEN** a soft-deleted prompt is opened
- **THEN** the content and deletion notice SHALL remain visible and only restore SHALL be offered
- **WHEN** the prompt id does not exist
- **THEN** the page SHALL return notFound

### Requirement: Detail action disclosure SHALL dismiss without losing confirmation context

The shared action disclosure SHALL close on an outside pointer interaction or Escape. Escape SHALL return focus to the ellipsis trigger. Its forms SHALL remain mounted even when an interaction with a portalled confirmation dialog closes the disclosure. Cancellation SHALL preserve the record and the originating form association.

#### Scenario: Closing and reopening actions

- **WHEN** an operator opens ellipsis actions and clicks the page heading or presses Escape
- **THEN** actions SHALL close without changing the record
- **AND** reopening and triggering a confirmation SHALL retain the original record id and CSRF form context
