## ADDED Requirements

### Requirement: Dashboard details SHALL share a compositional content-first layout

Memory, session, prompt, judgment and consolidation detail pages SHALL use one shared compositional layout with ReactNode content, metadata, secondary, notice and action slots rather than entity field schemas or registries. Each page SHALL render one page title, a back link and an accessible ellipsis action disclosure when actions apply. The action disclosure SHALL close on a pointer interaction outside it or Escape, returning focus to its trigger on Escape. Portalled confirmation dialogs SHALL retain their originating forms while open; closing the action disclosure SHALL NOT unmount those forms or submit them. Notices SHALL precede the responsive content grid. The default layout SHALL place primary content left of a 320px inspector on desktop, and one initially collapsed metadata disclosure before primary content on mobile. Memory and session SHALL instead opt into the approved Ficha presentation: header metadata and actions, document left, a 300px context rail right, and a single-column mobile document with a bottom action bar. Other detail pages SHALL retain their existing presentation.

Default secondary disclosures SHALL start collapsed at both widths, retain native summary markers, and preserve every existing entry and link. Their expanded desktop bodies SHALL have a maximum height of 24rem with overflow scrolling and contained overscroll. Ficha secondary sections SHALL expand in normal document flow at every width, without nested vertical scrolling or a height limit. Mobile expanded bodies SHALL remain in document flow without a height limit or nested vertical scrolling. No resize hooks, sticky inspector or separate document-scroll architecture SHALL be introduced. Shared detail body text SHALL be readable at 16px, long prose/URLs/code/identifiers SHALL wrap, and muted text SHALL use the existing chart-2 token only within these pages without changing global tokens.

MarkdownPanel reading presentation and visually hidden titles SHALL be opt-in. Existing list/update callers SHALL retain their default presentation and clipboard behavior. Hiding the redundant memory/session/prompt panel title SHALL NOT hide the judgment Source/Target memory titles. Redundant visible eyebrows such as Memory content, Session log and Prompt content SHALL be omitted. Useful Source/Target and summary/operation labels and copy buttons SHALL remain.

#### Scenario: Reading at narrow and desktop widths

- **WHEN** an operator opens any of the five detail pages at 320px or 1440px
- **THEN** the page SHALL use the same shared regions and one page title
- **AND** default details SHALL retain metadata before mobile prose and bounded desktop disclosures
- **AND** Ficha details SHALL keep identifying metadata in the header and secondary sections after mobile prose
- **AND** neither presentation SHALL introduce horizontal page overflow

### Requirement: Memory detail SHALL preserve context and mutation safeguards

Memory detail SHALL show its title once, lifecycle status and applicable review or superseded warnings before content. Header metadata SHALL include project, source agent and creation time; memory type SHALL remain available in Properties rather than an ambiguous header badge; tags SHALL follow in prominent chips, with six initially visible and an in-place expansion for the remainder. Copy and Share SHALL be header actions, not a separate content toolbar, with the same controls reachable in the mobile bottom bar. Copy SHALL preserve `# title\n\ncontent` exactly. The content section SHALL retain an accessible label. The rail SHALL contain applicable Review, History, flat Judgments and Properties in that order. Superseded memories SHALL hide Review and Confirm; a needs-review notice SHALL own the sole Confirm control. Archive SHALL remain active-only and appear alongside the primary header actions, without an otherwise empty overflow menu.

All existing metadata, confirmation count, source, topic key, creation and last-seen timestamps, replaces ids including unresolved ids, successor links and judgment/counterpart links SHALL remain available. Predecessors SHALL retain chronological title, content snapshot, status and timestamp information in compact lists. History SHALL initially expose the origin, previous and current versions and any successor, with intermediate versions expanding in place. Judgments and Properties SHALL initially be collapsed disclosures on every viewport, with judgment counts visible in the summary. Opening Judgments SHALL reveal a flat list showing all pending entries plus at most three resolved entries, with the rest reachable through Show all. Opening Properties SHALL reveal all remaining metadata and unresolved replacement ids. Review timing SHALL remain omitted when inapplicable. Confirmation SHALL appear exactly once, archive SHALL remain active-only, and existing no-project/scope guards and archive confirmation SHALL remain unchanged.

#### Scenario: Reading history without losing actions

- **WHEN** a memory has predecessors, a successor, touching judgments or stale review
- **THEN** all existing links, snapshots, timestamps and notices SHALL remain reachable in their current order
- **AND** confirmation and archive SHALL retain their existing eligibility, server guards and confirmation-dialog behavior

### Requirement: Session detail SHALL separate reading content from its copy payload

Session primary content SHALL show its description without repeating a description used as its page title, and its curated summary as Markdown, without an automatically added Summary heading. Uncurated summary text SHALL remain escaped preformatted text with a RAW indicator, never interpreted as Markdown. A session without a summary SHALL retain meaningful visible content. The existing Markdown copy payload SHALL remain unchanged, including title, description, curated summary, Run metadata and prompt excerpts, while inspector-only metadata and prompt excerpts SHALL NOT be duplicated into the visible prose.

