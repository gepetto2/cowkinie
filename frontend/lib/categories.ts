/**
 * Etykiety sekcji na stronie głównej.
 *
 * Klucze sekcji to albo `movie_type` prosto z bazy (zapisywany WERSALIKAMI przez scrapery, bo tam jest
 * wartością techniczną), albo nazwy nadawane w page.tsx ("Kina Studyjne", "STANDARD"). Dawało to
 * nagłówki krzyczące "KULTOWE" i "UKRAIŃSKI DUBBING" obok spokojnego "Wydarzenia i pokazy specjalne".
 *
 * Mapujemy więc DOPIERO przy wyświetlaniu - klucze zostają nietknięte, żeby grupowanie, sortowanie
 * i kolejność sekcji działały dalej bez zmian.
 *
 * Etykieta na kafelku (`typeLabel` w MovieCard) celowo NIE korzysta z tej mapy: tam wielkie litery
 * nakłada CSS (`uppercase`), bo to mały badge, w którym krótsza forma czyta się lepiej.
 */
const CATEGORY_LABELS: Record<string, string> = {
  // Sekcja główna - filmy bez `movie_type`, grane poza kinami studyjnymi.
  // Wcześniej ta sekcja w ogóle nie miała nagłówka.
  "STANDARD": "Aktualnie w kinach",
  "Kina Studyjne": "Kina studyjne",

  "KULTOWE": "Kultowe",
  "DLA DZIECI": "Dla dzieci",
  "MARATON": "Maratony",
  "KONCERT": "Koncerty",
  "TEATR": "Teatr",
  "OPERA": "Opera",
  "BALET": "Balet",
  "CYRK": "Cyrk",
  "SPORT": "Sport",
  "WYSTAWY": "Wystawy",
  "PANEL": "Panele dyskusyjne",
  "UKRAIŃSKI DUBBING": "Ukraiński dubbing",
  // Pokazy z audiodeskrypcją, napisami dla niesłyszących i tłumaczeniem na język migowy (Pałacowe).
  // Osobny rekord filmu, nie atrybut seansu - patrz clean_movie_title w scrapers/kino_palacowe.py.
  "KINO BEZ BARIER": "Kino bez barier",
  "NAJLEPSZE Z NAJGORSZYCH": "Najlepsze z najgorszych",
  "KARAOKE": "Pokazy karaoke",
  // Bloki konkursowe i pokazy w ramach przeglądów (Orzeł oznacza je wprost w repertuarze).
  "FESTIWAL": "Festiwale i przeglądy",

  // Nazwy własne cykli - zapis zgodny z tym, jak posługują się nimi same kina.
  "SALON KULTURY": "Salon Kultury",
  "LADIES NIGHT/KNO": "Ladies Night",
  "UNLIMITED SHOW": "Unlimited Show",
};

/**
 * Nagłówek sekcji dla danego klucza. Nieznany typ (np. dodany później przez scraper) dostaje
 * pierwszą literę wielką, resztę małą - dzięki temu nowa kategoria nigdy nie trafi na stronę
 * wykrzyczana wersalikami, nawet zanim ktoś doda ją do mapy.
 */
export function categoryLabel(key: string): string {
  const known = CATEGORY_LABELS[key];
  if (known) return known;
  // Klucze spoza mapy bywają już poprawnie sformatowane ("Wyniki wyszukiwania") - takich nie ruszamy.
  if (key !== key.toUpperCase()) return key;
  return key.charAt(0) + key.slice(1).toLowerCase();
}
