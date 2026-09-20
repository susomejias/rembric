/**
 * The dashboard's single timestamp renderer — the React replacement for
 * `apps/server/src/dashboard/templates.ts::formatTs`.
 *
 * The UTC string is the fallback, not the contract: `data-rembric-ts` is what a
 * client upgrades to the viewer's timezone, so a server render and a hydrated
 * render never disagree about the text node before that upgrade runs.
 */
export function Timestamp({
  value,
  className,
}: {
  value: Date | string | number | null | undefined;
  className?: string;
}) {
  if (value === null || value === undefined) return <>—</>;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return <>—</>;
  const iso = date.toISOString();
  return (
    <time dateTime={iso} data-rembric-ts className={className}>
      {iso.replace('T', ' ').slice(0, 19) + ' UTC'}
    </time>
  );
}
