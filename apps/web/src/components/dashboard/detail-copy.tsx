'use client';

import { Copy } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

export function DetailCopy({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('error');
    }
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={label}
      onClick={() => {
        void copy();
      }}
    >
      <Copy className="size-3.5" />
      <span aria-live="polite">
        {state === 'copied' ? 'Copied' : state === 'error' ? 'Copy failed' : label}
      </span>
    </Button>
  );
}
