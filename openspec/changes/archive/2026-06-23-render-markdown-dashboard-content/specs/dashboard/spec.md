## ADDED Requirements

### Requirement: Long text content on detail views MUST be rendered as Markdown

On detail views, the dashboard SHALL render long text `content` fields as Markdown using an in-process parser, rather than displaying the raw Markdown source inside an escaped `<pre>` block. This applies to: memory detail content (`/dashboard/memories/:id`), session description (seed goal) and session summary (`/dashboard/sessions/:id`), the expanded prompt content cell (`/dashboard/prompts`), and the Source and Target memory content on the judgment detail view (`/dashboard/judgments/:id`).

Fields that are NOT free-form Markdown content SHALL NOT be Markdown-rendered: the judgment Reason SHALL remain a plain (escaped) paragraph, and the judgment Evidence SHALL remain a `<pre>` block because it is pretty-printed JSON.

The Markdown parser SHALL be configured to **disable raw HTML passthrough** (`html: false`): any HTML tags present in the source SHALL be rendered as escaped text, never as live markup. The parser SHALL reject dangerous URL schemes (e.g. `javascript:`, `vbscript:`, `data:`) in links, leaving the affected link inert. No separate HTML sanitizer SHALL be required for safety. The rendered HTML SHALL be the **only** value passed through the template's raw/unescaped path; user-supplied content SHALL never bypass escaping except as the parser's output.

The rendering SHALL be performed entirely server-side and in-process; no CDN, network call, or client-side JavaScript SHALL be required to display formatted content. Rendering SHALL reuse the locked brutalist design tokens and self-hosted fonts; it SHALL NOT introduce a new design token, and fenced/inline code SHALL remain monospace.

Each rendered Markdown block SHALL provide an icon-only control that copies the verbatim Markdown source to the clipboard, so the raw source remains recoverable behind the render. The source SHALL be carried in the page (not re-fetched) such that copying yields the original source — including the literal `**`, backticks, and fences — rather than the rendered HTML. The control SHALL function in non-secure (plain-HTTP) deployments via a clipboard fallback. This control is a progressive enhancement; the formatted content itself SHALL still render with JavaScript disabled.

List and table views SHALL NOT render Markdown: truncated `content` snippets in list cells SHALL remain plain escaped text.

#### Scenario: Memory detail renders Markdown formatting

- **WHEN** an authenticated operator opens `/dashboard/memories/:id` for a memory whose content contains `**bold**`, inline `` `code` ``, a fenced code block, and a bulleted list
- **THEN** the page SHALL render the bold span, inline code, code block, and list as formatted HTML elements
- **AND** the literal characters `**`, `` ` ``, and ```` ``` ```` SHALL NOT appear as visible source text

#### Scenario: Raw HTML in content is rendered inert

- **WHEN** a memory's content contains `<script>alert(1)</script>` or any other raw HTML tag
- **THEN** the detail view SHALL display that text escaped (visible as literal characters), and SHALL NOT execute or inject it as live markup

#### Scenario: Dangerous link schemes are dropped

- **WHEN** a memory's content contains a Markdown link whose URL uses a `javascript:` (or other dangerous) scheme
- **THEN** the rendered output SHALL NOT produce a clickable link that navigates to that scheme

#### Scenario: Copy-raw control returns the verbatim source

- **WHEN** an operator activates the copy control on a rendered Markdown block
- **THEN** the verbatim Markdown source (including the original `**`, backticks, and fences) SHALL be copied to the clipboard, not the rendered HTML

#### Scenario: Session description and summary render Markdown

- **WHEN** an authenticated operator opens `/dashboard/sessions/:id` for a session with a Markdown-formatted description and summary
- **THEN** both the description (seed goal) and the summary SHALL be rendered as formatted HTML

#### Scenario: Judgment Source/Target render Markdown but Evidence stays JSON

- **WHEN** an authenticated operator opens `/dashboard/judgments/:id`
- **THEN** the Source and Target memory content SHALL be rendered as formatted Markdown
- **AND** the Evidence block SHALL remain a `<pre>` rendering of the pretty-printed JSON (not Markdown-rendered)

#### Scenario: List snippets remain plain text

- **WHEN** the operator views the `/dashboard/memories` list where a row's content contains `**bold**`
- **THEN** the truncated snippet cell SHALL display the raw characters as escaped plain text and SHALL NOT render Markdown formatting
