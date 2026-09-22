import { SUMMARY_MAX_CHARS } from '@rembric/core';
import { SUMMARY_MERGE_RULE, SUMMARY_SECTIONS } from '@rembric/core';

export interface InstructionsContext {
  /** Project slug requested in the URL path; null for `/mcp` connections. */
  requestedSlug: string | null;
}

const BASE = `Rembric — persistent memory. Use tools proactively.
SAVE: fix/decision/discovery/config/pattern/preference → memory.save(title≤100, content); topic: topic_key, candidates[]→memory.judge.
Know your sessionId? Pass it; never guess.
RECALL: before work in an area untouched this session, before diagnosing a possibly-known error, before building something that may already exist — or asked to recall: call memory.context (memory.search for keywords) if you lack prior detail.
SUMMARIZE: Before ending a working turn with real work, call memory.session_summary({title≤100, summary≤${SUMMARY_MAX_CHARS}}) — ${SUMMARY_MERGE_RULE} Current state first: ${SUMMARY_SECTIONS}
memory.about.`;

const PATH_SCOPED_NOTE = (slug: string) =>
  `\n\nproject '${slug}': all save/recall here belongs to it.`;

// Names no retired scope; confirmSwitch is documented in project.use's description.
const UNSCOPED_NOTE = `\n\nA project is always active: MCP roots (if any), else the default project. project.current; project.use to switch.`;
// BASE string length at build time: ~870 chars / 1000 (proactive-recall swap);

export function buildInstructions(ctx: InstructionsContext): string {
  return ctx.requestedSlug ? BASE + PATH_SCOPED_NOTE(ctx.requestedSlug) : BASE + UNSCOPED_NOTE;
}

export const INSTRUCTIONS_MAX_LENGTH = 1000;
