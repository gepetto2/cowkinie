import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import NextTopLoader from 'nextjs-toploader';
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Repertuar Kin",
  description: "Sprawdź aktualny repertuar i dostępność biletów w Twoich ulubionych kinach.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="pl"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-slate-950 text-slate-50">
        <NextTopLoader color="#4f46e5" showSpinner={false} shadow="0 0 10px #4f46e5,0 0 5px #4f46e5" />
        {children}
        {/* Statystyki odwiedzin. W layoucie głównym, żeby liczyć każdą podstronę (miasta, ekran
            wyboru), i na końcu <body>, żeby skrypt nie konkurował o pasmo z treścią.
            Zbiera dane bez ciasteczek, więc nie wymaga banera zgód. Na localhost nic nie wysyła -
            dane pojawią się dopiero po wdrożeniu i włączeniu zakładki Analytics w panelu Vercela. */}
        <Analytics />
      </body>
    </html>
  );
}
