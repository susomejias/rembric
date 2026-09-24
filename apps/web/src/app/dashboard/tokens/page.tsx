import { DomainError, isProjectSetScope, pinnedProjectId, type TokenScope } from '@rembric/core';
import type { Token } from '@rembric/db';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { ActionForm, type ActionState } from '@/components/dashboard/action-form';
import { CsrfField } from '@/components/dashboard/csrf-field';
import { singleParam } from '@/components/dashboard/support';
import { TokensTable } from '@/components/dashboard/tokens-table';
import { LABEL, Page, SectionBar } from '@/components/dashboard/ui';
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
import { guardAction, guardFailure } from '@/lib/actions/guard';
import { getServices } from '@/lib/services';
import { dashboardCsrfToken } from '@/lib/session';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

const CREATE_FORM = 'token.create';
const REVOKE_FORM = 'token.revoke';
const BULK_REVOKE_FORM = 'token.bulk-revoke';
const TOKEN_PAGE_SIZE = 10;

async function createToken(_prev: ActionState, formData: FormData): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, CREATE_FORM);
  if (!guard.ok) return guardFailure(guard);

  const name = readField(formData, 'name');
  const projectInputs = [
    ...new Set(
      formData
        .getAll('project')
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter((value) => value.length > 0),
    ),
  ];
  const accessInput = readField(formData, 'access');
  const expiresInput = readField(formData, 'expires');

  if (formData.has('scope')) {
    return {
      error:
        "The 'scope' field was retired. Reach comes from 'project' (empty = every project) " +
        "and the verb from 'access' ('write' or 'read'): scope=* is access=write, " +
        'scope=read:* is access=read.',
    };
  }

  if (!name) return { error: 'Name is required.' };

  if (accessInput !== 'read' && accessInput !== 'write') {
    return { error: "Access must be 'write' or 'read'." };
  }
  const access = accessInput;

  let expiresAt: Date | null = null;
  if (expiresInput) {
    const parsed = new Date(expiresInput);
    if (Number.isNaN(parsed.getTime())) {
      return { error: `Invalid expires timestamp '${expiresInput}'.` };
    }
    expiresAt = parsed;
  }

  const [firstSlug, ...restSlugs] = projectInputs;

  let secret: { plaintext: string };
  try {
    secret =
      firstSlug === undefined
        ? guard.services.tokens.create({
            name,
            scope: access === 'read' ? 'read:*' : '*',
            expiresAt,
          })
        : guard.services.tokens.createForSlugs(
            { name, slugs: [firstSlug, ...restSlugs], access, expiresAt },
            guard.services.projects,
          );
  } catch (err) {
    if (err instanceof DomainError) return { error: err.message };
    throw err;
  }
  const query = new URLSearchParams({ created: secret.plaintext, name });
  redirect(`/dashboard/tokens?${query.toString()}`);
}

async function revokeToken(_prev: ActionState, formData: FormData): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, REVOKE_FORM);
  if (!guard.ok) return guardFailure(guard);

  try {
    guard.services.tokens.revoke(readField(formData, 'name'));
  } catch (err) {
    if (err instanceof DomainError) return { error: err.message };
    throw err;
  }
  redirect('/dashboard/tokens');
}

async function bulkRevokeTokens(_prev: ActionState, formData: FormData): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, BULK_REVOKE_FORM);
  if (!guard.ok) return guardFailure(guard);

  const names = formData
    .getAll('name')
    .filter((value): value is string => typeof value === 'string');
  try {
    for (const name of names) {
      guard.services.tokens.revoke(name);
    }
  } catch (err) {
    if (err instanceof DomainError) return { error: err.message };
    throw err;
  }
  revalidatePath('/dashboard/tokens');
  return { error: null };
}

function readField(form: FormData, name: string): string {
  const value = form.get(name);
  return (typeof value === 'string' ? value : '').trim();
}

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
  const csrf = {
    revoke: await dashboardCsrfToken(REVOKE_FORM),
    bulkRevoke: await dashboardCsrfToken(BULK_REVOKE_FORM),
  };

  const tokens = tokensService.list();

  const projectRows = projects.list(true);
  const slugById = new Map(projectRows.map((p) => [p.id, p.slug]));

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

  const minted = tokens.find((t) => t.name === mintedName);
  const mintedSlug = minted?.projectId == null ? null : (slugById.get(minted.projectId) ?? null);
  const mintedMembers = minted ? (memberSlugs.get(minted.id) ?? []) : [];

  return (
    <Page>
      <header className="min-w-0">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Tokens</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {`${rows.length} tokens · ${activeCount} active`}
        </p>
      </header>

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
        <SectionBar name="Existing" meta={`${rows.length} ROWS`} />
        <TokensTable
          rows={rows.map(({ token, scope, members, slug, state }) => ({
            id: token.id,
            name: token.name,
            scope,
            project: members.length > 0 ? members.join(', ') : (slug ?? '—'),
            createdAt: token.createdAt,
            expiresAt: token.expiresAt,
            state: state.label,
            stateTone: state.tone,
            revoked: token.revokedAt !== null,
          }))}
          actions={{ revoke: revokeToken, bulkRevoke: bulkRevokeTokens }}
          csrf={csrf}
          selectable
          searchable
          pageSize={TOKEN_PAGE_SIZE}
        />
      </div>

      <div className="mt-8">
        <SectionBar name="Create a new token" />
        <ActionForm action={createToken} className="flex max-w-[480px] flex-col gap-4">
          <CsrfField form={CREATE_FORM} />
          <div className="flex flex-col gap-2">
            <Label htmlFor="token-name" className={`${LABEL} text-muted-foreground`}>
              Name
            </Label>
            <Input id="token-name" name="name" required placeholder="claude-laptop" />
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
            <Select name="access" defaultValue="write">
              <SelectTrigger id="token-access" className="w-full">
                <SelectValue placeholder="select access" />
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
            <Input id="token-expires" name="expires" placeholder="2027-01-01T00:00:00Z" />
          </div>

          <div>
            <Button type="submit">Create</Button>
          </div>
        </ActionForm>
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
