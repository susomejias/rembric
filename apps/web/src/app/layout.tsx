import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';

import './globals.css';

const geistSans = localFont({
  src: [
    { path: './fonts/geist-sans-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/geist-sans-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/geist-sans-600.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-geist',
  display: 'swap',
});

const geistMono = localFont({
  src: [
    { path: './fonts/geist-mono-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/geist-mono-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/geist-mono-600.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-geist-mono',
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
  themeColor: '#09090b',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`dark ${geistSans.variable} ${geistMono.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
