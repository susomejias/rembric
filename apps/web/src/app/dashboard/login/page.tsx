import Link from 'next/link';

import { LOGIN_CLIENTS, safeNext } from './clients';

import { singleParam } from '@/components/dashboard/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { REMBRIC_VERSION } from '@/lib/version';

/**
 * The login page — the `login-01` split composition with the Rembric brand mark
 * in place of the registry's product name.
 *
 * The form is a plain `POST` to `/dashboard/login`, the endpoint that validates
 * the admin token, enforces scope `*` and sets the signed session cookie. It is
 * NOT a Server Action: the retired form posted to that same path, that path's
 * handler owns the cookie attributes and the lockout, and a Server Action would
 * have to re-implement the session mint inside this view. Every rejection
 * (missing token, invalid token, too many attempts) is rendered by that handler,
 * exactly as before.
 *
 * One structural divergence, disclosed rather than hidden: `dashboard/layout.tsx`
 * mounts the operator shell for every route under `/dashboard`, so this page
 * covers the viewport to keep the login screen chrome-free. The structural fix is
 * moving the route into an auth route group (or out of `dashboard/`), which is
 * outside this slice's edit surface — no layout can opt out of its parent.
 */
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

export default async function LoginPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const next = safeNext(singleParam(params.next));

  return (
    <div className="fixed inset-0 z-50 grid min-h-svh overflow-y-auto bg-background lg:grid-cols-2">
      <div className="hidden flex-col justify-between gap-8 p-10 lg:flex">
        <div className="flex items-center gap-3">
          <img
            src="/dashboard/assets/logo-transparent.png"
            alt=""
            aria-hidden="true"
            className="size-9"
          />
          <div className="flex flex-col gap-1 font-mono text-xs tracking-[0.18em] text-muted-foreground uppercase">
            <span>REMBRIC</span>
            <span>v{REMBRIC_VERSION}</span>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <h1 className="font-display text-4xl font-semibold tracking-tight">
            <span className="text-brand-accent">REMBRIC</span>
            <br />
            DASHBOARD<span className="text-brand-accent">.</span>
          </h1>
          <p className="max-w-md text-sm text-muted-foreground">
            Persistent memory layer for your agents. Single user, single SQLite file, single control
            window. No onboarding — only the <span className="text-brand-accent">admin token</span>{' '}
            with scope <code className="font-mono">*</code>.
          </p>
        </div>

        <ul className="flex flex-wrap gap-x-6 gap-y-2 font-mono text-xs tracking-[0.18em] text-muted-foreground uppercase">
          {LOGIN_CLIENTS.map((client) => (
            <li key={client} className="flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
              {client}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col items-center justify-center gap-6 p-6 md:p-10">
        <div className="flex w-full max-w-sm flex-col gap-6">
          <Link href="/dashboard" className="flex items-center gap-2 self-center font-medium">
            <img
              src="/dashboard/assets/logo-transparent.png"
              alt=""
              aria-hidden="true"
              className="size-6 lg:hidden"
            />
            <span className="font-mono text-xs tracking-[0.18em] uppercase">REMBRIC</span>
            <Badge variant="outline" className="font-mono text-muted-foreground">
              v{REMBRIC_VERSION}
            </Badge>
          </Link>

          <Card>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <h2 className="font-display text-xl font-semibold">Sign in</h2>
                <p className="text-sm text-muted-foreground">
                  Only the admin token with scope <code className="font-mono">*</code> opens the
                  dashboard.
                </p>
              </div>

              <form action="/dashboard/login" method="post" className="flex flex-col gap-4">
                {next ? <input type="hidden" name="next" value={next} /> : null}
                <div className="flex flex-col gap-2">
                  <Label htmlFor="token">Admin token</Label>
                  <Input
                    id="token"
                    name="token"
                    type="password"
                    autoComplete="off"
                    required
                    autoFocus
                    placeholder="rbr_********************"
                    className="h-10"
                  />
                </div>
                <Button type="submit" size="lg" className="w-full">
                  SIGN IN →
                </Button>
              </form>
            </CardContent>
          </Card>

          <p className="text-center text-xs text-balance text-muted-foreground">
            The token is stored hashed; the session cookie it mints lasts 7 days.
          </p>
        </div>
      </div>
    </div>
  );
}
