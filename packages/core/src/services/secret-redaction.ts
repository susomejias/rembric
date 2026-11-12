import { sliceWithoutSplittingSurrogatePair } from './strings.js';

export const SECRET_KINDS = [
  'private_key',
  'jwt',
  'github_token',
  'gitlab_token',
  'anthropic_api_key',
  'openai_api_key',
  'aws_access_key_id',
  'slack_token',
  'stripe_secret_key',
  'google_api_key',
  'npm_token',
  'huggingface_token',
  'authorization_header',
  'url_password',
  'assigned_secret',
] as const;

export type SecretKind = (typeof SECRET_KINDS)[number];

export interface Redaction {
  kind: SecretKind;
  count: number;
}

export interface RedactionResult {
  text: string;
  redactions: Redaction[];
}

const PLACEHOLDER_MARK = '[REDACTED:';

export function redactionPlaceholder(kind: SecretKind): string {
  return `${PLACEHOLDER_MARK}${kind}]`;
}

interface Span {
  start: number;
  end: number;
}

interface Detector {
  kind: SecretKind;
  find: (text: string) => Iterable<Span>;
}

interface RegexDetectorOptions {
  accept?: (secret: string, match: RegExpExecArray, text: string, end: number) => boolean;
  trimTrailingPunctuation?: boolean;
}

function regexDetector(
  kind: SecretKind,
  pattern: RegExp,
  options: RegexDetectorOptions = {},
): Detector {
  return {
    kind,
    *find(text) {
      for (const match of text.matchAll(pattern)) {
        const indices = match.indices?.groups?.['secret'] ?? [
          match.index,
          match.index + match[0].length,
        ];
        const start = indices[0];
        let end = indices[1];
        if (options.trimTrailingPunctuation) {
          while (end > start && TRAILING_PUNCTUATION.has(text[end - 1]!)) end -= 1;
        }
        if (end <= start) continue;
        const secret = text.slice(start, end);
        if (options.accept && !options.accept(secret, match, text, end)) continue;
        yield { start, end };
      }
    },
  };
}

const TRAILING_PUNCTUATION = new Set(['.', ',', ':', '!', '?']);

const PEM_HEADER = /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY( BLOCK)?-----/g;
const PEM_BODY_TOKEN = /(?:\s|\\[nr])+([A-Za-z0-9+/=]{16,})/y;
const PEM_BODY_CHARSET = /^(?:[A-Za-z0-9+/=\s:,-]|\\[nr])*$/;
const PEM_KEY_RUN = /[A-Za-z0-9+/=]{40,}/;
const PEM_BODY_MAX = 16_384;

function* findPrivateKeys(text: string): Iterable<Span> {
  const nextEndByMarker = new Map<string, number>();
  let consumedTo = 0;
  for (const header of text.matchAll(PEM_HEADER)) {
    const start = header.index;
    if (start < consumedTo) continue;
    const headerEnd = start + header[0].length;
    const endMarker = `-----END ${header[1] ?? ''}PRIVATE KEY${header[2] ?? ''}-----`;
    let endIndex = nextEndByMarker.get(endMarker);
    if (endIndex === undefined || (endIndex !== -1 && endIndex < headerEnd)) {
      endIndex = text.indexOf(endMarker, headerEnd);
      nextEndByMarker.set(endMarker, endIndex);
    }
    if (endIndex !== -1 && endIndex - headerEnd <= PEM_BODY_MAX) {
      const body = text.slice(headerEnd, endIndex);
      if (PEM_BODY_CHARSET.test(body) && PEM_KEY_RUN.test(body)) {
        consumedTo = endIndex + endMarker.length;
        yield { start, end: consumedTo };
      }
      continue;
    }
    let end = headerEnd;
    let sawKeyRun = false;
    PEM_BODY_TOKEN.lastIndex = headerEnd;
    for (let token = PEM_BODY_TOKEN.exec(text); token; token = PEM_BODY_TOKEN.exec(text)) {
      end = PEM_BODY_TOKEN.lastIndex;
      if ((token[1] ?? '').length >= 40) sawKeyRun = true;
    }
    if (sawKeyRun) {
      consumedTo = end;
      yield { start, end };
    }
  }
}

const PROVIDER_PLACEHOLDER = /(.)\1{5,}|example|placeholder|redacted|your[-_]/i;

