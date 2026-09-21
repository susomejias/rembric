import { LOGIN_CLIENTS, loginErrorMessage, safeNext } from './clients';

import { singleParam } from '@/components/dashboard/support';
import { Flash, LABEL } from '@/components/dashboard/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { REMBRIC_VERSION } from '@/lib/version';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

export default async function LoginPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const next = safeNext(singleParam(params.next));
  const error = loginErrorMessage(singleParam(params.error));

  return (
    <main className="grid min-h-screen bg-background font-sans text-foreground min-[981px]:grid-cols-[1fr_480px]">
      <section className="flex flex-col justify-between gap-3 border-b border-border px-4 pt-6 pb-4 min-[641px]:gap-4 min-[641px]:px-6 min-[641px]:py-8 min-[981px]:gap-8 min-[981px]:border-r min-[981px]:border-b-0 min-[981px]:p-12">
        <div className="flex items-center gap-3">
          <img
            src="/dashboard/assets/logo-transparent.png"
            alt=""
            aria-hidden="true"
            className="size-10 shrink-0 min-[641px]:size-12 min-[981px]:size-14"
          />
          <div className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
            <p>REMBRIC</p>
            <p className="mt-1.5">v{REMBRIC_VERSION}</p>
          </div>
        </div>

        <div>
          <h1 className="font-display text-[2.2rem] leading-[1.3] font-bold tracking-tight min-[641px]:text-[3.2rem] min-[981px]:text-[5rem] min-[981px]:leading-[1.35]">
            <span className="bg-primary px-[.25em] text-primary-foreground">REMBRIC</span>
            <br />
            DASHBOARD<span className="text-primary">.</span>
          </h1>
          <p className="mt-4 max-w-xl text-sm text-muted-foreground">
            Persistent memory layer for your agents. Single user, single SQLite file, single control
            window. No onboarding — only the{' '}
            <span className="underline decoration-primary decoration-2 underline-offset-2">
              admin token
            </span>{' '}
            with scope <code>*</code>.
          </p>
        </div>

        <ul className="flex flex-wrap gap-x-6 gap-y-2 font-mono text-xs tracking-widest text-muted-foreground uppercase max-[641px]:hidden">
          {LOGIN_CLIENTS.map((client) => (
            <li key={client} className="flex items-center gap-2">
              <span aria-hidden="true" className="size-1.5 bg-primary" />
              {client}
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col justify-center px-4 pt-6 pb-8 min-[641px]:px-6 min-[641px]:py-8 min-[981px]:p-12">
        <form method="post" action="/dashboard/login" className="grid w-full gap-3">
          {next ? <input type="hidden" name="next" value={next} /> : null}

          {error ? (
            <div id="login-error" role="alert">
              <Flash tone="danger" label="ERROR">
                {error}
              </Flash>
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <Label htmlFor="token" className={`${LABEL} font-normal text-muted-foreground`}>
              Admin token
            </Label>
            <Input
              id="token"
              name="token"
              type="password"
              autoComplete="off"
              placeholder="rbr_********************"
              required
              autoFocus
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'login-error' : undefined}
              className="min-h-11"
            />
          </div>

          <div className="flex gap-3">
            <Button type="submit" className="min-h-11">
              SIGN IN →
            </Button>
          </div>
        </form>
      </section>
    </main>
  );
}
