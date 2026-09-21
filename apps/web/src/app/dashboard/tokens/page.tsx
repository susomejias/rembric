import { isProjectSetScope, pinnedProjectId, type TokenScope } from '@rembric/core';
import type { Token } from '@rembric/db';
import Link from 'next/link';

import { FIELD_INK } from '@/components/dashboard/filters';
import {
  Chip,
  DataBody,
  DataHead,
  DataTable,
  DataTd,
  DataTh,
  DataTr,
  Notice,
  Page,
  Pill,
  SectionBar,
  StatCard,
  StatGrid,
  TableEmpty,
  Time,
  ViewHead,
} from '@/components/dashboard/ui';
import { getServices } from '@/lib/services';

/**
 * The tokens list, in the production dashboard's composition: the numbered view
 * head, the credential stats, the mint form and the scope explanation, and the
 * tokens as a table with the name/scope/project/created/expires/state columns.
 *
 * The reads are the ported view's own (`TokensService.list`, the project set
 * tables, the archived-inclusive project list) and so is the state derivation —
 * revoked, expired, inert (pinned to a deleted project), no projects, active.
 *
 * Create and Revoke are still NOT wired: both are mutations whose Server Action
 * boundary is a separate slice. The mint form renders its fields and no action.
 */
export const dynamic = 'force-dynamic';

