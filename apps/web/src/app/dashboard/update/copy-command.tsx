'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';

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
