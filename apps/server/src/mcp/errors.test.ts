import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DomainError } from '../services/errors.js';

import { errToMcp } from './errors.js';

describe('errToMcp', () => {
  it('preserves a DomainError code and message verbatim', () => {
    const result = errToMcp(new DomainError('memory_not_found', 'memory not found'));
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
    const result = errToMcp(new DomainError('project_not_found', 'x', { suggestedSlugs: ['a'] }));
    const body = JSON.parse(result.content[0]?.text ?? '{}') as {
      code: string;
      suggestedSlugs: string[];
    };
    expect(body.code).toBe('project_not_found');
    expect(body.suggestedSlugs).toEqual(['a']);
  });

  it('omits the payload keys entirely when a DomainError carries none', () => {
    const body = JSON.parse(
      errToMcp(new DomainError('forbidden', 'nope')).content[0]?.text ?? '{}',
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
      const result = errToMcp(new Error('/data/rembric/secret-path leaked in a stack trace'));
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
      const result = errToMcp(new Error('boom'));
      const body = JSON.parse(result.content[0]?.text ?? '{}') as { errorId: string };
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(body.errorId));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('boom'));
    });

    it('handles a thrown non-Error value without crashing', () => {
      const result = errToMcp('a plain string throw');
      const body = JSON.parse(result.content[0]?.text ?? '{}') as { ok: boolean; code: string };
      expect(body.ok).toBe(false);
      expect(body.code).toBe('internal_error');
    });
  });
});
