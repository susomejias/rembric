import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'Rembric — Persistent memory for coding agents',
  description: 'Self-hosted memory, sessions, and context for AI coding agents.',
  icons: {
    icon: '/favicon.png',
    shortcut: '/favicon.png',
    apple: '/favicon.png',
  },
};

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#0b100e',
};

/**
 * `dark` is the document's *base* state, not an opt-in: the v0 palette is
 * dark-first, so the class is server-rendered and the light variant is the
 * class the pre-paint script swaps in. That ordering is also what makes the
 * `dark:` utilities of the generated `ui/*` primitives apply by default.
 * `suppressHydrationWarning` covers the one attribute the script rewrites before
 * React hydrates.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="antialiased">{children}</body>
    </html>
  );
}
