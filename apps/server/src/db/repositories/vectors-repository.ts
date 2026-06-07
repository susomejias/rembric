import type { Db } from '../client.js';

export class VectorsRepository {
  constructor(readonly db: Db) {}
}
