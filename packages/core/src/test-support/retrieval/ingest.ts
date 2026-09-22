import { createRepositories, projectScope, type Repositories, type Scope } from '@rembric/db';

import { type Embedder, embeddingQueryInput } from '../../embeddings/embedder.js';
import { EmbeddingWorker } from '../../services/embedding-worker.js';
import { extractEntities } from '../../services/entities.js';
import { MemoryService, type SaveMemoryInput } from '../../services/memory.js';
import { ProjectsService } from '../../services/projects.js';
import { RelationsService } from '../../services/relations.js';
import { findSaveTimeCandidates } from '../../services/save-time-candidates.js';
import { TestClock } from '../clock.js';
import { createTestDb } from '../db.js';

import { PROJECTS } from './corpus.js';
import type { CorpusItem, IngestedCorpus, IngestedMemory } from './types.js';

const DAY_MS = 86_400_000;

const CANDIDATES_PER_SAVE_MAX_DEFAULT = 5;

export interface Ingested extends IngestedCorpus {
  dataDir: string;
  cleanup: () => void;
  /** Exposed so a test can drive one retrieval branch in isolation. */
  repos: Repositories;
}

interface SaveDeps {
  memory: MemoryService;
  relations: RelationsService;
  repos: Repositories;
  embedNow: (
    memoryId: string,
    title: string,
    content: string,
    projectId: string,
  ) => Promise<boolean>;
}

async function saveThroughCuration(
  deps: SaveDeps,
  input: SaveMemoryInput,
  scope: Scope,
): Promise<ReturnType<MemoryService['saveWithTopicKey']>['memory']> {
  const { memory: saved } = deps.memory.saveWithTopicKey(input, scope);

  const extracted = extractEntities(saved.title, saved.content);

  try {
    await deps.embedNow(saved.id, saved.title, saved.content, scope.projectId);
    const found = findSaveTimeCandidates(
      deps.repos,
      saved,
      { perSaveMax: CANDIDATES_PER_SAVE_MAX_DEFAULT },
      extracted,
    );
    for (const candidate of found.candidates) {
      deps.relations.createPending({ sourceId: saved.id, targetId: candidate.targetId });
    }
  } catch {
    // Best-effort, as in the shipping wrapper: detection or embedding failure must not fail the save.
  }

  try {
    deps.repos.entities.linkMemory(saved.id, scope.projectId, extracted, saved.createdAt);
  } catch {
    // Best-effort in the shipping wrapper too.
  }

  return saved;
}

export async function ingestCorpus(items: CorpusItem[], embedder: Embedder): Promise<Ingested> {
  const { handle, dataDir, cleanup } = createTestDb();
  const repos = createRepositories(handle.db);

  const projects = new ProjectsService(repos);
  const projectIdBySlug = new Map<string, string>();
  for (const p of PROJECTS) {
    const row = projects.create({ slug: p.slug, displayName: p.displayName });
    projectIdBySlug.set(p.slug, row.id);
  }

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
    const scope: Scope = projectScope(requireProjectId(projectIdBySlug, item));

    const saved = await saveThroughCuration(
      {
        memory,
        relations,
        repos,
        embedNow: (memoryId, title, content, projectId) =>
          embeddingWorker.embedNow(memoryId, title, content, projectId),
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

  const finalRows = repos.memory.unsafeGetByIds(allIds);
  const ingested: IngestedMemory[] = finalRows
    .filter((m) => m.status === 'active')
    .map((m) => ({
      id: m.id,
      stableId: stableIdById.get(m.id) ?? m.id,
      type: m.type,
      title: m.title,
      content: m.content,
      projectId: m.projectId!,
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
