import { SLUG_REGEX } from '@rembric/core';
import Link from 'next/link';

import { projectsQuery, readProjectsFilters, type SearchParams } from './filters';

import { StatusBadge } from '@/components/dashboard/badges';
import { EmptyState } from '@/components/dashboard/empty-state';
import { FilterBar, FilterField, FilterSelect } from '@/components/dashboard/filter-bar';
import { PAGE_SIZE, queryWithPage } from '@/components/dashboard/format';
import { Pager } from '@/components/dashboard/pager';
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
 * The projects list — a server component reading `ProjectsService` directly, so
 * every filter and the page index come from the URL and the server does the
 * filtering. Same shape as `../memories/page.tsx`; the retired Hono view this
 * ports is `apps/server/src/dashboard/projects.ts`.
 *
 * The retired view rendered two tables (active + archived) and a per-row action
 * cluster (rename / archive / unarchive). The port collapses the two tables into
 * one `status`-filtered table and renders the lifecycle as a badge: every one of
 * those verbs is a mutation, and the change's mutation-protection probe (design
 * D4, task 2.5) has not run, so this view shows state and no dead control — the
 * same boundary `../memories/[id]/page.tsx` documents. The create form renders
 * its fields, disabled, and no action is wired.
 */
export const dynamic = 'force-dynamic';

const STATUS_OPTIONS = [
  { value: 'all', label: 'all statuses' },
  { value: 'active', label: 'active' },
  { value: 'archived', label: 'archived' },
] as const;

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const filters = readProjectsFilters(params);
  // The params the pager and the filter form round-trip, as the browser sent
  // them (minus `page`).
  const roundTripQuery = projectsQuery(params);
  const filterKey = queryWithPage(roundTripQuery, 0);

  const { projects } = getServices();
  // One read for every status: the retired view read both lists anyway, and the
  // table is small enough that a status-specific query would be a second rule.
  const all = projects.list(true);
  const activeCount = all.filter((p) => p.archivedAt === null).length;
  const archivedCount = all.length - activeCount;

  // `status` is untrusted text, not the enum: an unrecognised value filters to
  // NOTHING rather than silently widening back to `all`.
  const filtered =
    filters.status === 'all'
      ? all
      : filters.status === 'active'
        ? all.filter((p) => p.archivedAt === null)
        : filters.status === 'archived'
          ? all.filter((p) => p.archivedAt !== null)
          : [];

  const offset = filters.page * PAGE_SIZE;
  const visible = filtered.slice(offset, offset + PAGE_SIZE);
  const hasMore = offset + PAGE_SIZE < filtered.length;
  const total = filtered.length;

  return (
    <div className="flex flex-col gap-4">
      <ViewHead
        num="06"
        title="Rembric Projects."
        metaId="projects-meta"
        meta={[
          { k: 'ACTIVE', v: String(activeCount) },
          { k: 'ARCHIVED', v: String(archivedCount) },
        ]}
      />

      <p className="text-sm text-muted-foreground">
        A project is identified by its slug (the value passed via{' '}
        <code className="font-mono">/mcp/&lt;slug&gt;</code> or{' '}
        <code className="font-mono">project.use({'{slug}'})</code>).
      </p>

      <Card className="border-warn/40 bg-warn/5 py-3">
        <CardContent className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="outline" className="border-warn/50 font-mono text-warn">
            NOT CONNECTED
          </Badge>
          <span>
            Rename, archive, unarchive and create are <b>not wired</b> in this port: the
            mutation-protection probe has not landed yet, so this page renders lifecycle state only.
          </span>
        </CardContent>
      </Card>

      {/* Remounted whenever the filter set changes, so the uncontrolled controls
          re-seed from the URL on a soft navigation (e.g. CLEAR). */}
      <FilterBar key={filterKey} action="/dashboard/projects">
        <FilterField label="STATUS" htmlFor="f-status" className="w-40">
          <FilterSelect
            id="f-status"
            name="status"
            value={filters.status}
            options={STATUS_OPTIONS}
          />
        </FilterField>
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm">
            FILTER
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/projects">CLEAR</Link>
          </Button>
        </div>
      </FilterBar>

      <div id="projects-list" className="flex flex-col gap-3">
        {visible.length === 0 ? (
          <EmptyState>No projects match this filter.</EmptyState>
        ) : (
          <Table className="font-sans">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>name</TableHead>
                <TableHead>slug</TableHead>
                <TableHead className="w-32">status</TableHead>
                <TableHead className="w-56">created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">
                    <span className="inline-flex flex-wrap items-center gap-2">
                      {p.label}
                      {p.isDefault ? (
                        <Badge
                          variant="outline"
                          className="border-primary/50 font-mono text-brand-accent"
                        >
                          default
                        </Badge>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    <span className="inline-flex flex-wrap items-center gap-2">
                      {p.slug}
                      {!SLUG_REGEX.test(p.slug) ? (
                        <Badge variant="outline" className="border-warn/50 font-mono text-warn">
                          legacy
                        </Badge>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={p.archivedAt === null ? 'active' : 'archived'} />
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    <Timestamp value={p.createdAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Pager
          page={filters.page}
          hasMore={hasMore}
          total={total}
          totalLabel={`${visible.length} ROWS`}
          path="/dashboard/projects"
          query={roundTripQuery}
        />
      </div>

      <Card className="py-4">
        <CardHeader className="px-4">
          <CardTitle className="font-mono text-xs tracking-[0.18em] text-muted-foreground uppercase">
            Create project
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4">
          <form>
            {/* A disabled fieldset is what makes "rendered but not connected"
                true: no control can be focused, typed into or submitted, so
                there is no dead control that looks live. */}
            <fieldset disabled className="flex flex-wrap items-end gap-3">
              <FilterField label="SLUG" htmlFor="new-slug" className="w-56">
                <Input
                  id="new-slug"
                  name="slug"
                  placeholder="my-project"
                  pattern="[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?"
                />
              </FilterField>
              <FilterField label="DISPLAY NAME" htmlFor="new-display-name" className="w-56">
                <Input
                  id="new-display-name"
                  name="displayName"
                  placeholder="display name (optional)"
                />
              </FilterField>
              <Button type="submit" size="sm">
                CREATE PROJECT
              </Button>
            </fieldset>
          </form>
          <p className="mt-3 text-sm text-muted-foreground">
            Not yet connected — the create mutation is a Server Action this port does not wire, so
            submitting would reach no handler.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
