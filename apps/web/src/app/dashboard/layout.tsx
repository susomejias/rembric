import { REVIEW_TTL_MS } from '@rembric/core';
import type { MemoryType } from '@rembric/db';
import type { ReactNode } from 'react';

import { ActionNav } from '@/components/navigation/action-nav';
import { getServices } from '@/lib/services';
import { REMBRIC_VERSION } from '@/lib/version';

/**
 * The dashboard shell. Two things live here rather than in the navigation
 * component, because both are server-side facts:
 *
 * - **The nav's two badge counts.** They come from the service graph, so the
 *   client component is handed values and never the repositories. Every
 *   `/dashboard` page is `force-dynamic`, so this runs per request and never
 *   during `next build`.
 * - **The theme bootstrap.** It runs during HTML parsing, before the body
 *   paints, because the class it sets is the difference between loading in the
 *   stored theme and flashing dark first. `.dark` is server-rendered on
 *   `<html>` (`app/layout.tsx`), so the script only has to *remove* it for an
 *   operator who chose light; an absent key leaves the document as rendered.
 *
 * `THEME_STORAGE_KEY` is declared here, in the server component that renders the
 * script, and threaded down to the toggle as a prop rather than exported from
 * `action-nav.tsx`: an export of a `'use client'` module is a client reference,
 * so reading it during the server render throws instead of returning the string.
 */
export const dynamic = 'force-dynamic';

const THEME_STORAGE_KEY = 'rembric-theme';

const TTL_BY_TYPE = Object.entries(REVIEW_TTL_MS).filter(
  (entry): entry is [MemoryType, number] => typeof entry[1] === 'number',
);

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { repos } = getServices();
  const needsReview = repos.memory.adminCountNeedsReview({
    nowMs: Date.now(),
    ttlByType: TTL_BY_TYPE,
  });
  const pendingJudgments = repos.relations.adminCountByStatus('pending');

  return (
    <>
      <script>{themeScript()}</script>
      <div className="min-h-screen bg-background text-foreground">
        <ActionNav
          version={REMBRIC_VERSION}
          themeStorageKey={THEME_STORAGE_KEY}
          badges={{ needsReview, pendingJudgments }}
        >
          {children}
        </ActionNav>
      </div>
      <script>{timezoneScript()}</script>
    </>
  );
}

function themeScript(): string {
  return `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');var r=document.documentElement;if(t==='light'){r.classList.remove('dark')}else if(t==='dark'){r.classList.add('dark')}}catch(e){}})()`;
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
