'use client';

import { RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function OverviewRefreshButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="Refresh overview"
      aria-busy={isPending}
      title={isPending ? 'Refreshing overview…' : 'Refresh overview'}
      disabled={isPending}
      onClick={() => startTransition(() => router.refresh())}
      className="text-muted-foreground"
    >
      <RefreshCw
        aria-hidden="true"
        className={cn('size-4', isPending && 'animate-spin motion-reduce:animate-none')}
      />
    </Button>
  );
}
