import type { Memory, MemoryScope, MemoryType } from '../../db/schema/memory.js';
import type { MemoryService } from '../../services/memory.js';

/** A single corpus fixture row, before ingestion. See `corpus.ts`. */
export interface CorpusItem {
  /** Stable fixture id, referenced by `queries.ts` — never the DB-generated memory id. */
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  tags?: string[];
  scope: MemoryScope;
  /** Project slug (see `corpus.ts::PROJECTS`); required when `scope === 'project'`. */
  project?: string;
  /** Days before the eval run this memory was "created" — sets both `createdAt` and `lastSeenAt`. */
  daysAgo: number;
  /** Convergent-topic key; a second corpus item reusing the same key supersedes this one. */
  topicKey?: string;
  /** Documents which gold item this is a distractor for. Not read by the harness — corpus bookkeeping only. */
  distractorFor?: string;
}

/** One ingested memory: the corpus item plus its real, DB-assigned identity. */
export type IngestedMemory = Pick<
  Memory,
  'id' | 'type' | 'title' | 'content' | 'scope' | 'projectId' | 'createdAt'
> & {
  stableId: string;
};

/** The live throwaway corpus a retriever queries against. */
export interface IngestedCorpus {
  memory: MemoryService;
  embeddingModelId: string;
  items: IngestedMemory[];
  /** Corpus fixture id -> real DB id, for scoring gold sets against retrieved ids. */
  idByStableId: Map<string, string>;
  projectIdBySlug: Map<string, string>;
}

/** The scope + widening a query is issued under, resolved to a real project id. */
export interface QueryScope {
  scope: MemoryScope;
  projectId: string | null;
  includeGlobal?: boolean;
}

/** Same shape, but `project` is a fixture slug (see `corpus.ts::PROJECTS`) — resolved to a `QueryScope` at eval time. */
export interface QueryScopeFixture {
  scope: MemoryScope;
  project?: string;
  includeGlobal?: boolean;
}

export type QueryType =
  | 'extraction'
  | 'knowledge-update'
  | 'temporal'
  | 'preference'
  | 'multi-session-causal'
  | 'cross-scope'
  | 'abstention';

/** A single query fixture row. See `queries.ts`. */
export interface QueryItem {
  id: string;
  text: string;
  type: QueryType;
  /** Corpus fixture ids that count as relevant. Empty for `abstention` queries. */
  goldStableIds: string[];
  scope: QueryScopeFixture;
  /** Marks the small Spanish subset (design.md Open Question 1). */
  bilingual?: boolean;
}

/** A retriever under evaluation. All three run against the identical ingested corpus and query set. */
export interface Retriever<TState = unknown> {
  name: string;
  /** What this retriever's scorecard is meant to be read against — see design.md Decision 5. */
  discriminatingMetric: string;
  init(corpus: IngestedCorpus): TState | Promise<TState>;
  /** Returns real memory ids, ranked best-first, length <= k. */
  query(text: string, state: TState, k: number, scope: QueryScope): string[] | Promise<string[]>;
  teardown?(state: TState): void | Promise<void>;
}

/** Scope match for an in-memory retriever (`grep`, `memory-md-dump`) — the non-SQL sibling of `services/scope.ts::memoryMatchesScope`, `includeGlobal`-aware like `db/repositories/scope-clause.ts::scopeWhere`. */
export function inScope(
  item: { scope: MemoryScope; projectId: string | null },
  scope: QueryScope,
): boolean {
  if (scope.scope === 'global') return item.scope === 'global';
  if (item.scope === 'project') return item.projectId === scope.projectId;
  return scope.includeGlobal === true;
}
