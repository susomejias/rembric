## Why

The only redaction Rembric performs today is client-side: `stripPrivateTags` (`apps/plugin/bin/rembric-plugin-core.mjs`) removes `<private>…</private>` spans from transcript-derived uploads. Nothing on the server inspects what it persists (issue #447):

- A client without the plugin — a plain MCP URL in an editor, a custom connector, a script calling `/api` — writes content verbatim. A `memory.save` whose content quotes a `.env` line, a pasted `curl -H "Authorization: Bearer …"` or a connection string stores the credential as-is.
- Even plugin clients only redact what the model or the user wrapped in `<private>`. A token the agent read from a file and summarised is not wrapped.

Append-only makes this worse than in a mutable store. Once written, a secret lives in `memory.content`, in `memory_fts`, in the entity index and in the embedding input; `content` is never updated, and the maintenance purge only reaches archived rows that nothing references. In practice a leaked secret is permanent.

Mapped before writing (evidence in `design.md`): the NUL-byte guard (`assertNoNul`) covers memory content, title, tags and topic_key, the refute reason, and session title and summary. Prompt content/title/tags, judgment reason/evidence, the affirm reason, and session agent/description are persisted without it.

## What Changes

- **A deterministic, model-free secret scanner** in `packages/core/src/services/secret-redaction.ts`: a closed, named list of high-precision detectors — provider-prefixed tokens (GitHub, GitLab, Anthropic, OpenAI, AWS access key ids, Slack, Stripe secret keys, Google API keys, npm, Hugging Face), PEM private-key blocks, JWTs, `Authorization:` header credentials, `scheme://user:password@host` URL passwords, and credential-named assignments (`KEY=value`, `--key=value`, `?key=value`, `key: "value"`). No entropy heuristics.
- **Redaction at the service boundary**, on every persisted agent-supplied text field: memory title/content/tags/topic_key, confirmation reason (affirm and refute), session agent/description/title/summary, prompt content/title/tags, and judgment reason/evidence (`memory.judge_batch`, `memory.compare`, orphaning). A matched span becomes `[REDACTED:<kind>]` before the row is written, so the FTS triggers, entity extraction and the embedder — which all read the stored row — never see the original.
- **The write succeeds and says so.** MCP write responses carry `redactions: { kind, count }[]` when at least one span was replaced (omitted otherwise). Write tool descriptions gain one line stating the behaviour, within `DESCRIPTION_MAX_LENGTH`.
- **Coverage invariant.** Every TEXT column of every source table is classified as `redacted` or exempt-with-reason; an unclassified column fails the invariant suite, and a real-boundary sweep (MCP tools and HTTP session routes) proves that every `redacted` column receives a placeholder and that the raw secret appears nowhere in the database, the FTS index, the entity index or the embedder input.

Not in scope (issue #447): rewriting already-stored rows (it would break append-only), and user-configurable patterns (the list stays code).

## Capabilities

### New Capabilities

- `secret-redaction` — the detector list, the placeholder, the covered write paths, the response field, field caps after redaction, and the coverage invariant.

## Impact

- **Server:** `packages/core/src/services/{secret-redaction,memory,agent-sessions,prompts,relations}.ts`; MCP handlers and output schemas in `packages/mcp/src/{memory-tools,observability-tools,prompt-tools,relations-tools,session-tools}.ts`; descriptions in `packages/mcp/src/server.ts`.
- **Tests:** scanner unit tests and false-positive corpus (`packages/core`), service tests, `apps/web/src/test/invariants.test.ts` (classification), a new real-boundary sweep in `apps/web/src/test/`.
- **No schema change, no migration, no new tool, no client change.** HTTP session routes redact through the same services; their response bodies are unchanged because no model reads them. Rollback is a plain revert; rows written while the change was live keep their placeholders.
