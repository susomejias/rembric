'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';

import { PAGE_SIZE, queryWithPage } from './support';
import { LABEL } from './ui';

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
 * The URL-driven filter bar and pager, mirroring the production dashboard's
 * `.filters` pattern: each control is `LABEL · <input>` on one wrapping row,
 * with FILTER/CLEAR pinned to the end. The server does the filtering and the
 * paginating, and the browser's back button is the filter's undo.
 */

/** The bottom-ruled "ink" control the production filter bar uses for native inputs. */
export const FIELD_INK =
  'min-h-7 min-w-24 border-b border-border bg-transparent px-0 pr-4 font-mono text-xs uppercase tracking-[.08em] text-foreground outline-none transition-colors placeholder:text-muted-foreground placeholder:text-[.72rem] focus:border-primary disabled:cursor-not-allowed disabled:opacity-50';

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
        'mb-5 flex flex-wrap items-center gap-x-4 gap-y-3 border border-border bg-card px-4 py-3',
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
    <div className={cn('flex items-center gap-2', className)}>
      <label htmlFor={htmlFor} className={cn('whitespace-nowrap text-muted-foreground', LABEL)}>
        {label}
      </label>
      {children}
    </div>
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
      className={cn(FIELD_INK, 'flex-1')}
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
        <SelectTrigger
          id={id}
          className="h-7 min-w-24 border-0 border-b border-border bg-transparent px-0 font-mono text-xs uppercase tracking-[.08em] shadow-none focus-visible:ring-0 dark:bg-transparent"
        >
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
    <div className="ml-auto flex items-center gap-2">
      <Button type="submit" className="h-8 font-mono text-[10px] uppercase tracking-[.14em]">
        Filter
      </Button>
      <Link
        href={clearHref}
        className={cn('px-2 text-muted-foreground transition-colors hover:text-primary', LABEL)}
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
  const label =
    `PAGE ${page + 1}` +
    (total !== undefined ? ` OF ${Math.max(1, Math.ceil(total / PAGE_SIZE))}` : '') +
    ` · ${totalLabel}`;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border py-4">
      <span className={cn('text-muted-foreground', LABEL)}>{label}</span>
      <div className="flex items-center gap-2">
        {page > 0 ? (
          <Button variant="outline" size="sm" asChild>
            <Link href={`${path}${queryWithPage(query, page - 1)}`}>‹ Prev</Link>
          </Button>
        ) : null}
        {hasMore ? (
          <Button variant="outline" size="sm" asChild>
            <Link href={`${path}${queryWithPage(query, page + 1)}`}>Next ›</Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
