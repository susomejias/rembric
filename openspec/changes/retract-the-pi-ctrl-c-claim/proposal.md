# Retract the published claim that Ctrl-C never closes a Pi session

## Why

Six shipped surfaces — two published specs, the npm gallery card for `@rembric/pi`, `docs/agents.md`, and two skill references — state that Ctrl-C does not fire Pi's session-shutdown handler **in either mode**. In the interactive TUI that is false, and it was published with a measurement attached, which is the expensive kind of wrong.

Measured against Pi 0.84.1 under `script -q` with timed stdin, `HOME` redirected to a scratch dir, no network and no Rembric server, with a five-line extension appending `Date.now()-t0` and the event's `reason` on `session_shutdown`:

| Arm                                        | `session_shutdown` fired at | Reason |
| ------------------------------------------ | --------------------------- | ------ |
| No keys at all (baseline — stdin EOF only) | 10577 ms                    | `quit` |
| **Two Ctrl-C 200 ms apart**                | **5809 ms**                 | `quit` |
| Two Ctrl-C 1500 ms apart                   | 11839 ms                    | `quit` |

The 200 ms arm fires ~4.8 s **before** anything the baseline can produce, so only the key can explain it. The 1500 ms arm — two independent single presses — lands at the EOF, so a single press still does not close. The table checks itself: 11839 − 10577 = 1262 ms ≈ the 1300 ms of extra key spacing.

The mechanism is in the installed source. `dist/modes/interactive/interactive-mode.js:3048-3056`: `handleCtrlC()` calls `void this.shutdown()` when `now - this.lastSigintTime < 500`, and otherwise clears the editor and arms the window. `handleCtrlD()` at `:3059` is the same `void this.shutdown()`. `shutdown()` at `:3100` awaits `runtimeHost.dispose()` before `process.exit(0)`, and Pi's own comment at `:3089` reads "Interactive quit (Ctrl+D, Ctrl+C, /quit, extension shutdown())". Pi advertises it in its startup banner — `:667`, `rawKeyHint(\`${keyText("app.clear")} twice\`, "to exit")`. **Our documentation contradicts the product's own on-screen UI**, which is how an operator meets this claim: the banner says the key exits, our README says it loses the session.

The consequential surfaces are the two troubleshooting rows. `apps/plugin/.pi-plugin/README.md:87` attributes "the last turn is missing from the dashboard summary" to "the session was ended with Ctrl-C"; `docs/agents.md:426` says the same. After the retraction a double Ctrl-C loses **nothing**, so both point an operator at a cause that cannot produce the symptom they are debugging — and the README one is live on npm as `@rembric/pi`'s gallery card, the package's only discovery path (`pi-plugin/spec.md:9`).

`reason` never could have discriminated: all three arms report `quit`, because the EOF exit and the Ctrl-C exit both terminate through `runtimeHost.dispose()`. A probe asserting `reason === 'quit'`, or merely that a marker appeared, passes on every arm. Only elapsed time discriminates — the first attempt at today's re-measurement asserted marker-presence and "confirmed" the falsehood before the timing arms overturned it.

## What Changes

