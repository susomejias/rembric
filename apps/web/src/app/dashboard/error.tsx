'use client';

import { useEffect } from 'react';

import { ErrorEmpty } from '@/components/bento/empty-states';

/**
 * The dashboard's error boundary. Next renders this in place of the failed
 * segment, so the shell (and the operator's session) survives whatever threw —
 * `error.tsx` is the only place in the app that may be a client component for
 * that reason.
 *
 * The id handed to the block is the one string support asks for, and it has to
 * be stable: `error.digest` is what Next assigns server-side errors, and the
 * name is the fallback for a client throw that never reached the server. The
 * technical detail is the message alone — the stack is in the browser console
 * and the server log, not on the operator's screen.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[dashboard] route error', error);
  }, [error]);

  const requestId = error.digest ?? error.name;

  return (
    <div className="mx-auto flex min-h-[60svh] max-w-2xl items-center px-5 py-10 md:px-8">
      <ErrorEmpty
        errorId={requestId}
        title="This view did not load"
        description="The dashboard hit an error while rendering this route. Nothing was written — every view is a read."
        detail={error.message}
        onRetry={reset}
      />
    </div>
  );
}
