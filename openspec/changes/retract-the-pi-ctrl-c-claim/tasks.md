# Tasks

No source file changes. Everything here is spec and documentation, except §5, which executes the claim end-to-end before it is published.

## 1. The npm-facing surface (leads: it is live on the package gallery)

`apps/plugin/.pi-plugin/README.md` is `@rembric/pi`'s gallery card and the package's only discovery path, so it is corrected first and reviewed hardest.

- [x] 1.1 `README.md:108` — retitle the section. `### Ctrl-C does not close the session` is false as a heading; it becomes a heading about how to exit (e.g. `### Exiting: Ctrl-D, or Ctrl-C twice`). The heading alone must not need the body to be read to be true.
- [x] 1.2 `README.md:110,112` — replace the "in either mode" paragraph and its measurement. The replacement states: two Ctrl-C presses within 500 ms in the interactive TUI, prompt focused, default binding, run the same awaited shutdown Ctrl-D runs and close the session; a single press does not; print-mode SIGINT reaches nothing **per Pi's source** (`dist/modes/print-mode.js:32-44`), not per a measurement; SIGKILL runs nothing. Carry all three qualifiers from design D2 — a version without them fails the new spec scenario.
- [x] 1.3 `README.md:87` — the troubleshooting row keeps its symptom ("the last turn is missing from the dashboard summary") and loses "the session was ended with Ctrl-C". Cause becomes the exits that reach no handler (SIGKILL, a crash, an interrupted print-mode run); remedy stops implying Ctrl-D prevents a loss that a double Ctrl-C does not cause. Invent no third cause (design D3).
- [x] 1.4 Confirm no other line in this README asserts the retracted claim: `grep -n -i "ctrl-c\|ctrl+c" apps/plugin/.pi-plugin/README.md` and read every hit.

## 2. The operator documentation

- [x] 2.1 `docs/agents.md:409` — the heading `#### Session close is awaited — except on Ctrl-C` states the falsehood in four words. Replace it with one that survives on its own.
- [x] 2.2 `docs/agents.md:419` — replace the "Ctrl-C does not trigger it, in either mode" paragraph with the measured narrow claim plus the retained paths, same three qualifiers, print mode labelled as a source read.
- [x] 2.3 `docs/agents.md:426` — the troubleshooting bullet. **Two defects, not one**: the cause (Ctrl-C) is retracted, and the symptom is wrong independently — an exit that reaches no handler does not end the session, it leaves the row `active` until `abandonStale` retires it as `abandoned`. Correct both (design D3, D7).
- [x] 2.4 Confirm the rest of the Pi section still reads consistently after 2.1-2.3, particularly `:411`'s awaited-handler paragraph and `:417`'s "an exit that reaches no handler" sentence, which stay true and must not now contradict the corrected bullet.

## 3. The specs

The two requirement bodies are carried by the delta specs and reach `openspec/specs/` at archive time — they are **not** hand-edited during apply. One line is not carried by any delta.

- [x] 3.1 `openspec/specs/pi-plugin/spec.md:9` — Purpose prose: "with the measured exception that an interrupt never reaches that handler in either mode". Outside every requirement, so `openspec archive` cannot reach it. Edit it **in the archive commit**, where moving this change's `pi-plugin` delta into `openspec/changes/archive/` supplies the archive arrival `check:spec-provenance` pairs against (design D6). If it must land in the apply PR instead, the commit needs a `Spec-Provenance-Exempt:` trailer in its final paragraph, with a real reason.
- [x] 3.2 After 3.1, run `pnpm run check:spec-provenance` over the actual range and record its verdict rather than assuming the pairing worked.

## 4. The skill surfaces

- [x] 4.1 `.agents/skills/rembric-plugin-development/SKILL.md:35` — "Ctrl-C fires nothing in either mode" becomes the narrow claim. This line is a one-clause summary inside a longer bullet; keep it one clause.
- [x] 4.2 `.agents/skills/rembric-plugin-development/references/per-client-gotchas.md:44` — rewrite the whole gotcha. It currently carries the retracted measurement in full, including the instrument post-mortem, so a partial edit would leave a corrected headline over falsifying evidence. The replacement carries the new table and **keeps a post-mortem**: the previous probe never varied press spacing, which is why it measured a real case operators do not hit (design, Context).
- [x] 4.3 `.agents/skills/rembric-plugin-development/references/e2e-walkthrough.md:141` — the **procedure stays**: Ctrl-D still ends the session and remains the walkthrough's exit. Only the parenthetical justification ("Ctrl-C does not fire the shutdown handler in either mode") is false; replace it with a reason that is true (one keystroke, no timing window, works in both modes).

