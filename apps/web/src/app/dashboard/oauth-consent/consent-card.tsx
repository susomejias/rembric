import { resolveGrantedScope } from '@rembric/core';
import type { ReactNode } from 'react';

import { CONSENT_FORM } from './session';

import { CsrfField } from '@/components/dashboard/csrf-field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export interface ConsentCardProps {
  blob: string;
  clientName: string;
  redirectHost: string;
  grantedScope: string;
}

const SCOPE_COPY: Record<string, string> = {
  read: 'Read memories, sessions, projects and judgments.',
  mcp: 'Read and write through the MCP tools.',
};

const META_LABEL = 'font-mono text-[10px] tracking-[.16em] text-muted-foreground uppercase';

export function ConsentCard({ blob, clientName, redirectHost, grantedScope }: ConsentCardProps) {
  const access = resolveGrantedScope(grantedScope) === 'read:*' ? 'Read-only' : 'Read & write';
  const scopes = grantedScope.split(/\s+/).filter((scope) => scope.length > 0);

  return (
    <ConsentShell hl="Authorize" rest="Application.">
      <div className="flex flex-col gap-1">
        <span className={META_LABEL}>Client</span>
        <span className="font-display text-lg leading-snug font-semibold tracking-tight break-words text-foreground">
          {clientName}
        </span>
      </div>

      <Lead>
        This application wants to connect to your Rembric memory and will redirect to{' '}
        <code className="font-mono text-foreground">{redirectHost}</code>.
      </Lead>

      <section className="flex flex-col gap-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className={META_LABEL}>Requested access</h2>
          <span className={`${META_LABEL} text-primary`}>{access}</span>
        </div>
        <ul className="flex flex-col gap-2">
          {scopes.map((scope, index) => {
            const description = SCOPE_COPY[scope.toLowerCase()];
            return (
              <li key={`${scope}:${index}`} className="flex items-start gap-2.5">
                <span
                  aria-hidden="true"
                  className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary"
                />
                <span className="flex flex-col gap-0.5">
                  <code className="font-mono text-xs text-foreground">{scope}</code>
                  {description ? (
                    <span className="text-xs leading-relaxed text-muted-foreground">
                      {description}
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Project scope, if any, is bound by the connector path{' '}
        <code className="font-mono text-foreground">/mcp/&lt;slug&gt;</code>.
      </p>

      <div className="flex flex-col gap-2 sm:flex-row">
        <form action="/dashboard/oauth/consent" method="post" className="sm:flex-1">
          <CsrfField form={CONSENT_FORM} />
          <input type="hidden" name="areq" value={blob} />
          <input type="hidden" name="decision" value="approve" />
          <Button type="submit" className="h-11 w-full rounded-[10px]">
            AUTHORIZE →
          </Button>
        </form>
        <form action="/dashboard/oauth/consent" method="post" className="sm:flex-1">
          <CsrfField form={CONSENT_FORM} />
          <input type="hidden" name="areq" value={blob} />
          <input type="hidden" name="decision" value="deny" />
          <Button type="submit" variant="outline" className="h-11 w-full rounded-[10px]">
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
  hl: string;
  rest: string;
  children: ReactNode;
}) {
  return (
    <main className="relative isolate flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-4 py-12">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-96 bg-[radial-gradient(640px_260px_at_50%_-60px,rgba(198,242,78,0.09),transparent_70%)]"
      />
      <div className="flex items-center gap-2.5">
        <img
          src="/dashboard/assets/logo-transparent.png"
          alt=""
          aria-hidden="true"
          className="size-6 shrink-0"
        />
        <span className={`${META_LABEL} tracking-[.18em]`}>Rembric · Authorize</span>
      </div>
      <div className="flex w-full max-w-md flex-col gap-4">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">
          <span className="text-primary">{hl}</span> {rest}
        </h1>
        <Card className="rounded-2xl border border-border bg-card shadow-lg shadow-black/20 ring-0">
          <CardContent className="flex flex-col gap-4">{children}</CardContent>
        </Card>
      </div>
    </main>
  );
}

export function ErrorNotice({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <Badge variant="destructive" className="mt-0.5 shrink-0 font-mono tracking-[.14em]">
        ERROR
      </Badge>
      <span className="text-sm leading-relaxed text-foreground">{message}</span>
    </div>
  );
}

export function Lead({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>;
}
