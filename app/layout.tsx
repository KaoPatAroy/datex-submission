import type { Metadata } from 'next';
import { Anuphan } from 'next/font/google';
import './globals.css';

const anuphan = Anuphan({ subsets: ['thai', 'latin'], display: 'swap', variable: '--font-anuphan' });

export const metadata: Metadata = {
  title: 'DaTex',
  description: 'พื้นที่ทำงานสำหรับข้อมูลและการตัดสินใจของ DaTex',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="th" className={anuphan.variable}>
      <body>{children}</body>
    </html>
  );
}
