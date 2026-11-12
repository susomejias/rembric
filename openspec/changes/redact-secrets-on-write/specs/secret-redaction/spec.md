## ADDED Requirements

### Requirement: Agent-supplied text MUST be redacted before it is persisted

The server SHALL run the secret scanner (`redactSecrets`, `packages/core/src/services/secret-redaction.ts`) inside the service layer, after the existing validation of the value as sent and before the repository write, on every agent- or client-supplied text field it persists:

- `MemoryService.saveWithTopicKey`: `title`, `content`, each tag (before slug normalization) and `topic_key`;
- `MemoryService.confirm` / `confirmMany`: the confirmation `reason`, for both verdicts;
- `AgentSessionsService.start` / `ensure`: `agent` and `description`; `writeSummary` / `end`: `summary` and `title`; `reportTurn`: `title`;
- `PromptsService.save`: `content`, `title` and each tag;
- `RelationsService.judge` / `judgeInScope` / `compare` / `compareInScope`: `reason`, and every string inside `evidence` at any depth, object keys included.

Because the MCP tools and the HTTP session routes reach these methods, both are covered without a second scanner. Server-composed text written into the same columns SHALL be derived from already-redacted input or be constant.

#### Scenario: A secret used as an evidence key is stored redacted

- **GIVEN** a `memory.compare` whose `evidence` is an object with a `ghp_` token as a key
- **WHEN** it is handled
- **THEN** `memory_relations.evidence` SHALL hold `[REDACTED:github_token]` as that key and SHALL NOT contain the token

#### Scenario: A secret in memory content is stored redacted

- **GIVEN** a `memory.save` whose content contains `GITHUB_TOKEN=ghp_` followed by 36 alphanumeric characters
- **WHEN** the save completes
- **THEN** the stored `memory.content` SHALL contain `[REDACTED:github_token]` in place of the token
- **AND** the token SHALL NOT occur in any column of any table

#### Scenario: A secret posted to an HTTP session route is stored redacted

- **GIVEN** an HTTP `POST /api/<slug>/sessions/<id>/summary` whose summary contains `Authorization: Bearer ` followed by a 40-character token
- **WHEN** the route handles it
- **THEN** the stored `sessions.summary` SHALL contain `[REDACTED:authorization_header]` and not the token
- **AND** the response body SHALL be unchanged from a write with nothing to redact

### Requirement: Detection MUST be a closed list of named, high-precision detectors

The scanner SHALL be deterministic and model-free, with no entropy heuristic. Its kinds, applied in this order, SHALL be exactly: `private_key`, `jwt`, `github_token`, `gitlab_token`, `anthropic_api_key`, `openai_api_key`, `aws_access_key_id`, `slack_token`, `stripe_secret_key`, `google_api_key`, `npm_token`, `huggingface_token`, `authorization_header`, `url_password`, `assigned_secret`. The shapes are those of `design.md` D2. A span already containing `[REDACTED:` SHALL NOT be matched again, so redaction is idempotent.

`assigned_secret` SHALL match only when ALL hold: the key's words end in a credential word (`password`, `passwd`, `passphrase`, `secret`, `apikey`, `token`, `credential(s)`, a two-word credential such as `api key` or `access key`, or `secret key base`), and `token` is not qualified as a pagination or tokenizer token (`page`, `next`, `prev`, `continuation`, `cancellation`, `sync`, `resume`, `cursor`, `eos`, `bos`, `pad`, `unk`, `sep`, `cls`, `mask`); the form is `SCREAMING_KEY=value`, `--key=value`, a query parameter, or a key followed by `=` or `:` and a quoted literal; and the value is at least 8 characters, is secret-shaped (it contains a letter and a digit, or is an opaque run of at least 32 base64url characters with both cases), and is not a reference, placeholder, repeated character, number, boolean, dotted code reference, file path, URL or call. Placeholder hints (`example`, `your`, `todo`, `fixme`, `xxx`, …) SHALL count only at the start of a word, so a hint occurring by chance inside an opaque token never exempts it. `authorization_header` SHALL apply the same secret-shape and placeholder rules.

#### Scenario: Every kind redacts its positive fixture

- **GIVEN** one realistic fixture per kind
- **WHEN** each is scanned
- **THEN** the result SHALL contain exactly one `[REDACTED:<that kind>]` and none of the fixture's secret characters

