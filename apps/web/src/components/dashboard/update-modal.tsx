'use client';

import type { UpdateInfo } from '@rembric/core';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { ActionForm, type FormAction } from '@/components/dashboard/action-form';
import { ConfirmSubmit } from '@/components/dashboard/confirm-submit';
import { Time } from '@/components/dashboard/ui';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const DISMISS_KEY = 'rbr-upd-dismissed';

function dismissedVersion(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

export function UpdateModal({
  info,
  csrfToken,
  startUpdate,
}: {
  info: UpdateInfo;
  csrfToken: string;
  startUpdate: FormAction;
}) {
  const version = info.latestVersion;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (dismissedVersion() !== version) setOpen(true);
  }, [version]);

  const dismiss = (): void => {
    try {
      localStorage.setItem(DISMISS_KEY, version);
    } catch {
      /* private mode: the dismissal simply does not survive the reload */
    }
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="max-w-lg gap-4 rounded-2xl border border-border bg-card p-5 sm:max-w-lg md:p-6"
      >
        <DialogHeader className="gap-3">
          <p className="font-mono text-[11px] uppercase tracking-[.14em] text-primary">
            Update available
          </p>
          <DialogTitle className="text-xl font-semibold tracking-tight">
            A newer Rembric is published
          </DialogTitle>
          <DialogDescription>
            v{info.latestVersion} can be installed from this dashboard — Rembric backs up the
            database, then a short-lived upgrader container replaces and restarts the server.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-3">
          <code className="rounded-md border border-border px-2 py-1 font-mono text-sm text-muted-foreground">
            v{info.currentVersion}
          </code>
          <span className="text-muted-foreground">→</span>
          <code className="rounded-md border border-primary/40 bg-primary/10 px-2 py-1 font-mono text-sm text-primary">
            v{info.latestVersion}
          </code>
          {info.publishedAt ? (
            <span className="font-mono text-[11px] uppercase tracking-[.14em] text-muted-foreground">
              published <Time value={info.publishedAt} />
            </span>
          ) : null}
        </div>

        <div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="font-mono text-[11px] uppercase tracking-[.14em] text-muted-foreground">
              What&apos;s new
            </span>
            {info.releaseUrl ? (
              <a
                href={info.releaseUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[11px] uppercase tracking-[.14em] text-muted-foreground transition-colors hover:text-primary"
              >
                View release on GitHub ›
              </a>
            ) : null}
          </div>
          <pre className="mt-2 max-h-56 overflow-auto rounded-xl border border-border bg-muted/40 p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-muted-foreground">
            {info.changelog.trim().length > 0 ? info.changelog : '(no changelog provided)'}
          </pre>
        </div>

        <ActionForm action={startUpdate}>
          <input type="hidden" name="csrf" value={csrfToken} />
          <ConfirmSubmit
            tone="danger"
            title={`Install v${info.latestVersion}?`}
            description={`Rembric will back up the database, stop, replace its container with v${info.latestVersion} and restart. Your data and configuration are preserved.`}
            confirmLabel="UPDATE NOW"
          >
            <Button type="button" className="w-full">
              UPDATE TO v{info.latestVersion} →
            </Button>
          </ConfirmSubmit>
        </ActionForm>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <Button
            type="button"
            variant="ghost"
            onClick={dismiss}
            className="font-mono text-[11px] uppercase tracking-[.14em] text-muted-foreground"
          >
            Later
          </Button>
          <Button asChild variant="secondary">
            <Link href="/dashboard/update">OPEN UPDATE PAGE →</Link>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
