import Link from 'next/link';
import type { ReactNode } from 'react';

import { queryWithPage } from './support';

import { cn } from '@/lib/utils';

/**
 * The URL-driven filter bar and pager, in the v0 vocabulary. Both are plain
 * `<form>`/`<a>` surfaces with no client JavaScript: the server does the
 * filtering and the paginating, and the browser's back button is the filter's
 * undo. The page reads the values it round-trips; nothing here owns state.
 */

export const FIELD_INK =
  'w-full border border-(--ink)/[10%] bg-(--surface-input) px-3 py-2 text-xs text-(--ink) outline-none transition-colors focus:border-(--accent-ink)/50';

export const LIME_FILL =
  'rounded-lg bg-lime-300 px-4 py-2.5 text-[11px] font-medium text-[#111614] transition-colors hover:bg-lime-200 disabled:pointer-events-none disabled:opacity-50';

export function FilterForm({
  action,
  children,
  className,
}: {
  action: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <form
      method="get"
      action={action}
      className={cn(
        'flex flex-wrap items-end gap-3 rounded-2xl border border-(--ink)/[7.5%] bg-(--surface-panel) p-5',
        className,
      )}
    >
      {children}
    </form>
  );
}

export function FilterField({
  label,
  htmlFor,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className={cn('flex flex-col gap-2', className)}>
      <span className="text-[10px] tracking-[.14em] text-(--ink)/45 uppercase">{label}</span>
      {children}
    </label>
  );
}

export function FilterInput({
  id,
  name,
  value,
  placeholder,
}: {
  id: string;
  name: string;
  value: string;
  placeholder?: string;
}) {
  return (
    <input
      id={id}
      name={name}
      type="search"
      defaultValue={value}
      placeholder={placeholder}
      className={FIELD_INK}
    />
  );
}

export function FilterSelect({
  id,
  name,
  value,
  options,
}: {
  id: string;
  name: string;
  value: string;
  options: readonly { readonly value: string; readonly label: string }[];
}) {
  return (
    <select id={id} name={name} defaultValue={value} className={FIELD_INK}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function FilterActions({ clearHref }: { clearHref: string }) {
  return (
    <div className="flex items-center gap-2">
      <button type="submit" className={LIME_FILL}>
        Filter
      </button>
      <Link
        href={clearHref}
        className="rounded-lg border border-(--ink)/[10%] px-4 py-2.5 text-[11px] text-(--ink)/55 transition-colors hover:bg-(--ink)/[6%] hover:text-(--ink)"
      >
        Clear
      </Link>
    </div>
  );
}

/**
 * The pager. `total` is a *lower bound* wherever the listing cannot count its
 * filtered set cheaply (`undefined`), and it says so with a `+` rather than
 * printing a total it does not know.
 */
export function Pager({
  page,
  hasMore,
  total,
  totalLabel,
  path,
  query,
}: {
  page: number;
  hasMore: boolean;
  total: number | undefined;
  totalLabel: string;
  path: string;
  query: Readonly<Record<string, string>>;
}) {
  if (page === 0 && !hasMore) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-[11px] text-(--ink)/38">
        <span>{totalLabel}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-[11px] text-(--ink)/45">
      <span>
        {totalLabel}
        {total !== undefined ? (
          <span className="text-(--ink)/38"> · {total === undefined ? '' : total} total</span>
        ) : (
          <span className="text-(--ink)/38"> · more available</span>
        )}
      </span>
      <div className="flex items-center gap-2">
        {page > 0 ? (
          <Link
            href={`${path}${queryWithPage(query, page - 1)}`}
            className="rounded-lg border border-(--ink)/[10%] px-3 py-2 transition-colors hover:bg-(--ink)/[6%] hover:text-(--ink)"
          >
            ← Previous
          </Link>
        ) : null}
        <span className="text-(--ink)/38">Page {page + 1}</span>
        {hasMore ? (
          <Link
            href={`${path}${queryWithPage(query, page + 1)}`}
            className="rounded-lg border border-(--ink)/[10%] px-3 py-2 transition-colors hover:bg-(--ink)/[6%] hover:text-(--ink)"
          >
            Next →
          </Link>
        ) : null}
      </div>
    </div>
  );
}