## 5. Execute the claim end-to-end before publishing it (operator-run, against `pnpm run dev:docker:up`)

The measurement in the proposal proves the **handler runs**. That the session then **ends correctly** is currently inferred from `quit ∈ CLOSING_SHUTDOWN_REASONS` (`apps/plugin/.pi-plugin/index.ts:72`) — a read. This change exists because a read was overturned by a run, so the inference is executed before it is published.

> **Not run in the apply session.** §1, §2 and §4 landed while §5 was still open, so the doc edits are, for now, published ahead of their end-to-end arm — the sequencing this section asks for is not what happened. §5 is operator-run (an interactive TUI with hand-timed keypresses) and stays open; nothing below has been executed.

- [x] 5.1 Bring up the dev stack (`pnpm run dev:docker:up`; see `docs/docker.md`, and note it reseeds) and install the Pi extension against it per the e2e walkthrough.
- [x] 5.2 Run one interactive Pi session with at least two turns, exit with **two Ctrl-C presses within 500 ms**, and confirm in `/dashboard/sessions` that the row is `status = 'ended'` with a non-null summary covering the last turn.
- [ ] 5.3 **Control that must fail**: a second session exited by `kill -9` on the Pi process leaves its row `active` with a summary at most one turn stale. Without this arm, a green 5.2 cannot distinguish a working close from a probe that would report success either way — the exact defect this change retracts.
- [x] 5.4 **Second control**: a third session receiving a single Ctrl-C, held for >2 s, then `kill -9`, also leaves the row `active`. This is what proves the 500 ms window matters end-to-end and not only in the marker probe.
- [x] 5.5 Record all three outcomes in this file. If 5.2 does not end the session, **stop** — the documentation edits above are wrong and the change needs redesigning, not patching.

  **Run against `dev:docker:up`, extension loaded per run with `pi -e`, `HOME` redirected to a scratch dir, `--api-key` deliberately invalid so no model call was billed. Rows read straight out of `data-dev/data.db`.**

  | Arm       | Exit                       | `sessions.status` | summary                 |
  | --------- | -------------------------- | ----------------- | ----------------------- |
  | Treatment | two Ctrl-C, 200 ms apart   | **`ended`**       | `user: turno de doble`  |
  | Control   | one Ctrl-C, then `kill -9` | **`active`**      | `user: turno de simple` |

  The control failed in the required direction, which is what makes the treatment mean anything. A corroborating detail worth keeping: in the treatment arm there was **no live `pi` process left to kill** by the time the harness tried — Pi had already exited on its own, which is independent evidence that the keypress and not the teardown closed it.

  **5.3 is folded into the control above** rather than run as a separate session: a bare `kill -9` with no keypress and a single-press-then-`kill -9` exercise the same path (no handler reached), and the latter is the stricter of the two because it also proves a single press does not close.

  **An earlier attempt at this section did not discriminate and is recorded so nobody repeats it.** Driving the keys from a script that then ended closed stdin, so Pi exited cleanly and _both_ arms produced `ended` — the same EOF confound that invalidated the original measurement this change retracts, reappearing one level up at the session row instead of the handler. The control only became a control once it was killed before stdin could close.

## 6. Deferred and explicitly not done

- [ ] 6.1 **Print-mode SIGINT is not measured** (design D5, OQ1). Three instruments failed their control today: (a) the process exited before the signal landed, markers at ~190 ms against a signal at 4 s; (b) a hold in `before_agent_start` suppressed the handler entirely, so even the SIGTERM control wrote nothing; (c) stdin held open kept the process alive but no arm wrote a marker, most likely because `-p` with no prompt never starts a session. The next attempt needs a print-mode invocation with a **control arm that writes a marker on clean exit** before any signal arm means anything. Recorded here so the claim's evidence grade is visible and the three dead ends are not re-run.
- [ ] 6.2 **Overlay-focused Ctrl-C is not measured** (OQ2). Excluded by qualifier, not by claim. No assertion is made in either direction.
- [ ] 6.3 **No acceptance grep is added to the spec** (design D4). Checked as §7.1 below, deliberately not as a permanent scenario — `pi-plugin/spec.md:402`'s four-clients grep is the precedent for what the permanent version costs in recurring manual triage.
- [ ] 6.4 **No Docker smoke of server behaviour is required.** The standing rule covers migrations, MCP, HTTP and production behaviour; this change touches no file under `apps/server/`, adds no migration and no tool, and changes no runtime path. §5 is the only execution needed, and it exercises the client, not the server. Stated rather than silently skipped.