function providerDetector(kind: SecretKind, pattern: RegExp): Detector {
  return regexDetector(kind, pattern, { accept: (secret) => !PROVIDER_PLACEHOLDER.test(secret) });
}

const PLACEHOLDER_HINT =
  /example|placeholder|your|redacted|changeme|change[-_]me|dummy|sample|xxx|replace[-_]?me|insert[-_]?here/i;
const REFERENCE_START = /^[$%<{[(@*~/.#]/;
const TEMPLATE_MARK = /\.\.\.|…|\$\{|\{\{|\}\}/;
const SINGLE_REPEATED_CHAR = /^(.)\1*$/;
const DIGITS_ONLY = /^\d+$/;

function isPlaceholderValue(value: string): boolean {
  return (
    REFERENCE_START.test(value) ||
    TEMPLATE_MARK.test(value) ||
    SINGLE_REPEATED_CHAR.test(value) ||
    PLACEHOLDER_HINT.test(value)
  );
}

const ASSIGNED_MIN_LENGTH = 8;
const LITERAL_WORD = /^(?:true|false|null|none|nil|undefined|yes|no|on|off)$/i;
const DOTTED_REFERENCE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const FILE_LIKE = /\.(?:pem|key|crt|cer|der|p12|pfx|jks|json|ya?ml|toml|txt|env|ini|conf)$/i;
const URL_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const CREDENTIAL_WORD_VALUE = /^(?:password|passwd|passphrase|secret|token|apikey|api[-_]key)s?$/i;

function isPlausibleAssignedValue(value: string): boolean {
  return (
    value.length >= ASSIGNED_MIN_LENGTH &&
    !isPlaceholderValue(value) &&
    !DIGITS_ONLY.test(value) &&
    !LITERAL_WORD.test(value) &&
    !DOTTED_REFERENCE.test(value) &&
    !FILE_LIKE.test(value) &&
    !URL_LIKE.test(value) &&
    !CREDENTIAL_WORD_VALUE.test(value)
  );
}

const CREDENTIAL_WORD_SUFFIXES = ['password', 'passwd', 'passphrase', 'secret', 'apikey'];
const CREDENTIAL_WORDS = new Set(['token', 'pat', 'credential', 'credentials']);
const CREDENTIAL_WORD_PAIRS = new Set([
  'api key',
  'access key',
  'secret key',
  'private key',
  'signing key',
  'encryption key',
  'master key',
  'account key',
]);
const NON_SECRET_TOKEN_QUALIFIERS = new Set([
  'page',
  'next',
  'prev',
  'previous',
  'continuation',
  'cancellation',
  'sync',
  'resume',
  'cursor',
  'eos',
  'bos',
  'pad',
  'unk',
  'sep',
  'cls',
  'mask',
]);

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

function isCredentialKey(key: string): boolean {
  const words = keyWords(key);
  const last = words.at(-1);
  if (last === undefined) return false;
  const previous = words.at(-2);
  if (CREDENTIAL_WORD_SUFFIXES.some((suffix) => last.endsWith(suffix))) return true;
  if (CREDENTIAL_WORDS.has(last)) {
    return !(
      last === 'token' &&
      previous !== undefined &&
      NON_SECRET_TOKEN_QUALIFIERS.has(previous)
    );
  }
  if (previous !== undefined && CREDENTIAL_WORD_PAIRS.has(`${previous} ${last}`)) return true;
  return words.slice(-3).join(' ') === 'secret key base';
}

function acceptAssigned(
  secret: string,
  match: RegExpExecArray,
  text: string,
  end: number,
): boolean {
  const key = match.groups?.['key'] ?? '';
  return isCredentialKey(key) && isPlausibleAssignedValue(secret) && text[end] !== '(';
}

const URL_PASSWORD_WORD = /^(?:password|passwd|pass|pwd|pw|secret)$/i;
const URL_PASSWORD_MIN_LENGTH = 3;

function acceptUrlPassword(secret: string, match: RegExpExecArray): boolean {
  return (
    secret.length >= URL_PASSWORD_MIN_LENGTH &&
    secret !== match.groups?.['user'] &&
    !isPlaceholderValue(secret) &&
    !DIGITS_ONLY.test(secret) &&
    !URL_PASSWORD_WORD.test(secret)
  );
}

const DETECTORS: readonly Detector[] = [
  { kind: 'private_key', find: findPrivateKeys },
  regexDetector(
    'jwt',
    /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/dg,
  ),
  providerDetector(
    'github_token',
    /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/dg,
  ),
  providerDetector('gitlab_token', /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}/dg),
  providerDetector(
    'anthropic_api_key',
    /(?<![A-Za-z0-9_-])sk-ant-[a-z]{2,10}\d{2}-[A-Za-z0-9_-]{20,}/dg,
  ),
  providerDetector(
    'openai_api_key',
    /(?<![A-Za-z0-9_-])sk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20})(?![A-Za-z0-9_-])/dg,
  ),
  providerDetector(
    'aws_access_key_id',
    /(?<![A-Za-z0-9])(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}(?![A-Za-z0-9])/dg,
  ),
  providerDetector('slack_token', /(?<![A-Za-z0-9_-])xox[abposr]-[A-Za-z0-9-]{10,}/dg),
  providerDetector(
    'stripe_secret_key',
    /(?<![A-Za-z0-9_])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}/dg,
  ),
  providerDetector('google_api_key', /(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/dg),
  providerDetector('npm_token', /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/dg),
  providerDetector('huggingface_token', /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{34,40}(?![A-Za-z0-9])/dg),
  regexDetector(
    'authorization_header',
    /(?<![A-Za-z0-9-])(?:proxy-)?authorization["']?\s{0,8}[:=]\s{0,8}["']?(?:bearer|basic|token|bot)\s{1,8}(?<secret>[A-Za-z0-9._~+/=-]{16,})/dgi,
    { accept: (secret) => !isPlaceholderValue(secret) },
  ),
  regexDetector(
    'url_password',
    /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{1,30}:\/\/(?<user>[^\s:@/?#'"`<>[\]]{0,128}):(?<secret>[^\s@/?#'"`<>]{1,256})@(?=[A-Za-z0-9[])/dg,
    { accept: acceptUrlPassword },
  ),
  regexDetector(
    'assigned_secret',
    /(?<![\w$-])(?<quote>["']?)(?<key>[A-Za-z_][\w.-]{0,63})\k<quote>\s{0,8}[:=]\s{0,8}(?<valueQuote>["'])(?<secret>[^\s"'`\\]{1,512})\k<valueQuote>/dg,
    { accept: acceptAssigned },
  ),
  regexDetector(
    'assigned_secret',
    /(?<![\w$./-])(?<key>[A-Z][A-Z0-9_]{0,63})=(?<secret>[^\s"'`<>()[\]{},;&|\\]{1,512})/dg,
    { accept: acceptAssigned, trimTrailingPunctuation: true },
  ),
  regexDetector(
    'assigned_secret',
    /(?:(?<![\w-])--|[?&;])(?<key>[A-Za-z][\w.-]{0,63})=(?<secret>[^\s"'`<>()[\]{},;&|#\\]{1,512})/dg,
    { accept: acceptAssigned, trimTrailingPunctuation: true },
  ),
];

function applyDetector(text: string, detector: Detector, counts: Map<SecretKind, number>): string {
  let out = '';
  let cursor = 0;
  let replaced = 0;
  for (const { start, end } of detector.find(text)) {
    if (start < cursor || text.slice(start, end).includes(PLACEHOLDER_MARK)) continue;
    out += text.slice(cursor, start) + redactionPlaceholder(detector.kind);
    cursor = end;
    replaced += 1;
  }
  if (replaced === 0) return text;
  counts.set(detector.kind, (counts.get(detector.kind) ?? 0) + replaced);
  return out + text.slice(cursor);
}

export class RedactionTally {
  private readonly counts = new Map<SecretKind, number>();

  redact(text: string): string {
    let out = text;
    for (const detector of DETECTORS) out = applyDetector(out, detector, this.counts);
    return out;
  }

  redactWithin(text: string, maxLength: number): string {
    const out = this.redact(text);
    return out.length > maxLength ? sliceWithoutSplittingSurrogatePair(out, maxLength) : out;
  }

  redactJson(value: unknown): unknown {
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map((item) => this.redactJson(item));
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.redactJson(item)]),
      );
    }
    return value;
  }

  list(): Redaction[] {
    return SECRET_KINDS.flatMap((kind) => {
      const count = this.counts.get(kind);
      return count === undefined ? [] : [{ kind, count }];
    });
  }
}

export function redactSecrets(text: string): RedactionResult {
  const tally = new RedactionTally();
  const redacted = tally.redact(text);
  return { text: redacted, redactions: tally.list() };
}
