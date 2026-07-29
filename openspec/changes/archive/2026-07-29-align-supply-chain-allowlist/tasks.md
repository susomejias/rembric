## 1. Consult the skill and confirm the baseline

- [x] 1.1 **Confirmed: no dependency added, removed or bumped; `pnpm-lock.yaml`, `package.json` and `pnpm-workspace.yaml` untouched in the final diff. Restated in the commit body.** Read `.agents/skills/npm-security-best-practices/SKILL.md` (practices #1, #2, #3, #5, #6 are the ones this repo enforces) and `references/pnpm-config.md`. Mandatory per `CLAUDE.md` because this change edits `.npmrc`. Confirm in the commit body that **no dependency is added, removed, or bumped** and that `pnpm-lock.yaml`, `package.json` and `pnpm-workspace.yaml` are untouched.
- [x] 1.2 Record the baseline that the change must preserve: `pnpm-workspace.yaml::allowBuilds` has **7 entries — 4 `true` (`husky`, `better-sqlite3`, `sqlite-vec`, `onnxruntime-node`) and 3 `false` (`esbuild`, `sharp`, `protobufjs`)** — and all 7 resolve in `pnpm-lock.yaml`. Re-verify before writing the pin; if the file has moved on since this change was proposed, the pin follows the file, not this task.

## 2. Pinned inventory + parser

- [x] 2.1 Create `apps/server/src/test/supply-chain-inventory.ts` exporting `ALLOWED_BUILD_SCRIPTS` (the `true` set, 4 names) with a docstring stating why it exists (mirror `schema-inventory.ts:1-14`: the fact had two hand-maintained prose copies and they diverged) — and nothing more. Do **not** copy the justification text from the YAML comments; the reason lives in `pnpm-workspace.yaml` only (design D2).
- [x] 2.2 In the same module, export `parseAllowBuilds(source: string)` returning `{ entries: Array<{ name: string; allowed: boolean; justification: string }> }`. Scope: from the line `allowBuilds:` to the first following line that is non-blank, non-comment and not indented. In-block lines must match `^ {2}([^\s:#]+):[ \t]*(true|false)[ \t]*(?:#[ \t]*(\S.*?))?[ \t]*$`. **Throw on any in-block line that does not match, quoting the line** — never skip (design D5; the `SHADOWS` tolerate-extras lesson in `schema-inventory.ts:88-95`). No YAML dependency, no new import beyond `node:fs`/`node:path` at the call site.
- [x] 2.3 Unit-test the parser directly on synthetic sources (co-located or inside the invariants block, whichever keeps `invariants.test.ts` readable): a well-formed block; a block terminated by the next top-level key; an entry with no comment; an entry with an empty comment (`#` alone); a nested/quoted entry; a non-boolean value. Each malformed case must throw with the offending line in the message. Verifiable: 6 parser cases pass.

## 3. Invariant assertions in `invariants.test.ts`

- [x] 3.1 Add one `describe` block near the existing allow-list anchor tests (`:200-232`). Read `pnpm-workspace.yaml` and `pnpm-lock.yaml` via the existing `repoRoot` (`:286`).
- [x] 3.2 Assert **non-vacuity first**: the parse yields ≥ 1 entry and the parsed `true` set is non-empty. Without this, every set comparison below is satisfiable by an empty parse (the before/after-digest lesson: a match between two empty sets proves nothing).
- [x] 3.3 Assert the parsed `true` set **equals** `ALLOWED_BUILD_SCRIPTS`, both directions, with a failure message that names the offending package(s) and states that granting install-time code execution requires an OpenSpec change against `supply-chain-hygiene`.
- [x] 3.4 Assert every entry (`true` **and** `false`) has a non-empty `justification`. Assert presence only — never compare wording.
- [x] 3.5 Assert every `true` entry resolves in `pnpm-lock.yaml`, matching anchored on the `^ {2}<name>@` key shape so `sqlite-vec` cannot be satisfied by `sqlite-vec-anything`. **Expected result on landing: 4 of 4 resolve, zero findings** — this assertion is forward-looking by design (D3).
- [x] 3.6 Assert `pnpm-workspace.yaml` uses `allowBuilds` and does **not** contain `onlyBuiltDependencies`, with a message explaining that pnpm 11 ignores the retired key silently, so the mistake denies every allowlisted script with no error.
- [x] 3.7 Assert `.npmrc` still contains `ignore-scripts=true` (the directive, not the comment) — the allowlist means nothing without default-deny, and this change edits that file.

## 4. Prove each assertion actually fires

- [x] 4.1 For every assertion in §3, drive the failure path against a **mutated in-memory copy** of the real file (never by editing `pnpm-workspace.yaml` on disk): an extra `true` entry; a missing `true` entry; a `true` entry with no comment; a `true` entry naming a package absent from the lockfile fixture; `allowBuilds` renamed to `onlyBuiltDependencies`; a malformed in-block line. Verifiable: **6 negative cases, each failing with the offending name or line in the message.** A gate that has never been observed to fail is not a gate.
- [x] 4.2 Sanity-check the positive direction against the real tree: the whole new block passes on an unmodified checkout, with 7 entries parsed and 4 in the `true` set.

## 5. Retire the stale copies

- [x] 5.1 `CONTRIBUTING.md:17-21`: replace "Husky is one of three packages allowlisted as `true` … (along with the two native bindings `better-sqlite3` and `sqlite-vec`)" with a statement that Husky's `prepare` is allowlisted and that the complete, justified set lives in `pnpm-workspace.yaml::allowBuilds`. No count, no list.
- [x] 5.2 `CONTRIBUTING.md:153-158`: replace "for every dep except the three set to `true` … (`husky`, `better-sqlite3`, `sqlite-vec`)" with a pointer to the file, and add that a new `true` entry also requires updating `apps/server/src/test/supply-chain-inventory.ts` or `pnpm test` fails — so contributors meet the gate in the doc before they meet it in CI.
- [x] 5.3 `.npmrc:2`: the comment says "Exceptions are declared in pnpm-workspace.yaml::onlyBuiltDependencies". Change the key to `allowBuilds`. Comment only — `ignore-scripts=true` and `engine-strict=true` are untouched.
- [x] 5.4 `CLAUDE.md:76`: two errors in one sentence. Replace `explicit pnpm-workspace.yaml::allowBuilds` with a form that does not imply a fixed list, and **delete "and lockfile-lint in CI"** — `supply-chain-hygiene/spec.md:72` states `lockfile-lint@4.x` MAY NOT be used (it cannot parse `pnpm-lock.yaml`), `CONTRIBUTING.md:150-152` agrees, and `.github/workflows/` runs no lockfile-lint step (`ci.yml:87` names it only in a comment explaining why it is unusable). Name the three `--frozen-lockfile` invariants that actually run instead.
- [x] 5.5 **Non-spec copies now; the four spec-side rows land at archive time with 5.6.** Verifiable end state: `grep -rniE "(one|two|three|four|five|six|seven) (packages|deps|entries)|the three set to|These three are the only" CONTRIBUTING.md CLAUDE.md .npmrc openspec/specs/` returns nothing about `allowBuilds`, and the only tracked enumeration of membership is `pnpm-workspace.yaml` plus the pinned inventory. **The measurement this change must produce: 6 stale statements → 0.** Measured in the working tree before archive: **6 → 2 fixed, 4 remaining** (`CONTRIBUTING.md` ×2, `.npmrc`, `CLAUDE.md` fixed; `supply-chain-hygiene/spec.md:13`, `development-environment/spec.md:270`, `:295`, `:306` merge at archive). Re-run the grep after archiving to reach 0. **Re-run post-archive: 0 remaining. 6 → 0 met.**

- [x] 5.6 **At archive time only**, while already editing `openspec/specs/supply-chain-hygiene/spec.md`: its `## Purpose` still reads "TBD - created by archiving change add-dependabot-and-engine-strict. Update Purpose after archive." Write the real purpose (the dependency threat model this capability owns: default-deny lifecycle scripts, registry-only transitives, install cooldown, frozen-lockfile installs, bot-driven updates). Pre-existing wart, one line, in the file this change amends — not carried by a delta because deltas carry requirements only.

## 6. Verification

- [x] 6.1 `pnpm run typecheck`
- [x] 6.2 `pnpm run lint` (`.npmrc`, `CONTRIBUTING.md` and `CLAUDE.md` also pass through prettier via lint-staged on commit — do not bypass hooks)
- [x] 6.3 `pnpm test` — green, with the new block visible in the run and the negative cases from §4 passing
- [x] 6.4 `pnpm run eval` is **not** required and MUST NOT be run as evidence here: no retrieval, ranking, scoring or embedding path is touched. Recorded so the omission is a decision, not a gap.
- [x] 6.5 `npx openspec validate align-supply-chain-allowlist --strict`

## 7. Real Docker smoke against pre-existing seeded data

Standing requirement, and not ceremonial here: `.npmrc` is read by the `builder` and `dev` install layers (`runtime` is distroless and runs no install), so a malformed edit changes what executes at image build time. Follow `.agents/skills/rembric-smoke-tests/`.

- [x] 7.1 Build both Dockerfile stages from the branch (`builder`/`runtime` and `dev`). **Measured:** both `pnpm install --frozen-lockfile` layers reported `Lockfile is up to date, resolution step is skipped`; the only lifecycle scripts observed executing were `onnxruntime-node postinstall` and `better-sqlite3 install`, both pinned. Both `pnpm install --frozen-lockfile` layers must succeed with no lockfile churn and no `ignore-scripts` warning regression.
- [x] 7.2 **Deviation, recorded rather than hidden: `dev:docker:up` runs `seed-dev --reset` on every boot, so it CANNOT smoke against pre-existing data — it destroyed the resident corpus (2055 → 35 memories) before this was understood. The preservation proof was redone with the `runtime` image against a consistent copy of the data dir, with a non-seed marker memory written through MCP first so the assertion is not a match between two identical seeds.** Original text: Bring up `pnpm run dev:docker:up` against a data dir that **already holds seeded memories** (do not wipe/reseed for this run; `chown -R 10001:10001 data-dev` first if needed). Record the pre-run count of `memory` rows.
- [x] 7.3 **Measured: `memory` 36 → 36 (non-empty, marker present), `_migrations` 27 → 27 (last `0026_confirmation_verdict_check.sql`), `sqlite_master` indexes 57 → 57, `memory_fts` 36, `memory_replaces` 17, `memory_entities` 1, `memory_entity_links` 1, `memory_entity_scan` 36 — all unchanged, and zero migration/rebuild lines in the boot log.** After boot, assert the memory count is **identical and non-empty** (name the number in the task notes — a match between two zeros proves nothing), no migration ran, and no derived table was rebuilt (`memory_fts`, `prompts_fts`, `memory_replaces`, `memory_vec`, `memory_entities`, `memory_entity_links`, `memory_entity_scan`). This change ships no runtime code; the smoke exists to prove that non-effect.
- [x] 7.4 Exercise one MCP round-trip (`memory.context` or `memory.search`) and one dashboard page to confirm the image is functional, then tear down. Record the outcome in the PR body.

## 8b. Corrections forced by the adversarial review (all measured against pnpm 11.1.2)

- [x] 8b.1 Close the `dangerouslyAllowAllBuilds` bypass: asserted as a config key at any indentation in `pnpm-workspace.yaml` and as a CLI flag (`--dangerously-allow-all-builds`, `--config.dangerouslyAllowAllBuilds`) on any Dockerfile install line. **This was a critical false negative — a one-line edit to the parsed file defeated the whole gate with `pnpm test` green.**
- [x] 8b.2 Correct the default-deny mechanism in both published specs: `allowBuilds` denies, not `.npmrc::ignore-scripts`. Measured four ways with the esbuild ELF oracle (design D9).
- [x] 8b.3 Correct D8's inverted premise: `pnpm rebuild <pkg>` DOES respect `allowBuilds`. The subset check stays as a guard; the rationale is rewritten.
- [x] 8b.4 Make the Dockerfile check ordinal (COPY index < install index) for BOTH `pnpm-workspace.yaml` and `.npmrc`, and line-anchor the install matcher so a commented-out install no longer satisfies the vacuity guard.
- [x] 8b.5 Fix `resolvesInLockfile` for scoped packages: lockfile v9 quotes every key starting with `@`, so `^ {2}'?<name>@`. Without it the first scoped native grant would report as dead surface while plainly resolving.
- [x] 8b.6 Normalise CRLF, accept an inline comment on the block header, and give YAML flow style its own diagnosis — three legal, pnpm-honoured forms that previously threw blaming a pnpm 10 key rename.
- [x] 8b.7 Join backslash-continued Dockerfile instructions before analysis, and read the stage name past `FROM --platform=...`.
- [x] 8b.8 Add one negative case per finding above. **29 cases in the co-located file, up from 20; 96 tests green across the two files.**

## 8. Record what was deliberately not done

- [x] 8.1 In the PR body, carry forward the three deferred items from `proposal.md` so they are not silently lost: (a) whether `sharp: false` and `protobufjs: false` are still needed as explicit denies — needs a clean `pnpm install` observation of what pnpm actually reports as ignored, not a spec edit; (b) the diff-scoped CI gate that would red a `pnpm-workspace.yaml` change carrying no `supply-chain-hygiene` delta (inverse of `scripts/check-spec-provenance.mjs`), rejected here in favour of the working-tree assertion (design D4) and its residual hole stated; (c) extending the pin to `minimumReleaseAge` / `blockExoticSubdeps` / `minimumReleaseAgeExclude`, which have not drifted.
- [x] 8.2 Surface design **Open question 3** for the reviewer: should a `true` entry also record the grant's blast radius (network egress, paths written), not merely why the script exists? No default was taken — it changes the shape of the justification requirement and deciding it inside an alignment change would be overreach.
- [x] 8.3 Confirm `pnpm-workspace.yaml` is **unmodified** in the final diff (`git diff --stat` must not list it). If landing the change required editing it, something in the plan was wrong — stop and re-open the proposal.
