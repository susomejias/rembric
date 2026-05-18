import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

import {
  extractFirstAssistantOpenClaw,
  formatOpenClawTranscript,
  readOpenClawSessionMeta,
} from './transcript.js';

const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

function normalizeServerUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  return value
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/mcp$/, '');
}

async function readProjectSlug(cwd) {
  if (!cwd) return '';
  try {
    const raw = await readFile(join(cwd, '.rembric'), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^PROJECT_SLUG\s*=\s*(.+?)\s*$/);
      if (!match) continue;
      const slug = match[1].replace(/^['"]|['"]$/g, '');
      return SLUG_RE.test(slug) ? slug : '';
    }
  } catch {
    return '';
  }
  return '';
}

async function postJson({ serverUrl, apiToken, path, body, logger }) {
  try {
    const response = await fetch(`${serverUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      logger?.debug?.(`rembric-openclaw POST ${path} failed: HTTP ${response.status}`);
    }
  } catch (error) {
    logger?.debug?.(`rembric-openclaw POST ${path} failed: ${String(error)}`);
  }
}

export default definePluginEntry({
  id: 'rembric-openclaw',
  name: 'Rembric OpenClaw',
  description: 'Tracks OpenClaw session lifecycle in Rembric.',
  register(api) {
    const config = api.pluginConfig ?? {};
    const serverUrl = normalizeServerUrl(config.serverUrl);
    const apiToken = typeof config.apiToken === 'string' ? config.apiToken.trim() : '';
    const agentName =
      typeof config.agentName === 'string' && config.agentName.trim()
        ? config.agentName.trim()
        : 'openclaw';

    if (!serverUrl || !apiToken) {
      api.logger.debug('rembric-openclaw disabled: missing serverUrl or apiToken');
      return;
    }

    const ensureSession = async ({ sessionId, cwd, slug }) => {
      if (!sessionId || !cwd || !slug) return;
      await postJson({
        serverUrl,
        apiToken,
        path: `/api/${slug}/sessions`,
        body: { id: sessionId, cwd, agent: agentName },
        logger: api.logger,
      });
    };

    api.on('before_agent_finalize', async (event) => {
      const slug = await readProjectSlug(event.cwd);
      if (!slug) return;
      await ensureSession({ sessionId: event.sessionId, cwd: event.cwd, slug });
    });

    api.on('before_compaction', async (event) => {
      const meta = await readOpenClawSessionMeta(event.sessionFile);
      if (!meta?.sessionId || !meta.cwd) return;
      const slug = await readProjectSlug(meta.cwd);
      if (!slug) return;

      await ensureSession({ sessionId: meta.sessionId, cwd: meta.cwd, slug });

      const summary = await formatOpenClawTranscript(event.sessionFile);
      if (!summary) return;
      const title = await extractFirstAssistantOpenClaw(event.sessionFile);

      await postJson({
        serverUrl,
        apiToken,
        path: `/api/${slug}/sessions/${meta.sessionId}/summary`,
        body: title ? { summary, title, final: false } : { summary, final: false },
        logger: api.logger,
      });
    });

    api.on('session_end', async (event) => {
      const meta = await readOpenClawSessionMeta(event.sessionFile);
      if (!meta?.sessionId || !meta.cwd) return;
      const slug = await readProjectSlug(meta.cwd);
      if (!slug) return;

      await ensureSession({ sessionId: meta.sessionId, cwd: meta.cwd, slug });

      const summary = await formatOpenClawTranscript(event.sessionFile);
      const title = summary ? await extractFirstAssistantOpenClaw(event.sessionFile) : '';

      await postJson({
        serverUrl,
        apiToken,
        path: `/api/${slug}/sessions/${meta.sessionId}/end`,
        body: summary ? (title ? { summary, title, final: false } : { summary, final: false }) : {},
        logger: api.logger,
      });
    });
  },
});