#### Scenario: Realistic technical prose is never redacted

- **GIVEN** the false-positive corpus — commit SHAs, UUIDs, ULIDs, content and integrity hashes, base64 fixtures, public keys and certificates, example placeholders such as `sk-...`, `<token>`, `$GITHUB_TOKEN`, `${API_KEY}`, `AKIAIOSFODNN7EXAMPLE`, `postgres://user:password@localhost`, `max_tokens=1024`, `page_token=…`, `Client(api_key=api_key)`, `apiKey: process.env.API_KEY`, and code and prose literals such as `credentials: 'same-origin'`, `password: "Required"`, `REFRESH_TOKEN = "refresh_token"`, `xoxb-test-token`, `https://oauth2:PERSONAL_ACCESS_TOKEN@gitlab.com/…`, `GITHUB_TOKEN=TODO_FILL_ME_IN`
- **WHEN** each entry is scanned
- **THEN** it SHALL be returned unchanged with no redactions

#### Scenario: A whole private key is redacted in real-world wrappers

- **GIVEN** a private key wrapped as PGP armor with `Version:`/`Comment:` headers, as JavaScript string concatenation, as JSON with escaped `\/`, as a markdown blockquote, or with a `#` comment line in its body
- **WHEN** it is scanned
- **THEN** none of its base64 lines SHALL remain and the result SHALL report one `private_key`

#### Scenario: An opaque token containing a placeholder-like substring is still redacted

- **GIVEN** a 43-character base64url token containing `XXX` inside it, in an `Authorization: Bearer` header, a `KEY=` assignment, a `?token=` query parameter and a JSON pair
- **WHEN** each is scanned
- **THEN** the token SHALL NOT remain in any of them

#### Scenario: The scanner is linear on pathological input

- **GIVEN** inputs of at least 1,600,000 characters: repeated `-----BEGIN PRIVATE KEY-----` headers with no `END`, headers each with a distinct label, headers whose `END` lies beyond 16 KiB, long runs of token characters, and long chains of `KEY=`, `--key=` and quoted-key assignments
- **WHEN** each is scanned, timed with `performance.now()` around the `redactSecrets` call
- **THEN** each scan SHALL take less than 1,500 ms (a timeout cannot fail a synchronous scan, so the budget is asserted)

### Requirement: A matched span MUST become a typed placeholder that nothing downstream sees past

A matched span SHALL be replaced with `[REDACTED:<kind>]`. For `url_password`, `authorization_header` and `assigned_secret` only the secret part SHALL be replaced and the surrounding structure kept. Because the replacement happens before the row is written, the FTS postings (trigger-maintained), entity extraction and the embedding input — all of which read the stored row — SHALL NOT contain the original span.

#### Scenario: The span is absent from the FTS index and the embedder input

- **GIVEN** a `memory.save` whose content contains a JWT
- **WHEN** the save, its entity linking and its embedding complete
- **THEN** a `memory_fts` match on a distinctive fragment of the JWT SHALL return no row
- **AND** the text handed to the embedder SHALL contain `[REDACTED:jwt]` and not the JWT

### Requirement: The write MUST succeed and report what was redacted

A redaction SHALL NOT fail the write. The MCP write tools (`memory.save`, `memory.capture_passive`, `memory.confirm_batch`, `memory.save_prompt`, `memory.compare`, `memory.session_start`, `memory.session_summary`) SHALL add `redactions: { kind, count }[]` to their response when at least one span was replaced in a value the write stored, aggregated over the call, with kinds in detector order — a `memory.session_summary` discarded as `terminal_final` stores nothing and SHALL report nothing; `memory.judge_batch` SHALL add it to each result item whose judgment was redacted. A response with nothing redacted SHALL be identical to the response without this requirement. The tools' output schemas SHALL declare the field as optional.

#### Scenario: memory.save reports its redactions

- **GIVEN** a `memory.save` whose title contains one `ghp_` token and whose content contains the same token and a PEM private key
- **WHEN** it is handled
- **THEN** the response SHALL carry `redactions: [{ kind: 'private_key', count: 1 }, { kind: 'github_token', count: 2 }]`

#### Scenario: A clean write is unchanged

- **GIVEN** a `memory.save` with no credential-shaped text
- **WHEN** it is handled
- **THEN** the response SHALL NOT carry a `redactions` key

### Requirement: Field caps MUST hold on the stored value

