## REMOVED Requirements

### Requirement: Provider MUST override `on_session_switch` to rotate session ids cleanly

**Reason**: Two of the requirement's published claims are false, and both are load-bearing rather than cosmetic. Its **header** asserts that the hook "rotate[s] session ids"; measured against `hermes_agent` 0.19.0, three of the hook's seven call sites pass the id the provider already holds — in-place context compression (`agent/conversation_compression.py:1403`, whose own comment says "in-place uses the same id as parent"), `/undo` (`cli.py:7517`, `rewound=True`), and the gateway rewind (`tui_gateway/server.py:13396`). Its **scenario titled "/reset switches with no parent lineage"** asserts that `/reset` and `/new` arrive with an empty `parent_session_id`; `cli.py:7292` passes `parent_session_id=old_session_id or ""` and `agent/memory_manager.py:905` forwards the same on the with-history path, so it is populated on exactly that case. A published requirement header and a published scenario title cannot both be rewritten inside a `MODIFIED` block — `scripts/check-delta-freshness.mjs` fails on the scenario and `openspec archive` refuses the merge — so the requirement is removed and re-added below under an honest header, with that scenario replaced by one describing the shape `/reset` actually sends. Every other clause and every other scenario is carried over.

**Migration**: None for operators — the provider's HTTP behaviour on these paths does not change, because the code already keys off its own cached id rather than `parent_session_id` and therefore already treats the same-id calls as no-ops. What changes is that the spec now describes the algorithm that runs. For contributors: the provider gains a process-scoped set of ensured session ids so the new resume POST fires at most once per id, and the false comment at `apps/plugin/.hermes-plugin/__init__.py:606-608` is corrected.

## ADDED Requirements

### Requirement: Provider MUST override `on_session_switch` to track the agent's current session id

`RembricMemoryProvider` SHALL override `on_session_switch(new_session_id: str, *, parent_session_id: str = "", reset: bool = False, **kwargs)`. Hermes fires this method on context compression, `/resume`, `/branch`, `/reset`, `/new`, `/undo` and the gateway rewind — every path that reassigns or re-anchors `AIAgent.session_id` without tearing the provider down. Without overriding, our `self._session_id` becomes stale and all subsequent lifecycle posts target the wrong row.

**The session id does NOT always change, and the previous wording of this requirement asserted that it did.** Measured against `hermes_agent` 0.19.0, three of the seven call sites pass a `new_session_id` equal to the id the provider already holds:

- in-place context compression (`agent/conversation_compression.py:1403`, whose own comment records that the hook "Fires in BOTH modes: in-place uses the same id as parent");
- `/undo` (`cli.py:7517`), which passes `rewound=True` with `parent_session_id=""` and the unchanged `self.session_id` — the ABC documents `rewound` as "`True` if session_id is unchanged but the transcript was truncated";
- the gateway rewind (`tui_gateway/server.py:13396`), identical in shape.

The provider SHALL therefore compare against its own cached id and SHALL NOT assume a rotation. Behaviour:

1. If `self._suppressed` is `True` for the session being switched away from, skip ALL of the following steps except updating `self._session_id` — a subagent/cron/flush session that switches is still non-primary, and `self._suppressed` carries forward unchanged onto the new session id (Hermes does not re-run `initialize` on a switch, so there is no new `agent_context` to read).
2. Otherwise, when the cached `self._session_id` is non-empty AND differs from `new_session_id` AND a slug is resolved: `POST /api/<slug>/sessions/<cached_id>/end` with body `{}` to close the old row. Empty body — no summary write here, because the per-turn sync and `on_pre_compress` have already written one. The discriminator SHALL be the cached id, NOT `parent_session_id`: keying off equality with the cached id is what makes the same-id calls above no-ops, and `parent_session_id` cannot serve as the discriminator because it is populated on paths that are not continuations and empty on paths that are.
3. Update `self._session_id = new_session_id`.
4. Unless suppressed (step 1), `POST /api/<slug>/sessions` with body `{"id": <new_session_id>, "cwd": <cached cwd or os.getcwd()>, "agent": "hermes"}` to register the new row. The server writes the placeholder title. This step SHALL run even when the id did not change, because the ensure is idempotent and it is the carrier for step 5.
5. Unless suppressed, and only when `new_session_id` was not already in a process-scoped set of ids this provider has ensured, add it to that set and `POST /api/<slug>/sessions/<new_session_id>/resume` with body `{}`. `initialize` SHALL use the same set for the id it registers, so the pair "ensure then resume" fires at most once per id for the lifetime of the process. This is the uniform cross-client rule specified in `plugin-session-protocol`'s lifecycle mapping; Hermes implements the set itself because it is the Python client and does not import the shared JS core.

**A second false claim SHALL be retired with this requirement.** The provider's source carries the comment "`/reset` and `/new` use `parent_session_id=""` by upstream contract (clean restart, no continuation lineage)". Measured: `cli.py:7292` passes `parent_session_id=old_session_id or ""` on the `/new` path, and `agent/memory_manager.py:905` forwards the same value on the with-history path, so `parent_session_id` arrives **populated** on exactly the case the comment says it is empty. The genuine clean-restart discriminator is `reset=True`, which those two sites pass and no other site does. The comment SHALL be corrected to state the cached-id rule and its real justification; the behaviour it describes does not change.

