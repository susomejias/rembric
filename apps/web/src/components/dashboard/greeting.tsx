'use client';

import { MoonStar, Sun, Sunrise } from 'lucide-react';
import { useEffect, useState } from 'react';

type GreetingSpec = {
  readonly label: string;
  readonly Icon: typeof Sun;
};

function greetingFor(hour: number): GreetingSpec {
  if (hour < 6) return { label: 'Burning the midnight oil', Icon: MoonStar };
  if (hour < 12) return { label: 'Good morning', Icon: Sunrise };
  if (hour < 19) return { label: 'Good afternoon', Icon: Sun };
  return { label: 'Good evening', Icon: MoonStar };
}

export function Greeting() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const greeting = mounted ? greetingFor(new Date().getHours()) : null;

  return (
    <h1 className="flex items-center gap-3 text-3xl font-semibold tracking-tight text-foreground">
      {greeting ? (
        <>
          <greeting.Icon aria-hidden="true" className="size-7 shrink-0 text-foreground" />
          {greeting.label}
        </>
      ) : (
        'Hello'
      )}
    </h1>
  );
}