Validation SHALL run on the value as sent, so every published length contract is unchanged. When placeholders lengthen a bounded field — memory, prompt or session `title`, `topic_key`, session `summary` — past its cap, the stored value SHALL be cut at the cap without splitting a surrogate pair. The curated-summary merge SHALL check its cap on the merge of the stored summary with the summary as sent, and SHALL cut the stored (redacted) merge at the cap.

#### Scenario: A title lengthened by a placeholder is cut at the cap

- **GIVEN** a 100-character memory title ending in `password="hunter22"`
- **WHEN** it is saved
- **THEN** the stored title SHALL be 100 characters, SHALL NOT contain `hunter22`, and the save SHALL succeed

#### Scenario: A curated merge lengthened by placeholders is cut, not refused

- **GIVEN** a stored curated summary and an incoming one whose merge as sent is 9,995 characters and whose redacted merge is longer than 10,000
- **WHEN** it is written
- **THEN** the write SHALL succeed and the stored summary SHALL be at most 10,000 characters without the secret
- **AND** a merge longer than 10,000 characters as sent SHALL still be refused

### Requirement: Redaction MUST precede every server-side cut

A server-side cut made before the scanner runs can remove the context a detector needs and leave a secret undetectable. `memory.capture_passive` SHALL derive each title from the redacted learning, and the HTTP session routes SHALL redact a summary or title before `truncateSummary` or `truncateTitle` cuts it. An invariant SHALL fail when a call to `truncateSummary`, `truncateTitle` or `deriveTitle` in the scanned source roots does not redact its argument on the same line, except in an allow-listed fixture script.

#### Scenario: A secret straddling a cut is still redacted

- **GIVEN** a `memory.capture_passive` learning whose 100-character title cut falls between a URL password and its `@host`, an HTTP turn title cut the same way, and HTTP summaries over 10,000 characters whose tail-keeping cut falls inside `Authorization` or inside `DB_PASSWORD`
- **WHEN** each is written
- **THEN** none of the secrets SHALL occur in any column of any table, in the FTS index or in the embedder input

### Requirement: Write tool descriptions MUST state the behaviour in one line

Each MCP tool listed in "The write MUST succeed and report what was redacted", and `memory.judge_batch`, SHALL carry one line stating that credential-shaped text is stored as `[REDACTED:<kind>]` and reported in `redactions`, and every description SHALL stay within `DESCRIPTION_MAX_LENGTH`. `memory.session_summary`'s description already sits within 32 characters of the ceiling and its wording is pinned by other requirements, so its line SHALL instead be the description of its `summary` argument, which `tools/list` returns with the tool; its description text SHALL be unchanged.

#### Scenario: Descriptions carry the line within the ceiling

- **WHEN** `tools/list` is read over the real transport
- **THEN** each of those tools' descriptions — for `memory.session_summary`, its `summary` argument's description — SHALL contain `[REDACTED:<kind>]`
- **AND** every one of those descriptions SHALL be at most `DESCRIPTION_MAX_LENGTH` characters

### Requirement: Every persisted text column MUST be classified and the redacted ones proven

Every TEXT column of every table in `SOURCE_TABLES` SHALL be listed in `TEXT_COLUMNS` (`apps/web/src/test/schema-inventory.ts`) either as `'redacted'` or with a one-line exemption reason (identifiers, enumerations, hashes, server-composed text, operator-entered names). The invariant suite SHALL fail on an unlisted column and on a listed column that no longer exists.

A sweep test SHALL drive every agent-facing write path through its real boundary — the MCP write tools through the route handler and SDK client, and the HTTP session routes — with a secret in every free-text argument, and SHALL then assert that the secret occurs in no column of any table (source and derived, including `memory_fts`, `prompts_fts` and `memory_entities`) and was never handed to the embedder, and that EVERY column classified `'redacted'` holds at least one `[REDACTED:` placeholder.

#### Scenario: A new text column without a classification fails

- **GIVEN** a migration that adds a TEXT column to a source table and no `TEXT_COLUMNS` entry for it
- **WHEN** the invariant suite runs
- **THEN** it SHALL fail naming the column

#### Scenario: A column classified redacted that no write path reaches fails

- **GIVEN** a column classified `'redacted'` that the sweep's writes never fill with a placeholder
- **WHEN** the sweep runs
- **THEN** it SHALL fail naming the column
