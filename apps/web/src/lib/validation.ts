interface Issue {
  path: string;
  message: string;
}

export type ValidationOutcome<T> = { ok: true; data: T } | { ok: false; message: string };

const ID_RE_SOURCE = '^[A-Za-z0-9_-]{8,128}$';
const ID_RE = new RegExp(ID_RE_SOURCE);

function parsedType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

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

function optionalString(path: string, value: unknown, rule: StringRule = {}): Issue[] {
  return value === undefined ? [] : stringIssues(path, value, rule);
}

function booleanIssues(path: string, value: unknown): Issue[] {
  return typeof value === 'boolean' ? [] : [invalidType(path, 'boolean', value)];
}

function optionalBoolean(path: string, value: unknown): Issue[] {
  return value === undefined ? [] : booleanIssues(path, value);
}

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
