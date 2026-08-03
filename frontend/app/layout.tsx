import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import NextTopLoader from 'nextjs-toploader';
import { Analytics } from "@vercel/analytics/next";
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/site";
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
  // metadataBase pozwala podawać w podstronach ścieżki względne - Next dokleja do nich domenę.
  // Bez tego Open Graph dostaje adres względny, a serwisy społecznościowe nie pokazują podglądu.
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_NAME,
    // Podstrony ustawiają własny tytuł ("Repertuar kin w Poznaniu") - szablon dokleja markę,
    // żeby w wynikach wyszukiwania było widać, z jakiego serwisu pochodzi wynik.
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: {
    type: "website",
    locale: "pl_PL",
    siteName: SITE_NAME,
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
  },
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
