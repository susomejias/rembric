import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * The memories table's loading state. Column-by-column, not a spinner: the six
 * headers, their widths and the shape of each cell come from
 * `memories-table.tsx`, so the skeleton and the loaded table occupy the same box
 * and the layout does not jump when the rows arrive.
 *
 * Midday's `tables/core/table-skeleton.tsx` is the same idea (a `SkeletonCell`
 * per column type, driven by the column definitions); Rembric's tables are plain
 * `Table`/`TableCell` markup with no TanStack column model, so the column
 * description here is the markup itself rather than a `ColumnDef[]` prop.
 */
export function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <Table className="font-sans" aria-busy="true" aria-label="Loading memories">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-40">project</TableHead>
          <TableHead className="w-28">type</TableHead>
          <TableHead>title</TableHead>
          <TableHead className="w-32">status</TableHead>
          <TableHead className="w-36">review</TableHead>
          <TableHead className="w-56">created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: rows }, (_, index) => (
          <TableRow key={index} className="hover:bg-transparent">
            {/* project — mono slug */}
            <TableCell>
              <Skeleton className="h-3 w-24" />
            </TableCell>
            {/* type — badge */}
            <TableCell>
              <Skeleton className="h-5 w-16 rounded-full" />
            </TableCell>
            {/* title — the row's longest cell */}
            <TableCell>
              <Skeleton className="h-4 w-3/5" />
            </TableCell>
            {/* status — badge */}
            <TableCell>
              <Skeleton className="h-5 w-20 rounded-full" />
            </TableCell>
            {/* review — badge */}
            <TableCell>
              <Skeleton className="h-5 w-16 rounded-full" />
            </TableCell>
            {/* created — mono timestamp */}
            <TableCell>
              <Skeleton className="h-3 w-40" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
