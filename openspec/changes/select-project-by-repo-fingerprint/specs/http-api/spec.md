## ADDED Requirements

### Requirement: `POST /api/repositories/resolve` MUST resolve a repository fingerprint to a slug without connecting the caller

The server SHALL expose `POST /api/repositories/resolve`, authenticated with the same bearer verification, failed-authentication lockout, per-token rate limit and request-body bound as `/api/<slug>/*`. It carries no project slug in its path, and the `/api/<slug>/` tree SHALL have no `resolve` child, so the route shadows no project route.

The request body SHALL be a strict JSON object — an unknown property is refused with `400` and `invalid_input`:

- `fingerprint`: a string of 40 or 64 lowercase hexadecimal characters, or `null` for a git repository without fingerprint. Required.
- `remotes`: an array of at most 8 strings, each at most 512 characters. Required; may be empty. The server SHALL normalize each as the `repository-binding` capability specifies before any comparison or storage.
- `rootName`: an optional string of at most 255 characters containing no `/` or `\`, the basename of the checkout root. The server SHALL store it only for a pending row with no remote.
- `explicit`: an optional object `{ slug, source }` where `slug` matches the project slug regex and `source` is one of `rembric-root`, `rembric-nested` or `env`.

The successful response SHALL be `200` with one of:

- `{ ok: true, outcome: 'bound', slug }` — exactly one visible binding resolved, and the unknown-remote check passed;
- `{ ok: true, outcome: 'unbound', reason }` — `reason` is `not_bound`, `unknown_remote` or `no_fingerprint`;
- `{ ok: true, outcome: 'explicit', slug, conflict }` — when `explicit` was sent; `slug` echoes it, and `conflict` is `null` or `{ boundSlugs }` listing the visible bindings the explicit slug differs from.

Two or more visible bindings with no `explicit` SHALL answer `409` with `{ ok: false, code: 'repository_ambiguous', slugs }`. A body that fails validation SHALL answer `400`.

The endpoint SHALL record pending rows only as the `repository-binding` capability specifies, and only for a token whose scope authorizes writing. It SHALL NOT create, move or remove a binding, SHALL NOT create a project, SHALL NOT register a session, and its answer for a binding the token cannot read SHALL be byte-identical to its answer for no binding, apart from the echoed values. The endpoint's existence with these answers is what a client takes as the server's support for repository fingerprints.

#### Scenario: A bound fingerprint resolves

- **GIVEN** fingerprint `F` bound to `shop`, which the token may read, with known remote `github.com/acme/shop`
- **WHEN** the client posts `{ fingerprint: F, remotes: ['github.com/acme/shop'] }`
- **THEN** the response SHALL be `200 { ok: true, outcome: 'bound', slug: 'shop' }`

#### Scenario: An unbound fingerprint is recorded as pending

- **GIVEN** fingerprint `G` with no binding and a token authorized to write some project
- **WHEN** the client posts `{ fingerprint: G, remotes: ['github.com/acme/tools'] }`
- **THEN** the response SHALL be `200 { ok: true, outcome: 'unbound', reason: 'not_bound' }`
- **AND** a pending row of kind `unbound` for `G` SHALL list `github.com/acme/tools`

#### Scenario: An explicit selection is echoed with its conflict

- **GIVEN** fingerprint `F` bound to `shop`, and a token authorized for `shop` and `sandbox`
- **WHEN** the client posts `{ fingerprint: F, remotes: [], explicit: { slug: 'sandbox', source: 'rembric-root' } }`
- **THEN** the response SHALL be `200 { ok: true, outcome: 'explicit', slug: 'sandbox', conflict: { boundSlugs: ['shop'] } }`
- **AND** a pending row of kind `suggestion` for `(F, sandbox)` SHALL exist

#### Scenario: Strict validation refuses a malformed request

- **WHEN** the client posts `{ fingerprint: 'XYZ', remotes: [] }`, or a body with nine remotes, or a body with an extra `path` property
- **THEN** each response SHALL be `400`
- **AND** no pending row SHALL be created

#### Scenario: A read-only token resolves without recording anything

- **GIVEN** a token with scope `read:project:<id of shop>` and an unbound fingerprint `G`
- **WHEN** the client posts `{ fingerprint: G, remotes: ['github.com/acme/tools'] }`
- **THEN** the response SHALL be `200 { ok: true, outcome: 'unbound', reason: 'not_bound' }`
- **AND** no pending row SHALL be created or refreshed
