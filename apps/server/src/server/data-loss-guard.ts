import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';

import type { Db } from '../db/index.js';

const MARKER_FILENAME = '.rembric-state.json';
const MARKER_SCHEMA_VERSION = 1;
const SHRINKAGE_THRESHOLD = 0.5;

export interface DataCounts {
  memory: number;
  projects: number;
  sessions: number;
  tokens: number;
  prompts: number;
}

export interface StateMarker {
  version: 1;
  last_seen_at: number;
  counts: DataCounts;
}

export function queryCounts(db: Db): DataCounts {
  const one = (table: string): number => {
    const row = db.get<{ c: number }>(sql.raw(`SELECT COUNT(*) AS c FROM ${table}`)) as
      | { c: number }
      | undefined;
    return row?.c ?? 0;
  };
  return {
    memory: one('memory'),
    projects: one('projects'),
    sessions: one('sessions'),
    tokens: one('tokens'),
    prompts: one('prompts'),
  };
}

export function readStateMarker(dataDir: string): StateMarker | null {
  const path = join(dataDir, MARKER_FILENAME);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isMarker(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeStateMarker(dataDir: string, counts: DataCounts): void {
  const marker: StateMarker = {
    version: MARKER_SCHEMA_VERSION,
    last_seen_at: Date.now(),
    counts,
  };
  const path = join(dataDir, MARKER_FILENAME);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(marker, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export interface GuardDeps {
  dataDir: string;
  db: Db;
  env: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export interface GuardResult {
  current: DataCounts;
  previous: StateMarker | null;
  shrunkTables: Array<{ table: keyof DataCounts; previous: number; current: number }>;
  bypassed: boolean;
}

export class DataLossGuardError extends Error {
  readonly current: DataCounts;
  readonly previous: StateMarker;
  readonly shrunkTables: GuardResult['shrunkTables'];
  constructor(result: GuardResult & { previous: StateMarker }) {
    super('data-loss guard refused startup');
    this.current = result.current;
    this.previous = result.previous;
    this.shrunkTables = result.shrunkTables;
  }
}

export function assertDataLossGuard(deps: GuardDeps): GuardResult {
  const log = deps.log ?? ((l) => console.error(l));
  const current = queryCounts(deps.db);
  const previous = readStateMarker(deps.dataDir);
  const allowed = deps.env['REMBRIC_ALLOW_DATA_SHRINKAGE'] === '1';

  if (!previous) {
    log('[bootstrap] no prior state marker; treating as first boot');
    writeStateMarker(deps.dataDir, current);
    return { current, previous: null, shrunkTables: [], bypassed: false };
  }

  const shrunkTables: GuardResult['shrunkTables'] = [];
  const tables: Array<keyof DataCounts> = ['memory', 'projects', 'sessions', 'tokens', 'prompts'];
  for (const t of tables) {
    const prev = previous.counts[t];
    const cur = current[t];
    if (prev > 0 && cur < prev * SHRINKAGE_THRESHOLD) {
      shrunkTables.push({ table: t, previous: prev, current: cur });
    }
  }

  if (shrunkTables.length === 0) {
    writeStateMarker(deps.dataDir, current);
    return { current, previous, shrunkTables: [], bypassed: false };
  }

  if (allowed) {
    log('[bootstrap] data-loss guard bypassed via REMBRIC_ALLOW_DATA_SHRINKAGE=1');
    log(`[bootstrap]   previous: ${countsLine(previous.counts)}`);
    log(`[bootstrap]   current:  ${countsLine(current)}`);
    writeStateMarker(deps.dataDir, current);
    return { current, previous, shrunkTables, bypassed: true };
  }

  const lines = [
    '',
    '  ✗ Refusing to start: data-loss guard tripped.',
    `    data_dir: ${deps.dataDir}`,
    `    previous: ${countsLine(previous.counts)}`,
    `    current:  ${countsLine(current)}`,
    '    shrunk by ≥ 50%:',
  ];
  for (const s of shrunkTables) {
    lines.push(`      - ${s.table}: ${s.previous} → ${s.current}`);
  }
  lines.push(
    '',
    '    To acknowledge intentional data shrinkage, set',
    '    REMBRIC_ALLOW_DATA_SHRINKAGE=1 and restart.',
    '',
  );
  for (const l of lines) log(l);

  throw new DataLossGuardError({ current, previous, shrunkTables, bypassed: false });
}

function countsLine(c: DataCounts): string {
  return `memory=${c.memory} projects=${c.projects} sessions=${c.sessions} tokens=${c.tokens} prompts=${c.prompts}`;
}

function isMarker(value: unknown): value is StateMarker {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v['version'] !== MARKER_SCHEMA_VERSION) return false;
  if (typeof v['last_seen_at'] !== 'number') return false;
  if (typeof v['counts'] !== 'object' || v['counts'] === null) return false;
  const c = v['counts'] as Record<string, unknown>;
  for (const k of ['memory', 'projects', 'sessions', 'tokens', 'prompts']) {
    if (typeof c[k] !== 'number') return false;
  }
  return true;
}
