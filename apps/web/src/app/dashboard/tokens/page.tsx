import { isProjectSetScope, pinnedProjectId, type TokenScope } from '@rembric/core';
import type { Token } from '@rembric/db';

import { singleParam } from '@/components/dashboard/support';
import {
  Chip,
  DataBody,
  DataHead,
  DataTable,
  DataTd,
  DataTh,
  DataTr,
  LABEL,
  Notice,
  Page,
  Pill,
  SectionBar,
  TableEmpty,
  Time,
  ViewHead,
} from '@/components/dashboard/ui';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { getServices } from '@/lib/services';

/**
 * The tokens list, in the production dashboard's composition: the view head, the
 * one-shot plaintext panel the create redirect lands on, the credential table,
 * and the mint form with its project set, access verb and expiry.
 *
 * The reads are the ported view's own (`TokensService.list`, the project set
 * tables, the archived-inclusive project list) and so is the state derivation —
 * revoked, expired, inert (pinned to a deleted project), no projects, active.
 *
 * Create and Revoke are still NOT wired: both are mutations whose handler is a
 * separate slice. The mint form renders main's fields, all disabled, and no
 * control submits. The plaintext panel is read off the URL the create redirect
 * would carry, so it renders only for a hand-crafted `?created=…`.
 */
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

export default async function TokensPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const justCreated = singleParam(params.created);
  const mintedName = singleParam(params.name);

  const { repos, projects, tokens: tokensService } = getServices();
  const nowMs = Date.now();

  const tokens = tokensService.list();

  // Archived included: a token pinned to an archived project keeps
  // authorizing, so hiding the slug would misreport what it reaches.
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

  const selectable = projectRows.filter((p) => p.archivedAt === null);

  // Read back off the persisted row, not off the query string: the panel
  // states what was minted, not what the caller asked for.
  const minted = tokens.find((t) => t.name === mintedName);
  const mintedSlug = minted?.projectId == null ? null : (slugById.get(minted.projectId) ?? null);
  const mintedMembers = minted ? (memberSlugs.get(minted.id) ?? []) : [];

  return (
    <Page>
      <ViewHead
        num="07"
        title="Rembric Tokens."
        hl="Rembric"
        meta={[{ k: 'TOTAL', v: rows.length }]}
      />

      <Notice tone="amber" badge="Not connected" className="mt-6">
        Create and revoke are not wired in this port: both are mutations whose handler is a separate
        slice. This page renders credential state only, and the mint form submits nothing.
      </Notice>

      {justCreated ? (
        <div className="mt-6 border border-primary/40 bg-card p-5">
          <p className="text-sm">
            <strong className="font-semibold">New token created.</strong> This is the only time the
            plaintext is shown — copy it now:
          </p>
          <pre className="mt-3 overflow-x-auto border border-border bg-background px-3 py-2 font-mono text-xs">
            {justCreated}
          </pre>
          {minted ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Scope <code className="font-mono">{minted.scope}</code> —{' '}
              {mintedMembers.length > 0 ? (
                <>
                  reaches <strong className="font-semibold">{mintedMembers.join(', ')}</strong>.
                </>
              ) : mintedSlug ? (
                <>
                  bound to project <strong className="font-semibold">{mintedSlug}</strong>.
                </>
              ) : (
                'bound to no project.'
              )}
            </p>
          ) : null}
          <p className="mt-3 text-xs text-muted-foreground">
            Paste into your agent&apos;s MCP config under{' '}
            <code className="font-mono">
              headers.Authorization: &quot;Bearer {justCreated.slice(0, 6)}…&quot;
            </code>
            .
          </p>
        </div>
      ) : null}

      <div className="mt-8">
        <SectionBar name="Existing" />
        {rows.length === 0 ? (
          <TableEmpty>No tokens yet.</TableEmpty>
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
                  <DataTd>{token.name}</DataTd>
                  <DataTd>{scopeBadge(scope)}</DataTd>
                  <DataTd className="text-muted-foreground">
                    {members.length > 0 ? members.join(', ') : (slug ?? '—')}
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
                    {token.revokedAt ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled
                        title="Token revocation lands with the tokens Server Action"
                      >
                        Revoke
                      </Button>
                    )}
                  </DataTd>
                </DataTr>
              ))}
            </DataBody>
          </DataTable>
        )}
      </div>

      <div className="mt-8">
        <SectionBar name="Create a new token" />
        <form className="flex max-w-[480px] flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="token-name" className={`${LABEL} text-muted-foreground`}>
              Name
            </Label>
            <Input id="token-name" name="name" disabled placeholder="claude-laptop" />
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className={`${LABEL} text-muted-foreground`}>Projects (optional)</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {selectable.map((project) => (
                <div key={project.id} className="flex items-center gap-2">
                  <Checkbox
                    id={`token-project-${project.id}`}
                    name="project"
                    value={project.slug}
                    disabled
                  />
                  <Label
                    htmlFor={`token-project-${project.id}`}
                    className="font-mono text-xs font-normal"
                  >
                    {project.slug}
                  </Label>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              None selected: ADMIN, every project + dashboard login. One: that project only. Two or
              more: exactly those, and still not admin.
            </p>
          </fieldset>

          <div className="flex flex-col gap-2">
            <Label htmlFor="token-access" className={`${LABEL} text-muted-foreground`}>
              Access
            </Label>
            <Select name="access" defaultValue="write" disabled>
              <SelectTrigger id="token-access" className="w-full">
                <SelectValue>write (read and write)</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="write">write (read and write)</SelectItem>
                  <SelectItem value="read">read (read only)</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="token-expires" className={`${LABEL} text-muted-foreground`}>
              Expires (optional, ISO 8601)
            </Label>
            <Input id="token-expires" name="expires" disabled placeholder="2027-01-01T00:00:00Z" />
          </div>

          <div>
            <Button type="submit" disabled title="Token minting is wired in a later slice">
              Create
            </Button>
          </div>
        </form>
      </div>
    </Page>
  );
}

function scopeBadge(scope: TokenScope) {
  if (scope === '*' || scope === 'read:*' || isProjectSetScope(scope)) {
    return <Chip>{scope}</Chip>;
  }
  return <code className="font-mono text-xs">{scope}</code>;
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
