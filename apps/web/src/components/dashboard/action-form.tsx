'use client';

import { CircleAlert } from 'lucide-react';
import { createContext, useActionState, useContext, useId, type ReactNode } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

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
  onSubmit,
}: {
  action: FormAction;
  children: ReactNode;
  className?: string;
  onSubmit?: React.DOMAttributes<HTMLFormElement>['onSubmit'];
}) {
  const [state, formAction] = useActionState(action, { error: null });
  const formId = useId();

  return (
    <FormIdContext.Provider value={formId}>
      <form id={formId} action={formAction} onSubmit={onSubmit} className={className}>
        {state.error === null ? null : (
          <Alert variant="destructive" className="mb-4">
            <CircleAlert />
            <AlertTitle>Action failed</AlertTitle>
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        )}
        {children}
      </form>
    </FormIdContext.Provider>
  );
}
