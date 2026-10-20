import type { ReactNode } from 'react';

import { BackLink, Page } from './ui';

export function DetailLayout({
  title,
  backHref,
  backLabel,
  badges,
  actions,
  actionsLabel,
  notices,
  metadata,
  secondary,
  children,
  contentLabel,
}: {
  title: string;
  backHref: string;
  backLabel: string;
  badges?: ReactNode;
  actions?: ReactNode;
  actionsLabel: string;
  notices?: ReactNode;
  metadata: ReactNode;
  secondary?: ReactNode;
  children: ReactNode;
  contentLabel?: string;
}) {
  return (
    <Page className="detail-layout">
      <BackLink href={backHref} label={backLabel} />
      <header className="mt-5 mb-5 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
          {badges ? <div className="mt-3 flex flex-wrap items-center gap-2">{badges}</div> : null}
        </div>
        {actions ? (
          <details className="detail-actions relative shrink-0">
            <summary
              aria-label={actionsLabel}
              className="cursor-pointer rounded-lg border border-border px-3 py-1 text-xl hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
            >
              <span aria-hidden="true">⋯</span>
            </summary>
            <div className="absolute right-0 z-10 mt-2 min-w-44 space-y-2 rounded-xl border border-border bg-popover p-3 shadow-lg shadow-black/30">
              {actions}
            </div>
          </details>
        ) : null}
      </header>
      {notices}
      <div className="detail-grid">
        <aside aria-label="Details" className="detail-metadata">
          {metadata}
        </aside>
        <article aria-label={contentLabel} className="detail-content">
          {children}
        </article>
        {secondary ? (
          <aside aria-label="Related information" className="detail-secondary">
            {secondary}
          </aside>
        ) : null}
      </div>
    </Page>
  );
}

export function DetailDisclosure({
  title,
  inspector = false,
  children,
}: {
  title: ReactNode;
  inspector?: boolean;
  children: ReactNode;
}) {
  return (
    <details className={`detail-disclosure${inspector ? ' detail-inspector' : ''}`}>
      <summary>{title}</summary>
      <div className={inspector ? 'detail-inspector-body' : 'detail-secondary-body pt-4'}>
        {children}
      </div>
    </details>
  );
}
