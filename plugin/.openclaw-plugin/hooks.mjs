// Session lifecycle hook handlers.
//
// Wires `session_start`, `session_end`, `before_compaction`, and
// `after_compaction` to Rembric's `/api/<slug>/sessions(*)` HTTP API.
// Handlers NEVER throw out of the hook — host stability wins over POST
// success. Errors are logged via `api.logger` and swallowed.

const AGENT = 'openclaw';

function pickSessionId(event) {
  return event?.sessionId || event?.session_id || event?.sessionKey || event?.runId || null;
}

function pickCwd(event) {
  return event?.cwd || event?.context?.workspaceDir || event?.workspaceDir || null;
}

function pickTranscript(event) {
  if (typeof event?.transcript === 'string' && event.transcript.trim()) return event.transcript;
  if (typeof event?.summary === 'string' && event.summary.trim()) return event.summary;
  // Fallback: stitch from messages array if present.
  if (Array.isArray(event?.messages)) {
    const lines = [];
    for (const m of event.messages) {
      if (!m || typeof m !== 'object') continue;
      const role = m.role || 'unknown';
      const text =
        typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
                .map((b) => b.text)
                .join('\n')
            : '';
      if (text) lines.push(`[${role}] ${text}`);
    }
    if (lines.length) return lines.join('\n\n');
  }
  return '';
}

function pickTitle(event) {
  if (typeof event?.title === 'string' && event.title.trim()) {
    return event.title.slice(0, 100);
  }
  return null;
}

export function registerHooks(api, httpClient, { projectSlug = null } = {}) {
  // Resolution order: explicit config.project_slug > per-cwd .rembric file.
  // The explicit config wins because it's a deliberate operator choice;
  // the .rembric fallback covers the multi-project workflow.
  function resolveSlug(cwd) {
    if (projectSlug) return projectSlug;
    return cwd ? httpClient.readProjectSlug(cwd) : null;
  }

  api.on('session_start', async (event) => {
    try {
      const id = pickSessionId(event);
      const cwd = pickCwd(event);
      if (!id) {
        api.logger?.debug?.('rembric session_start: missing sessionId, skipping');
        return;
      }
      const slug = resolveSlug(cwd);
      if (!slug) {
        api.logger?.debug?.(
          `rembric session_start: no slug (config or .rembric in ${cwd}), skipping POST`,
        );
        return;
      }
      await httpClient.createSession({ slug, id, cwd, agent: AGENT });
    } catch (err) {
      api.logger?.warn?.(`rembric session_start handler: ${String(err)}`);
    }
  });

  api.on('session_end', async (event) => {
    try {
      const id = pickSessionId(event);
      const cwd = pickCwd(event);
      if (!id) return;
      const slug = resolveSlug(cwd);
      if (!slug) return;
      const summary = pickTranscript(event);
      const title = pickTitle(event);
      await httpClient.endSession({
        slug,
        sessionId: id,
        summary: summary || undefined,
        title: title || undefined,
        final: false,
      });
    } catch (err) {
      api.logger?.warn?.(`rembric session_end handler: ${String(err)}`);
    }
  });

  const compactionHandler = async (event) => {
    try {
      const id = pickSessionId(event);
      const cwd = pickCwd(event);
      if (!id) return;
      const slug = resolveSlug(cwd);
      if (!slug) return;
      const summary = pickTranscript(event);
      if (!summary) return;
      await httpClient.summarizeSession({
        slug,
        sessionId: id,
        summary,
        final: false,
      });
    } catch (err) {
      api.logger?.warn?.(`rembric compaction handler: ${String(err)}`);
    }
  };

  api.on('before_compaction', compactionHandler);
  api.on('after_compaction', compactionHandler);
}
