'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    console.error('[dashboard] route error', error);
  }, [error]);

  const requestId = error.digest ?? error.name;

  const copyId = (): void => {
    if (navigator.clipboard === undefined) return;
    void navigator.clipboard.writeText(requestId).then(() => {
      setCopied(true);
    });
  };

  return (
    <div className="flex min-h-[60svh] w-full items-center">
      <section className="w-full max-w-2xl rounded-2xl border border-border bg-card p-6 md:p-8">
        <p className="font-mono text-[11px] uppercase tracking-[.14em] text-destructive">
          Request failed
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
          This view did not load
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          The dashboard hit an error while rendering this route. Nothing was written — every view is
          a read.
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[.14em] text-muted-foreground">
            Request id
          </span>
          <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-muted px-2.5 py-1.5 font-mono text-xs text-foreground">
            {requestId}
          </code>
          <Button type="button" variant="outline" size="sm" onClick={copyId}>
            {copied ? <Check className="text-primary" /> : <Copy />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>

        <details className="mt-4">
          <summary className="w-fit cursor-pointer text-sm text-muted-foreground transition-colors hover:text-foreground">
            Technical detail
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-xl border border-border bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
            {error.message}
          </pre>
        </details>

        <div className="mt-6">
          <Button type="button" onClick={reset}>
            Try again
          </Button>
        </div>
      </section>
    </div>
  );
}
