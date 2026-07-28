import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SUMMARY_SECTIONS } from '../mcp/summary-rubric.js';
import { RUNTIME_IMAGE_LABEL_FILTER } from '../services/self-update/orchestrator.js';

/**
 * Append-only contract invariants enforced as a CI grep gate.
 *
 * The product makes load-bearing claims about memory immutability:
 *   - no row is ever DELETEd from the `memory` table
 *   - the `content` column is never UPDATEd
 *
 * Both are also enforced in the application layer, but a static check
 * shouts loudly if a future PR introduces a regression in a service we
 * haven't yet covered with unit tests. The check scans every .ts file
 * under src/ (except this file and migrations) and fails if forbidden
 * SQL fragments appear.
 *
 * Allow-list exception: the operator-only maintenance purge paths
 * (`MemoryService.purgeDisconnectedArchived` executing via
 * `db/repositories/memory-repository.ts` and
 * `src/services/agent-sessions.ts::purgeEmpty`) MAY emit `DELETE FROM
 * memory` and `DELETE FROM sessions` respectively. The check pins the
 * allowance to those exact files; introducing the same DELETE elsewhere
 * fails the build.
 */

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');

interface ForbiddenRule {
  pattern: RegExp;
  description: string;
  /**
   * Source files (relative to `srcRoot`) where the pattern is permitted.
   * Empty array means the pattern is forbidden everywhere.
   */
  allow?: readonly string[];
}

const FORBIDDEN: ForbiddenRule[] = [
  {
    pattern: /delete\s*\(\s*memory\s*\)/i,
    description: 'Drizzle `db.delete(memory)` is forbidden — memory is append-only',
  },
  {
    pattern: /DELETE\s+FROM\s+memory\b/i,
    description:
      'raw `DELETE FROM memory` is forbidden outside the operator-only purge in db/repositories/memory-repository.ts or the dev seed reset in scripts/seed-dev.ts',
    allow: ['db/repositories/memory-repository.ts', 'scripts/seed-dev.ts'],
  },
  {
    pattern: /update\([^)]*memory[^)]*\)[^.]*\.set\([^)]*content\s*:/i,
    description: '`db.update(memory).set({ content: … })` is forbidden — content is immutable',
  },
  {
    pattern: /UPDATE\s+memory\b[^;]*\bSET\s+content\s*=/i,
    description: 'raw `UPDATE memory SET content = …` is forbidden — content is immutable',
  },
  {
    pattern: /update\([^)]*memory[^)]*\)[^.]*\.set\([^)]*title\s*:/i,
    description: '`db.update(memory).set({ title: … })` is forbidden — title is immutable',
  },
  {
    pattern: /UPDATE\s+memory\b[^;]*\bSET\s+title\s*=/i,
    description: 'raw `UPDATE memory SET title = …` is forbidden — title is immutable',
  },
  {
    pattern: /delete\s*\(\s*agentSessions\s*\)/i,
    description: 'Drizzle `db.delete(agentSessions)` is forbidden — agent sessions are append-only',
  },
  {
    pattern: /DELETE\s+FROM\s+sessions\b/i,
    description:
      'raw `DELETE FROM sessions` is forbidden outside the operator-only purge in db/repositories/agent-sessions-repository.ts or the dev seed reset in scripts/seed-dev.ts',
    allow: ['db/repositories/agent-sessions-repository.ts', 'scripts/seed-dev.ts'],
  },
  {
    pattern:
      /update\([^)]*agentSessions[^)]*\)[^.]*\.set\([^)]*(agent|started_at|tokenId|projectId)\s*:/i,
    description:
      '`db.update(agentSessions).set({ agent|startedAt|tokenId|projectId })` is forbidden — immutable session columns',
  },
  {
    pattern: /UPDATE\s+sessions\b[^;]*\bSET\s+(agent|started_at|token_id|project_id)\s*=/i,
    description:
      'raw `UPDATE sessions SET (agent|started_at|token_id|project_id) =` is forbidden — immutable',
  },
  // NOTE: `deleted_at` is intentionally NOT listed among immutable session
  // columns — it is the single field that may transition NULL → timestamp
  // (soft-delete) and back to NULL (undelete). See the `sessions` spec
  // and `add-session-deletion` change for the narrowed contract.
  {
    pattern: /delete\s*\(\s*memoryRelations\s*\)/i,
    description:
      'Drizzle `db.delete(memoryRelations)` is forbidden — relations are append-only with status FSM',
  },
  {
    pattern: /DELETE\s+FROM\s+memory_relations\b/i,
    description:
      'raw `DELETE FROM memory_relations` is forbidden — relations are append-only, except in the dev seed reset (scripts/seed-dev.ts)',
    allow: ['scripts/seed-dev.ts'],
  },
  {
    pattern: /delete\s*\(\s*prompts\s*\)/i,
    description:
      'Drizzle `db.delete(prompts)` is forbidden — prompts are append-only (lifecycle is `deleted_at` flips + `replaces`)',
  },
  {
    pattern: /DELETE\s+FROM\s+prompts\b/i,
    description:
      'raw `DELETE FROM prompts` is forbidden outside the operator-only purge in db/repositories/prompts-repository.ts or the dev seed reset in scripts/seed-dev.ts',
    allow: ['db/repositories/prompts-repository.ts', 'scripts/seed-dev.ts'],
  },
  {
    pattern: /update\([^)]*prompts[^)]*\)[^.]*\.set\([^)]*content\s*:/i,
    description:
      '`db.update(prompts).set({ content: … })` is forbidden — prompt content is immutable',
  },
  {
    pattern: /UPDATE\s+prompts\b[^;]*\bSET\s+content\s*=/i,
    description: 'raw `UPDATE prompts SET content = …` is forbidden — content is immutable',
  },
  {
    pattern:
      /update\([^)]*memoryRelations[^)]*\)[^.]*\.set\([^)]*(source_id|target_id|judgment_id|sourceId|targetId|judgmentId)\s*:/i,
    description:
      '`db.update(memoryRelations).set({ sourceId|targetId|judgmentId })` is forbidden — immutable',
  },
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'migrations') continue; // raw SQL migrations are exempt
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts') || entry.endsWith('.spec.ts')) continue;
    out.push(full);
  }
  return out;
}

