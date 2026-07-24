## ADDED Requirements

### Requirement: Relevance MUST be prefetched once per session, not only on a keyword

The plugin currently runs a relevance query only when the user's prompt matches a recall-intent keyword list. Every other session begins with no relevant memory injected — the session-start hook emits a nudge and nothing else — so whether the agent receives prior knowledge depends on the user's phrasing rather than on whether prior knowledge exists.

On the first user prompt of a session, the plugin SHALL prefetch relevance seeded from that prompt and inject a bounded result. The existing keyword matcher SHALL be retained for explicit recall requests at any point in the session. The prefetch SHALL fire at most once per session, SHALL be bounded in injected size, and SHALL fail silently — an unreachable server SHALL never block the host agent.

The injected block SHALL be represented in the shared nudge fixtures with a character budget and asserted in lock-step against the equivalent block in every other client, so the four implementations cannot drift.

#### Scenario: A session with no recall keyword still receives relevance

- **GIVEN** a project with memories relevant to the user's first prompt
- **WHEN** the first prompt of a session contains no recall-intent keyword
- **THEN** the plugin SHALL inject a bounded relevance block

#### Scenario: The prefetch does not repeat

- **WHEN** the second and subsequent prompts of the same session are submitted
- **THEN** the first-prompt prefetch SHALL NOT fire again

#### Scenario: An unreachable server does not block the turn

- **WHEN** the first prompt is submitted and the server is unreachable
- **THEN** the hook SHALL exit without output and the host session SHALL continue

#### Scenario: The injected block is fixture-covered

- **WHEN** the injected relevance block diverges from the equivalent block in another client
- **THEN** the lock-step fixture test SHALL fail and the build SHALL be rejected
