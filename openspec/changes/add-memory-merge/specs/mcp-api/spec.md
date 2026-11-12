## ADDED Requirements

### Requirement: The MCP server MUST expose `memory.merge` with a preview-then-confirm contract

The server SHALL register an MCP tool `memory.merge` that replaces several `active` memories with ONE new successor memory. A merge supersedes several memories at once, so it SHALL NEVER happen on a single unreviewed call: the tool has two phases on the same arguments, selected by the presence of `fingerprint`.

Input (zod, strict): `ids` (2 to `MERGE_MAX_IDS` = 10 distinct memory ids; 10 equals `PREDECESSOR_CAP`, so the successor's history lists every original), the successor's `type`, `title`, `content` and `tags` with the same constraints as `memory.save`, an optional `topic_key`, an optional `sessionId` with `memory.save`'s semantics, and an optional `fingerprint`.

**Preview** (no `fingerprint`) SHALL write nothing, including `last_seen_at`, and SHALL return `merged: false` with:

- `originals[]`: each original in the caller's order, with `id`, `type`, `title`, `status`, `topicKey`, `tags`, `createdAt`, `reviewState`, and a `contentPreview` bounded to `MERGE_PREVIEW_CHARS` (300) with `contentTruncated`;
- `successor`: the successor exactly as it would be stored (`type`, `title`, `content`, normalized `tags`, the resolved `topicKey`, and `replaces` = `ids`);
- `warnings[]`, each `{ code, ids, message }`, with codes `topic_keys_dropped` (an original's key is not kept), `needs_review` (an original is past its re-verification date), `pending_judgments` (a pending judgment touches an original) and `type_changed` (an original's type differs from the successor's);
- `fingerprint`: an opaque sha256 over the successor, the state of every original (id, status, type, title, content, tags, `topic_key`, `replaces`) and the warnings. It SHALL NOT cover `last_seen_at`, which every read moves.

**Confirm** (with `fingerprint`) SHALL recompute the preview inside one transaction. When the recomputed fingerprint differs, it SHALL write nothing and return the MCP error `fingerprint_mismatch` whose payload carries the fresh `preview` (with its new `fingerprint`); it SHALL NEVER merge against a state the caller did not preview. When it matches, the same transaction SHALL flip every original to `superseded`, insert the successor with `replaces = ids`, and journal exactly one `merge` op (see the `consolidation` capability). The response SHALL carry `merged: true`, the committed preview fields, the successor's `id`, `status` and `createdAt`, the journal `opId`, and `memory.save`'s `candidates[]`, `judgmentRequired` and `candidatesDetected`, because after commit the successor SHALL go through the same post-commit steps as `memory.save` (embedding, save-time candidate detection, entity linking), sharing one implementation with it.

Rules:

- Every id SHALL resolve inside the connection's effective scope (`resolveEffectiveScope`); a missing or cross-scope id SHALL return `not_found`, and a non-`active` id SHALL return `conflict` naming it. Both phases SHALL require write access.
- `topic_key`: when omitted, the successor SHALL take the single distinct non-null key the originals hold, if any; when the originals hold several distinct keys, the call SHALL be refused with `conflict` until the caller names the surviving key. A named key held by an `active` memory that is NOT in `ids` SHALL be refused with `conflict` naming that memory, so a merge never retires a memory the caller did not name and preview.
- The merge SHALL NOT carry confirmations over (the successor is new text and starts with none), SHALL NOT write relation rows, and SHALL NOT copy the originals' relations. Pending judgments touching an original are left as they are.
- Annotations: `readOnlyHint: false`, `idempotentHint: false`, `destructiveHint: false`, `openWorldHint: false`.
- The tool description SHALL steer the model to call the preview first, SHOW the plan (originals, successor text and every warning) to the user and confirm only after the user agreed, never to invent a fingerprint, and to re-show a `fingerprint_mismatch` preview before confirming again. It SHALL state that the merge is reversible from the operator dashboard.

#### Scenario: A preview writes nothing

- **GIVEN** active memories A and B in project `P`
- **WHEN** a client calls `memory.merge` with `ids: [A, B]` and no `fingerprint`
- **THEN** the response SHALL carry `merged: false`, both originals, the successor with `replaces: [A, B]`, and a `fingerprint`
- **AND** A and B SHALL still be `active` and no `consolidation_ops` row SHALL have been written

#### Scenario: Confirm with the preview's fingerprint commits

- **GIVEN** a preview of merging A, B and C returned fingerprint `F`
- **WHEN** the client calls `memory.merge` with the same arguments and `fingerprint: F`
- **THEN** A, B and C SHALL be `superseded`, a new `active` successor M SHALL exist with `replaces: [A, B, C]`, and the response SHALL carry `merged: true` and M's id

#### Scenario: Confirm without a matching fingerprint writes nothing

- **GIVEN** a preview of merging A and B returned fingerprint `F`, and a pending judgment touching B was created afterwards
- **WHEN** the client calls `memory.merge` with the same arguments and `fingerprint: F`
- **THEN** the call SHALL fail with `fingerprint_mismatch`, carry a fresh preview whose warnings include `pending_judgments`, and A and B SHALL remain `active`
- **AND** a second call with the fresh preview's fingerprint SHALL commit

#### Scenario: An original is discoverable from its successor's history

- **GIVEN** A and B were merged into M
- **WHEN** a client calls `memory.get_batch` with `ids: [A]`
- **THEN** A SHALL be reported `superseded` and its history head SHALL be M

#### Scenario: A named topic_key held outside the merge is refused

- **GIVEN** an active memory O holds `topic_key = K` and is not in `ids`
- **WHEN** a client previews or confirms a merge of A and B with `topic_key: K`
- **THEN** the call SHALL fail with `conflict` naming O, and O SHALL remain `active`

#### Scenario: A cross-scope id is not found

- **GIVEN** a `/mcp/<slug>` connection scoped to project `P` and an active memory X in project `Q`
- **WHEN** a client calls `memory.merge` with `ids` containing X
- **THEN** the call SHALL fail with `not_found` and nothing SHALL be written

#### Scenario: A read-only token cannot merge

- **WHEN** a client authenticated with a read-only token calls `memory.merge`, with or without `fingerprint`
- **THEN** the call SHALL fail with `forbidden` and nothing SHALL be written
