import { readFile } from 'node:fs/promises';

const TRANSCRIPT_MAX_CHARS = 19500;
const TITLE_MAX_CHARS = 100;

function truncateTranscript(text) {
  if (!text) return '';
  return text.length > TRANSCRIPT_MAX_CHARS ? text.slice(-TRANSCRIPT_MAX_CHARS) : text;
}

function finalizeTitle(text) {
  if (!text) return '';
  return text.slice(0, TITLE_MAX_CHARS).replace(/[\n\r\t]+/g, ' ');
}

function extractText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((item) => item && (item.type === 'text' || Object.hasOwn(item, 'text')))
    .map((item) => (typeof item.text === 'string' ? item.text : ''))
    .join(' ')
    .trim();
}

export async function readOpenClawSessionMeta(sessionFile) {
  if (!sessionFile) return null;
  let raw;
  try {
    raw = await readFile(sessionFile, 'utf8');
  } catch {
    return null;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.type === 'session' && typeof row.id === 'string') {
        return {
          sessionId: row.id,
          cwd: typeof row.cwd === 'string' ? row.cwd : '',
        };
      }
    } catch {
      // ignore malformed rows defensively
    }
  }
  return null;
}

export async function formatOpenClawTranscript(sessionFile) {
  if (!sessionFile) return '';
  let raw;
  try {
    raw = await readFile(sessionFile, 'utf8');
  } catch {
    return '';
  }

  const lines = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.type !== 'message') continue;
      const role = row?.message?.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const text = extractText(row?.message?.content).trim();
      if (!text) continue;
      lines.push(`${role}: ${text}`);
    } catch {
      // ignore malformed rows defensively
    }
  }

  return truncateTranscript(lines.join('\n'));
}

export async function extractFirstAssistantOpenClaw(sessionFile) {
  if (!sessionFile) return '';
  let raw;
  try {
    raw = await readFile(sessionFile, 'utf8');
  } catch {
    return '';
  }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.type !== 'message' || row?.message?.role !== 'assistant') continue;
      const text = extractText(row?.message?.content).trim();
      if (!text) continue;
      return finalizeTitle(text);
    } catch {
      // ignore malformed rows defensively
    }
  }

  return '';
}
