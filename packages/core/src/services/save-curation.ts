import type { Memory, Repositories, Scope } from '@rembric/db';

import { extractEntities, type ExtractedEntity } from './entities.js';
import type { RelationsService } from './relations.js';
import {
  findSaveTimeCandidates,
  type CandidateOptions,
  type SaveCandidate,
} from './save-time-candidates.js';

export interface SaveTimeCandidateView {
  judgmentId: string;
  targetId: string;
  title: string;
  snippet: string;
  similarity: number;
  source: 'vec' | 'fts' | 'entity';
  topicKey: string | null;
  /** Set only for `source: 'entity'` — the value both memories share. */
  entityValue?: string;
}

export type RelatedMemoryView = Omit<SaveTimeCandidateView, 'judgmentId'>;

export interface PostSaveDeps {
  relations?: RelationsService;
  candidates?: CandidateOptions;
  repos?: Pick<Repositories, 'memory' | 'relations' | 'vectors' | 'entities' | 'termStatistics'>;
  embedNow?: (
    memoryId: string,
    title: string,
    content: string,
    projectId: string,
  ) => Promise<boolean>;
}

export interface PostSaveResult {
  candidates: SaveTimeCandidateView[];
  related: RelatedMemoryView[];
  /** Target ids of the high-band entries of `candidates`. */
  convergeWith: string[];
  candidatesDetected: number;
}

export async function runPostSaveSteps(
  deps: PostSaveDeps,
  m: Memory,
  scope: Scope,
): Promise<PostSaveResult> {
  const extractedEntities: ExtractedEntity[] = extractEntities(m.title, m.content);

  let candidates: SaveTimeCandidateView[] = [];
  let related: RelatedMemoryView[] = [];
  let convergeWith: string[] = [];
  let candidatesDetected = 0;
  if (deps.repos && deps.relations && deps.candidates && deps.candidates.perSaveMax > 0) {
    try {
      if (deps.embedNow) await deps.embedNow(m.id, m.title, m.content, scope.projectId);
      const found = findSaveTimeCandidates(deps.repos, m, deps.candidates, extractedEntities);
      candidatesDetected = found.detected;
      related = found.related.map(view);
      for (const c of found.candidates) {
        const row = deps.relations.createPending({
          sourceId: m.id,
          targetId: c.targetId,
        });
        candidates.push({ judgmentId: row.judgmentId, ...view(c) });
        if (c.band === 'high') convergeWith.push(c.targetId);
      }
    } catch {
      candidates = [];
      related = [];
      convergeWith = [];
      candidatesDetected = 0;
    }
  }

  if (deps.repos) {
    try {
      deps.repos.entities.linkMemory(m.id, scope.projectId, extractedEntities, m.createdAt);
    } catch {
      // Extraction/linking failure must never fail the save.
    }
  }

  return { candidates, related, convergeWith, candidatesDetected };
}

function view(c: SaveCandidate): RelatedMemoryView {
  return {
    targetId: c.targetId,
    title: c.title,
    snippet: c.snippet,
    similarity: c.similarity,
    source: c.source,
    topicKey: c.topicKey,
    ...(c.entityValue ? { entityValue: c.entityValue } : {}),
  };
}
