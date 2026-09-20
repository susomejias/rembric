import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * The view header shared by every ported dashboard page: the page title and the
 * right-aligned meta chips. The React replacement for
 * `apps/server/src/dashboard/components.ts::viewHead`, minus its numbered
 * eyebrow — the `§ NN` section marker was furniture of the retired dashboard and
 * did not survive the move to the Midday-shaped page.
 *
 * Each meta chip renders as a bare `<b>KEY</b> value` — the shape the retired
 * `TOTAL`/`SHOWING` assertions target — so a ported test keeps asserting on the
 * same substring contract rather than on markup shape.
 */
export function ViewHead({
  title,
  meta,
  metaId,
}: {
  title: ReactNode;
  meta?: readonly { k: string; v: ReactNode }[];
  metaId?: string;
}) {
  return (
    <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-semibold tracking-tight">{title}</h1>
      </div>
      {meta && meta.length > 0 ? (
        <div id={metaId} className="flex flex-wrap items-center gap-3 font-mono text-xs">
          {meta.map((m) => (
            <span key={m.k}>
              <b>{m.k}</b> {m.v}
            </span>
          ))}
        </div>
      ) : null}
    </header>
  );
}

/** The one-click way back to a parent list, for detail views. */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex w-fit items-center gap-1 font-mono text-xs tracking-[0.12em] text-muted-foreground uppercase hover:text-foreground"
    >
      ← {label}
    </Link>
  );
}
