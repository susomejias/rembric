/**
 * The canonical structure of a session summary, defined once.
 *
 * It was previously restated at eight surfaces and seven of them agreed while
 * the tool description named two sections the others did not, with nothing
 * detecting the drift. TypeScript surfaces import from here; bash, Python and
 * the opencode plugin keep their own copies for the usual cross-language reason
 * and are held to this text by
 * `invariants.test.ts::"the session-summary rubric has one source"`.
 *
 * Two forms, because the surfaces have different budgets. `SUMMARY_SECTIONS` is
 * the section list, short enough for a per-turn nudge and for a tool description
 * bounded by `DESCRIPTION_MAX_LENGTH`. `SUMMARY_RUBRIC` says what each section
 * is for and goes where there is no budget — the end-of-turn payload.
 */

/** Section list. Order is the reading order of a handoff, not an importance order. */
export const SUMMARY_SECTIONS =
  'Goal · Accomplished · Decisions+why · Verified+how · Unfinished+why · Files';

/**
 * The long form. Every section exists because it is something a later reader
 * cannot recover from the code: the code shows what a decision was, never why it
 * was taken over the alternative, nor what evidence a claim rests on, nor what
 * was deliberately left alone.
 */
export const SUMMARY_RUBRIC = `A session summary is read by whoever picks the work up next — often you, with none of this context. Cover, in this order:

- **Goal** — what this session set out to do, in the terms the work was actually framed in.
- **Accomplished** — what changed. Concrete: what now behaves differently, not "worked on X".
- **Decisions (+why)** — each decision taken AND the reason it beat the alternative you rejected. The code records what was decided; it never records why, and that is the part a later reader most needs.
- **Verified (how)** — what you actually checked and by what means (a command, a test, a measurement). Distinguish "verified" from "believed". If something is unverified, say so.
- **Unfinished (+why)** — what was left incomplete, blocked, or deliberately not done, and why. Silence here reads as "everything is done", which is the most expensive kind of wrong.
- **Files** — the paths that matter, not every path touched.

Be specific over complete: one measured number beats a paragraph of adjectives. Do not restate the diff.`;
