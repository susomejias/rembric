'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NAV } from '@/lib/nav';
import { cn } from '@/lib/utils';

/**
 * The command palette (Cmd+K / Ctrl+K): every dashboard view by name, plus the
 * active memories by title.
 *
 * Why not `cmdk`: Midday's palette is built on shadcn's `Command`, which wraps
 * `cmdk` — a dependency this workspace does not have and, on the instruction for
 * this slice, must not gain. The keyboard contract the operator actually uses
 * (arrow keys, Enter, Escape, filtered list, active item scrolled into view) is
 * reimplemented here over the existing `Dialog` + `Input` primitives, so the
 * palette is one self-contained client component instead of a new dependency.
 *
 * Why the memories arrive as props instead of a fetch: the list is read by the
 * server layout that mounts this component (`loadPaletteMemories`), which keeps
 * the palette a pure client filter with no request per keystroke and no new HTTP
 * endpoint on the dashboard. The limit that read applies is what bounds the
 * payload — it is a search over the most recent active memories, not over the
 * whole corpus.
 */

export const COMMAND_PALETTE_OPEN_EVENT = 'rembric:command-palette-open';

export interface PaletteMemory {
  readonly id: string;
  readonly title: string;
  readonly projectLabel: string;
}

/** How many memories the palette shows at rest, and at most while searching. */
const MAX_MEMORY_RESULTS = 20;
const IDLE_MEMORY_RESULTS = 8;

interface PaletteItem {
  readonly key: string;
  readonly label: string;
  readonly meta: string;
  readonly group: 'Views' | 'Memories';
  readonly href: string;
  readonly icon?: React.ComponentType<{ className?: string }>;
}

export function CommandPalette({ memories }: { memories: readonly PaletteMemory[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((previous) => !previous);
      }
    };
    const onOpenRequest = () => setOpen(true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpenRequest);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpenRequest);
    };
  }, []);

  const needle = query.trim().toLowerCase();

  const items = useMemo<PaletteItem[]>(() => {
    const views: PaletteItem[] = NAV.filter(
      (entry) => needle === '' || entry.label.toLowerCase().includes(needle),
    ).map((entry) => ({
      key: `view:${entry.key}`,
      label: entry.label,
      meta: entry.href,
      group: 'Views',
      href: entry.href,
      icon: entry.icon,
    }));

    const matched = needle === '' ? memories : memories.filter(hasTitleMatch(needle));
    const hits: PaletteItem[] = matched
      .slice(0, needle === '' ? IDLE_MEMORY_RESULTS : MAX_MEMORY_RESULTS)
      .map((memory) => ({
        key: `memory:${memory.id}`,
        label: memory.title,
        meta: memory.projectLabel,
        group: 'Memories',
        href: `/dashboard/memories/${memory.id}`,
      }));

    return [...views, ...hits];
  }, [memories, needle]);

  // A new query re-ranks the list, so the highlight returns to the first row.
  useEffect(() => setActive(0), [needle, open]);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const visit = useCallback(
    (href: string) => {
      setOpen(false);
      setQuery('');
      router.push(href);
    },
    [router],
  );

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (items.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current) => (current + 1) % items.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => (current - 1 + items.length) % items.length);
    } else if (event.key === 'Enter') {
      const item = items[active];
      if (item) {
        event.preventDefault();
        visit(item.href);
      }
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <DialogContent
        className="max-w-xl gap-0 overflow-hidden p-0"
        showCloseButton={false}
        aria-label="Command palette"
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Search every dashboard view and the most recent active memories.
        </DialogDescription>
        <Input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder="Jump to a view, or search memories…"
          aria-label="Search views and memories"
          aria-controls="command-palette-results"
          className="h-12 rounded-none border-0 border-b font-sans shadow-none focus-visible:ring-0"
        />
        <div
          id="command-palette-results"
          role="listbox"
          aria-label="Results"
          className="max-h-[22rem] overflow-y-auto p-2"
        >
          {items.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              No results for “{query.trim()}”.
            </p>
          ) : (
            groupItems(items).map((group) => (
              <div
                key={group.label}
                role="group"
                aria-label={group.label}
                className="flex flex-col gap-1"
              >
                <p className="px-3 pt-2 pb-1 font-mono text-xs tracking-[0.18em] text-muted-foreground uppercase">
                  {group.label}
                </p>
                {group.items.map(({ item, index }) => (
                  <button
                    key={item.key}
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    ref={index === active ? activeRef : undefined}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => visit(item.href)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm',
                      index === active ? 'bg-accent text-accent-foreground' : 'text-foreground',
                    )}
                  >
                    {item.icon ? (
                      <item.icon className="size-4 shrink-0 text-muted-foreground" />
                    ) : null}
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {item.meta}
                    </span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
        <div className="flex items-center justify-between border-t px-3 py-2 font-mono text-xs text-muted-foreground">
          <span>↑↓ navigate · ↵ open · esc close</span>
          <span>
            {items.length} RESULT{items.length === 1 ? '' : 'S'}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The header's discoverability affordance: the same route as Cmd+K, for a pointer. */
export function CommandPaletteTrigger({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT))}
      className={cn(
        'flex h-8 items-center gap-2 rounded-lg border border-input px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
        className,
      )}
      aria-label="Open the command palette"
    >
      <span>Search</span>
      <kbd className="rounded border border-border px-1 font-mono text-[10px]">⌘K</kbd>
    </button>
  );
}

/**
 * Title search is a substring match, deliberately: the FTS `MATCH` the memories
 * page uses tokenises, so a partial word ("authen") would answer nothing while
 * the operator is still typing. The palette's corpus is the slice the server
 * sent, so a linear scan over its titles is the honest cost here.
 */
function hasTitleMatch(needle: string): (memory: PaletteMemory) => boolean {
  return (memory) => memory.title.toLowerCase().includes(needle);
}

function groupItems(
  items: readonly PaletteItem[],
): { label: string; items: { item: PaletteItem; index: number }[] }[] {
  const groups: { label: string; items: { item: PaletteItem; index: number }[] }[] = [];
  items.forEach((item, index) => {
    const last = groups.at(-1);
    if (last && last.label === item.group) last.items.push({ item, index });
    else groups.push({ label: item.group, items: [{ item, index }] });
  });
  return groups;
}
