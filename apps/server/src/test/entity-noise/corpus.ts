import type { EntityKind } from '../../db/schema/entities.js';

/**
 * Adversarial corpus behind `memory-entities`' "a kind MUST earn its place
 * against the lexical branch" requirement. It exists so the justification
 * table in that spec is measured rather than asserted in prose.
 *
 * The measurement asks one question per probe: an agent has an exact
 * identifier and looks it up as text. `sanitizeFtsQuery` quotes each
 * whitespace-delimited token and ORs them, and FTS5's `unicode61` tokenizer
 * drops `/`, `.`, `_`, `#` and `-` — so how many of the documents the lexical
 * branch returns are not about that identifier at all?
 *
 * A decoy is admissible ONLY under one of the two mechanisms the spec names,
 * and it MUST declare which. Without that rule any kind's figure could be
 * inflated by writing more prose:
 *
 *   - `near-miss-identifier` — the document carries a DIFFERENT, valid
 *     identifier of the same class whose tokens overlap the target's (a
 *     prefix, a suffix, or a sibling in the same numeric family).
 *   - `tokenization-collision` — the document is ordinary prose that happens
 *     to contain the identifier's tokens, reachable only because the
 *     tokenizer dropped the separator that made it an identifier.
 *
 * A kind whose probes measure 0% noise is NOT thereby unjustified: it may
 * still earn its place by enumeration or by removing a false extraction (the
 * other two clauses of the requirement).
 */

export type NoiseMechanism = 'near-miss-identifier' | 'tokenization-collision';

export interface NoiseProbe {
  kind: EntityKind;
  /**
   * Sub-family within the kind, when one kind's branches measure differently
   * enough that a single figure would misreport both — `error_code`'s prefixed
   * families versus its closed gRPC name list. Also the reporting group key.
   */
  family?: string;
  /** The exact identifier the agent is looking up. */
  identifier: string;
  /** A document that genuinely references `identifier`. */
  truth: string;
  /** Documents that do NOT reference `identifier` but which the lexical branch may still return. */
  decoys: readonly { readonly text: string; readonly mechanism: NoiseMechanism }[];
}

/**
 * The figures published in `memory-entities`' justification table, as whole
 * percentage points, keyed by reporting group. `noise-rate.test.ts` asserts
 * the measurement against this map, so the table and the corpus cannot drift
 * and a new kind cannot be justified in prose alone. Regenerate with
 * `npx tsx src/test/entity-noise/report.ts`.
 */
export const PUBLISHED_NOISE: Readonly<Record<string, number>> = {
  path: 67,
  hostname: 67,
  env_var: 67,
  ticket: 50,
  ip_address: 50,
  systemd_unit: 50,
  'error_code (GRPC_STATUS_NAMES)': 50,
  'error_code (ERR_/SQLITE_/E_/errno)': 0,
  git_ref: 0,
  url: 0,
  cve_id: 0,
  uuid: 0,
  mac_address: 0,
};

