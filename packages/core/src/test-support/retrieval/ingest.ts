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

/**
 * Mirror of the shipping `CANDIDATES_PER_SAVE_MAX` default
 * (`apps/web/src/lib/mcp-server.ts` reads the same 5). Inlined instead of read
 * from a config module: the harness measures the shipping SAVE PATH, not the
 * deployment's environment.
 */
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

/**
 * The shipping save-time curation path, composed here.
 *
 * `packages/mcp/src/memory-tools.ts::saveMemoryWithCandidates` is the one
 * implementation a live `memory.save` goes through — `topic_key` supersession,
 * inline embedding, save-time candidate detection and entity linking — and this
 * harness must ingest through that path rather than a bare insert (design.md
 * Decision 2). It cannot be imported from `@rembric/core`: the dependency edge
 * runs the other way (`@rembric/mcp` depends on `@rembric/core`), and declaring
 * it here — even as a devDependency — is a turbo build cycle, measured. The
 * composition below calls the same public core/db primitives that wrapper
 * calls, so the corpus is still the shipping path's output. Any new step in
 * that wrapper has to be mirrored here.
 */
async function saveThroughCuration(
  deps: SaveDeps,
  input: SaveMemoryInput,
  scope: Scope,
): Promise<ReturnType<MemoryService['saveWithTopicKey']>['memory']> {
  const { memory: saved } = deps.memory.saveWithTopicKey(input, scope);

  // Extraction is pure and runs before detection reads: the just-saved row must
  // not count toward its own entity's rarity stats.
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
    // Best-effort in the shipping wrapper too: a detection or embedding failure
    // must not fail the save.
  }

  try {
    deps.repos.entities.linkMemory(saved.id, scope.projectId, extracted, saved.createdAt);
  } catch {
    // Best-effort in the shipping wrapper too.
  }

  return saved;
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
