import type { MemoryType } from '@rembric/db';

export interface SaveTimeBaseItem {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
}

export const SAVE_TIME_CLASSES = [
  'near-duplicate',
  'expanded-rewrite',
  'contradiction',
  'unrelated',
  'related',
] as const;
export type SaveTimeClass = (typeof SAVE_TIME_CLASSES)[number];

export interface LabelledSave {
  id: string;
  class: SaveTimeClass;
  /** The base item this save is about; absent only for `unrelated`. */
  expects?: string;
  type: MemoryType;
  title: string;
  content: string;
}

export const SAVE_TIME_BASE: SaveTimeBaseItem[] = [
  {
    id: 'b-orm',
    type: 'project',
    title: 'Billing service uses Drizzle ORM',
    content:
      'The billing service talks to SQLite through Drizzle ORM; migrations are plain SQL files under db/migrations reviewed in every pull request.',
  },
  {
    id: 'b-port',
    type: 'reference',
    title: 'Scheduler listens on port 8781',
    content:
      'The job scheduler binds to port 8781 instead of 8080 so it does not collide with the health-check sidecar running in the same pod.',
  },
  {
    id: 'b-node',
    type: 'project',
    title: 'Node 22 is the minimum runtime',
    content:
      'All services require Node 22 or newer because the test runner relies on the built-in fetch and the stable watch mode.',
  },
  {
    id: 'b-lint',
    type: 'procedural',
    title: 'Imports are ordered builtin, external, internal, relative',
    content:
      'ESLint auto-fixes import order: builtin modules first, then external packages, then internal workspace packages, then relative paths.',
  },
  {
    id: 'b-auth',
    type: 'project',
    title: 'Dashboard sessions expire after 12 hours',
    content:
      'Operator dashboard sessions are signed cookies that expire 12 hours after login; the expiry is checked on every request by the session middleware in src/lib/session.ts.',
  },
  {
    id: 'b-backup',
    type: 'reference',
    title: 'Nightly backups go to the off-site bucket',
    content:
      'A cron job at 02:30 UTC copies the SQLite file with the online backup API to the off-site bucket and keeps fourteen daily copies.',
  },
  {
    id: 'b-flaky',
    type: 'project',
    title: 'The websocket reconnect test is flaky on CI',
    content:
      'tests/realtime/reconnect.test.ts fails roughly one run in twenty on CI because the fake timer advances before the socket mock emits close; it is quarantined until the mock is fixed.',
  },
  {
    id: 'b-env',
    type: 'reference',
    title: 'STRIPE_WEBHOOK_SECRET is required in production',
    content:
      'The payments webhook handler refuses to start in production when STRIPE_WEBHOOK_SECRET is missing, so deploys fail fast instead of accepting unsigned events.',
  },
  {
    id: 'b-tz',
    type: 'procedural',
    title: "Store timestamps in UTC, render in the viewer's zone",
    content:
      "Every timestamp is stored as UTC milliseconds and converted to the viewer's time zone only in the presentation layer.",
  },
  {
    id: 'b-cache',
    type: 'project',
    title: 'Search results are cached for 60 seconds',
    content:
      'The public search endpoint caches responses in memory for 60 seconds keyed by the normalized query string; writes do not invalidate the cache.',
  },
  {
    id: 'b-docker',
    type: 'project',
    title: 'The production image is distroless',
    content:
      'The Docker image is built in two stages and the runtime stage is distroless, so there is no shell; debugging goes through the ephemeral debug container.',
  },
  {
    id: 'b-pnpm',
    type: 'procedural',
    title: 'Use pnpm through corepack',
    content:
      'The repository pins pnpm with corepack; run corepack enable once and never install pnpm globally with npm.',
  },
  {
    id: 'b-user-lang',
    type: 'user',
    title: 'El usuario prefiere respuestas en español',
    content:
      'Responder siempre en español al usuario, aunque el código, los commits y los comentarios se escriban en inglés.',
  },
  {
    id: 'b-es-deploy',
    type: 'project',
    title: 'Los despliegues se hacen los martes',
    content:
      'El equipo despliega a producción solo los martes por la mañana para tener margen de reacción antes del fin de semana.',
  },
  {
    id: 'b-es-reviews',
    type: 'procedural',
    title: 'Dos aprobaciones para fusionar en main',
    content:
      'Cualquier pull request contra main necesita dos aprobaciones y la integración continua en verde antes de poder fusionarse.',
  },
  {
    id: 'b-rate',
    type: 'reference',
    title: 'API rate limit is 120 requests per minute per token',
    content:
      'The HTTP API allows 120 requests per minute per bearer token; excess requests get 429 with a Retry-After header.',
  },
  {
    id: 'b-logs',
    type: 'procedural',
    title: 'Logs are JSON lines on stdout',
    content:
      'Every service writes structured JSON lines to stdout; the log shipper adds the pod name and forwards them, so files are never written inside the container.',
  },
  {
    id: 'b-flags',
    type: 'procedural',
    title: 'Feature flags live in config/flags.yaml',
    content:
      'Feature flags are declared in config/flags.yaml with an owner and a removal date; a CI check fails when a flag is past its removal date.',
  },
  {
    id: 'b-pdf',
    type: 'project',
    title: 'Invoices are rendered to PDF with a headless browser',
    content:
      'Invoice PDFs are produced by rendering the invoice HTML template in headless Chromium; fonts are embedded so the output matches across machines.',
  },
  {
    id: 'b-retry',
    type: 'project',
    title: 'Outbound webhooks retry with exponential backoff',
    content:
      'Failed outbound webhooks are retried up to eight times with exponential backoff starting at thirty seconds, then marked dead and shown in the admin panel.',
  },
  {
    id: 'b-i18n',
    type: 'project',
    title: 'Translations are loaded per route',
    content:
      'Translation bundles are split per route and loaded lazily, so the initial page only ships the strings it renders.',
  },
  {
    id: 'b-es-db',
    type: 'reference',
    title: 'La base de datos de analítica es de solo lectura',
    content:
      'La réplica de analítica se abre en modo solo lectura; cualquier escritura debe ir al primario a través del servicio de facturación.',
  },
  {
    id: 'b-ulid',
    type: 'project',
    title: 'Public identifiers are ULIDs',
    content:
      'Records exposed through the API use ULID identifiers so they sort by creation time; internal join tables keep integer keys.',
  },
  {
    id: 'b-ui',
    type: 'procedural',
    title: 'Shared UI components live in packages/ui',
    content:
      'Reusable React components belong in packages/ui and are imported by the apps; app folders must not import from each other.',
  },
];