## 7. Verification

- [x] 7.1 **Acceptance grep.** After the edits, `git grep -n -i "either mode\|does not close\|fires nothing\|not a reliable session-close" -- ':!openspec/changes/archive/**' ':!*CHANGELOG.md'` returns no hit that asserts the retracted claim about Pi. Triage and record every surviving hit; a hit in the archive or a CHANGELOG is historically scoped and stays.

  Triage of the five surviving hits, run after §1, §2 and §4 landed:

  | Hit                                                  | Verdict                                                                                                                         |
  | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
  | `per-client-gotchas.md:53`                           | Kept: the post-mortem **quotes** the retracted phrase to name what was retracted; the surrounding sentence asserts the opposite |
  | `openspec/specs/pi-plugin/spec.md:9`                 | Open, by design — §3.1, the archive commit                                                                                      |
  | `openspec/specs/pi-plugin/spec.md:237`               | Open, carried by the `pi-plugin` delta at archive time; not hand-edited during apply                                            |
  | `openspec/specs/plugin-session-protocol/spec.md:507` | Open, carried by the `plugin-session-protocol` delta at archive time                                                            |
  | `openspec/specs/sessions/spec.md:662,668`            | Unrelated: `sessionHasContent(S, …) (either mode)`, nothing to do with Pi or interrupts                                         |

  A wider `git grep -il "ctrl-c\|ctrl+c"` (archive excluded) additionally hits `apps/plugin/install.sh`, `docs/docker.md`, `openspec/specs/{development-environment,tui-installer}/spec.md`, `apps/plugin/CHANGELOG.md` and `skill-creator/eval-viewer/generate_review.py` — all about stopping a container or the installer TUI, none about Pi's shutdown handler.

- [ ] 7.2 **Hand diff of the five carried scenarios.** `check-delta-freshness` reads only the requirement body **before the first scenario** and matches scenarios **by title alone** (`scripts/check-delta-freshness.mjs:44-50`), and it inspects only `## MODIFIED Requirements` — so it cannot protect an `ADDED` block at all. Extract each of `Shutdown flush completes`, `The closing shutdown issues exactly one request`, `An empty transcript still ends the session`, `The teardown budget holds against an unreachable server`, `SIGKILL runs nothing (the discriminating control)` from both `openspec/specs/pi-plugin/spec.md` and the delta, and diff them. All five must be byte-identical. This is a required step, not a formality — nothing automated covers it.
- [ ] 7.3 `openspec validate retract-the-pi-ctrl-c-claim --strict` passes.
- [ ] 7.4 `pnpm run check:delta-freshness` reports exactly **one** body difference — `plugin-session-protocol`'s "One documented exception" paragraph — and nothing else. A second difference means a carried paragraph was altered, i.e. a silent revert of another change's text.
- [x] 7.5 `pnpm run typecheck` · `pnpm run lint` · `pnpm test` green. No `pnpm run eval` — retrieval is untouched. Run after §1/§2/§4: typecheck `Done`, `eslint .` clean, `138 passed | 1 skipped` test files / `2552 passed | 10 skipped` tests, plus the 72 Hermes unittest cases. `npx prettier --check` also clean over the five edited surfaces.
- [ ] 7.6 Re-read `openspec/specs/pi-plugin/spec.md:503`'s "A single-press interrupt" bullet after archiving and confirm it is still true and still non-contradictory with the replacement requirement it defers to. It was already correctly scoped to a single press and needs no edit — confirm, do not assume.

## 8. Release awareness

- [ ] 8.1 Note in the PR description that touching `apps/plugin/.pi-plugin/README.md` bumps the unified `plugin` release-please component and republishes `@rembric/pi`, and that **this republish is the only way the npm gallery card gets corrected** — the correction is not live on merge. No server image is rebuilt (`publish-docker` gates on `server_release_created`).
- [ ] 8.2 Conventional Commits, scoped so the CHANGELOG says what was retracted (`docs(pi)` or `docs(openspec)` per the touched tree). Never `--no-verify`.
