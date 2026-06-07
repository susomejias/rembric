import type { Db } from '../client.js';

export class TokensRepository {
  constructor(readonly db: Db) {}
}
