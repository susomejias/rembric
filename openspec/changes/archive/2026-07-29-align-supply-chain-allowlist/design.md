## Context

`.npmrc:4` sets `ignore-scripts=true`, so no dependency lifecycle script runs unless `pnpm-workspace.yaml::allowBuilds` says otherwise. That map is the repo's whole install-time code-execution surface. Its current shape, verbatim (`pnpm-workspace.yaml:14-21`):

```yaml
allowBuilds:
  husky: true # registers git hooks via prepare
  better-sqlite3: true # native binding postinstall fetches prebuilt
  sqlite-vec: true # native binding postinstall fetches prebuilt
  esbuild: false # transitive of vitest; explicitly DENY (no native binary needed at install time)
  onnxruntime-node: true # native binding postinstall validates/places prebuilt (in-process embedder)
  sharp: false # transitive of @huggingface/transformers; vision-only, never loaded by text pipelines — DENY
  protobufjs: false # transitive of onnxruntime; postinstall only writes version aliases — DENY
```

Two published specs enumerate a four-entry subset of this and one of them adds a false universal ("These three are the only third-party lifecycle scripts the repo permits to run", `development-environment/spec.md:295`). The proposal measures the divergence and its 54-day / 42-release lifetime.

Constraints this design has to respect:

- **No new dependency.** There is no YAML parser in the tree (`grep '"yaml"\|js-yaml' package.json apps/server/package.json` → nothing), and adding one to fix a supply-chain documentation bug would be self-parodying: it would route through `.agents/skills/npm-security-best-practices/` and enlarge the very surface under audit.
- **`pnpm test` must run on a source tarball with no `.git` and on a shallow clone.** This is why `2026-07-28-enforce-spec-archive-provenance` put its diff-based rule in `scripts/` and not in `invariants.test.ts` (its D1/D5). The rule here is the opposite shape — a property of the working tree — so the same reasoning lands it in `invariants.test.ts`.
- **`invariants.test.ts` already reads repo-root non-TS files** via `repoRoot` (`:286`): `apps/server/Dockerfile`, `.github/actions/build-runtime-image/action.yml`, `.github/workflows/docker-publish.yml`. Reading `pnpm-workspace.yaml` and `pnpm-lock.yaml` needs no new plumbing.
- **The spec's governance requirement stays.** "The supply-chain knobs MUST NOT be weakened without an OpenSpec change" (`supply-chain-hygiene/spec.md:136-151`) already names "adds a `true` entry to `allowBuilds`" as requiring a dedicated proposal. That requirement is correct and untouched; this change gives it teeth.

## Goals / Non-Goals

**Goals:**

- No tracked file except `pnpm-workspace.yaml` states which packages may execute code at install time.
- Adding a `true` entry cannot land without a reviewable, tracked edit outside `pnpm-workspace.yaml` that reds `pnpm test` until made.
- Every exception carries its reason where the exception lives.
- The published specs say something that stays true as the dependency tree moves.

**Non-Goals:**

- Changing `allowBuilds`. No entry is added, removed, or flipped by this change.
- Auditing whether `onnxruntime-node` _deserves_ its `true` — that decision was taken and recorded in `archive/2026-06-05-embed-embeddings-in-process/design.md:87`; this change publishes it, it does not revisit it.
- Verifying at runtime that pnpm actually honoured the policy. The assertions are static; observing which scripts really ran needs a real `pnpm install`, which is the smoke task, not the invariant.
- Pinning the other supply-chain scalars (`minimumReleaseAge`, `blockExoticSubdeps`). They are quoted correctly today and have not drifted.

## Decisions

### D1 — The specs state the property; `pnpm-workspace.yaml` is the sole enumeration

Both published requirements drop their inline lists. `supply-chain-hygiene` keeps the _semantics_ of an entry (a `true` grants arbitrary code execution on every contributor machine and CI runner; a `false` is an explicit documented deny) and requires that membership be readable in exactly one place. `development-environment` keeps the file-shape requirement (`.npmrc` contains `ignore-scripts=true`; `pnpm-workspace.yaml` contains an `allowBuilds:` boolean map) and stops naming members.

The reason this is not a loss of auditability: the file is shorter than the prose that described it, is always current, and carries the justification inline — so a reader auditing the surface gets a _better_ answer from one `cat pnpm-workspace.yaml` than from a spec paragraph written at some past commit. What the spec uniquely provides is the policy and the enforcement contract, and neither rots.

