import type { ReactNode } from 'react';

import { AppSidebar } from '@/components/dashboard/app-sidebar';
import { SiteHeader } from '@/components/dashboard/site-header';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';

/**
 * The dashboard shell. `SidebarProvider` owns both the desktop collapse state
 * and the narrow-viewport sheet, so no separate mobile bar exists.
 *
 * `TooltipProvider` is mounted here rather than in the root layout because the
 * collapsed sidebar's labels are the only tooltips in the application.
 */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <SiteHeader />
          <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
