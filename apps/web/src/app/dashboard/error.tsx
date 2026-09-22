'use client';

import { useEffect } from 'react';

import { ErrorEmpty } from '@/components/bento/empty-states';

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
