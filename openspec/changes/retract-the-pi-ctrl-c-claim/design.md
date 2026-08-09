## Context

`add-pi-plugin` published, in two specs and four documentation surfaces, that Ctrl-C does not reach Pi's session-shutdown handler **in either mode**. The interactive half of that is false. This document exists to explain **why the original measurement was wrong**, because a change that only flips the conclusion teaches a future reader nothing and leaves the same instrument free to produce the same class of error again.

### The original measurement, and the confound it did not control

Two probes preceded today's. Their history is already in the archive, and the second one's failure is diagnosed — unwittingly — by the first one's post-mortem.

**Probe 1** closed stdin immediately after sending the key and reported Ctrl-C as working. `openspec/changes/archive/2026-08-08-add-pi-plugin/design.md:199` records why it was thrown out, verbatim:

> The instrument matters more than the result here. The first version of this probe closed stdin immediately after sending the key, and reported Ctrl-C as working; the control that must fail (send nothing) produced byte-identical evidence, proving the probe measured the EOF rather than the key. Separating the arms in _time_ rather than in _whether the event occurs_ is what made it discriminate…

**Probe 2** is the published result, at `:197`: "keys delivered at t=4 s and stdin held open until t=14 s, Ctrl-C left the handler firing at 13.6 s — the stdin EOF, byte-identical to the no-keys control — while Ctrl-D fired it at 3.6 s."

Probe 2 fixed probe 1's confound and introduced one of its own that it never controlled for: **it never varied the inter-press interval.** "Keys at t=4 s", with no spacing stated, is either one press or two spaced beyond 500 ms — and both fall into the `else` branch of `handleCtrlC()`, which clears the editor and arms the window rather than exiting. So **13.6 s is a correct measurement of a case operators do not hit**. Nothing about it was sloppy; it answered a question narrower than the one the spec text then went on to answer. The published sentence generalised a single-press result to "the interrupt", and the generalisation is what was wrong, not the number.

That is the transferable lesson, and it is the same one probe 1 taught at a different level: **the arm structure has to span the axis the mechanism actually keys on.** Probe 1 varied "did the event happen" and could not see the key. Probe 2 varied time-of-key but held press-spacing fixed at a value outside the window, and could not see the double press. Today's probe varies spacing (200 ms vs 1500 ms) against a no-keys baseline, which is the first instrument in the series whose arms bracket the 500 ms threshold in the source.

### Why `reason` never could have discriminated, and how that nearly re-published the falsehood

All three arms report `reason: "quit"`, because the EOF exit and the Ctrl-C exit both terminate through the same `runtimeHost.dispose()`. A probe that asserts `reason === 'quit'`, or merely that a marker file appeared, therefore **passes on every arm including the baseline** — it is a probe with no failing control at all. The first attempt at today's re-measurement did exactly this, asserted marker-presence, and "confirmed" the published falsehood before the timing arms overturned it. Elapsed time is the only discriminator this system offers.

### What the source says

Verified in the installed 0.84.1 tree:

- `dist/modes/interactive/interactive-mode.js:3048-3056` — `handleCtrlC()` calls `void this.shutdown()` when `now - this.lastSigintTime < 500`; otherwise it clears the editor and arms the window.
- `:3059` — `handleCtrlD()` is the same `void this.shutdown()`.
- `:3100` — `shutdown()` awaits `runtimeHost.dispose()` before `process.exit(0)`.
- `:3089` — Pi's own comment: "Interactive quit (Ctrl+D, Ctrl+C, /quit, extension shutdown())".
- `:667` — the startup banner prints `rawKeyHint(\`${keyText("app.clear")} twice\`, "to exit")`.
- `dist/core/keybindings.js:8` — `app.clear` is the default binding and is user-rebindable.
- `:2223` — the handler is bound to the default editor.

The banner matters beyond confirming the mechanism: **the product tells the operator on screen that the key exits**, and our documentation told them it silently costs their session. A contradiction with the host's own UI is the shape of documentation error an operator resolves against us.

## Goals / Non-Goals

**Goals:**

- Retract the interactive half of the "either mode" claim on every surface that carries it, with the qualifiers that keep the replacement true.
- Record the instrument failure, not only the corrected conclusion.
- Leave the two operator troubleshooting rows pointing at causes that can actually produce their symptoms.
- State the evidence grade of every claim that survives, including the one that survives on a source read alone.

