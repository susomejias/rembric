import type { DbHandle } from '../db/index.js';
import { TokensService, type CreatedToken, type TokenScope } from '../services/tokens.js';

/**
 * Helper to mint a token quickly inside a test. Returns the plaintext so
 * tests can send it as a Bearer header.
 */
export function mintTestToken(
  handle: DbHandle,
  scope: TokenScope = '*',
  name = `test-${Math.random().toString(36).slice(2, 10)}`,
): CreatedToken {
  return new TokensService(handle.db).create({ name, scope, projectId: null });
}
