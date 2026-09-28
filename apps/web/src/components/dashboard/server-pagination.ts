'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

import type { DataTablePagination } from '@/components/spectrumui/data-table';

/**
 * Server-owned page numbers a server page hands down to its table. The table's
 * own footer renders the range and the arrows; a click writes `page` into the
 * URL so the server re-queries the right slice.
 */
export interface TablePaginationSpec {
  page: number;
  pageCount: number;
  totalRows: number;
  pageSize: number;
}

export function useServerPagination(
  spec: TablePaginationSpec | null,
): DataTablePagination | undefined {
  const router = useRouter();
  const searchParams = useSearchParams();

  return React.useMemo(() => {
    if (!spec) return undefined;
    const onPageChange = (page: number) => {
      const params = new URLSearchParams(searchParams.toString());
      if (page <= 1) params.delete('page');
      else params.set('page', String(page));
      const queryString = params.toString();
      router.replace(queryString ? `?${queryString}` : '?', { scroll: false });
    };
    return {
      page: spec.page,
      pageCount: spec.pageCount,
      pageSize: spec.pageSize,
      totalRows: spec.totalRows,
      onPageChange,
    };
  }, [spec, router, searchParams]);
}
