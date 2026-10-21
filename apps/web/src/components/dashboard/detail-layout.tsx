import Link from 'next/link';
import type { ReactNode } from 'react';

import { DetailActions } from './detail-actions';
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
  presentation = 'default',
  topic,
  tags,
  primaryActions,
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
  presentation?: 'default' | 'ficha';
  topic?: ReactNode;
  tags?: ReactNode;
  primaryActions?: ReactNode;
}) {
  if (presentation === 'ficha') {
    return (
      <Page className="detail-layout detail-ficha">
        <nav aria-label="Breadcrumb" className="ficha-crumb">
          <Link href={backHref}>{backLabel}</Link>
          {topic ? (
            <span className="ficha-topic">
              / <span>{topic}</span>
            </span>
          ) : null}
        </nav>
        <header className="ficha-header">
          <div className="min-w-0">
            <h1>{title}</h1>
            {badges ? <div className="ficha-meta">{badges}</div> : null}
            {tags}
          </div>
        </header>
        {notices}
        <div className="ficha-grid mt-6 pt-6">
          <article aria-label={contentLabel} className="detail-content">
            {children}
          </article>
          <aside aria-label="Context" className="ficha-rail">
            {secondary}
            {metadata}
          </aside>
        </div>
        <div
          className="ficha-actions gap-2 max-[760px]:gap-1 max-[760px]:[&_button]:px-2"
          role="group"
          aria-label={actionsLabel}
        >
          {primaryActions}
          {actions ? <DetailActions label={actionsLabel}>{actions}</DetailActions> : null}
        </div>
      </Page>
    );
  }
  return (
    <Page className="detail-layout">
      <BackLink href={backHref} label={backLabel} />
      <header className="mt-5 mb-5 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
          {badges ? <div className="mt-3 flex flex-wrap items-center gap-2">{badges}</div> : null}
        </div>
        {actions ? <DetailActions label={actionsLabel}>{actions}</DetailActions> : null}
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
  presentation = 'default',
  label,
  children,
}: {
  title: ReactNode;
  inspector?: boolean;
  presentation?: 'default' | 'ficha';
  label?: string;
  children: ReactNode;
}) {
  if (presentation === 'ficha') {
    return (
      <details
        className="ficha-disclosure group border-t border-border py-5"
        aria-label={label ?? (typeof title === 'string' ? title : undefined)}
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium before:text-[var(--chart-2)] before:transition-transform before:content-['›'] group-open:before:rotate-90 [&::-webkit-details-marker]:hidden [&>span]:ml-auto [&>span]:font-mono [&>span]:text-[var(--chart-2)]">
          {title}
        </summary>
        <div className="ficha-disclosure-body pt-4 [&_dl]:grid [&_dl]:grid-cols-[auto_minmax(0,1fr)] [&_dl]:gap-x-4 [&_dl]:gap-y-[9px] [&_dl]:pt-3 [&_dl]:text-sm [&_dt]:text-[var(--chart-2)] [&_dd]:font-mono [&_dd]:text-xs [&_dd]:wrap-anywhere">
          {children}
        </div>
      </details>
    );
  }
  return (
    <details className={`detail-disclosure${inspector ? ' detail-inspector' : ''}`}>
      <summary>{title}</summary>
      <div className={inspector ? 'detail-inspector-body' : 'detail-secondary-body pt-4'}>
        {children}
      </div>
    </details>
  );
}
