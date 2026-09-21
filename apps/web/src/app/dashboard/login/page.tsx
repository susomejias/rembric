import Link from 'next/link';

import { LOGIN_CLIENTS, loginErrorMessage, safeNext } from './clients';

import { singleParam } from '@/components/dashboard/support';
import { REMBRIC_VERSION } from '@/lib/version';

/**
 * The sign-in screen — the mockup's login lines, rebuilt on top of the real
 * sign-in endpoint rather than copied from either mockup.
 *
 * The composition is the mockup's split: the brand column on the left, the
 * admin-token form on the right, the client strip along the bottom. What it is
 * *not* is the mockup's `LoginView` transcribed. Two deliberate divergences:
 *
 *  - **The brand mark is this install's own.** The transparent logo, the
 *    `REMBRIC` wordmark and the running version — the trio the retired
 *    `dashboard-router.ts::renderLogin` opened with — instead of the mockup's
 *    letter tile over a hard-coded `v0.21.23`.
 *  - **Surfaces and ink are the theme's roles, not the markup's literals.** The
 *    mockup paints this screen with a literal near-black and `white/[.13]`;
 *    every role named here comes from the shadcn theme instead, so the view
 *    follows the `.dark` class and the light preference alike.
 *
 * The form is a plain `POST` to `/dashboard/login`, the endpoint that validates
 * the admin token, enforces scope `*` and sets the signed session cookie. It is
 * NOT a Server Action: that endpoint owns the cookie attributes and the lockout,
 * and a Server Action would have to re-implement the session mint inside this
 * view. `middleware.ts` rewrites the POST to `login/verify` (the App Router
 * refuses a `page.tsx` and a `route.ts` in one segment) so the public URL stays
 * byte-identical. Every rejection — missing token, invalid token, too many
 * attempts, no session secret — comes back as an `?error=` code and is rendered
 * here; the copy lives in `clients.ts`, one source for both sides.
 *
 * The two "back to preview" controls of the mockup are the only structural
 * change: a running dashboard has no preview to return to, so both point at
 * `/dashboard`, which is also where an operator with a live session lands.
 */
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

export default async function LoginPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const next = safeNext(singleParam(params.next));
  const error = loginErrorMessage(singleParam(params.error));

  return (
    <main className="relative min-h-screen overflow-hidden bg-background font-sans text-foreground">
      <div className="relative mx-auto flex min-h-screen max-w-[1280px] flex-col justify-between px-6 py-6 md:px-10 md:py-8">
        <header className="flex items-start justify-between gap-6">
          <div className="flex items-center gap-3">
            <img
              src="/dashboard/assets/logo-transparent.png"
              alt=""
              aria-hidden="true"
              className="size-12 shrink-0"
            />
            <div className="text-[11px] tracking-[.18em] uppercase">
              <p className="text-foreground">REMBRIC</p>
              <p className="mt-1 text-muted-foreground">v{REMBRIC_VERSION}</p>
            </div>
          </div>
          <span className="hidden text-right text-[10px] tracking-[.18em] text-muted-foreground/70 uppercase sm:block">
            Local memory infrastructure
          </span>
        </header>

        <div className="grid flex-1 items-center gap-12 py-16 lg:grid-cols-[1fr_420px] lg:gap-24">
          <section className="hidden max-w-lg lg:block">
            <div>
              <p className="text-[10px] tracking-[.22em] text-primary uppercase">
                Private control plane
              </p>
              <h1 className="mt-5 text-5xl leading-[.98] font-medium tracking-[-.08em]">
                Your context,
                <br />
                <span className="text-primary">kept close.</span>
              </h1>
              <p className="mt-6 max-w-sm text-sm leading-6 text-muted-foreground">
                Sessions, judgments and durable memory live in one local SQLite file. No account and
                no onboarding — the admin token with scope{' '}
                <code className="font-mono text-muted-foreground">*</code> is the only way in.
              </p>
            </div>
            <div className="mt-10 flex items-center gap-3 text-xs text-muted-foreground">
              <span className="size-1.5 rounded-full bg-primary" />
              One workspace. One local memory layer.
            </div>
          </section>

          <section className="flex items-center justify-center">
            <form
              method="post"
              action="/dashboard/login"
              className="w-full rounded-xl border border-border bg-card p-7 shadow-lg md:p-8"
            >
              {next ? <input type="hidden" name="next" value={next} /> : null}

              <p className="text-[10px] tracking-[.18em] text-primary uppercase">Admin access</p>

              <label className="mt-6 block text-[11px] tracking-[.18em] text-muted-foreground uppercase">
                Admin token
                <input
                  required
                  autoFocus
                  type="password"
                  name="token"
                  autoComplete="off"
                  placeholder="RBR_******************"
                  aria-invalid={error ? true : undefined}
                  aria-describedby="login-token-hint"
                  className="mt-3 w-full rounded-none border border-border bg-background px-5 py-5 font-mono text-sm tracking-[.12em] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
                />
              </label>

              {error ? (
                <p
                  role="alert"
                  className="mt-4 border border-destructive/40 px-3 py-2 text-[11px] text-destructive"
                >
                  {error}
                </p>
              ) : null}

              <button
                type="submit"
                className="mt-4 flex w-full items-center justify-between gap-4 bg-primary px-6 py-5 text-[13px] font-bold tracking-[.16em] text-primary-foreground uppercase transition-colors hover:bg-primary/90"
              >
                Sign in <span aria-hidden="true">→</span>
              </button>

              <p id="login-token-hint" className="mt-4 text-[10px] leading-4 text-muted-foreground">
                Only the admin token with scope <code className="font-mono">*</code> opens the
                dashboard. The token is stored hashed and the session it mints lasts 7 days.
              </p>

              <Link
                href="/dashboard"
                className="mt-8 block text-left text-[11px] tracking-[.14em] text-muted-foreground uppercase transition-colors hover:text-primary"
              >
                Back to dashboard
              </Link>
            </form>
          </section>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-4 text-[10px] text-muted-foreground/70">
          <ul className="flex flex-wrap gap-x-5 gap-y-2">
            {LOGIN_CLIENTS.map((client) => (
              <li key={client} className="flex items-center gap-2 tracking-[.14em] uppercase">
                <span className="size-1 rounded-full bg-primary/60" aria-hidden="true" />
                {client}
              </li>
            ))}
          </ul>
          <Link
            href="/dashboard"
            className="tracking-[.14em] uppercase hover:text-muted-foreground"
          >
            Rembric · Local-first memory
          </Link>
        </footer>
      </div>
    </main>
  );
}