_Alternatives considered._ (a) **Sync both lists to seven entries.** Rejected: it fixes today and nothing else, and the history in the proposal shows the copies were being guarded deliberately (`2026-05-20` required the block "verbatim") when they rotted anyway. (b) **Keep the enumeration in `supply-chain-hygiene` only and have the test assert the spec prose matches the file.** Rejected: it makes the spec text machine-parsed prose, so a legitimate rewording reds CI, and it enshrines a second copy in the file that is hardest to change (published specs are archive-gated by `check-spec-provenance.mjs`). (c) **Move the allowlist into a dedicated `supply-chain.yaml` the spec can reference.** Rejected: pnpm reads `pnpm-workspace.yaml`; a second file would be a copy, not a relocation.

### D2 — Pin the `true` set exactly; require justification on all entries; do not pin `false` membership

`apps/server/src/test/supply-chain-inventory.ts` exports the expected `true` set as a `const` (four names today) plus the parser. `invariants.test.ts` asserts set equality against the parsed file, in both directions — an added `true` fails, and a removed one fails too (the removal is strengthening, but it must still be _seen_, and a stale pin would otherwise sit there claiming a grant that no longer exists).

`false` membership is deliberately unpinned. The threat is code execution, and only `true` grants it; a `false` entry is strictly safer than the same package's absence, because absence is also deny. pnpm surfaces newly-flagged transitives as the tree moves, and each explicit deny is a documentation improvement — making it cost a test edit is friction that buys no security. The asymmetry is the whole design: **pin what grants, not what denies.**

Both sets are still required to carry a non-empty trailing `#` comment on their line. That is the requirement the bare list never satisfied: a reader wants to know _why_ `onnxruntime-node` needs a postinstall, and "native binding postinstall validates/places prebuilt (in-process embedder)" answers it at the point of decision. All seven already comply, so the assertion is green on landing and load-bearing thereafter.

_Alternative considered._ **Pin all seven entries with their booleans.** Rejected for the friction argument above; a maintainer adding `foo: false` after a pnpm warning should not need to touch the server test tree.

_Alternative considered._ **Carry the justification text in the inventory instead of the YAML comment.** Rejected — that is a second copy of the reason, which is the defect being fixed. The test asserts a comment _exists_; it never compares its wording.

### D3 — A dead `true` entry is detectable via `pnpm-lock.yaml`

Each pinned `true` name must appear as a package key in `pnpm-lock.yaml`. An exception outliving its dependency grants nothing while the package is gone and silently re-grants execution the moment it returns as somebody's transitive — the worst kind of surface, because no reviewer is looking at that line when it becomes live again.

**Measured before proposing: 7 of 7 entries resolve in `pnpm-lock.yaml` today** (`husky`, `better-sqlite3`, `sqlite-vec`, `onnxruntime-node`, `sharp`, `protobufjs` at 2 keys each; `esbuild` at 8 platform variants). So this assertion adds **zero findings on landing** and is purely forward-looking. Stated plainly rather than dressed up as a fix.

Matching is on the lockfile's `<name>@<version>` key shape at two-space indentation, anchored, so `sqlite-vec` cannot be satisfied by `sqlite-vec-something`. Applied to `true` entries only: a `false` entry naming a package that has left the tree is harmless bookkeeping, and pruning it is a judgement call, not a violation.

### D4 — A working-tree assertion, not a diff-scoped CI gate

The natural-looking symmetric fix is a `scripts/check-*.mjs` inverse of `check-spec-provenance.mjs`: red when `pnpm-workspace.yaml` changes in a diff without a `supply-chain-hygiene` delta. Rejected as the primary mechanism.

The property here is a property of the tree at a commit, not of a diff, and the working-tree form is strictly stronger for this purpose: it fails on **every** run — pre-push, CI, and a local `pnpm test` — including on the branch where the entry was added, rather than only where a base ref resolves. It needs no `fetch-depth: 0`, cannot be defeated by a force-push that unresolves the range (`check-spec-provenance.mjs` explicitly exits 0 there), and needs no exemption trailer because the "escape hatch" is simply editing the pinned constant, which is exactly the reviewable act we want to force.