export const SAVE_TIME_SAVES: LabelledSave[] = [
  {
    id: 'nd-port',
    class: 'near-duplicate',
    expects: 'b-port',
    type: 'reference',
    title: 'Job scheduler port is 8781',
    content:
      'The scheduler service listens on port 8781, not 8080, to avoid clashing with the health-check sidecar in the same pod.',
  },
  {
    id: 'nd-orm',
    class: 'near-duplicate',
    expects: 'b-orm',
    type: 'project',
    title: 'Billing persistence goes through Drizzle',
    content:
      'Billing talks to SQLite through Drizzle ORM, and its migrations are plain SQL files in db/migrations that get reviewed in each pull request.',
  },
  {
    id: 'nd-node',
    class: 'near-duplicate',
    expects: 'b-node',
    type: 'project',
    title: 'Services need Node 22+',
    content:
      'Every service needs Node 22 or newer since the test runner depends on built-in fetch and the stable watch mode.',
  },
  {
    id: 'nd-backup',
    class: 'near-duplicate',
    expects: 'b-backup',
    type: 'reference',
    title: 'Off-site SQLite backups run nightly',
    content:
      'At 02:30 UTC a cron job copies the SQLite file with the online backup API to the off-site bucket, keeping fourteen daily copies.',
  },
  {
    id: 'nd-rate',
    class: 'near-duplicate',
    expects: 'b-rate',
    type: 'reference',
    title: 'Per-token API rate limit',
    content:
      'The HTTP API permits 120 requests per minute for each bearer token and answers excess requests with 429 plus a Retry-After header.',
  },
  {
    id: 'nd-es-reviews',
    class: 'near-duplicate',
    expects: 'b-es-reviews',
    type: 'procedural',
    title: 'Fusionar en main requiere dos aprobaciones',
    content:
      'Toda pull request contra main requiere dos aprobaciones y la integración continua en verde antes de fusionarse.',
  },
  {
    id: 'nd-flags',
    class: 'near-duplicate',
    expects: 'b-flags',
    type: 'procedural',
    title: 'Feature flags need an owner and a removal date',
    content:
      'Feature flags are declared in config/flags.yaml, each with an owner and a removal date, and CI fails once a flag passes its removal date.',
  },
  {
    id: 'nd-user-lang',
    class: 'near-duplicate',
    expects: 'b-user-lang',
    type: 'user',
    title: 'Contestar al usuario en español',
    content:
      'Responder al usuario siempre en español, aunque los commits, el código y los comentarios vayan en inglés.',
  },
  {
    id: 'er-logs',
    class: 'expanded-rewrite',
    expects: 'b-logs',
    type: 'procedural',
    title: 'Logging conventions for every service',
    content:
      'Every service writes structured JSON lines to stdout and never to files inside the container. The log shipper adds the pod name before forwarding. Each line carries a level (debug, info, warn, error), an ISO timestamp, the request correlation id propagated from the incoming x-request-id header, and the service version. Debug lines are sampled at one percent in production. Stack traces go in a single escaped field so one event never spans several lines. Personal data such as emails and IP addresses must be hashed before logging. Retention in the central store is thirty days for info and above and three days for debug.',
  },
  {
    id: 'er-docker',
    class: 'expanded-rewrite',
    expects: 'b-docker',
    type: 'project',
    title: 'How the production container image is built',
    content:
      'The Docker image is built in two stages. The build stage installs the full toolchain, compiles the TypeScript, prunes development dependencies and copies the production node_modules. The runtime stage is distroless and runs as a non-root user with a read-only root filesystem, so there is no shell, no package manager and no curl. Health checks are served by the application itself on a dedicated route. Debugging a running pod goes through the ephemeral debug container, which mounts the process namespace. Image size dropped from 410 MB to 160 MB after the switch, and the vulnerability scanner now reports no findings in the base layer.',
  },
  {
    id: 'er-retry',
    class: 'expanded-rewrite',
    expects: 'b-retry',
    type: 'project',
    title: 'Outbound webhook delivery and retries',
    content:
      'Outbound webhooks are delivered by a background worker that signs each payload with the subscriber secret. A delivery fails on a network error, a timeout after ten seconds, or any status outside the 2xx range. Failed deliveries are retried up to eight times with exponential backoff starting at thirty seconds and capped at six hours, with jitter to avoid thundering herds. After the last attempt the delivery is marked dead and shown in the admin panel, where an operator can replay it. Subscribers that fail every delivery for three days are disabled automatically and notified by email.',
  },
  {
    id: 'er-es-deploy',
    class: 'expanded-rewrite',
    expects: 'b-es-deploy',
    type: 'project',
    title: 'Calendario y proceso de despliegue',
    content:
      'El equipo despliega a producción solo los martes por la mañana, para tener margen de reacción antes del fin de semana. El lunes se congela la rama principal y se prepara la nota de versión. El despliegue lo lanza la persona de guardia desde el pipeline, primero en el entorno de preproducción y después en producción con un despliegue gradual al diez, cincuenta y cien por cien. Si alguna métrica clave empeora, se revierte la versión sin esperar a investigar. Los cambios urgentes de seguridad son la única excepción y pueden salir cualquier día con la aprobación del responsable técnico.',
  },
  {
    id: 'c-session',
    class: 'contradiction',
    expects: 'b-auth',
    type: 'project',
    title: 'Operators stay logged in for a week',
    content:
      'src/lib/session.ts now keeps operators signed in for seven days; the short expiry annoyed people during long incidents.',
  },
  {
    id: 'c-env',
    class: 'contradiction',
    expects: 'b-env',
    type: 'reference',
    title: 'Webhook secret is fetched lazily from the vault',
    content:
      'Production no longer reads STRIPE_WEBHOOK_SECRET at boot; the secret is fetched from the vault on the first webhook instead.',
  },
  {
    id: 'c-flaky',
    class: 'contradiction',
    expects: 'b-flaky',
    type: 'project',
    title: 'Reconnect test is stable again',
    content:
      'tests/realtime/reconnect.test.ts is stable again after the timer fix and runs in the normal CI job.',
  },
  {
    id: 'c-flags',
    class: 'contradiction',
    expects: 'b-flags',
    type: 'procedural',
    title: 'Flags moved to the remote config service',
    content:
      'We dropped config/flags.yaml; flags now come from the remote config service and have no expiry check.',
  },
  {
    id: 'c-cache',
    class: 'contradiction',
    expects: 'b-cache',
    type: 'project',
    title: 'Index writes purge cached search responses',
    content:
      'Writes to the index now purge the public search response cache immediately, and entries no longer live a full minute.',
  },
  {
    id: 'u-tabs',
    class: 'unrelated',
    type: 'procedural',
    title: 'Makefiles need tab indentation',
    content:
      'Prefer tabs over spaces in Makefiles because make requires a literal tab before each recipe line.',
  },
  {
    id: 'u-retro',
    class: 'unrelated',
    type: 'project',
    title: 'Retro cadence',
    content:
      'The team retro happens every other Friday afternoon and the notes are kept in the shared drive.',
  },
  {
    id: 'u-thumbs',
    class: 'unrelated',
    type: 'project',
    title: 'Thumbnails are generated on upload',
    content:
      'Image thumbnails are generated on upload with sharp and stored next to the original file.',
  },
  {
    id: 'u-dns',
    class: 'unrelated',
    type: 'reference',
    title: 'Marketing site hosting',
    content:
      'The marketing site is hosted on a static CDN and its DNS records are managed by the platform team.',
  },
  {
    id: 'u-logo',
    class: 'unrelated',
    type: 'user',
    title: 'Slides use the new logo',
    content: 'Use the new logo in all slides.',
  },
  {
    id: 'u-es-meeting',
    class: 'unrelated',
    type: 'project',
    title: 'Cambio de día de la planificación',
    content: 'La reunión de planificación se mueve al jueves a las diez.',
  },
  {
    id: 'u-es-icons',
    class: 'unrelated',
    type: 'procedural',
    title: 'Iconos del panel',
    content: 'Los iconos del panel usan el set de Lucide con trazo de 1,5 píxeles.',
  },
  {
    id: 'u-a11y',
    class: 'unrelated',
    type: 'procedural',
    title: 'Visible focus rings',
    content: 'All interactive elements need a visible focus ring for keyboard users.',
  },
  {
    id: 'u-report',
    class: 'unrelated',
    type: 'project',
    title: 'Weekly finance report',
    content: 'The weekly report email goes out on Monday mornings to the finance team.',
  },
  {
    id: 'u-onboarding',
    class: 'unrelated',
    type: 'procedural',
    title: 'Onboarding reading',
    content:
      'New contributors should read the architecture overview before their first pull request.',
  },
];

