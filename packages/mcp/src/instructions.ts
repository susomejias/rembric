import { SUMMARY_MAX_CHARS } from '@rembric/core';
import { SUMMARY_MERGE_RULE, SUMMARY_SECTIONS } from '@rembric/core';

export interface InstructionsContext {
  /** Project slug requested in the URL path; null for `/mcp` connections. */
  requestedSlug: string | null;
}

const BASE = `SAVE: fix/decision/discovery/config/pattern/preference → memory.save(title≤100, content, tags); topic_key?, candidates[]→memory.judge_batch({judgments:[…]}).
Tags required, normally 1–5 useful reusable lowercase Unicode kebab-case: dashboard/sqlite/bug-fix.
Know your sessionId? Pass it; never guess.
RECALL: memory.context/memory.search if you lack prior detail.
READ: memory.get_batch(creation) / memory.session_get_batch(activity): ids OR from/to; full current data/errors, limit≤20, offset=nextOffset until null; all failed=isError.
SUMMARIZE: Before ending each working turn: memory.session_summary(title≤100, summary≤${SUMMARY_MAX_CHARS}). ${SUMMARY_MERGE_RULE} Current state first: ${SUMMARY_SECTIONS}
memory.about.`;

const PATH_SCOPED_NOTE = (slug: string) => `\n\nproject '${slug}'.`;

// Names no retired scope; confirmSwitch is documented in project.use's description.
const UNSCOPED_NOTE = `\n\nProject always active: roots or default project; project.use to switch.`;

export function buildInstructions(ctx: InstructionsContext): string {
  return ctx.requestedSlug ? BASE + PATH_SCOPED_NOTE(ctx.requestedSlug) : BASE + UNSCOPED_NOTE;
}

export const INSTRUCTIONS_MAX_LENGTH = 1000;
