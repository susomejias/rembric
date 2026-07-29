## ADDED Requirements

### Requirement: Memory detail MUST list the judgments touching that memory, in decision-relevance order

The memory detail view (`/dashboard/memories/:id`) SHALL render a `Judgments` section listing every `memory_relations` row whose `source_id` or `target_id` is that memory, excluding rows whose `relation` is `not_conflict`. Each row SHALL render the verdict kind through the shared `verdictPill` helper, the relation `status` through `statusPill`, the counterpart memory's stored `title` as an `<a href="/dashboard/memories/{counterpartId}">`, and the row's `judged_at` (falling back to `created_at`) through the shared timestamp helper. Each row SHALL carry `data-href="/dashboard/judgments/{id}"` and the timestamp cell SHALL contain that same anchor. When no such row exists the section SHALL render the empty state `No judgments touch this memory.`

The rows SHALL be ordered by the annotation order the `memory` capability defines for relation annotations ("Search results MUST carry relation annotations"): kind tier — `conflicts_with`, `supersedes`, `superseded_by`, then `pending_conflict`, then `scoped`, `compatible`, `related` — then the relation's creation time descending, then its `judgment_id`. The dashboard SHALL apply that order through the single shared comparator exported by the relations service, NOT through a second ordering rule of its own, so the operator surface and every agent-facing annotation list rank the same memory's edges identically.

The order SHALL be applied over the fetched rows rather than as a database `ORDER BY`, because the kind tier is keyed on the relation's kind **from this memory's point of view** — `supersedes` and `superseded_by` are the same stored row seen from its two ends — and that point of view is not a column.

The section SHALL NOT be paginated and SHALL NOT be capped. The `memory` capability states that annotations withheld by the MCP annotation bound remain visible via the dashboard, and this section is the only per-memory judgment view the dashboard provides; a cap here would make that statement false.

The section heading SHALL report the memory's **degree**: the number of rows rendered. It SHALL NOT report a separate total, because with no cap applied a total would restate the rendered row count.

#### Scenario: A contradiction leads the section regardless of when it was judged

- **GIVEN** a memory touched by one judged `conflicts_with` relation created before twelve judged `related` relations
- **WHEN** an authenticated operator opens that memory's detail view
- **THEN** the first row of the `Judgments` section SHALL be the `conflicts_with` relation, and all thirteen rows SHALL be rendered

#### Scenario: A pending backlog does not displace a judged lifecycle edge

- **GIVEN** a memory touched by twenty `pending` relations and one judged `supersedes` relation
- **WHEN** the operator opens that memory's detail view
- **THEN** the `supersedes` row SHALL precede every pending row

#### Scenario: Repeated renders agree on a same-millisecond batch

- **GIVEN** a memory whose touching relations include several judged inside one transaction and therefore sharing a `created_at` millisecond
- **WHEN** the operator loads the detail view twice with no intervening write
- **THEN** the `Judgments` rows SHALL appear in the same order both times

#### Scenario: The section reports the degree

- **GIVEN** a memory touched by seven relations
- **WHEN** the operator opens its detail view
- **THEN** the `Judgments` heading SHALL report a degree of `7`

#### Scenario: A memory with no judgments

- **WHEN** the operator opens the detail view of a memory that no `memory_relations` row touches
- **THEN** the section SHALL render the text `No judgments touch this memory.` and SHALL report a degree of `0`

## MODIFIED Requirements

### Requirement: No frontend build pipeline SHALL be required

The dashboard SHALL be implemented with server-side template literals plus a small, enumerated set of browser libraries served from its own origin. The repository SHALL NOT contain a JavaScript bundler or transpiler applied to **first-party** source, and SHALL NOT contain a first-party JavaScript source file that requires compilation beyond what `tsc` produces for the server; every served JavaScript file SHALL be usable directly from a `<script>` tag. A CSS minifier (lightningcss) IS allowed and IS required to produce the per-page CSS bundles described in the design-system requirements; the CSS build step is invoked by `pnpm run build` and SHALL NOT require any additional install or configuration beyond `pnpm install`.

The served third-party JavaScript SHALL be exactly one named, version-pinned file, with a single named purpose: **HTMX** — request and swap behaviour, on every page.

No second served file SHALL be added without a new OpenSpec change, and none SHALL be a client-side application framework: no framework, no CDN reference, and no client-side router or component system SHALL be introduced.

A served third-party file MAY be committed to the asset tree, or copied into it at build time from a dependency pinned in `package.json`. It SHALL be usable from a bare `<script>` tag as shipped by its package — no bundling, transpilation or module-format conversion of any kind SHALL be introduced, for third-party or first-party code. Every served file SHALL be asserted present by the build, so a missing library is a build failure rather than a blank page in a browser.

First-party client-side JavaScript SHALL be hand-written and embedded inline in the rendered response — either by the SSR shell, for behaviour every page needs, or by a component module, for behaviour only that surface needs. The dashboard SHALL NOT serve a first-party JavaScript asset file. Each inline script SHALL be smaller than 2 KB; the limit exists so that every first-party script stays readable in one sitting and no framework can hide inside one.

#### Scenario: Fresh contributor onboarding

- **WHEN** a contributor clones the repo and runs `pnpm install`
- **THEN** the dashboard SHALL be ready to develop and to build without any frontend-specific install step beyond what `pnpm install` already produces

#### Scenario: Build emits per-page CSS bundles

- **WHEN** a contributor runs `pnpm run build`
- **THEN** the build SHALL produce `dist/dashboard/public/assets/styles/core.<contentHash>.css`, one `dist/dashboard/public/assets/styles/views/<view>.<contentHash>.css` per dashboard view, and a `dist/dashboard/public/assets/styles/manifest.json` mapping view keys to file names

#### Scenario: Build emits every served library

- **WHEN** a contributor runs `pnpm run build`
- **THEN** every served third-party library SHALL be present under `dist/dashboard/public/assets/`, and a library that failed to be copied from its pinned dependency SHALL fail the build

#### Scenario: No client-side JS framework is introduced

- **WHEN** a contributor inspects the repository for client-side JS
- **THEN** the JavaScript executing in the browser SHALL be exactly the one served file named above plus first-party inline scripts, each embedded by the SSR shell or by the single view or component whose behaviour it enhances
- **AND** no first-party JavaScript file SHALL be served from the dashboard's static assets, and no client-side framework, component system or CDN reference SHALL be present

#### Scenario: Every shipped inline script is within budget

- **WHEN** the inline scripts embedded by the dashboard are enumerated
- **THEN** each SHALL be attributable either to the SSR shell or to one named view or component module, and each SHALL be smaller than 2 KB

### Requirement: The dashboard MUST be served at `/dashboard`

The server SHALL serve a server-side rendered web dashboard at the `/dashboard` path of the same process and port as the MCP endpoint. Static assets SHALL be served from `/dashboard/assets/` and SHALL be present inside the distributed package; **no CDN dependency at runtime**. The served static assets are the fonts and images committed under the dashboard's public tree, the content-hashed CSS bundles the build emits, and the third-party JavaScript files enumerated in the frontend-pipeline requirement — which is the single place that list is maintained, so it cannot go stale in two places at once.

#### Scenario: Dashboard home is reachable

- **WHEN** an authenticated operator navigates to `/dashboard`
- **THEN** the server SHALL return an HTML page with the layout, stats summary, and navigation rendered server-side

#### Scenario: Every served asset comes from this origin

- **WHEN** any dashboard page is loaded
- **THEN** every stylesheet, script, font and image it references SHALL be served from the dashboard's own `/dashboard/assets/` path, and the page SHALL issue no request to any third-party host
