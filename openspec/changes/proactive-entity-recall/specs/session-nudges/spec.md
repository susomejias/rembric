## MODIFIED Requirements

### Requirement: Every client MUST report each finished turn to the server and print what it is handed back

The five bundled clients SHALL behave identically in the core of this capability: each SHALL report the turn that has just finished, SHALL cache whatever lines the server returns, and SHALL print them at the start of its next turn. A client SHALL hold no cadence, no turn counter and no reminder text for this purpose.

**The report is at the END of the turn.** Issuing it at the start would put an HTTP round trip on the path where the user has just submitted a prompt, and would report a turn that has not happened yet. **The print is at the START of the next turn**, from the cache, so the notice costs no request on the latency-critical path.

The report SHALL carry a boolean naming what the CLIENT OBSERVED — whether at least one tool was invoked during the turn — rather than an interpretation of it. The server owns the interpretation; separating them is what allows the interpretation to change without touching five clients.

**The turn body retains `{usedTools}` (+`title` once) exactly as today.** The proactive recall hints are delivered via a separate synchronous endpoint (`POST /sessions/:id/recall-hints`) called at turn START, not via a `prompt` field on the turn body. The turn body SHALL NOT gain a `prompt` field; the prompt is sent to the hints endpoint instead.

**A client that cannot observe tool invocation SHALL report `true`, and its inability SHALL be recorded in that client's own capability.** Reporting `false` on an unobservable client silently disables the reminder there, which is the asymmetry this requirement exists to remove; reporting `true` costs at most one notice per floor on a session with no work. The per-client observation source SHALL be named in each client's capability, together with the grade of the evidence behind it — an executed run, a host declaration, or neither — so a reader can tell a measured source from an inferred one without re-deriving it. A source graded below an executed run SHALL carry the fail-open branch above, and its verification SHALL be an obligation of the change that introduces it rather than a note for a later one.

The report MAY carry an optional `title`, sent at most once per session, so that the provisional label a client used to derive from its per-turn transcript sync still lands. Where sent, it SHALL be the session's FIRST user prompt, truncated to 100 characters and `<private>`-redacted before it leaves the client, and it SHALL be written under the existing `final: false` precedence so any later model-authored title replaces it.

**A report that returns no lines SHALL NOT clear a non-empty cache.** A second report for the same turn — a host continuation triggered by an unrelated handler — would otherwise overwrite a pending notice with nothing.

Each client's report SHALL be issued at most once per turn. Where a host can re-enter the end-of-turn event within one turn, the client SHALL use the host's own re-entry signal to suppress the repeat rather than deduplicate downstream.

#### Scenario: The notice is printed one turn after the work that earned it

- **GIVEN** any of the five clients on a turn that used tools, where the gate's conditions are all satisfied
- **WHEN** the turn ends and the client reports it
- **THEN** the response SHALL carry the notice lines
- **AND** the client SHALL print nothing at that moment
- **AND** the client SHALL print exactly those lines at the start of its next turn, before the model responds

#### Scenario: A client cannot observe tool use and says so

- **GIVEN** a client whose host exposes no per-turn tool signal
- **WHEN** it reports a turn
- **THEN** it SHALL send `usedTools: true`
- **AND** its own capability SHALL name the absent signal, so the fail-open is a recorded gap rather than an undocumented default

#### Scenario: A second report inside one turn does not lose a pending notice

- **GIVEN** a client holding cached notice lines that have not yet been printed
- **WHEN** the end-of-turn event fires a second time within the same turn and the server returns no lines
- **THEN** the cached lines SHALL survive
- **AND** they SHALL be printed at the start of the next turn

#### Scenario: The provisional title is sent once

- **GIVEN** a session whose first turn has just ended
- **WHEN** the client reports it
- **THEN** the report MAY carry `title` equal to the first user prompt, ≤100 characters, with every `<private>` span replaced
- **AND** no later report in the same session SHALL carry `title`

#### Scenario: Five clients, one behaviour

- **WHEN** each of the five bundled clients is driven through a turn that used tools at a moment the gate fires
- **THEN** each SHALL issue exactly one report at the end of that turn
- **AND** each SHALL print the server's lines at the start of the next turn
- **AND** the printed text SHALL be byte-identical across the five, modulo the host wrapper each uses to inject context

#### Scenario: Recall hints arrive at turn start, not via the turn channel

- **GIVEN** a client whose prompt mentions an entity with matching memories
- **WHEN** the client calls the recall-hints endpoint at turn START
- **THEN** the response SHALL contain entity recall lines
- **AND** the client SHALL merge these lines into the model's context before the model responds
- **AND** the turn channel (`POST /sessions/:id/turn`) at turn END SHALL NOT carry entity recall lines

#### Scenario: The turn body does not carry a prompt field

- **WHEN** a client reports a turn via `POST /sessions/:id/turn`
- **THEN** the body SHALL contain only `{usedTools}` (and optionally `title`)
- **AND** the body SHALL NOT contain a `prompt` field

### Requirement: Recall, the session opening and the resumed-read line MUST stay client-composed, and the split MUST be stated

Moving the stretch-close reminder to the server does not remove the client's local rules; it moves one of them. The boundary SHALL be published rather than left to be inferred from code, and it is:

- **Server-composed:** the stretch-close notice (delivered via the turn channel at turn END, printed at next turn START).
- **Server-composed:** entity recall hints (delivered via the recall-hints endpoint at turn START, merged into the model's context immediately).
- **Client-composed:** the recall line (keyword regex), the session opening, and the resumed-read line.

Each local line stays local for a reason that is a property of the mechanism, not a matter of convenience:

- **Recall** is a regular expression over the user's prompt, and fires at the START of the current turn — the same moment the prompt arrives — while entity recall hints are fetched synchronously at the same moment via the hints endpoint. The two are complementary: the keyword regex catches explicit recall intent; entity recall catches implicit relevance. Both fire at turn START and neither subsumes the other.
- **The session opening** is gated on the `created` flag the session-ensure already returns, and it exists for the ONE-TURN session. The notice is a turn behind by construction, so a session that ends after a single turn would otherwise receive nothing at all.
- **The resumed-read line** is gated on the same `created` flag and fires before any floor can elapse. Its purpose partly overlaps the notice's inventory, which also tells a model that something is stored; the overlap is recorded and deliberately not resolved, because the two fire at different moments.

#### Scenario: The recall line is still emitted with the server unreachable

- **GIVEN** a client whose server is unreachable
- **WHEN** the user submits a prompt matching the recall keywords
- **THEN** the recall line SHALL still be emitted
- **AND** no notice SHALL be emitted, because none could be fetched
- **AND** no entity recall hints SHALL be available, because the hints endpoint is unreachable

#### Scenario: No client composes stretch-close text of its own

- **WHEN** every client's source is inspected at HEAD
- **THEN** none SHALL declare a string directing the model to refresh the session summary on a cadence
- **AND** the only cadence-driven reminder text in the repository SHALL be the server's

#### Scenario: Entity recall hints and keyword recall fire at the same moment

- **GIVEN** a turn whose prompt matches the recall keywords AND mentions an entity with matching memories
- **WHEN** the client prints the start-of-turn lines and fetches hints
- **THEN** the keyword recall line SHALL be emitted (client-composed, on this turn)
- **AND** the entity recall hints SHALL be merged into the model's context (server-computed, fetched synchronously at turn START)
- **AND** both SHALL be visible to the model from the first token of its response
