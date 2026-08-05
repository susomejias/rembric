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

import type { TransactionRunner } from '../db/client.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Project } from '../db/schema/projects.js';
import { type Token } from '../db/schema/tokens.js';

import { DomainError } from './errors.js';
import type { ProjectsService } from './projects.js';

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
 *   - `projects`                → write to the set in `token_projects`
 *   - `read:projects`           → read that set
 *
 * The two project arms are composed by `create` from a resolved project
 * row, never accepted from a caller: `<id>` is compared against
 * `projects.id`, and a caller-supplied string could name a slug instead.
 *
 * The two set arms name no project, so they authorize nothing by string
 * alone — deliberately, so that the union in `isAuthorized` can only add
 * reach and a reader ignorant of `token_projects` under-authorizes.
 */

const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1, keylen: 64 } as const;
const HASH_VERSION = 's1';
const TOKEN_BYTES = 32;
/** Bound on the verified-credential cache; oldest entry evicted past this. */
const VERIFIED_CACHE_MAX = 64;

export type TokenScope =
  | '*'
  | 'read:*'
  | `project:${string}`
  | `read:project:${string}`
  | 'projects'
  | 'read:projects';

/**
 * Reach is unbound (the caller names the scope literal), a single project, or
 * an explicit set of them; the last two carry an access verb. Resolved project
 * ROWS throughout: a bare project id would re-admit a slug, and that is as true
 * of the set as of the single arm.
 */
export type TokenGrant =
  | { scope: '*' | 'read:*'; project?: never; projects?: never; access?: never }
  | { project: Project; access: 'read' | 'write'; scope?: never; projects?: never }
  | {
      /** Non-empty by type: a credential over no project would authorize nothing. */
      projects: readonly [Project, ...Project[]];
      access: 'read' | 'write';
      scope?: never;
      project?: never;
    };

export type CreateTokenInput = { name: string; expiresAt?: Date | null } & TokenGrant;

/**
 * A credential's reach: what its scope string grants, plus the projects it
 * reaches by membership. Both halves are required at every authorization
 * decision, so `isAuthorized` takes them together rather than letting a call
 * site supply one and forget the other.
 */
export interface TokenReach {
  scope: TokenScope;
  /** From `token_projects`; empty for every arm but `projects`/`read:projects`. */
  memberProjectIds: readonly string[];
}

/** What `createForSlugs` needs of `ProjectsService`, derived so it cannot drift from it. */
type ProjectResolver = Pick<ProjectsService, 'findBySlug' | 'create'>;

export interface CreatedToken {
  /** The plaintext secret. Shown to the operator exactly once. */
  plaintext: string;
  /** The persisted row, minus the secret. */
  token: Token;
}

export interface ResolvedToken extends TokenReach {
  token: Token;
}

export class TokensService {
  /** sha256(plaintext) hex → token id, for successfully scrypt-verified tokens. */
  private readonly verifiedCache = new Map<string, string>();

  constructor(
    private readonly repos: Pick<Repositories, 'tokens'>,
    private readonly tx: TransactionRunner,
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
    const { scope, projectId, memberProjectIds } = composeGrant(input);
    const row = this.tx.transaction((): Token => {
      const inserted = this.repos.tokens.insert({
        id: ulid(ts.getTime()),
        name: input.name,
        hash,
        scope,
        projectId,
        createdAt: ts,
        expiresAt: input.expiresAt ?? null,
        revokedAt: null,
      });
      if (!inserted)
        throw new DomainError('conflict', 'tokens.create: insert did not return a row');
      this.repos.tokens.insertProjects(
        memberProjectIds.map((id) => ({ tokenId: inserted.id, projectId: id })),
      );
      return inserted;
    });
    return { plaintext, token: row };
  }

