/**
 * Request-body validation for the session-lifecycle HTTP API.
 *
 * `apps/server/src/server/api-router.ts` validates these bodies with `zod` and
 * answers `invalid_input` with zod's own text:
 * `issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')`.
 * That module is not importable from `apps/web` and `zod` is not a dependency
 * of this workspace, so the checks below transcribe the same schemas by hand:
 * same field order, same wording, same short-circuit behaviour. Each function
 * names the zod schema it mirrors.
 *
 * Two zod behaviours are load-bearing for message equality and are not
 * obvious from reading the schemas:
 *   - a string length bound counts CODE POINTS, not UTF-16 units, so
 *     `'𝄞𝄞𝄞'` satisfies `z.string().max(3)`;
 *   - a failed type check ABORTS the remaining checks on that field, but a
 *     failed safe-integer bound does not: `limit: -1e21` reports both the int
 *     bound and `min(1)`.
 * Every message below was taken verbatim from a zod 4.6.5 run against
 * `apps/server`'s schemas; editing one without re-running that comparison is a
 * contract regression.
 */

interface Issue {
  path: string;
  message: string;
}

export type ValidationOutcome<T> = { ok: true; data: T } | { ok: false; message: string };

const ID_RE_SOURCE = '^[A-Za-z0-9_-]{8,128}$';
const ID_RE = new RegExp(ID_RE_SOURCE);

/** zod's `parsedType` for the JSON values a body can carry. */
function parsedType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * zod measures `min`/`max` on a string in code points — a raw `.length` would
 * reject a value zod accepts as soon as the body carries an astral character.
 */
function codePointLength(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

function invalidType(path: string, expected: string, value: unknown): Issue {
  return { path, message: `Invalid input: expected ${expected}, received ${parsedType(value)}` };
}

function join(issues: readonly Issue[]): string {
  return issues.map((i) => `${i.path}: ${i.message}`).join('; ');
}

/**
 * `z.object()` accepts only a JSON object; `null` and arrays are type failures
 * (reported at the root path, which `zodMessage` renders as a leading `: `).
 */
function rootIssues(value: unknown): Issue[] | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return null;
  return [{ path: '', message: `Invalid input: expected object, received ${parsedType(value)}` }];
}

interface StringRule {
  min?: number;
  max?: number;
  pattern?: RegExp;
  patternMessage?: string;
}

function stringIssues(path: string, value: unknown, rule: StringRule = {}): Issue[] {
  if (typeof value !== 'string') return [invalidType(path, 'string', value)];
  if (rule.pattern && !rule.pattern.test(value)) {
    return [{ path, message: rule.patternMessage ?? 'Invalid input' }];
  }
  if (rule.min !== undefined && codePointLength(value) < rule.min) {
    return [{ path, message: `Too small: expected string to have >=${rule.min} characters` }];
  }
  if (rule.max !== undefined && codePointLength(value) > rule.max) {
    return [{ path, message: `Too big: expected string to have <=${rule.max} characters` }];
  }
  return [];
}

/** `.optional()` in zod admits exactly `undefined`; `null` is a type failure. */
function optionalString(path: string, value: unknown, rule: StringRule = {}): Issue[] {
  return value === undefined ? [] : stringIssues(path, value, rule);
}

function booleanIssues(path: string, value: unknown): Issue[] {
  return typeof value === 'boolean' ? [] : [invalidType(path, 'boolean', value)];
}

function optionalBoolean(path: string, value: unknown): Issue[] {
  return value === undefined ? [] : booleanIssues(path, value);
}

