import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

/**
 * The 404 every dashboard view falls through to. `memories/[id]/page.tsx` calls
 * `notFound()` for an unknown id (the retired view answered 404 there too), and
 * any path with no route lands here — including the views this branch has not
 * ported yet, whose sidebar entries point at URLs that only `apps/server`
 * answers today.
 *
 * It lives at the app root rather than under `dashboard/` on purpose: Next
 * renders the nearest `not-found.tsx` to the segment that failed, and a root
 * sibling covers both a dashboard route and a path that never matched the
 * dashboard subtree at all. One consequence is disclosed rather than hidden —
 * the root layout carries no shell, so this page renders without the sidebar.
 */
export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-svh w-full max-w-xl flex-col justify-center gap-6 p-6">
      <div className="flex items-center gap-3">
        <Badge variant="outline" className="font-mono text-muted-foreground">
          404
        </Badge>
        <span className="font-mono text-xs tracking-[0.18em] text-muted-foreground uppercase">
          Rembric · Nothing here
        </span>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="font-display text-2xl font-semibold tracking-tight">
              <span className="text-brand-accent">Page</span> not found.
            </h1>
            <p className="text-sm text-muted-foreground">
              This route does not exist, or the row it named is gone. Memories are append-only, so
              an id that used to resolve can only disappear through a purge.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/dashboard">OVERVIEW</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/dashboard/memories">MEMORIES</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href="/dashboard/consolidation">CONSOLIDATION</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