  /**
   * Mint a token over project SLUGS, creating any that names no project yet.
   * One transaction spans the project inserts and the mint, so a refusal from
   * either — an invalid slug, a token name already taken — leaves behind no
   * project the operator never got a credential for. `create`'s own
   * transaction nests inside this one as a savepoint (measured: an outer
   * rollback undoes the inner commit).
   *
   * The resolver is an argument rather than a constructor dependency: every
   * other construction site of this service would otherwise have to grow one.
   */
  createForSlugs(
    input: {
      name: string;
      slugs: readonly [string, ...string[]];
      access: 'read' | 'write';
      expiresAt?: Date | null;
    },
    projects: ProjectResolver,
  ): CreatedToken {
    const resolve = (slug: string): Project =>
      projects.findBySlug(slug) ?? projects.create({ slug });
    return this.tx.transaction((): CreatedToken => {
      const [first, ...rest] = input.slugs;
      return this.create({
        name: input.name,
        projects: [resolve(first), ...rest.map((slug) => resolve(slug))],
        access: input.access,
        expiresAt: input.expiresAt,
      });
    });
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
    // Membership is read here, beside revoked/expired, and for the same reason:
    // removing a project must take effect on the token's next request, so it is
    // never carried in `verifiedCache` — that cache may live forever precisely
    // because it substitutes for nothing on this path.
    return {
      token: row,
      scope: row.scope as TokenScope,
      memberProjectIds: this.repos.tokens.listProjectIds(row.id),
    };
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

interface ComposedGrant {
  scope: TokenScope;
  projectId: string | null;
  memberProjectIds: string[];
}

function composeGrant(grant: TokenGrant): ComposedGrant {
  if (grant.projects) {
    const [first, ...rest] = grant.projects;
    // One selection composes the SINGLE-project arm, not a one-member set, so
    // the common case keeps the FK-enforced `project_id` binding.
    if (rest.length === 0) return singleProject(first, grant.access);
    return {
      scope: grant.access === 'read' ? 'read:projects' : 'projects',
      projectId: null,
      memberProjectIds: [first.id, ...rest.map((p) => p.id)],
    };
  }
  if (!grant.project) return { scope: grant.scope, projectId: null, memberProjectIds: [] };
  return singleProject(grant.project, grant.access);
}

function singleProject(project: Project, access: 'read' | 'write'): ComposedGrant {
  const base = access === 'read' ? 'read:*' : '*';
  return {
    scope: projectScopedGrant(base, project.id),
    projectId: project.id,
    memberProjectIds: [],
  };
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
 * Authorization checks against a token's reach. Used by the MCP middleware
 * before dispatching tool calls.
 *
 * The union is additive: membership can only add authorizations, never remove
 * one the scope string grants. That is what makes every pre-existing token —
 * all of which have an empty membership set — observably unchanged.
 */
export function isAuthorized(
  reach: TokenReach,
  action: 'read' | 'write',
  target: { scope: 'global' | 'project'; projectId?: string | null },
): boolean {
  return (
    authorizedByScope(reach.scope, action, target) || authorizedByMembership(reach, action, target)
  );
}

/** What the scope string grants on its own. The two set arms grant nothing here. */
function authorizedByScope(
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
 * What the membership set grants. Confined to the two set arms: on a `*` or
 * `read:*` base a set would be decorative — measured, base `read:*` with a set
 * of {A, C} authorized project B — so a stray membership row widens nothing.
 */
function authorizedByMembership(
  reach: TokenReach,
  action: 'read' | 'write',
  target: { scope: 'global' | 'project'; projectId?: string | null },
): boolean {
  if (!isProjectSetScope(reach.scope)) return false;
  if (reach.scope === 'read:projects' && action !== 'read') return false;
  if (target.scope !== 'project' || !target.projectId) return false;
  return reach.memberProjectIds.includes(target.projectId);
}

/**
 * Narrow a global scope to a single project: `*` → `project:<id>`, `read:*` →
 * `read:project:<id>`. A null project leaves the scope unchanged. Lives beside
 * its inverse `pinnedProjectId` so the grammar has one writer and one reader;
 * the OAuth grant path and `composeGrant` are both callers.
 */
export function projectScopedGrant(base: TokenScope, projectId: string | null): TokenScope {
  if (!projectId) return base;
  return base === '*' ? `project:${projectId}` : `read:project:${projectId}`;
}

/**
 * The single project a token is pinned to, or null for `*` / `read:*`.
 * Parses the scope string rather than reading `tokens.project_id` because
 * its caller holds a `TokenScope`, not a row — and the string is what
 * `isAuthorized` compares against. Legacy rows predating the enforced
 * binding still carry a slug here, and resolve to no project.
 *
 * Null for the two set arms too, and that is the answer rather than a gap: a
 * set is not a pin, so there is no single project to name, and every caller
 * treats null as "no pin to reason about" — which is fail-closed.
 */
export function pinnedProjectId(scope: TokenScope): string | null {
  if (scope.startsWith('read:project:')) return scope.slice('read:project:'.length);
  if (scope.startsWith('project:')) return scope.slice('project:'.length);
  return null;
}

/**
 * The set arms, whose reach lives in `token_projects` rather than in the string.
 * A predicate rather than a comparison, so every consumer narrows: the dashboard
 * interpolates the scope into a template unescaped once it does.
 */
export function isProjectSetScope(scope: TokenScope): scope is 'projects' | 'read:projects' {
  return scope === 'projects' || scope === 'read:projects';
}

/** Derive an HMAC-based session-signing key from a base secret. */
export function deriveSessionKey(baseSecret: string): Buffer {
  return createHmac('sha256', baseSecret).update('rembric:session').digest();
}

/** Derive a distinct HMAC key for signing the OAuth consent hand-off. */
export function deriveOAuthAreqKey(baseSecret: string): Buffer {
  return createHmac('sha256', baseSecret).update('rembric:oauth-areq').digest();
}
