'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

import type {
  DataTableQuickFilterControl,
  DataTableQuickFilterOption,
} from '@/components/spectrumui/data-table';

/**
 * Serializable quick-filter description a server page passes down to its table.
 * The pills render inside the DataTable; value and counts are computed on the
 * server, and a click writes the value back into the URL (resetting `page`).
 */
export interface TableQuickFilterSpec {
  paramKey: string;
  /** Active value from the URL; null selects the All pill. */
  active: string | null;
  options: readonly DataTableQuickFilterOption[];
  counts: Record<string, number>;
  totalCount: number;
  allLabel?: string;
  label?: string;
  /** Param value restored when the active pill is clicked again or All is picked. */
  defaultValue?: string;
}

export function useServerQuickFilter(
  spec: TableQuickFilterSpec | null,
): DataTableQuickFilterControl | null {
  const router = useRouter();
  const searchParams = useSearchParams();

  return React.useMemo(() => {
    if (!spec) return null;
    const onValueChange = (value: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      params.delete('page');
      const next = value ?? spec.defaultValue ?? null;
      if (next === null || next === '') params.delete(spec.paramKey);
      else params.set(spec.paramKey, next);
      const queryString = params.toString();
      router.replace(queryString ? `?${queryString}` : '?', { scroll: false });
    };
    return {
      label: spec.label,
      allLabel: spec.allLabel,
      value: spec.active,
      options: spec.options,
      counts: spec.counts,
      totalCount: spec.totalCount,
      onValueChange,
    };
  }, [spec, router, searchParams]);
}
