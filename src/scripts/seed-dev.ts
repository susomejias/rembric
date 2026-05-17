/**
 * Dev seed — populates a fresh dev DB with ~30-50 thematic rows so every
 * dashboard surface renders with meaningful data on first boot.
 *
 * Usage:
 *   tsx src/scripts/seed-dev.ts          # idempotent: skip if `demo` project exists
 *   tsx src/scripts/seed-dev.ts --reset  # wipe and reseed
 *
 * Inside the dev container the wrapper is:
 *   pnpm run dev:docker:seed
 *
 * This script is gated by an entry in `src/test/invariants.test.ts`'s
 * `DELETE FROM` allow-list — it is the ONLY script outside the service
 * layer permitted to emit DELETEs against the protected tables.
 */

import { type DbHandle, createDb } from '../db/index.js';
import { AgentSessionsService } from '../services/agent-sessions.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { RelationsService } from '../services/relations.js';
import { projectScope } from '../services/scope.js';
import { TokensService } from '../services/tokens.js';

const DEMO_SLUG = 'demo';

export interface SeedDeps {
  handle: DbHandle;
  reset: boolean;
  /**
   * Plaintext to use for the admin token. When the dev container's boot
   * chain invokes the seed, it passes `process.env.REMBRIC_ADMIN_TOKEN`
   * here so the operator's existing `.env` token stays valid across
   * `--reset` reboots (dashboard login + container HEALTHCHECK both rely
   * on it). When undefined (e.g. unit tests), the seed generates a
   * random plaintext and prints it like the other project-scoped tokens.
   */
  adminTokenPlaintext?: string;
  /** Output sink for the operator-facing summary. Defaults to console.error. */
  log?: (line: string) => void;
}

export interface SeedResult {
  skipped: boolean;
  counts?: {
    projects: number;
    tokens: number;
    memories: number;
    endedSessions: number;
    activeSessions: number;
    pendingJudgments: number;
  };
  adminTokenPlaintext?: string;
  readerTokenPlaintext?: string;
  writerTokenPlaintext?: string;
}

