import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { RUNTIME_IMAGE_LABEL_FILTER } from '../services/self-update/orchestrator.js';

import { createTestDb } from './db.js';
import { DERIVED_TABLES, SHADOW_TABLE_NAMES, SOURCE_TABLES } from './schema-inventory.js';
import { findSupplyChainViolations, readSupplyChainSources } from './supply-chain-inventory.js';

type DbRaw = ReturnType<typeof createTestDb>['handle']['raw'];

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
    // `[^;]*` rather than `[^)]*`: the narrower form cannot cross a `)`, so a
    // call anywhere in the object literal (`.set({ status: f(), projectId: x })`)
    // slipped past it — measured.
    pattern: /\bupdate\(\s*memory\s*\)[^;]*\.set\([^;]*\bprojectId\s*:/i,
    description:
      '`db.update(memory).set({ projectId: … })` is forbidden — only a schema migration may move a memory between projects',
  },
  {
    // Migrations are exempt by construction: `listSourceFiles` skips the
    // directory and the runner reads `.sql`, which is not scanned at all.
    pattern: /UPDATE\s+memory\b[^;]*\bSET\s+project_id\s*=/i,
    description:
      'raw `UPDATE memory SET project_id = …` is forbidden outside db/migrations/ — the append-only carve-out is a migration-only one',
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
  {
    pattern: /delete\s*\(\s*sessionSummaryVersions\s*\)/i,
    description:
      'Drizzle `db.delete(sessionSummaryVersions)` is forbidden — version rows are append-only, removable only by the `ON DELETE CASCADE` when their session is purged',
  },
  {
    pattern: /DELETE\s+FROM\s+session_summary_versions\b/i,
    description:
      'raw `DELETE FROM session_summary_versions` is forbidden — the cascade on `sessions` is the only removal mechanism, and it needs no DELETE statement of its own',
  },
  {
    pattern:
      /update\([^)]*sessionSummaryVersions[^)]*\)[^.]*\.set\([^)]*(content|title|version|sessionId)\s*:/i,
    description:
      '`db.update(sessionSummaryVersions).set({ content|title|version|sessionId })` is forbidden — a version row is never edited',
  },
  {
    pattern:
      /UPDATE\s+session_summary_versions\b[^;]*\bSET\s+(content|title|version|session_id)\s*=/i,
    description:
      'raw `UPDATE session_summary_versions SET (content|title|version|session_id) = …` is forbidden — a version row is never edited',
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

  /**
   * The DELETE-FROM rules are anchored by their allow-listed files, which must
   * still contain the statement. The two `project_id` rules allow-list nothing —
   * their exemption is `db/migrations/`, which `listSourceFiles` does not scan at
   * all — so with no file to anchor against, a pattern that matches nothing
   * anywhere is indistinguishable from a pattern that is doing its job. Both
   * were measured NOT CAUGHT by a mutation before this existed.
   */
  it('grep anchors: the memory.project_id rules match a known-bad line and not a near miss', () => {
    const rule = (needle: string): ForbiddenRule => {
      const found = FORBIDDEN.filter((r) => r.description.includes(needle));
      expect(found, `no forbidden rule mentions ${needle}`).toHaveLength(1);
      return found[0]!;
    };

    const drizzle = rule('db.update(memory).set({ projectId');
    expect(drizzle.pattern.test('db.update(memory).set({ projectId: id }).run();')).toBe(true);
    expect(
      drizzle.pattern.test('db.update(memory).set({ status: pick(), projectId: id }).run();'),
    ).toBe(true);
    expect(drizzle.pattern.test('db.update(memoryRelations).set({ projectId: id }).run();')).toBe(
      false,
    );

    const raw = rule('raw `UPDATE memory SET project_id');
    expect(raw.pattern.test('sql`UPDATE memory SET project_id = ${id} WHERE id = ${m}`')).toBe(
      true,
    );
    expect(raw.pattern.test('sql`UPDATE memory SET last_seen_at = ${now} WHERE id = ${m}`')).toBe(
      false,
    );
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
    expect(body).toMatch(/const set = precedenceSet\(existing, input, \{ terminal: true \}\);/);
    expect(body).not.toMatch(/\bset\.\w+\s*=/);
    expect(body).not.toMatch(/\bset\[/);
  });

  // `merged` (the section-wise merge of `existing.summary`/`input.summary`,
  // both already summary-precedence-approved) is a legitimate second source
  // for the `summary` key alongside `summary.value` — see
  // "A curated session-summary write MUST be merged section-wise with the
  // stored summary". Deduped because the merge branch and the plain-replace
  // branch both assign `summaryFinal: summary.final`.
  it('precedenceSet can only ever produce summary and title fields', () => {
    const svc = sources[0]!;
    const start = svc.indexOf('function precedenceSet');
    const rawBody = svc.slice(start, svc.indexOf('\n}', start));
    // Strip string/template literals first — the merged-overflow and
    // heading-less DomainError messages contain "sessions: merged", which
    // otherwise matches the same shape as a real object-literal key.
    const body = rawBody.replace(/`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'/gs, '""');
    const keys = [
      ...new Set([...body.matchAll(/(\w+):\s*(?:summary\.|title\.|merged\b)/g)].map((m) => m[1]!)),
    ].sort();
    expect(keys).toEqual(['summary', 'summaryFinal', 'title', 'titleFinal']);
  });
});

// repoRoot points to the monorepo root (../../../ from apps/server/src/test).
// srcRoot resolves to apps/server/src; the actual repo root is two levels up
// from apps/server (one extra `..` for apps, one for the repo).
const repoRoot = join(srcRoot, '..', '..', '..');

/**
 * `pnpm-workspace.yaml::allowBuilds` is the repo's entire install-time
 * code-execution surface, because `.npmrc::ignore-scripts=true` makes lifecycle
 * scripts default-deny. Six prose copies of its membership drifted from it for
 * 54 days and 42 releases; nothing compared any of them to the file.
 *
 * Every failure path is driven against mutated in-memory copies in
 * `supply-chain-inventory.test.ts` — a gate never observed to fail is not a gate.
 */
describe('install-time code-execution surface', () => {
  it('nothing grants install-time code execution unreviewed', () => {
    expect(findSupplyChainViolations(readSupplyChainSources(repoRoot))).toEqual([]);
  });
});

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
 * Admin-method confinement invariant. `admin*` marks an unscoped repository
 * read; the allow-list below is what makes it callable. Spec: data-access,
 * "Scoped, unsafe, and admin method families".
 */
const ADMIN_CALL_PATTERN = /\.(admin[A-Z]\w*)\(/g;

const ADMIN_CALL_SITES: Readonly<Record<string, readonly string[]>> = {
  'server/dashboard-router.ts': [
    'adminCountArchived',
    'adminCountByStatus',
    'adminCountCreatedByDay',
    'adminListRuns',
    'adminOpCounts',
    'adminRecent',
    'adminRecentJudged',
  ],
  'server/bootstrap.ts': [
    'adminBacklogCount',
    'adminCountByStatus',
    'adminCountEntities',
    'adminCountNeedsReview',
    'adminLatestRun',
  ],
  'services/agent-sessions.ts': ['adminCountByStatus'],
  'services/hybrid-search.ts': ['adminDocumentCount', 'adminQueryTermFrequencies'],
};

describe('admin-method confinement invariant', () => {
  const files = listSourceFiles(srcRoot);

  it('every admin* call site is allow-listed by file AND method name', () => {
    const offenders: { file: string; line: number; method: string; text: string }[] = [];
    for (const file of files) {
      const rel = file.slice(srcRoot.length + 1).replace(/\\/g, '/');
      if (rel.startsWith('dashboard/') || rel.startsWith('db/repositories/')) continue;
      const allowed = new Set(ADMIN_CALL_SITES[rel] ?? []);
      const lines = readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
          continue;
        }
        for (const m of line.matchAll(ADMIN_CALL_PATTERN)) {
          const method = m[1]!;
          if (!allowed.has(method)) {
            offenders.push({ file: rel, line: i + 1, method, text: trimmed });
          }
        }
      }
    }
    if (offenders.length > 0) {
      const formatted = offenders
        .map((o) => `  ${o.file}:${o.line}  ${o.method}  ${o.text}`)
        .join('\n');
      throw new Error(
        `admin* repository method called from a call site the (file, method) allow-list does not name.\n${formatted}`,
      );
    }
  });

  it('allow-list anchors: every named (file, method) pair is still called there', () => {
    const stale: string[] = [];
    for (const [rel, methods] of Object.entries(ADMIN_CALL_SITES)) {
      const src = readFileSync(join(srcRoot, rel), 'utf8');
      for (const method of methods) {
        if (!new RegExp(`\\.${method}\\(`).test(src)) stale.push(`${rel}::${method}`);
      }
    }
    expect(stale).toEqual([]);
  });
});

/**
 * Closed inventory of unscoped, un-keyed, unprefixed repository reads. Spec:
 * data-access, "Scoped, unsafe, and admin method families". Set equality, so
 * both directions fail: an unlisted read, and a listed read that is gone.
 */
const REPOSITORIES_DIR = join(srcRoot, 'db/repositories');

const SCOPED_CONTENT_REPOSITORIES = [
  'agent-sessions-repository.ts',
  'entities-repository.ts',
  'memory-repository.ts',
  'prompts-repository.ts',
  'relations-repository.ts',
  'term-statistics-repository.ts',
  'vectors-repository.ts',
] as const;

const CONTROL_PLANE_REPOSITORIES = [
  'consolidation-repository.ts',
  'dashboard-sessions-repository.ts',
  'oauth-repository.ts',
  'projects-repository.ts',
  'tokens-repository.ts',
] as const;

const REPOSITORY_WRITE_VERBS =
  /^(insert|update|set|mark|touch|purge|delete|truncate|revoke|consume|reactivate|archive|abandon|finish|link|reset)/;

const UNSCOPED_UNPREFIXED_READS = [
  'agent-sessions-repository.ts::countPurgeableEmpty',
  'agent-sessions-repository.ts::findPurgeableEmptyIds',
  'agent-sessions-repository.ts::list',
  'entities-repository.ts::findMissingScans',
  'memory-repository.ts::countPurgeableDisconnectedArchived',
  'memory-repository.ts::countRowsByStatus',
  'memory-repository.ts::findPurgeableDisconnectedArchivedIds',
  'prompts-repository.ts::countDeleted',
  'prompts-repository.ts::findDeletedIds',
  'relations-repository.ts::countRowsByStatus',
  'vectors-repository.ts::count',
  'vectors-repository.ts::findMissingEmbeddings',
] as const;

/** The text between `open` and its matching close, exclusive. */
function balancedSpan(src: string, open: number, openCh: string, closeCh: string): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === openCh) depth++;
    else if (src[i] === closeCh) {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return '';
}

/** A method's parameter text with the bodies of same-file `Opts` types folded in. */
function parameterTextWithLocalTypes(src: string, params: string): string {
  let text = params;
  for (const name of new Set(params.match(/\b[A-Z]\w+\b/g) ?? [])) {
    const decl = new RegExp(`\\b(?:interface|type)\\s+${name}\\b[^{]*\\{`).exec(src);
    if (decl) text += ` ${balancedSpan(src, decl.index + decl[0].length - 1, '{', '}')}`;
  }
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function unscopedUnprefixedReads(src: string): string[] {
  const classStart = src.search(/^export class /m);
  if (classStart === -1) return [];
  const found: string[] = [];
  for (const m of src.matchAll(/^ {2}(private |protected |static )?([A-Za-z_]\w*)\(/gm)) {
    if (m.index < classStart) continue;
    const [, modifier, name] = m;
    if (modifier || name === 'constructor') continue;
    if (/^(admin|unsafe)/.test(name!) || REPOSITORY_WRITE_VERBS.test(name!)) continue;
    const params = parameterTextWithLocalTypes(
      src,
      balancedSpan(src, m.index + m[0].length - 1, '(', ')'),
    );
    // `partition_key` is `memory_vec`'s scope column; a search names a set of them.
    if (/\b(scope|projectId|partitionKeys?)\b/.test(params)) continue;
    if (/\b\w*[Ii]ds?\b/.test(params)) continue;
    found.push(name!);
  }
  return found;
}

describe('unscoped repository read inventory', () => {
  it('every repository file is classified as scoped-content or control-plane', () => {
    const actual = readdirSync(REPOSITORIES_DIR)
      .filter(
        (f) =>
          f.endsWith('.ts') &&
          !f.endsWith('.test.ts') &&
          f !== 'index.ts' &&
          f !== 'scope-clause.ts',
      )
      .sort();
    expect(actual).toEqual([...SCOPED_CONTENT_REPOSITORIES, ...CONTROL_PLANE_REPOSITORIES].sort());
  });

  it('the unscoped, un-keyed, unprefixed reads are exactly the inventory', () => {
    const found: string[] = [];
    for (const file of SCOPED_CONTENT_REPOSITORIES) {
      const src = readFileSync(join(REPOSITORIES_DIR, file), 'utf8');
      for (const name of unscopedUnprefixedReads(src)) found.push(`${file}::${name}`);
    }
    expect(found.sort()).toEqual([...UNSCOPED_UNPREFIXED_READS].sort());
  });
});

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

const OPENCODE_PLUGIN_TS = 'apps/plugin/.opencode-plugin/plugin.ts';
const REMBRIC_DOTENV_MJS = 'apps/plugin/mcp-bridge/rembric-dotenv.mjs';
const MCP_BRIDGE_MJS = 'apps/plugin/mcp-bridge/bridge.mjs';
const REMBRIC_PLUGIN_CORE_MJS = 'apps/plugin/bin/rembric-plugin-core.mjs';

// Every helper the JS/TS clients share, with the ONE file allowed to define it.
// The bash and Python clients keep their own, held in agreement by the fixtures.
const SHARED_JS_HELPERS: Array<{ symbol: string; definition: RegExp; canonical: string }> = [
  {
    symbol: 'parseDotenv',
    definition: /\bfunction\s+parseDotenv\b/,
    canonical: REMBRIC_DOTENV_MJS,
  },
  { symbol: 'SLUG_RE', definition: /\bSLUG_RE\s*=\s*\//, canonical: REMBRIC_DOTENV_MJS },
  {
    symbol: 'stripPrivateTags',
    definition: /\bfunction\s+stripPrivateTags\b/,
    canonical: REMBRIC_PLUGIN_CORE_MJS,
  },
  { symbol: 'truncate', definition: /\bfunction\s+truncate\b/, canonical: REMBRIC_PLUGIN_CORE_MJS },
  {
    symbol: 'underscoreToolNames',
    definition: /\bfunction\s+underscoreToolNames\b/,
    canonical: REMBRIC_PLUGIN_CORE_MJS,
  },
  {
    symbol: 'rembricPost',
    definition: /\bfunction\s+rembricPost\b/,
    canonical: REMBRIC_PLUGIN_CORE_MJS,
  },
  {
    symbol: 'RECALL_NUDGE',
    definition: /\bconst\s+RECALL_NUDGE\s*=/,
    canonical: REMBRIC_PLUGIN_CORE_MJS,
  },
  {
    symbol: 'FIRST_PROMPT_NUDGE',
    definition: /\bconst\s+FIRST_PROMPT_NUDGE\s*=/,
    canonical: REMBRIC_PLUGIN_CORE_MJS,
  },
  {
    symbol: 'SAVE_NUDGE',
    definition: /\bconst\s+SAVE_NUDGE\s*=/,
    canonical: REMBRIC_PLUGIN_CORE_MJS,
  },
  {
    symbol: 'SUMMARY_NUDGE',
    definition: /\bconst\s+SUMMARY_NUDGE\s*=/,
    canonical: REMBRIC_PLUGIN_CORE_MJS,
  },
  {
    symbol: 'SESSION_ID_NUDGE_TEMPLATE',
    definition: /\bconst\s+SESSION_ID_NUDGE_TEMPLATE\s*=/,
    canonical: REMBRIC_PLUGIN_CORE_MJS,
  },
  {
    symbol: 'RESUMED_READ_NUDGE',
    definition: /\bconst\s+RESUMED_READ_NUDGE\s*=/,
    canonical: REMBRIC_PLUGIN_CORE_MJS,
  },
];

// Tests are excluded because some legitimately re-declare the nudge constants as
// their expected values; `.d.mts` because a declaration is a type for the
// canonical implementation, never a second copy of it.
const PLUGIN_JS_PATHSPECS = [
  'apps/plugin/*.ts',
  'apps/plugin/*.mts',
  'apps/plugin/*.mjs',
  'apps/plugin/*.js',
  ':!*.test.ts',
  ':!*.test.mts',
  ':!*.test.mjs',
  ':!*.d.mts',
];

describe('the JS/TS plugin clients share one implementation of each protocol helper', () => {
  // `git grep` sees TRACKED files only, so a new client passes until it is
  // staged; the alternative walks the working tree and flags scratch files.
  const scanned = execSync(
    `git -C ${repoRoot} grep -l -E '.' -- ${PLUGIN_JS_PATHSPECS.map((p) => `'${p}'`).join(' ')} || true`,
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);

  // Derived from the `.<client>-plugin/` directory shape, so a client added later
  // is covered on the day it lands.
  const clients = scanned.filter((f) => /^apps\/plugin\/\.[\w-]+-plugin\//.test(f));

  it('the scanned file list is non-empty and covers every JS/TS client', () => {
    expect(
      scanned.length,
      'the pathspec matched nothing, so the per-helper assertions below would prove nothing',
    ).toBeGreaterThan(0);
    expect(
      clients.length,
      `fewer than the two known JS/TS clients matched, so the client assertions below would prove little; scanned: ${scanned.join(', ')}`,
    ).toBeGreaterThanOrEqual(2);
    // Explicit list: unlike the client set these are closed, so losing one is a
    // regression rather than a rename.
    for (const known of [REMBRIC_DOTENV_MJS, MCP_BRIDGE_MJS, REMBRIC_PLUGIN_CORE_MJS]) {
      expect(scanned, `${known} is no longer scanned`).toContain(known);
    }
    expect(scanned.filter((f) => f.includes('.test.'))).toEqual([]);
  });

  it('each shared helper is defined in exactly one scanned file', () => {
    const sources = new Map(scanned.map((f) => [f, readFileSync(join(repoRoot, f), 'utf8')]));
    for (const { symbol, definition, canonical } of SHARED_JS_HELPERS) {
      const definers = scanned.filter((f) => definition.test(sources.get(f)!));
      const located = definers.map((f) => {
        const lines = sources.get(f)!.split('\n');
        return `${f}:${lines.findIndex((l) => definition.test(l)) + 1}`;
      });
      expect(
        definers,
        `${symbol} must have exactly one JS/TS definition, in ${canonical}; found ${located.join(', ') || 'none'}`,
      ).toEqual([canonical]);
    }
  });

  // Derived rather than enumerated: the hand-written list above covers whichever
  // symbols someone remembered, which left 20 of the core's 25 functions
  // unenforced — a duplicated `flushSessionSummary` passed the whole suite.
  it('no other scanned file defines a function the protocol core owns', () => {
    const coreSrc = readFileSync(join(repoRoot, REMBRIC_PLUGIN_CORE_MJS), 'utf8');
    const owned = [
      ...new Set(
        [...coreSrc.matchAll(/(?:^|\s)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)].map(
          (m) => m[1],
        ),
      ),
    ];
    expect(
      owned.length,
      'no function names parsed out of the core, so the assertion below would pass vacuously',
    ).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const rel of scanned.filter((f) => f !== REMBRIC_PLUGIN_CORE_MJS)) {
      const lines = readFileSync(join(repoRoot, rel), 'utf8').split('\n');
      for (const name of owned) {
        const re = new RegExp(`(?:^|\\s)(?:async\\s+)?function\\s+${name}\\b`);
        const at = lines.findIndex((l) => re.test(l));
        if (at >= 0) offenders.push(`${rel}:${at + 1} defines ${name}`);
      }
    }
    expect(
      offenders,
      `import these from ${REMBRIC_PLUGIN_CORE_MJS} instead of redefining them: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('plugin.ts and the published bridge import the slug helpers instead of redefining them', () => {
    for (const rel of [OPENCODE_PLUGIN_TS, MCP_BRIDGE_MJS]) {
      expect(
        /from\s+['"][^'"]*rembric-dotenv\.mjs['"]/.test(readFileSync(join(repoRoot, rel), 'utf8')),
        `${rel} must import slug helpers from rembric-dotenv.mjs`,
      ).toBe(true);
    }
  });

  it('every JS/TS client imports the protocol core instead of reimplementing it', () => {
    for (const rel of clients) {
      expect(
        /from\s+['"][^'"]*rembric-plugin-core\.mjs['"]/.test(
          readFileSync(join(repoRoot, rel), 'utf8'),
        ),
        `${rel} must import the session protocol from rembric-plugin-core.mjs`,
      ).toBe(true);
    }
  });
});

const PI_PACKAGE_DIR = 'apps/plugin/.pi-plugin';

// `prepack`/`prepare`/`prepublishOnly` run at pack time; the install trio runs on
// a consumer's machine.
const FORBIDDEN_PUBLISHED_LIFECYCLE_KEYS = [
  'prepack',
  'prepare',
  'prepublishOnly',
  'preinstall',
  'install',
  'postinstall',
];

type PublishedManifest = {
  path: string;
  name?: string;
  version?: string;
  files?: unknown;
  private?: unknown;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
};

const publishedManifests = execSync(
  `git -C ${repoRoot} ls-files -- 'apps/plugin/**/package.json' 'apps/plugin/package.json'`,
  { encoding: 'utf8' },
)
  .split('\n')
  .filter(Boolean)
  .map((path): PublishedManifest => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, path), 'utf8')) as Omit<
      PublishedManifest,
      'path'
    >;
    return { path, ...manifest };
  })
  .filter((manifest) => manifest.private !== true || Array.isArray(manifest.files));

describe('the published npm packages', () => {
  it('derives the published package set from workspace manifests', () => {
    expect(publishedManifests.length).toBeGreaterThanOrEqual(2);
  });

  it('has no lifecycle scripts, private flag, or missing files allowlist', () => {
    for (const manifest of publishedManifests) {
      const declared = FORBIDDEN_PUBLISHED_LIFECYCLE_KEYS.filter(
        (key) => manifest.scripts?.[key] !== undefined,
      );
      expect(
        declared,
        `${manifest.path} declares ${declared.join(', ')}; materialise in an explicit CI step instead. Why: scripts/pi-package.mjs and openspec/specs/supply-chain-hygiene/spec.md.`,
      ).toEqual([]);
      expect(manifest.files, `${manifest.path} must declare a files allowlist`).toEqual(
        expect.arrayContaining([expect.any(String)]),
      );
      expect(manifest.private, `${manifest.path} must not be private`).toBeUndefined();
    }
  });

  it('declares no runtime dependencies', () => {
    for (const manifest of publishedManifests) {
      expect(
        manifest.dependencies ?? {},
        `${manifest.path} must have no runtime dependencies`,
      ).toEqual({});
    }
  });

  it('tracks only its four development files, so materialised resources cannot be committed', () => {
    const tracked = execSync(`git ls-files ${PI_PACKAGE_DIR}`, {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .map((p) => p.slice(`${PI_PACKAGE_DIR}/`.length))
      .sort();
    expect(tracked).toEqual(['README.md', 'index.ts', 'package.json', 'plugin.test.ts']);
  });
});

// Plugin versioning (see openspec/changes/unify-plugin-release-track): all of
// apps/plugin/ versions under ONE unified release-please `plugin` component,
// so every client carrier (.claude-plugin/{package,plugin}.json,
// .codex-plugin/{package,plugin}.json, .hermes-plugin/plugin.yaml,
// .opencode-plugin/plugin.ts) shares a single version. There is no
// node-workspace cascade and no per-client component. Documented spawn sites
// are checked too because Hermes has no tracked MCP manifest.

describe('the bridge version carriers', () => {
  const pluginVersion = (
    JSON.parse(readFileSync(join(repoRoot, 'apps/plugin/package.json'), 'utf8')) as {
      version: string;
    }
  ).version;

  it('keeps every bridge pin equal to the unified plugin version', () => {
    const pin = /@rembric\/mcp-bridge@(\d+\.\d+\.\d+)/g;
    const carriers = execSync(
      `git -C ${repoRoot} grep -l -E '@rembric/mcp-bridge@[0-9]+\\.[0-9]+\\.[0-9]+' -- ':!openspec/**' ':!*.test.*' || true`,
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
    expect(carriers, 'no operational bridge pin carriers were found').not.toHaveLength(0);
    for (const carrier of carriers) {
      const pins = [...readFileSync(join(repoRoot, carrier), 'utf8').matchAll(pin)].map(
        (match) => match[1],
      );
      expect(pins, `${carrier} must carry at least one bridge pin`).not.toHaveLength(0);
      expect(pins, `${carrier} must use the unified plugin version`).toEqual(
        pins.map(() => pluginVersion),
      );
    }
    const bridgeVersion = publishedManifests.find(
      (manifest) => manifest.name === '@rembric/mcp-bridge',
    )?.version;
    expect(bridgeVersion).toBe(pluginVersion);
    const opencode = readFileSync(join(repoRoot, 'apps/plugin/.opencode-plugin/plugin.ts'), 'utf8');
    expect(opencode).toContain(`const MCP_BRIDGE_VERSION = '${pluginVersion}';`);
  });
});

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

// Per-transport discovery state in a module-level registry only misbehaves
// observably when two transports are live, so a re-introduced global would pass
// every single-transport test. Asserted here as well as behaviourally.
describe('roots-discovery state ownership invariant', () => {
  const src = readFileSync(join(srcRoot, 'mcp/roots-discovery.ts'), 'utf8');

  it('declares no module-level mutable registry of per-transport state', () => {
    const registries = src.match(/^(?:const|let|var)\s+\w+[^=\n]*=\s*new\s+(?:Set|Map|Array)\b/gm);
    expect(registries, 'per-transport state must hang off the connection, not the module').toBe(
      null,
    );
  });

  it('owns that state through a WeakMap keyed by the connection server', () => {
    // The anti-vacuity control for the assertion above: without it, deleting the
    // ownership mechanism outright would also pass.
    expect(/^const\s+\w+\s*=\s*new\s+WeakMap<McpServer,/m.test(src)).toBe(true);
  });

  it('clears no collection, so no helper can reset every transport at once', () => {
    expect(src).not.toMatch(/\.clear\(\)/);
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
      file: REMBRIC_PLUGIN_CORE_MJS,
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
    REMBRIC_PLUGIN_CORE_MJS,
    'apps/plugin/.hermes-plugin/__init__.py',
  ];

  it('every surface carries the canonical section list', () => {
    const headings = [
      '## Goal',
      '## Accomplished',
      '## Decisions+why',
      '## Verified+how',
      '## Unfinished+why',
      '## Files',
    ];
    const directive =
      'Use exactly these six Markdown level-2 headings, in this order, each on its own line (never one flat paragraph):';
    const flatRubric =
      'Goal · Accomplished · Decisions+why · Verified+how · Unfinished+why · Files';
    for (const rel of surfaces) {
      const src = readFileSync(join(repoRoot, rel), 'utf8');
      const joined = src
        .replace(/"\s*\n\s*"/g, '')
        .replace(/'\s*\n\s*'/g, '')
        .replaceAll('\\n', '\n')
        .replace(/\n\s*\n/g, '\n');
      const interpolated = src.includes('${SUMMARY_SECTIONS}');
      const contract = `${directive}\n${headings.join('\n')}`;
      expect(
        interpolated || joined.includes(contract),
        `${rel} omits the canonical directive`,
      ).toBe(true);
      expect(src, `${rel} still carries the flat rubric`).not.toContain(flatRubric);
      if (!interpolated) {
        const at = joined.indexOf(contract);
        const after = joined.slice(at + contract.length);
        expect(after, `${rel} appends another Markdown heading`).not.toMatch(/^\n## /);
      }
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
    const candidates = execSync(
      `git -C ${repoRoot} ls-files -- apps/ ':!*.test.*' ':!*/tests/*' ':!apps/plugin/test/**' ':!apps/plugin/bin/rembric-bridge.mjs'`,
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
    const found = candidates.filter((rel) => {
      const src = readFileSync(join(repoRoot, rel), 'utf8');
      const joined = src
        .replace(/"\s*\n\s*"/g, '')
        .replace(/'\s*\n\s*'/g, '')
        .replaceAll('\\n', '\n');
      if (
        rel.endsWith('summary-rubric.ts') ||
        rel.endsWith('invariants.test.ts') ||
        rel.includes('/tests/') ||
        rel.endsWith('.test.ts')
      )
        return false;
      return (
        joined.includes('Use exactly these six Markdown level-2 headings') ||
        src.includes('${SUMMARY_SECTIONS}')
      );
    });
    expect(found.sort()).toEqual([...surfaces].sort());
  });
});

// A SECOND, independent enumeration: compaction-time protocol text is a
// different class of surface from the always-present rubric above, and that
// guard can only ever see surfaces that carry ITS OWN canonical section
// list — this block's text never did, which is why .opencode-plugin/plugin.ts
// shipped a hand-written, diverging copy for a whole phase undetected
// (design.md D24). Grepped by a marker specific to THIS text so the two
// enumerations stay independent.
describe('the post-compaction protocol text has one source', () => {
  const surfaces = [
    'apps/plugin/scripts/post-compact.sh',
    REMBRIC_PLUGIN_CORE_MJS,
    OPENCODE_PLUGIN_TS,
    'apps/plugin/.hermes-plugin/__init__.py',
  ];

  // NOTE: derived from `git grep`, so it only sees TRACKED files — stage the
  // plugin files before running it, same caveat as the rubric enumeration
  // above. `plugin.ts` carries no literal copy of the text (it imports
  // POST_COMPACT_NUDGE_CORE), so the symbol name is grepped alongside the
  // literal marker — `.d.mts`'s declaration and the JSON fixture also name
  // that symbol/text and are excluded, as summary-rubric.ts is above.
  it('the enumeration above is complete', () => {
    const found = execSync(
      `git -C ${repoRoot} grep -l -e 'This session resumes from a compaction' -e 'POST_COMPACT_NUDGE_CORE' -- apps/ ':!*.test.*' ':!*/tests/*' ':!*.d.mts' ':!apps/plugin/test/nudge-fixtures.json' || true`,
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
    expect(found.sort()).toEqual([...surfaces].sort());
  });
});

describe('derived-table reproducibility invariant', () => {
  function ownedTables(raw: DbRaw): string[] {
    const shadows = new Set(SHADOW_TABLE_NAMES);
    return raw
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all()
      .map((r) => r.name)
      .filter((n) => !shadows.has(n));
  }

  const fixture = createTestDb();
  afterAll(() => fixture.cleanup());

  it('classifies every owned table as exactly one of source or derived', () => {
    const owned = ownedTables(fixture.handle.raw);
    const classified = [...SOURCE_TABLES, ...Object.keys(DERIVED_TABLES)].sort();

    const both = classified.filter(
      (t) => (SOURCE_TABLES as readonly string[]).includes(t) && t in DERIVED_TABLES,
    );
    expect(both, 'table classified as BOTH source and derived').toEqual([]);

    const unclassified = owned.filter((t) => !classified.includes(t));
    expect(
      unclassified,
      `unclassified table(s) in the schema: ${unclassified.join(', ')}. Every table must be ` +
        'named in SOURCE_TABLES or DERIVED_TABLES (persistence: "Every derived table MUST be ' +
        'reproducible from source tables by a pinned recipe").',
    ).toEqual([]);

    // A partition, not a subset: a listed table that no longer exists is drift too.
    expect([...owned].sort()).toEqual(classified);
  });

  it('every named trigger exists in the migrated schema', () => {
    const triggers = new Set(
      fixture.handle.raw
        .prepare<[], { name: string }>(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)
        .all()
        .map((r) => r.name),
    );
    for (const [table, entry] of Object.entries(DERIVED_TABLES)) {
      if (!entry.triggers) continue;
      for (const t of entry.triggers) {
        expect(triggers.has(t), `${table} names trigger '${t}', absent from sqlite_master`).toBe(
          true,
        );
      }
    }
  });

  it('every named rebuild entry point is still exported by the module it names', () => {
    for (const [table, entry] of Object.entries(DERIVED_TABLES)) {
      if (!entry.rebuild) continue;
      const src = readFileSync(join(srcRoot, entry.rebuild.module), 'utf8');
      const exported = new RegExp(
        `export\\s+(?:async\\s+)?(?:function|const)\\s+${entry.rebuild.entryPoint}\\b`,
      ).test(src);
      expect(
        exported,
        `${table} names ${entry.rebuild.entryPoint} in ${entry.rebuild.module}, not exported there`,
      ).toBe(true);
    }
  });

  it('every release-variable recipe names an exported version marker', () => {
    const markerModules = ['embeddings/embedder.ts', 'services/entities.ts'];
    const sources = markerModules.map((m) => readFileSync(join(srcRoot, m), 'utf8')).join('\n');
    for (const [table, entry] of Object.entries(DERIVED_TABLES)) {
      if (!entry.markers) continue;
      for (const marker of entry.markers) {
        expect(
          new RegExp(`export\\s+const\\s+${marker}\\b`).test(sources),
          `${table} names marker ${marker}, not exported by any of ${markerModules.join(', ')}`,
        ).toBe(true);
      }
    }
  });
});

/**
 * Scope-is-one-arm invariant.
 *
 * `Scope` carries a single `{ kind: 'project' }` arm. The global arm and every
 * symbol that served it were deleted; nothing may reintroduce one, in
 * production code OR in a fixture — the retrieval harness kept its own copy of
 * the global scope alive long after the production one stopped being reachable,
 * which is how a phantom arm survived a release.
 *
 * The `memory.scope` COLUMN is a different thing and is deliberately NOT
 * matched here: it is still written as the constant `'project'`, the migration
 * tests still construct pre-migration rows carrying `'global'`, and its removal
 * is a separate change (memory/spec.md).
 */
const GLOBAL_SCOPE_PATTERNS: { pattern: RegExp; description: string }[] = [
  { pattern: /\bSCOPE_GLOBAL\b/, description: '`SCOPE_GLOBAL` — deleted with the global arm' },
  {
    pattern: /\bGLOBAL_PARTITION_KEY\b/,
    description: '`GLOBAL_PARTITION_KEY` — deleted; a partition key is a project id',
  },
  {
    pattern: /kind:\s*'global'/,
    description: "`{ kind: 'global' }` — constructing a global Scope",
  },
  {
    pattern: /kind\s*===\s*'global'/,
    description: "`kind === 'global'` — branching on a Scope arm that does not exist",
  },
];

/**
 * Every `.ts` under `src/`, tests included: a fixture may not reintroduce it
 * either. This file is the one exclusion — it names the forbidden tokens in
 * order to forbid them, so it matches its own patterns.
 */
function listAllTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'migrations') continue;
      out.push(...listAllTsFiles(full));
      continue;
    }
    if (entry.endsWith('.ts') && entry !== 'invariants.test.ts') out.push(full);
  }
  return out;
}

function scanForPattern(
  files: readonly string[],
  pattern: RegExp,
): { file: string; line: number; text: string }[] {
  const matches: { file: string; line: number; text: string }[] = [];
  for (const file of files) {
    const rel = file.slice(srcRoot.length + 1).replace(/\\/g, '/');
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i]!.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      if (pattern.test(trimmed)) matches.push({ file: rel, line: i + 1, text: trimmed });
    }
  }
  return matches;
}

describe('scope-is-one-arm invariant', () => {
  const files = listAllTsFiles(srcRoot);

  // Non-vacuity control. Every assertion below is negative, and an empty file
  // list — or a scan that never reads a line — satisfies all of them. This
  // greps for a token that MUST be present, through the identical scanner.
  it('the scan reaches source files and reads their non-comment lines', () => {
    expect(files.filter((f) => f.endsWith('.test.ts')).length).toBeGreaterThan(50);
    const control = scanForPattern(files, /\bprojectScope\(/);
    expect(control.length).toBeGreaterThan(20);
    expect(new Set(control.map((m) => m.file)).size).toBeGreaterThan(5);
  });

  for (const { pattern, description } of GLOBAL_SCOPE_PATTERNS) {
    it(`no file reintroduces ${description}`, () => {
      const matches = scanForPattern(files, pattern);
      expect(
        matches.length,
        matches.map((m) => `  ${m.file}:${m.line}  ${m.text}`).join('\n'),
      ).toBe(0);
    });
  }
});

/**
 * One-construction-site invariant for the widened search scope.
 *
 * A widened scope carries its own authorization decision, so a second place
 * that builds one is a second place that decides who may read what — the shape
 * `auth/spec.md` forbids ("constructed at exactly one site that has already
 * made that decision"). The compiler already refuses the value on every write;
 * this is the second line, for the case the compiler cannot see: another
 * request-facing module assembling the literal itself.
 */
const WIDENED_SCOPE_DISCRIMINANT = /'authorized-projects'/;
const WIDENED_SCOPE_SITES: Record<string, number> = {
  'services/scope.ts': 1,
  'mcp/_shared.ts': 1,
};

describe('the widened scope has one construction site', () => {
  const production = listAllTsFiles(srcRoot).filter(
    (f) =>
      !f.endsWith('.test.ts') &&
      !f
        .slice(srcRoot.length + 1)
        .replace(/\\/g, '/')
        .startsWith('test/'),
  );

  it('the scan reaches the production tree', () => {
    expect(production.length).toBeGreaterThan(100);
    const control = scanForPattern(production, /\bprojectScope\(/);
    expect(new Set(control.map((m) => m.file)).size).toBeGreaterThan(5);
  });

  it('names the discriminant in exactly the declaring module and the one builder', () => {
    const matches = scanForPattern(production, WIDENED_SCOPE_DISCRIMINANT);

    // Non-vacuity: a rename would empty this, and every count assertion below
    // would then hold over nothing.
    expect(matches.length).toBeGreaterThan(0);

    const byFile: Record<string, number> = {};
    for (const m of matches) byFile[m.file] = (byFile[m.file] ?? 0) + 1;
    expect(byFile, matches.map((m) => `  ${m.file}:${m.line}  ${m.text}`).join('\n')).toEqual(
      WIDENED_SCOPE_SITES,
    );
  });
});
