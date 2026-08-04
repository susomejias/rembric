import type { CorpusItem } from './types.js';

/**
 * Fixture corpus: hand-written coding-session memories for two fictional
 * projects (`atlas`, a billing SaaS; `nimbus`, a data pipeline) plus a
 * handful of cross-project global memories. Every gold memory referenced by
 * `queries.ts` has at least one same-project, vocabulary-sharing distractor
 * here (design.md Decision 3) — see each item's `distractorFor`.
 */
export const PROJECTS = [
  { slug: 'atlas', displayName: 'Atlas Billing' },
  { slug: 'nimbus', displayName: 'Nimbus Pipeline' },
] as const;

export const CORPUS: CorpusItem[] = [
  {
    id: 'atlas-orm-choice',
    type: 'project',
    title: 'Atlas uses Drizzle over Prisma for the database layer',
    content:
      'Chose Drizzle ORM for atlas instead of Prisma: the generated SQL stays inspectable and migrations are plain .sql files we can review in PRs, instead of a binary engine and a proprietary migration format.',
    scope: 'project',
    project: 'atlas',
    daysAgo: 200,
  },
  {
    id: 'atlas-orm-distractor',
    type: 'project',
    title: 'Considered Prisma for atlas before settling on Drizzle',
    distractorFor: 'atlas-orm-choice',
    content:
      'Prototyped the billing schema in Prisma first — nice DX with the studio UI, but the query engine binary complicated the distroless Docker image, and the migration diffing was opaque compared to plain SQL.',
    scope: 'project',
    project: 'atlas',
    daysAgo: 205,
  },
  {
    id: 'nimbus-scheduler-port',
    type: 'reference',
    title: 'Nimbus scheduler listens on port 8781',
    content:
      "Nimbus's internal job scheduler listens on port 8781 (not the usual 8080) to avoid clashing with the health-check sidecar in the same pod. Documented here since it's easy to forget when writing a new probe.",
    scope: 'project',
    project: 'nimbus',
    daysAgo: 95,
  },
  {
    id: 'nimbus-scheduler-port-distractor',
    type: 'reference',
    title: 'Nimbus metrics exporter listens on port 8782',
    distractorFor: 'nimbus-scheduler-port',
    content:
      "Nimbus's Prometheus metrics exporter binds to port 8782, picked to sit outside the range reserved for application ports so a portscan of the pod doesn't mistake it for a request-serving service.",
    scope: 'project',
    project: 'nimbus',
    daysAgo: 93,
  },
  {
    id: 'nimbus-pg-pin',
    type: 'project',
    title: 'Pinned nimbus postgres client to 8.11.3',
    content:
      "Pinned nimbus's pg client to exactly 8.11.3 after 8.11.4 shipped a connection-pool regression that silently dropped idle connections under load, causing intermittent ECONNRESET during the nightly batch job.",
    scope: 'project',
    project: 'nimbus',
    daysAgo: 45,
  },
  {
    id: 'nimbus-pg-pin-distractor',
    type: 'project',
    title: 'Nimbus redis client left unpinned, tracks latest minor',
    distractorFor: 'nimbus-pg-pin',
    content:
      "Unlike the postgres client, nimbus's redis client is left on the latest minor version — no equivalent regression has hit it and it has no connection-pool behavior sensitive to point releases.",
    scope: 'project',
    project: 'nimbus',
    daysAgo: 44,
  },

  {
    id: 'atlas-auth-v1',
    type: 'project',
    title: 'Atlas uses Auth0 for authentication',
    topicKey: 'decision/atlas-auth-provider',
    content:
      'Atlas authenticates users via Auth0: hosted login pages, social providers out of the box, and a generous free tier for our current user count.',
    scope: 'project',
    project: 'atlas',
    daysAgo: 250,
  },
  {
    id: 'atlas-auth-v2',
    type: 'project',
    title: 'Atlas migrated authentication from Auth0 to WorkOS',
    topicKey: 'decision/atlas-auth-provider',
    content:
      "Migrated atlas's authentication from Auth0 to WorkOS: enterprise customers kept asking for SAML SSO, which Auth0 gated behind an enterprise plan we couldn't justify at our volume, and WorkOS prices SSO per-connection instead.",
    scope: 'project',
    project: 'atlas',
    daysAgo: 15,
  },
  {
    id: 'nimbus-retry-v1',
    type: 'project',
    title: 'Nimbus job retries use linear backoff',
    topicKey: 'decision/nimbus-retry-strategy',
    content:
      'Failed nimbus jobs retry with a flat 30-second linear backoff, up to 5 attempts, before moving to the dead-letter queue.',
    scope: 'project',
    project: 'nimbus',
    daysAgo: 180,
  },
  {
    id: 'nimbus-retry-v2',
    type: 'project',
    title: 'Nimbus job retries switched to exponential backoff with jitter',
    topicKey: 'decision/nimbus-retry-strategy',
    content:
      "Switched nimbus's job retries from linear to exponential backoff with jitter (base 2s, cap 5m): the flat 30s linear delay was causing synchronized retry storms against the same downstream API after a transient outage.",
    scope: 'project',
    project: 'nimbus',
    daysAgo: 8,
  },

  {
    id: 'atlas-rate-limit-old',
    type: 'project',
    title: 'Atlas rate limits the public API at 60 req/min per key',
    content:
      "Set atlas's public API rate limit to a flat 60 requests/minute per API key, enforced with a fixed-window counter in Redis.",
    scope: 'project',
    project: 'atlas',
    daysAgo: 160,
    distractorFor: 'atlas-rate-limit-new',
  },
  {
    id: 'atlas-rate-limit-new',
    type: 'project',
    title: 'Atlas moved rate limiting to a token bucket, 120 req/min burst 20',
    content:
      "Replaced atlas's fixed-window rate limiter with a token bucket: 120 requests/minute sustained, burst of 20, because the fixed window let clients double their effective rate by bursting across the window boundary.",
    scope: 'project',
    project: 'atlas',
    daysAgo: 4,
  },
  {
    id: 'nimbus-deploy-pipeline-old',
    type: 'project',
    title: 'Nimbus deploys via a manual Jenkins job',
    content:
      'Nimbus deploys are triggered by a manual Jenkins job that an engineer runs after merging to main — no automatic promotion, and no rollback beyond re-running the previous build.',
    scope: 'project',
    project: 'nimbus',
    daysAgo: 170,
    distractorFor: 'nimbus-deploy-pipeline-new',
  },
  {
    id: 'nimbus-deploy-pipeline-new',
    type: 'project',
    title: 'Nimbus deploys now run through GitHub Actions with auto-rollback',
    content:
      "Moved nimbus's deploys off the manual Jenkins job onto GitHub Actions: merge to main auto-deploys to staging, and a failed post-deploy health check auto-rolls back to the previous image tag with no human involved.",
    scope: 'project',
    project: 'nimbus',
    daysAgo: 6,
  },

  {
    id: 'pref-pr-review-depth',
    type: 'user',
    title: 'User wants PR reviews to focus on correctness over style',
    content:
      'When reviewing PRs on atlas or nimbus, the user wants correctness, security, and regressions flagged first; style-only nitpicks should be mentioned last or skipped if the diff is already large.',
    scope: 'global',
    daysAgo: 100,
  },
  {
    id: 'pref-pr-review-depth-distractor',
    type: 'user',
    title: 'User wants PR descriptions to state the why, not the what',
    distractorFor: 'pref-pr-review-depth',
    content:
      'The user prefers PR descriptions that explain why a change was made over restating what changed line-by-line, since the diff already shows the what.',
    scope: 'global',
    daysAgo: 98,
  },
  {
    id: 'pref-nimbus-docstrings',
    type: 'user',
    title: "User dislikes verbose docstrings in nimbus's Python code",
    content:
      "In nimbus's Python codebase specifically, the user wants short one-line docstrings only — no multi-paragraph Sphinx-style blocks restating the function signature in prose.",
    scope: 'project',
    project: 'nimbus',
    daysAgo: 30,
  },
  {
    id: 'pref-nimbus-docstrings-distractor',
    type: 'user',
    title: 'User wants type hints on every nimbus function signature',
    distractorFor: 'pref-nimbus-docstrings',
    content:
      "Separately from the docstring preference, the user wants every function in nimbus's Python codebase fully type-hinted, including return types, so mypy --strict stays green.",
    scope: 'project',
    project: 'nimbus',
    daysAgo: 29,
  },

  {
    id: 'atlas-cache-decision',
    type: 'project',
    title: 'Atlas added a Redis cache in front of the invoice list endpoint',
    content:
      "Added a Redis cache in front of atlas's GET /invoices endpoint: the query joins four tables and was taking 800ms+ under load, and invoice lists change rarely enough that a 60s TTL cache cuts p95 latency to under 50ms.",
    scope: 'project',
    project: 'atlas',
    daysAgo: 70,
  },
  {
    id: 'atlas-cache-bug-fix',
    type: 'project',
    title: 'Fixed stale invoice cache entries after payment status changes',
    content:
      "Found and fixed a bug in the invoice list cache added earlier: a payment status change wasn't invalidating the cached list, so a customer could see 'unpaid' for up to 60s after paying. Payment webhooks now explicitly bust the per-customer cache key.",
    scope: 'project',
    project: 'atlas',
    daysAgo: 12,
  },
  {
    id: 'atlas-cache-distractor',
    type: 'project',
    title: 'Atlas also caches the plan-pricing lookup table',
    distractorFor: 'atlas-cache-decision',
    content:
      "Separately from the invoice list cache, atlas caches the (rarely-changing) plan-pricing lookup table in-process with a 5-minute TTL, since it's read on every checkout request.",
    scope: 'project',
    project: 'atlas',
    daysAgo: 65,
  },
  {
    id: 'nimbus-mq-decision',
    type: 'project',
    title: 'Nimbus moved ingestion from polling to a message queue',
    content:
      "Replaced nimbus's polling-based ingestion (querying the source table every 30s) with an SQS-backed message queue, so new rows are processed within seconds instead of up to 30s late, and the source DB no longer takes a polling query every cycle.",
    scope: 'project',
    project: 'nimbus',
    daysAgo: 80,
  },
  {
    id: 'nimbus-dup-fix',
    type: 'project',
    title: 'Fixed duplicate row processing from the nimbus message queue',
    content:
      "Root-caused nimbus's duplicate-row processing to SQS's at-least-once delivery combined with a non-idempotent insert: a redelivered message after a slow consumer ack caused the same row to be inserted twice. Fixed by keying the insert on the source row's natural id with ON CONFLICT DO NOTHING.",
    scope: 'project',
    project: 'nimbus',
    daysAgo: 14,
  },
  {
    id: 'nimbus-mq-distractor',
    type: 'project',
    title: 'Nimbus queue visibility timeout set to 2 minutes',
    distractorFor: 'nimbus-mq-decision',
    content:
      "Set the SQS visibility timeout for nimbus's ingestion queue to 2 minutes, comfortably above the slowest observed consumer processing time, to reduce (not eliminate) redeliveries.",
    scope: 'project',
    project: 'nimbus',
    daysAgo: 78,
  },

  {
    id: 'global-test-colocation',
    type: 'user',
    title: 'User wants tests co-located with source, never a separate /tests dir',
    content:
      'Across every project, the user wants test files co-located next to the source file they cover (e.g. foo.ts + foo.test.ts in the same directory), not gathered into a top-level /tests tree.',
    scope: 'global',
    daysAgo: 220,
  },
  {
    id: 'atlas-test-colocation-convention',
    type: 'user',
    title: 'User wants atlas tests co-located with source, never a separate /tests dir',
    content:
      'In atlas the user wants test files co-located next to the source file they cover (e.g. foo.ts + foo.test.ts in the same directory), not gathered into a top-level /tests tree.',
    scope: 'project',
    project: 'atlas',
    daysAgo: 218,
  },
  {
    id: 'atlas-test-colocation-instance',
    type: 'project',
    title: 'Added invoice.test.ts next to invoice.ts in atlas',
    content:
      'Added atlas/src/billing/invoice.test.ts directly next to invoice.ts, following the project-wide co-location convention, instead of the /tests/billing/ layout the previous contractor had started.',
    scope: 'project',
    project: 'atlas',
    daysAgo: 40,
  },
  {
    id: 'atlas-test-colocation-distractor',
    type: 'project',
    title: 'Atlas keeps end-to-end tests in a separate /e2e directory',
    distractorFor: 'atlas-test-colocation-instance',
    content:
      "Unlike unit tests, atlas's end-to-end Playwright specs live in a separate top-level /e2e directory, since they don't correspond to a single source file the way unit tests do.",
    scope: 'project',
    project: 'atlas',
    daysAgo: 38,
  },
  // Isolation control for q-isolation-test-colocation: same vocabulary, other
  // project, opposite answer — a widened scope shows up as a wrong hit here.
  {
    id: 'nimbus-test-layout-cross-project',
    type: 'project',
    title: 'Nimbus keeps its test files in a top-level tests/ tree',
    content:
      "Nimbus's test files live in a top-level tests/ tree mirroring the package layout, not co-located next to the module they cover, because the runner discovers them from that root.",
    scope: 'project',
    project: 'nimbus',
    daysAgo: 42,
  },
  {
    id: 'global-conventional-commits',
    type: 'user',
    title: 'User wants Conventional Commits in every project',
    content:
      'Every project the user works on should use Conventional Commits (feat:, fix:, chore:, etc.) for commit messages, enforced by commitlint where possible.',
    scope: 'global',
    daysAgo: 210,
  },
  {
    id: 'nimbus-conventional-commits-convention',
    type: 'user',
    title: 'User wants Conventional Commits for nimbus commit messages',
    content:
      'Commit messages in nimbus should use Conventional Commits (feat:, fix:, chore:, etc.), enforced by commitlint where possible.',
    scope: 'project',
    project: 'nimbus',
    daysAgo: 208,
  },
  {
    id: 'nimbus-conventional-commits-instance',
    type: 'project',
    title: 'Wired commitlint into nimbus following the Conventional Commits rule',
    content:
      "Added a commitlint pre-commit hook to nimbus enforcing Conventional Commits, matching the user's cross-project convention — nimbus had been using free-form commit messages until now.",
    scope: 'project',
    project: 'nimbus',
    daysAgo: 50,
  },
  {
    id: 'nimbus-commit-distractor',
    type: 'project',
    title: 'Nimbus squashes PRs into a single commit on merge',
    distractorFor: 'nimbus-conventional-commits-instance',
    content:
      "Nimbus's GitHub repo is configured to squash-merge every PR into a single commit, independent of the Conventional Commits formatting rule applied to that commit's message.",
    scope: 'project',
    project: 'nimbus',
    daysAgo: 49,
  },
  // Isolation control for q-isolation-commit-convention, as above.
  {
    id: 'atlas-commit-convention-cross-project',
    type: 'project',
    title: 'Atlas commit messages carry a leading Jira key, not a Conventional Commits type',
    content:
      "Atlas's commit message convention is a leading Jira issue key (e.g. `ATL-1423: widen the dunning window`) rather than a Conventional Commits type prefix, because its release notes are generated from Jira.",
    scope: 'project',
    project: 'atlas',
    daysAgo: 55,
  },

  {
    id: 'atlas-zod-validation-es',
    type: 'project',
    title: 'Atlas valida los payloads de la API con Zod',
    content:
      'Decidimos usar Zod para validar los payloads de la API de atlas en el borde, antes de tocar la base de datos, así los errores de forma se rechazan con un 400 claro en vez de reventar más abajo en el ORM.',
    scope: 'project',
    project: 'atlas',
    daysAgo: 55,
  },
  {
    id: 'atlas-zod-validation-es-distractor',
    type: 'project',
    title: 'Atlas también valida las variables de entorno al arrancar',
    distractorFor: 'atlas-zod-validation-es',
    content:
      'Además de los payloads de la API, atlas valida sus variables de entorno al arrancar con un esquema Zod separado, así un despliegue con configuración incompleta falla rápido en vez de fallar a mitad de una request.',
    scope: 'project',
    project: 'atlas',
    daysAgo: 53,
  },
  {
    id: 'global-commit-language-es',
    type: 'user',
    title: 'Los mensajes de commit siempre van en inglés',
    content:
      'El equipo prefiere que los mensajes de commit sean en inglés siempre, independientemente del idioma en el que se converse con el agente.',
    scope: 'global',
    daysAgo: 190,
  },
  {
    id: 'global-commit-language-es-distractor',
    type: 'user',
    title: 'Los títulos de PR también van siempre en inglés',
    distractorFor: 'global-commit-language-es',
    content:
      'Igual que los mensajes de commit, los títulos y descripciones de las pull requests se escriben siempre en inglés, sin importar el idioma del chat.',
    scope: 'global',
    daysAgo: 188,
  },
  {
    id: 'global-atomic-commits',
    type: 'user',
    title: 'User wants each commit to be one atomic logical change',
    content:
      'Across every project, the user wants each commit to represent a single logical change — no mixing an unrelated refactor or dependency bump into the same commit as a feature or fix.',
    scope: 'global',
    daysAgo: 140,
  },
  {
    id: 'global-atomic-commits-distractor',
    type: 'user',
    title: 'User wants commit subject lines kept under 72 characters',
    distractorFor: 'global-atomic-commits',
    content:
      'Separately from atomicity, the user wants the commit subject line kept under 72 characters, wrapping any further detail into the commit body instead.',
    scope: 'global',
    daysAgo: 138,
  },
  {
    id: 'global-no-emoji',
    type: 'user',
    title: 'User does not want emoji in code, commits, or PRs unless asked',
    content:
      'The user does not want emoji added to code, commit messages, or PR descriptions unless they explicitly ask for it in that instance.',
    scope: 'global',
    daysAgo: 75,
  },
  {
    id: 'global-no-emoji-distractor',
    type: 'user',
    title: 'User wants PR titles prefixed with a Conventional Commits type',
    distractorFor: 'global-no-emoji',
    content:
      'Separately from the emoji preference, the user wants every PR title prefixed with a Conventional Commits type (feat:, fix:, etc.), matching the commit message convention.',
    scope: 'global',
    daysAgo: 73,
  },
  {
    id: 'nimbus-cron-migration-es',
    type: 'project',
    title: 'Nimbus migró de cron a un scheduler basado en eventos',
    content:
      'Migramos el pipeline de nimbus de cron a un scheduler basado en eventos porque cron perdía ejecuciones durante los despliegues: si el despliegue coincidía con la ventana de ejecución, ese ciclo simplemente no corría.',
    scope: 'project',
    project: 'nimbus',
    daysAgo: 35,
  },
  {
    id: 'nimbus-cron-migration-es-distractor',
    type: 'project',
    title: 'Nimbus mantiene un cron aparte solo para los reportes semanales',
    distractorFor: 'nimbus-cron-migration-es',
    content:
      'A diferencia del pipeline principal, nimbus mantiene un job de cron aparte únicamente para generar los reportes semanales, porque no necesita la latencia baja del scheduler basado en eventos.',
    scope: 'project',
    project: 'nimbus',
    daysAgo: 33,
  },
];
