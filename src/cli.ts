#!/usr/bin/env node
/**
 * CLI entrypoint. Routes subcommands; `start` (default) launches the server.
 * Each subcommand is implemented in its own module and lazy-loaded so that
 * `--help` and trivial commands don't pay startup cost.
 */

import { Command } from 'commander';

const program = new Command();

program
  .name('rembric')
  .description('Self-hosted MCP memory server for AI agents (brand: Rembric)')
  .version('0.0.0');

program
  .command('start', { isDefault: true })
  .description('Start the HTTP server (MCP + dashboard)')
  .action(async () => {
    const { startCli } = await import('./server/index.js');
    await startCli();
  });

program
  .command('status')
  .description('Print health and counters from the local DB')
  .action(async () => {
    const { runStatus } = await import('./cli/server-status.js');
    runStatus();
  });

const llm = program.command('llm').description('LLM-related commands');
llm
  .command('ping')
  .description('Verify the configured LLM endpoint is reachable')
  .action(async () => {
    const { runLlmPing } = await import('./cli/llm-ping.js');
    await runLlmPing();
  });

const tokenCmd = program.command('token').description('Manage API tokens');
tokenCmd
  .command('create <name>')
  .description('Create a new bearer token; plaintext is shown exactly once')
  .option('--project <name>', 'Resolve a project and scope the token to it')
  .option('--expires <iso>', 'Expiration timestamp (ISO 8601)')
  .option(
    '--scope <scope>',
    "Token scope: '*', 'read:*', 'project:<id>', or 'read:project:<id>' (default: derives from --project)",
  )
  .action(async (name: string, opts: { project?: string; expires?: string; scope?: string }) => {
    const { runTokenCreate } = await import('./cli/token-cli.js');
    runTokenCreate({ name, ...opts });
  });
tokenCmd
  .command('list')
  .description('List all tokens (names + scopes + state; never the secret)')
  .action(async () => {
    const { runTokenList } = await import('./cli/token-cli.js');
    runTokenList();
  });
tokenCmd
  .command('revoke <name>')
  .description('Revoke a token by name (effective immediately)')
  .action(async (name: string) => {
    const { runTokenRevoke } = await import('./cli/token-cli.js');
    runTokenRevoke(name);
  });

const projectCmd = program.command('project').description('Manage projects');
projectCmd
  .command('create <slug>')
  .description('Create a project with the given slug (must match the strict slug regex)')
  .option('--name <name>', 'Optional display name (cosmetic only; slug remains the identity)')
  .action(async (slug: string, opts: { name?: string }) => {
    const { runProjectCreate } = await import('./cli/project-cli.js');
    runProjectCreate({ slug, name: opts.name });
  });
projectCmd
  .command('list')
  .description('List projects')
  .option('--all', 'Include archived projects (default: active only)')
  .option('--table', 'Render as a text table (default: JSON)')
  .action(async (opts: { all?: boolean; table?: boolean }) => {
    const { runProjectList } = await import('./cli/project-cli.js');
    runProjectList({ json: !opts.table, includeArchived: opts.all });
  });

const sessionCmd = program.command('session').description('Manage agent sessions');
sessionCmd
  .command('list')
  .description('List recent agent sessions')
  .option('--status <status>', 'Filter by status: active | ended | abandoned')
  .option('--limit <n>', 'Maximum rows to return (default 50)', (v: string) => parseInt(v, 10))
  .option('--include-deleted', 'Include soft-deleted sessions (default: hide)')
  .option('--table', 'Render as a text table (default: JSON)')
  .action(
    async (opts: {
      status?: 'active' | 'ended' | 'abandoned';
      limit?: number;
      includeDeleted?: boolean;
      table?: boolean;
    }) => {
      const { runSessionList } = await import('./cli/session-cli.js');
      runSessionList({
        status: opts.status,
        limit: opts.limit,
        includeDeleted: opts.includeDeleted,
        json: !opts.table,
      });
    },
  );
sessionCmd
  .command('delete <id>')
  .description('Soft-delete a session (hides it from listings; preserves audit trail)')
  .action(async (id: string) => {
    const { runSessionDelete } = await import('./cli/session-cli.js');
    runSessionDelete({ id });
  });

const consolidation = program
  .command('consolidation')
  .description('Manage the consolidation engine');
consolidation
  .command('run-now')
  .description('Trigger a consolidation pass on demand (server must be running)')
  .option('--token <token>', 'Admin bearer token (falls back to REMBRIC_ADMIN_TOKEN)')
  .option('--url <url>', 'Base URL of the running server (defaults to host/port from config)')
  .option('--orphans-only', 'Skip the decay sweep; only promote pending judgments')
  .action(async (opts: { token?: string; url?: string; orphansOnly?: boolean }) => {
    const { runConsolidationRunNow } = await import('./cli/consolidation-cli.js');
    await runConsolidationRunNow(opts);
  });

const db = program.command('db').description('Database admin');
db.command('migrate')
  .description('Apply pending migrations (server must be stopped)')
  .action(async () => {
    const { runDbMigrate } = await import('./cli/db-migrate.js');
    runDbMigrate();
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`rembric: ${message}`);
  process.exit(1);
});
