import {
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  scryptSync,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

import { ulid } from 'ulid';

import type { Repositories } from '../db/repositories/index.js';
import { type Token } from '../db/schema/tokens.js';

import { DomainError } from './errors.js';

/**
 * Bearer-token authn/z service.
 *
 * Plaintext tokens are high-entropy (32 random bytes ≈ 256 bits) and never
 * persisted. We store a scrypt-derived hash with a per-token salt; matching
 * is by linear scan + constant-time compare. For realistic deployments
 * (< 100 tokens) the O(tokens) scan is fast; the actual cost is scrypt's
 * fixed ~20ms-per-verify KDF work, paid on every authenticated request
 * regardless of token count (every MCP tool call and `/api` request
 * re-authenticates — see `server/auth.ts`). `authenticate` caches the
 * (fast-hashed) plaintext → token id mapping after a successful scrypt
 * verify so a repeat caller skips the KDF; revocation/expiry are always
 * re-checked against a fresh row read on a cache hit, so revoking a token
 * still takes effect on its very next request regardless of cache state —
 * the cache only ever skips the *hashing*, never the authorization check.
 *
 * Scope grammar:
 *   - `*`                       → full access (admin)
 *   - `read:*`                  → read across all scopes
 *   - `project:<id>`            → write to that single project
 *   - `read:project:<id>`       → read that single project
 */

const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1, keylen: 64 } as const;
const HASH_VERSION = 's1';
const TOKEN_BYTES = 32;
/** Bound on the verified-credential cache; oldest entry evicted past this. */
const VERIFIED_CACHE_MAX = 64;

export type TokenScope = '*' | 'read:*' | `project:${string}` | `read:project:${string}`;

export interface CreateTokenInput {
  name: string;
  scope: TokenScope;
  projectId?: string | null;
  expiresAt?: Date | null;
}

export interface CreatedToken {
  /** The plaintext secret. Shown to the operator exactly once. */
  plaintext: string;
  /** The persisted row, minus the secret. */
  token: Token;
}

export interface ResolvedToken {
  token: Token;
  scope: TokenScope;
}

export class TokensService {
  /** sha256(plaintext) hex → token id, for successfully scrypt-verified tokens. */
  private readonly verifiedCache = new Map<string, string>();

  constructor(
    private readonly repos: Pick<Repositories, 'tokens'>,
    private readonly now: () => Date = () => new Date(),
    /** Injectable for tests; production callers use the default bound. */
    private readonly verifiedCacheMax: number = VERIFIED_CACHE_MAX,
  ) {}

  count(): number {
    return this.repos.tokens.count();
  }

  create(input: CreateTokenInput): CreatedToken {
    if (input.name.trim().length === 0) {
      throw new DomainError('invalid_input', 'tokens.create: name must be non-empty');
    }
    if (this.findByName(input.name)) {
      throw new DomainError('conflict', `tokens.create: name '${input.name}' already exists`);
    }
    const plaintext = generatePlaintextToken();
    const hash = hashToken(plaintext);
    const ts = this.now();
    const row = this.repos.tokens.insert({
      id: ulid(ts.getTime()),
      name: input.name,
      hash,
      scope: input.scope,
      projectId: input.projectId ?? null,
      createdAt: ts,
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
    });
    if (!row) throw new DomainError('conflict', 'tokens.create: insert did not return a row');
    return { plaintext, token: row };
  }

  list(): Token[] {
    return this.repos.tokens.listAll();
  }

  findByName(name: string): Token | undefined {
    return this.repos.tokens.findByName(name);
  }

  findById(id: string): Token | undefined {
    return this.repos.tokens.findById(id);
  }

  revoke(name: string): void {
    const changes = this.repos.tokens.revokeByName(name, this.now());
    if (changes === 0) {
      throw new DomainError(
        'token_not_found',
        `tokens.revoke: '${name}' not found or already revoked`,
      );
    }
  }

