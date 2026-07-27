## Why

Three defects in the deterministic entity index are confirmed indexed in production (0.24.13), and all three degrade the mechanism's only value proposition: that an entity lookup is an _exact address_, not a bad text search.

**The bare-dotfile branch of `PATH_RE` extracts prose as paths.** Reproduced against the real extractor:

| input                               | extracted                          |
| ----------------------------------- | ---------------------------------- |
| `the .length property is undefined` | `[{kind:'path', value:'.length'}]` |
| `run the .sql migrations by hand`   | `[{kind:'path', value:'.sql'}]`    |
| `spawn returns a .child handle`     | `[{kind:'path', value:'.child'}]`  |
| `the .HERMES marker is written`     | `[{kind:'path', value:'.HERMES'}]` |

The control proves these are prose, not truncated paths: `wrote to .HERMES/config` yields `[]`, because a following `/` fails the branch's lookahead. So the branch fires _only_ when there is no path there.

`.HERMES` is the argument that makes this urgent, because it is **systematic rather than incidental**. `.HERMES · HH:MM UTC` is the generic placeholder session title Rembric's own session bookkeeping mints (`computePlaceholderTitle`, recorded in `archive/2026-07-13-strengthen-curation-nudge-compliance/design.md:10`), emitted on every Hermes session that never fires `on_session_end` — which in practice is most of them. Rembric is therefore manufacturing its own false path entity, at a rate proportional to Hermes usage, and `.sql` / `.length` / `.child` are the same class arriving from ordinary engineering prose. A polluted `path` index is exactly what `memory-entities/spec.md:34` forbids and what `archive/2026-07-25-add-entity-index/design.md:25` says is not recoverable once the index is polluted.

**`MAX_ENTITIES = 250` starves later rules.** The cap is enforced inside the rule loop with an early `return`, and `path` is the 2nd of 15 rules. Reproduced: 400 synthetic `node_modules/pkgN/dist/index.js` lines followed by a tail containing a real ticket, errno, env var, git ref and hostname yields 250 entities whose kinds are `['path']` only. The same tail alone yields all five kinds. Five kinds are silently lost, and the loss is indistinguishable from "the memory mentions none of them" — the failure mode the whole index is supposed to remove. The cap has **no test coverage at all**, which is why it shipped. Worse, `extractor-rules.ts:228-231` asserts "Order is presentation-only: dedup is keyed `kind:value`, so no rule masks another" — that comment is **false** under the cap. Registry order is load-bearing today, and a contributor reordering the registry on that comment's authority would change extraction semantics.

**A failed wipe leaves the marker asserting a recipe the index does not hold.** `memory-entities/spec.md:241` takes marker-before-wipe as its explicit premise and prescribes two mitigations; both are already implemented (the wipe is one transaction at `entity-state.ts:45-47`, and `memory_entity_scan` is cleared first at `entities-repository.ts:482-486`), so the partial-wipe hole is closed. What is still violated is the second clause of scenario `:259-262`: "and the drain SHALL still see the corpus as unscanned". On a rolled-back transaction the scan rows are _restored_, so the drain sees the corpus as scanned, the operator-visible backlog reads zero, and nothing ever re-checks — while `entity-state.json` already asserts the new recipe. `entity-state.test.ts:110-132` tests only the first clause. This matters most right now: the version bump is the entire remediation mechanism for the first two defects, so the reset path must be sound before it fires.

## What Changes