- **The interactive-TUI claim is narrowed, not inverted.** What may now be asserted: **two presses within 500 ms**, **in the interactive TUI with the prompt focused**, **on the default `app.clear` binding**, run the same awaited `shutdown()` that Ctrl-D runs and emit `reason: "quit"` — already in the client's end-set (`apps/plugin/.pi-plugin/index.ts:72`), so the session ends correctly with **no code change**. All three qualifiers are load-bearing; dropping any of them makes the new wording overbroad in the opposite direction (design D2).
- **Four claims are explicitly retained.** That a _single_ Ctrl-C closes nothing; that print-mode SIGINT reaches no handler; that SIGKILL runs nothing; and that no requirement asserts every Pi session reaches a terminal status (`pi-plugin/spec.md:506`). The interrupt exception still exists — it is smaller than published, not absent.
- **The print-mode retention is labelled as a source read, not a measurement.** Three attempts to execute it failed their controls (design D5). Inside a change whose entire content is a read overturned by a run, presenting an unexecuted read as measured evidence would repeat the defect being retracted. Measuring print mode is deferred, named, and listed in tasks §6 rather than quietly dropped.
- **Both troubleshooting rows lose their false cause.** They keep the symptom and re-attribute it to the exits that actually reach no handler; they do not gain an invented replacement cause (design D3). `docs/agents.md:426`'s symptom wording is corrected too — an exit that reaches no handler leaves the row `active`, so "session ends with no summary" was already describing a state that exit cannot produce.
- **`pi-plugin` is REMOVED + ADDED; `plugin-session-protocol` is a plain MODIFIED.** The falsehood in `pi-plugin` is a _scenario title_ (`:271`, "Ctrl-C is documented as lossy in both modes"), and a `MODIFIED` block cannot rename a published scenario title — `check-delta-freshness` reports the loss and `openspec archive` refuses. `REMOVED` + `ADDED` is the mechanism, and `openspec validate` rejects it unless the requirement header changes too, so the header changes as well (design D1). Rejected: keeping the scenario title and writing a contradicting body, which leaves a false sentence in the published contract.
- **No acceptance grep is written into the spec.** The retraction's checkability lives in a task, not in a permanent scenario (design D4). Rejected on the same ground `fix-stale-client-count-surfaces` recorded: `pi-plugin/spec.md:402`'s four-clients grep is still generating manual triage, and a phrase-grep for "either mode" would red on any unrelated legitimate use.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `pi-plugin`: **REMOVED + ADDED.** `### Requirement: Session close is awaited, with the interrupt exception recorded` is replaced by `### Requirement: Session close is awaited, and each exit path is named with the evidence for it`. Five scenarios carry through byte-identical; the sixth (`Ctrl-C is documented as lossy in both modes`) is replaced by one whose title is not itself a false claim.
- `plugin-session-protocol`: **MODIFIED.** `### Requirement: Sessions under the Pi client MUST converge on a non-null summary` — the "One documented exception" paragraph (`spec.md:507`) is rewritten. Header and all five scenarios unchanged.

## Impact

**No source change, no schema change, no migration, no MCP tool added or removed, and no load-bearing invariant touched.** The end-set at `apps/plugin/.pi-plugin/index.ts:72` already contains `quit`, which is what the measured Ctrl-C path emits, so the shipped client is correct as-is — this change corrects only what we say about it.

Documentation and spec surfaces, all edited during apply:

| Surface                                                                         | What is wrong there                                                   |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `openspec/specs/pi-plugin/spec.md:235,237,271,274`                              | carried by the `pi-plugin` delta (REMOVED + ADDED)                    |
| `openspec/specs/pi-plugin/spec.md:9`                                            | **Purpose prose — outside any requirement, so no delta reaches it**   |
| `openspec/specs/plugin-session-protocol/spec.md:507`                            | carried by the `plugin-session-protocol` delta (MODIFIED)             |
| `apps/plugin/.pi-plugin/README.md:87,108,110,112`                               | troubleshooting row + the "Ctrl-C does not close the session" section |
| `docs/agents.md:409,419,426`                                                    | heading, the "in either mode" paragraph, troubleshooting bullet       |
| `.agents/skills/rembric-plugin-development/SKILL.md:35`                         | "Ctrl-C fires nothing in either mode"                                 |
| `.agents/skills/rembric-plugin-development/references/per-client-gotchas.md:44` | the full false gotcha, measurement included                           |
| `.agents/skills/rembric-plugin-development/references/e2e-walkthrough.md:141`   | procedure stays (Ctrl-D still works); only its parenthetical is false |

`openspec/specs/pi-plugin/spec.md:9` is the one surface the delta mechanism cannot carry: it is Purpose prose, not a requirement, and `openspec archive` merges requirement blocks only. A hand edit to a published spec is gated by `check:spec-provenance`, which pairs each touched capability against an archive delta **arrival** in the same range (`scripts/check-spec-provenance.mjs::checkProvenance`). It therefore belongs in the **archive** commit, where moving this change's `pi-plugin` delta into `openspec/changes/archive/` supplies exactly that pairing and no waiver is needed. `Spec-Provenance-Exempt:` is the fallback only if the line must land in the apply PR (design D6).

**`apps/plugin/.pi-plugin/README.md` is a version carrier's payload.** Touching anything under `apps/plugin/` bumps the unified `plugin` release-please component and republishes `@rembric/pi` — and that republish is **the only way the npm gallery card gets corrected**. The correction therefore ships on a plugin release, not on merge, and no server image is rebuilt (`publish-docker` gates on `server_release_created`).

`docs/agents.md` and `.pi-plugin/README.md` are distribution docs, so the `rembric-tui-installer` contract applies by path. Nothing here touches `install.sh`, a per-client installer, `marketplace.json` or any install instruction, so the installer e2e playbook is not triggered — stated so the applier does not have to decide it silently.
