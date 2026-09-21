import { resolveGrantedScope } from '@rembric/core';
import type { ReactNode } from 'react';

import { CONSENT_FORM } from './session';

import { CsrfField } from '@/components/dashboard/csrf-field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

/**
 * The consent screen's markup, extracted from the page so the protocol shape
 * (form action, the `areq`/`decision` fields, the granted scope block) lives in
 * one place. `/dashboard/oauth/consent` serves this same card: its GET delegates
 * to the page below, because a Route Handler cannot return JSX and cannot
 * rewrite (Next throws on `NextResponse.rewrite()` in an app route handler), and
 * a standalone `renderToStaticMarkup` document would drop the app's stylesheet
 * at an authentication boundary.
 *
 * The decision control stays a plain form `POST` to the authorization endpoint —
 * deliberately NOT a Server Action: the endpoint that verifies the CSRF token,
 * mints the code and redirects to the client's registered `redirect_uri` is the
 * one that owns the protocol, and splitting the decision from it would move the
 * code mint into the view layer. `CsrfField` mints the token bound to this form
 * name and session, so the token the endpoint verifies is the one rendered here.
 */
export interface ConsentCardProps {
  /** The signed authorization request, round-tripped as the form's `areq`. */
  blob: string;
  clientName: string;
  redirectHost: string;
  grantedScope: string;
}

export function ConsentCard({ blob, clientName, redirectHost, grantedScope }: ConsentCardProps) {
  const access = resolveGrantedScope(grantedScope) === 'read:*' ? 'Read-only' : 'Read & write';

  return (
    <ConsentShell hl="Authorize" rest="Application.">
      <Lead>
        <b className="text-foreground">{clientName}</b> wants to connect to your Rembric memory and
        will redirect to <code className="font-mono">{redirectHost}</code>.
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

export function ConsentShell({
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

export function ErrorNotice({ message }: { message: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Badge variant="destructive" className="font-mono">
        ERROR
      </Badge>
      <span>{message}</span>
    </div>
  );
}

export function Lead({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