The diff-scoped variant would additionally require the _spec delta_, which the working-tree assertion cannot demand. That residual hole is real and recorded: an author can edit both the constant and `allowBuilds` in one commit with no proposal. Accepted, because after D1 there is nothing in the spec to update — the spec no longer enumerates, so the correct artifact for a new `true` entry is a proposal recording the review, and `supply-chain-hygiene`'s governance requirement already demands it. Filed as deferred in the proposal, not silently dropped.

_Alternative considered._ **A `.husky/pre-commit` grep.** Rejected: hooks are bypassable and `pnpm test` runs on pre-push and in CI anyway.

### D5 — Parse the block with a scoped line scanner, and fail closed

No YAML dependency (see Context). The parser reads `pnpm-workspace.yaml`, finds the line `allowBuilds:`, and consumes subsequent lines until the first line that is non-blank, non-comment, and not indented. Within the block each line must match `^  ([^\s:#]+):\s*(true|false)\s*(#\s*\S.*)?$`.

**Any in-block line that fails to match is an error, not a skip.** This is the `SHADOWS` lesson from `schema-inventory.ts:88-95` verbatim: a `^memory_vec_` prefix rule was tried and rejected there because it silently swallowed an unclassified `memory_vec_impostor` into "derived with its parent" — the tolerate-extras hole the partition existed to close. The same hole here would be a nested or quoted entry the scanner shrugs at, which is precisely how a grant hides. If a future pnpm release changes the block syntax, this test fails loudly and the new shape gets reviewed in one place.

Sibling assertion, cheap and directly motivated by the measured `.npmrc:2` and `development-environment/spec.md:270` drift: the file must use the key `allowBuilds` and must NOT contain `onlyBuiltDependencies`. pnpm 11 (pinned `pnpm@11.1.2`) ignores the pnpm 10 key silently, so a rename-by-mistake would deny every allowlisted script and, worse, a _revert_ to the old key would look plausible in review.

### D6 — Location: `apps/server/src/test/supply-chain-inventory.ts`, asserted from `invariants.test.ts`

Direct precedent, and the one this change is patterned on: `apps/server/src/test/schema-inventory.ts` exists because "two hand-maintained inventories drifted within a single branch once; a new table is now one edit" (`:1-14`). Same disease, same cure. The module holds data plus the parser; the assertions live in `invariants.test.ts` beside the allow-list anchor tests (`:200-232`), which established the pattern of a _positive_ assertion accompanying every allow-list — "invariant relaxation without enforcement is worse than no allow-list at all" (`:195-199`).

A repo-root config concern living under `apps/server/src/test/` is mild misfiling, accepted because that is where `repoRoot` assertions already live (Dockerfile, workflows).

The reason is **typecheck coverage, not cross-workspace cost** — recorded precisely, because the plausible-sounding version is wrong and would get this relocated later on a false premise. `apps/server/vitest.config.ts` already includes `../../scripts/*.test.ts` and `../../install.test.ts`, so a module under `scripts/` would run in the same `pnpm test`, same process, no new config: there is no suite to split. What `scripts/` loses is `pnpm run typecheck` — `apps/server/tsconfig.json` is `include: ["src/**/*"]` with `rootDir: ./src`, which is why `check-spec-provenance.mjs` is untyped `.mjs`. A fail-closed regex parser wants strict TS with `noUncheckedIndexedAccess`, so it stays under `src/`.

### D7 — Fix the non-spec copies in this change, not a follow-up

`CONTRIBUTING.md:17` / `:153-155`, `.npmrc:2`, and `CLAUDE.md:76` each restate the same fact wrongly. They are not spec text, so no requirement can cover them, and the test cannot reasonably assert prose. They are fixed here because the change is otherwise incomplete in the only way that matters — a contributor reads `CONTRIBUTING.md`, not the spec — and because leaving three known-false statements in place while landing a change titled "align" would be absurd. The fix converts counts into a pointer at the file, so they cannot rot again.

`CLAUDE.md:76`'s "and lockfile-lint in CI" is a distinct error in the same sentence: `supply-chain-hygiene/spec.md:72` states `lockfile-lint@4.x` MAY NOT be used because it does not parse `pnpm-lock.yaml`, `CONTRIBUTING.md:150-152` says the same, and no workflow runs a lockfile-lint step (`ci.yml:87` names it only in a comment explaining why it cannot be used). Corrected to name the three `--frozen-lockfile` invariants that actually run.

## Risks / Trade-offs

