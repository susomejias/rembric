## ADDED Requirements

### Requirement: A `supersedes` verdict MUST be refused when either endpoint is no longer active

`supersedes` is the only verdict that rewrites the lifecycle of both memories it names: the target transitions to `superseded` and the source's `replaces[]` gains the target's id. That rewrite is only meaningful while both rows still represent live knowledge. The server SHALL therefore verify that the source AND the target are both `status = 'active'` before applying the side effect, and SHALL reject the call with structured code `conflict` otherwise, persisting nothing — neither the lifecycle flip nor the `memory_relations` transition that accompanies it.

The check SHALL apply to every entry point that can produce the verdict, `memory.judge` and `memory.compare` alike, including `memory.compare`'s update-in-place path over an already-judged row. The existing scenarios for those tools already state both endpoints as `active`; this requirement makes that precondition normative rather than incidental.

The check SHALL NOT apply where the requested end state already holds — the target is already `superseded` and the source's `replaces` already names it. Re-applying that is a no-op, not the rewrite this requirement guards, and `memory.compare` is specified as last-call-wins and carries `idempotentHint: true`, so an identical retry SHALL succeed rather than raise `conflict`.

The `topic_key` upsert path is unaffected because it does not reach this check at all: the `memory_relations` row with `marked_by_kind = 'agent_topic_key'` is written by `memory.save` inside the SAME transaction as the insert and the supersede, as the `memory` capability already requires, rather than by a follow-up verdict.

No other relation SHALL be constrained this way. `not_conflict`, `conflicts_with`, `duplicate`, `related`, `compatible` and `scoped` SHALL remain closable when either endpoint has been retired, because they record an observation about a pair rather than rewriting it — and because a `not_conflict` dismissal recorded against a retired source is deliberately carried forward to every later revision of the topic through the `replaces` ancestry, so refusing it would discard suppression the `memory` capability specifies and leave the pair to orphan with no verdict at all.

#### Scenario: Judging supersedes from a retired source

- **GIVEN** a pending row J whose source S has `status = 'superseded'` and whose target L has `status = 'active'`
- **WHEN** the agent calls `memory.judge({judgmentId: J, relation: 'supersedes'})`
- **THEN** the call SHALL be rejected with code `conflict`, L SHALL remain `active`, S's `replaces` SHALL be unchanged, and J SHALL remain `pending`

#### Scenario: Judging supersedes against a retired target

- **GIVEN** a pending row J whose source S has `status = 'active'` and whose target T has `status = 'archived'`
- **WHEN** the agent calls `memory.judge({judgmentId: J, relation: 'supersedes'})`
- **THEN** the call SHALL be rejected with code `conflict` and nothing SHALL be persisted

#### Scenario: Other verdicts stay closable on a retired pair

- **GIVEN** a pending row J whose source S has `status = 'superseded'`
- **WHEN** the agent calls `memory.judge({judgmentId: J, relation: 'not_conflict'})`
- **THEN** the call SHALL succeed and J SHALL transition to `status = 'judged'` with `relation = 'not_conflict'`

#### Scenario: A topic_key upsert records its audit relation atomically

- **GIVEN** an active memory M holding `topic_key = 't'`
- **WHEN** `memory.save` is called with the same `topic_key = 't'`
- **THEN** within that one save transaction M SHALL transition to `superseded`, the new row N SHALL carry M's id in `replaces`, and a `memory_relations` row SHALL exist with source N, target M, `relation = 'supersedes'`, `status = 'judged'` and `marked_by_kind = 'agent_topic_key'` — with no follow-up verdict, so this requirement's check is never consulted

#### Scenario: Re-applying a supersede that already holds

- **GIVEN** an `active` memory N whose `replaces` names M, and M with `status = 'superseded'`
- **WHEN** the caller invokes `memory.compare({sourceId: N, targetId: M, relation: 'supersedes'})` again
- **THEN** the call SHALL succeed, M SHALL remain `superseded`, and N's `replaces` SHALL be unchanged

#### Scenario: `memory.compare` is refused on the same terms

- **GIVEN** an `active` memory L and a `superseded` memory S in the same scope
- **WHEN** the caller invokes `memory.compare({sourceId: S, targetId: L, relation: 'supersedes'})`, whether or not a judged row for that pair already exists
- **THEN** the call SHALL be rejected with code `conflict`, L SHALL remain `active`, and no `memory_relations` row SHALL be inserted or updated


## MODIFIED Requirements

### Requirement: The MCP server MUST expose `memory.compare`

The server SHALL register a `memory.compare` tool that records a verdict on two arbitrary memories without a preceding save. The schema SHALL be `{ memoryIdA: string, memoryIdB: string, relation: enum (excluding 'not_conflict'), reason?: string, confidence: number, evidence?: any }`. The verdict SHALL be persisted as a `memory_relations` row with `status = 'judged'` from the start. Both memories SHALL first be resolved against the connection's effective scope (per the cross-scope-target requirement above) before any cross-scope-tuple comparison between the two memories themselves is considered.

#### Scenario: Comparing two memories from independent analysis

- **WHEN** the agent calls `memory.compare({memoryIdA: 'X', memoryIdB: 'Y', relation: 'related', confidence: 0.9, reason: 'both describe auth token rotation'})`
- **THEN** a `memory_relations` row SHALL be inserted with `source_id = X`, `target_id = Y`, `relation = 'related'`, `status = 'judged'`, `marked_by_kind = 'agent'`

#### Scenario: Comparing the same pair twice (idempotency)

- **WHEN** `memory.compare` is called twice with the same `(memoryIdA, memoryIdB)` ordered pair and different `relation` values
- **THEN** the existing row SHALL be UPDATED (relation, reason, confidence, judged_at refreshed); a new row SHALL NOT be inserted

#### Scenario: Comparing across scopes relative to the connection

- **WHEN** `memory.compare` is called with two memories from different `(scope, project_id)` tuples
- **THEN** at least one of the two necessarily lies outside the connection's effective scope, so the call SHALL be rejected with code `not_found` (per the cross-scope-target requirement) — the legacy `cross_scope_relation` code is superseded at the tool surface by this masking rule; the underlying `RelationsService.compare` defensive check (and its `cross_scope_relation` error) remains in place for same-scope-resolved callers that do not go through the connection-scoped path (e.g. the development seeder)

#### Scenario: Comparing with the `not_conflict` relation

- **WHEN** `memory.compare` is called with `relation: 'not_conflict'`
- **THEN** the call SHALL be rejected with code `invalid_input`; `not_conflict` is only valid as a `memory.judge` verdict (it answers "the save-time candidate was a false positive"), not as a proactive comparison