export function runSeed(deps: SeedDeps): SeedResult {
  const log = deps.log ?? ((l) => console.error(l));
  const projectsSvc = new ProjectsService(deps.handle.db);

  const existing = projectsSvc.findBySlug(DEMO_SLUG);
  if (existing && !deps.reset) {
    log('[seed-dev] data already present; pass --reset to wipe and reseed');
    return { skipped: true };
  }
  if (deps.reset) {
    log('[seed-dev] --reset: wiping protected tables before reseeding');
    wipe(deps.handle);
  }

  const tokensSvc = new TokensService(deps.handle.db);
  const memorySvc = new MemoryService(deps.handle.db);
  const relationsSvc = new RelationsService(deps.handle.db);
  const sessionsSvc = new AgentSessionsService(deps.handle.db);

  // 1. Project.
  const proj = projectsSvc.create({ slug: DEMO_SLUG, displayName: 'Demo Project' });

  // 2. Admin token. When the dev container's boot chain passes
  // adminTokenPlaintext (from `REMBRIC_ADMIN_TOKEN` in .env), insert the
  // admin row with that exact plaintext via bootstrapAdmin — so the
  // operator's existing .env login keeps working across resets. When
  // undefined, fall back to generating a random plaintext (test mode).
  const envAdmin = deps.adminTokenPlaintext;
  const useEnvAdmin = typeof envAdmin === 'string' && envAdmin.length >= 16;
  let adminTokenId: string;
  let adminTokenPlaintext: string;
  if (useEnvAdmin) {
    tokensSvc.bootstrapAdmin(envAdmin);
    const adminRow = tokensSvc.findByName('admin');
    if (!adminRow) {
      throw new Error('[seed-dev] bootstrapAdmin did not insert an admin row');
    }
    adminTokenId = adminRow.id;
    adminTokenPlaintext = envAdmin;
  } else {
    const adminTok = tokensSvc.create({ name: 'admin-dev', scope: '*' });
    adminTokenId = adminTok.token.id;
    adminTokenPlaintext = adminTok.plaintext;
  }

  // 2b. Two project-scoped tokens. Plaintext printed every boot — these
  // are dev-only ephemeral tokens regenerated on every `--reset`.
  const readerTok = tokensSvc.create({
    name: 'demo-reader',
    scope: `read:project:${proj.id}`,
    projectId: proj.id,
  });
  const writerTok = tokensSvc.create({
    name: 'demo-writer',
    scope: `project:${proj.id}`,
    projectId: proj.id,
  });

  // 3. Memories — 5 topic_key clusters × 4 memories each = 20 rows.
  const scope = projectScope(proj.id);
  const clusters: Array<{
    topicKey: string;
    type: 'project' | 'feedback' | 'reference' | 'user';
    items: string[];
  }> = [
    {
      topicKey: 'design-system',
      type: 'reference',
      items: [
        'Design tokens: lime (#c6f24e) is the only accent. Brutalist defaults.',
        'Spacing scale: --s-1..--s-8 powers-of-two.',
        'Font stack: Space Grotesk display / Inter body / JetBrains Mono code.',
        'Sidebar collapse state is server-driven via rbr-sb-collapsed cookie.',
      ],
    },
    {
      topicKey: 'auth-rotation',
      type: 'project',
      items: [
        'Rotate the admin bearer every 90 days; document in runbook.',
        'PATs for GHCR pulls are per-host; rotate when team changes.',
        'Hermes provider reads token from ~/.hermes/.env on every startup.',
        'Plugin 0.6.0+ sends bearer header on /healthz probe.',
      ],
    },
    {
      topicKey: 'bug-fix-2026-Q1',
      type: 'project',
      items: [
        'Fixed countByStatus filtering deleted_at (PR #36).',
        'data-confirm attributes must live on <form>, not <button>.',
        'WAL + busy_timeout=5000 resolved sporadic locked errors under load.',
        'Embedding worker batch size 16 to avoid OOM on small Ollama hosts.',
      ],
    },
    {
      topicKey: 'meeting-decisions',
      type: 'project',
      items: [
        'Decided: Docker becomes canonical install path (archive Apr-17).',
        'Decided: keep dual-publish npm + Docker until v1.0.',
        '/healthz must be bearer-gated to match the rest of the auth posture.',
        'No Watchtower for now — manual click after release.',
      ],
    },
    {
      topicKey: 'runbook-onboarding',
      type: 'reference',
      items: [
        'New machine: install Claude Code plugin then /rembric:context to verify.',
        'Generate REMBRIC_ADMIN_TOKEN with openssl rand -hex 32.',
        'For LXC deploys, expose 8787 over Tailscale, not raw LAN.',
        'Smoke check: curl -I -H Authorization: Bearer ... /healthz should be 200.',
      ],
    },
  ];

  let memoryCount = 0;
  for (const cluster of clusters) {
    for (const content of cluster.items) {
      memorySvc.save(
        {
          type: cluster.type,
          content,
          tags: [cluster.topicKey],
          topicKey: cluster.topicKey,
        },
        scope,
      );
      memoryCount += 1;
    }
  }

  // 4. Ended sessions with realistic summaries.
  const endedSessions = [
    {
      agent: 'claude-code',
      cwd: '/Users/dev/demo',
      summary:
        'Goal: bootstrap the demo project with three tokens and run a smoke test against /dashboard.\nDiscoveries: token plaintext only shown once; admin scope required for the maintenance page.\nAccomplished: dashboard login, project creation, three tokens minted.\nNext: invite a project-scoped agent and verify memory.save scopes correctly.',
      title: 'Bootstrap demo project + token smoke test',
    },
    {
      agent: 'codex-cli',
      cwd: '/Users/dev/demo',
      summary:
        'Goal: investigate why the consolidation runs view rendered an empty week.\nDiscoveries: CONSOLIDATION_CRON=0 3 * * * had never fired because the daemon was restarted at 02:55 each night.\nFix: switched to "30 3 * * *" so the daemon is always warm when the cron tick lands.\nNext: monitor for a week to confirm.',
      title: 'Diagnose consolidation cron miss',
    },
    {
      agent: 'hermes',
      cwd: '/srv/hermes',
      summary:
        'Goal: verify Hermes provider lifecycle calls land on the API.\nAccomplished: ran an interactive session, observed /api/demo/sessions POST on initialize, /summary POST on pre-compress, /end POST on session-end.\nNext: enable provider in the always-on profile so every Hermes session is tracked.',
      title: 'Hermes lifecycle smoke',
    },
  ];

  for (const cfg of endedSessions) {
    const s = sessionsSvc.start({
      tokenId: adminTokenId,
      projectId: proj.id,
      agent: cfg.agent,
      description: null,
      cwd: cfg.cwd,
    });
    sessionsSvc.end(s.id, {
      tokenId: adminTokenId,
      summary: cfg.summary,
      title: cfg.title,
      final: true,
    });
  }

  // 5. Active sessions.
  sessionsSvc.start({
    tokenId: writerTok.token.id,
    projectId: proj.id,
    agent: 'claude-code',
    description: null,
    cwd: '/Users/dev/demo',
  });
  sessionsSvc.start({
    tokenId: writerTok.token.id,
    projectId: proj.id,
    agent: 'codex-cli',
    description: null,
    cwd: '/Users/dev/demo',
  });

  // 6. Pending judgment — create two related memories in the SAME topic_key
  // cluster and register a pending conflict between them via the relations
  // service. The dashboard's /dashboard/judgments shows the pending row.
  memorySvc.save(
    {
      type: 'feedback',
      content: 'When debugging a flaky test, always log the WAL state first.',
      tags: ['debug-tips'],
      topicKey: 'debug-tips',
    },
    scope,
  );
  const m2 = memorySvc.save(
    {
      type: 'feedback',
      content: 'Debugging flaky tests starts with reading the SQLite WAL — most ghosts hide there.',
      tags: ['debug-tips'],
      topicKey: 'debug-tips',
    },
    scope,
  );
  // m2 already supersedes m1 by topic_key. Add a separate pending row to
  // exercise the judgment surface explicitly.
  const m3 = memorySvc.save(
    {
      type: 'feedback',
      content: 'For flaky tests, dump the journal_mode + busy_timeout pragmas first.',
      tags: ['debug-tips'],
      topicKey: 'debug-tips-variant',
    },
    scope,
  );
  relationsSvc.createPending({
    sourceId: m3.id,
    targetId: m2.id,
    markedByKind: 'system',
  });
  memoryCount += 3;

  const result: SeedResult = {
    skipped: false,
    counts: {
      projects: 1,
      tokens: 3,
      memories: memoryCount,
      endedSessions: endedSessions.length,
      activeSessions: 2,
      pendingJudgments: 1,
    },
    adminTokenPlaintext,
    readerTokenPlaintext: readerTok.plaintext,
    writerTokenPlaintext: writerTok.plaintext,
  };

  log('');
  log('[seed-dev] done. Summary:');
  log(`  projects:          ${result.counts!.projects}`);
  log(`  tokens:            ${result.counts!.tokens}`);
  log(`  memories:          ${result.counts!.memories}`);
  log(`  ended sessions:    ${result.counts!.endedSessions}`);
  log(`  active sessions:   ${result.counts!.activeSessions}`);
  log(`  pending judgments: ${result.counts!.pendingJudgments}`);
  log('');
  if (useEnvAdmin) {
    log('[seed-dev] admin token: matches your REMBRIC_ADMIN_TOKEN in .env');
    log('[seed-dev]              (login with the .env value; not re-printed here)');
  } else {
    log('[seed-dev] admin-dev plaintext (shown exactly once — copy now):');
    log(`  admin-dev:    ${adminTokenPlaintext}`);
  }
  log('[seed-dev] project-scoped tokens (plaintext — regenerated every reset):');
  log(`  demo-reader:  ${readerTok.plaintext}`);
  log(`  demo-writer:  ${writerTok.plaintext}`);
  log('');
  log('[seed-dev] open the dashboard:  http://127.0.0.1:8788/dashboard');
  if (useEnvAdmin) {
    log('[seed-dev] log in with your REMBRIC_ADMIN_TOKEN from .env');
  } else {
    log('[seed-dev] log in with the `admin-dev` token above.');
  }
  log('');

  return result;
}