  /**
   * Look up a token by its plaintext bearer secret. Returns the matching
   * row if (a) the hash verifies, (b) it is not revoked, and (c) it has
   * not expired.
   *
   * Async so the scrypt work runs on the libuv threadpool rather than
   * blocking the single Node event loop — repeated failed attempts are
   * additionally throttled by the pre-auth lockout (see `AuthLockout`).
   */
  async authenticate(plaintext: string): Promise<ResolvedToken> {
    const cacheKey = createHash('sha256').update(plaintext).digest('hex');
    const cachedId = this.verifiedCache.get(cacheKey);
    if (cachedId !== undefined) {
      const row = this.repos.tokens.findById(cachedId);
      // A cache hit only ever skips the scrypt verify, never the
      // authorization check: revoked/expired/missing is re-read fresh
      // every time, so revocation takes effect on the very next request.
      if (row) return this.authorizeRow(row);
    }
    const all = this.repos.tokens.listAll();
    for (const row of all) {
      if (await verifyToken(plaintext, row.hash)) {
        this.cacheVerified(cacheKey, row.id);
        return this.authorizeRow(row);
      }
    }
    throw new DomainError('token_not_found', 'token not recognized');
  }

  private authorizeRow(row: Token): ResolvedToken {
    if (row.revokedAt) {
      throw new DomainError('token_revoked', 'token has been revoked');
    }
    if (row.expiresAt && row.expiresAt.getTime() <= this.now().getTime()) {
      throw new DomainError('token_expired', 'token has expired');
    }
    return { token: row, scope: row.scope as TokenScope };
  }

  private cacheVerified(cacheKey: string, tokenId: string): void {
    if (this.verifiedCache.size >= this.verifiedCacheMax) {
      const oldest = this.verifiedCache.keys().next().value;
      if (oldest !== undefined) this.verifiedCache.delete(oldest);
    }
    this.verifiedCache.set(cacheKey, tokenId);
  }

  /**
   * On first-run bootstrap, seed the admin token from REMBRIC_ADMIN_TOKEN.
   * If a token row already exists, this is a no-op (the env var is
   * authoritative only at first run).
   */
  bootstrapAdmin(adminTokenPlaintext: string | null): void {
    if (this.count() > 0) return;
    if (!adminTokenPlaintext) {
      throw new DomainError(
        'admin_token_required',
        'REMBRIC_ADMIN_TOKEN is required on first run; set a strong random value (>= 16 chars).',
      );
    }
    const hash = hashToken(adminTokenPlaintext);
    const ts = this.now();
    this.repos.tokens.insert({
      id: ulid(ts.getTime()),
      name: 'admin',
      hash,
      scope: '*',
      projectId: null,
      createdAt: ts,
      expiresAt: null,
      revokedAt: null,
    });
  }
}

function generatePlaintextToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

function hashToken(plaintext: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(plaintext, salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS);
  return `${HASH_VERSION}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyToken(plaintext: string, stored: string): Promise<boolean> {
  const [version, saltHex, hashHex] = stored.split('$');
  if (version !== HASH_VERSION || !saltHex || !hashHex) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== SCRYPT_PARAMS.keylen) return false;
  const computed = await scryptAsync(plaintext, salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS);
  return timingSafeEqual(computed, expected);
}

/** Promise wrapper over the async (threadpool) scrypt so auth never blocks the event loop. */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/**
 * Authorization checks against a token's scope. Used by the MCP middleware
 * before dispatching tool calls.
 */
export function isAuthorized(
  scope: TokenScope,
  action: 'read' | 'write',
  target: { scope: 'global' | 'project'; projectId?: string | null },
): boolean {
  if (scope === '*') return true;

  if (scope === 'read:*') {
    return action === 'read';
  }

  if (scope.startsWith('read:project:')) {
    const id = scope.slice('read:project:'.length);
    return action === 'read' && target.scope === 'project' && target.projectId === id;
  }

  if (scope.startsWith('project:')) {
    const id = scope.slice('project:'.length);
    return target.scope === 'project' && target.projectId === id;
  }

  return false;
}

/**
 * The single project a token is pinned to, or null for `*` / `read:*`. Derived
 * from the scope string rather than `tokens.project_id`, which the only
 * production creation path leaves NULL — the scope string is what
 * `isAuthorized` compares against.
 */
export function pinnedProjectId(scope: TokenScope): string | null {
  if (scope.startsWith('read:project:')) return scope.slice('read:project:'.length);
  if (scope.startsWith('project:')) return scope.slice('project:'.length);
  return null;
}

/** Derive an HMAC-based session-signing key from a base secret. */
export function deriveSessionKey(baseSecret: string): Buffer {
  return createHmac('sha256', baseSecret).update('rembric:session').digest();
}

/** Derive a distinct HMAC key for signing the OAuth consent hand-off. */
export function deriveOAuthAreqKey(baseSecret: string): Buffer {
  return createHmac('sha256', baseSecret).update('rembric:oauth-areq').digest();
}
