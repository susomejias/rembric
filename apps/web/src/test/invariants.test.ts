import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RUNTIME_IMAGE_LABEL_FILTER } from '@rembric/core';
import type { RequestContext } from '@rembric/core';
import { defaultMigrationsDir } from '@rembric/db';
import { afterAll, describe, expect, it } from 'vitest';

import { createTestDb } from './db.js';
import { DERIVED_TABLES, SHADOW_TABLE_NAMES, SOURCE_TABLES } from './schema-inventory.js';
import { findSupplyChainViolations, readSupplyChainSources } from './supply-chain-inventory.js';

type DbRaw = ReturnType<typeof createTestDb>['handle']['raw'];

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');
const repoRoot = join(srcRoot, '..', '..', '..');
const dbRoot = join(repoRoot, 'packages/db/src');
const coreRoot = join(repoRoot, 'packages/core/src');
const mcpRoot = join(repoRoot, 'packages/mcp/src');

function relToRepo(file: string): string {
  return relative(repoRoot, file).split(sep).join('/');
}

function scanRoots(): string[] {
  return [
    ...listSourceFiles(srcRoot),
    ...listSourceFiles(coreRoot),
    ...listSourceFiles(dbRoot),
    ...listSourceFiles(mcpRoot),
  ];
}

interface ForbiddenRule {
  pattern: RegExp;
  description: string;
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
      'raw `DELETE FROM memory` is forbidden outside the operator-only purge in packages/db/src/repositories/memory-repository.ts or the dev seed reset in apps/web/src/scripts/seed-dev.ts',
    allow: [
      'packages/db/src/repositories/memory-repository.ts',
      'apps/web/src/scripts/seed-dev.ts',
    ],
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
    pattern: /\bupdate\(\s*memory\s*\)[^;]*\.set\([^;]*\bprojectId\s*:/i,
    description:
      '`db.update(memory).set({ projectId: … })` is forbidden — only a schema migration may move a memory between projects',
  },
  {
    pattern: /UPDATE\s+memory\b[^;]*\bSET\s+project_id\s*=/i,
    description:
      'raw `UPDATE memory SET project_id = …` is forbidden outside packages/db/src/migrations/ — the append-only carve-out is a migration-only one',
  },
  {
    pattern: /delete\s*\(\s*agentSessions\s*\)/i,
    description: 'Drizzle `db.delete(agentSessions)` is forbidden — agent sessions are append-only',
  },
  {
    pattern: /DELETE\s+FROM\s+sessions\b/i,
    description:
      'raw `DELETE FROM sessions` is forbidden outside the operator-only purge in packages/db/src/repositories/agent-sessions-repository.ts or the dev seed reset in apps/web/src/scripts/seed-dev.ts',
    allow: [
      'packages/db/src/repositories/agent-sessions-repository.ts',
      'apps/web/src/scripts/seed-dev.ts',
    ],
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
  {
    pattern: /delete\s*\(\s*memoryRelations\s*\)/i,
    description:
      'Drizzle `db.delete(memoryRelations)` is forbidden — relations are append-only with status FSM',
  },
  {
    pattern: /DELETE\s+FROM\s+memory_relations\b/i,
    description:
      'raw `DELETE FROM memory_relations` is forbidden — relations are append-only, except in the dev seed reset (apps/web/src/scripts/seed-dev.ts)',
    allow: ['apps/web/src/scripts/seed-dev.ts'],
  },
  {
    pattern: /delete\s*\(\s*prompts\s*\)/i,
    description:
      'Drizzle `db.delete(prompts)` is forbidden — prompts are append-only (lifecycle is `deleted_at` flips + `replaces`)',
  },
  {
    pattern: /DELETE\s+FROM\s+prompts\b/i,
    description:
      'raw `DELETE FROM prompts` is forbidden outside the operator-only purge in packages/db/src/repositories/prompts-repository.ts or the dev seed reset in apps/web/src/scripts/seed-dev.ts',
    allow: [
      'packages/db/src/repositories/prompts-repository.ts',
      'apps/web/src/scripts/seed-dev.ts',
    ],
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
      if (entry === 'migrations') continue;
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
  const files = scanRoots();

  it('discovers source files to scan', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const rule of FORBIDDEN) {
    const { pattern, description, allow } = rule;
    it(`forbids: ${description}`, () => {
      const offenders: { file: string; line: number; text: string }[] = [];
      const allowed = new Set((allow ?? []).map((p) => p.replace(/\\/g, '/')));
      for (const file of files) {
        const rel = relToRepo(file);
        if (allowed.has(rel)) continue;
        const lines = readFileSync(file, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
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

  it('allow-list anchors: packages/db/src/repositories/memory-repository.ts contains DELETE FROM memory', () => {
    const file = join(dbRoot, 'repositories/memory-repository.ts');
    const src = readFileSync(file, 'utf8');
    expect(/DELETE\s+FROM\s+memory\b/i.test(src)).toBe(true);
  });

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

  it('allow-list anchors: packages/db/src/repositories/agent-sessions-repository.ts contains DELETE FROM sessions', () => {
    const file = join(dbRoot, 'repositories/agent-sessions-repository.ts');
    const src = readFileSync(file, 'utf8');
    expect(/DELETE\s+FROM\s+sessions\b/i.test(src)).toBe(true);
  });

  it('allow-list anchors: packages/db/src/repositories/prompts-repository.ts contains DELETE FROM prompts', () => {
    const file = join(dbRoot, 'repositories/prompts-repository.ts');
    const src = readFileSync(file, 'utf8');
    expect(/DELETE\s+FROM\s+prompts\b/i.test(src)).toBe(true);
  });

  it('schema/prompts.ts declares content as immutable in its docstring', () => {
    const file = join(dbRoot, 'schema/prompts.ts');
    const src = readFileSync(file, 'utf8');
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

describe('session lifecycle-column invariants', () => {
  const SESSION_WRITERS = [
    'packages/core/src/services/agent-sessions.ts',
    'packages/db/src/repositories/agent-sessions-repository.ts',
  ] as const;

  const sources = SESSION_WRITERS.map((rel) => readFileSync(join(repoRoot, rel), 'utf8'));

  it('the terminal write path adds nothing to the precedence fields', () => {
    const svc = sources[0]!;
    const start = svc.indexOf('private writeTerminalFields');
    expect(start).toBeGreaterThan(-1);
    const body = svc.slice(start, svc.indexOf('\n  }', start));
    expect(body).toMatch(
      /const set = precedenceSet\(existing, input, this\.now\(\), \{ terminal: true \}\);/,
    );
    expect(body).not.toMatch(/\bset\.\w+\s*=/);
    expect(body).not.toMatch(/\bset\[/);
  });

  it('precedenceSet can only ever produce summary, title and last_summary_at fields', () => {
    const svc = sources[0]!;
    const start = svc.indexOf('function precedenceSet');
    const rawBody = svc.slice(start, svc.indexOf('\n}', start));
    const body = rawBody.replace(/`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'/gs, '""');
    const keys = [
      ...new Set(
        [...body.matchAll(/(\w+):\s*(?:summary\.|title\.|merged\b|laterOf\b)/g)].map((m) => m[1]!),
      ),
    ].sort();
    expect(keys).toEqual(['lastSummaryAt', 'summary', 'summaryFinal', 'title', 'titleFinal']);
  });
});

describe('install-time code-execution surface', () => {
  it('nothing grants install-time code execution unreviewed', () => {
    expect(findSupplyChainViolations(readSupplyChainSources(repoRoot))).toEqual([]);
  });
});

const PROD_STAGE = 'runner';
const prodDockerfile = (): string => readFileSync(join(repoRoot, 'apps/web/Dockerfile'), 'utf8');

describe('image packaging invariants', () => {
  function compositeActionInput(action: string, name: string): string {
    const lines = action.split('\n');
    const start = lines.findIndex((line) => line === `  ${name}:`);
    expect(start).toBeGreaterThan(-1);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => /^ {2}[a-z][\w-]*:$/.test(line));
    return (end === -1 ? rest : rest.slice(0, end)).join('\n');
  }

  it('Dockerfile: the LAST `FROM ... AS <name>` stage is the production stage', () => {
    const stages = [...prodDockerfile().matchAll(/^FROM\s+\S+\s+AS\s+(\w+)/gim)].map((m) => m[1]);
    expect(stages.length).toBeGreaterThan(1);
    expect(stages[stages.length - 1]).toBe(PROD_STAGE);
  });

  it('Dockerfile: the production stage declares LABEL rembric.stage=runtime', () => {
    const dockerfile = prodDockerfile();
    const runtimeIdx = dockerfile.search(
      new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${PROD_STAGE}\\b`, 'm'),
    );
    expect(runtimeIdx).toBeGreaterThan(-1);
    const runtimeBlock = dockerfile.slice(runtimeIdx);
    const escaped = RUNTIME_IMAGE_LABEL_FILTER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(new RegExp(`^LABEL\\s+${escaped}\\s*$`, 'm').test(runtimeBlock)).toBe(true);
  });

  it('build-runtime-image action parameterizes file + target, defaulting to the web runtime', () => {
    const action = readFileSync(
      join(repoRoot, '.github/actions/build-runtime-image/action.yml'),
      'utf8',
    );
    expect(action.match(/file:\s*\$\{\{\s*inputs\.dockerfile\s*\}\}/g) ?? []).toHaveLength(2);
    expect(action.match(/target:\s*\$\{\{\s*inputs\.target\s*\}\}/g) ?? []).toHaveLength(2);
    expect(compositeActionInput(action, 'dockerfile')).toMatch(
      /^ {4}default: \.\/apps\/web\/Dockerfile$/m,
    );
    expect(compositeActionInput(action, 'target')).toMatch(/^ {4}default: runner$/m);
  });

  it('docker-publish.yml publishes the web image through the shared action', () => {
    const publish = readFileSync(join(repoRoot, '.github/workflows/docker-publish.yml'), 'utf8');
    expect(/uses:\s*\.\/\.github\/actions\/build-runtime-image\b/.test(publish)).toBe(true);
    expect(publish.match(/^[ \t]*dockerfile: \.\/apps\/web\/Dockerfile$/gm) ?? []).toHaveLength(1);
    expect(publish.match(/^[ \t]*target: runner$/gm) ?? []).toHaveLength(1);
    expect(publish).toMatch(/EXPECT_ENTRY='apps\/web\/server\.js'/);
    expect(/dist\/server-entrypoint\.js/.test(publish)).toBe(false);
  });

  it('release imports its per-arch cache without exporting it, while CI keeps the export default', () => {
    const action = readFileSync(
      join(repoRoot, '.github/actions/build-runtime-image/action.yml'),
      'utf8',
    );
    const publish = readFileSync(join(repoRoot, '.github/workflows/docker-publish.yml'), 'utf8');
    const digest = action
      .split('    - name: Build and push by digest (native — no QEMU)')[1]
      ?.split('    - name: Surface digest')[0];
    expect(digest).toBeDefined();
    expect(compositeActionInput(action, 'export-cache')).toMatch(/^ {4}default: 'true'$/m);
    expect(digest).toMatch(/cache-from: type=gha,scope=\$\{\{ inputs\.cache-scope \}\}/);
    expect(digest).toMatch(
      /cache-to: >-\n\s+\$\{\{ inputs\.export-cache == 'true' &&\s+format\('type=gha,mode=max,scope=\{0\}', inputs\.cache-scope\) \|\| '' \}\}/,
    );
    expect(publish).toMatch(/^ {10}cache-scope: web-runtime-\$\{\{ matrix\.arch \}\}$/m);
    expect(publish).toMatch(/^ {10}export-cache: 'false'$/m);
    expect(publish).not.toMatch(/^ {10}cache-to:/m);
    expect(action).toMatch(
      /if: inputs\.mode == 'load'[\s\S]*?cache-to: type=gha,mode=max,scope=\$\{\{ inputs\.cache-scope \}\}/,
    );
  });

  it('release builds the checked-out tag by digest and gates promotion on both smokes', () => {
    const publish = readFileSync(join(repoRoot, '.github/workflows/docker-publish.yml'), 'utf8');
    const build = publish.split('  build:')[1]?.split('  merge:')[0];
    const merge = publish.split('  merge:')[1];
    expect(build).toMatch(/ref: \$\{\{ inputs\.tag \}\}/);
    expect(build).toMatch(/mode: digest/);
    expect(build).toMatch(/platform: \$\{\{ matrix\.platform \}\}/);
    expect(build).toMatch(/DIGEST: \$\{\{ steps\.build\.outputs\.digest \}\}/);
    expect(build).toMatch(/REF="\$IMAGE@\$DIGEST"[\s\S]*?docker pull "\$REF"/);
    expect(build).toMatch(
      /seed-dev[\s\S]*?tsx watch[\s\S]*?EXPECT_ENTRY='apps\/web\/server\.js'[\s\S]*?\[ "\$LABEL" != "runtime" \][\s\S]*?\[ "\$SIZE_MB" -gt "\$MAX_MB" \][\s\S]*?\[ "\$fail" -ne 0 \]/,
    );
    expect(merge).toMatch(/needs: build/);
    const refusal = merge
      ?.split('      - name: Refuse to overwrite an existing immutable tag')[1]
      ?.split('      - name: Extract Docker metadata (immutable tags)')[0];
    expect(refusal).toMatch(
      /if docker manifest inspect "\$IMAGE:\$VERSION" > \/dev\/null 2>&1; then[\s\S]*?exit 1/,
    );
    expect(merge).toMatch(/docker buildx imagetools create \$TAGARGS \$REFS/);
  });

  it('docker-publish.yml: post-publish smoke test references all three signals', () => {
    const yml = readFileSync(join(repoRoot, '.github/workflows/docker-publish.yml'), 'utf8');
    expect(/seed-dev/.test(yml)).toBe(true);
    expect(/tsx watch/.test(yml)).toBe(true);
    expect(/rembric\.stage/.test(yml)).toBe(true);
    expect(/MAX_MB|800/.test(yml)).toBe(true);
  });

  it('lib/process.ts calls assertDataLossGuard before the first timer', () => {
    const src = readFileSync(join(srcRoot, 'lib/process.ts'), 'utf8');
    const guardIdx = src.search(/\bassertDataLossGuard\s*\(/);
    const timerIdx = src.search(/\bset(?:Interval|Timeout)\s*\(/);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(timerIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(timerIdx);
  });
});

describe('distroless runtime node-path invariants', () => {
  const NODE = '/nodejs/bin/node';

  it('runtime stage is distroless AND its ENTRYPOINT + HEALTHCHECK use the absolute node path', () => {
    const dockerfile = prodDockerfile();
    const runtimeIdx = dockerfile.search(
      new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${PROD_STAGE}\\b`, 'm'),
    );
    expect(runtimeIdx).toBeGreaterThan(-1);
    const runtime = dockerfile.slice(runtimeIdx);
    expect(/^FROM\s+\S*distroless\S*/.test(runtime.split('\n')[0] ?? '')).toBe(true);

    const entry = runtime.match(/^ENTRYPOINT\s+(\[.*\])/m);
    expect(entry).not.toBeNull();
    expect(entry![1]).toContain(NODE);

    const health = runtime.match(/HEALTHCHECK[\s\S]*?CMD\s+(\[.*\])/);
    expect(health).not.toBeNull();
    expect(health![1]).toContain(NODE);

    expect(/\[\s*"node"\s*[,\]]/.test(runtime)).toBe(false);
  });

  it('docker-compose healthcheck uses the absolute node path (runs in the distroless image)', () => {
    const compose = readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8');
    expect(compose).toContain(NODE);
    expect(/^\s*-\s*node\s*$/m.test(compose)).toBe(false);
  });

  it('self-update upgrader entrypoint uses the absolute node path (runs in the NEW distroless image)', () => {
    const orch = readFileSync(join(coreRoot, 'services/self-update/orchestrator.ts'), 'utf8');
    expect(orch).toContain(`'${NODE}'`);
    expect(/\[\s*'node'\s*,/.test(orch)).toBe(false);
  });
});

describe('standalone listen-port invariants', () => {
  function runtimeStage(): string {
    const dockerfile = prodDockerfile();
    const runtimeIdx = dockerfile.search(
      new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${PROD_STAGE}\\b`, 'm'),
    );
    expect(runtimeIdx).toBeGreaterThan(-1);
    return dockerfile.slice(runtimeIdx);
  }

  function entrypoint(runtime: string): string {
    const match = runtime.match(/^ENTRYPOINT\s+(\[.*\])/m);
    expect(match).not.toBeNull();
    return match![1]!;
  }

  it('the entrypoint runs the port-deriving launcher at apps/web/server.js', () => {
    expect(entrypoint(runtimeStage())).toContain('/app/apps/web/server.js');
  });

  it('the launcher starts the renamed generated server, and the assembly does rename it', () => {
    const launcher = readFileSync(join(srcRoot, '..', 'server.js'), 'utf8');
    expect(launcher).toContain('next-server.js');
    expect(prodDockerfile()).toMatch(
      /mv\s+\/runtime\/apps\/web\/server\.js\s+\/runtime\/apps\/web\/next-server\.js/,
    );
  });

  it('the HEALTHCHECK probes the env-derived port through the launcher, never a hard-coded 8787', () => {
    const runtime = runtimeStage();
    const health = runtime.match(/HEALTHCHECK[\s\S]*?CMD\s+(\[.*\])/);
    expect(health).not.toBeNull();
    expect(health![1]).toContain('/app/apps/web/server.js');
    expect(health![1]).toContain('--healthcheck');
    expect(health![1]).not.toMatch(/127\.0\.0\.1:8787/);
  });
});

const SCOPE_BYPASS_PATTERN = /\.unsafeGetByIds?\b/;
const SCOPE_BYPASS_ALLOWED_PREFIXES = [
  'packages/db/src/repositories/memory-repository.ts',
  'packages/core/src/services/memory.ts',
  'packages/core/src/consolidation/',
  'apps/web/src/app/dashboard/',
  'packages/core/src/test-support/retrieval/ingest.ts',
];

describe('scope-leak invariant', () => {
  const files = scanRoots();

  it('memory.unsafeGetBy* may only be called from allow-listed modules', () => {
    const offenders: { file: string; line: number; text: string }[] = [];
    for (const file of files) {
      const rel = relToRepo(file);
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
        `memory.unsafeGetBy* called outside allow-list (packages/db/src/repositories/memory-repository.ts, ` +
          `packages/core/src/consolidation/, apps/web/src/app/dashboard/, packages/core/src/services/memory.ts). ` +
          `Use the scoped API instead, or add a justification + extend the allow-list.\n${formatted}`,
      );
    }
  });
});

const SQL_EXECUTION_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /from ['"]drizzle-orm['"]/, label: "import from 'drizzle-orm'" },
  { pattern: /\.raw\.prepare\(/, label: 'raw.prepare(' },
  { pattern: /\bdb\.(select|insert|update|delete)\(/, label: 'db.<builder>(' },
  { pattern: /\bdb\.(all|get|run)\(/, label: 'db.<all|get|run>(' },
  { pattern: /\bdb\.query\./, label: 'db.query.' },
];

describe('data-access confinement invariant', () => {
  const appFiles = listSourceFiles(srcRoot);
  const coreFiles = listSourceFiles(coreRoot);
  const dbFiles = listSourceFiles(dbRoot);
  const mcpFiles = listSourceFiles(mcpRoot);

  function scanSql(files: readonly string[]) {
    const hits: { file: string; line: number; label: string; text: string }[] = [];
    for (const file of files) {
      const rel = relToRepo(file);
      const lines = readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
          continue;
        }
        for (const { pattern, label } of SQL_EXECUTION_PATTERNS) {
          if (pattern.test(line)) hits.push({ file: rel, line: i + 1, label, text: trimmed });
        }
      }
    }
    return hits;
  }

  it('the db package is where the SQL actually is', () => {
    const hits = scanSql(dbFiles);
    expect(hits.length).toBeGreaterThan(50);
    expect(new Set(hits.map((h) => h.file)).size).toBeGreaterThan(5);
    expect(coreFiles.length).toBeGreaterThan(20);
    expect(mcpFiles.length).toBeGreaterThan(10);
  });

  it('SQL executes only under packages/db/src/', () => {
    const offenders = scanSql([...appFiles, ...coreFiles, ...mcpFiles]).filter(
      (o) => o.file !== 'apps/web/src/scripts/seed-dev.ts',
    );
    if (offenders.length > 0) {
      const formatted = offenders
        .map((o) => `  ${o.file}:${o.line}  [${o.label}]  ${o.text}`)
        .join('\n');
      throw new Error(
        `SQL execution found outside packages/db/src/. Move it into the repository layer or the package's diagnostics.ts.\n${formatted}`,
      );
    }
  });
});

const ADMIN_CALL_PATTERN = /\.(admin[A-Z]\w*)\(/g;

const ADMIN_CALL_SITES: Readonly<Record<string, readonly string[]>> = {
  'apps/web/src/lib/mcp-server.ts': [
    'adminBacklogCount',
    'adminCountByStatus',
    'adminCountEntities',
    'adminCountNeedsReview',
    'adminLatestRun',
  ],
  'packages/core/src/doctor.ts': [
    'adminBacklogCount',
    'adminCountByStatus',
    'adminCountEntities',
    'adminCountNeedsReview',
    'adminLatestRun',
  ],
  'packages/core/src/services/agent-sessions.ts': ['adminCountByStatus'],
  'packages/core/src/services/hybrid-search.ts': [
    'adminDocumentCount',
    'adminQueryTermFrequencies',
  ],
};

describe('admin-method confinement invariant', () => {
  const files = scanRoots();

  it('every admin* call site is allow-listed by file AND method name', () => {
    const offenders: { file: string; line: number; method: string; text: string }[] = [];
    for (const file of files) {
      const rel = relToRepo(file);
      if (
        rel.startsWith('apps/web/src/app/dashboard/') ||
        rel.startsWith('packages/db/src/repositories/')
      ) {
        continue;
      }
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
      const src = readFileSync(join(repoRoot, rel), 'utf8');
      for (const method of methods) {
        if (!new RegExp(`\\.${method}\\(`).test(src)) stale.push(`${rel}::${method}`);
      }
    }
    expect(stale).toEqual([]);
  });
});

const REPOSITORIES_DIR = join(dbRoot, 'repositories');

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
    symbol: 'SESSION_OPENING_NUDGE',
    definition: /\bconst\s+SESSION_OPENING_NUDGE\s*=/,
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
  const scanned = execSync(
    `git -C ${repoRoot} grep -l -E '.' -- ${PLUGIN_JS_PATHSPECS.map((p) => `'${p}'`).join(' ')} || true`,
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);

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

  it('the tool-observation latch is state no client holds, under any name', () => {
    const offenders: string[] = [];
    for (const rel of clients) {
      readFileSync(join(repoRoot, rel), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/\b(?:const|let|var)\s+\w*(?:[Tt]ool\w*[Uu]sed|[Uu]sed\w*[Tt]ool)\w*\b/.test(line)) {
            offenders.push(`${rel}:${i + 1}`);
          }
        });
    }
    expect(
      offenders,
      `use core.markToolUsed / core.beginTurn instead of a client-side latch: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('every per-session container the core declares is cleared by forgetSession', () => {
    const coreSrc = readFileSync(join(repoRoot, REMBRIC_PLUGIN_CORE_MJS), 'utf8');
    const containers = [
      ...coreSrc.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+(?:Map|Set)\(/g),
    ].map((m) => m[1]!);
    expect(
      containers.length,
      'no per-session containers parsed out of the core, so the assertion below would pass vacuously',
    ).toBeGreaterThan(5);

    const body = /function forgetSession\(sessionId\) \{([\s\S]*?)\n {2}\}/.exec(coreSrc)?.[1];
    expect(body, 'forgetSession not found in the core').toBeDefined();

    const leaked = containers.filter((name) => !body!.includes(`${name}.delete(sessionId)`));
    expect(
      leaked,
      `forgetSession must clear every per-session container or the client that calls it leaks: ${leaked.join(', ')}`,
    ).toEqual([]);
  });

  it('reportTurn takes only a session id, so no client can hand it per-turn state', () => {
    const coreSrc = readFileSync(join(repoRoot, REMBRIC_PLUGIN_CORE_MJS), 'utf8');
    const signature = /async function reportTurn\(([^)]*)\)/.exec(coreSrc);
    expect(signature, 'reportTurn not found in the core').not.toBeNull();
    expect(signature![1]!.split(',').filter((p) => p.trim().length > 0)).toHaveLength(1);

    const offenders: string[] = [];
    for (const rel of clients) {
      readFileSync(join(repoRoot, rel), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const call = /\breportTurn\(([^)]*)\)/.exec(line);
          if (call && call[1]!.includes(',')) offenders.push(`${rel}:${i + 1}`);
        });
    }
    expect(
      offenders,
      `reportTurn reads its own latch; passing it a second argument reintroduces client-held turn state: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});

const PI_PACKAGE_DIR = 'apps/plugin/.pi-plugin';

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

const LEGACY_INSTALL_URL_SUBSTRINGS = [
  'raw.githubusercontent.com/susomejias/rembric/main/plugin/',
  'github.com/susomejias/rembric/blob/main/plugin/',
];

const LEGACY_URL_ALLOW_LIST = new Set([
  'openspec/specs/open-source-distribution/spec.md',
  'openspec/specs/hermes-agent-plugin/spec.md',
  'apps/web/src/test/invariants.test.ts',
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
          `apps/web/src/test/invariants.test.ts.\n${formatted}`,
      );
    }
  });

  it('allow-list anchors: each allow-listed spec file actually contains a legacy URL reference', () => {
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

describe('migration runner FK-safety invariant', () => {
  const migrateSrc = readFileSync(join(dbRoot, 'migrate.ts'), 'utf8');

  it('migrate.ts disables foreign_keys around each migration transaction', () => {
    expect(/PRAGMA\s+foreign_keys\s*=\s*OFF/i.test(migrateSrc)).toBe(true);
    expect(/PRAGMA\s+foreign_keys\s*=\s*ON/i.test(migrateSrc)).toBe(true);
  });

  it('migrate.ts runs PRAGMA foreign_key_check before commit', () => {
    expect(/PRAGMA\s+foreign_key_check/i.test(migrateSrc)).toBe(true);
  });

  it('migrate.ts restores foreign_keys via a finally block', () => {
    const finallyBlock = migrateSrc.match(
      /finally\s*\{[\s\S]{0,200}?PRAGMA\s+foreign_keys\s*=\s*ON/i,
    );
    expect(finallyBlock, 'expected a finally block that re-enables foreign_keys').not.toBeNull();
  });
});

describe('oauth additive-migration invariant', () => {
  const oauthMigration = readFileSync(join(dbRoot, 'migrations/0013_oauth_tables.sql'), 'utf8');

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

describe('migration discovery equivalence invariant (DS2)', () => {
  const srcMigrations = join(dbRoot, 'migrations');
  const distMigrations = join(repoRoot, 'packages/db/dist/migrations');

  const sqlFiles = (dir: string): string[] =>
    readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

  const digests = (dir: string, files: readonly string[]): string[] =>
    files.map(
      (f) =>
        `${f} ${createHash('sha256')
          .update(readFileSync(join(dir, f)))
          .digest('hex')}`,
    );

  it('every migration filename is numbered, unique and contiguous from 0000', () => {
    const files = sqlFiles(srcMigrations);
    expect(files.length).toBeGreaterThan(30);
    for (const f of files) {
      expect(f, `${f} is not a numbered migration filename`).toMatch(/^[0-9]{4}_[a-z0-9_]+\.sql$/);
    }
    expect(new Set(files).size).toBe(files.length);
    expect(files.map((f) => f.slice(0, 4))).toEqual(
      files.map((_, i) => String(i).padStart(4, '0')),
    );
  });

  it('the runner resolves its migrations directory to the pinned source tree', () => {
    expect(defaultMigrationsDir()).toBe(srcMigrations);
    expect(sqlFiles(defaultMigrationsDir())).toEqual(sqlFiles(srcMigrations));
  });

  it('dist/migrations is byte-identical to src/migrations when the package is built', () => {
    if (!existsSync(distMigrations)) {
      console.warn(
        `[DS2] ${distMigrations} absent (package not built in this run) — src == dist NOT verified here`,
      );
      return;
    }
    const names = sqlFiles(distMigrations);
    expect(names).toEqual(sqlFiles(srcMigrations));
    expect(digests(distMigrations, names)).toEqual(digests(srcMigrations, names));
  });
});

describe('MCP tool-handler module layout invariant', () => {
  const mcpDir = mcpRoot;
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

describe('server-context single-instance invariant', () => {
  const CONTEXT_MODULES = ['request-context', 'session-router', 'tool-call-context'] as const;
  const barrelSpecifiers = CONTEXT_MODULES.map((m) => `./server-context/${m}.js`);

  it('each context module exists exactly once, under packages/core/src/server-context/', () => {
    const tracked = execSync(`git -C ${repoRoot} ls-files -- apps/ packages/`, {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
    for (const mod of CONTEXT_MODULES) {
      expect(
        tracked.filter((f) => f.endsWith(`/${mod}.ts`)),
        `${mod} must exist exactly once, in packages/core/src/server-context/`,
      ).toEqual([`packages/core/src/server-context/${mod}.ts`]);
    }
    expect(readdirSync(join(coreRoot, 'server-context')).sort()).toEqual(
      CONTEXT_MODULES.map((m) => `${m}.ts`).sort(),
    );
  });

  it('the only path import of them anywhere is the core barrel', () => {
    const hits = execSync(
      `git -C ${repoRoot} grep -n -E "from '[^']*/(request-context|session-router|tool-call-context)\\.js'" -- apps/ packages/ || true`,
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);

    const specifiers = new Set(hits.map((hit) => /from '([^']+)'/.exec(hit)?.[1] ?? '<unparsed>'));
    expect([...specifiers].sort()).toEqual([...barrelSpecifiers].sort());
    expect(hits.length).toBe(CONTEXT_MODULES.length);
  });

  it('every application-side consumer imports them from @rembric/core', () => {
    const consumers = [
      { file: 'apps/web/src/app/mcp/[[...path]]/route.ts', symbol: 'runWithContext' },
      { file: 'apps/web/src/lib/mcp-server.ts', symbol: 'SessionRouter' },
      { file: 'apps/web/src/lib/api.ts', symbol: 'RequestContext' },
      { file: 'apps/web/src/lib/auth.ts', symbol: 'RequestContext' },
      { file: 'apps/web/src/lib/mcp-auth.ts', symbol: 'RequestContext' },
      { file: 'packages/mcp/src/_shared.ts', symbol: 'getRequestContext' },
      { file: 'packages/mcp/src/server.ts', symbol: 'runWithToolCallId' },
    ];
    const offenders = consumers.filter(({ file, symbol }) => {
      const src = readFileSync(join(repoRoot, file), 'utf8');
      return !new RegExp(`import[^;]*\\b${symbol}\\b[^;]*from '@rembric/core'`).test(src);
    });
    expect(offenders, offenders.map((o) => `${o.file} must import ${o.symbol}`).join('\n')).toEqual(
      [],
    );
  });

  it('the application and @rembric/mcp read one AsyncLocalStorage instance', async () => {
    const core = await import('@rembric/core');
    const mcp = await import('@rembric/mcp');
    const ctx: RequestContext = {
      token: {
        id: 'tk_context_guard',
        name: 'context-guard',
        hash: 'hash',
        scope: '*',
        projectId: null,
        createdAt: new Date(0),
        expiresAt: null,
        revokedAt: null,
      },
      scope: '*',
      memberProjectIds: [],
      project: null,
      requestedSlug: null,
      mcpSessionId: null,
    };

    expect(() => mcp.isPathScoped()).toThrow(/request context missing/);

    await expect(core.runWithContext(ctx, () => Promise.resolve(mcp.isPathScoped()))).resolves.toBe(
      false,
    );
    await expect(
      core.runWithContext({ ...ctx, requestedSlug: 'context-guard' }, () =>
        Promise.resolve(mcp.routerKey()),
      ),
    ).resolves.toBeNull();
  });
});

describe('roots-discovery state ownership invariant', () => {
  const src = readFileSync(join(mcpRoot, 'roots-discovery.ts'), 'utf8');

  it('declares no module-level mutable registry of per-transport state', () => {
    const registries = src.match(/^(?:const|let|var)\s+\w+[^=\n]*=\s*new\s+(?:Set|Map|Array)\b/gm);
    expect(registries, 'per-transport state must hang off the connection, not the module').toBe(
      null,
    );
  });

  it('owns that state through a WeakMap keyed by the connection server', () => {
    expect(/^const\s+\w+\s*=\s*new\s+WeakMap<McpServer,/m.test(src)).toBe(true);
  });

  it('clears no collection, so no helper can reset every transport at once', () => {
    expect(src).not.toMatch(/\.clear\(\)/);
  });
});

describe('summary truncation keeps the same side in every layer', () => {
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
  ];

  it('the server keeps the tail and marks the front', () => {
    const src = readFileSync(join(coreRoot, 'services', 'agent-sessions.ts'), 'utf8');
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
    const src = readFileSync(join(coreRoot, 'services', 'agent-sessions.ts'), 'utf8');
    const body = src.slice(src.indexOf('export function truncateTitle'));
    expect(body.slice(0, body.indexOf('\n}'))).toContain('sliceWithoutSplittingSurrogatePair');
  });
});

describe('the session-summary rubric has one source', () => {
  const surfaces = [
    'packages/mcp/src/instructions.ts',
    'packages/mcp/src/server.ts',
    'packages/core/src/services/session-nudge.ts',
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

  it('the enumeration above is complete', () => {
    const candidates = execSync(
      `git -C ${repoRoot} ls-files -- apps/ packages/ ':!*.test.*' ':!*/tests/*' ':!apps/plugin/test/**' ':!apps/plugin/bin/rembric-bridge.mjs'`,
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

describe('the post-compaction protocol text has one source', () => {
  const surfaces = [
    'apps/plugin/scripts/post-compact.sh',
    REMBRIC_PLUGIN_CORE_MJS,
    OPENCODE_PLUGIN_TS,
    'apps/plugin/.hermes-plugin/__init__.py',
  ];

  it('the enumeration above is complete', () => {
    const found = execSync(
      `git -C ${repoRoot} grep -l -e 'Resumed from a compaction' -e 'POST_COMPACT_NUDGE_CORE' -- apps/ packages/ ':!*.test.*' ':!*/tests/*' ':!*.d.mts' ':!apps/plugin/test/nudge-fixtures.json' || true`,
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
      const src = readFileSync(join(coreRoot, entry.rebuild.module), 'utf8');
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
    const sources = markerModules.map((m) => readFileSync(join(coreRoot, m), 'utf8')).join('\n');
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
    const rel = relToRepo(file);
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
  const files = [
    ...listAllTsFiles(srcRoot),
    ...listAllTsFiles(coreRoot),
    ...listAllTsFiles(dbRoot),
    ...listAllTsFiles(mcpRoot),
  ];

  it('the scan reaches source files and reads their non-comment lines', () => {
    expect(files.length).toBeGreaterThan(100);
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

const WIDENED_SCOPE_DISCRIMINANT = /'authorized-projects'/;
const WIDENED_SCOPE_SITES: Record<string, number> = {
  'packages/db/src/scope.ts': 1,
  'packages/mcp/src/_shared.ts': 1,
  'packages/core/src/test-support/retrieval/retrievers/hybrid.ts': 1,
};

describe('the widened scope has one construction site', () => {
  const production = [
    ...listAllTsFiles(srcRoot),
    ...listAllTsFiles(coreRoot),
    ...listAllTsFiles(dbRoot),
    ...listAllTsFiles(mcpRoot),
  ].filter(
    (f) =>
      !f.endsWith('.test.ts') &&
      !relToRepo(f).startsWith('apps/web/src/test/') &&
      !relToRepo(f).startsWith('packages/db/src/migrations/'),
  );

  it('the scan reaches the production tree', () => {
    expect(production.length).toBeGreaterThan(100);
    const control = scanForPattern(production, /\bprojectScope\(/);
    expect(new Set(control.map((m) => m.file)).size).toBeGreaterThan(5);
  });

  it('names the discriminant in exactly the declaring module and the one builder', () => {
    const matches = scanForPattern(production, WIDENED_SCOPE_DISCRIMINANT);

    expect(matches.length).toBeGreaterThan(0);

    const byFile: Record<string, number> = {};
    for (const m of matches) byFile[m.file] = (byFile[m.file] ?? 0) + 1;
    expect(byFile, matches.map((m) => `  ${m.file}:${m.line}  ${m.text}`).join('\n')).toEqual(
      WIDENED_SCOPE_SITES,
    );
  });
});
