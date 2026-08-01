import { CANDIDATES_PER_SAVE_MAX_DEFAULT } from '../../config.js';
import { createRepositories } from '../../db/index.js';
import type { Repositories } from '../../db/repositories/index.js';
import { type Embedder, embeddingQueryInput } from '../../embeddings/embedder.js';
import { saveMemoryWithCandidates } from '../../mcp/memory-tools.js';
import { EmbeddingWorker } from '../../services/embedding-worker.js';
import { MemoryService } from '../../services/memory.js';
import { ProjectsService } from '../../services/projects.js';
import { RelationsService } from '../../services/relations.js';
import { SCOPE_GLOBAL, projectScope, type Scope } from '../../services/scope.js';
import { TestClock } from '../clock.js';
import { createTestDb } from '../db.js';

import { PROJECTS } from './corpus.js';
import type { CorpusItem, IngestedCorpus, IngestedMemory } from './types.js';

const DAY_MS = 86_400_000;

export interface Ingested extends IngestedCorpus {
  dataDir: string;
  cleanup: () => void;
  /** Exposed so a test can drive one retrieval branch in isolation. */
  repos: Repositories;
}

/**
 * Ingests `items` through the real save path — `MemoryService.saveWithTopicKey`
 * + inline `embedNow` + save-time candidate detection, exactly like a live
 * `memory.save` call — into a fresh throwaway SQLite file. Per design.md
 * Decision 2: this is what makes the harness measure the shipping system,
 * not a synthetic index.
 *
 * Each item's `createdAt`/`lastSeenAt` is stamped `daysAgo` days before the
 * moment this function runs (not a fixed historical date), so the relative
 * age structure — and therefore the ranking boost it drives — is identical
 * regardless of which calendar day the eval executes.
 */
export async function ingestCorpus(items: CorpusItem[], embedder: Embedder): Promise<Ingested> {
  const { handle, dataDir, cleanup } = createTestDb();
  const repos = createRepositories(handle.db);

  const projects = new ProjectsService(repos);
  const projectIdBySlug = new Map<string, string>();
  for (const p of PROJECTS) {
    const row = projects.create({ slug: p.slug, displayName: p.displayName });
    projectIdBySlug.set(p.slug, row.id);
  }

  // `clock` ends the loop frozen at the last item's daysAgo — harmless today only
  // because `MemoryService.search` never threads `now` into `hybridSearch`'s
  // recency boost (that uses real wall-clock `Date.now()` directly).
  const clock = new TestClock();
  const embedText = (text: string): Promise<Float32Array> =>
    embedder.embed(embeddingQueryInput(text));

  const memory = new MemoryService(repos, handle.db, clock.now, embedText);
  const relations = new RelationsService(repos, handle.db);
  const embeddingWorker = new EmbeddingWorker({ repos, embedder });

  const idByStableId = new Map<string, string>();
  const stableIdById = new Map<string, string>();
  const allIds: string[] = [];

  for (const item of items) {
    clock.set(new Date(Date.now() - item.daysAgo * DAY_MS));
    const scope: Scope =
      item.scope === 'global'
        ? SCOPE_GLOBAL
        : projectScope(requireProjectId(projectIdBySlug, item));

    const { memory: saved } = await saveMemoryWithCandidates(
      {
        memory,
        relations,
        candidates: { perSaveMax: CANDIDATES_PER_SAVE_MAX_DEFAULT },
        repos,
        embedNow: (memoryId, title, content, memScope, projectId) =>
          embeddingWorker.embedNow(memoryId, title, content, memScope, projectId),
      },
      {
        type: item.type,
        title: item.title,
        content: item.content,
        tags: item.tags,
        topicKey: item.topicKey,
      },
      scope,
    );

    idByStableId.set(item.id, saved.id);
    stableIdById.set(saved.id, item.id);
    allIds.push(saved.id);
  }

  // A topic_key upsert flips an earlier row in this same loop from
  // active -> superseded; re-read final state instead of trusting each
  // insert's own row, and drop anything no longer active so grep/dump see
  // exactly the corpus `hybrid`'s default status='active' filter sees.
  const finalRows = repos.memory.unsafeGetByIds(allIds);
  const ingested: IngestedMemory[] = finalRows
    .filter((m) => m.status === 'active')
    .map((m) => ({
      id: m.id,
      stableId: stableIdById.get(m.id) ?? m.id,
      type: m.type,
      title: m.title,
      content: m.content,
      scope: m.scope,
      projectId: m.projectId,
      createdAt: m.createdAt,
    }));

  return {
    memory,
    embeddingModelId: embedder.modelId,
    items: ingested,
    idByStableId,
    projectIdBySlug,
    dataDir,
    cleanup,
    repos,
  };
}

function requireProjectId(byName: Map<string, string>, item: CorpusItem): string {
  const id = item.project ? byName.get(item.project) : undefined;
  if (!id) {
    throw new Error(`corpus item '${item.id}' has scope='project' but no known project slug`);
  }
  return id;
}
