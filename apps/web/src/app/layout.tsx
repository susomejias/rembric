import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';

import './globals.css';

/**
 * The three brand faces, self-hosted through `next/font/local` and exposed as
 * the theme's font variables (`--font-space-grotesk` / `--font-inter` /
 * `--font-jetbrains-mono`, wired to `--font-display` / `--font-sans` /
 * `--font-mono` in `globals.css`). These are the same families the production
 * dashboard serves from `/dashboard/assets/fonts/`; `next/font` hashes and
 * preloads them instead of relying on a public path.
 */
const spaceGrotesk = localFont({
  src: [
    { path: './fonts/space-grotesk-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/space-grotesk-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/space-grotesk-600.woff2', weight: '600', style: 'normal' },
    { path: './fonts/space-grotesk-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-space-grotesk',
  display: 'swap',
});

const inter = localFont({
  src: [
    { path: './fonts/inter-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/inter-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/inter-600.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-inter',
  display: 'swap',
});

const jetbrainsMono = localFont({
  src: [
    { path: './fonts/jetbrains-mono-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/jetbrains-mono-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/jetbrains-mono-600.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

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
 * `dark` is the document's *base* state and its only one: the class is
 * server-rendered and nothing removes it, so every route — the dashboard, the
 * login screen, the 404 — renders in the dark palette regardless of the OS or a
 * previously stored preference. That is also what makes the `dark:` utilities of
 * the generated `ui/*` primitives apply by default.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark ${spaceGrotesk.variable} ${inter.variable} ${jetbrainsMono.variable}`}
    >
      <body className="antialiased">{children}</body>
    </html>
  );
}
