'use client';

import { createContext, useActionState, useContext, useId, type ReactNode } from 'react';

import { Flash } from '@/components/dashboard/ui';

/**
 * A refused mutation has to surface somewhere: a Server Action returns the message
 * instead of redirecting, and every form renders it as a `Flash` above its own
 * fields. The provider also publishes the form's id so `ConfirmSubmit` can reach
 * it from a Radix portal.
 */
export interface ActionState {
  error: string | null;
}

export type FormAction = (state: ActionState, formData: FormData) => Promise<ActionState>;

const FormIdContext = createContext<string | null>(null);

export function useActionFormId(): string | null {
  return useContext(FormIdContext);
}

export function ActionForm({
  action,
  children,
  className,
}: {
  action: FormAction;
  children: ReactNode;
  className?: string;
}) {
  const [state, formAction] = useActionState(action, { error: null });
  const formId = useId();

  return (
    <FormIdContext.Provider value={formId}>
      <form id={formId} action={formAction} className={className}>
        {state.error === null ? null : (
          <div className="mb-4">
            <Flash tone="danger" label="ERROR">
              {state.error}
            </Flash>
          </div>
        )}
        {children}
      </form>
    </FormIdContext.Provider>
  );
}
