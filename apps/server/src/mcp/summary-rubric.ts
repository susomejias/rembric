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