Status, agent, project, revoked-token suffix, timestamps, duration and counts SHALL remain available in metadata. The header agent SHALL use the existing primary shadcn Badge, with lime fill and near-black text. The Ficha rail SHALL contain run statistics, one compact History and Properties last. History SHALL merge session start, captured prompts, written memories and reliably stored lifecycle milestones by their actual timestamps, with deterministic ordering for ties. Visible History items SHALL occupy at most two lines for title and timestamp, with no status badges, tag blocks, excerpts or out-of-run indicators alongside them. A keyboard-focusable timeline dot SHALL expose the complete title, type, status, tags, excerpt and available context through the existing accessible tooltip primitive, opened by focus or activation including touch. Lifecycle dots SHALL use a neutral ring; active memories SHALL use lime, superseded memories the existing warning orange, and other captures zinc, not a new color per event. Expanded intermediate items SHALL align with the same rail and text column, without a duplicate container dot or indentation. Empty prompt/memory counts SHALL NOT add separate banner-like messages. History SHALL retain all record titles, types, status, timestamps, prompt excerpts, tags and links through those tooltips and navigation, without duplicating separate Memories and Prompts tables or implying an unrecorded causal relation between a prompt and a memory. Captures outside the recorded run interval SHALL retain their real dates rather than being relabeled to fit the interval. For more than five capture events, the first two and last three SHALL remain visible while intermediate captures expand in place from a counted marker at their chronological position; smaller histories SHALL show every capture. This compact presentation SHALL remain usable with 50–100 or more memories per session, without nested vertical scrolling, new pagination or additional event storage. The narrative SHALL use already-loaded start, latest terminal/deletion and capture facts without extra event queries or a new event store. Resume history SHALL NOT be inferred from mutable last-activity or current-status fields; unavailable historical milestones SHALL not be invented. A terminal or deleted session without an end timestamp SHALL NOT receive a fabricated end time, elapsed duration or Running for label. Prompt titles SHALL link to their detail route at `/dashboard/prompts/:id`. Active nondeleted sessions SHALL offer direct abandon and delete actions beside Copy and Share, other nondeleted sessions direct delete, and deleted sessions direct undelete only. The soft-delete warning, form context, CSRF/DomainError guards, confirmation tones and encoded flash redirects SHALL remain unchanged.

#### Scenario: Inspecting a session and its captured records

- **WHEN** an operator opens a curated, raw or empty session
- **THEN** summary text SHALL retain its corresponding Markdown, escaped preformatted or empty-state treatment
- **AND** compact History SHALL follow primary content on mobile, with prompts and memories linked to their detail pages and intermediate capture events expandable in place
- **AND** lifecycle actions SHALL be directly reachable and match current deletion/status eligibility

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

### Requirement: Memory and session details SHALL export complete local PNG cards

Share SHALL open an accessible preview dialog using the selected Constelación design only: dark zinc, a decorative network with a lime node above the title, Memory or Session label, date, title and agent/project byline. The network SHALL NOT imply actual relation data. Memory tags SHALL precede content. No lifecycle status, version or confirmation facts SHALL appear in the image.

Sharing SHALL use one format with width 1080 and minimum height 1080, without a format selector. The image SHALL grow to include the complete selected content without truncation, fading or silently omitted lines; preview SHALL show the generated PNG and its actual dimensions. Markdown SHALL use the same semantic renderer as dashboard views, including GFM tables, task lists, strikethrough and footnotes, while preserving the approved PNG typography and layout independently of view styling. PNG capture SHALL rasterize that rendered card locally, not maintain a second Markdown parser or text-layout engine. RAW session text SHALL remain literal. Content/Summary and Project name controls SHALL affect the exported file, not just a preview overlay. Session-only Stats SHALL default on and hide memory/prompt/duration tiles plus date-adjacent duration when off.

Generation SHALL be local and SHALL NOT upload data. Unsupported images or export-size limits SHALL produce an explicit error, never a partial image presented as successful. Native file sharing SHALL only be offered when canShare accepts the generated file. Otherwise Download PNG SHALL be primary. Image clipboard copying SHALL be available only when supported. Share cancellation SHALL not be reported as success; failures SHALL remain recoverable through visible feedback and download. Pending or failed generation SHALL not expose a stale previous image as the current export.

#### Scenario: Sharing long private memory content

- **WHEN** the operator opens Share, selects long content and disables Project name
- **THEN** the generated PNG SHALL include the full content and tags above it, omit project attribution and display its measured dimensions
- **AND** changing included data SHALL regenerate the current preview and file
- **AND** unsupported native sharing SHALL retain an actual PNG download

#### Scenario: Sharing a session without statistics

- **WHEN** the operator disables Stats
- **THEN** the generated PNG SHALL omit all three stat tiles and duration next to the date
- **AND** the summary toggle SHALL remain independent
