## Context

Mapped on `origin/main` e555921a before designing:

- `assertNoNul` runs at `memory.ts:141` (content), `:149` (title), `:222` (each raw tag), `:474` (confirmation reason, refute only), `:661` (topic_key), and `agent-sessions.ts:82` (title), `:265` / `:296` (summary). `PromptsService` (`prompts.ts:79-90`, `:117-128`), `RelationsService.markJudged`/`insert` (`relations.ts:172-184`, `:223-235`, `:250-264`) and session `agent`/`description` (`agent-sessions.ts:163-177`, `:201-215`) persist caller text without it.
- Everything derived reads the STORED row: `saveMemoryWithCandidates` calls `extractEntities(m.title, m.content)` and `embedNow(m.id, m.title, m.content, …)` on the row returned by `saveWithTopicKey` (`memory-tools.ts:643-651`); the background embedding and entity-backfill workers read stored rows; `memory_fts` and `prompts_fts` are maintained by triggers only (`0016_add_memory_title.sql`, `0020_fix_fts_delete_triggers.sql`, `0010_prompts_title_required.sql`).
- `memory.save` content has no length cap (`memorySaveSchema.content` is `z.string().min(1)`); capture is ≤50k, prompts ≤20k, summaries ≤10k (HTTP accepts 40k and truncates before the service).
- Rembric's own API tokens are 43 base64url characters with no prefix (`tokens.ts:316-317`).

## Goals / Non-Goals

**Goals:** one deterministic scanner, applied once, at the service boundary every client reaches; nothing derived ever sees the original span; the agent is told; a new persisted text column cannot ship unclassified.

**Non-Goals:** rewriting stored rows; configurable patterns; entropy heuristics; redacting read-only inputs (search queries, recall-hint prompts — never persisted).

## Decisions

### D1 — Redact in the services, before the repository call

The service layer is the one boundary MCP, HTTP and the dashboard all reach, and it is where `assertNoNul` already lives. Redacting there means the row is written redacted, so the FTS triggers, `extractEntities`, the embedder and both background workers — which all read the stored row — never see the original. Redacting in the MCP layer would miss the HTTP session routes; redacting in repositories would put content policy under the SQL boundary.

Order inside a write: the existing validation runs on the value AS SENT (emptiness, NUL, caps — every published contract is unchanged), then redaction, then the repository call. Server-composed text written into a redacted column is built from already-redacted input (the topic-key upsert reason quotes the redacted `topic_key`) or is a constant (the deadline-orphan reason).

### D2 — A closed list of named detectors, applied in a fixed order

| kind                   | shape                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `private_key`          | `-----BEGIN … PRIVATE KEY-----` through its matching `END` line, or — when the `END` line is missing — the header plus the base64 lines that follow it; a body with no base64 run of ≥40 chars is prose, not a key |
| `jwt`                  | `eyJ…` `.` `eyJ…` `.` signature (≥16)                                                                                                                                                                              |
| `github_token`         | `gh[pousr]_` + ≥36 alnum, `github_pat_` + ≥60                                                                                                                                                                      |
| `gitlab_token`         | `glpat-` + ≥20                                                                                                                                                                                                     |
| `anthropic_api_key`    | `sk-ant-<word><2 digits>-` + ≥20                                                                                                                                                                                   |
| `openai_api_key`       | `sk-proj-` / `sk-svcacct-` / `sk-admin-` + ≥20, legacy `sk-` + 20 + `T3BlbkFJ` + 20                                                                                                                                |
| `aws_access_key_id`    | `AKIA`/`ASIA`/`ABIA`/`ACCA` + 16 upper alnum, except AWS's documented `…EXAMPLE` ids                                                                                                                               |
| `slack_token`          | `xox[abposr]-` + ≥10                                                                                                                                                                                               |
| `stripe_secret_key`    | `sk_live_`/`sk_test_`/`rk_live_`/`rk_test_` + ≥24                                                                                                                                                                  |
| `google_api_key`       | `AIza` + 35                                                                                                                                                                                                        |
| `npm_token`            | `npm_` + 36                                                                                                                                                                                                        |
| `huggingface_token`    | `hf_` + 34-40 alnum                                                                                                                                                                                                |
| `authorization_header` | the credential after `Authorization:` / `Proxy-Authorization:` + `Bearer`/`Basic`/`Token`/`Bot` (≥16)                                                                                                              |
| `url_password`         | the password in `scheme://user:password@host`                                                                                                                                                                      |
| `assigned_secret`      | the value of a credential-named assignment (below)                                                                                                                                                                 |

The order is the table's: a key block first (its body contains base64 the others could match), structured tokens next, context-dependent shapes last. A span that already contains `[REDACTED:` is never matched again, so `GITHUB_TOKEN=ghp_…` counts once, as `github_token`, and redacting redacted text changes nothing.

`assigned_secret` is where false positives live, so it is the narrowest:

