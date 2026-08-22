import type { Metadata } from 'next';
import { IBM_Plex_Mono, Instrument_Sans, Instrument_Serif } from 'next/font/google';
import type { ReactNode } from 'react';

import './globals.css';
import { Nav } from './components/Nav';

const sans = Instrument_Sans({
  subsets: ['latin'],
  variable: '--font-app-sans',
  display: 'swap',
});

const display = Instrument_Serif({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-app-display',
  display: 'swap',
});

const mono = IBM_Plex_Mono({
  weight: ['400', '500', '600'],
  subsets: ['latin'],
  variable: '--font-app-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Sequencer — Revenue recovery control',
  description:
    'Reason-aware recovery for recurring payments. Diagnose the failure, protect the attempt budget, and keep every decision auditable.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable} ${mono.variable}`}>
      <body className="min-h-screen">
        <Nav />
        <main className="mx-auto w-full max-w-6xl px-4 pt-8 pb-20 sm:px-6 sm:pt-10 lg:px-8">
          {children}
        </main>
      </body>
    </html>
  );
}
