import type { EntityKind } from '../db/schema/entities.js';

/**
 * Pattern registry for deterministic entity extraction, separated from the
 * extraction loop so the rules are inspectable and unit-testable on their own.
 *
 * `examples`/`rejects` are REQUIRED fields: `extractor-rules.test.ts` runs the
 * whole registry against them, so a kind cannot be added without stating both
 * what it must catch and what prose it must not. That makes coverage
 * structural rather than something a contributor has to remember.
 */

export interface ExtractorRule {
  kind: EntityKind;
  /** Must carry the `g` flag; iterated with `matchAll`. */
  pattern: RegExp;
  /** Capture group holding the value. Default 0 (whole match). */
  capture?: number;
  /** Second gate for shapes a regex alone cannot bound (whitelist/denylist). */
  accept?: (m: RegExpMatchArray) => boolean;
  normalize: (raw: string) => string | null;
  examples: readonly { readonly text: string; readonly values: readonly string[] }[];
  rejects: readonly string[];
}

const TRAILING_PUNCT_RE = /[.,;:!?)'"`]+$/;
export function stripTrailingPunct(s: string): string {
  return s.replace(TRAILING_PUNCT_RE, '');
}

// A file path: at least one `/` and a recognized code/config extension, or a
// dotfile-led relative path. Requiring an extension (or a leading dot) is what
// keeps prose like "a solution / an idea" and versions like "3.14" out.
const PATH_EXT =
  'ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|php|java|kt|swift|c|cc|cpp|h|hpp|sh|bash|zsh|' +
  'sql|json|yaml|yml|md|mdx|toml|ini|cfg|conf|env|css|scss|html|xml|proto|graphql|lock|' +
  // Infra-as-code and unit files: the vocabulary a homelab operator writes
  // most, absent from the original code-only list.
  'tf|tfvars|hcl|tpl|service|socket|timer|rules|nix|dockerfile|containerfile';
// Gating on PATH_EXT instead would be a trap: `sql` is already there, and `.sql`
// is a file type rather than a file. Case-sensitive, because `normalize` does not
// fold case. Seeded from `git ls-files` so a narrowing meant to drop prose cannot
// also drop an address this repo writes bare — `entities.test.ts` asserts the
// tracked ones, and the suite fails if a future trim loses one.
const DOTFILE_NAMES = new Set([
  'agents',
  'bashrc',
  'browserslistrc',
  'claude',
  'claude-plugin',
  'codegraph',
  'codex',
  'codex-plugin',
  'devcontainer',
  'dockerignore',
  'editorconfig',
  'env',
  'eslintignore',
  'eslintrc',
  'gitattributes',
  'github',
  'gitignore',
  'gitkeep',
  'gitlab-ci',
  'gitmodules',
  'hermes',
  'hermes-plugin',
  'husky',
  'mcp',
  'node-version',
  'npmignore',
  'npmrc',
  'nvmrc',
  'opencode',
  'opencode-plugin',
  'openspec',
  'prettierignore',
  'prettierrc',
  'release-please-manifest',
  'rembric',
  'ssh',
  'tool-versions',
  'zshrc',
]);
// Extension must be terminal, else `src/user.service.ts` stores `src/user.service`.
const PATH_RE = new RegExp(
  `(?:^|[\\s"'(\`])((?:\\.{1,2}\\/)?(?:[A-Za-z0-9_.-]+\\/)+[A-Za-z0-9_.-]+\\.(?:${PATH_EXT})|\\.[A-Za-z][A-Za-z0-9_.-]{2,40})(?=[\\s"'),:;!?\`]|\\.(?![A-Za-z0-9])|$)`,
  'g',
);

// A git SHA: 7-40 hex chars requiring BOTH a letter (a-f) and a digit, which
// excludes all-letter words that happen to use only hex-valid letters.
const GIT_REF_RE = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}\b/g;

