import { describe, expect, it } from 'vitest';

import {
  BASE64URL,
  DIGITS,
  fakeChars as fake,
  fakeJwt,
  fakePemBlock as pemBlock,
  LETTERS,
  UPPER_DIGITS,
} from '../test-support/fake-secrets.js';

import { extractEntities } from './entities.js';
import {
  RedactionTally,
  redactionPlaceholder,
  redactSecrets,
  SECRET_KINDS,
  type SecretKind,
} from './secret-redaction.js';

const JWT = fakeJwt(7);

interface PositiveFixture {
  secret: string;
  text: (secret: string) => string;
}

const POSITIVE: Record<SecretKind, PositiveFixture> = {
  private_key: {
    secret: pemBlock('RSA PRIVATE KEY', 1),
    text: (s) => `Deploy key for the staging box:\n${s}\nRotate it after the migration.`,
  },
  jwt: {
    secret: JWT,
    text: (s) => `The id_token in the callback was ${s} when it expired.`,
  },
  github_token: {
    secret: `ghp_${fake(36, 11)}`,
    text: (s) => `CI failed until I exported GH_TOKEN=${s} in the runner.`,
  },
  gitlab_token: {
    secret: `glpat-${fake(20, 12, BASE64URL)}`,
    text: (s) => `git clone with the personal token ${s} works`,
  },
  anthropic_api_key: {
    secret: `sk-ant-api03-${fake(93, 13, BASE64URL)}AA`,
    text: (s) => `Smoke test used the key ${s} against the API.`,
  },
  openai_api_key: {
    secret: `sk-proj-${fake(48, 14, BASE64URL)}`,
    text: (s) => `client configured with ${s} for embeddings`,
  },
  aws_access_key_id: {
    secret: `AKIA${fake(16, 15, UPPER_DIGITS)}`,
    text: (s) => `The bucket policy denied the access key ${s} yesterday.`,
  },
  slack_token: {
    secret: `xoxb-${fake(12, 16, DIGITS)}-${fake(13, 17, DIGITS)}-${fake(24, 18)}`,
    text: (s) => `The bot posts with ${s} to #deploys.`,
  },
  stripe_secret_key: {
    secret: `sk_live_${fake(24, 19)}`,
    text: (s) => `Webhook replay needed the live key ${s} temporarily.`,
  },
  google_api_key: {
    secret: `AIza${fake(35, 20, BASE64URL)}`,
    text: (s) => `Maps stopped rendering after ${s} hit its quota.`,
  },
  npm_token: {
    secret: `npm_${fake(36, 21)}`,
    text: (s) => `//registry.npmjs.org/:_authToken ${s}`,
  },
  huggingface_token: {
    secret: `hf_${fake(34, 22, LETTERS)}`,
    text: (s) => `Downloading the gated model requires ${s} in the env.`,
  },
  authorization_header: {
    secret: fake(43, 23, BASE64URL),
    text: (s) => `curl -H "Authorization: Bearer ${s}" https://memory.internal/healthz`,
  },
  url_password: {
    secret: fake(16, 24),
    text: (s) => `DATABASE_URL=postgres://app:${s}@db.internal:5432/app`,
  },
  assigned_secret: {
    secret: fake(24, 25),
    text: (s) => `Added DB_PASSWORD=${s} to .env.production and restarted.`,
  },
};

describe('redactSecrets — one positive fixture per kind', () => {
  it('declares a fixture for every kind', () => {
    expect(Object.keys(POSITIVE).sort()).toEqual([...SECRET_KINDS].sort());
  });

  it.each(SECRET_KINDS)('redacts %s', (kind) => {
    const fixture = POSITIVE[kind];
    const input = fixture.text(fixture.secret);
    const { text, redactions } = redactSecrets(input);
    expect(text).not.toContain(fixture.secret);
    expect(text.split(redactionPlaceholder(kind)).length - 1).toBe(1);
    expect(redactions).toEqual([{ kind, count: 1 }]);
  });
});

