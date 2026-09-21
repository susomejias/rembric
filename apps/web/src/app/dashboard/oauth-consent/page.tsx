import { grantedOAuthScope, resolveGrantedScope, verifyAuthRequest } from '@rembric/core';
import type { ReactNode } from 'react';

import { areqKey, CONSENT_FORM } from './session';

import { CsrfField } from '@/components/dashboard/csrf-field';
import { singleParam } from '@/components/dashboard/support';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { getServices } from '@/lib/services';
import { dashboardCsrfToken } from '@/lib/session';

/**
 * The OAuth consent screen — the one dashboard view that is a protocol endpoint
 * as much as a page, so it stays server-rendered with no client JavaScript
 * requirement.
 *
 * The decision control is a plain form `POST` to the authorization endpoint
 * (`/dashboard/oauth/consent`) — deliberately NOT a Server Action: the endpoint
 * that verifies the CSRF token, mints the code and redirects to the client's
 * registered `redirect_uri` is the one that owns the protocol, and splitting the
 * decision from it would move the code mint into the view layer. The CSRF token
 * is therefore bound to the same form name and session the endpoint checks.
 *
 * Two disclosed divergences from `apps/server/src/dashboard/oauth-consent.ts`:
 *
 *  - **No session, no token.** The retired view required a logged-in operator
 *    (the dashboard middleware redirected to login); this slice's app has no
 *    dashboard session yet. The card renders either way, and a request with no
 *    resolvable session carries no CSRF token, so the endpoint refuses the
 *    approval — the boundary stays closed, and nothing signs itself in.
 *  - **The route's own path.** The ported view lives at `/dashboard/oauth-consent`
 *    while the provider still redirects to `/dashboard/oauth/consent`
 *    (`apps/server/src/server/oauth-provider.ts::CONSENT_PATH`), which is also
 *    where both decision forms post. Moving that constant is an `apps/server`
 *    edit, outside this slice.
 */
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

export default async function OAuthConsentPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const blob = singleParam(params.areq);
  const key = areqKey();
  if (key === null) {
    return (
      <ConsentShell hl="Authorization" rest="Error.">
        <ErrorNotice message="This deployment has no session secret configured, so the authorization request cannot be verified. Set REMBRIC_SESSION_SECRET or REMBRIC_ADMIN_TOKEN and restart." />
        <Lead>Return to the application and start the connection again.</Lead>
      </ConsentShell>
    );
  }

  const areq = verifyAuthRequest(blob, key, Date.now());
  if (!areq) {
    return (
      <ConsentShell hl="Authorization" rest="Error.">
        <ErrorNotice message="This authorization request is invalid or expired." />
        <Lead>Return to the application and start the connection again.</Lead>
      </ConsentShell>
    );
  }

  const { oauth } = getServices();
  if (oauth === null) {
    return (
      <ConsentShell hl="Authorization" rest="Error.">
        <ErrorNotice message="The authorization server is disabled on this deployment: REMBRIC_PUBLIC_URL is unset." />
        <Lead>Return to the application and start the connection again.</Lead>
      </ConsentShell>
    );
  }

  const client = oauth.findClient(areq.clientId);
  if (!client) {
    return (
      <ConsentShell hl="Authorization" rest="Error.">
        <ErrorNotice message="Unknown OAuth client." />
        <Lead>Return to the application and start the connection again.</Lead>
      </ConsentShell>
    );
  }

  const grantedScope = grantedOAuthScope(areq.scope);
  const access = resolveGrantedScope(grantedScope) === 'read:*' ? 'Read-only' : 'Read & write';
  const csrf = await dashboardCsrfToken(CONSENT_FORM);

  return (
    <ConsentShell hl="Authorize" rest="Application.">
      <Lead>
        <b className="text-foreground">{client.clientName ?? areq.clientId}</b> wants to connect to
        your Rembric memory and will redirect to{' '}
        <code className="font-mono">{safeHost(areq.redirectUri)}</code>.
      </Lead>

      <div className="flex flex-col gap-1 rounded-xl border bg-muted/40 px-3 py-2.5">
        <span className="font-mono text-[0.66rem] tracking-[0.12em] text-muted-foreground uppercase">
          Granted access
        </span>
        <span className="text-sm">
          <span className="text-primary">{access}</span> · scope{' '}
          <code className="font-mono">{grantedScope}</code>
        </span>
      </div>

      <p className="text-xs text-muted-foreground">
        Project scope, if any, is bound by the connector path{' '}
        <code className="font-mono">/mcp/&lt;slug&gt;</code>.
      </p>

      {csrf === null ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          No dashboard session was resolved for this request, so the approval will be refused at the
          endpoint&apos;s CSRF check. Sign in to the dashboard and open the authorization link
          again.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <form action="/dashboard/oauth/consent" method="post">
          <CsrfField form={CONSENT_FORM} />
          <input type="hidden" name="areq" value={blob} />
          <input type="hidden" name="decision" value="approve" />
          <Button type="submit">AUTHORIZE →</Button>
        </form>
        <form action="/dashboard/oauth/consent" method="post">
          <CsrfField form={CONSENT_FORM} />
          <input type="hidden" name="areq" value={blob} />
          <input type="hidden" name="decision" value="deny" />
          <Button type="submit" variant="outline">
            DENY
          </Button>
        </form>
      </div>
    </ConsentShell>
  );
}

function ConsentShell({
  hl,
  rest,
  children,
}: {
  /** The accented first word of the heading — the retired `hl-lime` span. */
  hl: string;
  rest: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
      <div className="flex items-center gap-3">
        <img
          src="/dashboard/assets/logo-transparent.png"
          alt=""
          aria-hidden="true"
          className="size-8"
        />
        <span className="font-mono text-xs tracking-[0.18em] text-muted-foreground uppercase">
          Rembric · Authorize
        </span>
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">
        <span className="text-primary">{hl}</span> {rest}
      </h1>
      <Card>
        <CardContent className="flex flex-col gap-3">{children}</CardContent>
      </Card>
    </div>
  );
}

function ErrorNotice({ message }: { message: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Badge variant="destructive" className="font-mono">
        ERROR
      </Badge>
      <span>{message}</span>
    </div>
  );
}

function Lead({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function safeHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}
