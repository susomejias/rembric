'use client';

import { Copy } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

export function DetailCopy({
  text,
  label = 'Copy',
  size = 'sm',
}: {
  text: string;
  label?: string;
  size?: 'sm' | 'lg';
}) {
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
      size={size}
      aria-label={label}
      onClick={() => {
        void copy();
      }}
    >
      <Copy />
      <span aria-live="polite">
        {state === 'copied' ? 'Copied' : state === 'error' ? 'Copy failed' : label}
      </span>
    </Button>
  );
}