**Non-Goals:**

- No source change. `CLOSING_SHUTDOWN_REASONS` at `apps/plugin/.pi-plugin/index.ts:72` already contains `quit`, which is what the measured path emits, so the shipped client is already correct.
- Not measuring print mode. Three attempts failed their control today (D5); it is deferred and named, not quietly resolved.
- Not inverting the claim. A blanket "Ctrl-C closes the session" would be false for a single press, for print mode, inside an overlay, and under a rebound key.
- No mechanical guard against the phrase re-appearing (D4).

## Decisions

### D1 — `pi-plugin` is REMOVED + ADDED; `plugin-session-protocol` is a plain MODIFIED

The falsehood in `pi-plugin` is not only in a requirement body. Scenario `:271` is titled **`Ctrl-C is documented as lossy in both modes`**, and the title _is_ the false claim. A `MODIFIED` block cannot rename a published scenario title: `check-delta-freshness` reports every published scenario title absent from the delta as a hard failure, and `openspec archive` refuses the merge. The only mechanism that renames a scenario is `REMOVED` + `ADDED` of the whole requirement — and `openspec validate` rejects that pair unless the requirement header changes too.

So the header changes:

- **REMOVED**: `### Requirement: Session close is awaited, with the interrupt exception recorded`
- **ADDED**: `### Requirement: Session close is awaited, and each exit path is named with the evidence for it`

The new header is deliberately **count-free**. The old one implies a single exception; after this change there are three retained non-reaching paths of two different evidence grades, and a header that counts them would need renaming again the first time print mode is measured. The precedent for header-renaming-as-mechanism is `ground-session-summaries`, whose REMOVED block records the same reasoning for a handler count embedded in a header.

`plugin-session-protocol`'s falsehood is a paragraph (`spec.md:507`) inside `### Requirement: Sessions under the Pi client MUST converge on a non-null summary`, whose header and five scenarios are all correct. That is a plain `MODIFIED`.

**Rejected: keep the scenario title, contradict it in the body.** It avoids the REMOVED+ADDED ceremony and leaves a sentence in the published contract that says the opposite of the requirement containing it. A spec whose scenario title is false is worse than a missing scenario, because it is quotable.

**Rejected: fold both capabilities into one delta.** Delta specs pair per capability by construction (`check-spec-provenance`, `check-delta-freshness`), so this was never available; noted only because the two paragraphs say nearly the same thing and a reader may wonder why they are edited twice.

### D2 — Three qualifiers, all load-bearing

The replacement claim is: **two presses within 500 ms, in the interactive TUI with the prompt focused, on the default `app.clear` binding**, run the same awaited `shutdown()` Ctrl-D runs and emit `reason: "quit"`.

Each qualifier answers a way the sentence would otherwise be false:

1. **"twice, within 500 ms"** — `:3048`'s guard is `now - this.lastSigintTime < 500`. The 1500 ms arm measures the `else` branch landing at the EOF, so a single press, and two slow presses, close nothing.
2. **"in the interactive TUI, with the prompt focused"** — the handler binds to the default editor (`:2223`). Inside an overlay the key routes elsewhere, and that path is unmeasured.
3. **"the default binding"** — `dist/core/keybindings.js:8`; `app.clear` is user-rebindable, so the claim is about a default install.

Dropping any one produces a sentence that is overbroad in the opposite direction, which is the same failure mode being retracted — a narrow measurement stated broadly.

**Rejected: state it unqualified because the qualifiers are the common case.** That is precisely the reasoning that produced the original error.

### D3 — The troubleshooting rows keep their symptom and lose their cause; no replacement cause is invented

`apps/plugin/.pi-plugin/README.md:87` and `docs/agents.md:426` both attribute a real symptom to Ctrl-C. After the retraction a double Ctrl-C loses nothing, so the attribution is dead. The decision has two parts:

