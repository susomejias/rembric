import { createRepositories, projectScope, type Repositories, type Scope } from '@rembric/db';

import { type Embedder, embeddingQueryInput } from '../../embeddings/embedder.js';
import { EmbeddingWorker } from '../../services/embedding-worker.js';
import { MemoryService, type SaveMemoryInput } from '../../services/memory.js';
import { ProjectsService } from '../../services/projects.js';
import { RelationsService } from '../../services/relations.js';
import { runPostSaveSteps } from '../../services/save-curation.js';
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
  lexicalFloor: number | undefined,
): Promise<ReturnType<MemoryService['saveWithTopicKey']>['memory']> {
  const { memory: saved } = deps.memory.saveWithTopicKey(input, scope);
  await runPostSaveSteps(
    {
      ...deps,
      candidates: {
        perSaveMax: CANDIDATES_PER_SAVE_MAX_DEFAULT,
        ...(lexicalFloor === undefined ? {} : { lexicalFloor }),
      },
    },
    saved,
    scope,
  );
  return saved;
}

export async function ingestCorpus(
  items: CorpusItem[],
  embedder: Embedder,
  opts: { lexicalFloor?: number } = {},
): Promise<Ingested> {
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
      opts.lexicalFloor,
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