describe('redactSecrets — span and structure', () => {
  it('keeps the URL around a redacted password', () => {
    const password = fake(16, 31);
    expect(redactSecrets(`postgres://app:${password}@db:5432/x`).text).toBe(
      'postgres://app:[REDACTED:url_password]@db:5432/x',
    );
  });

  it('keeps the header scheme around a redacted credential', () => {
    const token = fake(40, 32);
    expect(redactSecrets(`Authorization: Bearer ${token}`).text).toBe(
      'Authorization: Bearer [REDACTED:authorization_header]',
    );
  });

  it('redacts every assignment form and keeps the key', () => {
    const v = fake(20, 33);
    const cases: [string, string][] = [
      [`export API_KEY=${v}`, 'export API_KEY=[REDACTED:assigned_secret]'],
      [`--password=${v} --verbose`, '--password=[REDACTED:assigned_secret] --verbose'],
      [
        `GET /v1/me?access_token=${v}&x=1`,
        'GET /v1/me?access_token=[REDACTED:assigned_secret]&x=1',
      ],
      [`{"apiKey": "${v}"}`, '{"apiKey": "[REDACTED:assigned_secret]"}'],
      [`client_secret = '${v}'`, "client_secret = '[REDACTED:assigned_secret]'"],
      [
        `spring.datasource.password="${v}"`,
        'spring.datasource.password="[REDACTED:assigned_secret]"',
      ],
      [`PGPASSWORD=${v} psql`, 'PGPASSWORD=[REDACTED:assigned_secret] psql'],
      [`set SECRET_KEY_BASE=${v}.`, 'set SECRET_KEY_BASE=[REDACTED:assigned_secret].'],
    ];
    for (const [input, expected] of cases) expect(redactSecrets(input).text).toBe(expected);
  });

  it('redacts a private key whose END line is missing', () => {
    const block = pemBlock('PRIVATE KEY', 34);
    const truncated = block.slice(0, block.indexOf('-----END'));
    const { text, redactions } = redactSecrets(`key:\n${truncated}`);
    expect(text).toBe('key:\n[REDACTED:private_key]\n');
    expect(redactions).toEqual([{ kind: 'private_key', count: 1 }]);
  });

  it('redacts a private key embedded in a JSON string with escaped newlines', () => {
    const block = pemBlock('PRIVATE KEY', 35).replaceAll('\n', '\\n');
    const { text } = redactSecrets(`{"type":"service_account","private_key":"${block}\\n"}`);
    expect(text).toBe('{"type":"service_account","private_key":"[REDACTED:private_key]\\n"}');
  });

  it('counts a provider token inside an assignment once, under its provider kind', () => {
    const token = `ghp_${fake(36, 36)}`;
    const { text, redactions } = redactSecrets(`GITHUB_TOKEN=${token}`);
    expect(text).toBe('GITHUB_TOKEN=[REDACTED:github_token]');
    expect(redactions).toEqual([{ kind: 'github_token', count: 1 }]);
  });

  it('counts repeated occurrences and reports kinds in detector order', () => {
    const token = `ghp_${fake(36, 37)}`;
    const input = `${token} then ${JWT} then ${token} and ${pemBlock('EC PRIVATE KEY', 38)}`;
    expect(redactSecrets(input).redactions).toEqual([
      { kind: 'private_key', count: 1 },
      { kind: 'jwt', count: 1 },
      { kind: 'github_token', count: 2 },
    ]);
  });

  it('leaves nothing for entity extraction to index', () => {
    const placeholders = SECRET_KINDS.map(
      (kind) =>
        `x ${redactionPlaceholder(kind)} y postgres://app:${redactionPlaceholder(kind)}@db/x`,
    );
    expect(extractEntities('title', placeholders.join('\n'))).toEqual([]);
  });

  it('is idempotent', () => {
    for (const kind of SECRET_KINDS) {
      const fixture = POSITIVE[kind];
      const once = redactSecrets(fixture.text(fixture.secret)).text;
      expect(redactSecrets(once)).toEqual({ text: once, redactions: [] });
    }
  });
});

