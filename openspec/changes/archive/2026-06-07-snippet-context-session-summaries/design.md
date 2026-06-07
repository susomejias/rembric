## Context

`handleContext` in `apps/server/src/mcp/sessions-tools.ts` builds the `memory.context` response from four sources. Two were already display-truncated via a shared `snippet(content, max)` helper — memories (`snippet(m.content, 200)`) and relations (`sourceSnippet`/`targetSnippet`, 200) — but at an ad-hoc literal. The other two were emitted verbatim: session `summary` (up to the 2000-char `SUMMARY_MAX_CHARS` cap) and prompt `content` (uncapped). At the default of 5 sessions the verbatim summaries alone are the single largest contributor to the context payload (~10K chars ≈ ~2.5K tokens), undercutting Rembric's token-efficiency promise. There is no single source of truth for the display bound.

## Goals / Non-Goals

**Goals:**

- Bound every text field of the `memory.context` output by one shared constant, so context stays a cheap awareness payload and the four fields cannot drift apart.
- Close the two verbatim-content holes (session summary, prompt content) while harmonizing the already-truncated fields (memory snippet, relation snippets) to the same bound.
- Keep all full values intact and retrievable through every other surface (`memory.get`, dashboard, `memory.search`).

**Non-Goals:**

- Changing what is _stored_ (no write-path, cap, schema, or migration change).
- Reducing the default recent-session count (stays 5).
- Introducing a second "full" summary field or any agent-authored condensed summary.
- Touching the four plugin clients (all POST-and-forget; none read context text back).

## Decisions

**Decision 1 — Truncate read-side in `handleContext`, not at write/storage time.**
Each text field is wrapped in `snippet(value, CONTEXT_SNIPPET_CHARS)` (sessions and prompts newly; memories and relations switched from the literal 200).

- _Alternative A — lower the stored `SUMMARY_MAX_CHARS` cap (write-path):_ rejected. It would require lowering the SQLite `CHECK(length(summary) <= 2000)`, which on SQLite forces a full table rebuild; it also mangles the hook fallback transcripts (which legitimately arrive large) and loses data permanently. Read-side truncation preserves storage and is a handful of lines.
- _Alternative B — add `summary_condensed` + `summary_full` columns with agent-authored condensed text and fallback routing:_ rejected for this change. It adds conditional fallback-routing logic and dual-column `final`-precedence over a load-bearing mutable table — high complexity for a benefit (cross-client "full handoff on demand") that is currently speculative. Parked, not part of this change.
- _Alternative C — reduce default session count 5→3:_ rejected. The count was never the cost driver; the per-item size was. With snippeting, 5 sessions cost ~590 tokens; dropping to 3 saves only marginal tokens while losing two sessions of awareness.

**Decision 2 — One shared constant `CONTEXT_SNIPPET_CHARS = 350` for all four fields.**
A single module-level constant replaces the prior per-field literals (200, and verbatim for the other two).

- _Why one constant:_ the four fields are the same kind of thing — "a bounded preview of a stored record in the context payload." A shared bound guarantees they cannot drift and documents the intent in one place.
- _Why 350 over the prior 200:_ the user wants a little more information per item; 350 keeps the payload bounded while letting the leading, most-useful lines survive (a session summary's `Goal:`/`Discoveries:` head, a prompt's first ask). 350 is a tuning constant, not a contract — the spec mandates "bounded with ellipsis via the shared constant," not a magic number.
- _Trade-off accepted:_ memory and relation snippets grow 200 → 350 (~+150 chars each), a small payload increase on fields that were already lean. This is dwarfed by the session-summary saving (each drops from up to 2000 to ≤350), so the net context payload still falls sharply versus today.

**Decision 3 — Reuse the existing `snippet` helper; apply uniformly including prompts.**
No new helper. `snippet(content, max)` already appends `…` on truncation. Prompts (`recentPrompts[].content`) were the second verbatim field and are included so "every context text field is bounded" holds with no exceptions; field names are preserved (`content`, `summary`) so the response shape is unchanged.

## Risks / Trade-offs

- **[Trade-off] The snippet is a blunt mid-sentence cut** (no semantic condensation) → Accepted because the purpose of the context payload is _awareness_, for which a leading slice suffices, and the full text is one tool call away (`memory.get`). Semantic condensation would require the agent-authored condensed path (Alternative B), explicitly out of scope.
- **[Trade-off] Memory/relation snippets grow 200 → 350** → Accepted: a small increase on already-lean fields, chosen for uniformity and "a bit more info," and far outweighed by the session-summary reduction.
- **[Risk] A consumer might rely on `memory.context` returning full text** → Mitigated: no plugin client reads context text back (verified — all four are POST-and-forget), and full values remain available via `memory.get`, the dashboard, and `memory.search`. The change is additive-safe on the read path; only internal tests assert full content and are updated.

## Migration Plan

None. Pure read-side behavior change in one handler. No data migration, no schema change, no rollback steps beyond reverting the mapping. Deploys with the normal server image.
