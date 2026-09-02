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
        
SAVE: fix/decision/discovery/config/pattern/preference → memory.save(title≤100, content); evolving topic: topic_key, candidates[]→memory.judge.
RECALL: before work in an area untouched this session, before diagnosing a possibly-known error, before building something that may already exist — or asked to recall: call memory.context (memory.search for keywords) if you lack prior detail.
SUMMARIZE: Before ending a working turn with real work, call memory.session_summary({title≤100, summary≤${SUMMARY_MAX_CHARS}}) — ${SUMMARY_MERGE_RULE} Current state first: ${SUMMARY_SECTIONS}
memory.about.`;

const PATH_SCOPED_NOTE = (slug: string) =>
  `\n\nproject '${slug}': all save/recall here belongs to it.`;

// Names no retired scope; confirmSwitch restated in memory.save description.
const UNSCOPED_NOTE = `\n\nA project is always active: MCP roots (if any), else the default project. project.current; project.use to switch.`;
// BASE string length at build time: ~870 chars / 1000 (proactive-recall swap);

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
