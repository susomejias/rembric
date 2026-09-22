import { DomainError } from '@rembric/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errToMcp, isDomainError } from '@rembric/mcp';

import { logInternalError } from './test-support/test-logger.js';

describe('errToMcp', () => {
  it('preserves a DomainError code and message verbatim', () => {
    const result = errToMcp(
      new DomainError('memory_not_found', 'memory not found'),
      logInternalError,
    );
    const body = JSON.parse(result.content[0]?.text ?? '{}') as {
      ok: boolean;
      code: string;
      message: string;
    };
    expect(body).toMatchObject({
      ok: false,
      code: 'memory_not_found',
      message: 'memory not found',
    });
  });

  it('forwards a DomainError payload into the body, like a hand-built mcpError', () => {
    const result = errToMcp(
      new DomainError('project_not_found', 'x', { suggestedSlugs: ['a'] }),
      logInternalError,
    );
    const body = JSON.parse(result.content[0]?.text ?? '{}') as {
      code: string;
      suggestedSlugs: string[];
    };
    expect(body.code).toBe('project_not_found');
    expect(body.suggestedSlugs).toEqual(['a']);
  });

  it('omits the payload keys entirely when a DomainError carries none', () => {
    const body = JSON.parse(
      errToMcp(new DomainError('forbidden', 'nope'), logInternalError).content[0]?.text ?? '{}',
    ) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['ok', 'code', 'message']);
  });

  describe('non-domain errors', () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      errorSpy.mockRestore();
    });

    it('never returns the raw error message or stack to the client', () => {
      const result = errToMcp(
        new Error('/data/rembric/secret-path leaked in a stack trace'),
        logInternalError,
      );
      const text = result.content[0]?.text ?? '';
      expect(text).not.toContain('secret-path');
      const body = JSON.parse(text) as {
        ok: boolean;
        code: string;
        message: string;
        errorId: string;
      };
      expect(body.ok).toBe(false);
      expect(body.code).toBe('internal_error');
      expect(body.message).toBe('An unexpected error occurred.');
      expect(typeof body.errorId).toBe('string');
      expect(body.errorId.length).toBeGreaterThan(0);
    });

    it('logs the real error server-side with the same error id returned to the client', () => {
      const result = errToMcp(new Error('boom'), logInternalError);
      const body = JSON.parse(result.content[0]?.text ?? '{}') as { errorId: string };
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(body.errorId));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('boom'));
    });

    it('handles a thrown non-Error value without crashing', () => {
      const result = errToMcp('a plain string throw', logInternalError);
      const body = JSON.parse(result.content[0]?.text ?? '{}') as { ok: boolean; code: string };
      expect(body.ok).toBe(false);
      expect(body.code).toBe('internal_error');
    });
  });
});

/**
 * The shape a bundled second copy of `@rembric/core` produces: same `name` +
 * `code` contract as `packages/core/src/services/errors.ts::DomainError`, a
 * different class, so `instanceof DomainError` is false across the two.
 */
class DuplicatedCoreDomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

describe('isDomainError', () => {
  it('recognizes a DomainError thrown by a duplicated module copy', () => {
    expect(isDomainError(new DuplicatedCoreDomainError('memory_not_found', 'gone'))).toBe(true);
  });

  it('does not classify a better-sqlite3 SqliteError as a DomainError', () => {
    const sqlite = Object.assign(new Error('database is locked'), {
      name: 'SqliteError',
      code: 'SQLITE_BUSY',
    });
    expect(isDomainError(sqlite)).toBe(false);
  });

  it('rejects a non-Error throw and a DomainError-named error without a string code', () => {
    const noCode = Object.assign(new Error('boom'), { name: 'DomainError' });
    expect(isDomainError('a plain string throw')).toBe(false);
    expect(isDomainError(noCode)).toBe(false);
  });

  it('makes errToMcp preserve the code of a duplicated-copy DomainError', () => {
    const result = errToMcp(
      new DuplicatedCoreDomainError('memory_not_found', 'memory not found'),
      logInternalError,
    );
    const body = JSON.parse(result.content[0]?.text ?? '{}') as { code: string; message: string };
    expect(body.code).toBe('memory_not_found');
    expect(body.message).toBe('memory not found');
  });
});
