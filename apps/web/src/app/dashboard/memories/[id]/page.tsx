import { annotationKindFor, compareAnnotations, deriveReviewState } from '@rembric/core';
import type { Memory } from '@rembric/db';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ReviewBadge, StatusBadge, VerdictBadge } from '@/components/dashboard/badges';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { getServices } from '@/lib/services';

/**
 * The memory detail hub: Card + Tabs + state badge (design D10). A server
 * component reading the same service and repositories the Hono handler used
 * (`apps/server/src/dashboard/memories.ts`), so the sections it shows, and the
 * order it shows them in, are the ported contract — nothing new is derived here.
 *
 * The Confirm and Archive verbs are NOT ported in this slice: both are mutations,
 * and the change's mutation-protection probe (design D4, task 2.5) has not run
 * yet, so their form boundary is a decision this view must not pre-empt. The
 * detail renders their *state* — review state, review-after date, confirmation
 * count, lifecycle status — and no dead control.
 *
 * Each `TabsContent` is `forceMount`ed and hides itself with
 * `data-[state=inactive]:hidden`: the server HTML then carries every section
 * (Radix marks the inactive panels `data-state="inactive"`), so the lineage and
 * judgment data is in the response a test or a crawler reads, while CSS — not
 * JavaScript — keeps exactly one panel visible. Without the `forceMount`, Radix
 * omits the inactive panels from the server render entirely.
 */
export const dynamic = 'force-dynamic';

