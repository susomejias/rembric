/**
 * Build the MCP `initialize.instructions` block.
 *
 * Supported clients (Claude Code, Codex CLI) inject this string directly
 * into the LLM's system prompt. Hard constraint: ≤ 800 characters per
 * variant — verified by a unit test. Anything longer is either bug or
 * documentation creep.
 *
 * Two variants per scope (project-scoped vs unscoped). The body is the
 * same crib-sheet protocol; only the trailing scope note diverges.
 */

export interface InstructionsContext {
  /** Project slug requested in the URL path; null for `/mcp` connections. */
  requestedSlug: string | null;
}

const BASE = `Rembric memory.

Call memory.save right after: bug fix · decision · discovery · config change · pattern · user preference. If the same topic is evolving, pass topic_key (or call memory.suggest_topic_key first) so the previous row supersedes atomically. When save returns candidates[], close each with memory.judge.
Call memory.search when the user references past work or asks "what did we do".
Call memory.session_summary({title, summary≤2000 chars}) before saying "done": title ≤100 chars (real work, not cwd). Summary covers Goal · Discoveries · Accomplished · Next Steps · Files.`;

const PATH_SCOPED_NOTE = (slug: string) =>
  `\n\nThis connection is path-scoped to '${slug}'. scope='global' is rejected; open /mcp for user-wide memory.`;

const UNSCOPED_NOTE = `\n\nProject scope: auto-detected from your client's MCP roots when supported. Otherwise call project.use({slug, create:true}) to pin (and create on first use). project.current reports the active project.`;

export function buildInstructions(ctx: InstructionsContext): string {
  return ctx.requestedSlug ? BASE + PATH_SCOPED_NOTE(ctx.requestedSlug) : BASE + UNSCOPED_NOTE;
}

/** Hard limit; CI test enforces. */
export const INSTRUCTIONS_MAX_LENGTH = 800;
