import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

/**
 * One family and one mono, per DESIGN.md. `display: 'swap'` so a cold font
 * fetch shows text in the fallback rather than showing nothing — on a screen
 * whose whole point is that a slow first load stays honest, a blank page while
 * a font downloads would be the same failure in a different layer.
 */
const geist = Geist({ subsets: ['latin'], variable: '--font-geist', display: 'swap' });
const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Atrium — operations console',
  description: 'Studio booking operations console',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
