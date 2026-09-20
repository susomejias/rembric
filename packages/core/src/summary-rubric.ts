/**
 * The canonical structure of a session summary, defined once.
 *
 * TypeScript surfaces import from here; bash, Python and the shared plugin core
 * keep their own copies for the usual cross-language reason and are held to this
 * text by `invariants.test.ts::"the session-summary rubric has one source"`.
 *
 * Only the SHORT form lives here: it is what the TypeScript surfaces interpolate.
 * The long form has no TypeScript consumer — its only consumer is the end-of-turn
 * hook, which is bash — so it lives in `apps/plugin/test/nudge-fixtures.json`
 * beside the other cross-language nudge text, and the hook is held to it there.
 * A TypeScript constant nothing in TypeScript reads is how the first version of
 * this shipped: dead, while the text that actually went out was written twice.
 */

/** Section list. Order is the reading order of a handoff, not an importance order. */
export const SUMMARY_SECTIONS = `Use exactly these six Markdown level-2 headings, in this order, each on its own line (never one flat paragraph):
## Goal
## Accomplished
## Decisions+why
## Verified+how
## Unfinished+why
## Files`;

/**
 * The section-wise merge rule, in one sentence: consumed by
 * `memory.session_summary`'s description and by `instructions.ts::BASE`,
 * so the two surfaces cannot drift into teaching different rules (see
 * `mcp-api`, "The `instructions` block MUST state that a curated summary
 * write replaces the stored value"). `SUMMARY_SECTIONS` above is untouched
 * by this constant.
 */
export const SUMMARY_MERGE_RULE = 'The `##` sections you send REPLACE; the ones you omit STAY.';
