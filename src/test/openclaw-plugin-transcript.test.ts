import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  extractFirstAssistantOpenClaw,
  formatOpenClawTranscript,
  readOpenClawSessionMeta,
} from '../../plugin/.openclaw-plugin/transcript.js';

type ReadSessionMeta = (sessionFile: string) => Promise<{
  sessionId: string;
  cwd: string;
} | null>;
type ReadTranscript = (sessionFile: string) => Promise<string>;

const readSessionMeta = readOpenClawSessionMeta as ReadSessionMeta;
const formatTranscript = formatOpenClawTranscript as ReadTranscript;
const extractFirstAssistant = extractFirstAssistantOpenClaw as ReadTranscript;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const fixturePath = join(repoRoot, 'src', 'test', 'fixtures', 'transcripts', 'openclaw.jsonl');

describe('openclaw plugin transcript helpers', () => {
  it('reads session id and cwd from the OpenClaw session header', async () => {
    await expect(readSessionMeta(fixturePath)).resolves.toEqual({
      sessionId: 'f776edda-9ab1-4306-904b-91a5c4d308bd',
      cwd: '/tmp/rembric-openclaw',
    });
  });

  it('formats only user/assistant text content', async () => {
    await expect(formatTranscript(fixturePath)).resolves.toBe(
      [
        'user: Hola OpenClaw',
        'assistant: Hola. Ya estoy conectado a Rembric.',
        'user: Resume el estado',
        'assistant: Todo listo y funcionando.',
      ].join('\n'),
    );
  });

  it('extracts the first non-empty assistant message as title', async () => {
    await expect(extractFirstAssistant(fixturePath)).resolves.toBe(
      'Hola. Ya estoy conectado a Rembric.',
    );
  });
});
