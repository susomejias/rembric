import {
  createDiagnostics,
  createRepositories,
  type DbDiagnostics,
  type DbHandle,
} from '@rembric/db';

import { AgentSessionsService } from '@rembric/core';

import { buildDoctorReportFactory } from '../doctor.js';

export function doctorReport(handle: DbHandle, dataDir: string, diagnostics?: DbDiagnostics) {
  const repos = createRepositories(handle.db);
  return buildDoctorReportFactory({
    diagnostics: diagnostics ?? createDiagnostics(handle),
    repos,
    agentSessions: new AgentSessionsService(repos, handle.db),
    dataDir,
  })();
}
