import { grantedOAuthScope, verifyAuthRequest } from '@rembric/core';

import { ConsentCard, ConsentShell, ErrorNotice, Lead } from './consent-card';
import { areqKey } from './session';

import { singleParam } from '@/components/dashboard/support';
import { getServices } from '@/lib/services';

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