describe('RedactionTally', () => {
  it('aggregates across fields', () => {
    const tally = new RedactionTally();
    tally.redact(`token ghp_${fake(36, 41)}`);
    tally.redact(`and ghp_${fake(36, 42)} plus ${JWT}`);
    expect(tally.list()).toEqual([
      { kind: 'jwt', count: 1 },
      { kind: 'github_token', count: 2 },
    ]);
  });

  it('redacts every string inside JSON at any depth and keeps the rest', () => {
    const tally = new RedactionTally();
    const token = `ghp_${fake(36, 43)}`;
    const out = tally.redactJson({
      n: 1,
      ok: true,
      none: null,
      list: [token, { deep: `x ${token}` }],
    });
    expect(out).toEqual({
      n: 1,
      ok: true,
      none: null,
      list: ['[REDACTED:github_token]', { deep: 'x [REDACTED:github_token]' }],
    });
    expect(tally.list()).toEqual([{ kind: 'github_token', count: 2 }]);
  });

  it('cuts a value lengthened past its cap and never keeps the secret', () => {
    const title = `${'a'.repeat(80)} password="hunter22"`;
    expect(title).toHaveLength(100);
    const out = new RedactionTally().redactWithin(title, 100);
    expect(out).toHaveLength(100);
    expect(out).not.toContain('hunter22');
  });
});

const FALSE_POSITIVE_CORPUS: readonly string[] = [
  'Fixed in 3ffdd4b3e1f0a2c5d6b7a8e9f0c1d2e3f4a5b6c7; see 19bc5d2a and 203e3cfd for context.',
  'session bfabf2ad-08e5-4026-86eb-740bbb4991c1 started at 15:42 UTC',
  'memory 01M6KD3S9BA8E794V10KNP99GE superseded 01M6KD3RYFKR361KZ6QX71QQFN',
  'sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 matched the artifact',
  'integrity: sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==',
  'const blob = "SGVsbG8sIFdvcmxkISBUaGlzIGlzIGEgYmFzZTY0IHRlc3QgZml4dHVyZS4=";',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'OpenAI keys look like sk-... and Anthropic keys like sk-ant-...; never paste them.',
  'GitHub classic tokens start with ghp_ and fine-grained ones with github_pat_.',
  'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx is the placeholder in the README',
  'Use xoxb-your-bot-token from the Slack app settings.',
  'sk_test_... keys only work in Stripe test mode',
  'hf_hub_download(repo_id="org/model", filename="config.json")',
  'curl -H "Authorization: Bearer <token>" http://127.0.0.1:8787/healthz',
  'curl -sS -H "Authorization: Bearer $REMBRIC_ADMIN_TOKEN" http://127.0.0.1:8787/healthz',
  'fetch(url, { headers: { Authorization: `Bearer ${token}` } })',
  'Authorization: Basic dXNlcjpwYXNz',
  'Bearer tokens are sent in the Authorization header.',
  'export GITHUB_TOKEN=$GITHUB_TOKEN',
  'API_KEY=${API_KEY} pnpm run dev',
  'GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }}',
  'Set GITHUB_TOKEN in the repository secrets, then reference ${{ secrets.GITHUB_TOKEN }}.',
  'docker run -e POSTGRES_PASSWORD=$POSTGRES_PASSWORD postgres:16',
  'REMBRIC_TOKEN=<your token>',
  'REMBRIC_TOKEN=your-token-here',
  'API_KEY=changeme',
  'SECRET=xxxxxxxxxxxxxxxx',
  'TOKEN=********',
  'API_TOKEN=sk-...',
  'The AWS docs use AKIAIOSFODNN7EXAMPLE with wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY as sample credentials.',
  'ACCESS_KEY_ID=AKIA...',
  'connect with postgres://user:password@localhost:5432/app',
  'postgres://postgres:postgres@localhost:5432/postgres and amqp://guest:guest@rabbit:5672',
  'redis://localhost:6379/0',
  'http://localhost:8080@internal is a phishing-shaped URL, and http://u:8080@host too',
  'git clone git@github.com:susomejias/rembric.git',
  'ssh://git@github.com/org/repo.git',
  'see https://github.com/susomejias/rembric/issues/447#issuecomment-1',
  'email jane.doe@example.com or http://[::1]:8787/mcp',
  'SENTRY_DSN=https://public@o0.ingest.sentry.io/0',
  'model.generate(prompt, max_tokens=1024, temperature=0.2)',
  'MAX_TOKENS=4096',
  'TOKEN_TTL=3600',
  'PASSWORD_MIN_LENGTH=12',
  'GET /v1/items?page_token=CAESBgoEQUJDRA&limit=50',
  'aws ec2 describe-instances --page-token=AAAAAgAAAAEAAAAB',
  'client = OpenAI(api_key=api_key)',
  'client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])',
  'apiKey: process.env.OPENAI_API_KEY,',
  'TOKEN=process.env.REMBRIC_TOKEN',
  'const token = await getToken();',
  'password: string;',
  'token: z.string().min(1),',
  'tokenizer = AutoTokenizer.from_pretrained(name, eos_token="</s>", pad_token="<pad>")',
  'topic_key=auth/token-rotation-contract',
  'tokenId: "01KRM6225F1KM666HJBRNQE4Y2"',
  'sessionId="bfabf2ad-08e5-4026-86eb-740bbb4991c1"',
  'token_hash = "scrypt$16384$c2FsdHNhbHQ$aGFzaGhhc2g"',
  'passwordHash: "$2b$10$abcdefghijklmnopqrstuv"',
  'ENCRYPTION_KEY_ID=key-2026-11',
  'secret_name: "prod/db"',
  'cookie rembric_session and column dashboard_sessions.csrf_secret',
  '<input type="password" name="password" autocomplete="current-password">',
  'label: "API key", placeholder: "sk-..."',
  'password = "password"',
  'NODE_OPTIONS=--max-old-space-size=4096',
  'DATABASE_URL=file:./data/data.db',
  'SSL_PRIVATE_KEY=/etc/ssl/private/server.key',
  'GOOGLE_APPLICATION_CREDENTIALS=./service-account.json',
  'SECRET_KEY_BASE is generated by bin/rails secret',
  'https://example.com/callback?code=SplxlOBeZQQYbYS6WxSbIA&state=xyz',
  '-----BEGIN PRIVATE KEY----- is the PKCS#8 header line.',
  'Example PEM:\n-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----',
  pemBlock('PUBLIC KEY', 51),
  pemBlock('CERTIFICATE', 52),
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl user@host',
  'a JWT has three parts: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.<signature>',
  'tokens.project_id SHALL be NULL for `*` tokens',
  '`memory.save` returns `{ id, candidates[] }` and judgmentRequired',
  'export PATH=$HOME/.local/bin:$PATH',
];

