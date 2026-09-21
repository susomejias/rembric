'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';

/**
 * The manual-update command with its copy control — `update-modal.ts`'s
 * `[data-upd-copy]` behaviour: write the command to the clipboard and relabel
 * the button `COPIED`.
 *
 * A client component because the clipboard is a browser API, and one that is not
 * always present (a non-secure origin): main guarded on `navigator.clipboard`
 * and so does this, so the button stays `COPY` rather than claiming a copy that
 * did not happen. The command is a prop, so the string has one definition.
 */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const copy = (): void => {
    if (navigator.clipboard === undefined) return;
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <code className="border border-border bg-muted px-2.5 py-1.5 font-mono text-xs text-foreground">
        {command}
      </code>
      <Button type="button" variant="secondary" size="sm" onClick={copy}>
        {copied ? 'COPIED' : 'COPY'}
      </Button>
    </div>
  );
}
