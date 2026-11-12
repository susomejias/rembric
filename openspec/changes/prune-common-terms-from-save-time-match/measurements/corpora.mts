// Shared corpus builders for the measurement scripts in this directory.
// Each corpus is built once per size into a cache directory, then copied before any script writes to it.
import { cpSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const webRequire = createRequire(new URL('../../../../apps/web/package.json', import.meta.url));
export const load = (spec: string) => import(pathToFileURL(webRequire.resolve(spec)).href);

const { createDb, createRepositories, projectScope } = await load('@rembric/db');
const { MemoryService, ProjectsService, indexTerms } = await load('@rembric/core');
const { buildCorpus, DEFAULT_ARGS, scopeSlotFor } = await import(
  new URL('../../../../apps/web/src/scripts/seed-volumetric.ts', import.meta.url).href
);
const { CORPUS } = await import(
  new URL('../../../../packages/core/src/test-support/retrieval/corpus.ts', import.meta.url).href
);

export type CorpusName = 'generator' | 'realistic';

// A base-corpus term found in at least this many of the 73 retrieval items (about 5%) is shared
// verbatim by every copy; every rarer term gets a per-copy suffix, so copies share only those.
export const REALISTIC_SHARED_MIN_DOCS = 4;
const PROJECT_COUNT = 6;

export const quiet = { onMigrationProgress: () => {}, onStartupLog: () => {} };

function buildRealistic(handle: { db: unknown }, size: number): void {
  const repos = createRepositories(handle.db);
  const projects = new ProjectsService(repos);
  const memory = new MemoryService(repos, handle.db);
  const scopes = Array.from({ length: PROJECT_COUNT }, (_, i) =>
    projectScope(
      projects.create({ slug: i === 0 ? 'real-shared' : `real-${i}`, displayName: `Real ${i}` }).id,
    ),
  );
  const df = new Map<string, number>();
  for (const item of CORPUS) {
    for (const t of new Set<string>(indexTerms(`${item.title}\n${item.content}`)))
      df.set(t, (df.get(t) ?? 0) + 1);
  }
  const suffixRare = (text: string, copy: number): string =>
    copy === 0
      ? text
      : text.replace(/[\p{L}\p{N}]+/gu, (w) => {
          const terms = indexTerms(w);
          const shared = terms.every((t: string) => (df.get(t) ?? 0) >= REALISTIC_SHARED_MIN_DOCS);
          return shared ? w : `${w}q${copy.toString(36)}`;
        });
  const BATCH = 500;
  for (let start = 0; start < size; start += BATCH) {
    (handle.db as { transaction: (fn: () => void) => void }).transaction(() => {
      for (let i = start; i < Math.min(size, start + BATCH); i += 1) {
        const item = CORPUS[i % CORPUS.length];
        const copy = Math.floor(i / CORPUS.length);
        const scope = scopes[scopeSlotFor(i, DEFAULT_ARGS.skew)];
        memory.save(
          {
            type: item.type,
            title: suffixRare(item.title, copy),
            content: suffixRare(item.content, copy),
          },
          scope,
        );
      }
    });
  }
}

export function cachedCorpus(cacheRoot: string, corpus: CorpusName, size: number): string {
  const dir = join(cacheRoot, `${corpus}-${size}`);
  if (existsSync(join(dir, 'data.db'))) return dir;
  mkdirSync(dir, { recursive: true });
  const handle = createDb({ dataDir: dir, ...quiet });
  try {
    if (corpus === 'generator') {
      buildCorpus({
        handle,
        args: { ...DEFAULT_ARGS, dataDir: dir, memories: size },
        log: () => {},
      });
    } else {
      buildRealistic(handle, size);
    }
    handle.raw.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    handle.close();
  }
  return dir;
}

export function freshCopy(cacheRoot: string, corpus: CorpusName, size: number): string {
  const src = cachedCorpus(cacheRoot, corpus, size);
  const dst = mkdtempSync(join(cacheRoot, `copy-${corpus}-${size}-`));
  cpSync(src, dst, { recursive: true });
  return dst;
}

export function largestProjectSlug(corpus: CorpusName): string {
  return corpus === 'generator' ? 'vol-shared' : 'real-shared';
}
