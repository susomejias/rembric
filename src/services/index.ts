/**
 * Service barrel. The HTTP, MCP, dashboard, and CLI layers depend only on
 * these exports; they don't reach into per-file modules.
 */

export { MemoryService } from './memory.js';
export type { SaveMemoryInput, SearchMemoriesInput, MemoryWithHistory } from './memory.js';

export { ProjectsService } from './projects.js';
export type { ProjectView } from './projects.js';

export { TokensService, isAuthorized, deriveSessionKey } from './tokens.js';
export type { TokenScope, CreateTokenInput, CreatedToken, ResolvedToken } from './tokens.js';

export { SessionsService } from './sessions.js';
export type { SessionContext } from './sessions.js';

export { EmbeddingWorker } from './embedding-worker.js';
export type { EmbeddingWorkerOptions } from './embedding-worker.js';

export { DomainError } from './errors.js';
export type { DomainErrorCode } from './errors.js';