The host additionally passes a `reason` keyword — `"new_session"`, `"resume"`, `"branch"` or `"compression"`, from five of the seven call sites, absent from the two that pass `rewound=True` — which is not part of the `MemoryProvider` ABC signature and reaches the provider only through `**kwargs`. The provider SHALL NOT consume `reason` or `rewound`, and SHALL continue to discard `**kwargs`. Consuming `reason` could only be used to skip a resume that is already a no-op on an `active` row, at the cost of coupling this provider to a keyword the ABC does not declare and only some call sites send; and `reason="resume"` fires only for an in-process switch, never for the cold start this rule exists to cover, so it would not buy the case that matters.

All HTTP-making steps SHALL silently swallow HTTP errors (single-line stderr diagnostic) — provider failure SHALL NOT crash the host Hermes process.

#### Scenario: Context compression rotates session id

- **GIVEN** the provider is initialized with `self._session_id = "01OLD"` and slug `"foo"`
- **WHEN** Hermes calls `on_session_switch(new_session_id="01NEW", parent_session_id="01OLD", reset=False)` mid-process
- **THEN** the provider SHALL POST `/api/foo/sessions/01OLD/end` with `{}`
- **AND** SHALL update `self._session_id = "01NEW"`
- **AND** SHALL POST `/api/foo/sessions` with `{"id":"01NEW","cwd":<cached>,"agent":"hermes"}`
- **AND** SHALL POST `/api/foo/sessions/01NEW/resume` with `{}`

#### Scenario: An in-place switch keeps the id and closes nothing

- **GIVEN** the provider holds `self._session_id = "01SAME"` and a resolved slug
- **WHEN** Hermes calls `on_session_switch(new_session_id="01SAME", parent_session_id="01SAME", reset=False)` (in-place compression), or `on_session_switch(new_session_id="01SAME", parent_session_id="", reset=False, rewound=True)` (`/undo` or the gateway rewind)
- **THEN** the provider SHALL NOT POST `/end` for `01SAME`
- **AND** `self._session_id` SHALL still be `"01SAME"`
- **AND** the ensure POST SHALL still be issued, and the resume SHALL be issued only if `01SAME` was not already in the provider's ensured-id set
- **AND** the control SHALL pass in the same run: the rotating case above DOES POST `/end`

#### Scenario: /reset switches with a populated parent lineage

- **GIVEN** the provider initialized with `self._session_id = "01OLD"`
- **WHEN** Hermes calls `on_session_switch(new_session_id="01NEW", parent_session_id="01OLD", reset=True)` — the shape `/reset` and `/new` actually send, contrary to the retired claim that `parent_session_id` is empty there
- **THEN** the provider SHALL POST `/end` for `01OLD`, because the discriminator is the cached id and it differs from the new one
- **AND** SHALL update `self._session_id = "01NEW"`
- **AND** SHALL POST `/api/<slug>/sessions` with the new id, then the resume for it

#### Scenario: Switch when slug never resolved is a no-op

- **GIVEN** `initialize` ran with no resolvable slug (provider in degraded mode)
- **WHEN** Hermes calls `on_session_switch` for any reason
- **THEN** the provider SHALL only update `self._session_id` (no HTTP calls, including no resume)

#### Scenario: Switch from a suppressed context makes no HTTP calls for the new session either

- **GIVEN** the provider was initialized with `agent_context="cron"` (so `self._suppressed` is `True`), with `self._session_id = "01OLD"` and a resolved slug
- **WHEN** Hermes calls `on_session_switch(new_session_id="01NEW", parent_session_id="01OLD", reset=False)`
- **THEN** the provider SHALL NOT POST `/end` for `01OLD`
- **AND** SHALL NOT POST `/sessions` for `01NEW`
- **AND** SHALL NOT POST the resume for `01NEW`
- **AND** SHALL still update `self._session_id = "01NEW"`

#### Scenario: The provider ignores `reason` and `rewound`

- **WHEN** Hermes calls `on_session_switch` with any `reason` value, with `rewound=True`, or with neither
- **THEN** the provider's HTTP behaviour SHALL be identical in all three cases for the same `(cached id, new id, slug, suppressed)` tuple
- **AND** the provider SHALL NOT read either keyword

#### Scenario: A cold-started Hermes session re-attaches its memories

- **GIVEN** session `<S>` was registered by a previous Hermes process and its row is now `ended` (`on_session_end` fired) or `abandoned` (the sweep retired it)
- **WHEN** a new Hermes process initializes against the same session id
- **THEN** `initialize` SHALL POST the ensure and then the resume, and the row SHALL be `status='active'` with `ended_at IS NULL`
- **AND** the control SHALL pass in the same run: without the resume the row stays terminal and a subsequent `memory.save` on that transport persists `session_id = NULL`
