import { isProjectSetScope, pinnedProjectId, type TokenScope } from '@rembric/core';
import type { Token } from '@rembric/db';
import { KeyRound } from 'lucide-react';
import Link from 'next/link';

import { FIELD_INK } from '@/components/dashboard/filters';
import { PAGE_SIZE } from '@/components/dashboard/support';
import {
  Chip,
  EmptyNote,
  Notice,
  Page,
  PageHead,
  Panel,
  PanelHead,
  Row,
  Rows,
  StatTile,
  Time,
} from '@/components/dashboard/ui';
import { getServices } from '@/lib/services';

/**
 * The tokens list, in the v0 composition: the credential rows, the mint form and
 * the scope explanation.
 *
 * The reads are the ported view's own (`TokensService.list`, the project set
 * tables, the archived-inclusive project list) and so is the state derivation —
 * revoked, expired, inert (pinned to a deleted project), no projects, active.
 *
 * Create and Revoke are still NOT wired: both are mutations whose Server Action
 * boundary is a separate slice. The mint form renders its fields and no action.
 *
 * The state cell is the mockup's bordered badge, not a filled pill: the tokens
 * table is the one v0 view that draws its state that way, and the tones below
 * are the retired view's own `.pill.{active,revoked,expired,legacy,pending}`
 * mapping. `Chip` from `ui.tsx` cannot serve it — that component has no amber
 * arm, and both `expired` and `inert` need one.
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
      <PageHead
        icon={KeyRound}
        eyebrow="Admin access"
        title="Tokens"
        description="Create and revoke scoped tokens used by agents and MCP clients to access this workspace."
        aside={<span className="text-[11px] text-muted-foreground">{rows.length} total</span>}
      />

      <section className="mt-6 grid gap-3 sm:grid-cols-3">
        <StatTile label="Active" value={activeCount} tone="lime" hint="authorizing right now" />
        <StatTile
          label="Revoked or expired"
          value={rows.length - activeCount}
          hint="kept for audit"
        />
        <StatTile label="Projects" value={selectable.length} hint="available as a scope" />
      </section>

      <Notice tone="amber" badge="Not connected" className="mt-6">
        Create and revoke are not wired in this port: both are mutations whose Server Action
        boundary is a separate slice. This page renders credential state only, and the mint form
        submits nothing.
      </Notice>

      <Panel className="mt-7">
        <PanelHead
          eyebrow="Existing tokens"
          title="Active and revoked credentials"
          action={
            <Link
              href="/dashboard/projects"
              className="text-[11px] text-primary hover:text-primary"
            >
              Project scopes →
            </Link>
          }
        />
        {rows.length === 0 ? (
          <EmptyNote>
            No token exists. The bootstrap admin token is minted by the server on first boot and is
            not listed here.
          </EmptyNote>
        ) : (
          <>
            <div className="hidden grid-cols-[1.1fr_1.3fr_1.4fr_1fr_110px] gap-4 border-b border-border px-5 py-3 text-[10px] tracking-[.14em] text-muted-foreground uppercase md:grid">
              <span>Name</span>
              <span>Scope</span>
              <span>Created</span>
              <span>State</span>
              <span>Expires</span>
            </div>
            <Rows>
              {rows.map(({ token, scope, members, slug, state }) => (
                <Row key={token.id} columns="md:grid-cols-[1.1fr_1.3fr_1.4fr_1fr_110px]">
                  <div className="min-w-0">
                    <p className="truncate text-xs text-muted-foreground">{token.name}</p>
                    <p className="mt-1 truncate text-[10px] text-muted-foreground">
                      {members.length > 0
                        ? members.join(', ')
                        : slug === null
                          ? 'admin / global'
                          : slug}
                    </p>
                  </div>
                  <Chip>{scope}</Chip>
                  <span className="text-xs text-muted-foreground">
                    <Time value={token.createdAt} />
                  </span>
                  <span
                    className={`w-fit border px-2 py-1 text-[10px] tracking-[.12em] uppercase ${STATE_CHIP[state.tone]}`}
                  >
                    {state.label}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    <Time value={token.expiresAt} />
                  </span>
                </Row>
              ))}
            </Rows>
          </>
        )}
      </Panel>

      <Panel className="mt-7" padded>
        <p className="text-[10px] tracking-[.14em] text-muted-foreground uppercase">
          Create a new token
        </p>
        <form className="mt-4 flex flex-col gap-3 md:flex-row md:items-end">
          <label className="flex-1 text-[10px] tracking-[.14em] text-muted-foreground uppercase">
            Name
            <input
              disabled
              placeholder="claude-laptop"
              className={`mt-2 ${FIELD_INK} disabled:opacity-50`}
            />
          </label>
          <label className="flex-1 text-[10px] tracking-[.14em] text-muted-foreground uppercase">
            Project scope
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
            className="rounded-lg bg-primary px-5 py-3 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Create token
          </button>
        </form>
        <p className="mt-3 text-[11px] text-muted-foreground">
          The plaintext secret is shown once, at creation, and only its hash is stored.
        </p>
      </Panel>

      <Panel className="mt-7" padded>
        <p className="text-[10px] tracking-[.14em] text-muted-foreground uppercase">Scope model</p>
        <h2 className="mt-2 text-xl font-medium tracking-[-.04em]">One token, one reach</h2>
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
        <p className="mt-6 border-t border-border pt-4 text-[11px] text-muted-foreground">
          {PAGE_SIZE} is the dashboard&apos;s listing page size; tokens are listed in full because a
          workspace has few of them.
        </p>
      </Panel>
    </Page>
  );
}

type StateTone = 'lime' | 'amber' | 'danger' | 'dim';

const STATE_CHIP: Record<StateTone, string> = {
  lime: 'border-primary/30 text-primary',
  amber: 'border-amber-500/30 text-amber-600 dark:text-amber-400',
  danger: 'border-destructive/40 text-destructive',
  dim: 'border-border text-muted-foreground',
};

function tokenState(
  token: Token,
  slugById: ReadonlyMap<string, string>,
  memberCount: number,
  nowMs: number,
): { label: string; tone: StateTone } {
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