- **Key.** The key's words (split on `_ . -` and camelCase) must END in a credential word: `password`/`passwd`/`passphrase`/`secret`/`apikey` (also as a suffix, e.g. `PGPASSWORD`), `token`, `pat`, `credential(s)`, or a two-word credential (`api key`, `access key`, `secret key`, `private key`, `signing key`, `encryption key`, `master key`, `account key`) or `secret key base`. A `token` qualified as non-secret (`page`, `next`, `prev`, `continuation`, `cancellation`, `sync`, `resume`, `cursor`, `eos`, `bos`, `pad`, `unk`, `sep`, `cls`, `mask`) does not count, nor do `tokens`, `token_id`, `topic_key`, `primary_key`.
- **Form.** `SCREAMING_KEY=value` (env files, shells); `--key=value` and `?key=` / `&key=` / `;key=` (flags, query strings); `key = "value"` / `key: "value"` / `"key": "value"` with a QUOTED literal. A lowercase key with an unquoted value outside a flag or query string is code (`Client(token=token)`), not a secret.
- **Value.** At least 8 characters, and not a reference or placeholder: no leading `$ % < { [ ( @ * ~ / . #`; no `...`, `…`, `${`, `{{`; not one repeated character; not purely numeric or a boolean/null word; no placeholder hint (`example`, `placeholder`, `your`, `redacted`, `changeme`, `dummy`, `sample`, `xxx`, `replace_me`, `insert_here`, `fixme`, `todo`); not a dotted code reference (`process.env.TOKEN`); not a file path (`*.pem`, `*.key`, `*.json`, …) or URL; not followed by `(`.

`url_password` and `authorization_header` apply the same placeholder rules (`url_password` also skips the literal words `password`, `pass`, `pwd`, `secret` and purely numeric values such as a port).

Rembric's own tokens have no prefix; they are caught where they are actually pasted — `REMBRIC_TOKEN=…`, `Authorization: Bearer …`, `?token=`.

### D3 — Placeholder `[REDACTED:<kind>]`

Typed so a reader (and the agent) knows what was there, short enough for titles. The whole matched span is replaced, except where a detector names the secret part (`url_password`, `authorization_header`, `assigned_secret`), which keeps the surrounding structure readable: `postgres://app:[REDACTED:url_password]@db:5432/x`.

### D4 — Caps after redaction

A placeholder can be longer than the span it replaces (an 8-character `assigned_secret` becomes 26 characters). Validation keeps running on the value as sent; when a placeholder lengthens a bounded field (memory/prompt/session title, topic_key, session summary) past its cap, the stored value is cut at the cap, never inside a surrogate pair. The cut can only shorten a placeholder or the text after it — the original span is already gone. The curated-summary merge keeps its own cap check on the merged (redacted) text. Rejecting instead would turn an automated write (HTTP hook titles and summaries are truncated to the cap by the client contract) into a lost write.

### D5 — Reporting

Each service write method takes an optional `RedactionTally` collector as its last parameter; redaction is unconditional, the tally only records it, so a caller that omits it loses the report and never the protection. MCP write handlers pass a tally and add `redactions: { kind, count }[]` (kinds in the D2 order) to their response when it is non-empty; `memory.judge_batch` reports per result item, because each judgment carries its own reason. Responses with nothing redacted are byte-identical to today. HTTP session routes redact through the same services; their bodies do not change because no model reads them.

Each write tool's description gains one line (`REDACTION_NOTE`, 125 characters). `memory.session_summary` is the exception: its description measured 1868 of the 1900-character `DESCRIPTION_MAX_LENGTH`, and with the line it measured 1994. Its wording is pinned phrase by phrase by other requirements and tests, so instead of condensing that prose (or raising the ceiling, which issue #447 rules out) the line becomes the description of its `summary` argument. `tools/list` returns that argument description with the tool, and the tool's response already echoes the stored, redacted `summary` and `title`.

### D6 — Coverage invariant: classification plus a real-boundary sweep

A grep cannot prove that a value went through the scanner, so the invariant has two halves that only pass together:

1. **Classification** (`invariants.test.ts`): every TEXT column of every `SOURCE_TABLES` table in a freshly migrated database is listed in `TEXT_COLUMNS` (`schema-inventory.ts`) as `'redacted'` or with an exemption reason; an unlisted column, or a listed column that no longer exists, fails.
2. **Sweep** (`secret-redaction-sweep.test.ts`): every agent-facing write — the MCP write tools through the real route handler and SDK client, and the HTTP session routes — is called with a secret in every free-text argument. Afterwards the raw secret occurs in NO column of any table (including `memory_fts`, `prompts_fts` and `memory_entities`), the fake embedder never received it, and EVERY column classified `'redacted'` holds at least one placeholder — so a column cannot be classified `'redacted'` without a write path that reaches the scanner.

### D7 — Linear time

Content is uncapped, so the scanner must be linear: every regex anchors its start with a lookbehind that excludes its own body class (only run starts are tried), quantifiers are bounded, and no quantified group can split a run two ways. PEM blocks are found procedurally: a missing `END` for a label is remembered, so repeated headers cost one search each. A test feeds pathological inputs (repeated headers, long token-class runs, long `KEY=` chains).

## Risks / Trade-offs

- **False negatives by design.** Lowercase unquoted assignments in prose (`password=hunter22`), YAML unquoted values, values under 8 characters and opaque tokens without context are not caught. Precision is the v1 contract; every observed false positive or negative becomes a corpus case.
- **A redacted title can lose its tail** (D4) in the rare case where placeholders lengthen it past 100 characters.
- **Already-stored secrets stay.** A read-only count in `memory.doctor` is the natural follow-up (issue #447).