function wipe(handle: DbHandle): void {
  // Raw SQL — Drizzle's `db.delete(table)` is forbidden by the invariant
  // grep for memory/sessions/memory_relations even in this allow-listed
  // file, so we mirror the pattern used by services/memory.ts and
  // services/agent-sessions.ts: raw `DELETE FROM` inside a transaction.
  //
  // `PRAGMA defer_foreign_keys = ON` defers FK checks until the transaction
  // commits. Without it, SQLite checks FKs after each DELETE in
  // dependency order — which fails because some children reference rows
  // we haven't reached yet (e.g. memory_relations → memory is fine, but
  // depending on schema details, some checks fire mid-transaction).
  // Defer + dependency-ordered deletes + atomic commit = clean wipe.
  // memory_vec / memory_fts have AFTER DELETE triggers on memory and
  // clean up automatically.
  handle.raw.transaction(() => {
    handle.raw.exec('PRAGMA defer_foreign_keys = ON');
    handle.raw.exec('DELETE FROM memory_relations');
    handle.raw.exec('DELETE FROM confirmations');
    handle.raw.exec('DELETE FROM consolidation_ops');
    handle.raw.exec('DELETE FROM consolidation_runs');
    handle.raw.exec('DELETE FROM prompts');
    handle.raw.exec('DELETE FROM memory');
    handle.raw.exec('DELETE FROM sessions'); // agent_sessions table is named `sessions`
    handle.raw.exec('DELETE FROM dashboard_sessions'); // dashboard login cookies → tokens
    handle.raw.exec('DELETE FROM tokens');
    handle.raw.exec('DELETE FROM projects');
  })();
}

function main(): void {
  const reset = process.argv.includes('--reset');
  const dataDir = process.env.REMBRIC_DATA_DIR ?? '/data';
  const adminTokenPlaintext = process.env.REMBRIC_ADMIN_TOKEN;
  const handle = createDb({ dataDir });
  try {
    runSeed({ handle, reset, adminTokenPlaintext });
  } finally {
    handle.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