export default function TokensPage() {
  const { repos, projects, tokens: tokensService } = getServices();
  const nowMs = Date.now();

  const tokens = tokensService.list();

  // Archived included: a token pinned to an archived project keeps authorizing,
  // so hiding the slug would misreport what it reaches.
  const projectRows = projects.list(true);
  const slugById = new Map(projectRows.map((p) => [p.id, p.slug]));

  // Slug-ascending per token: the repository orders by (token_id, slug).
  const memberSlugs = new Map<string, string[]>();
  for (const member of repos.tokens.adminListProjectSlugs()) {
    const found = memberSlugs.get(member.tokenId);
    if (found) found.push(member.slug);
    else memberSlugs.set(member.tokenId, [member.slug]);
  }

  const rows = tokens.map((token) => {
    const scope = token.scope as TokenScope;
    const members = memberSlugs.get(token.id) ?? [];
    return {
      token,
      scope,
      members,
      slug: token.projectId === null ? null : (slugById.get(token.projectId) ?? null),
      state: tokenState(token, slugById, members.length, nowMs),
    };
  });

  const activeCount = rows.filter((row) => row.state.label === 'active').length;
  const selectable = projectRows.filter((p) => p.archivedAt === null);

  return (
    <Page>
      <ViewHead
        num="07"
        title="Rembric Tokens."
        hl="Rembric"
        meta={[{ k: 'TOTAL', v: rows.length }]}
      />

      <StatGrid className="mt-6 sm:grid-cols-3 xl:grid-cols-3">
        <StatCard k="ACTIVE" v={activeCount} tone="lime" sub={<span>AUTHORIZING RIGHT NOW</span>} />
        <StatCard
          k="REVOKED OR EXPIRED"
          v={rows.length - activeCount}
          sub={<span>KEPT FOR AUDIT</span>}
        />
        <StatCard k="PROJECTS" v={selectable.length} sub={<span>AVAILABLE AS A SCOPE</span>} />
      </StatGrid>

      <Notice tone="amber" badge="Not connected" className="mt-6 mb-5">
        Create and revoke are not wired in this port: both are mutations whose Server Action
        boundary is a separate slice. This page renders credential state only, and the mint form
        submits nothing.
      </Notice>

      <SectionBar
        name="Existing tokens"
        meta={`${rows.length} CREDENTIALS`}
        more={
          <Link
            href="/dashboard/projects"
            className="font-mono text-[11px] uppercase tracking-[.12em] text-primary hover:underline"
          >
            PROJECT SCOPES →
          </Link>
        }
      />
      {rows.length === 0 ? (
        <TableEmpty>
          NO TOKEN EXISTS — the bootstrap admin token is minted on first boot and is not listed here
        </TableEmpty>
      ) : (
        <DataTable>
          <DataHead>
            <DataTh>name</DataTh>
            <DataTh>scope</DataTh>
            <DataTh>project</DataTh>
            <DataTh>created</DataTh>
            <DataTh>expires</DataTh>
            <DataTh>state</DataTh>
            <DataTh>actions</DataTh>
          </DataHead>
          <DataBody>
            {rows.map(({ token, scope, members, slug, state }) => (
              <DataTr key={token.id}>
                <DataTd className="max-w-[220px] truncate">{token.name}</DataTd>
                <DataTd>
                  <Chip>{scope}</Chip>
                </DataTd>
                <DataTd className="text-muted-foreground">
                  {members.length > 0
                    ? members.join(', ')
                    : slug === null
                      ? 'admin / global'
                      : slug}
                </DataTd>
                <DataTd className="font-mono text-xs text-muted-foreground">
                  <Time value={token.createdAt} />
                </DataTd>
                <DataTd className="font-mono text-xs text-muted-foreground">
                  <Time value={token.expiresAt} />
                </DataTd>
                <DataTd>
                  <Pill tone={state.tone}>{state.label}</Pill>
                </DataTd>
                <DataTd>
                  <button
                    type="button"
                    disabled
                    title="Token revocation lands with the tokens Server Action"
                    className="w-fit border border-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[.12em] text-muted-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Revoke
                  </button>
                </DataTd>
              </DataTr>
            ))}
          </DataBody>
        </DataTable>
      )}

      <div className="mt-8 border border-border bg-card p-5 md:p-6">
        <SectionBar name="Create a new token" />
        <form className="mt-4 flex flex-col gap-3 md:flex-row md:items-end">
          <label className="flex-1 font-mono text-[11px] uppercase tracking-[.14em] text-muted-foreground">
            NAME
            <input
              disabled
              placeholder="claude-laptop"
              className={`mt-2 ${FIELD_INK} disabled:opacity-50`}
            />
          </label>
          <label className="flex-1 font-mono text-[11px] uppercase tracking-[.14em] text-muted-foreground">
            PROJECT SCOPE
            <select disabled className={`mt-2 ${FIELD_INK} disabled:opacity-50`}>
              <option>— none (admin / global) —</option>
              {selectable.map((project) => (
                <option key={project.id}>{project.slug}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled
            title="Token minting is wired in a later slice"
            className="h-9 bg-primary px-5 font-mono text-[11px] font-semibold uppercase tracking-[.12em] text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Create token
          </button>
        </form>
        <p className="mt-3 text-[11px] text-muted-foreground">
          The plaintext secret is shown once, at creation, and only its hash is stored.
        </p>
      </div>

      <div className="mt-8 border border-border bg-card p-5 md:p-6">
        <SectionBar name="Scope model" />
        <h2 className="font-display text-xl font-bold tracking-[-.02em]">One token, one reach</h2>
        <div className="mt-5 grid gap-4 text-xs sm:grid-cols-2">
          <div>
            <p className="text-muted-foreground">Admin scope</p>
            <p className="mt-1">
              <code className="font-mono">*</code> reaches every project and the dashboard itself.
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Project scope</p>
            <p className="mt-1">
              A pinned <code className="font-mono">project:&lt;id&gt;</code> or a project set limits
              the token to those scopes.
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Revocation</p>
            <p className="mt-1">Revoking sets a timestamp; the row is kept for audit.</p>
          </div>
          <div>
            <p className="text-muted-foreground">Expiry</p>
            <p className="mt-1">
              An expired token authenticates nothing and is reported as expired.
            </p>
          </div>
        </div>
      </div>
    </Page>
  );
}

function tokenState(
  token: Token,
  slugById: ReadonlyMap<string, string>,
  memberCount: number,
  nowMs: number,
): { label: string; tone: 'lime' | 'amber' | 'danger' | 'dim' } {
  if (token.revokedAt) return { label: 'revoked', tone: 'danger' };
  if (token.expiresAt && token.expiresAt.getTime() <= nowMs) {
    return { label: 'expired', tone: 'amber' };
  }
  const pinned = pinnedProjectId(token.scope as TokenScope);
  if (pinned !== null && !slugById.has(pinned)) return { label: 'inert', tone: 'amber' };
  if (isProjectSetScope(token.scope as TokenScope) && memberCount === 0) {
    return { label: 'no projects', tone: 'dim' };
  }
  return { label: 'active', tone: 'lime' };
}
