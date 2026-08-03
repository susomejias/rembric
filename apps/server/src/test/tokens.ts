import type { DbHandle } from '../db/index.js';
import { createRepositories } from '../db/repositories/index.js';
import { TokensService, type CreatedToken, type TokenGrant } from '../services/tokens.js';

/**
 * Helper to mint a token quickly inside a test. Returns the plaintext so
 * tests can send it as a Bearer header.
 */
export function mintTestToken(
  handle: DbHandle,
  grant: TokenGrant = { scope: '*' },
  name = `test-${Math.random().toString(36).slice(2, 10)}`,
): CreatedToken {
  const tokens = new TokensService(createRepositories(handle.db));
  return tokens.create({ name, ...grant });
}
