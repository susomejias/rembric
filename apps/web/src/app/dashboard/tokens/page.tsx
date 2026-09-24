import { DomainError, isProjectSetScope, pinnedProjectId, type TokenScope } from '@rembric/core';
import type { Token } from '@rembric/db';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import type { ActionState } from '@/components/dashboard/action-form';
import { PageHelp } from '@/components/dashboard/page-help';
import { singleParam } from '@/components/dashboard/support';
import { CopyPlaintextButton, CreateTokenSheet } from '@/components/dashboard/tokens-sheet';
import { TokensTable } from '@/components/dashboard/tokens-table';
import { Page, SectionBar } from '@/components/dashboard/ui';
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
    create: await dashboardCsrfToken(CREATE_FORM),
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
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">Tokens</h1>
            <PageHelp text="Bearer credentials agents use to reach this memory." />
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {`${rows.length} tokens · ${activeCount} active`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <CreateTokenSheet action={createToken} csrf={csrf.create} projects={selectable} />
        </div>
      </header>

      {justCreated ? (
        <div className="mt-6 rounded-2xl border border-primary/40 bg-primary/10 p-5">
          <p className="text-sm">
            <strong className="font-semibold">New token created.</strong> This is the only time the
            plaintext is shown — copy it now:
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <code className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs">
              {justCreated}
            </code>
            <CopyPlaintextButton value={justCreated} />
          </div>
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