describe('append-only invariants (static grep)', () => {
  const files = listSourceFiles(srcRoot);

  it('discovers source files to scan', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const rule of FORBIDDEN) {
    const { pattern, description, allow } = rule;
    it(`forbids: ${description}`, () => {
      const offenders: { file: string; line: number; text: string }[] = [];
      const allowed = new Set((allow ?? []).map((p) => p.replace(/\\/g, '/')));
      for (const file of files) {
        const rel = file.slice(srcRoot.length + 1).replace(/\\/g, '/');
        if (allowed.has(rel)) continue;
        const lines = readFileSync(file, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          // Skip comments — a comment may legitimately reference the
          // forbidden pattern when documenting the invariant itself.
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
            continue;
          }
          if (pattern.test(line)) {
            offenders.push({ file: rel, line: i + 1, text: line.trim() });
          }
        }
      }
      if (offenders.length > 0) {
        const formatted = offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n');
        throw new Error(`${description}\n${formatted}`);
      }
    });
  }

  // Positive assertion: the two allow-listed files MUST actually contain
  // their respective DELETE statements. Otherwise a future refactor could
  // silently remove the purge implementation while keeping the allow-list
  // in place — invariant relaxation without enforcement is worse than no
  // allow-list at all.
  it('allow-list anchors: db/repositories/memory-repository.ts contains DELETE FROM memory', () => {
    const file = join(srcRoot, 'db/repositories/memory-repository.ts');
    const src = readFileSync(file, 'utf8');
    expect(/DELETE\s+FROM\s+memory\b/i.test(src)).toBe(true);
  });

  it('allow-list anchors: db/repositories/agent-sessions-repository.ts contains DELETE FROM sessions', () => {
    const file = join(srcRoot, 'db/repositories/agent-sessions-repository.ts');
    const src = readFileSync(file, 'utf8');
    expect(/DELETE\s+FROM\s+sessions\b/i.test(src)).toBe(true);
  });

  it('allow-list anchors: db/repositories/prompts-repository.ts contains DELETE FROM prompts', () => {
    const file = join(srcRoot, 'db/repositories/prompts-repository.ts');
    const src = readFileSync(file, 'utf8');
    expect(/DELETE\s+FROM\s+prompts\b/i.test(src)).toBe(true);
  });

  it('schema/prompts.ts declares content as immutable in its docstring', () => {
    const file = join(srcRoot, 'db/schema/prompts.ts');
    const src = readFileSync(file, 'utf8');
    // Mirrors the pattern asserted for memory.content; the docstring must
    // make the append-only contract explicit so reviewers can rely on it.
    expect(/content[^.\n]*immutable/i.test(src)).toBe(true);
  });

  it('allow-list anchors: scripts/seed-dev.ts contains DELETE FROM memory / sessions / memory_relations', () => {
    const file = join(srcRoot, 'scripts/seed-dev.ts');
    const src = readFileSync(file, 'utf8');
    expect(/DELETE\s+FROM\s+memory\b/i.test(src)).toBe(true);
    expect(/DELETE\s+FROM\s+sessions\b/i.test(src)).toBe(true);
    expect(/DELETE\s+FROM\s+memory_relations\b/i.test(src)).toBe(true);
  });

  it('seed-dev.ts gates --reset behind REMBRIC_ALLOW_DESTRUCTIVE_SEED before invoking the wipe helper', () => {
    const file = join(srcRoot, 'scripts/seed-dev.ts');
    const src = readFileSync(file, 'utf8');
    const gateIdx = src.search(/env\[['"]REMBRIC_ALLOW_DESTRUCTIVE_SEED['"]\]/);
    const wipeCallIdx = src.search(/\bwipe\s*\(\s*deps\.handle\s*\)/);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(wipeCallIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(wipeCallIdx);
  });
});

/**
 * Two files suffice: the data-access invariant above already confines every
 * session `UPDATE` to `db/`, and the service is the only composer of a
 * `Partial<NewAgentSession>`. Asserted on line TEXT, not line numbers, so an
 * edit elsewhere in the file cannot break it — only a new write site can.
 */
describe('session lifecycle-column invariants', () => {
  const SESSION_WRITERS = [
    'services/agent-sessions.ts',
    'db/repositories/agent-sessions-repository.ts',
  ] as const;

  const sources = SESSION_WRITERS.map((rel) => readFileSync(join(srcRoot, rel), 'utf8'));

  // The one property grep can actually carry: the terminal write path derives
  // its `set` wholly from `precedenceSet` and never appends to it. Everything
  // about which COLUMNS may move is enforced at runtime instead — see
  // agent-sessions.test.ts "terminal rows are terminal" — because a mutation
  // test proved a counting invariant here passes on `set.endedAt = …`.
  it('the terminal write path adds nothing to the precedence fields', () => {
    const svc = sources[0]!;
    const start = svc.indexOf('private writeTerminalFields');
    expect(start).toBeGreaterThan(-1);
    const body = svc.slice(start, svc.indexOf('\n  }', start));
    expect(body).toMatch(/const set = precedenceSet\(existing, input\);/);
    expect(body).not.toMatch(/\bset\.\w+\s*=/);
    expect(body).not.toMatch(/\bset\[/);
  });

  it('precedenceSet can only ever produce summary and title fields', () => {
    const svc = sources[0]!;
    const start = svc.indexOf('function precedenceSet');
    const body = svc.slice(start, svc.indexOf('\n}', start));
    const keys = [...body.matchAll(/(\w+):\s*(?:summary|title)\./g)].map((m) => m[1]).sort();
    expect(keys).toEqual(['summary', 'summaryFinal', 'title', 'titleFinal']);
  });
});

// repoRoot points to the monorepo root (../../../ from apps/server/src/test).
// srcRoot resolves to apps/server/src; the actual repo root is two levels up
// from apps/server (one extra `..` for apps, one for the repo).
const repoRoot = join(srcRoot, '..', '..', '..');

describe('image packaging invariants', () => {
  it('Dockerfile: the LAST `FROM ... AS <name>` stage is `runtime`', () => {
    const dockerfile = readFileSync(join(repoRoot, 'apps/server/Dockerfile'), 'utf8');
    const stages = [...dockerfile.matchAll(/^FROM\s+\S+\s+AS\s+(\w+)/gim)].map((m) => m[1]);
    expect(stages.length).toBeGreaterThan(1);
    expect(stages[stages.length - 1]).toBe('runtime');
  });

  it('Dockerfile: the `runtime` stage declares LABEL rembric.stage=runtime', () => {
    const dockerfile = readFileSync(join(repoRoot, 'apps/server/Dockerfile'), 'utf8');
    const runtimeIdx = dockerfile.search(/^FROM\s+\S+\s+AS\s+runtime\b/m);
    expect(runtimeIdx).toBeGreaterThan(-1);
    const runtimeBlock = dockerfile.slice(runtimeIdx);
    // Anchored to a whole line and built from the self-update prune-filter
    // constant: Docker's label filter is exact-match, so a commented-out
    // LABEL or a value drift (runtime2) must fail here, not silently stop
    // image cleanup and resurrect the per-update leak.
    const escaped = RUNTIME_IMAGE_LABEL_FILTER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(new RegExp(`^LABEL\\s+${escaped}\\s*$`, 'm').test(runtimeBlock)).toBe(true);
  });

  it('Dockerfile: the `dev` stage declares LABEL rembric.stage=dev', () => {
    const dockerfile = readFileSync(join(repoRoot, 'apps/server/Dockerfile'), 'utf8');
    const devIdx = dockerfile.search(/^FROM\s+\S+\s+AS\s+dev\b/m);
    const runtimeIdx = dockerfile.search(/^FROM\s+\S+\s+AS\s+runtime\b/m);
    expect(devIdx).toBeGreaterThan(-1);
    expect(runtimeIdx).toBeGreaterThan(devIdx);
    const devBlock = dockerfile.slice(devIdx, runtimeIdx);
    expect(/LABEL\s+rembric\.stage=dev\b/.test(devBlock)).toBe(true);
  });

  it('build-runtime-image action targets the runtime stage (shared by CI + publish)', () => {
    // The runtime build moved into a composite action used by both
    // docker-publish.yml (mode=digest) and ci.yml's docker-build-check
    // (mode=load), so the `target: runtime` guard lives there now.
    const action = readFileSync(
      join(repoRoot, '.github/actions/build-runtime-image/action.yml'),
      'utf8',
    );
    expect(/target:\s*runtime\b/.test(action)).toBe(true);
    const publish = readFileSync(join(repoRoot, '.github/workflows/docker-publish.yml'), 'utf8');
    expect(/uses:\s*\.\/\.github\/actions\/build-runtime-image\b/.test(publish)).toBe(true);
  });

  it('docker-publish.yml: post-publish smoke test references all three signals', () => {
    const yml = readFileSync(join(repoRoot, '.github/workflows/docker-publish.yml'), 'utf8');
    expect(/seed-dev/.test(yml)).toBe(true);
    expect(/tsx watch/.test(yml)).toBe(true);
    expect(/rembric\.stage/.test(yml)).toBe(true);
    expect(/MAX_MB|800/.test(yml)).toBe(true);
  });

  it('bootstrap.ts calls assertDataLossGuard before startHttpServer', () => {
    const src = readFileSync(join(srcRoot, 'server/bootstrap.ts'), 'utf8');
    const guardIdx = src.search(/\bassertDataLossGuard\s*\(/);
    const startIdx = src.search(/\bstartHttpServer\s*\(/);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(startIdx);
  });
});

/**
 * Distroless node-path invariant.
 *
 * The runtime image is distroless (gcr.io/distroless/nodejs22): node lives at
 * /nodejs/bin/node and there is NO bare `node` on PATH. Every place that execs
 * node *against the runtime image* must use the absolute path or it dies with
 * `exec: "node": executable file not found in $PATH`. This regressed in prod
 * (self-update upgrader + compose healthcheck) when the image moved to
 * distroless — these tests pin each call site so it can't happen again.
 */
describe('distroless runtime node-path invariants', () => {
  const NODE = '/nodejs/bin/node';

  it('runtime stage is distroless AND its ENTRYPOINT + HEALTHCHECK use the absolute node path', () => {
    const dockerfile = readFileSync(join(repoRoot, 'apps/server/Dockerfile'), 'utf8');
    const runtimeIdx = dockerfile.search(/^FROM\s+\S+\s+AS\s+runtime\b/m);
    expect(runtimeIdx).toBeGreaterThan(-1);
    const runtime = dockerfile.slice(runtimeIdx);
    // The reason node isn't on PATH — if this ever changes, revisit every NODE path below.
    expect(/^FROM\s+\S*distroless\S*/.test(runtime.split('\n')[0] ?? '')).toBe(true);

    const entry = runtime.match(/^ENTRYPOINT\s+(\[.*\])/m);
    expect(entry).not.toBeNull();
    expect(entry![1]).toContain(NODE);

    const health = runtime.match(/HEALTHCHECK[\s\S]*?CMD\s+(\[.*\])/);
    expect(health).not.toBeNull();
    expect(health![1]).toContain(NODE);

    // No bare-`node` exec form anywhere in the runtime stage.
    expect(/\[\s*"node"\s*[,\]]/.test(runtime)).toBe(false);
  });

  it('docker-compose healthcheck uses the absolute node path (runs in the distroless image)', () => {
    const compose = readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8');
    expect(compose).toContain(NODE);
    // A bare `- node` list entry would exec `node` and mark the container unhealthy.
    expect(/^\s*-\s*node\s*$/m.test(compose)).toBe(false);
  });

  it('dev compose overrides the healthcheck (its target is node:22-bookworm-slim, not distroless)', () => {
    const dev = readFileSync(join(repoRoot, 'docker-compose.dev.yml'), 'utf8').replace(
      /^\s*#.*$/gm,
      '',
    );
    // Without !override the dev stack inherits the distroless path, and
    // `up --wait` never returns healthy: stat /nodejs/bin/node: no such file.
    expect(/^\s*healthcheck:\s*!override\s*$/m.test(dev)).toBe(true);
    expect(dev).not.toContain(NODE);
  });

  // `image:` is the last environment-specific key the dev override has to
  // restate. Inheriting it makes `up --build` tag the 4.9 GB dev artifact as
  // the published production tag, replacing it on the developer's host — the
  // local-blast-radius twin of the 2026-05-17 dev-as-latest incident.
  it('dev compose does not tag its build with the published image name', () => {
    const dev = readFileSync(join(repoRoot, 'docker-compose.dev.yml'), 'utf8').replace(
      /^\s*#.*$/gm,
      '',
    );
    const image = /^\s*image:\s*(\S+)\s*$/m.exec(dev)?.[1];
    expect(image).toBeDefined();
    expect(image).not.toContain('ghcr.io/');
  });

  it('self-update upgrader entrypoint uses the absolute node path (runs in the NEW distroless image)', () => {
    const orch = readFileSync(join(srcRoot, 'services/self-update/orchestrator.ts'), 'utf8');
    expect(orch).toContain(`'${NODE}'`);
    // The bare-`node` default that bricked the upgrader must be gone.
    expect(/\[\s*'node'\s*,/.test(orch)).toBe(false);
  });
});

/**
 * Scope-leak invariant.
 *
 * Application-level RLS is enforced by passing a `Scope` argument into
 * every read/write through `MemoryService`. The scope-bypassing escape
 * hatches are `unsafeGetById` / `unsafeGetByIds`. Those must NOT be
 * called from the MCP layer (which would re-open the bug we just
 * closed). Allow-listed callers: the repository that defines them, the
 * service itself (private helpers), the consolidation engine (which
 * legitimately crosses scopes), the dashboard admin views, and tests.
 */
const SCOPE_BYPASS_PATTERN = /\.unsafeGetByIds?\b/;
const SCOPE_BYPASS_ALLOWED_PREFIXES = [
  'db/repositories/memory-repository.ts',
  'services/memory.ts',
  'consolidation/',
  'dashboard/',
  // Eval harness ingest re-reads its own throwaway corpus across scopes
  // post-ingest — see add-retrieval-eval-harness.
  'test/retrieval/ingest.ts',
];

describe('scope-leak invariant', () => {
  const files = listSourceFiles(srcRoot);

  it('memory.unsafeGetBy* may only be called from allow-listed modules', () => {
    const offenders: { file: string; line: number; text: string }[] = [];
    for (const file of files) {
      const rel = file.slice(srcRoot.length + 1);
      const allowed = SCOPE_BYPASS_ALLOWED_PREFIXES.some((prefix) => rel.startsWith(prefix));
      if (allowed) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
          continue;
        }
        if (SCOPE_BYPASS_PATTERN.test(line)) {
          offenders.push({ file: rel, line: i + 1, text: trimmed });
        }
      }
    }
    if (offenders.length > 0) {
      const formatted = offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n');
      throw new Error(
        `memory.unsafeGetBy* called outside allow-list (consolidation/, dashboard/, services/memory.ts). ` +
          `Use the scoped API instead, or add a justification + extend the allow-list.\n${formatted}`,
      );
    }
  });
});

/**
 * Data-access confinement invariant.
 *
 * ALL SQL — Drizzle query-builder calls, the drizzle-orm `sql` tag, and raw
 * better-sqlite3 statement APIs — lives under `src/db/`. Services, dashboard
 * handlers, MCP tools, the HTTP layer, consolidation, and embeddings are
 * SQL-free consumers of the repository layer + `db/diagnostics.ts`.
 */
const SQL_EXECUTION_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /from ['"]drizzle-orm['"]/, label: "import from 'drizzle-orm'" },
  { pattern: /\.raw\.prepare\(/, label: 'raw.prepare(' },
  { pattern: /\bdb\.(select|insert|update|delete)\(/, label: 'db.<builder>(' },
  { pattern: /\bdb\.(all|get|run)\(/, label: 'db.<all|get|run>(' },
  { pattern: /\bdb\.query\./, label: 'db.query.' },
];

describe('data-access confinement invariant', () => {
  const files = listSourceFiles(srcRoot);

  it('SQL executes only under src/db/', () => {
    const offenders: { file: string; line: number; label: string; text: string }[] = [];
    for (const file of files) {
      const rel = file.slice(srcRoot.length + 1).replace(/\\/g, '/');
      if (rel.startsWith('db/')) continue;
      if (rel === 'scripts/seed-dev.ts') continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
          continue;
        }
        for (const { pattern, label } of SQL_EXECUTION_PATTERNS) {
          if (pattern.test(line)) offenders.push({ file: rel, line: i + 1, label, text: trimmed });
        }
      }
    }
    if (offenders.length > 0) {
      const formatted = offenders
        .map((o) => `  ${o.file}:${o.line}  [${o.label}]  ${o.text}`)
        .join('\n');
      throw new Error(
        `SQL execution found outside src/db/. Move it into the repository layer or db/diagnostics.ts.\n${formatted}`,
      );
    }
  });
});

/**
 * Admin-method confinement invariant.
 *
 * `admin*`-prefixed repository reads are unscoped (they bypass the
 * `(scope, project_id)` filter) and exist solely for the operator dashboard.
 * Calling them anywhere else would leak cross-scope rows into agent-facing
 * paths. Repository definitions and tests are exempt.
 */
const ADMIN_CALL_PATTERN = /\.admin[A-Z]\w*\(/;

describe('admin-method confinement invariant', () => {
  const files = listSourceFiles(srcRoot);

  it('admin* repository methods are called only from src/dashboard/', () => {
    const offenders: { file: string; line: number; text: string }[] = [];
    for (const file of files) {
      const rel = file.slice(srcRoot.length + 1).replace(/\\/g, '/');
      if (rel.startsWith('dashboard/')) continue;
      // The dashboard router renders the operator overview page directly.
      if (rel === 'server/dashboard-router.ts') continue;
      // Doctor report + dashboard stats card — same class of operator-facing aggregation.
      if (rel === 'server/bootstrap.ts') continue;
      // Service-layer admin wrapper; its own callers are confined above.
      if (rel === 'services/agent-sessions.ts') continue;
      if (rel.startsWith('db/repositories/')) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
          continue;
        }
        if (ADMIN_CALL_PATTERN.test(line)) {
          offenders.push({ file: rel, line: i + 1, text: trimmed });
        }
      }
    }
    if (offenders.length > 0) {
      const formatted = offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n');
      throw new Error(`admin* repository method called outside src/dashboard/.\n${formatted}`);
    }
  });
});

/**
 * Plugin version lock-step invariant.
 *
 * The Rembric plugin is shipped to four agent clients (Claude Code, Codex
 * CLI, Hermes Agent, opencode). Each declares its own version in a
 * client-specific surface:
 *   - plugin/.claude-plugin/plugin.json::version
 *   - plugin/.codex-plugin/plugin.json::version
 *   - plugin/.hermes-plugin/plugin.yaml::version (top-level `version: '...'`)
 *   - plugin/.opencode-plugin/plugin.ts (// @rembric-plugin-version <semver>)
 *
 * Operators expect `/plugin update` (Claude Code), Codex's marketplace
 * cache key, and a re-run of the opencode install script to produce the
 * same version everywhere. Drift between the four sources causes silent
 * cache hits and "already at the latest version" messages despite
 * shipped changes.
 */
describe('opencode plugin dispose-spike result is recorded', () => {
  it('plugin.ts declares the spike outcome in the header', () => {
    const src = readFileSync(join(repoRoot, 'apps/plugin/.opencode-plugin/plugin.ts'), 'utf8');
    const head = src.split('\n').slice(0, 10).join('\n');
    expect(
      /\/\/ dispose-spike-result: fire-and-forget/.test(head),
      'plugin.ts must declare `// dispose-spike-result: fire-and-forget` in the first 10 lines',
    ).toBe(true);
  });

  it('server.instance.disposed handler exists in plugin.ts', () => {
    const src = readFileSync(join(repoRoot, 'apps/plugin/.opencode-plugin/plugin.ts'), 'utf8');
    expect(
      src.includes("'server.instance.disposed'"),
      'plugin.ts must dispatch the undocumented server.instance.disposed event',
    ).toBe(true);
  });
});

describe('apps/plugin/bin/rembric-dotenv.mjs is the single source of truth for slug parsing', () => {
  it('plugin.ts and rembric-bridge.mjs import from the shared dotenv lib', () => {
    const pluginSrc = readFileSync(
      join(repoRoot, 'apps/plugin/.opencode-plugin/plugin.ts'),
      'utf8',
    );
    const bridgeSrc = readFileSync(join(repoRoot, 'apps/plugin/bin/rembric-bridge.mjs'), 'utf8');

    expect(
      /from\s+['"][^'"]*rembric-dotenv\.mjs['"]/.test(pluginSrc),
      'plugin.ts must import slug helpers from rembric-dotenv.mjs',
    ).toBe(true);
    expect(
      /from\s+['"][^'"]*rembric-dotenv\.mjs['"]/.test(bridgeSrc),
      'rembric-bridge.mjs must import slug helpers from rembric-dotenv.mjs',
    ).toBe(true);

    for (const [name, src] of [
      ['plugin.ts', pluginSrc],
      ['rembric-bridge.mjs', bridgeSrc],
    ] as const) {
      if (/\bfunction\s+parseDotenv\b/.test(src)) {
        throw new Error(
          `${name} defines its own parseDotenv — must import from rembric-dotenv.mjs instead.`,
        );
      }
      if (/\bSLUG_RE\s*=\s*\//.test(src)) {
        throw new Error(
          `${name} defines its own SLUG_RE — must import from rembric-dotenv.mjs instead.`,
        );
      }
    }
  });
});

// Plugin versioning (see openspec/changes/unify-plugin-release-track): all of
// apps/plugin/ versions under ONE unified release-please `plugin` component,
// so every client carrier (.claude-plugin/{package,plugin}.json,
// .codex-plugin/{package,plugin}.json, .hermes-plugin/plugin.yaml,
// .opencode-plugin/plugin.ts) shares a single version. There is no
// node-workspace cascade and no per-client component. (A future invariant
// could assert all carriers agree; not enforced today.)

// Install URL drift guard. The `restructure-monorepo-apps-layout` change
// moved the shared plugin tree from `plugin/` to `apps/plugin/` and
// requires every install-command surface to point at the new path
// (`open-source-distribution` + `hermes-agent-plugin` specs). The legacy
// `…/main/plugin/…` URL returns HTTP 404 from `raw.githubusercontent.com`;
// shipping it anywhere outside the spec files that document that 404
// contract is always a regression.
const LEGACY_INSTALL_URL_SUBSTRINGS = [
  'raw.githubusercontent.com/susomejias/rembric/main/plugin/',
  'github.com/susomejias/rembric/blob/main/plugin/',
];

const LEGACY_URL_ALLOW_LIST = new Set([
  'openspec/specs/open-source-distribution/spec.md', // 404-contract documentation
  'openspec/specs/hermes-agent-plugin/spec.md', // 404-contract documentation
  'openspec/specs/opencode-plugin/spec.md', // 404-contract documentation
  'apps/server/src/test/invariants.test.ts', // self-reference: this test owns the rule
]);

const LEGACY_URL_BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.zip',
  '.tar',
  '.gz',
  '.pdf',
  '.sqlite',
  '.db',
]);

describe('install URL drift invariant', () => {
  it('legacy plugin install URL substring is absent from non-spec surfaces', () => {
    const trackedRaw = execSync('git ls-files', { cwd: repoRoot, encoding: 'utf8' });
    const tracked = trackedRaw.split('\n').filter(Boolean);

    const offenders: { file: string; line: number; text: string }[] = [];
    for (const rel of tracked) {
      if (LEGACY_URL_ALLOW_LIST.has(rel)) continue;
      // Active and archived OpenSpec changes are work-in-progress
      // documents that may legitimately quote the legacy URL while
      // describing the 404 contract. The canonical 404-contract
      // documentation lives in `openspec/specs/` (allow-listed above);
      // any drift introduced via a change is caught at archive time
      // when the delta merges into the canonical spec.
      if (rel.startsWith('openspec/changes/')) continue;
      const dotIdx = rel.lastIndexOf('.');
      const ext = dotIdx >= 0 ? rel.slice(dotIdx).toLowerCase() : '';
      if (LEGACY_URL_BINARY_EXTENSIONS.has(ext)) continue;
      const abs = join(repoRoot, rel);
      let src: string;
      try {
        src = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      if (!LEGACY_INSTALL_URL_SUBSTRINGS.some((s) => src.includes(s))) continue;
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (LEGACY_INSTALL_URL_SUBSTRINGS.some((s) => line.includes(s))) {
          offenders.push({ file: rel, line: i + 1, text: line.trim() });
        }
      }
    }
    if (offenders.length > 0) {
      const formatted = offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n');
      throw new Error(
        `Install URL drift detected. The legacy '…/main/plugin/…' URL returns HTTP 404 ` +
          `after the restructure-monorepo-apps-layout change. Replace with ` +
          `'…/main/apps/plugin/…' or, if the reference intentionally documents the 404 ` +
          `contract, add the file to LEGACY_URL_ALLOW_LIST at ` +
          `apps/server/src/test/invariants.test.ts.\n${formatted}`,
      );
    }
  });

  it('allow-list anchors: each allow-listed spec file actually contains a legacy URL reference', () => {
    // Symmetric to the DELETE-FROM allow-list anchor tests: if a future
    // edit removes the 404-contract documentation from a spec, the
    // allow-list entry becomes a silent loophole. Force the allow-list
    // to stay tight by asserting each listed file still has a reason to
    // be there.
    for (const rel of LEGACY_URL_ALLOW_LIST) {
      const abs = join(repoRoot, rel);
      const src = readFileSync(abs, 'utf8');
      const hasLegacy = LEGACY_INSTALL_URL_SUBSTRINGS.some((s) => src.includes(s));
      expect(
        hasLegacy,
        `Allow-list entry ${rel} no longer contains a legacy URL — remove it from LEGACY_URL_ALLOW_LIST.`,
      ).toBe(true);
    }
  });
});

// SQLite migration FK-safety: SQLite refuses `DROP TABLE` on a parent
// table whose children reference live rows when `foreign_keys=ON`, and
// `db/client.ts` enables FKs before running migrations. `PRAGMA foreign_keys`
// cannot be changed inside a transaction and `defer_foreign_keys` does NOT
// defer the DROP-TABLE check (verified empirically). The migration runner
// therefore MUST disable FKs around each migration transaction and run
// `PRAGMA foreign_key_check` as the final pre-commit step. Without this
// dance, any rebuild of a populated parent table fails at startup with
// `rembric: FOREIGN KEY constraint failed` (the production incident that
// motivated openspec/changes/fix-sessions-rebuild-fk-safety/).
describe('migration runner FK-safety invariant', () => {
  const migrateSrc = readFileSync(join(srcRoot, 'db/migrate.ts'), 'utf8');

  it('migrate.ts disables foreign_keys around each migration transaction', () => {
    expect(/PRAGMA\s+foreign_keys\s*=\s*OFF/i.test(migrateSrc)).toBe(true);
    expect(/PRAGMA\s+foreign_keys\s*=\s*ON/i.test(migrateSrc)).toBe(true);
  });

  it('migrate.ts runs PRAGMA foreign_key_check before commit', () => {
    expect(/PRAGMA\s+foreign_key_check/i.test(migrateSrc)).toBe(true);
  });

  it('migrate.ts restores foreign_keys via a finally block', () => {
    // Belt-and-suspenders: a thrown migration must not leave FKs disabled
    // for the rest of the process. The check below is intentionally loose
    // (greps for `finally` near a `PRAGMA foreign_keys = ON`) so a refactor
    // that keeps the semantics passes.
    const finallyBlock = migrateSrc.match(
      /finally\s*\{[\s\S]{0,200}?PRAGMA\s+foreign_keys\s*=\s*ON/i,
    );
    expect(finallyBlock, 'expected a finally block that re-enables foreign_keys').not.toBeNull();
  });
});

describe('oauth additive-migration invariant', () => {
  // The OAuth change promises the static `tokens` table is untouched and the
  // OAuth migration is purely additive (CREATE TABLE only — no rebuild dance).
  const oauthMigration = readFileSync(join(srcRoot, 'db/migrations/0013_oauth_tables.sql'), 'utf8');

  it('0013 never DROPs or ALTERs the static `tokens` table', () => {
    expect(/\b(DROP|ALTER)\s+TABLE\s+tokens\b/i.test(oauthMigration)).toBe(false);
  });

  it('0013 is additive: only CREATE TABLE / CREATE INDEX statements', () => {
    const statements = oauthMigration
      .split(/-->\s*statement-breakpoint/)
      .map((s) =>
        s
          .split('\n')
          .filter((l) => !l.trim().startsWith('--'))
          .join('\n')
          .trim(),
      )
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      expect(/^CREATE\s+(TABLE|INDEX)\b/i.test(stmt), `non-additive statement: ${stmt}`).toBe(true);
    }
  });
});

describe('MCP tool-handler module layout invariant', () => {
  const mcpDir = join(srcRoot, 'mcp');
  const sourceFiles = readdirSync(mcpDir).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
  );
  const handlerModules = sourceFiles.filter((f) => f.endsWith('-tools.ts'));

  it('has no generic tools.ts handler module', () => {
    expect(readdirSync(mcpDir)).not.toContain('tools.ts');
  });

  it('every *-tools.ts module exports exactly one build*Handlers factory', () => {
    for (const file of handlerModules) {
      const src = readFileSync(join(mcpDir, file), 'utf8');
      const matches = src.match(/export function build\w+Handlers\b/g) ?? [];
      expect(matches.length, `${file} must export exactly one build*Handlers factory`).toBe(1);
    }
  });

  it('errToMcp and routerKey are each defined in exactly one module', () => {
    for (const sym of ['errToMcp', 'routerKey']) {
      const definers = sourceFiles.filter((f) =>
        new RegExp(`(?:export )?function ${sym}\\b`).test(readFileSync(join(mcpDir, f), 'utf8')),
      );
      expect(
        definers,
        `${sym} must be defined once; found in: ${definers.join(', ')}`,
      ).toHaveLength(1);
    }
  });
});

// A summary payload is trimmed twice: once by the client that sends it, once by
// the server that stores it. Two tail-cuts are idempotent — the result is the
// last min(bounds) characters — so the bounds are free to disagree. The SIDES
// are not: a client tail-cut followed by a server head-cut yields a middle
// window, which is what shipped until 2026-07-28. Asserting the two numbers
// agreed would have been the wrong guard; it would fail on a correct tree and
// pass on the broken one.
describe('summary truncation keeps the same side in every layer', () => {
  // One entry per language, each pinned to that language's actual tail idiom.
  // Deliberately NOT a generic "contains a minus sign" match: the point is that
  // switching any of these to a head-cut fails here.
  const clientTrimmers = [
    {
      file: 'apps/plugin/scripts/_transcript.sh',
      tail: /\$\{out: -\$RBR_TRANSCRIPT_MAX_CHARS\}/,
      head: /\$\{out:0:\$RBR_TRANSCRIPT_MAX_CHARS\}/,
    },
    {
      file: 'apps/plugin/.opencode-plugin/plugin.ts',
      tail: /body\.slice\(body\.length - MAX_TRANSCRIPT_CHARS\)/,
      head: /body\.slice\(0, MAX_TRANSCRIPT_CHARS\)/,
    },
    {
      file: 'apps/plugin/.hermes-plugin/__init__.py',
      tail: /transcript\[-_SUMMARY_MAX_CHARS:\]/,
      head: /transcript\[:_SUMMARY_MAX_CHARS\]/,
    },
    // Added after this guard shipped with a hole in it: `stop-nudge.sh` bounds the
    // INJECTED payload and was a fourth trimmer the enumeration did not know
    // about, so flipping it to a head-cut would have passed CI on day one.
    {
      file: 'apps/plugin/scripts/stop-nudge.sh',
      tail: /\$\{FACTS: -\$RBR_NUDGE_MAX_FACTS_CHARS\}/,
      head: /\$\{FACTS:0:\$RBR_NUDGE_MAX_FACTS_CHARS\}/,
    },
  ];

  it('the server keeps the tail and marks the front', () => {
    const src = readFileSync(join(srcRoot, 'services', 'agent-sessions.ts'), 'utf8');
    const body = src.slice(src.indexOf('export function truncateSummary'));
    const fn = body.slice(0, body.indexOf('\n}'));
    expect(fn).toContain('sliceTailWithoutSplittingSurrogatePair');
    expect(fn).not.toContain('sliceWithoutSplittingSurrogatePair(');
    expect(fn.indexOf('SUMMARY_TRUNCATE_MARKER +')).toBeGreaterThan(-1);
  });

  it.each(clientTrimmers)('$file keeps the tail', ({ file, tail, head }) => {
    const src = readFileSync(join(repoRoot, file), 'utf8');
    expect(src).toMatch(tail);
    expect(src).not.toMatch(head);
  });

  it('titles deliberately keep the HEAD, and that difference is intentional', () => {
    const src = readFileSync(join(srcRoot, 'services', 'agent-sessions.ts'), 'utf8');
    const body = src.slice(src.indexOf('export function truncateTitle'));
    expect(body.slice(0, body.indexOf('\n}'))).toContain('sliceWithoutSplittingSurrogatePair');
  });
});

// Asserts every surface carries the one definition AND that the enumeration is
// complete. `design.md` said six sites; enumerating them found eight, which is
// why the count is asserted rather than trusted.
describe('the session-summary rubric has one source', () => {
  const surfaces = [
    'apps/server/src/mcp/instructions.ts',
    'apps/server/src/mcp/server.ts',
    'apps/plugin/scripts/prompt-nudge.sh',
    'apps/plugin/scripts/stop-nudge.sh',
    'apps/plugin/scripts/post-compact.sh',
    'apps/plugin/commands/summary.md',
    'apps/plugin/.opencode-plugin/plugin.ts',
    'apps/plugin/.hermes-plugin/__init__.py',
  ];

  it('every surface carries the canonical section list', () => {
    for (const rel of surfaces) {
      const src = readFileSync(join(repoRoot, rel), 'utf8');
      const carriesIt =
        src.includes(SUMMARY_SECTIONS) ||
        // TypeScript surfaces interpolate the constant instead of restating it.
        src.includes('${SUMMARY_SECTIONS}') ||
        // Python wraps it across adjacent string literals.
        SUMMARY_SECTIONS.split(' · ').every((section) => src.includes(section));
      expect(carriesIt, `${rel} does not carry the canonical section list`).toBe(true);
    }
  });

  it('no surface still carries a superseded section name', () => {
    for (const rel of surfaces) {
      const src = readFileSync(join(repoRoot, rel), 'utf8');
      for (const stale of ['Discoveries', 'Next Steps', 'Relevant Files']) {
        expect(src, `${rel} still names '${stale}'`).not.toContain(stale);
      }
    }
  });

  // NOTE: derived from `git grep`, so it only sees TRACKED files — a new surface
  // passes until it is staged. That is why this caught `stop-nudge.sh` at
  // pre-push rather than during development, and it is the correct trade: the
  // alternative walks the working tree and flags scratch files.
  it('the enumeration above is complete', () => {
    const found = execSync(
      `git -C ${repoRoot} grep -l -e 'Goal · ' -e 'SUMMARY_SECTIONS' -- apps/ ':!*.test.*' ':!*/tests/*' || true`,
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean)
      .filter((f) => !f.endsWith('summary-rubric.ts'));
    expect(found.sort()).toEqual([...surfaces].sort());
  });
});