export const NOISE_PROBES: readonly NoiseProbe[] = [
  {
    kind: 'path',
    identifier: 'apps/server/src/db/migrate.ts',
    truth: 'the migration ordering bug is in apps/server/src/db/migrate.ts',
    decoys: [
      {
        text: 'apps/server/src/db/migrate.ts.bak is the pre-refactor copy, keep it out of the build',
        mechanism: 'near-miss-identifier',
      },
      {
        text: 'test/apps/server/src/db/migrate.ts covers the runner, not the runner itself',
        mechanism: 'near-miss-identifier',
      },
    ],
  },
  {
    kind: 'path',
    identifier: 'infra/main.tf',
    truth: 'the cluster autoscaler block lives in infra/main.tf',
    decoys: [
      {
        text: 'infra/modules/main.tf is the module copy, edited by nobody since the split',
        mechanism: 'near-miss-identifier',
      },
    ],
  },
  {
    kind: 'ticket',
    identifier: '#36',
    truth: 'the WAL checkpoint fix landed in #36',
    decoys: [
      {
        text: 'that release touched 36 files across the two workspaces',
        mechanism: 'tokenization-collision',
      },
    ],
  },
  {
    kind: 'ticket',
    identifier: 'PROJ-1234',
    truth: 'the retry backoff work is tracked as PROJ-1234',
    decoys: [
      {
        text: 'PROJ-1234-B is the split-out follow-up nobody has scheduled',
        mechanism: 'near-miss-identifier',
      },
      {
        text: 'PROJ-1235 is a different ticket about the billing export',
        mechanism: 'near-miss-identifier',
      },
    ],
  },
  {
    kind: 'ip_address',
    identifier: '192.168.1.50',
    truth: 'the NAS answers on 192.168.1.50 over the LAN',
    decoys: [
      {
        text: 'the printer sits at 192.168.1.5 and answers ping but not IPP',
        mechanism: 'near-miss-identifier',
      },
      {
        text: 'the agent reported build 10.192.168.1.50 in its handshake',
        mechanism: 'tokenization-collision',
      },
    ],
  },
  {
    kind: 'hostname',
    identifier: 'nas.local',
    truth: 'ssh into nas.local to collect the pool logs',
    decoys: [
      {
        text: 'the nas local drive is full again, prune the snapshots',
        mechanism: 'tokenization-collision',
      },
      {
        text: 'backup-nas.local is the secondary box, not the one with the pool',
        mechanism: 'near-miss-identifier',
      },
    ],
  },
  {
    kind: 'systemd_unit',
    identifier: 'caddy.service',
    truth: 'reload caddy.service after editing the site block',
    decoys: [
      {
        text: 'the caddy service definition in the compose file is unrelated to the host unit',
        mechanism: 'tokenization-collision',
      },
      {
        text: 'caddy-reload.service is the oneshot wrapper, not the daemon',
        mechanism: 'near-miss-identifier',
      },
    ],
  },
  {
    kind: 'env_var',
    identifier: 'DATABASE_URL',
    truth: 'export DATABASE_URL=postgres://... before running the migration',
    decoys: [
      {
        text: 'DATABASE_URL_REPLICA points at the read replica and is optional',
        mechanism: 'near-miss-identifier',
      },
      {
        text: 'the database url is printed in the boot banner, redacted after the host',
        mechanism: 'tokenization-collision',
      },
    ],
  },
  {
    kind: 'error_code',
    family: 'error_code (ERR_/SQLITE_/E_/errno)',
    identifier: 'ERR_MODULE_NOT_FOUND',
    truth: 'the entrypoint throws ERR_MODULE_NOT_FOUND when the dist copy is stale',
    // No admissible decoy: the prefix plus the underscores make the whole
    // token one FTS5 phrase with no shorter valid sibling and no prose form.
    decoys: [],
  },
  {
    kind: 'error_code',
    family: 'error_code (ERR_/SQLITE_/E_/errno)',
    identifier: 'SQLITE_CANTOPEN',
    truth: 'the dev stack dies with SQLITE_CANTOPEN until data-dev is chowned',
    decoys: [],
  },
  {
    kind: 'error_code',
    family: 'error_code (GRPC_STATUS_NAMES)',
    identifier: 'PERMISSION_DENIED',
    truth: 'the gRPC call came back PERMISSION_DENIED for the service account',
    decoys: [
      {
        text: 'permission denied writing the socket, the container runs as uid 10001',
        mechanism: 'tokenization-collision',
      },
      {
        text: 'the bucket policy grants no permission, so every denied request is expected',
        mechanism: 'tokenization-collision',
      },
    ],
  },
  {
    kind: 'error_code',
    family: 'error_code (GRPC_STATUS_NAMES)',
    identifier: 'NOT_FOUND',
    truth: 'the resolver returns NOT_FOUND for a tenant that was never provisioned',
    decoys: [
      {
        text: 'the module was not found because the path was misspelled',
        mechanism: 'tokenization-collision',
      },
      {
        text: 'not a single row was found in the audit table',
        mechanism: 'tokenization-collision',
      },
      {
        text: 'ALREADY_EXISTS is returned instead when the tenant was found',
        mechanism: 'tokenization-collision',
      },
    ],
  },
  {
    kind: 'error_code',
    family: 'error_code (ERR_/SQLITE_/E_/errno)',
    identifier: 'ENOENT',
    truth: 'the writer failed with ENOENT because the data dir was never created',
    decoys: [],
  },
  {
    kind: 'git_ref',
    identifier: 'cfb5c04',
    truth: 'the off-by-one was introduced in cfb5c04 and reverted the same day',
    decoys: [
      {
        text: 'cfb5c04a1 is the same work rebased onto the release branch',
        mechanism: 'near-miss-identifier',
      },
    ],
  },
  {
    kind: 'url',
    identifier: 'https://github.com/anthropics/claude-code/issues/282',
    truth: 'the upstream report is https://github.com/anthropics/claude-code/issues/282',
    decoys: [
      {
        text: 'https://github.com/anthropics/claude-code/issues/2820 is a different report',
        mechanism: 'near-miss-identifier',
      },
    ],
  },
  {
    kind: 'cve_id',
    identifier: 'CVE-2024-3094',
    truth: 'the xz backdoor is CVE-2024-3094 and the pinned version predates it',
    decoys: [
      {
        text: 'CVE-2024-30940 is an unrelated advisory in the same batch',
        mechanism: 'near-miss-identifier',
      },
    ],
  },
  {
    kind: 'uuid',
    identifier: '550e8400-e29b-41d4-a716-446655440000',
    truth: 'the failing request carried id 550e8400-e29b-41d4-a716-446655440000',
    decoys: [
      {
        text: 'the retry carried id 550e8400-e29b-41d4-a716-446655440001 and succeeded',
        mechanism: 'near-miss-identifier',
      },
    ],
  },
  {
    kind: 'mac_address',
    identifier: 'de:ad:be:ef:00:01',
    truth: 'the DHCP reservation for the NAS is de:ad:be:ef:00:01',
    decoys: [
      {
        text: 'the switch reports de:ad:be:ef:00:02 on port 4',
        mechanism: 'near-miss-identifier',
      },
    ],
  },
];
