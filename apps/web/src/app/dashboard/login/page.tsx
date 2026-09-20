import Link from 'next/link';

import { LOGIN_CLIENTS, loginErrorMessage, safeNext } from './clients';

import { singleParam } from '@/components/dashboard/support';
import { REMBRIC_VERSION } from '@/lib/version';

/**
 * The sign-in screen — the v0 `LoginView`, ported as-is: the split composition
 * with the lime glow orb, the brand column on the left and the admin-token form
 * in the framed card on the right. No `prose` wrapper and no shadcn `Card`: the
 * view is raw utilities over the v0 palette, which is why it reads its surfaces
 * through the theme's role variables instead of the mockup's literal `#111614`
 * (identical in dark, flipped in light).
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
    <main className="relative min-h-screen overflow-hidden bg-(--surface-login) font-sans text-(--body-ink)">
      <div className="relative mx-auto flex min-h-screen max-w-[1280px] flex-col justify-between px-6 py-6 before:pointer-events-none before:absolute before:top-[18%] before:left-[-18%] before:size-[520px] before:rounded-full before:bg-lime-300/[.055] before:blur-[140px] md:px-10 md:py-8">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="grid size-8 place-items-center rounded-md bg-lime-300 text-lg leading-none font-bold text-[#111614]">
              R
            </div>
            <div className="text-[11px] tracking-[.18em] text-(--ink)/45 uppercase">
              <p>Rembric</p>
              <p className="mt-1 text-(--ink)/45">v{REMBRIC_VERSION}</p>
            </div>
          </div>
          <span className="text-[10px] tracking-[.18em] text-(--ink)/25 uppercase">
            Local memory infrastructure
          </span>
        </header>

        <div className="grid flex-1 items-center gap-12 py-16 lg:grid-cols-[1fr_420px] lg:gap-24">
          <section className="hidden max-w-lg lg:block">
            <div>
              <p className="text-[10px] tracking-[.22em] text-(--accent-ink)/60 uppercase">
                Private control plane
              </p>
              <h1 className="mt-5 text-5xl leading-[.98] font-medium tracking-[-.08em]">
                Your context,
                <br />
                <span className="text-(--accent-ink)">kept close.</span>
              </h1>
              <p className="mt-6 max-w-sm text-sm leading-6 text-(--ink)/40">
                Sign in to continue to your local memory workspace, where sessions, judgments, and
                durable context stay under your control.
              </p>
            </div>
            <div className="mt-10 flex items-center gap-3 text-xs text-(--ink)/45">
              <span className="size-1.5 rounded-full bg-lime-300" />
              One workspace. One local memory layer.
            </div>
          </section>

          <section className="flex items-center justify-center">
            <form
              method="post"
              action="/dashboard/login"
              className="w-full rounded-2xl border border-(--ink)/[10%] bg-(--surface-panel)/95 p-7 shadow-[0_24px_80px_rgba(0,0,0,.4)] backdrop-blur-xl md:p-8"
            >
              {next ? <input type="hidden" name="next" value={next} /> : null}

              <label className="block text-[11px] tracking-[.18em] text-(--ink)/55 uppercase">
                Admin token
                <input
                  required
                  type="password"
                  name="token"
                  autoComplete="off"
                  placeholder="RBR_******************"
                  className="mt-3 w-full rounded-none border border-(--ink)/[13%] bg-(--surface-input) px-5 py-5 font-mono text-sm tracking-[.12em] text-(--ink) outline-none transition-colors placeholder:text-(--ink)/45 focus:border-[#c1ff38]"
                />
              </label>

              {error ? (
                <p
                  role="alert"
                  className="mt-4 border border-(--danger-ink)/50 px-3 py-2 text-[11px] text-(--danger-ink)"
                >
                  {error}
                </p>
              ) : null}

              <button
                type="submit"
                className="mt-4 bg-[#c1ff38] px-6 py-5 text-[13px] font-bold tracking-[.16em] text-black uppercase transition-colors hover:bg-[#d3ff70]"
              >
                Sign in <span aria-hidden="true">→</span>
              </button>

              <p className="mt-4 text-[10px] leading-4 text-(--ink)/38">
                Only the admin token with scope <code className="font-mono">*</code> opens the
                dashboard. The token is stored hashed and the session it mints lasts 7 days.
              </p>

              <Link
                href="/dashboard"
                className="mt-8 block text-left text-[11px] tracking-[.14em] text-(--ink)/38 uppercase transition-colors hover:text-[#c1ff38]"
              >
                Back to dashboard
              </Link>
            </form>
          </section>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-4 text-[10px] text-(--ink)/20">
          <ul className="flex flex-wrap gap-x-5 gap-y-2">
            {LOGIN_CLIENTS.map((client) => (
              <li key={client} className="flex items-center gap-2 tracking-[.14em] uppercase">
                <span className="size-1 rounded-full bg-lime-300/60" aria-hidden="true" />
                {client}
              </li>
            ))}
          </ul>
          <Link href="/dashboard" className="tracking-[.14em] uppercase hover:text-(--ink)/50">
            Rembric · Local-first memory
          </Link>
        </footer>
      </div>
    </main>
  );
}