- **Re-attribute only to exits we have evidence for**: `SIGKILL` and host crashes (measured — `pi-plugin`'s SIGKILL control scenario), and print-mode SIGINT (source read, labelled as such per D5). Nothing else is asserted. Specifically, "the server was unreachable at teardown" is _not_ added: plausible, unmeasured, and a second invented cause would repeat the defect.
- **Correct `docs/agents.md:426`'s symptom too.** It reads "Session ends with no summary. You exited with Ctrl-C." An exit that reaches no handler does not end the session at all — the row stays `active` until `abandonStale` retires it as `abandoned` (`pi-plugin/spec.md:506`). So the bullet named a state its stated cause cannot produce, independently of the Ctrl-C error. The corrected symptom is the `active`-then-`abandoned` row with a summary one turn stale.

**Rejected: delete both rows.** The symptom is real and an operator meeting it needs somewhere to land; deleting the row trades a wrong answer for no answer, and the evidenced causes are enough to write a right one.

**Rejected: keep "exit with Ctrl-D" as the remedy.** Ctrl-D is still a clean exit and the e2e walkthrough still uses it, but presenting it as the _fix_ for the symptom implies the alternative loses data, which is the retracted claim wearing different clothes.

### D4 — The retraction is checked by a task, not by a permanent spec scenario

An acceptance grep — after this change, no Pi surface asserts "either mode" or "does not close" — is a good gate and belongs in `tasks.md`. It is deliberately **not** written into the spec as a scenario.

`pi-plugin/spec.md:402`'s `Scenario: No surface still claims four clients` is the precedent against it: it is a permanent phrase-grep obligation that returns 28 hits, nearly all legitimate, and every future run needs the same manual triage table `fix-stale-client-count-surfaces` had to write. A grep for "either mode" is worse, because the phrase is generic English that any unrelated sentence may legitimately use. What the spec asserts instead is what the documentation must **say**, which is checkable by reading the surfaces named in the requirement.

**Rejected: an invariant test over the doc surfaces.** Same objection, plus it would put a documentation-phrase assertion into `invariants.test.ts`, whose subject is code-level invariants.

### D5 — The print-mode claim survives on a source read, and says so

This is the uncomfortable part of the change and it is recorded rather than smoothed over.

The retained claim is that print mode never registers `SIGINT`: `dist/modes/print-mode.js:32-44` registers `["SIGTERM"]` plus `SIGHUP`, and grepping `SIGINT` in that file returns nothing. **That is a read, not a run.** Three attempts to execute it failed today, and each failed its control — the arm that must pass did not:

1. **Probe A** — the process exited before the signal landed: markers at ~190 ms against a signal sent at 4 s. Nothing about the handler was observed.
2. **Probe B** — a hold in `before_agent_start` suppressed the handler entirely, so even the SIGTERM control wrote nothing. A run in which the _passing_ arm is silent measures the probe, not the subject.
3. **Probe C** — holding stdin open kept the process alive, but no arm wrote a marker at all, most likely because `-p` with no prompt never starts a session.

So the print-mode claim sits inside a change whose entire content is a source read overturned by a run. Two honest options were available: drop the claim, or retain it with its evidence grade stated. Retaining it is chosen — the read is specific, cites a line, and is consistent with the file having no `SIGINT` reference at all — and **the spec text names it as a read**, so the next person to touch it knows which claims in this requirement are executed and which are not. That labelling is the point of the new requirement header (D1).

**Rejected: drop the print-mode sentence.** It would silently narrow the contract on no evidence, which is the mirror image of the error being retracted.

**Rejected: assert it as measured because the read is convincing.** This change exists because a convincing read was published as a measurement.

Measuring print mode is deferred, with the three failed instruments named so the next attempt does not re-run them (tasks §6, OQ1).

### D6 — The Purpose line is corrected in the archive commit, not the apply commit

`openspec/specs/pi-plugin/spec.md:9` carries the falsehood in Purpose prose, outside any requirement. `openspec archive` merges requirement blocks, so no delta reaches it; it must be hand-edited.

`check:spec-provenance` pairs every touched `openspec/specs/<cap>/spec.md` against an **archive delta arrival** for the same capability in the same range (`scripts/check-spec-provenance.mjs::checkProvenance`). The archive commit for this change moves `specs/pi-plugin/spec.md` into `openspec/changes/archive/`, which is exactly that arrival — so making the Purpose edit **in the archive commit** satisfies the check with no waiver, while making it during apply would need one.

**Fallback, not preference**: if the line must land earlier, a `Spec-Provenance-Exempt: <reason>` trailer in the final paragraph of the commit message waives it. Recorded as a fallback because a waiver in a change _about_ publishing unverified claims is a bad look, and unnecessary here.

### D7 — The one-turn bound survives, but its antecedent set shrinks

`pi-plugin/spec.md:237` ends "The per-turn flush bounds the loss at one turn." The bound itself is unaffected — it is the same guarantee `plugin-session-protocol`'s SIGKILL scenario already states ("convergence SHALL rest on the last per-turn flush, so the stored summary SHALL lag by at most one turn"). What changes is **what it is a bound on**: no longer interactive Ctrl-C, only SIGKILL/crash, print-mode SIGINT, and a single press followed by a kill.

Two consequences for the wording, both taken:

- The sentence must not be left attached to "Ctrl-C", or it reads as conceding a loss that does not occur.
- The bound is about **summary content only**. It says nothing about `status`: a session whose process reached no handler stays `active` until the stale-active sweep flips it to `abandoned`, and no flush changes that. Stating the bound without that qualifier is how `docs/agents.md:426` ended up describing a session that "ends with no summary" (D3).

## Risks / Trade-offs

- **[Risk] The replacement wording is overbroad in the other direction, and an operator concludes Ctrl-C is always safe.** A single press, a rebound key, an overlay, or print mode all break it → Mitigation: D2's three qualifiers appear in the requirement, in both operator surfaces, and in the skill gotcha, and the new scenario asserts explicitly that the docs SHALL NOT claim a single press exits.
- **[Trade-off] A retained claim (print mode) rests on a read inside a change that exists because a read was wrong.** → Accepted because the alternative is silently dropping a specific, line-cited claim on no evidence; the mitigation is that the spec labels it a read and OQ1 carries the measurement, so the asymmetry is visible rather than laundered.
- **[Risk] `check-delta-freshness` cannot protect the five carried scenarios.** It reads only the requirement body **before the first scenario** and matches scenarios **by title alone** (`scripts/check-delta-freshness.mjs:44-50`) — and it only inspects `## MODIFIED Requirements`, so an ADDED block is outside its remit entirely. A carried scenario could be silently reworded and every check would stay green → Mitigation: tasks §4.2 requires a hand `diff` of the five carried scenario blocks against the published spec, proving byte-identity. This is a required step, not a formality; nothing automated covers it.
- **[Risk] The npm gallery card stays wrong after merge.** The README correction only reaches npm when the unified `plugin` component releases → Mitigation: stated in Impact and in tasks §5, so it is a known wait rather than a discovery at release time. No server image is rebuilt either way (`publish-docker` gates on `server_release_created`).
- **[Trade-off] No mechanical guard stops the phrase returning.** → Accepted per D4; the four-clients grep is the counter-example showing what the permanent version costs.
- **[Risk] The measurement is pinned to Pi 0.84.1, and the 500 ms window is an implementation detail of a dependency we do not control.** A future Pi could change or remove it → Mitigation: the requirement cites the version and the source line, so a reader can tell whether it still applies; and the failure mode of a changed window is a stale doc, not a broken client, because the end-set already accepts `quit` however it is produced.

## Migration Plan

Nothing to migrate. No schema, no data, no derived tables, no client behaviour, no version gate: the change is entirely in specs and documentation, and `apps/plugin/.pi-plugin/index.ts` is untouched. Existing installations are unaffected on upgrade and rollback is a `git revert`.

The only sequencing constraint is D6: the `pi-plugin` Purpose edit lands in the archive commit so `check:spec-provenance` pairs it. The only externally visible effect is the `@rembric/pi` republish that corrects the npm gallery card, which happens on the next `plugin` release.

## Open Questions

- **OQ1 — Does print-mode SIGINT actually reach no handler?** Retained on a source read (D5). Three instruments failed today: exit-before-signal, a `before_agent_start` hold that suppressed even the SIGTERM control, and a stdin-held run where `-p` with no prompt appears never to start a session. The next attempt needs a print-mode invocation that provably starts a session (a control arm that writes a marker on clean exit) before any signal arm means anything. **Default while unresolved: the claim stands as written and labelled.** Deferred to tasks §6, not blocking.
- **OQ2 — Does Ctrl-C reach the handler while an overlay is focused?** Unmeasured, and D2 excludes it by qualifier rather than by claim. No default is asserted in either direction, because both directions are guesses. Listed so a later reader knows the gap is deliberate.
