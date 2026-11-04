import { SUMMARY_MAX_CHARS } from '@rembric/core';
import { SUMMARY_MERGE_RULE, SUMMARY_SECTIONS } from '@rembric/core';

export interface InstructionsContext {
  /** Project slug requested in the URL path; null for `/mcp` connections. */
  requestedSlug: string | null;
}

const BASE = `Rembric is this project's long-term memory: only what you write to it outlives this conversation. Run this loop yourself; host reminders may help, never wait for them.
RECALL: memory.context/memory.search for new-area/diagnosis/recall if you lack prior detail.
SAVE: fix/decision/discovery/config/pattern/preference→memory.save(title≤100,content,tags) as soon as it is settled, not at the end: one fact per memory, written so a later session can act on it without this chat. A session summary never replaces it. topic_key? updates an evolving fact; candidates[]→memory.judge_batch({judgments:[…]}).
Tags required, normally 1–5 useful reusable lowercase ASCII kebab-case: dashboard/sqlite/bug-fix.
Pass known sessionId; never guess.
READ:memory.get_batch(creation)/memory.session_get_batch(activity):ids OR from/to;full current data/errors,limit≤20,offset=nextOffset until null;all failed=isError.
SUMMARIZE: Before ending each work turn: memory.session_summary(title≤100,summary≤${SUMMARY_MAX_CHARS}). ${SUMMARY_MERGE_RULE} Current state first: ${SUMMARY_SECTIONS}
session_not_found (no host registered one)→memory.session_start once, then retry.
memory.about`;

const PATH_SCOPED_NOTE = (slug: string) => `\n\nproject '${slug}'.`;

// Names no retired scope; confirmSwitch is documented in project.use's description.
const UNSCOPED_NOTE = `\n\nProject always active: roots or default project; project.use to switch.`;

export function buildInstructions(ctx: InstructionsContext): string {
  return ctx.requestedSlug ? BASE + PATH_SCOPED_NOTE(ctx.requestedSlug) : BASE + UNSCOPED_NOTE;
}

export const INSTRUCTIONS_MAX_LENGTH = 1500;
