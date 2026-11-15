import type { MemorySource, Scope } from '@rembric/db';

import { deriveTitle, normalizeTag, type MemoryService } from './memory.js';
import {
  runPostSaveSteps,
  type PostSaveDeps,
  type RelatedMemoryView,
  type SaveTimeCandidateView,
} from './save-curation.js';
import { RedactionTally } from './secret-redaction.js';

export const KEY_LEARNINGS_HEADING_HINT = '## Key Learnings' as const;
export const CAPTURE_TEXT_MAX_CODE_POINTS = 50_000;
export const SUBAGENT_LEARNING_TAG = 'subagent-learning' as const;

const KEY_LEARNINGS_RE = /^(#{2,3})[ \t]*key learnings:?[ \t]*$/im;
const NEXT_HEADING_RE = /^#{2,3}[ \t]/m;
const LIST_ITEM_RE = /^(?:\s*(?:-|\*|\d+\.)\s+)(.+?)\s*$/gm;

export function parseKeyLearnings(text: string): string[] {
  const match = KEY_LEARNINGS_RE.exec(text);
  if (!match || match.index === undefined) return [];
  const after = text.slice(match.index + match[0].length);
  const nextHeading = after.search(NEXT_HEADING_RE);
  const section = nextHeading === -1 ? after : after.slice(0, nextHeading);
  LIST_ITEM_RE.lastIndex = 0;
  const items: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = LIST_ITEM_RE.exec(section)) !== null) {
    const v = (m[1] ?? '').trim();
    if (v.length > 0) items.push(v);
  }
  return items;
}

export function lastCodePoints(text: string, max: number): string {
  let start = text.length;
  for (let kept = 0; kept < max && start > 0; kept += 1) {
    const low = text.charCodeAt(start - 1);
    const high = start >= 2 ? text.charCodeAt(start - 2) : 0;
    const pair = low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff;
    start -= pair ? 2 : 1;
  }
  return text.slice(start);
}

export function subagentLearningTags(agentType: string | undefined): string[] {
  const agentTag = agentType === undefined ? '' : normalizeTag(agentType, new RedactionTally());
  return agentTag.length > 0 ? [SUBAGENT_LEARNING_TAG, agentTag] : [SUBAGENT_LEARNING_TAG];
}

export interface CaptureKeyLearningsDeps extends PostSaveDeps {
  memory: MemoryService;
}

export interface CaptureKeyLearningsInput {
  text: string;
  tags: readonly string[] | undefined;
  resolveSessionId: () => string | null;
  source: MemorySource;
}

export interface CaptureKeyLearningsResult {
  saved: number;
  skipped: number;
  ids: string[];
  candidates: SaveTimeCandidateView[];
  related: RelatedMemoryView[];
  convergeWith: string[];
  candidatesDetected: number;
  reason?: string;
}

export async function captureKeyLearnings(
  deps: CaptureKeyLearningsDeps,
  input: CaptureKeyLearningsInput,
  scope: Scope,
  redactions: RedactionTally = new RedactionTally(),
): Promise<CaptureKeyLearningsResult> {
  const result: CaptureKeyLearningsResult = {
    saved: 0,
    skipped: 0,
    ids: [],
    candidates: [],
    related: [],
    convergeWith: [],
    candidatesDetected: 0,
  };
  const items = parseKeyLearnings(input.text);
  if (items.length === 0) {
    result.reason = `No "${KEY_LEARNINGS_HEADING_HINT}" (or "###") section found; nothing was extracted.`;
    return result;
  }
  const sessionId = input.resolveSessionId();
  for (const content of items) {
    const saved = deps.memory.saveUnlessSessionDuplicate(
      {
        type: 'reference',
        title: deriveTitle(redactions.redact(content)),
        content,
        tags: input.tags ? [...input.tags] : undefined,
        source: input.source,
        sessionId,
      },
      scope,
      redactions,
    );
    if (saved === null) {
      result.skipped += 1;
      continue;
    }
    const post = await runPostSaveSteps(deps, saved.memory, scope);
    result.ids.push(saved.memory.id);
    result.candidates.push(...post.candidates);
    result.related.push(...post.related);
    result.convergeWith.push(...post.convergeWith);
    result.candidatesDetected += post.candidatesDetected;
  }
  result.saved = result.ids.length;
  if (result.saved === 0) {
    result.reason = `All ${result.skipped} learnings were already captured in this session; nothing new was saved.`;
  }
  return result;
}
