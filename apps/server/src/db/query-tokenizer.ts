import type Database from 'better-sqlite3';

/**
 * The query's terms are read back out of FTS5 rather than reproduced in
 * JavaScript — memory/spec.md, "Term-statistics lookups MUST be keyed on the
 * index's own terms". A term the application invents is absent from the index's
 * statistics and takes the weight of a term the corpus has never seen, which is
 * the maximum, so the corpus's commonest word can score as its rarest.
 *
 * Both tables live in the connection's temporary schema and the tokenising one
 * is contentless, so no query text reaches the durable database or its WAL.
 */
export const QUERY_TERMS_TABLE = 'rembric_query_terms';
export const QUERY_TERMS_VOCAB_TABLE = 'rembric_query_terms_vocab';
/** Anything but `temp` puts per-query writes into the WAL of an append-only store. */
export const QUERY_TERMS_SCHEMA = 'temp';

/**
 * fts5 declaration arguments the derivation knows how to carry. `content=` and
 * `content_rowid=` are dropped (the tokenising table holds its own text); a
 * bare argument is a column definition and is replaced by the single `body`
 * column. Anything else fails startup rather than being silently omitted: a
 * `tokenize=` that did not reach this table is exactly the divergence the
 * mechanism exists to remove.
 */
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

/**
 * Splits the argument list of `... USING fts5(<args>)` on commas that are not
 * inside a string or bracketed identifier. FTS5 accepts `'`, `"`, `` ` `` and
 * `[…]` around an option's value, and a tokenizer argument list arrives quoted.
 */
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

/**
 * Creates the tokenising table on `sqlite`, deriving its declaration from the
 * one the migrations left behind. Must run AFTER the migration runner: the
 * declaration is read out of `sqlite_master`, so a migration that changes
 * `memory_fts`'s tokenizer is picked up on the next boot with no code change.
 */
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
