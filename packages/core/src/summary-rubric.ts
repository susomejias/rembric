/** Section list. Order is the reading order of a handoff, not an importance order. */
export const SUMMARY_SECTIONS = `Use exactly these six Markdown level-2 headings, in this order, each on its own line (never one flat paragraph):
## Goal
## Accomplished
## Decisions+why
## Verified+how
## Unfinished+why
## Files`;

export const SUMMARY_MERGE_RULE = 'The `##` sections you send REPLACE; the ones you omit STAY.';
