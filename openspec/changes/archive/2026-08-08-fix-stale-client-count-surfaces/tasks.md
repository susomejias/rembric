# Tasks

## 1. The runtime surface (leads: an agent reads it every session)

- [x] 1.1 `apps/server/src/mcp/server.ts` — the `memory.session_start` description names Pi alongside the other four hosts, and drops the "on startup" clause that is wrong for the in-process providers.
- [x] 1.2 Confirm the description still passes `mcp-integration.test.ts`'s `DESCRIPTION_MAX_LENGTH` assertion and its headroom assertion, measured from a real `tools/list` rather than by reading the source.

  The suite pins the **exact** measured length per tool, not just the ceiling (`mcp-integration.test.ts:711-724`, `it.each` over seven tools, with the comment "Measured from the live `tools/list` string, never from the source constant"). The edit moved `memory.session_start` from 624 to **616** characters and reddened that row, which is the pin working as designed. The expectation was updated to the length vitest reported, not to an arithmetic guess.

- [x] 1.3 Confirm the description still names every required output field, so the edit does not break `Scenario: memory.session_start's description names every required output field`. Green — the edit touched only the host enumeration, not the `Returns: { … }` list.

## 2. The stale code comment

- [x] 2.1 `apps/server/src/mcp/summary-rubric.ts:4` — name the shared plugin core as the second copy holder, matching what `invariants.test.ts` pins.

  Verified against the test rather than the old comment: `invariants.test.ts:1251-1260`'s surface list holds `REMBRIC_PLUGIN_CORE_MJS`, the three bash scripts and `.hermes-plugin/__init__.py`, and no longer the opencode plugin.

## 3. The prose counts

Carried by the delta specs, so they reach `openspec/specs/` when this change is archived — not hand-edited during apply.

- [x] 3.1 `http-api` delta — `spec.md:44`'s "all four supported agents" becomes "every supported agent".
- [x] 3.2 `mcp-api` delta — `spec.md:1559`'s "all four supported clients" becomes "every supported client".
- [x] 3.3 `mcp-api` delta — `spec.md:539` drops the stale total and keeps the verified "two".
- [x] 3.4 `development-environment` delta — `spec.md:381` adds Pi to the `apps/plugin/` client list.

The four deltas were produced by extracting each enclosing requirement verbatim from the live spec and applying one substitution to each, asserting a single match per substitution. 235 lines of delta for four corrections is the provenance gate's price: it pairs per capability, so a one-word fix still carries its whole requirement.

## 4. Verification

- [x] 4.1 `openspec validate fix-stale-client-count-surfaces --strict` passes.
- [x] 4.2 `pnpm run check:delta-freshness` reports exactly **4** body differences, one per modified requirement — the four intended substitutions and nothing else, which is what confirms the verbatim extraction did not silently revert another change's text.
- [x] 4.3 `pnpm run typecheck`, `pnpm run lint`, `pnpm test` green.
- [x] 4.4 Re-run the acceptance grep from `pi-plugin/spec.md:402` and confirm every remaining hit is legitimate or historically scoped. Run as the last step of archiving, because until the deltas merge the stale lines are still in `openspec/specs/`.

  Every client-related hit that survives is correct as written:

  | Surface                                                               | Why it stays                                                                                                                              |
  | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
  | `.pi-plugin/README.md:7`                                              | "the other four clients" — from Pi's own README this is the right count                                                                   |
  | `apps/plugin/CHANGELOG.md:141,176`, `apps/server/CHANGELOG.md:63,487` | historically scoped by definition                                                                                                         |
  | `pi-plugin/spec.md:400-404`                                           | the acceptance scenario itself                                                                                                            |
  | `tui-installer/spec.md:98`                                            | four installer _surfaces_, not clients                                                                                                    |
  | `scripts/pi-package.mjs:60`                                           | "the four clients that register the dotted names" — Pi is the only underscored one, so four is right and correcting it would be the error |

  The rest are `all four` followed by `indexes`, `columns`, `arguments`, `memories`, `phases`, `fallbacks` — nouns, not clients.
