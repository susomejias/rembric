// HTTP client for Rembric's non-MCP `/api/<slug>/sessions(*)` lifecycle
// endpoints and the `.rembric::PROJECT_SLUG` parser.
//
// Mirrors the responsibilities of `plugin/scripts/_api.sh` (Claude/Codex)
// and `plugin/.hermes-plugin/__init__.py::_api_post` (Hermes) in plain
// ESM JavaScript. Same HTTP contract; the wire is the source of truth.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Mirror plugin/bin/rembric-bridge.mjs::SLUG_RE so the same `.rembric`
// files work across every client.
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

export function readProjectSlug(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  const file = path.join(cwd, '.rembric');
  if (!existsSync(file)) return null;
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key !== 'PROJECT_SLUG') continue;
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (SLUG_RE.test(val)) return val;
    return null;
  }
  return null;
}

export function createHttpClient({ serverUrl, apiToken, logger, timeoutMs = 5000 }) {
  if (!serverUrl) throw new Error('createHttpClient: serverUrl required');
  if (!apiToken) throw new Error('createHttpClient: apiToken required');
  const base = String(serverUrl).replace(/\/+$/, '');

  async function postJson(pathSuffix, body) {
    const url = `${base}${pathSuffix}`;
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const code = err?.name === 'TimeoutError' ? 'timeout' : 'network_error';
      logger?.warn?.(`rembric http POST ${pathSuffix} ${code}: ${String(err)}`);
      return { ok: false, code, message: String(err) };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // not JSON; keep raw text
      }
      const code = parsed?.code || (res.status >= 500 ? 'server_error' : 'http_error');
      const message = parsed?.message || text || `${res.status}`;
      logger?.warn?.(`rembric http POST ${pathSuffix} ${res.status}: ${message}`);
      return { ok: false, code, message };
    }
    const text = await res.text().catch(() => '');
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { ok: true, data };
  }

  return {
    readProjectSlug,
    /** POST /api/<slug>/sessions  → ensure-session (idempotent). */
    createSession({ slug, id, cwd, agent, description }) {
      return postJson(`/api/${encodeURIComponent(slug)}/sessions`, {
        id,
        cwd,
        agent,
        description,
      });
    },
    /** POST /api/<slug>/sessions/<id>/summary  → per-turn / pre-compact. */
    summarizeSession({ slug, sessionId, summary, title, final }) {
      const body = { summary };
      if (title) body.title = title;
      if (typeof final === 'boolean') body.final = final;
      return postJson(
        `/api/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/summary`,
        body,
      );
    },
    /** POST /api/<slug>/sessions/<id>/end  → final close, status=ended. */
    endSession({ slug, sessionId, summary, title, final }) {
      const body = {};
      if (summary) body.summary = summary;
      if (title) body.title = title;
      if (typeof final === 'boolean') body.final = final;
      return postJson(
        `/api/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/end`,
        body,
      );
    },
  };
}
