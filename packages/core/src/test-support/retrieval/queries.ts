import { type PROJECTS } from './corpus.js';
import type { QueryItem, QueryScopeFixture } from './types.js';

function project(slug: (typeof PROJECTS)[number]['slug']): QueryScopeFixture {
  return { project: slug };
}

export const QUERIES: QueryItem[] = [
  {
    id: 'q-atlas-orm',
    text: 'what ORM does atlas use for its database layer',
    type: 'extraction',
    goldStableIds: ['atlas-orm-choice'],
    scope: project('atlas'),
  },
  {
    id: 'q-nimbus-scheduler-port',
    text: 'what port does the nimbus job scheduler listen on',
    type: 'extraction',
    goldStableIds: ['nimbus-scheduler-port'],
    scope: project('nimbus'),
  },
  {
    id: 'q-nimbus-pg-pin',
    text: 'why is the postgres client version pinned in nimbus',
    type: 'extraction',
    goldStableIds: ['nimbus-pg-pin'],
    scope: project('nimbus'),
  },

  {
    id: 'q-atlas-auth-provider',
    text: 'what authentication provider does atlas use now',
    type: 'knowledge-update',
    goldStableIds: ['atlas-auth-v2'],
    scope: project('atlas'),
  },
  {
    id: 'q-nimbus-retry-strategy',
    text: "what's the current retry strategy for failed nimbus jobs",
    type: 'knowledge-update',
    goldStableIds: ['nimbus-retry-v2'],
    scope: project('nimbus'),
  },

  {
    id: 'q-atlas-rate-limit-latest',
    text: 'what is the latest decision about rate limiting in atlas',
    type: 'temporal',
    goldStableIds: ['atlas-rate-limit-new'],
    scope: project('atlas'),
  },
  {
    id: 'q-nimbus-deploy-pipeline-latest',
    text: "what's the most recent change to nimbus's deployment pipeline",
    type: 'temporal',
    goldStableIds: ['nimbus-deploy-pipeline-new'],
    scope: project('nimbus'),
  },

  {
    id: 'q-pref-pr-review',
    text: 'how does the user like PRs reviewed',
    type: 'preference',
    goldStableIds: ['pref-pr-review-depth'],
    scope: project('shared'),
  },
  {
    id: 'q-pref-nimbus-docstrings',
    text: "what's the user's preference on docstrings in nimbus's python code",
    type: 'preference',
    goldStableIds: ['pref-nimbus-docstrings'],
    scope: project('nimbus'),
  },

  {
    id: 'q-atlas-cache-fix-reason',
    text: 'why did we fix stale cache entries in atlas and what caused them',
    type: 'multi-session-causal',
    goldStableIds: ['atlas-cache-decision', 'atlas-cache-bug-fix'],
    scope: project('atlas'),
  },
  {
    id: 'q-nimbus-dup-processing-reason',
    text: 'what caused duplicate row processing in nimbus and how was it fixed',
    type: 'multi-session-causal',
    goldStableIds: ['nimbus-mq-decision', 'nimbus-dup-fix'],
    scope: project('nimbus'),
  },

  {
    id: 'q-isolation-test-colocation',
    text: 'where should test files live in atlas',
    type: 'cross-project-isolation',
    goldStableIds: ['atlas-test-colocation-convention', 'atlas-test-colocation-instance'],
    scope: project('atlas'),
  },
  {
    id: 'q-isolation-commit-convention',
    text: 'what commit message convention should nimbus follow',
    type: 'cross-project-isolation',
    goldStableIds: [
      'nimbus-conventional-commits-convention',
      'nimbus-conventional-commits-instance',
    ],
    scope: project('nimbus'),
  },

  // >= 8 so the rates move in 0.125 steps; each shares vocabulary with its own
  // scope so the gate is scored, not an empty candidate set. See queries.test.ts.
  {
    id: 'q-abstain-atlas-graphql',
    text: 'what GraphQL schema versioning strategy does atlas use',
    type: 'abstention',
    goldStableIds: [],
    scope: project('atlas'),
  },
  {
    id: 'q-abstain-nimbus-k8s-autoscaling',
    text: "what's nimbus's Kubernetes autoscaling threshold",
    type: 'abstention',
    goldStableIds: [],
    scope: project('nimbus'),
  },
  {
    id: 'q-abstain-atlas-feature-flags',
    text: 'which feature flag provider does atlas use for gradual rollouts',
    type: 'abstention',
    goldStableIds: [],
    scope: project('atlas'),
  },
  {
    id: 'q-abstain-atlas-invoice-pdf-slo',
    text: 'what latency SLO does atlas promise for invoice PDF generation',
    type: 'abstention',
    goldStableIds: [],
    scope: project('atlas'),
  },
  {
    id: 'q-abstain-nimbus-worker-replicas',
    text: 'how many worker replicas does the nimbus ingestion service run',
    type: 'abstention',
    goldStableIds: [],
    scope: project('nimbus'),
  },
  {
    id: 'q-abstain-nimbus-tracing-vendor',
    text: 'which observability vendor stores the nimbus scheduler traces',
    type: 'abstention',
    goldStableIds: [],
    scope: project('nimbus'),
  },
  {
    id: 'q-abstain-shared-shell-theme',
    text: 'what terminal shell and prompt theme does the user prefer',
    type: 'abstention',
    goldStableIds: [],
    scope: project('shared'),
  },
  {
    id: 'q-abstain-shared-changelog',
    text: 'how does the user want changelog entries written for a release',
    type: 'abstention',
    goldStableIds: [],
    scope: project('shared'),
  },

  {
    id: 'q-es-atlas-validation',
    text: 'qué librería usamos para validar los payloads de la API en atlas',
    type: 'extraction',
    goldStableIds: ['atlas-zod-validation-es'],
    scope: project('atlas'),
    bilingual: true,
  },
  {
    id: 'q-es-commit-language',
    text: 'en qué idioma deben escribirse los mensajes de commit',
    type: 'preference',
    goldStableIds: ['shared-commit-language-es'],
    scope: project('shared'),
    bilingual: true,
  },
  {
    id: 'q-es-nimbus-cron-migration',
    text: 'por qué migramos nimbus de cron a un scheduler basado en eventos',
    type: 'knowledge-update',
    goldStableIds: ['nimbus-cron-migration-es'],
    scope: project('nimbus'),
    bilingual: true,
  },

  // |gold| >= each gated k, so a row taking a slot in the page pushes an answer
  // out of it. Below that size Precision@k is pinned at its arithmetic ceiling
  // and Recall@k saturates, and a foreign row displaces nothing measurable.
  // Asserted in queries.test.ts rather than left to the fixture.
  {
    id: 'q-atlas-release-checklist',
    text: 'what does the atlas release checklist require before shipping a build',
    type: 'extraction',
    goldStableIds: [
      'atlas-release-step-migration-dryrun',
      'atlas-release-step-staging-soak',
      'atlas-release-step-smoke',
      'atlas-release-step-dependency-audit',
      'atlas-release-step-tag',
      'atlas-release-step-image-digest',
      'atlas-release-step-rollback-plan',
      'atlas-release-step-status-page',
    ],
    scope: project('atlas'),
  },
  {
    id: 'q-nimbus-oncall-runbook',
    text: 'what does the nimbus on-call runbook say to do during a paging incident',
    type: 'extraction',
    goldStableIds: [
      'nimbus-runbook-step-lag-check',
      'nimbus-runbook-step-pause-scheduler',
      'nimbus-runbook-step-snapshot-offsets',
      'nimbus-runbook-step-dlq-drain',
      'nimbus-runbook-step-handoff',
    ],
    scope: project('nimbus'),
  },

  // Gold outside the queried project, so recall scores the widening itself:
  // reading the home project alone cannot answer either of these, however well
  // it ranks. Each home project holds a plausible near-answer, so the narrow
  // page is a wrong answer rather than an empty one.
  {
    id: 'q-widened-dunning-window',
    text: 'how long is the dunning window before an account is suspended',
    type: 'cross-project-widened',
    goldStableIds: ['atlas-dunning-window'],
    scope: project('nimbus'),
    widened: true,
  },
  {
    id: 'q-widened-backfill-watermark',
    text: 'where is the backfill watermark stored',
    type: 'cross-project-widened',
    goldStableIds: ['nimbus-backfill-watermark'],
    scope: project('atlas'),
    widened: true,
  },
];
