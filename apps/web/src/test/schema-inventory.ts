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
  'sessions',
  'token_projects',
  'tokens',
] as const;

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
      contentless: true;
      triggers?: never;
      rebuild?: never;
      markers?: never;
    };

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

export const ALL_TABLES: readonly string[] = [
  ...SOURCE_TABLES,
  ...Object.keys(DERIVED_TABLES),
  ...SHADOW_TABLE_NAMES,
];

export type TextColumnClass = 'redacted' | { exempt: string };

const IDENTIFIER: TextColumnClass = { exempt: 'identifier or foreign key' };
const ENUMERATION: TextColumnClass = { exempt: 'closed enumeration' };
const SERVER_COMPOSED: TextColumnClass = { exempt: 'composed by the server, never caller text' };
const OPERATOR_ENTERED: TextColumnClass = { exempt: 'operator-entered name, not agent content' };
const HASH: TextColumnClass = { exempt: 'hash or server-generated secret' };
const OAUTH_METADATA: TextColumnClass = { exempt: 'OAuth client metadata (RFC 7591/7636)' };

export const TEXT_COLUMNS: Record<string, TextColumnClass> = {
  '_migrations.filename': SERVER_COMPOSED,
  'confirmations.id': IDENTIFIER,
  'confirmations.memory_id': IDENTIFIER,
  'confirmations.source': SERVER_COMPOSED,
  'confirmations.session_id': IDENTIFIER,
  'confirmations.verdict': ENUMERATION,
  'confirmations.reason': 'redacted',
  'consolidation_ops.id': IDENTIFIER,
  'consolidation_ops.run_id': IDENTIFIER,
  'consolidation_ops.op_type': ENUMERATION,
  'consolidation_ops.affected_ids': IDENTIFIER,
  'consolidation_ops.created_id': IDENTIFIER,
  'consolidation_ops.reasoning': SERVER_COMPOSED,
  'consolidation_runs.id': IDENTIFIER,
  'consolidation_runs.scope': IDENTIFIER,
  'consolidation_runs.summary': SERVER_COMPOSED,
  'dashboard_sessions.id': IDENTIFIER,
  'dashboard_sessions.token_id': IDENTIFIER,
  'dashboard_sessions.csrf_secret': HASH,
  'memory.id': IDENTIFIER,
  'memory.scope': ENUMERATION,
  'memory.project_id': IDENTIFIER,
  'memory.type': ENUMERATION,
  'memory.title': 'redacted',
  'memory.content': 'redacted',
  'memory.tags': 'redacted',
  'memory.status': ENUMERATION,
  'memory.replaces': IDENTIFIER,
  'memory.source': SERVER_COMPOSED,
  'memory.session_id': IDENTIFIER,
  'memory.topic_key': 'redacted',
  'memory_relations.id': IDENTIFIER,
  'memory_relations.judgment_id': IDENTIFIER,
  'memory_relations.source_id': IDENTIFIER,
  'memory_relations.target_id': IDENTIFIER,
  'memory_relations.relation': ENUMERATION,
  'memory_relations.status': ENUMERATION,
  'memory_relations.reason': 'redacted',
  'memory_relations.evidence': 'redacted',
  'memory_relations.marked_by_kind': ENUMERATION,
  'memory_relations.marked_by_actor': OPERATOR_ENTERED,
  'oauth_authorization_codes.id': IDENTIFIER,
  'oauth_authorization_codes.hash': HASH,
  'oauth_authorization_codes.client_id': IDENTIFIER,
  'oauth_authorization_codes.redirect_uri': OAUTH_METADATA,
  'oauth_authorization_codes.code_challenge': HASH,
  'oauth_authorization_codes.scope': ENUMERATION,
  'oauth_authorization_codes.subject': IDENTIFIER,
  'oauth_authorization_codes.project_id': IDENTIFIER,
  'oauth_clients.client_id': IDENTIFIER,
  'oauth_clients.client_name': OAUTH_METADATA,
  'oauth_clients.redirect_uris': OAUTH_METADATA,
  'oauth_clients.token_endpoint_auth_method': ENUMERATION,
  'oauth_tokens.id': IDENTIFIER,
  'oauth_tokens.kind': ENUMERATION,
  'oauth_tokens.hash': HASH,
  'oauth_tokens.client_id': IDENTIFIER,
  'oauth_tokens.family_id': IDENTIFIER,
  'oauth_tokens.scope': ENUMERATION,
  'oauth_tokens.subject': IDENTIFIER,
  'oauth_tokens.project_id': IDENTIFIER,
  'projects.id': IDENTIFIER,
  'projects.slug': OPERATOR_ENTERED,
  'projects.display_name': OPERATOR_ENTERED,
  'prompts.id': IDENTIFIER,
  'prompts.session_id': IDENTIFIER,
  'prompts.project_id': IDENTIFIER,
  'prompts.content': 'redacted',
  'prompts.title': 'redacted',
  'prompts.tags': 'redacted',
  'prompts.replaces': IDENTIFIER,
  'prompts.agent': OPERATOR_ENTERED,
  'sessions.id': IDENTIFIER,
  'sessions.token_id': IDENTIFIER,
  'sessions.project_id': IDENTIFIER,
  'sessions.agent': 'redacted',
  'sessions.description': 'redacted',
  'sessions.title': 'redacted',
  'sessions.summary': 'redacted',
  'sessions.status': ENUMERATION,
  'token_projects.token_id': IDENTIFIER,
  'token_projects.project_id': IDENTIFIER,
  'tokens.id': IDENTIFIER,
  'tokens.name': OPERATOR_ENTERED,
  'tokens.hash': HASH,
  'tokens.scope': ENUMERATION,
  'tokens.project_id': IDENTIFIER,
};

export const REDACTED_TEXT_COLUMNS: readonly string[] = Object.entries(TEXT_COLUMNS)
  .filter(([, cls]) => cls === 'redacted')
  .map(([column]) => column);

const TEXT_AFFINITY = /CHAR|CLOB|TEXT/i;

export function textColumnsOf(
  raw: { prepare: (sql: string) => { all: () => unknown[] } },
  tables: readonly string[],
): string[] {
  return tables.flatMap((table) =>
    (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[])
      .filter((c) => c.type === '' || TEXT_AFFINITY.test(c.type))
      .map((c) => `${table}.${c.name}`),
  );
}
