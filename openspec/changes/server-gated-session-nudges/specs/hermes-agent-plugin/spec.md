## MODIFIED Requirements

### Requirement: The Hermes provider SHALL emit unified per-turn save and summary reminders, plus a pre-compaction save reminder

The Hermes `MemoryProvider` (`apps/plugin/.hermes-plugin/__init__.py`) SHALL reinforce curation through `prefetch()` (whose return is injected as `<memory-context>` every turn), report each finished turn through `sync_turn()`, and keep observing `remaining_tokens` in `on_turn_start()`. This is the only per-turn reinforcement Hermes has, since it does not consume the server's `initialize.instructions`.

**The periodic save and summary reminders are no longer composed here and no longer keyed on a turn counter.** `_SAVE_HINT_EVERY`, `_SUMMARY_HINT_EVERY`, `_SAVE_HINT` and `_SUMMARY_HINT` are removed. The firing decision belongs to the server, which composes one stretch-close notice from the session's own state (`session-nudges`); `prefetch()` prints what the previous turn's report returned. `_turn_number` survives only for the one thing that still needs it — the first-turn relevance line — and for nothing else.

- `on_turn_start(turn_number, message, **kwargs)` SHALL remain listed in `plugin.yaml`'s `hooks:` array (the array gates override invocation). It SHALL record the turn number and, when `remaining_tokens` is an int below `_COMPACTION_TOKEN_FLOOR` and no urgent reminder has yet fired this session, arm an urgent flag.
- **`sync_turn(user, assistant, **kwargs)` SHALL additionally issue the turn report** to `POST /api/<slug>/sessions/<session_id>/turn`, on the SAME background thread as the transcript POST it already dispatches, and SHALL cache the returned lines for the next `prefetch()`. It SHALL be suppressed by the same `self._suppressed` guard that gates every other lifecycle call. The transcript POST itself is UNCHANGED and SHALL NOT be removed: the compaction and session-end paths depend on the same `messages` list, and this client's convergence guarantee rests on them.
- **Hermes is the one client that does NOT report on every finished turn, and the deviation SHALL be published rather than left to be discovered.** The host skips its memory fan-out entirely on an interrupted turn (`run_agent.py:4345-4346` returns before `sync_all`), and again when the flattened user or assistant text is empty. `sync_turn` is therefore not called at all on those turns, so this client issues no report for them. Two consequences follow and neither is a defect this change can repair from the plugin side: no notice can be delivered for an interrupted turn, and — the one that matters — `last_activity_at` is not stamped, so a session interrupted on every turn for longer than the abandonment threshold is retired by the stale-active sweep while its user is still working. A client-side workaround (reporting from `on_turn_start`, or a timer) SHALL NOT be added for this: it would report turns that did not complete, which is the opposite of what the field means, and the host's own skip is deliberate — its comment reasons that a partial or aborted turn "is not durable conversational truth".
- **The two conditions SHALL be evaluated over the LAST TURN of `messages`, never over the whole list.** The kwarg is the agent loop's own working list — the same property that makes its content trustworthy makes it a CONVERSATION, not a turn — so a scan of all of it reports `usedTools: true` for every turn after the first tool call the session ever made, and the gate then fires on conversation-only turns for the rest of the run. The turn SHALL be taken as the suffix beginning at the LAST message whose `role` is `user`; where the list carries no `user` message the whole list SHALL be scanned, since nothing narrower is available. The transcript POST is unaffected and SHALL keep using the whole list.
- **The tool observation SHALL be read from `sync_turn`'s `messages` kwarg, and it SHALL test TWO conditions rather than one.** The flag is set when EITHER a message's `role` is outside `{user, assistant, system}`, OR a message with `role: "assistant"` carries a non-empty `tool_calls` field. **A role-only test detects results and misses calls**: in the OpenAI message shape a tool CALL lives in the `tool_calls` field of an `assistant` message while the RESULT is a separate `role: "tool"` message, so a call that produced no result message — an aborted turn, a tool that errored before returning, a provider that batches differently — would be silently invisible to a role check alone. A `system` role SHALL NOT count as a tool.
- **When the kwarg is absent the provider SHALL report `true`, and the reason is structural rather than cautious.** The kwarg exists only on Hermes ≥ 2026.5.29; on older hosts the provider takes its own fallback branch (`apps/plugin/.hermes-plugin/__init__.py:552-557`), which synthesises the list as exactly `[{"role": "user", …}, {"role": "assistant", …}]` from the two positional strings. Both conditions above are then unsatisfiable **by construction**, so a count over that list does not mean "no tool ran" — it means "nothing was observable", and reporting `false` would turn every turn on an older Hermes into a silent false negative. This is the fail-open rule in `session-nudges` applied to a case where the negative is known to be uninformative, not a general precaution.
- **The kwarg's DELIVERY is settled and SHALL NOT be re-litigated; only its runtime CONTENT is open.** The host's `MemoryProvider` ABC declares `sync_turn(self, user_content, assistant_content, *, session_id="", messages=None)`, and the dispatcher selects per provider by signature inspection: a provider declaring a `VAR_KEYWORD` parameter is passed `messages`. This provider's signature is `sync_turn(self, user, assistant, **kwargs)` (`apps/plugin/.hermes-plugin/__init__.py:543`), so it qualifies as written and SHALL keep its `**kwargs` — narrowing that signature to named parameters would fail the inspection and silently stop the kwarg arriving. The host passes the two leading values POSITIONALLY, so this provider's parameter names (`user`, `assistant`) diverging from the ABC's (`user_content`, `assistant_content`) is harmless and SHALL NOT be treated as a defect to repair.
- **The list's CONTENT is traced in upstream source, and the role half of the condition is traced to its literal.** `messages` is the agent loop's own working list rather than one assembled for memory: the tool executor appends tool-result messages into it at seven sites, `make_tool_result_message` sets `"role": "tool"`, the turn finaliser carries `messages` as a first-class parameter distinct from `conversation_history`, and the runtime forwards it into `sync_all` when non-`None`. So a turn that ran a tool puts a `role: "tool"` message in the list the provider receives. What remains is corroboration in execution, not discovery: a single dump of the roles present on a tool turn against a running Hermes ≥ 2026.5.29. That check SHALL gate closing this change and SHALL NOT gate implementing it.
- **The `tool_calls` half is the one clause with no trace behind it, and SHALL be labelled as such rather than presented alongside the traced half.** It was not followed to an append. It stays because it is the correct rule for the OpenAI shape, and its worst case is narrow: a tool call that produced no result message reports `false`, costing one notice. If a running Hermes never populates it, the clause MAY be dropped, and dropping it SHALL NOT be treated as weakening the rule.
- `prefetch()` SHALL return the cached recall context and SHALL additionally append, as separate lines:
  - the **first-turn relevance** hint when `_turn_number == 1`;
  - the **session opening** when the session-ensure reported a newly created session and it has not yet been emitted (`session-nudges`);
  - the **urgent pre-compaction** save reminder when its flag is armed, marking itself warned so it fires at most once per session;
  - the **post-compaction** directive when armed by `on_pre_compress`, superseding the resumed-read line on a shared turn, unchanged by this requirement;
  - the **cached server lines** from the last turn report, verbatim, wrapped in `<memory-hint>…</memory-hint>` per this provider's established convention and otherwise unaltered. Reading the cache SHALL clear it, so a notice is injected exactly once.
