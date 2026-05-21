import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

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
 * (`src/services/memory.ts::purgeDisconnectedArchived` and
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
      'raw `DELETE FROM memory` is forbidden outside the operator-only purge in services/memory.ts or the dev seed reset in scripts/seed-dev.ts',
    allow: ['services/memory.ts', 'scripts/seed-dev.ts'],
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
    pattern: /delete\s*\(\s*agentSessions\s*\)/i,
    description: 'Drizzle `db.delete(agentSessions)` is forbidden — agent sessions are append-only',
  },
  {
    pattern: /DELETE\s+FROM\s+sessions\b/i,
    description:
      'raw `DELETE FROM sessions` is forbidden outside the operator-only purge in services/agent-sessions.ts or the dev seed reset in scripts/seed-dev.ts',
    allow: ['services/agent-sessions.ts', 'scripts/seed-dev.ts'],
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
      'raw `DELETE FROM prompts` is forbidden outside the operator-only purge in services/prompts.ts or the dev seed reset in scripts/seed-dev.ts',
    allow: ['services/prompts.ts', 'scripts/seed-dev.ts'],
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
  it('allow-list anchors: services/memory.ts contains DELETE FROM memory', () => {
    const file = join(srcRoot, 'services/memory.ts');
    const src = readFileSync(file, 'utf8');
    expect(/DELETE\s+FROM\s+memory\b/i.test(src)).toBe(true);
  });

  it('allow-list anchors: services/agent-sessions.ts contains DELETE FROM sessions', () => {
    const file = join(srcRoot, 'services/agent-sessions.ts');
    const src = readFileSync(file, 'utf8');
    expect(/DELETE\s+FROM\s+sessions\b/i.test(src)).toBe(true);
  });

  it('allow-list anchors: services/prompts.ts contains DELETE FROM prompts', () => {
    const file = join(srcRoot, 'services/prompts.ts');
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
    expect(/LABEL\s+rembric\.stage=runtime\b/.test(runtimeBlock)).toBe(true);
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

  it('docker-publish.yml: `Build and push` step uses target: runtime', () => {
    const yml = readFileSync(join(repoRoot, '.github/workflows/docker-publish.yml'), 'utf8');
    expect(/target:\s*runtime\b/.test(yml)).toBe(true);
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
 * Scope-leak invariant.
 *
 * Application-level RLS is enforced by passing a `Scope` argument into
 * every read/write through `MemoryService`. The scope-bypassing escape
 * hatches are `unsafeGetById` / `unsafeGetByIds`. Those must NOT be
 * called from the MCP layer (which would re-open the bug we just
 * closed). Allow-listed callers: the service itself (private helpers),
 * the consolidation engine (which legitimately crosses scopes), the
 * dashboard admin views, and tests.
 */
const SCOPE_BYPASS_PATTERN = /\.unsafeGetByIds?\b/;
const SCOPE_BYPASS_ALLOWED_PREFIXES = ['services/memory.ts', 'consolidation/', 'dashboard/'];

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

// Per-component versioning (see openspec/changes/restructure-monorepo-apps-layout):
// the previous "all four version sources agree" invariant is removed. Each
// apps/plugin/.X-plugin/ now versions independently via its own release-please
// component. claude-code + codex are linked via release-please's
// linked-versions plugin (cluster `bridge-bundlers`); hermes and opencode
// bump independently. Drift between components is intentional, not a bug.
