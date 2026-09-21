import { grantedOAuthScope, verifyAuthRequest } from '@rembric/core';

import { ConsentCard, ConsentShell, ErrorNotice, Lead } from './consent-card';
import { areqKey } from './session';

import { singleParam } from '@/components/dashboard/support';
import { getServices } from '@/lib/services';

/**
 * The OAuth consent screen — the dashboard-hosted rendering of the card, and the
 * page the authorization endpoint's GET delegates to.
 *
 * `provider.authorize` redirects the operator to `/dashboard/oauth/consent`
 * (`apps/server/src/server/oauth-provider.ts::CONSENT_PATH`); that path is a
 * Route Handler because the approval decision is a plain form `POST`, and Next
 * refuses a `page.tsx` and a `route.ts` in one segment. Its GET therefore
 * redirects here, preserving `?areq=`, so the operator sees this card inside the
 * dashboard shell rather than an unstyleable standalone document.
 *
 * The decision control is a plain form `POST` to the authorization endpoint —
 * deliberately NOT a Server Action: the endpoint that verifies the CSRF token,
 * mints the code and redirects to the client's registered `redirect_uri` is the
 * one that owns the protocol, and splitting the decision from it would move the
 * code mint into the view layer.
 *
 * One disclosed divergence from `apps/server/src/dashboard/oauth-consent.ts`:
 * the retired view required a logged-in operator (the dashboard middleware
 * redirected to login). This page is behind the same middleware, but a request
 * with no resolvable session still renders the card with no CSRF token, so the
 * endpoint refuses the approval — the boundary stays closed, and nothing signs
 * itself in.
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

  return (
    <ConsentCard
      blob={blob}
      clientName={client.clientName ?? areq.clientId}
      redirectHost={safeHost(areq.redirectUri)}
      grantedScope={grantedOAuthScope(areq.scope)}
    />
  );
}

function safeHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}
