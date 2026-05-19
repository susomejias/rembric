// @rembric-plugin-version 0.7.0
// cwd-spike-result: plan-a
//
// Rembric plugin for opencode (https://opencode.ai).
//
// Distributed as a single .ts file via plugin/.opencode-plugin/install.sh,
// which copies this file to ~/.config/opencode/plugins/rembric.ts and the
// shared bridge to ~/.config/rembric/bin/rembric-bridge.mjs. MCP wiring
// lives in ~/.config/opencode/opencode.json (user-edited, see README).
//
// The plugin handles session lifecycle + passive capture over HTTP. MCP
// memory.* tools are served by the spawned bridge — single source of truth
// for path-scoping via .rembric.
//
// ONLY `RembricPlugin` is exported. opencode iterates every named export
// of a plugin module and invokes each with the plugin ctx — exporting the
// helpers would crash on load. Test mirror lives in `helpers.ts` (sibling
// file, NOT distributed).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
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

function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

function readRembricSlug(directory: string): string | null {
  const file = join(directory, '.rembric');
  if (!existsSync(file)) return null;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const cfg = parseDotenv(raw);
  const slug = cfg.PROJECT_SLUG;
  if (!slug) return null;
  return SLUG_RE.test(slug) ? slug : null;
}

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