/** A hex run flanked by hyphen-hex is a UUID segment, not a ref. */
function notUuidSegment(m: RegExpMatchArray): boolean {
  const input = m.input ?? '';
  const start = m.index ?? 0;
  const after = input.slice(start + m[0].length);
  const before = input.slice(0, start);
  return !/^-[0-9a-f]{4}(-|\b)/i.test(after) && !/[0-9a-f]-$/i.test(before);
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/g;

// A closed whitelist of POSIX/libuv errno names — not a generic `E`-prefix
// regex, which would also match plain-English all-caps words ("ERROR",
// "EITHER"). The `ERR_*`/`SQLITE_*`/underscored family below is regex-safe on
// its own: the underscore is what excludes prose.
const ERRNO_NAMES = new Set([
  'ENOENT',
  'EACCES',
  'EAGAIN',
  'EADDRINUSE',
  'EADDRNOTAVAIL',
  'EAFNOSUPPORT',
  'EALREADY',
  'EBADF',
  'EBUSY',
  'ECANCELED',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EDESTADDRREQ',
  'EDQUOT',
  'EEXIST',
  'EFAULT',
  'EFBIG',
  'EHOSTUNREACH',
  'EIDRM',
  'EILSEQ',
  'EINPROGRESS',
  'EINTR',
  'EINVAL',
  'EIO',
  'EISCONN',
  'EISDIR',
  'ELOOP',
  'EMFILE',
  'EMLINK',
  'EMSGSIZE',
  'ENAMETOOLONG',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'ENFILE',
  'ENOBUFS',
  'ENODATA',
  'ENODEV',
  'ENOLCK',
  'ENOLINK',
  'ENOMEM',
  'ENOMSG',
  'ENOPROTOOPT',
  'ENOSPC',
  'ENOSR',
  'ENOSTR',
  'ENOSYS',
  'ENOTCONN',
  'ENOTDIR',
  'ENOTEMPTY',
  'ENOTRECOVERABLE',
  'ENOTSOCK',
  'ENOTSUP',
  'ENOTTY',
  'ENXIO',
  'EOPNOTSUPP',
  'EOVERFLOW',
  'EOWNERDEAD',
  'EPERM',
  'EPIPE',
  'EPROTO',
  'EPROTONOSUPPORT',
  'EPROTOTYPE',
  'ERANGE',
  'EROFS',
  'ESPIPE',
  'ESRCH',
  'ESTALE',
  'ETIME',
  'ETIMEDOUT',
  'ETXTBSY',
  'EWOULDBLOCK',
  'EXDEV',
]);
// Prefixed error families only. A bare `[A-Z]+(_[A-Z]+)+` alternative used to
// live here and swallowed every env var and constant (`DATABASE_URL`,
// `MAX_RETRIES`) as an error code; unanchored SCREAMING_SNAKE cannot be typed,
// so it now yields nothing unless it is in a closed list below.
const ERROR_CODE_PREFIXED_RE = /\b(?:ERR_[A-Z0-9_]+|SQLITE_[A-Z_]+|E_[A-Z0-9_]+)\b/g;
const ERROR_CODE_BAREWORD_RE = /\b[A-Z][A-Z_]{3,30}\b/g;

// gRPC canonical status codes — the bare-underscore error names common enough
// to be worth a closed list now that the generic branch is gone.
const GRPC_STATUS_NAMES = new Set([
  'CANCELLED',
  'UNKNOWN',
  'INVALID_ARGUMENT',
  'DEADLINE_EXCEEDED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION',
  'ABORTED',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED',
  'UNAVAILABLE',
  'DATA_LOSS',
  'UNAUTHENTICATED',
]);

// Env vars must be ANCHORED — `$VAR`, `${VAR}`, or `VAR=value`. Bare
// SCREAMING_SNAKE is deliberately not matched: it is indistinguishable from a
// constant or an error code, and guessing is what produced the bug above.
const ENV_VAR_SIGIL_RE = /\$\{?([A-Z][A-Z0-9_]{2,64})\}?/g;
const ENV_VAR_ASSIGN_RE = /\b([A-Z][A-Z0-9_]{2,64})=(?=\S)/g;

// RFC 9562 layout with the version/variant nibbles constrained.
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

// A SUBSET of systemd's unit suffixes. `.target`, `.path`, `.slice`, `.scope`
// and `.mount` are excluded despite being real units: they are also everyday
// property accessors (`event.target`, `array.slice`, `req.path`,
// `wrapper.mount`), which measured 8 false positives in 9 lines of ordinary
// code prose against 1 with this list.
const SYSTEMD_UNIT_RE =
  /(?<![a-z0-9._/-])[a-z0-9][a-z0-9:_.-]{0,64}\.(?:service|socket|timer|automount|device|swap)\b(?!\.[a-z0-9])/gi;

// Six hex pairs separated consistently by `:` or `-`. A clock time has three
// groups, so there is no prose shape to collide with.
const MAC_ADDRESS_RE = /\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b|\b[0-9a-f]{2}(?:-[0-9a-f]{2}){5}\b/gi;

// Ticket ids: JIRA-style `PROJ-123`, or GitHub-style `#123`. The denylist
// excludes standards references sharing the `WORD-digits` shape; `CVE` is
// there because `cve_id` owns that identifier.
const NON_TICKET_PREFIXES = new Set([
  'UTF',
  'ISO',
  'RFC',
  'IEEE',
  'ECMA',
  'ASCII',
  'HTTP',
  'HTML',
  'CVE',
]);
const TICKET_JIRA_RE = /\b([A-Z]{2,10})-(\d{1,6})\b/g;
const TICKET_HASH_RE = /#\d{1,6}\b/g;

// MITRE's own format. The literal `CVE-` prefix makes this collision-free.
const CVE_RE = /\bCVE-\d{4}-\d{4,7}\b/gi;

// IPv4 with each octet range-validated (0-255), which is what makes it safe
// against dotted version strings: a build number like `10.0.19041.1266` is
// rejected because `19041` exceeds 255. IPv6 is deliberately absent — its
// grammar is far looser and its precision has not been measured.
const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IP_ADDRESS_RE = new RegExp(
  `\\b${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}(?:\\/(?:3[0-2]|[12]?\\d))?\\b`,
  'g',
);

// Labels ending in a CLOSED suffix list, not general public-domain matching
// (which would need a public-suffix list to stay precise). These suffixes
// never appear as sentence-ending abbreviations, unlike a generic short TLD.
// Capped, unambiguous label group: the nested-quantifier form was quadratic (19s at 200KB).
const HOSTNAME_RE = new RegExp(
  `(?<![a-z0-9.-])(?:[a-z0-9][a-z0-9-]{0,62}\\.){1,10}(?:local|lan|home|internal|localdomain|arpa)\\b(?!\\.[a-z0-9])`,
  'gi',
);

/**
 * Order fixes only the sequence entities are reported in: collection is
 * per-rule and the budget is allocated per kind, so no rule masks another —
 * which the shipped budget, spent in this order, made untrue. Kinds sharing a
 * shape are separated by `accept`, never by order.
 */
export const EXTRACTOR_RULES: readonly ExtractorRule[] = [
  {
    kind: 'url',
    pattern: URL_RE,
    normalize: stripTrailingPunct,
    examples: [
      {
        text: 'see https://github.com/anthropics/claude-code/issues/282.',
        values: ['https://github.com/anthropics/claude-code/issues/282'],
      },
    ],
    rejects: ['just say github com slash something'],
  },
  {
    kind: 'path',
    pattern: PATH_RE,
    capture: 1,
    accept: (m) => {
      const v = stripTrailingPunct(m[1] ?? '');
      if (v.includes('/')) return true;
      // Membership is on the FIRST segment, so a listed dotfile may carry
      // further ones (`.env.example`) while `.length` and `.envelope` miss.
      const segments = v.slice(1).split('.');
      // An empty later segment means a doubled dot, which no filename has.
      if (segments.some((s) => s.length === 0)) return false;
      return DOTFILE_NAMES.has(segments[0] ?? '');
    },
    normalize: (raw) => {
      const v = stripTrailingPunct(
        raw
          .replace(/\\/g, '/')
          .replace(/\/{2,}/g, '/')
          .replace(/^\.\//, ''),
      );
      return v.length > 0 ? v : null;
    },
    examples: [
      {
        text: 'the bug is in apps/server/src/db/migrate.ts',
        values: ['apps/server/src/db/migrate.ts'],
      },
      { text: 'the slug lives in .rembric at the root', values: ['.rembric'] },
      { text: 'run ./scripts/prompt-search.sh to reproduce', values: ['scripts/prompt-search.sh'] },
      { text: 'edit infra/main.tf for the cluster', values: ['infra/main.tf'] },
      // A unit-like body before the terminal extension: the extension must win,
      // or the index stores `src/user.service`, an address that does not exist.
      { text: 'the provider lives in src/user.service.ts', values: ['src/user.service.ts'] },
      {
        text: 'the slug lives in .claude/settings.local.json',
        values: ['.claude/settings.local.json'],
      },
    ],
    rejects: ['a solution / an idea, or maybe both', 'the version is 3.14 exactly'],
  },
  {
    kind: 'ticket',
    pattern: TICKET_JIRA_RE,
    accept: (m) => !NON_TICKET_PREFIXES.has(m[1]!),
    normalize: (raw) => raw.toUpperCase(),
    examples: [{ text: 'tracked as PROJ-1234 in the backlog', values: ['PROJ-1234'] }],
    rejects: ['UTF-8 encoding, per ISO-8601 and RFC-822', 'patched CVE-2024-3094 upstream'],
  },
  {
    kind: 'ticket',
    pattern: TICKET_HASH_RE,
    normalize: (raw) => raw,
    examples: [{ text: 'fixed in #282 last week', values: ['#282'] }],
    rejects: ['this costs $100 for the item'],
  },
  {
    kind: 'error_code',
    pattern: ERROR_CODE_PREFIXED_RE,
    normalize: (raw) => raw.toUpperCase(),
    examples: [
      { text: 'threw ERR_MODULE_NOT_FOUND on boot', values: ['ERR_MODULE_NOT_FOUND'] },
      { text: 'dies with SQLITE_CANTOPEN unless chowned', values: ['SQLITE_CANTOPEN'] },
    ],
    rejects: [
      'HTML and IEEE and ECMA are just acronyms',
      'export DATABASE_URL before starting',
      'the constant MAX_RETRIES is 3',
    ],
  },
  {
    kind: 'error_code',
    pattern: ERROR_CODE_BAREWORD_RE,
    accept: (m) => ERRNO_NAMES.has(m[0]) || GRPC_STATUS_NAMES.has(m[0]),
    normalize: (raw) => raw.toUpperCase(),
    examples: [
      { text: 'the write failed with ENOENT', values: ['ENOENT'] },
      { text: 'the server returned PERMISSION_DENIED', values: ['PERMISSION_DENIED'] },
    ],
    rejects: [
      'An ERROR occurred while EITHER retrying or aborting; ENOUGH said',
      'export DATABASE_URL before starting',
      'the constant MAX_RETRIES is 3',
    ],
  },
  {
    kind: 'env_var',
    pattern: ENV_VAR_SIGIL_RE,
    capture: 1,
    normalize: (raw) => raw,
    examples: [
      { text: 'set $DATABASE_URL first', values: ['DATABASE_URL'] },
      { text: 'interpolate ${REMBRIC_TOKEN} in the compose file', values: ['REMBRIC_TOKEN'] },
    ],
    rejects: ['export DATABASE_URL before starting', 'the constant MAX_RETRIES is 3'],
  },
  {
    kind: 'env_var',
    pattern: ENV_VAR_ASSIGN_RE,
    capture: 1,
    normalize: (raw) => raw,
    examples: [
      { text: 'put NODE_ENV=production in the env file', values: ['NODE_ENV'] },
      { text: 'PUID=1000 and PGID=1000 in the compose', values: ['PUID', 'PGID'] },
    ],
    rejects: ['export DATABASE_URL before starting', 'the constant MAX_RETRIES is 3'],
  },
  {
    kind: 'uuid',
    pattern: UUID_RE,
    normalize: (raw) => raw.toLowerCase(),
    examples: [
      {
        text: 'the request id was 550e8400-e29b-41d4-a716-446655440000',
        values: ['550e8400-e29b-41d4-a716-446655440000'],
      },
    ],
    rejects: ['fixed in commit cfb5c04 yesterday', 'tracked as PROJ-1234'],
  },
  {
    kind: 'git_ref',
    pattern: GIT_REF_RE,
    accept: notUuidSegment,
    normalize: (raw) => raw.toLowerCase(),
    examples: [
      { text: 'fixed in commit cfb5c04 yesterday', values: ['cfb5c04'] },
      {
        text: 'landed as 6840d670c1a2b3d4e5f60718293a4b5c6d7e8f90',
        values: ['6840d670c1a2b3d4e5f60718293a4b5c6d7e8f90'],
      },
    ],
    // `accede1` (Spanish word + digit) DOES match: git's default short SHA is
    // 7 chars, so tightening to 8 would drop real refs. Accepted limitation.
    rejects: [
      'the word deface, defaced, and facade use only hex-like letters',
      'ABCdef1',
      'the request id was 550e8400-e29b-41d4-a716-446655440000',
    ],
  },
  {
    kind: 'cve_id',
    pattern: CVE_RE,
    normalize: (raw) => raw.toUpperCase(),
    examples: [{ text: 'affected by cve-2024-3094 in xz-utils', values: ['CVE-2024-3094'] }],
    rejects: ['see RFC-822 and ISO-8601'],
  },
  {
    kind: 'ip_address',
    pattern: IP_ADDRESS_RE,
    normalize: (raw) => raw,
    examples: [
      { text: 'the NAS is at 192.168.1.50 on the LAN', values: ['192.168.1.50'] },
      { text: 'the docker bridge uses 172.18.0.0/16', values: ['172.18.0.0/16'] },
    ],
    rejects: ['the value 999.1.1.1 is out of range', 'the OS build is 10.0.19041.1266'],
  },
  {
    kind: 'systemd_unit',
    pattern: SYSTEMD_UNIT_RE,
    normalize: (raw) => raw.toLowerCase(),
    examples: [
      { text: 'restart caddy.service after the change', values: ['caddy.service'] },
      { text: 'rembric-backup.timer runs nightly', values: ['rembric-backup.timer'] },
      { text: 'check docker.socket on the host', values: ['docker.socket'] },
    ],
    // `user.service` (Angular DI prose) still matches — a documented, accepted
    // ambiguity, the same class as `git_ref`'s `accede1`.
    rejects: [
      'the handler uses event.target for the click',
      'call array.slice(0, 10) before mapping',
      'req.path returns the relative route',
      'the component calls wrapper.mount() in the test',
      // A unit suffix inside a longer dotted name is not a unit.
      'the provider lives in src/user.service.ts',
    ],
  },
  {
    kind: 'mac_address',
    pattern: MAC_ADDRESS_RE,
    normalize: (raw) => raw.toLowerCase().replace(/-/g, ':'),
    examples: [
      { text: 'the DHCP reservation is de:ad:be:ef:00:01', values: ['de:ad:be:ef:00:01'] },
      { text: 'NIC 00-1A-2B-3C-4D-5E on the switch', values: ['00:1a:2b:3c:4d:5e'] },
    ],
    rejects: ['the job ran at 12:34:56 last night', 'a ratio of 3:1 is fine'],
  },
  {
    kind: 'hostname',
    pattern: HOSTNAME_RE,
    normalize: (raw) => raw.toLowerCase(),
    examples: [
      { text: 'ssh into nas.local to grab the logs', values: ['nas.local'] },
      { text: 'reach NAS.LOCAL from any device', values: ['nas.local'] },
    ],
    rejects: [
      'the nas local drive is full',
      'e.g. or i.e. or etc. are not hosts',
      // A suffix inside a longer dotted filename is not a host.
      'the slug lives in .claude/settings.local.json',
    ],
  },
];

/** Apply one rule to text, returning its normalized values in order. */
export function applyRule(rule: ExtractorRule, text: string, maxTokenChars = 300): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(rule.pattern)) {
    if (rule.accept && !rule.accept(m)) continue;
    const raw = m[rule.capture ?? 0] ?? m[0];
    if (raw.length === 0 || raw.length > maxTokenChars) continue;
    const value = rule.normalize(raw);
    if (value) out.push(value);
  }
  return out;
}
