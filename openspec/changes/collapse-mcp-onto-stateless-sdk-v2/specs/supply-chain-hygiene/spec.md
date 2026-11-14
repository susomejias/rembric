## MODIFIED Requirements

### Requirement: A published package's runtime dependency surface MUST be justified, and zero is the default

A package this repository publishes SHALL declare the minimum runtime dependency surface that makes it work, and SHALL prefer zero. Every runtime `dependencies` entry in a published package SHALL be justified in the proposal that introduces it, on the same standard as an `allowBuilds` grant: a dependency we ship executes on a user's machine and is a dependency that user cannot decline.

Host packages that are present by construction (the plugin host of a client extension) SHALL be declared as `peerDependencies` and SHALL NOT be bundled. Their version range SHALL not assert compatibility broader than what has been measured; where only one version has been measured and the host manages its own compatibility, `"*"` is the honest range.

Where a runtime dependency is unavoidable, three further rules apply:

1. **The version SHALL be exact, never a range.** A range lets a new upstream release change the published package's behaviour on a user's machine with no release of ours — the same hole a floating `npx` tag opens, one level down. An exact version means new third-party code reaches a user only through a deliberate release.
2. **The dependency SHALL NOT be bundled or vendored to make the count look like zero.** A consumer's dependency tree is what lets their advisory tooling see the version they are running; a bundled copy makes a CVE in it invisible to them, and makes the package's behaviour auditable only by reading a build artifact. This repository has paid that cost directly: confirming a dependency's HTTP-status handling required reading its bundled `dist` rather than its dependency tree.
3. **The cost SHALL be measured, not characterised.** The proposal SHALL state the installed package count and size the dependency adds, measured against the alternative it replaces, so the trade is recorded as a number rather than as an adjective.

`@rembric/mcp-bridge` SHALL declare no runtime dependencies, and the reasoning is recorded here because the obvious alternative was specified first and reversed on measurement. Depending on `@modelcontextprotocol/sdk` alone — the protocol's reference implementation, and at the time an `apps/web` dependency that was already reviewed and lockfile-pinned here (`apps/web` has since moved to `@modelcontextprotocol/server` and `@modelcontextprotocol/client` 2.x and no longer declares it) — would have avoided owning any wire protocol. **Measured 2026-08-15** (`npm install --ignore-scripts` into an empty directory): the delegate being replaced, `mcp-remote@0.1.38`, installs 80 packages / 7.0 MB, while `@modelcontextprotocol/sdk` installs 93 packages / 25 MB at `1.29.0` (97 / 24 MB at `1.30.0`), because the SDK ships its server-side halves (`express`, `hono`, `cors`, `jose`, `pkce-challenge`, `express-rate-limit`) in `dependencies` even though only the client transport would be imported. A package whose purpose includes reducing what runs on a user's machine cannot install a larger tree than the delegate it removes, so the dependency was dropped rather than accepted.

What the bridge owns instead is bounded, and smaller than the SDK's full surface suggests: newline-delimited stdio framing, `fetch` with a bearer header, and `data:` line parsing on the response stream. It does **not** own SSE resumability or `Last-Event-ID` (this server does not offer resumable streams), nor OAuth, nor the server half of the protocol. `apps/plugin/.pi-plugin/index.ts` already carries the same surface with `dependencies: {}`. The bridge relays no server-initiated request: the server initiates none, so the bridge forwards the host's requests and the server's responses and nothing else.

This is not vendoring. Bundling a third-party package to report zero dependencies hides the version from a consumer's advisory tooling, which is how confirming `mcp-remote`'s `404` behaviour required reading `chunk-65X3S4HB.js` instead of a dependency tree. First-party code carries no such blind spot: there is no upstream version for tooling to miss.

#### Scenario: The published client extension declares no runtime dependencies

- **WHEN** `apps/plugin/.pi-plugin/package.json` is read at HEAD
- **THEN** it SHALL declare no `dependencies`, or an empty `dependencies` object
- **AND** it SHALL declare no `bundledDependencies` / `bundleDependencies`

#### Scenario: Adding a runtime dependency to a published package requires a recorded justification

- **WHEN** a change proposes adding an entry to a published package's `dependencies`
- **THEN** the proposal SHALL state why the dependency cannot be avoided and what it executes on the user's machine
- **AND** it SHALL state the measured installed package count and size the dependency adds
- **AND** a reviewer SHALL block the change if either is absent

#### Scenario: A ranged runtime dependency fails review

- **GIVEN** a published package declaring a `dependencies` entry whose value carries a range operator (`^`, `~`, `>=`, `*`, or `x`)
- **WHEN** the manifest is read in CI or in review
- **THEN** the change SHALL be rejected
- **AND** the reason SHALL cite that a range lets upstream change user-machine behaviour with no release of ours

#### Scenario: A published package does not bundle its dependency

- **WHEN** the tarball of a package this repository publishes is inspected
- **THEN** it SHALL NOT contain a vendored or bundled copy of a declared dependency
- **AND** it SHALL declare no `bundledDependencies` / `bundleDependencies`
