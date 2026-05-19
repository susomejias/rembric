// @rembric-plugin-version 0.7.0
// cwd-spike-result: plan-a
//
// Rembric plugin for opencode (https://opencode.ai).
//
// Distributed as a single .ts file via plugin/.opencode-plugin/install.sh,
// which copies this file to ~/.config/opencode/plugins/rembric.ts, the
// shared bridge to ~/.config/rembric/bin/rembric-bridge.mjs, and the
// shared dotenv lib to ~/.config/rembric/bin/rembric-dotenv.mjs. MCP
// wiring lives in ~/.config/opencode/opencode.json (user-edited, see
// README).
//
// The plugin handles session lifecycle over HTTP. MCP memory.* tools
// are served by the spawned bridge — single source of truth for
// path-scoping via .rembric.
//
// Slug-resolution helpers (`parseDotenv`, `readRembricSlug`, `SLUG_RE`)
// live in `rembric-dotenv.mjs`, the same module the bridge imports. The
// import path below is patched by install.sh: at source time it is the
// relative `../bin/rembric-dotenv.mjs` (resolves for `pnpm vitest` and
// `tsc --noEmit` against the monorepo layout). install.sh rewrites it to
// the absolute installed path before copying this file to the user's
// machine.
//
// ONLY `RembricPlugin` is exported. opencode iterates every named export
// of a plugin module and invokes each with the plugin ctx — exporting
// helpers (or re-exporting from the dotenv lib) would crash on load.

import { readRembricSlug } from '../bin/rembric-dotenv.mjs';

const POST_TIMEOUT_MS = 3000;

type EventInput = {
  event: {
    type: string;
    properties?: Record<string, unknown>;
  };
};

type CompactingInput = { sessionID?: string };
type CompactingOutput = { context: string[] };

type PluginContext = { directory: string };

type PluginReturn = {
  event?: (input: EventInput) => Promise<void>;
  'experimental.session.compacting'?: (
    input: CompactingInput,
    output: CompactingOutput,
  ) => Promise<void>;
};

type Plugin = (ctx: PluginContext) => Promise<PluginReturn>;

function diag(line: string): void {
  process.stderr.write(`[rembric] ${line}\n`);
}

export const RembricPlugin: Plugin = async (ctx) => {
  const serverUrl = process.env.REMBRIC_SERVER_URL;
  const apiToken = process.env.REMBRIC_API_TOKEN;
  const slug = readRembricSlug(ctx.directory);

  const disabled = !serverUrl || !apiToken;
  if (disabled) {
    diag('REMBRIC_SERVER_URL or REMBRIC_API_TOKEN missing; plugin disabled');
  }

  const knownSessions = new Set<string>();
  const subAgentSessions = new Set<string>();

  const baseUrl = serverUrl ? serverUrl.replace(/\/$/, '') : '';

  async function rembricPost(path: string, body: unknown): Promise<void> {
    if (disabled || !slug) return;
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      if (!res.ok) {
        diag(`POST ${path} ${res.status}`);
      }
    } catch (err) {
      diag(`POST ${path} ${(err as Error).message ?? 'error'}`);
    }
  }

  async function ensureSession(sessionId: string): Promise<void> {
    if (!sessionId) return;
    if (subAgentSessions.has(sessionId)) return;
    if (knownSessions.has(sessionId)) return;
    knownSessions.add(sessionId);

    const body: Record<string, unknown> = {
      id: sessionId,
      agent: 'opencode',
    };
    if (ctx.directory) body.cwd = ctx.directory;

    await rembricPost(`/api/${slug}/sessions`, body);
  }

  return {
    event: async ({ event }) => {
      if (event.type === 'session.created') {
        const info = (event.properties?.info ?? {}) as {
          id?: string;
          parentID?: string;
          title?: string;
        };
        const sessionId = info.id ?? '';
        const parentID = info.parentID ?? '';
        const title = info.title ?? '';
        const isSubAgent = Boolean(parentID) || title.endsWith(' subagent)');

        diag(
          `session.created id=${sessionId} parentID=${parentID} title=${title} subagent=${isSubAgent}`,
        );

        if (!sessionId) return;
        if (isSubAgent) {
          subAgentSessions.add(sessionId);
          return;
        }
        await ensureSession(sessionId);
      }

      if (event.type === 'session.deleted') {
        const info = (event.properties?.info ?? {}) as { id?: string };
        const sessionId = info.id ?? '';
        if (!sessionId) return;
        knownSessions.delete(sessionId);
        subAgentSessions.delete(sessionId);
      }
    },

    'experimental.session.compacting': async (input, output) => {
      if (input.sessionID) {
        await ensureSession(input.sessionID);
      }

      output.context.push(
        'CRITICAL INSTRUCTION FOR THE POST-COMPACTION AGENT:\n' +
          'You have Rembric persistent memory available via MCP tools. As your FIRST action, ' +
          `call \`memory.session_summary\` with the content of the compacted summary above. ` +
          (slug ? `Use project: '${slug}'. ` : '') +
          'This preserves what was accomplished before compaction. ' +
          'Without this step, everything done before compaction is lost from memory.',
      );
    },
  };
};
