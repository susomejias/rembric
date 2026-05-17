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

  it('allow-list anchors: scripts/seed-dev.ts contains DELETE FROM memory / sessions / memory_relations', () => {
    const file = join(srcRoot, 'scripts/seed-dev.ts');
    const src = readFileSync(file, 'utf8');
    expect(/DELETE\s+FROM\s+memory\b/i.test(src)).toBe(true);
    expect(/DELETE\s+FROM\s+sessions\b/i.test(src)).toBe(true);
    expect(/DELETE\s+FROM\s+memory_relations\b/i.test(src)).toBe(true);
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