- **Restrict the bare-dotted-token path branch to a closed list of known dotfile _names_**, declared in the rule registry so it is inspectable. A dotted token whose remainder is merely a recognised file _extension_ is not an address: `.sql` is a file type and `.length` is a property access. The alternative — allowing any token whose remainder is in `PATH_EXT` — is rejected because it is a trap: `sql` is already in `PATH_EXT` (`extractor-rules.ts:36`), so an extension-based allowlist would keep `.sql`. This half needs no new requirement; it is conformance with three existing ones (`memory-entities/spec.md:13`, `:34`, and scenario `:51-54`).
- **Reallocate the per-memory entity budget so no single kind can exhaust it.** The cap's _value_ stays 250 — there is no measurement to justify moving it — and only its allocation changes, to a max-min fair share with a per-rule collection ceiling. Rejected: a fixed equal per-rule share (`ceil(250/15) = 17`), which would cap a genuine 300-path dump at 17 paths and regress the common case. The cap's _existence_ is entirely absent from all 310 lines of `memory-entities/spec.md`, so it is undocumented shipped behaviour: the requirement has to state that a bound exists before it can state that the bound is fair. **Correct the false registry-order comment** in the same commit, and make it true by asserting that permuting `EXTRACTOR_RULES` does not change the extracted set.
- **Make the recipe marker two-phase**: `{extractorVersion, pending: true}` written before the wipe, flipped to `pending: false` after the wipe commits; a marker still marked pending is treated as a mismatch, so the reset re-fires. Rejected: a DB-resident marker, which would need a new table plus a migration — there is no kv/settings/meta table anywhere in `apps/server/src/db/schema/` — for a guarantee a second file write already provides. Conformance fix; no new requirement.
- **Resolve a self-contradiction the spec currently carries for `env_var`.** `:15` mandates that `$`-anchored tokens are typed `env_var`; `:34` forbids extracting prose that resembles an entity; `$MRR` (a currency sigil, not a shell variable) satisfies both. The delta states that the anchor requirement dominates for `env_var` and records the currency-sigil false positive as accepted. Rejected: requiring an underscore, which would kill `$MRR` but also `$PATH`, `$HOME`, `$PWD`, `$SHELL` and `$EDITOR`, needing a closed name list — real maintenance surface for one bogus row.
- **Record `ticket: '#4'` / `'#5'` as an accepted documented ambiguity**, alongside `git_ref`'s `accede1` and `systemd_unit`'s `user.service`. The spec already publishes `#36` as a legitimate ticket form and already measures it at 50% noise (`:73`); a digit floor would lose real single-digit issues.
- **All three land as ONE change behind ONE `EXTRACTOR_VERSION` bump.** Separate releases would cost two full corpus rebuilds for nothing, and landing the marker fix with the bump means the corrected reset path and the new recipe reach the operator in the same deploy.
- **Not in scope**: no change to the published lexical-noise table (`spec.md:68-81`), which governs _admitting_ a kind rather than tightening an existing pattern; no new entity kind; no change to `MAX_ENTITIES`'s value; no measurement harness (all three defects are deterministic and unit-testable).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `memory-entities`: adds a requirement bounding entities per memory and forbidding one kind from consuming the whole bound (the cap is currently unspecified); adds a requirement that a bare dotted token is a path only by closed dotfile-name membership, not by extension; adds a requirement that an observed false extraction must enter the zero-tolerance prose corpus as a test, not as prose; and modifies the determinism/precision requirement to resolve the `env_var` anchor-versus-prose contradiction and to list the accepted documented ambiguities.

## Impact

Affected code:

- `apps/server/src/services/extractor-rules.ts` — the bare-dotted-token alternative in `PATH_RE` (`:42`), a new closed dotfile-name list declared beside it, and the false order comment at `:228-231`.
- `apps/server/src/services/entities.ts` — `EXTRACTOR_VERSION` (`:25`, bumped once) and the budget allocation in `extractEntities` (`MAX_ENTITIES` at `:37`, enforced at `:55`).
- `apps/server/src/services/entity-state.ts` — `readMarker` / `ensureEntityExtractor` two-phase marker; `resetEntityIndex` unchanged.
- Tests: `apps/server/src/services/entities.test.ts` (the zero-tolerance fixture at `:119`, plus first-ever coverage for the cap), `apps/server/src/services/extractor-rules.test.ts` (regression guard on `.rembric` at `:263` and `.claude/settings.local.json` at `:271`), `apps/server/src/services/entity-state.test.ts` (both clauses of scenario `:259-262`).

Not affected, deliberately:

- **No migration.** No schema change; `entity-state.json` is a data-dir file, not a table.
- **No `memory` row is touched.** The three entity tables plus `memory_fts` and `memory_vec` stay regenerable from `memory` alone — the derived-index invariant is what licenses the rebuild.
- **No new MCP tool**, no dashboard change, and **zero plugin-tree impact** (all four clients unaffected).
- **No SQL outside `apps/server/src/db/`**; `truncateAll` already exists and is unchanged.
- `apps/server/src/test/entity-noise/` is untouched: despite the name it measures FTS5 noise per identifier class, not extractor precision, and would not have caught any of this.

Existing installations: the first boot after upgrade detects the version mismatch, truncates all three entity tables (so bogus rows are _deleted_, not merely unlinked), and the self-pacing drain re-links from `memory` with no operator action — see `design.md` D5. Rollback to 0.24.13 re-fires the same reset in the opposite direction and re-mints the bogus entities; it is safe, not lossless.
