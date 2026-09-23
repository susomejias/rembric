'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { ActionState } from '@/components/dashboard/action-form';
import { UndoPill } from '@/components/spectrumui/undo-pill';

export function SessionUndoPill({
  id,
  restoreAction,
}: {
  id: string;
  restoreAction: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [open, setOpen] = useState(true);
  const router = useRouter();

  const undo = () => {
    setOpen(false);
    const formData = new FormData();
    formData.set('id', id);
    void restoreAction({ error: null }, formData).then(() => router.refresh());
  };

  return (
    <UndoPill
      open={open}
      label={`Session ${id.slice(-8)} deleted`}
      duration={8}
      onUndo={undo}
      onExpire={() => setOpen(false)}
      className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2"
    />
  );
}