export default async function MemoryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { memory, repos } = getServices();

  const row = memory.unsafeGetById(id);
  if (!row) notFound();

  const project = row.projectId ? repos.projects.adminFindById(row.projectId) : undefined;
  // `adminGetByIds` has no ORDER BY; sorting restores the chronological contract.
  const predecessors = repos.memory
    .adminGetByIds(row.replaces)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const confirmCount = repos.memory.adminCountConfirmations(row.id);
  const reviewTimestamps = repos.memory.reviewTimestampsByIds([row.id]).get(row.id);
  const { reviewState, reviewAfter } = deriveReviewState(
    {
      type: row.type,
      createdAt: row.createdAt,
      status: row.status,
      lastConfirmedAt: reviewTimestamps?.affirmedAt ?? null,
      lastRefutedAt: reviewTimestamps?.refutedAt ?? null,
    },
    new Date(),
  );
  const successor = row.status === 'superseded' ? repos.memory.findSuccessorId(row.id) : undefined;

  // Uncapped and unpaginated on purpose: the `memory` capability promises the
  // annotations its MCP bound withholds stay visible here, and this is the only
  // per-memory judgment view the dashboard has. Ordered by the shared
  // comparator — not a second ordering rule.
  const touching = repos.relations
    .adminListTouching(row.id)
    .map((relation) => ({ relation, kind: annotationKindFor(relation, row.id) }))
    .sort((a, b) =>
      compareAnnotations({ ...a.relation, kind: a.kind }, { ...b.relation, kind: b.kind }),
    );

  const projectLabel = project?.slug ?? '—';

  return (
    <div className="flex flex-col gap-4">
      <ViewHead
        num="02"
        title={row.title}
        meta={[
          { k: 'ID', v: <span className="font-mono">{shortId(row.id)}</span> },
          { k: 'STATUS', v: row.status.toUpperCase() },
          { k: 'PROJECT', v: projectLabel },
        ]}
      />

      <div className="flex flex-wrap items-center gap-3">
        <BackLink href="/dashboard/memories" label="BACK TO MEMORIES" />
        <StatusBadge status={row.status} />
        {reviewState === 'needs_review' ? <ReviewBadge /> : null}
      </div>

      {reviewState === 'needs_review' ? (
        <Card className="border-warn/50 bg-warn/5 py-3">
          <CardContent className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="outline" className="border-warn/50 font-mono text-warn">
              NEEDS REVIEW
            </Badge>
            <span>
              This memory hasn&apos;t been re-affirmed since <Timestamp value={reviewAfter} />.
              Re-affirming it with <code className="font-mono">memory.confirm</code> moves it back
              to <code className="font-mono">fresh</code>.
            </span>
          </CardContent>
        </Card>
      ) : null}

      <Tabs defaultValue="overview" className="gap-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="lineage">
            Lineage ({predecessors.length + row.replaces.length})
          </TabsTrigger>
          <TabsTrigger value="judgments">Judgments ({touching.length})</TabsTrigger>
        </TabsList>

        <TabsContent
          value="overview"
          forceMount
          className="flex flex-col gap-4 data-[state=inactive]:hidden"
        >
          <KvGrid>
            <Kv k="Status">
              <StatusBadge status={row.status} />
            </Kv>
            <Kv k="Project">{projectLabel}</Kv>
            <Kv k="Type">{row.type}</Kv>
            <Kv k="Confirms">{confirmCount}</Kv>
            <Kv k="Created">
              <Timestamp value={row.createdAt} />
            </Kv>
            <Kv k="Last seen">
              <Timestamp value={row.lastSeenAt} />
            </Kv>
            <Kv k="Source">{sourceLine(row.source)}</Kv>
            <Kv k="Session">
              {row.sessionId ? (
                <Link
                  href={`/dashboard/sessions/${row.sessionId}`}
                  className="font-mono underline-offset-4 hover:underline"
                >
                  {shortId(row.sessionId)}
                </Link>
              ) : (
                '—'
              )}
            </Kv>
            {successor ? (
              <Kv k="Superseded by">
                <Link
                  href={`/dashboard/memories/${successor}`}
                  className="font-mono underline-offset-4 hover:underline"
                >
                  {shortId(successor)}
                </Link>
              </Kv>
            ) : null}
            {reviewState !== null && reviewAfter !== null ? (
              <>
                <Kv k="Review">{reviewState === 'needs_review' ? <ReviewBadge /> : 'fresh'}</Kv>
                <Kv k="Review after" mono>
                  <Timestamp value={reviewAfter} />
                </Kv>
              </>
            ) : null}
          </KvGrid>

          <Card>
            <CardHeader>
              <CardTitle className="font-mono text-xs tracking-[0.18em] text-muted-foreground uppercase">
                Content
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Markdown content={row.content} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="font-mono text-xs tracking-[0.18em] text-muted-foreground uppercase">
                Tags
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {row.tags.length === 0 ? (
                <span className="text-sm text-muted-foreground">—</span>
              ) : (
                row.tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="font-mono">
                    {tag}
                  </Badge>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent
          value="lineage"
          forceMount
          className="flex flex-col gap-4 data-[state=inactive]:hidden"
        >
          <Card>
            <CardHeader>
              <CardTitle className="font-mono text-xs tracking-[0.18em] text-muted-foreground uppercase">
                Replaces
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {row.replaces.length === 0 ? (
                <span className="text-sm text-muted-foreground">—</span>
              ) : (
                row.replaces.map((replacedId) => (
                  <Link
                    key={replacedId}
                    href={`/dashboard/memories/${replacedId}`}
                    className="font-mono text-xs underline-offset-4 hover:underline"
                  >
                    {replacedId}
                  </Link>
                ))
              )}
            </CardContent>
          </Card>

          {predecessors.length > 0 ? (
            <Card className="py-0">
              <CardHeader className="pt-4">
                <CardTitle className="font-mono text-xs tracking-[0.18em] text-muted-foreground uppercase">
                  Predecessors ({predecessors.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="px-0 pb-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-32 pl-4">status</TableHead>
                      <TableHead>title</TableHead>
                      <TableHead>content</TableHead>
                      <TableHead className="w-56 pr-4">created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {predecessors.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="pl-4">
                          <StatusBadge status={p.status} />
                        </TableCell>
                        <TableCell>
                          <Link
                            href={`/dashboard/memories/${p.id}`}
                            className="underline-offset-4 hover:underline"
                          >
                            {truncate(p.title, 120)}
                          </Link>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {truncate(p.content, 160)}
                        </TableCell>
                        <TableCell className="pr-4 font-mono text-xs text-muted-foreground">
                          <Timestamp value={p.createdAt} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : null}
        </TabsContent>

        <TabsContent value="judgments" forceMount className="data-[state=inactive]:hidden">
          {touching.length === 0 ? (
            <Card className="py-3">
              <CardContent className="text-sm text-muted-foreground">
                No judgments touch this memory.
              </CardContent>
            </Card>
          ) : (
            <Card className="py-0">
              <CardContent className="px-0 py-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-40 pl-4">kind</TableHead>
                      <TableHead className="w-28">status</TableHead>
                      <TableHead>counterpart</TableHead>
                      <TableHead className="w-56 pr-4">timestamp</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {touching.map(({ relation, kind }) => {
                      const isSource = relation.sourceId === row.id;
                      const counterpartId = isSource ? relation.targetId : relation.sourceId;
                      const counterpartTitle = isSource
                        ? relation.targetTitle
                        : relation.sourceTitle;
                      // `kind`, not `relation`: the column shows what the rows are
                      // sorted by, from this memory's point of view.
                      return (
                        <TableRow key={relation.id}>
                          <TableCell className="pl-4">
                            <VerdictBadge kind={kind} />
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={relation.status} />
                          </TableCell>
                          <TableCell className="text-xs">
                            <Link
                              href={`/dashboard/memories/${counterpartId}`}
                              className="underline-offset-4 hover:underline"
                            >
                              {truncate(counterpartTitle, 80)}
                            </Link>
                          </TableCell>
                          <TableCell className="pr-4 font-mono text-xs text-muted-foreground">
                            <Link
                              href={`/dashboard/judgments/${relation.id}`}
                              className="underline-offset-4 hover:underline"
                            >
                              <Timestamp value={relation.judgedAt ?? relation.createdAt} />
                            </Link>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** `sourceLine` from the retired view, unchanged: the three reported facets, or a dash. */
function sourceLine(source: Memory['source']): string {
  if (!source) return '—';
  const parts = [
    source.agent ? `agent: ${source.agent}` : null,
    source.tokenName ? `token: ${source.tokenName}` : null,
    source.model ? `model: ${source.model}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' · ') : '—';
}
