## ADDED Requirements

### Requirement: The plugin module SHALL also export an opencode 2.x default plugin

`apps/plugin/.opencode-plugin/plugin.ts` SHALL additionally export, as its **default** export, an object shaped for the opencode 2.x plugin API: `{ id: string, setup: (context) => Promise<Cleanup | void> | Cleanup | void }`. The V2 object SHALL carry the id `rembric.lifecycle`.

The V2 object SHALL NOT be exported by name. opencode 1.x invokes every named export as a plugin function; a V2 object reached that way receives a V1 context and dereferences `ctx.location`, which does not exist there.

`setup` SHALL build its session protocol from the same shared core the V1 export uses, and SHALL register:

1. `ctx.session.hook('prompt')` — begins the turn, ensures the session exists, records the user prompt, and computes the block to inject.
2. `ctx.session.hook('context')` — pushes the block onto the request's `system` array.
3. `ctx.tool.hook('execute.before')` — marks tool use for the current session.
4. `ctx.event.subscribe()` — the lifecycle dispatcher.

`setup` SHALL return a cleanup function that aborts the event subscription and flushes pending work.

#### Scenario: The V2 plugin registers its hooks

- **WHEN** `setup` runs with credentials and a resolvable project slug
- **THEN** the `prompt` and `context` session hooks and the `execute.before` tool hook SHALL be registered
- **AND** an event subscription SHALL be opened

#### Scenario: Missing credentials register nothing

- **WHEN** `setup` runs without `REMBRIC_API_TOKEN`
- **THEN** no hook SHALL be registered
- **AND** `setup` SHALL return without a cleanup function

#### Scenario: The V2 object is not reachable as a named export

- **WHEN** the module's exports are enumerated
- **THEN** the V2 object SHALL appear only as the default export
- **AND** `RembricPlugin` SHALL remain a named export

### Requirement: The V2 plugin SHALL deliver nudges as transient system text

The V2 plugin API exposes no user-message part array, so the plugin SHALL NOT append nudges to a persisted message. Recall and session-opening nudges SHALL be delivered by pushing onto the `system` array of the `context` hook's input, which exists for one model request only and is never persisted to the transcript.

Because that system part does not survive the request, the plugin SHALL cache the injected block per session and SHALL push it on every subsequent request until the session is compacted or closed. On a `context` call whose session has no cached block — a session resumed after a host or plugin restart — the plugin SHALL rebuild the block from the daemon rather than serve the request without context.

The cached block SHALL be discarded when the session is compacted, because compaction rewrites the transcript the block was derived from.

#### Scenario: The block is re-pushed on the next request

- **WHEN** a session's block is injected on one model request
- **THEN** the next request for the same session SHALL receive the same block

#### Scenario: A resumed session rehydrates

- **WHEN** the `context` hook runs for a session with no cached block
- **THEN** the plugin SHALL attempt to rebuild the block before pushing
- **AND** SHALL NOT fail the request if the rebuild fails

#### Scenario: Compaction invalidates the cache

- **WHEN** a `session.compaction.ended` event arrives for a known, non-sub-agent session
- **THEN** the cached block for that session SHALL be discarded

### Requirement: The V2 plugin SHALL scope its events to its own directory

opencode 2.x events carry no project scope. The plugin SHALL therefore resolve a `session.created` session's directory and SHALL register only sessions whose directory equals the plugin instance's `ctx.location.directory`. A session that cannot be resolved SHALL NOT be registered.

Sessions carrying a parent id SHALL be marked as sub-agents and SHALL NOT be registered.

#### Scenario: A foreign session is ignored

- **WHEN** `session.created` names a session whose directory differs from the plugin's
- **THEN** the session SHALL NOT be registered
- **AND** SHALL receive no injected context

#### Scenario: A sub-agent session is not registered

- **WHEN** `session.created` names a session with a parent id
- **THEN** the session SHALL be marked as a sub-agent
- **AND** SHALL NOT be registered

### Requirement: The V2 plugin SHALL capture the assistant transcript from session.text.ended

opencode 2.x does not deliver assistant text as message parts. It emits `session.text.ended` carrying `{ sessionID, assistantMessageID, ordinal, text }`, where `ordinal` distinguishes the text segments of one assistant message.

The plugin SHALL accumulate those segments per assistant message id, ordered by `ordinal`, and SHALL write the joined text to the shared core's assistant-transcript accumulator. Accumulating by ordinal SHALL be idempotent, so a redelivered `session.text.ended` for the same ordinal SHALL NOT duplicate text.

Segments for sub-agent sessions and for sessions the plugin has not registered SHALL be ignored.

#### Scenario: Assistant text reaches the transcript accumulator

- **WHEN** a `session.text.ended` event arrives for a registered, non-sub-agent session
- **THEN** the plugin SHALL write the accumulated text for that assistant message to the core
- **AND** SHALL ignore the event for a sub-agent or unregistered session

#### Scenario: Segments are ordered and idempotent

- **WHEN** two `session.text.ended` events for one message arrive with ordinals 1 and 0
- **THEN** the joined text SHALL order ordinal 0 before ordinal 1
- **AND** a repeat of an ordinal already seen SHALL replace rather than append

### Requirement: The V2 plugin SHALL scope injected context, not only registration

The directory check SHALL be applied when the plugin decides whether to inject context, not only when it registers a session. A session that is not the plugin instance's SHALL receive no injected context even if a request for it reaches the `context` hook.

The resolved verdict SHALL be remembered per session, because the check runs on every model request and 2.x events carry no project scope of their own. The remembered verdict SHALL be discarded when the session is deleted.

#### Scenario: A foreign session receives no context

- **WHEN** the `context` hook runs for a session whose directory differs from the plugin's
- **THEN** the plugin SHALL push nothing onto the request's `system` array
- **AND** SHALL NOT fail the request
