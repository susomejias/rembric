import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger, setLogLevel } from './logger.js';

describe('logger', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    setLogLevel('info');
  });

  it('suppresses a log below the configured level', () => {
    setLogLevel('warn');
    logger.info('should not appear');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('emits a log at or above the configured level', () => {
    setLogLevel('warn');
    logger.warn('should appear');
    logger.error('should also appear');
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it('writes to stderr (console.error), never stdout, regardless of level', () => {
    setLogLevel('debug');
    logger.debug('debug line');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[debug] debug line'));
  });

  it('includes structured meta as JSON when provided', () => {
    setLogLevel('debug');
    logger.error('boom', { errorId: 'abc-123' });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"errorId":"abc-123"'));
  });
});
