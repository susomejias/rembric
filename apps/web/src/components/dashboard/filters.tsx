'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';

import { queryWithPage } from './support';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

/**
 * The URL-driven filter bar and pager. Both are plain `<form>`/`<a>` surfaces:
 * the server does the filtering and the paginating, and the browser's back
 * button is the filter's undo. `FilterSelect` holds the one piece of state the
 * shadcn `Select` needs to drive — everything else reads what the page passed
 * in and nothing here owns a filter.
 */

/** The default shadcn control skin, for the native inputs that are not a `Select`. */
export const FIELD_INK =
  'w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30';

/**
 * `Select` refuses an empty-string item value, and this vocabulary spells
 * "unset" as exactly that. The sentinel is the display value only: the hidden
 * input below submits the real one, so the URL keeps the contract the pages
 * read (`status=` absent, `type=` empty) instead of gaining a new spelling.
 */
const UNSET = '__unset__';

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
        'flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-5',
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
      <span className="text-[10px] tracking-[.14em] text-muted-foreground uppercase">{label}</span>
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
  const [selected, setSelected] = useState(value);

  return (
    <>
      <Select
        value={selected === '' ? UNSET : selected}
        onValueChange={(next) => {
          setSelected(next === UNSET ? '' : next);
        }}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              key={option.value === '' ? UNSET : option.value}
              value={option.value === '' ? UNSET : option.value}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/* The submitted value, so an unset filter still round-trips as `''`. */}
      <input type="hidden" name={name} value={selected} />
    </>
  );
}

export function FilterActions({ clearHref }: { clearHref: string }) {
  return (
    <div className="flex items-center gap-2">
      <Button type="submit">Filter</Button>
      <Button variant="outline" asChild>
        <Link href={clearHref}>Clear</Link>
      </Button>
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
      <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-[11px] text-muted-foreground">
        <span>{totalLabel}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-[11px] text-muted-foreground">
      <span>
        {totalLabel}
        {total !== undefined ? (
          <span className="text-muted-foreground/70"> · {total} total</span>
        ) : (
          <span className="text-muted-foreground/70"> · more available</span>
        )}
      </span>
      <div className="flex items-center gap-2">
        {page > 0 ? (
          <Button variant="outline" size="sm" asChild>
            <Link href={`${path}${queryWithPage(query, page - 1)}`}>← Previous</Link>
          </Button>
        ) : null}
        <span className="text-muted-foreground/70">Page {page + 1}</span>
        {hasMore ? (
          <Button variant="outline" size="sm" asChild>
            <Link href={`${path}${queryWithPage(query, page + 1)}`}>Next →</Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
