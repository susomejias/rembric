/**
 * Deterministic entity extraction — no LLM, no model, no network I/O.
 *
 * Recognises only high-confidence syntax: file paths, git refs (commit
 * SHAs), URLs, error codes, and ticket-style ids. Symbol identifiers and
 * package names are deliberately deferred (design.md's open question 1) —
 * both need more context than a regex has to disambiguate from prose.
 *
 * Precision over recall is the deliberate bar here (design.md Decision 2):
 * a false entity link degrades exact lookup into bad text search, which is
 * worse than missing a real one. Every pattern below is written to be
 * conservative rather than clever; extend kinds later once this is proven
 * on real memory text, tighten a pattern if it pollutes the index, and
 * rebuild — never loosen defensively "just in case".
 */

import type { EntityKind } from '../db/schema/entities.js';

export interface ExtractedEntity {
  kind: EntityKind;
  /** Normalized so the same referent always yields the same key. */
  value: string;
}

const MAX_INPUT_CHARS = 200_000;
const MAX_TOKEN_CHARS = 300;

// A file path: at least one `/` and a recognized code/config extension, or
// a dotfile-led relative path (`.rembric`, `./scripts/x.sh`). Requiring an
// extension (or a leading dot) is what keeps prose like "a solution / an
// idea" or version numbers like "3.14" from matching.
const PATH_EXT =
  'ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|php|java|kt|swift|c|cc|cpp|h|hpp|sh|bash|zsh|' +
  'sql|json|yaml|yml|md|mdx|toml|ini|cfg|conf|env|css|scss|html|xml|proto|graphql|lock';
const PATH_RE = new RegExp(
  `(?:^|[\\s"'(\`])((?:\\.{1,2}\\/)?(?:[A-Za-z0-9_.-]+\\/)+[A-Za-z0-9_-]+\\.(?:${PATH_EXT})|\\.[A-Za-z][A-Za-z0-9_.-]{2,40})(?=[\\s"'),.:;!?\`]|$)`,
  'g',
);

// A git SHA: 7-40 hex chars, requiring BOTH a letter (a-f) and a digit — a
// real commit SHA is essentially always a letter/digit mix, while requiring
// both is what excludes the rare all-letter English word that happens to
// use only a-f ("defaced" is 7 hex-valid letters with no digit).
const GIT_REF_RE = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}\b/g;

const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/g;

// A closed whitelist of POSIX/libuv errno names — not a generic `E`-prefix
// regex, which would also match plain-English all-caps words ("ERROR",
// "EITHER", "EXTRA"). ERR_*/SQLITE_* and a generic underscored constant are
// still regex-matched below since the underscore itself is what makes those
// safe: prose essentially never contains a bare SCREAMING_SNAKE token.
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
// The `ERR_*`/`SQLITE_*`/underscored family is regex-safe on its own — the
// underscore requirement is what excludes plain-English words. Bare all-caps
// words (no underscore) are only accepted against the `ERRNO_NAMES`
// whitelist below, never by shape alone.
const ERROR_CODE_UNDERSCORED_RE =
  /\b(?:ERR_[A-Z0-9_]+|SQLITE_[A-Z_]+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g;
const ERROR_CODE_BAREWORD_RE = /\b[A-Z]{4,15}\b/g;

// Ticket ids: JIRA-style `PROJ-123`, or GitHub-style `#123`. The prefix
// denylist excludes standards/encoding references (`UTF-8`, `ISO-8601`,
// `RFC-822`) that share the same `WORD-digits` shape but are not tickets.
const NON_TICKET_PREFIXES = new Set(['UTF', 'ISO', 'RFC', 'IEEE', 'ECMA', 'ASCII', 'HTTP', 'HTML']);
const TICKET_JIRA_RE = /\b([A-Z]{2,10})-(\d{1,6})\b/g;
const TICKET_HASH_RE = /#\d{1,6}\b/g;

export function extractEntities(title: string, content: string): ExtractedEntity[] {
  const text = `${title}\n\n${content}`.slice(0, MAX_INPUT_CHARS);
  const seen = new Set<string>();
  const out: ExtractedEntity[] = [];

  const add = (kind: EntityKind, raw: string): void => {
    if (raw.length === 0 || raw.length > MAX_TOKEN_CHARS) return;
    const value = normalize(kind, raw);
    if (!value) return;
    const key = `${kind}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, value });
  };

  for (const m of text.matchAll(URL_RE)) add('url', m[0]);
  for (const m of text.matchAll(PATH_RE)) add('path', m[1] ?? m[0]);
  for (const m of text.matchAll(TICKET_JIRA_RE)) {
    if (!NON_TICKET_PREFIXES.has(m[1]!)) add('ticket', m[0]);
  }
  for (const m of text.matchAll(TICKET_HASH_RE)) add('ticket', m[0]);
  for (const m of text.matchAll(ERROR_CODE_UNDERSCORED_RE)) add('error_code', m[0]);
  for (const m of text.matchAll(ERROR_CODE_BAREWORD_RE)) {
    if (ERRNO_NAMES.has(m[0])) add('error_code', m[0]);
  }
  for (const m of text.matchAll(GIT_REF_RE)) add('git_ref', m[0]);

  return out;
}

const TRAILING_PUNCT_RE = /[.,;:!?)'"`]+$/;
function stripTrailingPunct(s: string): string {
  return s.replace(TRAILING_PUNCT_RE, '');
}

function normalize(kind: EntityKind, raw: string): string | null {
  switch (kind) {
    case 'path': {
      let v = raw.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
      v = v.replace(/^\.\//, '');
      v = stripTrailingPunct(v);
      return v.length > 0 ? v : null;
    }
    case 'url':
      return stripTrailingPunct(raw);
    case 'git_ref':
      return raw.toLowerCase();
    case 'error_code':
      return raw.toUpperCase();
    case 'ticket':
      return raw.startsWith('#') ? raw : raw.toUpperCase();
  }
}
