## Why

Memory, session, and prompt `content` is authored as Markdown (the `What / Why / Where / Learned` template, `**bold**`, inline `` `code` ``, fenced code blocks, lists), but the dashboard renders it verbatim inside an escaped `<pre>` block. Operators reading a memory in `/dashboard/memories/:id` see the raw `**`, backticks, and ` ``` ` as literal noise instead of formatted text, which makes the dashboard a poor audit surface for the structured content it stores.

## What Changes

- Add a single shared server-side helper `renderMarkdown(content)` in `apps/server/src/dashboard/components.ts` that parses Markdown with **`markdown-it` configured `html: false`** and returns `SafeHtml` (wrapped via `raw()`). `html: false` makes raw HTML in the source render as escaped text — no separate sanitizer / `jsdom` needed — and `markdown-it`'s default `validateLink` rejects `javascript:`/`vbscript:`/`data:` URL schemes.
- Replace the escaped `<pre>${content}</pre>` blocks on **detail views only** with `<div class="md-body">${renderMarkdown(content)}</div>`:
  - memory detail content — `apps/server/src/dashboard/memories.ts` (~line 392)
  - session description (seed goal) + session summary — `apps/server/src/dashboard/sessions.ts` (~lines 329–335)
  - prompt full content inside the `<details>` cell — `apps/server/src/dashboard/prompts.ts` (~line 129)
  - judgment detail Source + Target memory content — `apps/server/src/dashboard/judgments.ts` (~lines 279/285). The judgment **Reason** stays a plain `<p>` (short prose) and **Evidence** stays a `<pre>` (it is pretty-printed JSON, not Markdown).
- **List/table cells stay unchanged**: `truncate(content, N)` snippets remain plain escaped text (Markdown in a 100-char snippet is noise, not signal).
- Wrap the render in a shared `mdBody(content)` component (`components.ts`) that pairs the rendered `.md-body` with an icon-only **copy-raw** button (GitHub code-block style, top-right) and a hidden `<pre class="md-raw">` carrying the verbatim source. A `MD_COPY` handler injected by `shell()` copies that source (Clipboard API with an `execCommand` fallback for plain-HTTP). All call sites use `mdBody` — no duplicated render/copy logic.
- Add a `.md-body` block to the dashboard CSS (`styles/core/content.css`) covering the elements core CSS does not yet style (`ul`/`ol`/`li`, standalone `a`, `blockquote`, `hr`), reusing the locked brutalist tokens. Fenced code stays monospace via the existing `.main pre`/`code` rules. **No design token is added or changed.**
- Add `markdown-it` as a runtime dependency of `apps/server`. It and its transitive deps (`entities`, `linkify-it`, `mdurl`, `uc.micro`, `punycode.js`) are pure JS with no lifecycle scripts, so no `pnpm-workspace.yaml::allowBuilds` entry is required; the existing `minimumReleaseAge`/`blockExoticSubdeps`/frozen-lockfile gates apply unchanged.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `dashboard`: adds a requirement that long text `content` on **detail views** is rendered as Markdown server-side via an `html: false` parser, while list/table snippets remain plain escaped text. Reinforces the existing brutalist-identity and no-CDN requirements (the parser is in-process, no token changes).

## Impact

- **Dependency**: `apps/server/package.json` gains `markdown-it` (+ `@types/markdown-it` dev); `pnpm-lock.yaml` updated. No `.npmrc` / `pnpm-workspace.yaml` / CI / Dockerfile changes (no install scripts). Consults `.agents/skills/npm-security-best-practices` per repo policy; honors `supply-chain-hygiene` spec (no weakening of any gate).
- **Code**: new `renderMarkdown` helper in `apps/server/src/dashboard/components.ts`; edits to `memories.ts`, `sessions.ts`, `prompts.ts` detail render paths; new `.md-body` rules in `apps/server/src/dashboard/styles/core/content.css`.
- **Security**: XSS surface is bounded by `markdown-it`'s `html: false` (HTML in content escaped to text) + default `validateLink` (dangerous URL schemes dropped). The `raw()` escape hatch wraps **only** `markdown-it` output, never user input directly.
- **No invariant touched**: append-only memory, scope-at-service, `topic_key`, and judgment freshness are all unaffected — this is a read-side presentation change only. No DB schema, no migration, no MCP/HTTP wire change, no plugin change.
- **Tests**: unit tests for `renderMarkdown` (formatting + XSS payloads + link-scheme rejection) in `components.test.ts`; render assertions in the affected dashboard view tests.
