'use client';

import { createContext, useActionState, useContext, useId, type ReactNode } from 'react';

import { Flash } from '@/components/dashboard/ui';

/**
 * The wrapper every dashboard mutation form uses. It exists for two reasons:
 *
 *  - a refused mutation has to surface *somewhere*. The Hono handlers redirected
 *    to an error page (or a `?error=` flash); a Server Action returns the message
 *    instead, and every form renders it the same way — a `Flash` above its own
 *    fields, so the operator's input is still in front of them.
 *  - the form's id. A confirmation dialog's own button lives in a Radix portal,
 *    outside the form element, so it reaches the form by `id` instead of by DOM
 *    ancestry; the provider is what lets `ConfirmSubmit` discover that id without
 *    every call site inventing one.
 *
 * `useActionState`'s pending flag is deliberately not rendered: main's forms
 * never disabled themselves, and a disabled submit is a behavior the operator
 * did not have before.
 */
export interface ActionState {
  error: string | null;
}

export type FormAction = (state: ActionState, formData: FormData) => Promise<ActionState>;

const FormIdContext = createContext<string | null>(null);

/** The enclosing `ActionForm`'s element id, or `null` outside one. */
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
