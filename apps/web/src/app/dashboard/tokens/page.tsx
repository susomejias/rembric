import { isProjectSetScope, pinnedProjectId, type TokenScope } from '@rembric/core';
import type { Token } from '@rembric/db';

import { EmptyState } from '@/components/dashboard/empty-state';
import { FilterField, FilterSelect } from '@/components/dashboard/filter-bar';
import { shortId } from '@/components/dashboard/format';
import { Timestamp } from '@/components/dashboard/timestamp';
import { ViewHead } from '@/components/dashboard/view-head';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getServices } from '@/lib/services';

/**
 * The tokens list — a server component reading `TokensService` and the tokens
 * repository directly, the same reads the retired Hono view made
 * (`apps/server/src/dashboard/tokens.ts`).
 *
 * Two things this port deliberately does NOT carry over:
 *
 * - The per-row Revoke form and the one-shot plaintext banner. Both need the
 *   create/revoke mutations, which are Server Actions the mutation-protection
 *   probe (design D4, task 2.5) has not yet cleared, so the list renders state
 *   and no dead control — the boundary `../memories/[id]/page.tsx` documents.
 * - A "last used" column. No such datum exists: `tokens` has no `last_used_at`
 *   column, and `UsageCounters` is an in-memory (token, tool) tally with no
 *   timestamp. The two lifecycle columns the retired view rendered — `expires`
 *   and the derived `state` — stand in, because a token's reach without them is
 *   unreadable.
 *
 * The mint form renders its fields, disabled, and no action is wired.
 */
export const dynamic = 'force-dynamic';

