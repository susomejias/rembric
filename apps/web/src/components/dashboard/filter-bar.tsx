import { ChevronDownIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * The shared filter bar for every list view, and the React replacement for
 * `components.ts::filtersBar`/`filterGroup`/`sel`/`inp`.
 *
 * It is a plain `method="get"` form: submitting it navigates to the same path
 * with the controls serialised as search params, so the server filters and
 * paginates and the URL is the whole state. That is why the controls are native
 * `<select>`/`<input>` elements rather than the Radix `Select`: a Radix trigger
 * is a button and contributes nothing to a form submission, so using it here
 * would make the filter unusable without JavaScript. The native control carries
 * the shadcn trigger's token classes instead, so it is indistinguishable at
 * rest.
 */
export function FilterBar({
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
      action={action}
      method="get"
      className={cn(
        'flex flex-wrap items-end gap-3 rounded-xl border bg-card px-3 py-3',
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
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <Label
        htmlFor={htmlFor}
        className="font-mono text-[0.66rem] tracking-[0.12em] text-muted-foreground uppercase"
      >
        {label}
      </Label>
      {children}
    </div>
  );
}

export interface FilterOption {
  value: string;
  label: string;
}

export function FilterSelect({
  id,
  name,
  value,
  options,
  className,
}: {
  id: string;
  name: string;
  value: string;
  options: readonly FilterOption[];
  className?: string;
}) {
  return (
    <div className={cn('relative', className)}>
      <select
        id={id}
        name={name}
        defaultValue={value}
        className="h-8 w-full appearance-none rounded-lg border border-input bg-transparent py-1 pr-7 pl-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

export function FilterSearch({
  id,
  name,
  value,
  placeholder,
  className,
}: {
  id: string;
  name: string;
  value: string;
  placeholder: string;
  className?: string;
}) {
  return (
    <Input
      id={id}
      name={name}
      type="search"
      defaultValue={value}
      placeholder={placeholder}
      className={cn('h-8', className)}
    />
  );
}
