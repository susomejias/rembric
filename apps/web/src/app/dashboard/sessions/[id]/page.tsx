import type { Prompt } from '@rembric/db';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { RawBadge, StatusBadge } from '@/components/dashboard/badges';
import { shortId, truncate } from '@/components/dashboard/format';
import { Kv, KvGrid } from '@/components/dashboard/kv-grid';
import { Markdown } from '@/components/dashboard/markdown';
import { Timestamp } from '@/components/dashboard/timestamp';
import { BackLink, ViewHead } from '@/components/dashboard/view-head';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
 * The session detail — a server component reading the same repositories the
 * Hono handler used (`apps/server/src/dashboard/sessions.ts`), so the sections
 * it shows, and the order it shows them in, are the ported contract: metadata,
 * the seed-goal description, the summary, then `Memories (N)` before
 * `Prompts (N)`.
 *
 * The summary's two shapes are both the ported contract: a curated
 * (`summary_final = 1`) summary renders as Markdown, an uncurated one as
 * preformatted text with the RAW badge. React escapes the `<pre>`'s text child,
 * which is the port's equivalent of the retired escaped-`<pre>` boundary
 * (regression #252).
 *
 * Abandon, Delete and Undelete are NOT ported in this slice: all three are
 * mutations and the change's mutation-protection probe has not run, so this
 * view renders their state (status, soft-delete banner, token revoked suffix)
 * and no dead control.
 */
export const dynamic = 'force-dynamic';

export default async function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { repos } = getServices();

  const row = repos.agentSessions.adminGetDetail(id);
  if (!row) notFound();

  const memories = repos.memory.adminListBySession(id);
  const prompts = repos.prompts.adminListBySession(id);

  const detailTitle = titleCascade(row.title, row.description, row.id);

  return (
    <div className="flex flex-col gap-4">
      <ViewHead
        num="03"
        title={detailTitle}
        meta={[
          { k: 'ID', v: <span className="font-mono">{shortId(row.id)}</span> },
          { k: 'STATUS', v: row.status.toUpperCase() },
        ]}
      />

      <BackLink href="/dashboard/sessions" label="BACK TO SESSIONS" />

      {row.deletedAt ? (
        <Card className="border-destructive/50 bg-destructive/5 py-3">
          <CardContent className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="outline" className="border-destructive/50 font-mono text-destructive">
              SOFT-DELETED
            </Badge>
            <span>
              This session was soft-deleted at <Timestamp value={row.deletedAt} />. Memories that
              reference it keep their <code className="font-mono">session_id</code> pointer intact.
            </span>
          </CardContent>
        </Card>
      ) : null}

      <KvGrid>
        <Kv k="Status">
          <StatusBadge status={row.status} />
        </Kv>
        <Kv k="Agent">{row.agent}</Kv>
        <Kv k="Project">{row.projectSlug ?? '—'}</Kv>
        <Kv k="Token">
          {row.tokenName ?? '—'}
          {row.tokenRevokedAt ? (
            <span className="ml-1 text-xs text-muted-foreground">(revoked)</span>
          ) : null}
        </Kv>
        <Kv k="Started">
          <Timestamp value={row.startedAt} />
        </Kv>
        <Kv k="Ended">
          <Timestamp value={row.endedAt} />
        </Kv>
      </KvGrid>

      {row.description ? (
        <Card>
          <CardHeader>
            <CardTitle className="font-mono text-xs tracking-[0.18em] text-muted-foreground uppercase">
              Description (seed goal)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Markdown content={row.description} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 font-mono text-xs tracking-[0.18em] text-muted-foreground uppercase">
            Summary {row.summary && !row.summaryFinal ? <RawBadge /> : null}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {row.summary ? (
            row.summaryFinal ? (
              <Markdown content={row.summary} />
            ) : (
              <pre className="overflow-x-auto rounded-xl border bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
                {row.summary}
              </pre>
            )
          ) : (
            <span className="text-sm text-muted-foreground">—</span>
          )}
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardHeader className="pt-4">
          <CardTitle className="font-mono text-xs tracking-[0.18em] text-muted-foreground uppercase">
            Memories ({memories.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {memories.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">
              No memories anchored to this session.
            </p>
          ) : (
            <Table className="font-sans">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-28 pl-4">type</TableHead>
                  <TableHead>title</TableHead>
                  <TableHead className="w-32">status</TableHead>
                  <TableHead className="w-56 pr-4">created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {memories.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="pl-4 font-mono text-xs text-muted-foreground">
                      {m.type}
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/dashboard/memories/${m.id}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {truncate(m.title, 120)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={m.status} />
                    </TableCell>
                    <TableCell className="pr-4 font-mono text-xs text-muted-foreground">
                      <Timestamp value={m.createdAt} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardHeader className="pt-4">
          <CardTitle className="font-mono text-xs tracking-[0.18em] text-muted-foreground uppercase">
            Prompts ({prompts.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {prompts.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">
              No prompts anchored to this session.
            </p>
          ) : (
            <Table className="font-sans">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-56 pl-4">title</TableHead>
                  <TableHead>content</TableHead>
                  <TableHead className="w-40">tags</TableHead>
                  <TableHead className="w-56 pr-4">created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {prompts.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="pl-4">{promptTitle(p)}</TableCell>
                    <TableCell className="text-xs whitespace-normal text-muted-foreground">
                      {truncate(p.content, 120)}
                    </TableCell>
                    <TableCell>
                      {Array.isArray(p.tags) && p.tags.length > 0 ? (
                        <span className="flex flex-wrap gap-1">
                          {p.tags.map((tag) => (
                            <Badge key={tag} variant="secondary" className="font-mono">
                              {tag}
                            </Badge>
                          ))}
                        </span>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="pr-4 font-mono text-xs text-muted-foreground">
                      <Timestamp value={p.createdAt} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** The prompt title cascade: `title` → truncated content → shortId. */
function promptTitle(p: Prompt): string {
  if (p.title && p.title.length > 0) return p.title;
  const truncated = truncate(p.content, 80);
  return truncated.length > 0 ? truncated : shortId(p.id);
}

/**
 * Derive a human-readable label for a session row: explicit title →
 * description (seed goal) → shortId. Placeholder titles count as real titles —
 * they are still more informative than the bare shortId.
 */
function titleCascade(
  title: string | null | undefined,
  description: string | null | undefined,
  id: string,
): string {
  if (title && title.length > 0) return title;
  if (description && description.length > 0) return description;
  return shortId(id);
}