export default function TokensPage() {
  const { repos, projects, tokens: tokensService } = getServices();

  const tokens = tokensService.list();
  const nowMs = Date.now();

  // Archived included: a token pinned to an archived project keeps authorizing,
  // so hiding the slug would misreport what it reaches.
  const projectRows = projects.list(true);
  const slugById = new Map(projectRows.map((p) => [p.id, p.slug]));

  // Slug-ascending per token: the repository orders by (token_id, slug).
  const memberSlugs = new Map<string, string[]>();
  for (const m of repos.tokens.adminListProjectSlugs()) {
    const found = memberSlugs.get(m.tokenId);
    if (found) found.push(m.slug);
    else memberSlugs.set(m.tokenId, [m.slug]);
  }

  const rows = tokens.map((token) => {
    const scope = token.scope as TokenScope;
    const members = memberSlugs.get(token.id) ?? [];
    const slug = token.projectId === null ? null : (slugById.get(token.projectId) ?? null);
    return {
      token,
      scope,
      members,
      slug,
      state: tokenState(token, slugById, members.length, nowMs),
    };
  });

  const selectable = projectRows.filter((p) => p.archivedAt === null);

  return (
    <div className="flex flex-col gap-4">
      <ViewHead
        num="07"
        title="Rembric Tokens."
        metaId="tokens-meta"
        meta={[{ k: 'TOTAL', v: String(tokens.length) }]}
      />

      <Card className="border-warn/40 bg-warn/5 py-3">
        <CardContent className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="outline" className="border-warn/50 font-mono text-warn">
            NOT CONNECTED
          </Badge>
          <span>
            Mint and revoke are <b>not wired</b> in this port: the mutation-protection probe has not
            landed yet, so this page renders token state only. The plaintext secret is shown once at
            mint time and never again.
          </span>
        </CardContent>
      </Card>

      <div id="tokens-list" className="flex flex-col gap-3">
        {rows.length === 0 ? (
          <EmptyState>No tokens yet.</EmptyState>
        ) : (
          <Table className="font-sans">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>name</TableHead>
                <TableHead>scope</TableHead>
                <TableHead>project</TableHead>
                <TableHead className="w-56">created</TableHead>
                <TableHead className="w-56">expires</TableHead>
                <TableHead className="w-32">state</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.token.id}>
                  <TableCell className="font-medium">{row.token.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="font-mono">
                      {scopeLabel(row.scope, slugById)}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {row.members.length > 0
                      ? row.members.join(', ')
                      : (row.slug ?? <span className="text-muted-foreground">—</span>)}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    <Timestamp value={row.token.createdAt} />
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    <Timestamp value={row.token.expiresAt} />
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`font-mono ${row.state.tone}`}>
                      {row.state.label}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <Card className="py-4">
        <CardHeader className="px-4">
          <CardTitle className="font-mono text-xs tracking-[0.18em] text-muted-foreground uppercase">
            Create a new token
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-4">
          <form>
            {/* A disabled fieldset is what makes "rendered but not connected"
                true: no control can be focused, typed into or submitted. */}
            <fieldset disabled className="flex flex-col gap-4">
              <FilterField label="NAME" htmlFor="mint-name" className="w-56">
                <Input id="mint-name" name="name" placeholder="claude-laptop" />
              </FilterField>
              <div className="flex flex-col gap-2">
                <span className="font-mono text-[0.66rem] tracking-[0.12em] text-muted-foreground uppercase">
                  Projects (optional)
                </span>
                <div className="flex flex-wrap gap-3">
                  {selectable.length === 0 ? (
                    <span className="text-sm text-muted-foreground">No selectable projects.</span>
                  ) : (
                    selectable.map((p) => (
                      <label key={p.id} className="inline-flex items-center gap-2 text-sm">
                        <input type="checkbox" name="project" value={p.slug} />
                        <span className="font-mono text-xs">{p.slug}</span>
                      </label>
                    ))
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  None selected: ADMIN, every project + dashboard login. One: that project only. Two
                  or more: exactly those, and still not admin.
                </span>
              </div>
              <FilterField label="ACCESS" htmlFor="mint-access" className="w-64">
                <FilterSelect
                  id="mint-access"
                  name="access"
                  value="write"
                  options={[
                    { value: 'write', label: 'write (read and write)' },
                    { value: 'read', label: 'read (read only)' },
                  ]}
                />
              </FilterField>
              <FilterField
                label="EXPIRES (OPTIONAL, ISO 8601)"
                htmlFor="mint-expires"
                className="w-72"
              >
                <Input id="mint-expires" name="expires" placeholder="2027-01-01T00:00:00Z" />
              </FilterField>
              <Button type="submit" size="sm" className="w-fit">
                CREATE
              </Button>
            </fieldset>
          </form>
          <p className="text-sm text-muted-foreground">
            Not yet connected — the mint mutation is a Server Action this port does not wire, so
            submitting would reach no handler.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The scope with its opaque project id resolved to a slug. The retired view
 * interpolated the raw scope; `project:01M2YZ…` as a badge is unreadable and the
 * id is already resolvable here, so the substitution is the only change.
 */
function scopeLabel(scope: TokenScope, slugById: ReadonlyMap<string, string>): string {
  const pinned = pinnedProjectId(scope);
  if (pinned === null) return scope;
  const slug = slugById.get(pinned) ?? shortId(pinned);
  return scope.startsWith('read:project:') ? `read:project:${slug}` : `project:${slug}`;
}

/**
 * The retired view's `stateOf`, unchanged: revoked and expired are terminal,
 * `inert` is a pin that resolves to no live project, `no projects` is an empty
 * set (repairable, unlike `inert`), and everything else is active.
 */
function tokenState(
  token: Token,
  slugById: ReadonlyMap<string, string>,
  memberCount: number,
  nowMs: number,
): { label: string; tone: string } {
  if (token.revokedAt) return { label: 'revoked', tone: 'text-muted-foreground' };
  if (token.expiresAt && token.expiresAt.getTime() <= nowMs) {
    return { label: 'expired', tone: 'text-muted-foreground' };
  }
  const scope = token.scope as TokenScope;
  const pinned = pinnedProjectId(scope);
  if (pinned !== null && !slugById.has(pinned)) {
    return { label: 'inert', tone: 'border-warn/50 text-warn' };
  }
  if (isProjectSetScope(scope) && memberCount === 0) {
    return { label: 'no projects', tone: 'border-warn/50 text-warn' };
  }
  return { label: 'active', tone: 'border-primary/50 text-brand-accent' };
}
