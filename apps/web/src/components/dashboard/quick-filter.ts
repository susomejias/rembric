'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

import type {
  DataTableQuickFilterControl,
  DataTableQuickFilterOption,
} from '@/components/spectrumui/data-table';

interface TableQuickFilterOptionSpec extends DataTableQuickFilterOption {
  /** When set, selecting this option writes these params instead of `paramKey`. */
  params?: Record<string, string>;
}

/**
 * Serializable quick-filter description a server page passes down to its table.
 * The pills render inside the DataTable; value and counts are computed on the
 * server, and a click writes the value back into the URL (resetting `page`).
 */
export interface TableQuickFilterSpec {
  paramKey: string;
  /** Active value from the URL; null selects the All pill. */
  active: string | null;
  options: readonly TableQuickFilterOptionSpec[];
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
    const optionParams = spec.options.map((option) => option.params ?? null);
    const onValueChange = (value: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      params.delete('page');
      params.delete(spec.paramKey);
      for (const extra of optionParams) {
        if (extra) for (const key of Object.keys(extra)) params.delete(key);
      }
      const selected =
        value === null ? null : (spec.options.find((o) => o.value === value) ?? null);
      if (selected?.params) {
        for (const [key, v] of Object.entries(selected.params)) params.set(key, v);
      } else {
        const next = value ?? spec.defaultValue ?? null;
        if (next !== null && next !== '') params.set(spec.paramKey, next);
      }
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
