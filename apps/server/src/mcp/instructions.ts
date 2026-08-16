/**
 * Build the MCP `initialize.instructions` block.
 *
 * Clients that consume the block — Claude Code, Codex CLI and Pi among
 * them — inject this string into the LLM's system prompt on connect. Pi
 * holds the MCP client itself and appends the string to the harness's
 * own system prompt each turn. Hermes never reads the block: its Python
 * provider restates this text from `system_prompt_block`, and that copy
 * MUST stay byte-identical, so an edit here is an edit there too.
 *
 * The block is a directive crib-sheet of
 * three proactive flows (SAVE / RECALL / SUMMARIZE) that cite their
 * tools; precise mechanics live in each tool's own `description`.
 *
 * Two variants per scope (project-scoped vs unscoped). The body is the
 * same protocol; only the trailing scope note diverges.
 */

import { SUMMARY_MAX_CHARS } from '../services/agent-sessions.js';

import { SUMMARY_MERGE_RULE, SUMMARY_SECTIONS } from './summary-rubric.js';

export interface InstructionsContext {
  /** Project slug requested in the URL path; null for `/mcp` connections. */
  requestedSlug: string | null;
}

const BASE = `Rembric — persistent memory. Use tools proactively.

SAVE: On each real fix/decision/discovery/config/pattern/preference, call memory.save(title≤100, content); evolving topic: topic_key, candidates[]→memory.judge.
RECALL: Starting/resuming, after /compact, or asked what did we do: call memory.context (memory.search for keywords) if you lack prior detail.
SUMMARIZE: Before ending each working turn with real work, MUST call memory.session_summary({title≤100, summary≤${SUMMARY_MAX_CHARS}}) — ${SUMMARY_MERGE_RULE} Current state first: ${SUMMARY_SECTIONS}
Know your sessionId? Pass it; never guess.
Update: memory.about.`;

const PATH_SCOPED_NOTE = (slug: string) =>
  `\n\nThis connection is bound to project '${slug}': everything you save or recall here belongs to it, and no argument reaches another project.`;

// Names `project.use` without restating its flags: the copy here omitted
// `confirmSwitch`, which the tool's own description names as required to switch.
const UNSCOPED_NOTE = `\n\nA project is always active here: your client's MCP roots when supported, otherwise the default project. project.current names it; project.use switches it.`;

export function buildInstructions(ctx: InstructionsContext): string {
  return ctx.requestedSlug ? BASE + PATH_SCOPED_NOTE(ctx.requestedSlug) : BASE + UNSCOPED_NOTE;
}

/**
 * Self-imposed token budget, not the binding limit: the MCP spec defines
 * `InitializeResult.instructions` as a free-form string with no max length, and
 * Claude Code truncates it at 2048 — the same `LB` it applies to tool
 * descriptions (see DESCRIPTION_MAX_LENGTH) — so this cap binds first. It
 * exists to keep the system-prompt cost bounded and guard against doc-creep.
 * CI test (`instructions.test.ts`) enforces it against both variants.
 */
export const INSTRUCTIONS_MAX_LENGTH = 1000;
