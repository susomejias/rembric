import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Placeholder for the overview view. Phase 15 of
 * `redesign-dashboard-identity-and-port` replaces this file with the
 * `dashboard-01` composition; until then it exists so the shell has a route to
 * render and so the theme, the fonts and the glass layer are observable.
 */
export default function DashboardPage() {
  return (
    <>
      <div className="flex flex-col gap-1">
        <p className="font-mono text-xs tracking-[0.18em] text-brand-accent uppercase">
          Rembric operator surface
        </p>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          The dashboard shell is in place: collapsible sidebar, glass chrome and the theme tokens.
          The views are ported one route per commit, starting with memories.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Sidebar</CardDescription>
            <CardTitle>Collapsible, persisted</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Collapses to icons on desktop; below the tablet band the same provider opens a sheet.
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Identity</CardDescription>
            <CardTitle>
              Liquid glass
              <Badge variant="secondary" className="ml-2 align-middle">
                identity A
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            The sidebar and header are one glass layer over the light content surface.
          </CardContent>
        </Card>

        <Card className="glass-chrome border">
          <CardHeader>
            <CardDescription>Glass surface</CardDescription>
            <CardTitle>Backdrop-filter</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Opaque fallback applies where <code className="font-mono">backdrop-filter</code> is
            unsupported.
          </CardContent>
        </Card>
      </div>
    </>
  );
}
