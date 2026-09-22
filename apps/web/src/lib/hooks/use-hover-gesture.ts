'use client';

import { useMemo, useRef } from 'react';

import { isHoveringPointer } from '@/lib/touch';

interface BoundaryEvent {
  pointerId: number;
  pointerType: string;
  buttons: number;
}

export interface HoverGesture {
  enter: (event: BoundaryEvent) => boolean;
  leave: (event: BoundaryEvent) => boolean;
}

export function useHoverGesture(): HoverGesture {
  const contact = useRef(new Set<number>());

  return useMemo(
    () => ({
      enter: (event) => {
        if (isHoveringPointer(event)) {
          contact.current.delete(event.pointerId);
          return true;
        }
        contact.current.add(event.pointerId);
        return false;
      },
      leave: (event) => {
        const arrivedInContact = contact.current.delete(event.pointerId);
        return !arrivedInContact && event.pointerType !== 'touch';
      },
    }),
    [],
  );
}
