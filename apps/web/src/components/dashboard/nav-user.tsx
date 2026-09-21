'use client';

import { LogOut } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useSidebar } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';

export function NavUser() {
  const { isMobile, state } = useSidebar();
  const iconOnly = state === 'collapsed' && !isMobile;

  return (
    <div className="flex w-full flex-col gap-2">
      <form action="/dashboard/logout" method="post">
        <Button
          type="submit"
          variant="ghost"
          size="sm"
          title="Sign out"
          className={cn('w-full', iconOnly ? 'justify-center px-0' : 'justify-start')}
        >
          <LogOut data-icon="inline-start" aria-hidden="true" />
          <span className={cn(iconOnly && 'sr-only')}>Logout</span>
        </Button>
      </form>
    </div>
  );
}
