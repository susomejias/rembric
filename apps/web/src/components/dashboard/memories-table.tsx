import Link from 'next/link';

import { ReviewBadge, StatusBadge, TypeBadge } from '@/components/dashboard/badges';
import { truncate } from '@/components/dashboard/format';
import { Timestamp } from '@/components/dashboard/timestamp';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export interface MemoriesTableRow {
  id: string;
  projectLabel: string;
  type: string;
  title: string;
  status: string;
  createdAt: Date;
  reviewState: 'fresh' | 'needs_review' | null;
}

/**
 * The memories list table — the same six columns the Hono view rendered
 * (`apps/server/src/dashboard/memories.ts`), with the derived review state as a
 * badge. A server component: the rows are plain props and the whole read path
 * is rendered on the server.
 *
 * The retired whole-row `data-href` click is gone; the title is the link, so row
 * navigation needs no JavaScript and a keyboard or screen reader reaches the
 * same target.
 */
export function MemoriesTable({ rows }: { rows: readonly MemoriesTableRow[] }) {
  return (
    <Table className="font-sans">
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
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="font-mono text-xs text-muted-foreground">
              {row.projectLabel}
            </TableCell>
            <TableCell>
              <TypeBadge type={row.type} />
            </TableCell>
            <TableCell>
              <Link
                href={`/dashboard/memories/${row.id}`}
                className="font-medium underline-offset-4 hover:underline"
              >
                {truncate(row.title, 100)}
              </Link>
            </TableCell>
            <TableCell>
              <StatusBadge status={row.status} />
            </TableCell>
            <TableCell>
              {row.reviewState === 'needs_review' ? (
                <ReviewBadge />
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground">
              <Timestamp value={row.createdAt} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
