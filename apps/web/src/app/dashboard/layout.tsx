import type { ReactNode } from 'react';

import { DashboardChrome } from '@/components/dashboard/chrome';
import { getServices } from '@/lib/services';
import { REMBRIC_VERSION } from '@/lib/version';

/**
 * The dashboard shell. Two design lines live here rather than in the chrome
 * component, because both are server-side facts:
 *
 * - **The rail's live-session count and its project list.** Both come from the
 *   service graph, so the client component is handed values and never the
 *   repositories. Every `/dashboard` page is `force-dynamic`, so this runs per
 *   request and never during `next build`.
 * - **The theme bootstrap.** It runs during HTML parsing, before the body
 *   paints, because the class it sets is the difference between loading in the
 *   stored theme and flashing dark first. `.dark` is server-rendered on
 *   `<html>` (`app/layout.tsx`), so the script only has to *replace* it for an
 *   operator who chose light; an absent key leaves the document as rendered.
 *
 * `THEME_STORAGE_KEY` is declared here, in the server component that renders the
 * script, and threaded down to the toggle as a prop rather than exported from
 * `chrome.tsx`: an export of a `'use client'` module is a client reference, so
 * reading it during the server render throws instead of returning the string.
 */
export const dynamic = 'force-dynamic';

const THEME_STORAGE_KEY = 'rembric-theme';

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { repos, agentSessions } = getServices();

  // Archived projects are listed on purpose: the selector is a filter over what
  // memory already exists, and an archived project's memories are still readable
  // through the memories view.
  const projects = repos.projects.adminListAll().map((project) => ({
    slug: project.slug,
    name: project.displayName ?? project.slug,
  }));
  const liveSessions = agentSessions.adminCountByStatus().active;

  return (
    <>
      <script>{themeScript()}</script>
      <DashboardChrome
        projects={projects}
        liveSessions={liveSessions}
        version={REMBRIC_VERSION}
        themeStorageKey={THEME_STORAGE_KEY}
      >
        {children}
      </DashboardChrome>
      <script>{timezoneScript()}</script>
    </>
  );
}

function themeScript(): string {
  return `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');var r=document.documentElement;if(t==='light'){r.classList.remove('dark');r.classList.add('light')}else if(t==='dark'){r.classList.remove('light');r.classList.add('dark')}}catch(e){}})()`;
}

/**
 * Upgrades every `[data-rembric-ts]` text node from its UTC fallback to the
 * viewer's timezone. The UTC string is what the server rendered, so this is a
 * progressive improvement rather than a correctness requirement: a document
 * without JavaScript keeps the unambiguous UTC reading instead of a wrong one.
 */
function timezoneScript(): string {
  return `(function(){try{var tz=Intl.DateTimeFormat().resolvedOptions().timeZone;var f=new Intl.DateTimeFormat(undefined,{year:'numeric',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',timeZone:tz});document.querySelectorAll('[data-rembric-ts]').forEach(function(el){var d=new Date(el.getAttribute('datetime')||'');if(!isNaN(d.getTime())){el.textContent=f.format(d).replace(',',', ')}})}catch(e){}})()`;
}