- **[Risk] The pinned constant is itself hand-maintained — has the drift just moved?** → Mitigation: no, because nothing compared the prose to the file, whereas the test compares the constant to the file on every run. The constant _cannot_ silently diverge; that is the entire difference between this and the situation it replaces (D2, and the `schema-inventory.ts` precedent).
- **[Risk] An author adds a `true` entry, edits the constant, and skips the proposal.** → Mitigation: partial. The edit is now visible in the diff at a file whose name says what it is, and the test's failure message names `supply-chain-hygiene`'s governance requirement. A gate that also demands the proposal is the deferred diff-scoped variant (D4). Accepted: this closes the invisible path, not the dishonest one.
- **[Risk] Removing the enumeration reads as reducing published auditability.** → Mitigation: the requirement will name `pnpm-workspace.yaml::allowBuilds` explicitly as the place to look, and the file carries per-entry justification. The alternative — a published list that understates the `true` count by 25% for 42 releases — is worse auditability, not better.
- **[Risk] The line scanner breaks on a future pnpm `allowBuilds` syntax.** → Mitigation: fail-closed (D5), so the break is a loud red with a named line rather than a silently-empty parse that passes every assertion vacuously. Guarding against the vacuous-pass shape specifically: the tests assert a non-empty parse and a non-zero `true` count, because an "identical behaviour" proof over two empty sets proves nothing.
- **[Trade-off] `false` membership is unpinned, so a `true → false` flip is not itself gated.** → Accepted: a flip to `false` removes a grant, and `supply-chain-hygiene` already permits strengthening via a one-paragraph proposal. The set-equality assertion on `true` catches the flip anyway (the name leaves the `true` set), which is the reason equality is asserted in both directions.
- **[Trade-off] Two published specs get amended for one fact.** → Accepted; both currently state it, and leaving `development-environment` alone would leave the _false_ universal and the failing scenario in place, which is the more serious of the two defects.

## Migration Plan

Nothing to migrate. No runtime code, no schema, no DB access, no MCP tool, no plugin file, no dashboard token, no dependency change. Existing installations — including those carrying hundreds of memories — are bit-for-bit unaffected: no migration runs, no derived table (`memory_fts`, `prompts_fts`, `memory_replaces`, `memory_vec`, `memory_entities`, `memory_entity_links`, `memory_entity_scan`) is invalidated, and the first boot after upgrade is indistinguishable from the last boot before it.

Deploy = merge. The Docker smoke in `tasks.md` exists to prove exactly that non-effect against pre-existing seeded data, not to verify a behaviour change. Rollback = delete `supply-chain-inventory.ts` and its describe block; the spec text reverts by the normal archive route.

## Open questions

1. **Should `sharp: false` and `protobufjs: false` remain listed?** Both are explicit denies for transitives of `@huggingface/transformers` / `onnxruntime-node`. If pnpm no longer flags them, the lines are documentation of a decision nobody is being asked to make. Default taken: **leave them**, because an explicit deny is free and the note explains a non-obvious call ("vision-only, never loaded by text pipelines"). Answering properly needs a clean `pnpm install` and a look at what pnpm actually reports as ignored — an observation, not a spec edit. Deferred, recorded in the proposal.
2. **Should the inventory also pin `minimumReleaseAge` and `blockExoticSubdeps`?** They are scalars, both quoted correctly in both specs, and neither has drifted since it was introduced (`2026-05-18-harden-npm-supply-chain`). Default taken: **no** — pin the thing that demonstrably rots. Revisit if either is ever found stale, at which point the parser already written here makes it a two-line addition.
3. **Genuinely open: should a `true` entry also require the grant's blast radius to be recorded, not just its reason?** "native binding postinstall fetches prebuilt" says why the script exists; it does not say what the script can reach (network egress to which host, which paths it writes). For `onnxruntime-node` that is the difference between "downloads from a pinned CDN" and "runs a build toolchain". No default taken — it is a real judgement call about how much audit detail belongs in a YAML comment versus a spec, it would change the shape of the justification requirement, and deciding it by fiat in a change about alignment would be overreach. Flagged for the reviewer.

### D8 — The image build is a second execution channel, and `pnpm rebuild` is the ungoverned half of it

Found during apply, by a review that asked whether the gate covered the policy it pins. It did not: `findSupplyChainViolations` took `{workspace, lockfile, npmrc}` and stopped, while `apps/server/Dockerfile` carries two install-time execution channels with different governance.

