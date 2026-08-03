import type { NextConfig } from "next";

// Hosty, z których pochodzą plakaty - dokładnie te, które scraper zapisuje do kolumn `poster*`.
// Lista MUSI być zawężona. Wcześniej stało tu `hostname: "**"`, co przy WYŁĄCZONEJ optymalizacji było
// nieszkodliwe (przeglądarka i tak szła po obrazek bezpośrednio), ale po jej włączeniu zamieniłoby
// aplikację w otwarte proxy do obrazków - każdy mógłby przepuszczać dowolne pliki przez nasz
// optymalizator, na nasz rachunek.
//
// Po dodaniu nowego kina sprawdź, czy jego plakaty nie idą z nowego hosta - inaczej `next/image`
// odrzuci je błędem 400 i kafelki zostaną puste. Aktualną listę hostów daje przegląd kolumn
// `poster*` w tabeli `movies`.
const POSTER_HOSTS = [
  "image.tmdb.org",
  "fwcdn.pl",
  "www.multikino.pl",
  "www.cinema-city.pl",
  "www.kinomuza.pl",
  "movies.helios.pl",
  "kinopalacowe.pl",
  "www.kinomalta.pl",
  "kinoapollo.pl",
] as const;

const nextConfig: NextConfig = {
  images: {
    // Celowo NIE ograniczamy `search`: Multikino dokleja do adresów plakatów `?rev=...` (108 pozycji
    // w bazie), więc `search: ""` wyciąłby wszystkie jego okładki.
    remotePatterns: POSTER_HOSTS.map((hostname) => ({ protocol: "https" as const, hostname })),

    // Wymagane od Next.js 16 - bez tej listy optymalizator odrzuca żądania o inną jakość.
    // 75 to wartość domyślna komponentu <Image>, a `quality` nie ustawiamy nigdzie ręcznie.
    qualities: [75],

    // Domyślne 4 godziny oznaczałyby ponowne pobranie i przetworzenie plakatu kilka razy dziennie.
    // Pod danym adresem plakat praktycznie nigdy się nie zmienia (zmiana okładki = nowy plik u kina),
    // więc trzymamy przetworzone wersje przez miesiąc. Mniej transformacji = niższy rachunek.
    minimumCacheTTL: 2678400, // 31 dni

    // Najcięższy plakat w bazie ma 2.6 MB, więc domyślny limit 50 MB to zbędne ryzyko dla pamięci.
    maximumResponseBody: 5_000_000,
  },
};

export default nextConfig;
