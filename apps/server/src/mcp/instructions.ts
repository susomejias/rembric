/**
 * Build the MCP `initialize.instructions` block.
 *
 * All four clients (Claude Code, Codex CLI, Hermes Agent, opencode) inject
 * this string into the LLM's system prompt on connect; for in-process
 * clients with no per-turn hook it is the ONLY nudging surface. The block
 * is a directive crib-sheet of three proactive flows (SAVE / RECALL /
 * SUMMARIZE) that cite their tools; precise mechanics live in each tool's
 * own `description`.
 *
 * Two variants per scope (project-scoped vs unscoped). The body is the
 * same protocol; only the trailing scope note diverges.
 */

import { SUMMARY_MAX_CHARS } from '../services/agent-sessions.js';

export interface InstructionsContext {
  /** Project slug requested in the URL path; null for `/mcp` connections. */
  requestedSlug: string | null;
}

const BASE = `Rembric — persistent memory across sessions. Use tools proactively; each description has exact mechanics.

SAVE: the moment it happens — bug fix · decision · discovery · config · pattern · preference — call memory.save with a title≤100 headline + content (don't batch). Evolving a prior topic? pass topic_key; resolve candidates[] with memory.judge.
RECALL: starting/resuming work, after /compact, or asked "what did we do"? Call memory.context (memory.search for keyword lookup) if you lack prior detail.
SUMMARIZE: did real work happen? Before ending, you MUST call memory.session_summary({title≤100 (the work, not cwd), summary≤${SUMMARY_MAX_CHARS}}) — Goal · Discoveries · Accomplished · Next Steps · Files. Trivial? Skip.
Know your sessionId? Pass it — never guess it.
Update Rembric: memory.about.`;

const PATH_SCOPED_NOTE = (slug: string) =>
  `\n\nThis connection is path-scoped to '${slug}'. scope='global' is rejected; open /mcp for user-wide memory.`;

const UNSCOPED_NOTE = `\n\nProject scope: auto-detected from your client's MCP roots when supported. Otherwise call project.use({slug, autocreate:true}) to pin (and create on first use). project.current reports the active project.`;

export function buildInstructions(ctx: InstructionsContext): string {
  return ctx.requestedSlug ? BASE + PATH_SCOPED_NOTE(ctx.requestedSlug) : BASE + UNSCOPED_NOTE;
}

/**
 * Self-imposed token budget, NOT a client or protocol limit: the MCP spec
 * defines `InitializeResult.instructions` as a free-form string with no max
 * length, and none of the four clients truncates it. The cap exists only to
 * keep the system-prompt cost bounded and guard against doc-creep. CI test
 * (`instructions.test.ts`) enforces it against both variants.
 */
export const INSTRUCTIONS_MAX_LENGTH = 1000;
