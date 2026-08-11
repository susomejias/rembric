/**
 * The one classification of every table this schema owns, shared by
 * `invariants.test.ts` (which asserts the source/derived partition and each
 * derived table's reproduction path) and `schema-drift.test.ts` (which asserts
 * the migrated table set). Two hand-maintained inventories drifted within a
 * single branch once; a new table is now one edit.
 *
 * The trigger lists here and `schema-drift.test.ts::EXPECTED_TRIGGERS` are
 * deliberately NOT shared: this one names the reproduction mechanism keyed by
 * the DERIVED table, that one names every trigger a table-rebuild migration must
 * recreate keyed by the table it fires ON, and their membership differs
 * (`memory_vec_status_sync` maintains vec metadata but is not how vectors are
 * reproduced — `ensureVectorModel` is).
 */

/** Sole record of something an agent, an operator, or the process's history supplied. */
export const SOURCE_TABLES = [
  '_migrations',
  'confirmations',
  'consolidation_ops',
  'consolidation_runs',
  'dashboard_sessions',
  'memory',
  'memory_relations',
  'oauth_authorization_codes',
  'oauth_clients',
  'oauth_tokens',
  'projects',
  'prompts',
  'session_summary_versions',
  'sessions',
  'token_projects',
  'tokens',
] as const;

/**
 * A union, not four optional fields: triggers ARE the recipe and cannot drift
 * from it, so a trigger-maintained table must NOT name a marker, while a
 * rebuildable one must.
 *
 * The `?: never` arms are load-bearing. Without them a union only rejects the
 * MISSING direction (a `rebuild` entry with no `markers`): excess-property
 * checking admits any key declared by some constituent, so `{ triggers, markers }`
 * would type-check and the pairing would be half-enforced.
 */
export type DerivedEntry =
  | {
      derivesFrom: string;
      triggers: readonly string[];
      rebuild?: never;
      markers?: never;
      contentless?: never;
    }
  | {
      derivesFrom: string;
      rebuild: { module: string; entryPoint: string };
      markers: readonly string[];
      triggers?: never;
      contentless?: never;
    }
  | {
      derivesFrom: string;
      /** Stores nothing — the DDL is the whole recipe, so there is no marker and nothing to invalidate. */
      contentless: true;
      triggers?: never;
      rebuild?: never;
      markers?: never;
    };

/** Recomputable in full from source tables plus a recipe pinned in the image. */
export const DERIVED_TABLES: Record<string, DerivedEntry> = {
  memory_fts: { derivesFrom: 'memory', triggers: ['memory_ai', 'memory_au', 'memory_ad'] },
  memory_fts_vocab: { derivesFrom: 'memory_fts', contentless: true },
  prompts_fts: { derivesFrom: 'prompts', triggers: ['prompts_ai', 'prompts_au', 'prompts_ad'] },
  memory_replaces: {
    derivesFrom: 'memory.replaces',
    triggers: ['memory_replaces_ai', 'memory_replaces_au', 'memory_replaces_ad'],
  },
  memory_vec: {
    derivesFrom: 'memory.title+content',
    rebuild: { module: 'embeddings/state.ts', entryPoint: 'ensureVectorModel' },
    markers: ['EMBEDDING_MODEL_ID', 'EMBEDDING_INPUT_VERSION'],
  },
  memory_entities: {
    derivesFrom: 'memory.title+content',
    rebuild: { module: 'services/entity-state.ts', entryPoint: 'ensureEntityExtractor' },
    markers: ['EXTRACTOR_VERSION'],
  },
  memory_entity_links: {
    derivesFrom: 'memory.title+content',
    rebuild: { module: 'services/entity-state.ts', entryPoint: 'resetEntityIndex' },
    markers: ['EXTRACTOR_VERSION'],
  },
  memory_entity_scan: {
    derivesFrom: 'memory.title+content',
    rebuild: { module: 'services/entity-state.ts', entryPoint: 'resetEntityIndex' },
    markers: ['EXTRACTOR_VERSION'],
  },
};

/**
 * Exact sets per parent, never a prefix. A `^memory_vec_` prefix rule was tried
 * and rejected: it silently swallowed an unclassified `memory_vec_impostor` into
 * "derived with its parent", which is the tolerate-extras hole the partition
 * exists to close. The cost is accepted — a sqlite-vec release that changes
 * vec0's shadow layout fails here deliberately, so the new set is reviewed and
 * pinned in ONE place rather than absorbed in two.
 */
export const SHADOWS: Record<string, readonly string[]> = {
  memory_fts: ['memory_fts_config', 'memory_fts_data', 'memory_fts_docsize', 'memory_fts_idx'],
  prompts_fts: ['prompts_fts_config', 'prompts_fts_data', 'prompts_fts_docsize', 'prompts_fts_idx'],
  memory_vec: [
    'memory_vec_chunks',
    'memory_vec_info',
    'memory_vec_metadatachunks00',
    'memory_vec_metadatachunks01',
    'memory_vec_metadatatext00',
    'memory_vec_metadatatext01',
    'memory_vec_rowids',
    'memory_vec_vector_chunks00',
  ],
};

export const SHADOW_TABLE_NAMES: readonly string[] = Object.values(SHADOWS).flat();

/** Every table a freshly migrated database holds, shadows included. */
export const ALL_TABLES: readonly string[] = [
  ...SOURCE_TABLES,
  ...Object.keys(DERIVED_TABLES),
  ...SHADOW_TABLE_NAMES,
];
