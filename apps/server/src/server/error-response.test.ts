import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { httpInternalError, logInternalError } from './error-response.js';

/**
 * 0255 — HTTP surfaces (domainErr, respondInternal, /admin/consolidation/run)
 * used to return the raw `err.message` to the client for unexpected errors,
 * unlike the MCP surface's `errToMcp` (generic message + correlatable
 * errorId, stack logged server-side only). Both now share this helper.
 */
describe('httpInternalError / logInternalError', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('never returns the raw error message or stack to the client', () => {
    const body = httpInternalError(
      new Error('/data/rembric/secret-path leaked in a stack trace'),
      'test context',
    );
    expect(JSON.stringify(body)).not.toContain('secret-path');
    expect(body.ok).toBe(false);
    expect(body.code).toBe('internal_error');
    expect(body.message).toBe('An unexpected error occurred.');
    expect(typeof body.errorId).toBe('string');
    expect(body.errorId.length).toBeGreaterThan(0);
  });

  it('logs the real error server-side with the same error id returned to the client', () => {
    const body = httpInternalError(new Error('boom'), 'test context');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(body.errorId));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('test context'));
  });

  it('handles a thrown non-Error value without crashing', () => {
    const body = httpInternalError('a plain string throw', 'test context');
    expect(body.ok).toBe(false);
    expect(body.code).toBe('internal_error');
  });

  it('logInternalError returns the same id it logs, without the message field', () => {
    const errorId = logInternalError(new Error('boom'), 'ctx');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(errorId));
  });
});