- Every line SHALL remain mutually independent; none SHALL overwrite another.
- **`prefetch()` SHALL make no network call.** It reads two caches — the recall cache and the pending-lines cache — and returns. The request that produced the lines was made by `sync_turn` on the previous turn.
- The urgent/warned flags, the turn counter and the pending-lines cache SHALL reset on session end and session switch.

#### Scenario: prefetch injects the server's notice, once, wrapped

- **GIVEN** an initialized provider whose last `sync_turn` report returned notice lines
- **WHEN** `prefetch` is next called
- **THEN** the returned string SHALL contain those lines, wrapped in `<memory-hint>…</memory-hint>` and otherwise byte-identical to the response
- **AND** a subsequent `prefetch` with no new report SHALL NOT contain them again

#### Scenario: The provider composes no periodic reminder and counts no cadence

- **WHEN** `apps/plugin/.hermes-plugin/__init__.py` is read at HEAD
- **THEN** it SHALL contain no `_SAVE_HINT_EVERY`, no `_SUMMARY_HINT_EVERY`, no `_SAVE_HINT` and no `_SUMMARY_HINT`
- **AND** the only remaining use of `_turn_number` SHALL be the first-turn relevance line

#### Scenario: sync_turn reports the turn and keeps its transcript POST

- **GIVEN** an initialized, unsuppressed provider
- **WHEN** `sync_turn` is called once
- **THEN** the background thread SHALL issue BOTH the `/summary` transcript POST and the `/turn` report
- **AND** `sync_turn` SHALL return without blocking on that thread
- **AND** a suppressed provider (`agent_context` in the non-primary set) SHALL issue neither

