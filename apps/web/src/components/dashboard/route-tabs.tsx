import Link from 'next/link';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface RouteTab {
  readonly href: string;
  readonly label: string;
  readonly active: boolean;
  readonly badge?: ReactNode;
}

export function RouteTabs({ tabs, label }: { tabs: readonly RouteTab[]; label: string }) {
  return (
    <nav aria-label={label} className="flex gap-6 border-b border-border">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={tab.active ? 'page' : undefined}
          className={cn(
            '-mb-px inline-flex items-center gap-2 border-b-2 px-0.5 pb-3 text-sm font-medium transition-colors outline-none focus-visible:text-foreground',
            tab.active
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {tab.label}
          {tab.badge}
        </Link>
      ))}
    </nav>
  );
}
