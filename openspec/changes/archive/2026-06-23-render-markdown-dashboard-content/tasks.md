## 1. Dependency

- [x] 1.1 Consult `.agents/skills/npm-security-best-practices` and confirm `markdown-it` (+ transitive deps) has no lifecycle scripts → no `pnpm-workspace.yaml::allowBuilds` entry needed
- [x] 1.2 `pnpm --filter @rembric/server add markdown-it` (14.2.0) and `pnpm --filter @rembric/server add -D @types/markdown-it`; verify `pnpm-lock.yaml` shows only registry sources and the chosen version clears `minimumReleaseAge`
- [x] 1.3 Run `pnpm install --frozen-lockfile` to confirm all supply-chain gates pass with no `.npmrc` / `pnpm-workspace.yaml` / CI / Dockerfile changes

## 2. Render helper

- [x] 2.1 Add `renderMarkdown(content: string): SafeHtml` to `apps/server/src/dashboard/components.ts` — one module-level `MarkdownIt({ html: false, linkify: false })`, returns `raw(md.render(content))`
- [x] 2.2 Confirm it is the only new `raw()` call site and that it wraps parser output exclusively (never raw user input)

## 3. Wire detail views

- [x] 3.1 `memories.ts` (~line 392): replace `<pre>${row.content}</pre>` with `<div class="md-body">${renderMarkdown(row.content)}</div>`
- [x] 3.2 `sessions.ts` (~lines 329–335): wrap session description (seed goal) and summary with `renderMarkdown` inside `.md-body` (preserve the `—` placeholder when summary is null)
- [x] 3.3 `prompts.ts` (~line 129): replace the `<pre>${p.content}</pre>` inside the `<details>` cell with `.md-body` + `renderMarkdown`
- [x] 3.4 `judgments.ts` (~lines 279/285): render Source + Target memory content via `.md-body` + `renderMarkdown`; leave Reason as `<p>` and Evidence as `<pre>` (JSON)
- [x] 3.5 Leave all list/table `truncate(content, N)` cells unchanged (plain escaped text)

## 4. Styles

- [x] 4.1 Add a `.md-body` block to `apps/server/src/dashboard/styles/core/content.css` covering the framed panel (border + `--bg-elev` background + padding, matching the old `<pre>` look) plus `ul`/`ol`/`li`, standalone `a`, `blockquote`, `hr` using locked tokens; keep fenced/inline code monospace via existing `.main pre`/`code`. Introduce no new design token
- [x] 4.2 Run `pnpm --filter @rembric/server run build:css` and confirm the rebuilt core CSS hash is picked up via manifest

## 5. Tests

- [x] 5.1 `components.test.ts`: `renderMarkdown` renders bold/inline-code/fenced-code/list; `<script>`/raw HTML stays escaped; `javascript:` link is not clickable
- [x] 5.2 No per-view dashboard unit tests exist (view render is covered by the shared `renderMarkdown` helper + the MCP/integration suite). List snippets are unchanged (`truncate` path untouched), so no new assertion needed
- [x] 5.3 `templates.test.ts` already asserts `minifyHtml` preserves `<pre>` blocks — covers rendered fenced-code output

## 6. Verify

- [x] 6.1 `pnpm run typecheck` + `pnpm run lint` + full server suite green (837 passed, 1 skipped)
- [x] 6.2 `pnpm run dev:docker:up` live smoke: memory, session, and judgment detail pages render Markdown inside `.md-body`; injected `<script>`, `<img onerror>`, and `javascript:` link all confirmed inert in the served HTML