`pnpm install` (`:26` builder, `:95` dev) obeys `.npmrc::ignore-scripts`, but only because `.npmrc` is COPYed in at `:21` and `:92`. Each stage copies independently, so a stage that installs without it installs under npm's default, scripts ON, with every allowlist assertion still green. Asserted.

`pnpm rebuild better-sqlite3 sqlite-vec onnxruntime-node` (`:48`) obeys nothing. Explicit arguments run those packages' lifecycle scripts regardless of `allowBuilds`, and the invocation runs after `cd /prod-out` — not a descendant of the `WORKDIR` holding the copied `.npmrc` — so default-deny could not apply even in principle. That argument list is a grant, and nothing in the repo compared it to anything. Today all three names are in the pinned set, so **the assertion finds nothing on landing**; what it closes is the path by which a fourth name lands there with no allowlist entry, no inventory edit and no failing test. A bare `pnpm rebuild` is also rejected, because it grants whatever the allowlist permits and would make the subset check vacuous.

This is why the requirement's previous Dockerfile clause was worse than merely false. It demanded `--ignore-scripts` on the `runtime` stage's `pnpm install` — a stage with no install — and in doing so pointed attention at the channel that was already governed twice over while saying nothing about the one that was not governed at all.

_Alternative considered._ **Add `--ignore-scripts` to the two real install lines and keep the clause.** Rejected: redundant wherever `.npmrc` is present, it would still leave `pnpm rebuild` unchecked, and it would modify the Dockerfile — which the proposal deliberately leaves untouched. The Dockerfile is read here, never written.

### D9 — The mechanism everyone had written down was wrong in both directions, measured

Found during apply by an adversarial review, then re-measured independently against the pinned pnpm 11.1.2 with `esbuild@0.25.10` as the oracle: its `bin/esbuild` ships as a JS shim and becomes an ELF binary only if its postinstall runs, so "did a lifecycle script execute" is a `file(1)` call rather than a judgement.

| case                                                                                     | result                                                     |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `.npmrc: ignore-scripts=true` + `allowBuilds: {esbuild: true}`                           | script **RAN** (ELF)                                       |
| **no `.npmrc` at all**, no `allowBuilds`                                                 | script **DENIED** (`ERR_PNPM_IGNORED_BUILDS`, shim intact) |
| `ignore-scripts=true` + `allowBuilds: {husky: true}` + `dangerouslyAllowAllBuilds: true` | script **RAN** (ELF), esbuild granted nowhere              |
| `allowBuilds: {husky: true}`, then `pnpm rebuild esbuild`                                | script **DENIED** (shim intact)                            |

Three consequences, all of which changed this change:

**`.npmrc::ignore-scripts=true` is not the default-deny mechanism for dependency scripts.** `allowBuilds` is: absence denies, and `ignore-scripts` does not suppress a grant. The published requirement had asserted the reverse since `2026-05-18-harden-npm-supply-chain`, and this change was about to re-publish it inside a paragraph it had just rewritten for accuracy. Corrected in both specs. The knob stays required — it governs the repository's own scripts — but the file that must reach an installing stage is `pnpm-workspace.yaml`, and the image assertion now checks both, ordinally.

**`dangerouslyAllowAllBuilds` is a real, unchecked bypass, and it was the gate's one critical hole.** pnpm's `createAllowBuildFunction` opens with `if (opts.dangerouslyAllowAllBuilds) return () => true`, short-circuiting before `allowBuilds` is read, so it also overrides explicit `false` denies. Because the block parser stops at the first unindented line, a sibling top-level key was invisible to it — the only placement that works was the only placement missed. A one-line edit to the very file the gate parses would have defeated the gate, the pinned inventory and the governance requirement together, with `pnpm test` green. Now asserted as a config key and as a CLI flag on any install line.

**`pnpm rebuild <pkg…>` does respect `allowBuilds`, contrary to D8.** D8's reasoning was inverted. The subset check it added is conservative — it can only false-alarm — so it stays, as a guard against a future pnpm changing this and because the bypass-flag check has to cover rebuild lines anyway. D8's _conclusion_ (assert the argument list) survives; its _premise_ does not, and the difference is recorded rather than quietly overwritten.

The lesson worth keeping: this change's whole thesis is that an unverified claim rots. Four of its own claims about pnpm's behaviour were inherited rather than measured, and three were false. A gate is only as trustworthy as the mechanism it believes in.