/** `z.number().int().min(1).optional()` — see the safe-integer note above. */
function optionalIntMinOne(path: string, value: unknown): Issue[] {
  if (value === undefined) return [];
  if (typeof value !== 'number') return [invalidType(path, 'number', value)];
  if (!Number.isInteger(value))
    return [{ path, message: 'Invalid input: expected int, received number' }];
  const issues: Issue[] = [];
  if (!Number.isSafeInteger(value)) {
    issues.push({
      path,
      message:
        value > 0
          ? `Too big: expected int to be <=${Number.MAX_SAFE_INTEGER}`
          : `Too small: expected int to be >=${Number.MIN_SAFE_INTEGER}`,
    });
  }
  if (value < 1) issues.push({ path, message: 'Too small: expected number to be >=1' });
  return issues;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/** Mirrors `sessionPostSchema` (`POST /:slug/sessions`). */
export interface SessionPostBody {
  id: string;
  cwd?: string;
  agent?: string;
  description?: string;
}

export function parseSessionPost(value: unknown): ValidationOutcome<SessionPostBody> {
  const root = rootIssues(value);
  if (root) return { ok: false, message: join(root) };
  const body = asRecord(value);
  const issues: Issue[] = [
    ...stringIssues('id', body['id'], {
      pattern: ID_RE,
      patternMessage: `id must match ${ID_RE_SOURCE}`,
    }),
    ...optionalString('cwd', body['cwd'], { max: 4096 }),
    ...optionalString('agent', body['agent'], { min: 1, max: 120 }),
    ...optionalString('description', body['description'], { max: 2000 }),
  ];
  if (issues.length > 0) return { ok: false, message: join(issues) };
  // An empty issue list is the proof these casts rely on: every field above
  // was checked against the type named by the cast.
  return {
    ok: true,
    data: {
      id: body['id'] as string,
      cwd: body['cwd'] as string | undefined,
      agent: body['agent'] as string | undefined,
      description: body['description'] as string | undefined,
    },
  };
}

/** Mirrors `sessionSummarySchema` (`POST /:slug/sessions/:id/summary`). */
export interface SessionSummaryBody {
  summary: string;
  title?: string;
  final?: boolean;
}

export function parseSessionSummary(value: unknown): ValidationOutcome<SessionSummaryBody> {
  const root = rootIssues(value);
  if (root) return { ok: false, message: join(root) };
  const body = asRecord(value);
  const issues: Issue[] = [
    ...stringIssues('summary', body['summary'], { min: 1, max: 40_000 }),
    ...optionalString('title', body['title'], { min: 1, max: 200 }),
    ...optionalBoolean('final', body['final']),
  ];
  if (issues.length > 0) return { ok: false, message: join(issues) };
  return {
    ok: true,
    data: {
      summary: body['summary'] as string,
      title: body['title'] as string | undefined,
      final: body['final'] as boolean | undefined,
    },
  };
}

/** Mirrors `sessionEndSchema`; every field is optional. */
export interface SessionEndBody {
  summary?: string;
  title?: string;
  final?: boolean;
}

export function parseSessionEnd(value: unknown): ValidationOutcome<SessionEndBody> {
  const root = rootIssues(value);
  if (root) return { ok: false, message: join(root) };
  const body = asRecord(value);
  const issues: Issue[] = [
    ...optionalString('summary', body['summary'], { min: 1, max: 40_000 }),
    ...optionalString('title', body['title'], { min: 1, max: 200 }),
    ...optionalBoolean('final', body['final']),
  ];
  if (issues.length > 0) return { ok: false, message: join(issues) };
  return {
    ok: true,
    data: {
      summary: body['summary'] as string | undefined,
      title: body['title'] as string | undefined,
      final: body['final'] as boolean | undefined,
    },
  };
}

/**
 * Mirrors `sessionResumeSchema` — `z.object({}).strict()`. Strict is the point
 * of the route (a resume misspelled onto the ensure body would be discarded
 * with a 200 the client cannot tell from success), so unknown keys are
 * reported, one issue for the whole set, in body key order.
 */
export function parseSessionResume(value: unknown): ValidationOutcome<Record<string, never>> {
  const root = rootIssues(value);
  if (root) return { ok: false, message: join(root) };
  const extra = Object.keys(asRecord(value));
  if (extra.length === 0) return { ok: true, data: {} };
  const quoted = extra.map((key) => `"${key}"`).join(', ');
  const message =
    extra.length === 1 ? `Unrecognized key: ${quoted}` : `Unrecognized keys: ${quoted}`;
  return { ok: false, message: join([{ path: '', message }]) };
}

/** Mirrors `sessionTurnSchema`; `usedTools` is required (a default would make a miswired client indistinguishable from a conversation-only turn). */
export interface SessionTurnBody {
  usedTools: boolean;
  title?: string;
}

export function parseSessionTurn(value: unknown): ValidationOutcome<SessionTurnBody> {
  const root = rootIssues(value);
  if (root) return { ok: false, message: join(root) };
  const body = asRecord(value);
  const issues: Issue[] = [
    ...booleanIssues('usedTools', body['usedTools']),
    ...optionalString('title', body['title'], { min: 1, max: 200 }),
  ];
  if (issues.length > 0) return { ok: false, message: join(issues) };
  return {
    ok: true,
    data: {
      usedTools: body['usedTools'] as boolean,
      title: body['title'] as string | undefined,
    },
  };
}

/** Mirrors `recallHintsSchema`; `prompt` is unbounded and may be empty (the handler answers with no lines). */
export interface RecallHintsBody {
  prompt: string;
}

export function parseRecallHints(value: unknown): ValidationOutcome<RecallHintsBody> {
  const root = rootIssues(value);
  if (root) return { ok: false, message: join(root) };
  const body = asRecord(value);
  const issues: Issue[] = [...stringIssues('prompt', body['prompt'])];
  if (issues.length > 0) return { ok: false, message: join(issues) };
  return { ok: true, data: { prompt: body['prompt'] as string } };
}

/** Mirrors `memoryRecallSchema`; `limit` is clamped to 5 by the handler, never rejected for being too large. */
export interface MemoryRecallBody {
  query: string;
  limit?: number;
}

export function parseMemoryRecall(value: unknown): ValidationOutcome<MemoryRecallBody> {
  const root = rootIssues(value);
  if (root) return { ok: false, message: join(root) };
  const body = asRecord(value);
  const issues: Issue[] = [
    ...stringIssues('query', body['query'], { min: 1 }),
    ...optionalIntMinOne('limit', body['limit']),
  ];
  if (issues.length > 0) return { ok: false, message: join(issues) };
  return {
    ok: true,
    data: {
      query: body['query'] as string,
      limit: body['limit'] as number | undefined,
    },
  };
}
