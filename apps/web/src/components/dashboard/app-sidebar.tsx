'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ComponentProps } from 'react';

import { NavUser } from '@/components/dashboard/nav-user';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';
import { badgeTooltip, NAV, NAV_GROUPS, navEntryForPath, type NavBadgeCounters } from '@/lib/nav';

export function AppSidebar({
  counters = {},
  ...props
}: ComponentProps<typeof Sidebar> & { counters?: NavBadgeCounters }) {
  const activeKey = navEntryForPath(usePathname())?.key;

  return (
    <Sidebar collapsible="icon" className="glass-chrome" {...props}>
      <SidebarContent>
        {NAV_GROUPS.map((group) => {
          const entries = NAV.filter((entry) => entry.group === group.key);
          if (entries.length === 0) return null;

          return (
            <SidebarGroup key={group.key}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {entries.map((entry) => {
                    const Icon = entry.icon;
                    const badgeKey = entry.badgeKey;
                    const breakdown = badgeKey ? counters[badgeKey] : undefined;
                    const count = breakdown?.total ?? 0;

                    return (
                      <SidebarMenuItem key={entry.key}>
                        <SidebarMenuButton
                          asChild
                          isActive={activeKey === entry.key}
                          tooltip={entry.label}
                        >
                          <Link href={entry.href}>
                            <Icon />
                            <span>{entry.label}</span>
                          </Link>
                        </SidebarMenuButton>
                        {badgeKey && breakdown && count > 0 ? (
                          <SidebarMenuBadge title={badgeTooltip(badgeKey, breakdown)}>
                            {count}
                          </SidebarMenuBadge>
                        ) : null}
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
