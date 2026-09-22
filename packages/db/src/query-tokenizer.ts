import type Database from 'better-sqlite3';

export const QUERY_TERMS_TABLE = 'rembric_query_terms';
export const QUERY_TERMS_VOCAB_TABLE = 'rembric_query_terms_vocab';
/** Anything but `temp` puts per-query writes into the WAL of an append-only store. */
export const QUERY_TERMS_SCHEMA = 'temp';

const CARRIED_OPTIONS = ['tokenize', 'prefix', 'detail', 'columnsize'];
const DROPPED_OPTIONS = ['content', 'content_rowid'];

export class UnrecognisedFts5OptionError extends Error {
  constructor(readonly option: string) {
    super(
      `cannot derive the query-tokenising table: '${option}=' is declared on memory_fts and the ` +
        `derivation does not know whether it must be carried. Recognised: ` +
        `${[...CARRIED_OPTIONS, ...DROPPED_OPTIONS].join(', ')}.`,
    );
    this.name = 'UnrecognisedFts5OptionError';
  }
}

/** The `option=value` arguments a tokenising table must inherit from `declaration`. */
export function inheritedFts5Arguments(declaration: string): string[] {
  const carried: string[] = [];
  for (const argument of splitFts5Arguments(declaration)) {
    const option = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(argument);
    if (!option) continue; // a column definition, replaced by `body`
    const name = option[1]!.toLowerCase();
    if (DROPPED_OPTIONS.includes(name)) continue;
    if (!CARRIED_OPTIONS.includes(name)) throw new UnrecognisedFts5OptionError(name);
    carried.push(argument);
  }
  return carried;
}

function splitFts5Arguments(declaration: string): string[] {
  const open = declaration.indexOf('(');
  const close = declaration.lastIndexOf(')');
  if (open === -1 || close < open) {
    throw new Error(`not an fts5 declaration: ${declaration}`);
  }
  const args: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (const ch of declaration.slice(open + 1, close)) {
    if (quote) {
      if (ch === quote) quote = undefined;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[') {
      quote = ']';
      current += ch;
      continue;
    }
    if (ch === ',') {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  args.push(current.trim());
  return args.filter((a) => a.length > 0);
}

export interface QueryTokenizerTables {
  /** The arguments carried over from `memory_fts`, for the boot log. */
  inherited: string[];
  statements: string[];
}

/** The temp-schema DDL for a tokenising table declared like `declaration`. */
export function deriveQueryTokenizerDdl(declaration: string): QueryTokenizerTables {
  const inherited = inheritedFts5Arguments(declaration);
  const args = ['body', "content=''", ...inherited].join(', ');
  return {
    inherited,
    statements: [
      `CREATE VIRTUAL TABLE ${QUERY_TERMS_SCHEMA}.${QUERY_TERMS_TABLE} USING fts5(${args})`,
      `CREATE VIRTUAL TABLE ${QUERY_TERMS_SCHEMA}.${QUERY_TERMS_VOCAB_TABLE} USING fts5vocab('${QUERY_TERMS_TABLE}','row')`,
    ],
  };
}

export function createQueryTokenizerTables(sqlite: Database.Database): string[] {
  const declaration = sqlite
    .prepare<[], { sql: string }>(`SELECT sql FROM sqlite_master WHERE name = 'memory_fts'`)
    .get()?.sql;
  if (!declaration) {
    throw new Error('cannot derive the query-tokenising table: memory_fts is not in the schema');
  }
  const { inherited, statements } = deriveQueryTokenizerDdl(declaration);
  for (const statement of statements) sqlite.exec(statement);
  return inherited;
}
