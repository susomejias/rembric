import type { Db } from '../client.js';

import { AgentSessionsRepository } from './agent-sessions-repository.js';
import { ConsolidationRepository } from './consolidation-repository.js';
import { DashboardSessionsRepository } from './dashboard-sessions-repository.js';
import { MemoryRepository } from './memory-repository.js';
import { OAuthRepository } from './oauth-repository.js';
import { ProjectsRepository } from './projects-repository.js';
import { PromptsRepository } from './prompts-repository.js';
import { RelationsRepository } from './relations-repository.js';
import { TokensRepository } from './tokens-repository.js';
import { VectorsRepository } from './vectors-repository.js';

export {
  AgentSessionsRepository,
  type AdminRecentSession,
  type AdminSessionDetail,
  type AdminSessionRow,
  type ListSessionsOpts,
} from './agent-sessions-repository.js';
export { ConsolidationRepository } from './consolidation-repository.js';
export {
  DashboardSessionsRepository,
  type ResolvedDashboardSession,
} from './dashboard-sessions-repository.js';
export {
  MemoryRepository,
  type AdminListMemoriesOpts,
  type FindActiveByScopeOpts,
} from './memory-repository.js';
export { OAuthRepository } from './oauth-repository.js';
export { ProjectsRepository } from './projects-repository.js';
export { PromptsRepository, type AdminListPromptsOpts } from './prompts-repository.js';
export {
  RelationsRepository,
  type AdminRelationFilters,
  type AdminRelationWithContent,
} from './relations-repository.js';
export { TokensRepository } from './tokens-repository.js';
export { VectorsRepository } from './vectors-repository.js';

export interface Repositories {
  memory: MemoryRepository;
  relations: RelationsRepository;
  agentSessions: AgentSessionsRepository;
  prompts: PromptsRepository;
  projects: ProjectsRepository;
  tokens: TokensRepository;
  oauth: OAuthRepository;
  consolidation: ConsolidationRepository;
  vectors: VectorsRepository;
  dashboardSessions: DashboardSessionsRepository;
}

export function createRepositories(db: Db): Repositories {
  return {
    memory: new MemoryRepository(db),
    relations: new RelationsRepository(db),
    agentSessions: new AgentSessionsRepository(db),
    prompts: new PromptsRepository(db),
    projects: new ProjectsRepository(db),
    tokens: new TokensRepository(db),
    oauth: new OAuthRepository(db),
    consolidation: new ConsolidationRepository(db),
    vectors: new VectorsRepository(db),
    dashboardSessions: new DashboardSessionsRepository(db),
  };
}
