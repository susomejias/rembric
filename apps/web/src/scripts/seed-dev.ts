import { AgentSessionsService } from '@rembric/core';
import { deriveTitle, MemoryService } from '@rembric/core';
import { ProjectsService } from '@rembric/core';
import { RelationsService } from '@rembric/core';
import { TokensService } from '@rembric/core';
import { createDb, createRepositories, projectScope, type DbHandle } from '@rembric/db';
import { ulid } from 'ulid';

const DEMO_SLUG = 'demo';

export interface SeedDeps {
  handle: DbHandle;
  reset: boolean;
  adminTokenPlaintext?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export interface SeedResult {
  skipped: boolean;
  refused?: boolean;
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
  const env = deps.env ?? process.env;

  if (deps.reset && env['REMBRIC_ALLOW_DESTRUCTIVE_SEED'] !== '1') {
    log('[seed-dev] --reset requires REMBRIC_ALLOW_DESTRUCTIVE_SEED=1; refusing to wipe');
    return { skipped: true, refused: true };
  }

  const projectsSvc = new ProjectsService(createRepositories(deps.handle.db));

  const existing = projectsSvc.findBySlug(DEMO_SLUG);
  if (existing && !deps.reset) {
    log('[seed-dev] data already present; pass --reset to wipe and reseed');
    return { skipped: true };
  }
  if (deps.reset) {
    log('[seed-dev] --reset: wiping protected tables before reseeding');
    wipe(deps.handle);
  }

  const tokensSvc = new TokensService(createRepositories(deps.handle.db), deps.handle.db);
  const memorySvc = new MemoryService(createRepositories(deps.handle.db), deps.handle.db);
  const relationsSvc = new RelationsService(createRepositories(deps.handle.db), deps.handle.db);
  const sessionsSvc = new AgentSessionsService(createRepositories(deps.handle.db), deps.handle.db);

  const proj = projectsSvc.create({ slug: DEMO_SLUG, displayName: 'Demo Project' });

  const showcase: Array<{ slug: string; displayName: string }> = [
    { slug: 'api-gateway', displayName: 'API Gateway' },
    { slug: 'mobile-app', displayName: 'Mobile App' },
    { slug: 'data-pipeline', displayName: 'Data Pipeline' },
    { slug: 'infra', displayName: 'Infra & Terraform' },
    { slug: 'ml-experiments', displayName: 'ML Experiments' },
    { slug: 'design-system', displayName: 'Design System' },
    { slug: 'marketing-site', displayName: 'Marketing Site' },
    { slug: 'internal-tools', displayName: 'Internal Tools' },
    { slug: 'auth-service', displayName: 'Auth Service' },
    { slug: 'billing', displayName: 'Billing' },
    { slug: 'analytics', displayName: 'Analytics Dashboard' },
    { slug: 'e2e-testing', displayName: 'E2E Testing' },
    { slug: 'docs-site', displayName: 'Docs Site' },
    { slug: 'browser-extension', displayName: 'Browser Extension' },
    { slug: 'partner-integrations', displayName: 'Partner Integrations' },
    { slug: 'legacy-migration', displayName: 'Legacy Monolith Migration to Services' },
    { slug: 'sre-runbooks', displayName: 'SRE Runbooks' },
    { slug: 'support-kb', displayName: 'Customer Support KB' },
  ];
  for (const p of showcase) projectsSvc.create(p);

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

  const readerTok = tokensSvc.create({ name: 'demo-reader', project: proj, access: 'read' });
  const writerTok = tokensSvc.create({ name: 'demo-writer', project: proj, access: 'write' });

  const DAY = 24 * 60 * 60 * 1000;
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
      const ageDays = ((memoryCount * 11) % 29) + (memoryCount % 3) * 2;
      const clock = ageDays === 0 ? undefined : () => new Date(Date.now() - ageDays * DAY);
      const saver =
        clock === undefined
          ? memorySvc
          : new MemoryService(createRepositories(deps.handle.db), deps.handle.db, clock);
      saver.save(
        {
          type: cluster.type,
          title: deriveTitle(content),
          content,
          tags: [cluster.topicKey],
          topicKey: cluster.topicKey,
        },
        scope,
      );
      memoryCount += 1;
    }
  }

  const staleSeeds: Array<{
    type: 'project' | 'feedback' | 'user' | 'reference';
    content: string;
    ageDays: number;
  }> = [
    {
      type: 'project',
      content: 'Goal: ship the review-state dashboard surface this sprint.',
      ageDays: 120,
    },
    {
      type: 'feedback',
      content: 'Prefer terse PRs; lead with the why, then the diff.',
      ageDays: 220,
    },
    {
      type: 'user',
      content: 'Operator is a backend engineer; comfortable with SQLite internals.',
      ageDays: 400,
    },
    {
      type: 'reference',
      content: 'Runbook: dashboards live behind Tailscale (no TTL — should stay fresh).',
      ageDays: 400,
    },
  ];
  for (const s of staleSeeds) {
    const past = new Date(Date.now() - s.ageDays * DAY);
    const backdated = new MemoryService(
      createRepositories(deps.handle.db),
      deps.handle.db,
      () => past,
    );
    backdated.save({ type: s.type, title: deriveTitle(s.content), content: s.content }, scope);
    memoryCount += 1;
  }

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
        'Goal: investigate why the consolidation runs view rendered an empty week.\nDiscoveries: the lazy sweep only fires on session start, throttled to one run per scope per day — no agent had opened a session against this project all week.\nFix: forced a run with the dashboard "Run sweep now" button and confirmed the journal populated.\nNext: monitor that regular agent sessions keep the sweep cadence.',
      title: 'Diagnose missing consolidation runs',
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

  memorySvc.save(
    {
      type: 'feedback',
      title: 'Log WAL state first when debugging flaky tests',
      content: 'When debugging a flaky test, always log the WAL state first.',
      tags: ['debug-tips'],
      topicKey: 'debug-tips',
    },
    scope,
  );
  const m2 = memorySvc.save(
    {
      type: 'feedback',
      title: 'Read the SQLite WAL first when debugging flaky tests',
      content: 'Debugging flaky tests starts with reading the SQLite WAL — most ghosts hide there.',
      tags: ['debug-tips'],
      topicKey: 'debug-tips',
    },
    scope,
  );
  const m3 = memorySvc.save(
    {
      type: 'feedback',
      title: 'Dump journal_mode + busy_timeout pragmas for flaky tests',
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

  const judgedPairs: Array<{
    relation: 'supersedes' | 'conflicts_with' | 'related' | 'compatible';
    topicKey: string;
    source: string;
    target: string;
  }> = [
    {
      relation: 'supersedes',
      topicKey: 'demo-judged-supersedes',
      source:
        'Pin pnpm to v11.1.2 in package.json::packageManager — newer versions need Node 22.13.',
      target: 'Pin pnpm to v9 in package.json::packageManager for max compatibility.',
    },
    {
      relation: 'conflicts_with',
      topicKey: 'demo-judged-conflicts',
      source: 'Rely on the lazy session-start sweep only; never force manual consolidation runs.',
      target: 'Force a manual sweep after every bulk import so decay stays current.',
    },
    {
      relation: 'related',
      topicKey: 'demo-judged-related',
      source: 'data-confirm attributes live on the <form> element, not the <button>.',
      target: 'Destructive forms always use data-confirm-tone=danger for irreversible ops.',
    },
    {
      relation: 'compatible',
      topicKey: 'demo-judged-compatible',
      source: 'Use formatTs helper for absolute timestamps in dashboard tables.',
      target: 'Use relTime helper for "X AGO" relative time in dashboard overview tiles.',
    },
  ];
  for (const pair of judgedPairs) {
    const src = memorySvc.save(
      {
        type: 'reference',
        title: deriveTitle(pair.source),
        content: pair.source,
        tags: [pair.topicKey],
        topicKey: `${pair.topicKey}-src`,
      },
      scope,
    );
    const tgt = memorySvc.save(
      {
        type: 'reference',
        title: deriveTitle(pair.target),
        content: pair.target,
        tags: [pair.topicKey],
        topicKey: `${pair.topicKey}-tgt`,
      },
      scope,
    );
    relationsSvc.compare({
      sourceId: src.id,
      targetId: tgt.id,
      relation: pair.relation,
      actor: 'seed-dev',
      kind: 'agent',
      confidence: 0.85,
      reason: `seed-dev demo: ${pair.relation}`,
    });
    memoryCount += 2;
  }

  const result: SeedResult = {
    skipped: false,
    counts: {
      projects: projectsSvc.list().length,
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
  handle.raw.transaction(() => {
    handle.raw.exec('PRAGMA defer_foreign_keys = ON');
    handle.raw.exec('DELETE FROM memory_relations');
    handle.raw.exec('DELETE FROM confirmations');
    handle.raw.exec('DELETE FROM consolidation_ops');
    handle.raw.exec('DELETE FROM consolidation_runs');
    handle.raw.exec('DELETE FROM prompts');
    handle.raw.exec('DELETE FROM memory_vec');
    handle.raw.exec('DELETE FROM memory_entity_links');
    handle.raw.exec('DELETE FROM memory_entity_scan');
    handle.raw.exec('DELETE FROM memory_entities');
    handle.raw.exec('DELETE FROM memory');
    handle.raw.exec('DELETE FROM sessions');
    handle.raw.exec('DELETE FROM dashboard_sessions');
    handle.raw.exec('DELETE FROM token_projects');
    handle.raw.exec('DELETE FROM tokens');
    handle.raw.exec('DELETE FROM projects');
    handle.raw
      .prepare(
        "INSERT INTO projects (id, slug, display_name, is_default, created_at) VALUES (?, 'default', 'Default', 1, ?)",
      )
      .run(ulid(), Date.now());
  })();
}

function main(): void {
  const reset = process.argv.includes('--reset');
  const dataDir = process.env.REMBRIC_DATA_DIR ?? '/data';
  const adminTokenPlaintext = process.env.REMBRIC_ADMIN_TOKEN;
  const handle = createDb({ dataDir });
  try {
    const result = runSeed({ handle, reset, adminTokenPlaintext });
    if (result.refused) {
      process.exit(1);
    }
  } finally {
    handle.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
