## ADDED Requirements

### Requirement: The post-compaction instruction SHALL name the session it applies to when the client knows the id

The post-compaction block (see "The post-compaction instruction SHALL direct the model to read the stored summary and then rewrite the session's current state in full") SHALL carry the literal session id whenever the emitting client knows it:

1. The read step SHALL name the id literally: `memory.session_get_batch({ ids: ["<id>"] })`.
2. The write step SHALL name `sessionId` among the arguments of `memory.session_summary`: `memory.session_summary({sessionId, title, summary})`.
3. Nothing else in the block SHALL change. The rendered block SHALL differ from the symbolic block only in those two calls.

The id SHALL come from the client's own record of the session it registered: the hook's stdin `session_id` for `post-compact.sh` (Claude Code and Codex CLI), `input.sessionID` for the opencode compacting handler, and the provider's session id for Hermes. When the client has no id, it SHALL emit the symbolic block unchanged (`ids: [sessionId]`, `memory.session_summary({title, summary})`). It SHALL NOT emit an empty id such as `ids: [""]`, and SHALL NOT leave the `{{SESSION_ID}}` placeholder in the output.

One copy of the text is kept. The shared fixtures carry the rendered form as a template (`postCompactTemplate`, and `postCompactCoreTemplate` without the `rembric:` prefix) with the placeholder `{{SESSION_ID}}`, next to the symbolic `postCompact` and `postCompactCore`. The JS/TS core exports the template and one renderer that every JS/TS client uses. Bash and Python render the same template, and the fixture test pins all three.

Where another requirement fixes a client's post-compaction text as byte-identical to the shared fixture value (the opencode compacting handler's "byte-identical to the shared fixture's unprefixed post-compaction value", Hermes' `_POST_COMPACT_HINT`, and "One copy of the text" above), that value SHALL be read as `postCompactCoreTemplate` rendered with the session id when the client knows the id, and as `postCompactCore` when it does not. The id is per-session data, like the opencode slug sentence, and not a per-client copy of the text.

The rendered block SHALL stay within the ≤700-byte cap that `claude-code-plugin` publishes for `postCompact` and that the fixture test asserts, when rendered with a 36-character id. Measured on the shipped fixtures, the rendered `postCompactTemplate` is 669 bytes and the rendered `postCompactCoreTemplate` is 660, against 629 and 620 for the symbolic forms. No cap moves. Two older clauses still quote ≤600 bytes for this block (`opencode-plugin`'s compacting handler, and the post-compact scenario under "Plugin-injected protocol nudges MUST surface the summary length cap"). The symbolic block already exceeded that before this change (629 and 620 bytes), and no test asserts it. This change does not reconcile those clauses.

The symbolic form depended on the literal id surviving compaction somewhere else in the context, usually the turn-1 `sessionIdTemplate` line. The host's compaction summary does not always keep that line. When it is lost, the server's own instructions ("Pass known sessionId; never guess") lead the model to skip both steps rather than guess. Executed with Claude Code auto-compaction against a local server (Sonnet), none of the 9 compactions whose summary lost the id was followed by a Rembric call under the symbolic block. Six of the nine stated the reason: the model had no session id and would not guess one. With this block, 3 of 5 such compactions were followed by both calls. The design records the counts.

#### Scenario: post-compact.sh names the session it was given

- **GIVEN** hook stdin `{"session_id": "<36-character id>", "cwd": …}`
- **WHEN** `post-compact.sh` runs as Claude Code or as Codex CLI
- **THEN** its stdout SHALL equal `postCompactTemplate` with `{{SESSION_ID}}` replaced by that id
- **AND** it SHALL be ≤700 bytes in UTF-8

#### Scenario: No id falls back to the symbolic block

- **GIVEN** hook stdin with no `session_id`
- **WHEN** `post-compact.sh` runs
- **THEN** its stdout SHALL equal `postCompact`
- **AND** it SHALL contain neither `{{SESSION_ID}}` nor `ids: [""]`

#### Scenario: Every client renders the same text

- **WHEN** the opencode compacting handler runs with `input.sessionID = S`, and the Hermes provider emits the post-compaction hint for session `S`
- **THEN** the opencode string SHALL be `postCompactCoreTemplate` rendered with `S`, followed only by the slug sentence
- **AND** the Hermes hint SHALL be `postCompactCoreTemplate` rendered with `S`, wrapped in `<memory-hint>` tags
- **AND** without an id, both SHALL fall back to `postCompactCore`

#### Scenario: The template differs from the symbolic block only in the two calls

- **WHEN** `postCompactTemplate` has `ids: ["{{SESSION_ID}}"]` replaced by `ids: [sessionId]`, and `({sessionId, title, summary})` replaced by `({title, summary})`
- **THEN** the result SHALL equal `postCompact`