#### Scenario: A tool RESULT message in the messages kwarg is reported as work

- **GIVEN** a `sync_turn` call whose `messages` kwarg carries a message with `role: "tool"`
- **WHEN** the report is built
- **THEN** it SHALL carry `usedTools: true`
- **AND** the control SHALL pass in the same run: a list of only `user`, `assistant` and `system` roles, none carrying `tool_calls`, SHALL report `usedTools: false`

#### Scenario: A tool used in an earlier turn is not reported for a later chat turn

- **GIVEN** a `messages` list whose first turn carries a `tool_calls` assistant message and a `role: "tool"` result, followed by a second turn of `user` and `assistant` messages only
- **WHEN** the report for that second turn is built
- **THEN** it SHALL carry `usedTools: false`
- **AND** the control SHALL pass in the same run: the same two turns in the opposite order SHALL report `usedTools: true`

#### Scenario: A tool CALL with no result message is still reported as work

- **GIVEN** a `sync_turn` call whose `messages` kwarg carries an `assistant` message with a non-empty `tool_calls` field and NO `role: "tool"` message anywhere in the list
- **WHEN** the report is built
- **THEN** it SHALL carry `usedTools: true`
- **AND** a role-only test SHALL be shown to return `false` on the same input, which is why both conditions are required

#### Scenario: An interrupted turn produces no report, and that is the published behaviour

- **GIVEN** a Hermes turn the user interrupts before it completes
- **WHEN** the host finalises it
- **THEN** `sync_turn` SHALL NOT be called, so no turn report SHALL be issued
- **AND** `last_activity_at` SHALL NOT be stamped by that turn
- **AND** no client-side substitute SHALL be issued from `on_turn_start`, from a timer, or from any other handler

#### Scenario: The provider's signature keeps the kwarg arriving

- **WHEN** `apps/plugin/.hermes-plugin/__init__.py`'s `sync_turn` signature is read at HEAD
- **THEN** it SHALL declare a `**kwargs` parameter
- **AND** it SHALL NOT be narrowed to named parameters only, which would fail the host's signature inspection and stop `messages` being passed with no error anywhere

#### Scenario: An empty `tool_calls` field is not a tool call

- **GIVEN** an `assistant` message whose `tool_calls` is an empty list, or absent, or `None`
- **WHEN** the report is built
- **THEN** that message alone SHALL NOT set the flag

#### Scenario: An absent messages kwarg fails open because the negative is uninformative

- **GIVEN** a Hermes older than 2026.5.29, so `sync_turn` receives no `messages` kwarg and the provider synthesises the list from the two positional strings
- **WHEN** the report is built
- **THEN** it SHALL carry `usedTools: true`
- **AND** the synthesised list SHALL be shown to admit only `user` and `assistant` roles and no `tool_calls` field, so a `false` from that branch would report "no tool ran" on evidence that could never have shown one

#### Scenario: prefetch appends the relevance hint on turn 1

- **GIVEN** an initialized Hermes provider with an empty recall cache
- **WHEN** `prefetch` is called on the 1st turn
- **THEN** it SHALL return a non-empty string containing the first-turn relevance hint

#### Scenario: on_turn_start arms the urgent reminder only below the floor

- **WHEN** `on_turn_start` is called with `remaining_tokens` above `_COMPACTION_TOKEN_FLOOR`
- **THEN** no urgent flag SHALL be armed
- **WHEN** it is later called with `remaining_tokens` below the floor
- **THEN** the urgent flag SHALL be armed

#### Scenario: The pre-compaction reminder fires once and does not suppress a pending notice

- **GIVEN** the urgent flag is armed and notice lines are cached
- **WHEN** `prefetch` is next called
- **THEN** it SHALL return the urgent pre-compaction save reminder AND the cached notice, as separate lines
- **AND** a subsequent `prefetch` on a later low-token turn SHALL NOT repeat the urgent reminder (warned once per session)

#### Scenario: prefetch makes no network call

- **WHEN** `prefetch` is executed
- **THEN** no HTTP request SHALL be issued from it
- **AND** the lines it injects SHALL come from caches populated by `queue_prefetch` and `sync_turn`