describe('redactSecrets — false-positive corpus', () => {
  it.each(FALSE_POSITIVE_CORPUS.map((entry) => [entry]))('leaves %j unchanged', (entry) => {
    expect(redactSecrets(entry)).toEqual({ text: entry, redactions: [] });
  });
});

describe('redactSecrets — linear on pathological input', () => {
  const SIZE = 200_000;
  const repeat = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length));
  const inputs: [string, string][] = [
    ['PEM headers without END', repeat('-----BEGIN PRIVATE KEY-----\n')],
    [
      'PEM headers with a far END',
      `${repeat('-----BEGIN PRIVATE KEY-----\n')}-----END PRIVATE KEY-----`,
    ],
    ['token-class run', repeat('a')],
    ['JWT-prefix run', repeat('eyJ')],
    ['provider-prefix run', repeat('ghp_')],
    ['assignment chain', repeat('A=')],
    ['flag chain', repeat('--a=')],
    ['scheme chain', repeat('a://')],
    ['url userinfo chain', `x://${repeat('a:')}`],
    ['quoted key chain', repeat('"password": ')],
    ['dotted key chain', repeat('a.')],
    ['authorization chain', repeat('Authorization: Bearer ')],
  ];

  it.each(inputs)('%s', (_label, input) => {
    expect(redactSecrets(input).text.length).toBeGreaterThan(0);
  });
});
