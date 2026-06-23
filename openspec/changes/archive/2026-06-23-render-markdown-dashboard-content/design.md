## Context

The dashboard is server-rendered (Hono + the hand-rolled `html\`\``tagged template in`apps/server/src/dashboard/templates.ts`). Every interpolated string is HTML-escaped by `renderValue`; `raw(s)` is the only escape hatch and is reserved for pre-rendered, trusted HTML (`SafeHtml`). Long `content`fields are currently emitted as`<pre>${content}</pre>`, so the operator sees raw Markdown source (`\*\*`, backticks, fences).

Constraints that shape this change:

- **Design tokens locked** (brutalist dark + lime, self-hosted fonts) by the `dashboard` spec; changing a token needs its own OpenSpec change. This change adds none.
- **No CDN at runtime** (`dashboard` spec) → the parser must be in-process.
- **Append-only / read-side only** → no DB, migration, MCP, HTTP-wire, or plugin changes.
- **Supply-chain hygiene** (`supply-chain-hygiene` spec): `ignore-scripts=true`, `allowBuilds` allowlist, `blockExoticSubdeps`, `minimumReleaseAge: 4320`, frozen-lockfile CI. Any new dep must pass these unchanged.
- **CSS** lives in `styles/core/*.css` (shared) and `styles/views/<view>.css` (per-route, auto-globbed by `scripts/build-css.mjs`). No inline `<style>`.

## Goals / Non-Goals

**Goals:**

- Operators read formatted Markdown for memory/session/prompt content on detail views.
- XSS-safe by construction, without pulling in a sanitizer + `jsdom`.
- Zero new design tokens; output stays visually brutalist.
- One shared, tested helper; minimal edits at call sites.

**Non-Goals:**

- Rendering Markdown in list/table snippets (stays plain escaped text — Markdown in a 100-char truncation is noise).
- Editing/round-tripping Markdown, syntax highlighting, GFM tables/footnotes/task-lists, or `linkify` autolinking. Plain CommonMark subset is enough.
- Any change to how content is stored or transmitted over MCP/HTTP (agents still consume verbatim).

## Decisions

**D1 — Use `markdown-it` with `html: false`, not a hand-rolled renderer.**
A regex-based renderer half-renders this repo's content: globs (`apps/*`, `mem_*`, `memory.*`) trip spurious emphasis, and LLM-truncated unclosed fences swallow the rest of the document. `markdown-it` is a real parser (balanced inline rules, correct fence handling). `html: false` (its default) renders any raw HTML in the source as escaped text, so `<script>` becomes inert text with **no separate sanitizer**. Its default `validateLink` already drops `javascript:`/`vbscript:`/`data:` schemes. _Alternative rejected:_ `marked` — zero-dep but passes raw HTML through, forcing DOMPurify + `jsdom` (heavier + more deps than markdown-it's 5 pure-JS transitive deps). _Alternative rejected:_ hand-rolled subset — the exact failure mode (half-rendered output) we are trying to avoid.

**D2 — Single helper `renderMarkdown(content: string): SafeHtml` in `components.ts`.**
Instantiate one module-level `MarkdownIt({ html: false, linkify: false })` (reused across requests — the parser is stateless and reusable) and return `raw(md.render(content))`. Centralizing means `raw()` wraps **only** parser output, never user input — the invariant that keeps the XSS surface bounded. _Alternative rejected:_ inlining markdown-it at each call site (3× duplication, easy to forget `html: false`).

**D3 — Wrap output in `<div class="md-body">`, add the missing block rules to `core/content.css`.**
Core CSS already styles `h2`/`h3`/`p`/`code`/`pre`; it does **not** style `ul`/`ol`/`li`, standalone `a`, `blockquote`, `hr`. Scope new rules under `.md-body` so they only affect rendered content, reusing existing tokens (`--fg`, `--lime`, `--bg-elev`, spacing scale). Fenced code keeps the existing `.main pre`/`code` look. _Alternative rejected:_ a new `views/*.css` — these rules are cross-view (memories + sessions + prompts), so `core/content.css` is the right layer.

**D4 — Detail views only; list cells untouched.**
`truncate(content, N)` cells stay plain escaped strings. Only the full-content blocks switch to `renderMarkdown`.

## Risks / Trade-offs

- **Malformed agent Markdown renders oddly** (unclosed fence, stray backtick) → `markdown-it` degrades gracefully (treats the rest as code/text) instead of corrupting the page; acceptable and still more readable than raw source.
- **New dependency = supply-chain surface** → markdown-it + transitive deps are pure JS, no lifecycle scripts (no `allowBuilds` entry), widely used and mature (clears `minimumReleaseAge` easily). Added via `pnpm add` so the lockfile + integrity hashes are validated by the existing frozen-lockfile CI gate. Consult the `npm-security-best-practices` skill before adding.
- **`raw()` misuse risk** → mitigated by D2: a single helper is the only new `raw()` site, and it wraps parser output exclusively. Unit tests assert HTML/`javascript:` payloads stay inert.
- **HTML minifier interaction** → `minifyHtml()` skips `<pre>`/`<textarea>`/`<script>`; rendered `<div class="md-body">` block content (including any `<pre><code>` from fences) is preserved because the minifier already protects `<pre>`. Verify in the templates test.

## Migration Plan

Pure additive read-side change; no data migration. Deploy = ship the new server image. Rollback = revert the commit (no persisted state touched). Validate against `pnpm run dev:docker:up`: open a memory/session detail page with Markdown content and confirm formatting + that an injected `<script>`/`javascript:` link stays inert.

## Open Questions

None.
