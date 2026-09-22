import {
  createDiagnostics,
  createRepositories,
  type DbDiagnostics,
  type DbHandle,
} from '@rembric/db';

import { AgentSessionsService } from '@rembric/core';

import { buildDoctorReportFactory } from '../doctor.js';

/**
 * `memory.doctor`'s payload for a test's own handle, wired as the app layer
 * wires it. `diagnostics` is injectable because a test may need a stubbed one.
 */
export function doctorReport(handle: DbHandle, dataDir: string, diagnostics?: DbDiagnostics) {
  const repos = createRepositories(handle.db);
  return buildDoctorReportFactory({
    diagnostics: diagnostics ?? createDiagnostics(handle),
    repos,
    agentSessions: new AgentSessionsService(repos, handle.db),
    dataDir,
  })();
}
