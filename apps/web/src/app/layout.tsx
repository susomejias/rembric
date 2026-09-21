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
  themeColor: '#0a0a0a',
};

/**
 * `dark` is the document's *base* state, not an opt-in: the theme is dark-first,
 * so the class is server-rendered and the pre-paint script removes it for a
 * viewer who chose light. That ordering is also what makes the `dark:`
 * utilities of the generated `ui/*` primitives apply by default.
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
