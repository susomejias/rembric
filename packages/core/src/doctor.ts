import type { DbDiagnostics, Repositories } from '@rembric/db';

import { EMBEDDING_MODEL_ID } from './embeddings/embedder.js';
import { vectorIndexResetWarning } from './embeddings/state.js';
import type { AgentSessionsService } from './services/agent-sessions.js';
import { entityIndexResetWarning } from './services/entity-state.js';
import { reviewTtlEntries } from './services/review.js';

/**
 * `memory.doctor`'s payload and its production factory.
 *
 * The domain layer owns the reads, so `@rembric/mcp`'s `observability-tools.ts`
 * re-exports the shape and the summary parser for compatibility while the app
 * layer only hands the factory the diagnostics handle, the repositories and the
 * data dir.
 */

export interface DoctorRunSummary {
  kind?: string;
  [op: string]: string | number | undefined;
}

/**
 * Narrow a stored summary to what `doctorOutput` admits, so a shape no writer
 * is supposed to produce degrades this one field instead of failing the whole
 * report — `memory.doctor` is the tool an operator reaches for when the DB is
 * already suspect.
 */
export function parseRunSummary(raw: string): DoctorRunSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: DoctorRunSummary = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'kind') {
      if (typeof value === 'string') out.kind = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return out;
}

export interface DoctorReport {
  db: { journalMode: string; integrity: string; sizeBytes: number };
  embeddings: { model: string; backlog: number };
  /** Memories not yet scanned for entities — a derived-index drift signal, same shape as `embeddings.backlog`. */
  entities: { backlog: number };
  consolidation: { lastRunAt: string | null; lastRunOps: DoctorRunSummary };
  sessions: { active: number };
  /** Server-wide (unscoped) queue-depth signals — same precedent as `sessions.active`; `memory.stats` carries the scoped equivalents. */
  review: { needsReview: number; pendingJudgments: number };
  warnings: string[];
}

export function buildDoctorReportFactory(deps: {
  diagnostics: DbDiagnostics;
  repos: Repositories;
  agentSessions: AgentSessionsService;
  dataDir: string;
}): () => DoctorReport {
  return () => {
    const warnings: string[] = [];

    let journalMode = 'unknown';
    let integrity = 'unknown';
    let sizeBytes = 0;
    try {
      journalMode = deps.diagnostics.readJournalMode();
      integrity = deps.diagnostics.quickCheck();
      sizeBytes = deps.diagnostics.readDbSize().totalBytes;
    } catch (err) {
      warnings.push(`db pragma read failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (integrity !== 'ok') warnings.push(`db integrity: ${integrity}`);

    const lastConsolidation = deps.repos.consolidation.adminLatestRun();

    const lastRunOps = lastConsolidation?.summary ? parseRunSummary(lastConsolidation.summary) : {};

    const backlog = deps.repos.vectors.adminBacklogCount();
    if (backlog > 100) {
      warnings.push(`embeddings backlog: ${backlog}`);
    }

    const entitiesBacklog = deps.repos.entities.adminBacklogCount();
    if (entitiesBacklog > 100) {
      warnings.push(`entities backlog: ${entitiesBacklog}`);
    }

    // Both backlogs read 0 in these states: every memory has a vector and a scan
    // row, just from the previous recipe. Nothing else distinguishes them.
    const vectorResetOwed = vectorIndexResetWarning(deps.dataDir, () => deps.repos.vectors.count());
    if (vectorResetOwed) warnings.push(vectorResetOwed);
    const entityResetOwed = entityIndexResetWarning(deps.dataDir, () =>
      deps.repos.entities.adminCountEntities({}),
    );
    if (entityResetOwed) warnings.push(entityResetOwed);

    // Deliberate spec exception (mcp-api/spec.md): memory.doctor's session,
    // needsReview, and pendingJudgments counts are all server-wide, unlike
    // memory.stats's scoped ones — same precedent, applied consistently.
    const sessionsByStatus = deps.agentSessions.adminCountByStatus();
    const needsReview = deps.repos.memory.adminCountNeedsReview({
      nowMs: Date.now(),
      ttlByType: reviewTtlEntries(),
    });
    const pendingJudgments = deps.repos.relations.adminCountByStatus('pending');

    return {
      db: { journalMode, integrity, sizeBytes },
      embeddings: { model: EMBEDDING_MODEL_ID, backlog },
      entities: { backlog: entitiesBacklog },
      consolidation: {
        lastRunAt: lastConsolidation?.startedAt ? lastConsolidation.startedAt.toISOString() : null,
        lastRunOps,
      },
      sessions: { active: sessionsByStatus.active },
      review: { needsReview, pendingJudgments },
      warnings,
    };
  };
}
