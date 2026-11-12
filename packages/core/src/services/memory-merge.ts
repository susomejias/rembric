import { createHash } from 'node:crypto';

import { type Memory, type MemorySource, type MemoryType } from '@rembric/db';

import { type ReviewState } from './review.js';
import { sliceWithoutSplittingSurrogatePair } from './strings.js';

export const MERGE_MIN_IDS = 2;
// Equal to PREDECESSOR_CAP, so the successor's history lists every original.
export const MERGE_MAX_IDS = 10;
export const MERGE_PREVIEW_CHARS = 300;

export interface MergeMemoriesInput {
  ids: readonly string[];
  type: MemoryType;
  title: string;
  content: string;
  tags?: string[];
  topicKey?: string | null;
  source?: MemorySource;
  sessionId?: string | null;
}

export type MergeWarningCode =
  | 'topic_keys_dropped'
  | 'needs_review'
  | 'pending_judgments'
  | 'type_changed';

export interface MergeWarning {
  code: MergeWarningCode;
  ids: string[];
  message: string;
}

export interface MergeOriginalView {
  id: string;
  type: MemoryType;
  title: string;
  status: Memory['status'];
  topicKey: string | null;
  tags: string[];
  createdAt: Date;
  contentPreview: string;
  contentTruncated: boolean;
  reviewState: ReviewState | null;
}

export interface MergeSuccessorView {
  type: MemoryType;
  title: string;
  content: string;
  tags: string[];
  topicKey: string | null;
  replaces: string[];
}

export interface MergePreview {
  originals: MergeOriginalView[];
  successor: MergeSuccessorView;
  warnings: MergeWarning[];
  fingerprint: string;
}

export interface MergeResult {
  memory: Memory;
  opId: string;
  preview: MergePreview;
}

export function toOriginalView(m: Memory, reviewState: ReviewState | null): MergeOriginalView {
  const contentPreview = sliceWithoutSplittingSurrogatePair(m.content, MERGE_PREVIEW_CHARS);
  return {
    id: m.id,
    type: m.type,
    title: m.title,
    status: m.status,
    topicKey: m.topicKey,
    tags: m.tags,
    createdAt: m.createdAt,
    contentPreview,
    contentTruncated: contentPreview.length < m.content.length,
    reviewState,
  };
}

export function mergeFingerprint(
  originals: readonly Memory[],
  successor: MergeSuccessorView,
  warnings: readonly MergeWarning[],
): string {
  const canonical = JSON.stringify({
    v: 1,
    successor: [
      successor.type,
      successor.title,
      successor.content,
      successor.tags,
      successor.topicKey,
      successor.replaces,
    ],
    originals: originals.map((m) => [
      m.id,
      m.status,
      m.type,
      m.title,
      m.content,
      m.tags,
      m.topicKey,
      m.replaces,
    ]),
    warnings: warnings.map((w) => [w.code, w.ids]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