export const SAVE_TIME_RELATED_SAVES: LabelledSave[] = [
  {
    id: 'r-session-owner',
    class: 'related',
    expects: 'b-auth',
    type: 'project',
    title: 'Platform team owns the session module',
    content:
      'src/lib/session.ts is owned by the platform team, so a pull request touching it needs one of their reviewers.',
  },
  {
    id: 'r-session-lint',
    class: 'related',
    expects: 'b-auth',
    type: 'procedural',
    title: 'The session module has no default export',
    content:
      'Lint forbids a default export in src/lib/session.ts; import the named helpers instead.',
  },
  {
    id: 'r-retry-after',
    class: 'related',
    expects: 'b-rate',
    type: 'reference',
    title: 'Clients back off on 429',
    content:
      'Our SDK sleeps for the Retry-After interval before resending a request that was rejected with status 429.',
  },
  {
    id: 'r-debug',
    class: 'related',
    expects: 'b-docker',
    type: 'procedural',
    title: 'Inspecting a live container',
    content:
      'To look inside a running service, attach an ephemeral debug container with kubectl debug, since the image ships without a shell.',
  },
  {
    id: 'r-cache-key',
    class: 'related',
    expects: 'b-cache',
    type: 'project',
    title: 'The search cache normalises queries',
    content:
      'Before a query becomes a cache key it is lowercased and trimmed, so equivalent searches hit the same cached entry.',
  },
  {
    id: 'r-es-review-time',
    class: 'related',
    expects: 'b-es-reviews',
    type: 'procedural',
    title: 'Las revisiones se piden en el canal del equipo',
    content:
      'Para pedir revisión de un pull request se avisa en el canal del equipo y se asigna a dos personas.',
  },
  {
    id: 'r-reconnect-shard',
    class: 'related',
    expects: 'b-flaky',
    type: 'project',
    title: 'Realtime tests run in their own CI shard',
    content:
      'tests/realtime/reconnect.test.ts and the other realtime suites run in a separate CI shard with a longer timeout.',
  },
  {
    id: 'r-webhook-replay',
    class: 'related',
    expects: 'b-retry',
    type: 'project',
    title: 'Dead webhooks can be replayed',
    content:
      'Operators can replay a dead outbound webhook from the admin panel once the receiving endpoint is healthy again.',
  },
  {
    id: 'r-reconnect-helper',
    class: 'related',
    expects: 'b-flaky',
    type: 'project',
    title: 'Socket mocks are shared test helpers',
    content:
      'tests/realtime/reconnect.test.ts imports its socket mock from the shared test helpers, so every realtime test builds sockets the same way.',
  },
  {
    id: 'r-cache-metrics',
    class: 'related',
    expects: 'b-cache',
    type: 'project',
    title: 'Search cache hit rate is on the dashboard',
    content:
      'The hit rate of the in-memory search cache is exported as a metric and charted on the operations dashboard.',
  },
];
