/**
 * Bazowy adres witryny - potrzebny sitemapie, robots.txt i metadanym Open Graph, bo wszystkie
 * wymagają adresów ABSOLUTNYCH (podgląd linku na Facebooku czy w Messengerze nie zadziała ze ścieżką).
 *
 * Kolejność źródeł:
 *  1. NEXT_PUBLIC_SITE_URL - ustaw ręcznie po podpięciu własnej domeny (np. https://repertuar.pl),
 *  2. VERCEL_PROJECT_PRODUCTION_URL - Vercel podstawia sam adres produkcyjny, więc bez własnej domeny
 *     nic nie trzeba konfigurować; zmienna NIE zawiera protokołu, stąd doklejane https://,
 *  3. localhost - dla `npm run dev`.
 *
 * Świadomie bierzemy adres PRODUKCYJNY, a nie `VERCEL_URL`: ten drugi wskazuje na konkretne wdrożenie
 * (inny losowy adres przy każdym deployu), więc trafiłby do sitemapy jako link nie do utrzymania.
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:3000")
).replace(/\/+$/, "");

/**
 * Nazwa marki - spójna z domeną (cowkinie.pl) i z nagłówkiem strony ("Co w kinie w Poznaniu").
 * Trafia do tytułu zakładki, szablonu tytułów podstron i obrazka podglądu linku, więc trzymanie
 * jej tutaj jest jedynym miejscem do zmiany.
 *
 * Opis celowo zaczyna się od "Repertuar kin": to fraza wyszukiwarkowa, a nazwa marki nic o serwisie
 * nie mówi komuś, kto trafia na niego pierwszy raz z listy wyników.
 */
export const SITE_NAME = "Co w kinie";
export const SITE_DESCRIPTION =
  "Repertuar kin w jednym miejscu - Multikino, Cinema City, Helios oraz kina studyjne. " +
  "Seanse, godziny i linki do biletów.";
