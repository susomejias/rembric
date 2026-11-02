'use client';

import type { ActionState } from '@/components/dashboard/action-form';
import { CopyPlaintextButton } from '@/components/dashboard/tokens-sheet';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface RotationState extends ActionState {
  plaintext?: string;
  reauthenticate?: boolean;
}

export function TokenRotationResult({
  name,
  plaintext,
  onDismiss,
}: {
  name: string;
  plaintext: string;
  onDismiss: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Token &quot;{name}&quot; rotated</DialogTitle>
          <DialogDescription>
            Copy the replacement secret now. It will not be shown again. The previous secret, linked
            dashboard sessions and all OAuth codes, access and refresh tokens are invalid. Update
            your clients and reconnect.
          </DialogDescription>
        </DialogHeader>
        <code className="overflow-x-auto rounded-lg border border-border bg-background p-3 font-mono text-xs">
          {plaintext}
        </code>
        <DialogFooter>
          <CopyPlaintextButton value={plaintext} />
          <Button type="button" onClick={onDismiss}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
