import { Suspense } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import {
  getCities, getMovies, getAvailableDates, getFilteredAvailability, getDateDaysAgo,
  getCinemaAvailabilities, getScreeningCounts, getAvailableFormats,
} from '@/lib/supabase/queries';
import MovieCard from '@/components/MovieCard';
import Carousel from '@/components/Carousel';
import FilterBar from '@/components/FilterBar';
import { CityScopeProvider } from '@/components/CityScope';
import { parseCityScope, scopeFromCookie, cityScopeHref, citiesLocative, CITY_COOKIE } from '@/lib/cities';
import { categoryLabel } from '@/lib/categories';
import { computeRatingMeans, bayesianScore } from '@/lib/ratings';

// Szerokość kafelka w karuzelach. Na mobile PŁYNNA i odtwarzająca matematykę siatki `grid-cols-3`
// niżej, żeby karuzele i rozwinięte sekcje miały identyczny rozmiar - wcześniej siatka dawała ~106 px,
// a karuzele sztywne 140 px, więc ta sama sekcja kurczyła się przy rozwijaniu.
// 2.5rem = 40 px = padding kontenera (px-3, czyli 2×12) + odstępy siatki (gap-2, czyli 2×8);
// zmiana któregokolwiek z nich wymaga poprawki tutaj. Od `sm` w górę siatka ma 4+ kolumn,
// więc wracamy do sztywnych rozmiarów.
const CARD_WIDTH = 'w-[calc((100vw-2.5rem)/3)] sm:w-[160px] lg:w-[180px]';

// Parametry adresu NALEŻĄCE DO APLIKACJI. Reszta to znaczniki doklejane przez serwisy, z których
// przyszedł link (`fbclid` z Facebooka i Messengera, `utm_*`, `gclid`, `igshid`...) - nie niosą
// żadnej intencji użytkownika, więc nie mogą wpływać na to, co pokazujemy.
//
// Powód: wejście na goły "/" ma odesłać na ekran wyboru miasta, ale warunkiem było "brak
// JAKICHKOLWIEK parametrów". Link otwarty w Messengerze przychodzi jako "/?fbclid=...", więc
// warunek nie był spełniony i użytkownik lądował od razu na repertuarze całej Polski, nigdy nie
// widząc ekranu wyboru.
const APP_PARAMS = ['q', 'miasta', 'from', 'to', 'format', 'genre'] as const;

// Typy filmów pomijane w karuzelach "Nowości"/"Wkrótce" (dopisuj wg potrzeb).
const CAROUSEL_EXCLUDED_TYPES = ['SPORT', 'TEATR', 'UKRAIŃSKI DUBBING', 'KINO BEZ BARIER', 'UNLIMITED SHOW', 'CYRK', 'MARATON', 'WYSTAWY', 'DLA DZIECI', 'SALON KULTURY', 'KONCERT', 'LADIES NIGHT/KNO', 'BALET', 'OPERA', 'PANEL'];

// Maksymalna różnica (w latach) między rokiem produkcji a rokiem premiery kinowej.
// Powyżej tej wartości traktujemy film jako wznowienie starego tytułu i pomijamy w karuzelach.
const CAROUSEL_MAX_YEAR_GAP = 1;

// Normalizacja do wyszukiwania: małe litery, bez diakrytyków (ł->l), by np. "zelazny" znalazł
// "Żelazny", a "lea seydoux" -> "Léa Seydoux". Stosowana i do zapytania, i do przeszukiwanego tekstu.
const normalizeSearch = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');

// Segment opcjonalny ([[...miasto]]) łapie zarówno "/" (miasto === undefined, czyli cała Polska),
// jak i "/poznan". Dzięki temu adres domyślny nie wymaga sztucznego segmentu w stylu /wszystkie.
type PageProps = {
  params: Promise<{ miasto?: string[] }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

/** Segment miasta ze ścieżki: '' dla "/", 'poznan' dla "/poznan", null dla ścieżek głębszych (404). */
function citySegment(miasto?: string[]): string | null {
  if (!miasto || miasto.length === 0) return '';
  return miasto.length === 1 ? miasto[0] : null; // /poznan/cokolwiek nie jest poprawnym adresem
}

// Osobny tytuł per miasto - "Repertuar kin w Poznaniu" to realne zapytanie w wyszukiwarce,
// a segment ścieżki daje mu własny, indeksowalny adres.
export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { miasto } = await params;
  const sp = await searchParams;
  const cities = await getCities();
  const slug = citySegment(miasto);
  if (slug === null) return { title: 'Nie znaleziono strony' };
  // ?miasta= trzeba uwzględnić, inaczej przy wybranym podzbiorze tytuł kłamałby "w całej Polsce".
  const miastaParam = typeof sp?.miasta === 'string' ? sp.miasta : '';
  const { selected, valid } = parseCityScope(slug, miastaParam, cities);
  if (!valid) return { title: 'Nie znaleziono miasta' };
  // Odmieniona forma ("w Poznaniu") zamiast sztywnego "w mieście Poznań" - to dosłownie fraza,
  // którą ludzie wpisują w wyszukiwarkę, więc tytuł strony powinien ją zawierać wprost.
  const where = citiesLocative(selected);
  return {
    title: `Repertuar kin ${where}`,
    description: `Seanse i godziny w kinach ${where} - Multikino, Cinema City, Helios i kina studyjne w jednym miejscu.`,
  };
}

export default async function Home({ params: routeParams, searchParams }: PageProps) {
  const params = await searchParams;
  const { miasto } = await routeParams;
  const query = typeof params?.q === 'string' ? params.q.toLowerCase() : '';
  const miastaParam = typeof params?.miasta === 'string' ? params.miasta : '';
  // Zakres dat: from/to (włącznie). Jedna granica = pojedynczy dzień.
  const fromQuery = typeof params?.from === 'string' ? params.from : '';
  const toQuery = typeof params?.to === 'string' ? params.to : '';
  const rangeFrom = fromQuery || toQuery;
  const rangeTo = toQuery || fromQuery;
  const rangeActive = Boolean(rangeFrom);
  // Format to lista (multi-select), w URL rozdzielona przecinkami. Wersja językowa NIE jest już
  // filtrem globalnym - przeniesiona do modalu, bo to wybór dotyczący konkretnego filmu.
  const selectedFormats = typeof params?.format === 'string' && params.format
    ? params.format.split(',').filter(Boolean)
    : [];
  // Gatunek to atrybut filmu (kolumna genre), więc filtrujemy po stronie klienta (bez RPC).
  const selectedGenres = typeof params?.genre === 'string' && params.genre
    ? params.genre.split(',').filter(Boolean)
    : [];
  // Filtr daty/formatu wymaga danych na poziomie seansu -> liczymy je po stronie serwera (RPC).
  const serverFilterActive = rangeActive || selectedFormats.length > 0;

  // Lista miast musi być ZNANA PRZED resztą zapytań: rozstrzyga, czy slug w adresie jest poprawny,
  // a od wybranych miast zależy zapytanie o dostępność. getCities() jest cache'owane, więc to tanie.
  const cities = await getCities();
  const slug = citySegment(miasto);
  if (slug === null) notFound();

  // Wejście na GOŁY adres główny: jeśli użytkownik już kiedyś wybierał miasto, odsyłamy go tam,
  // a jeśli nie - na ekran wyboru.
  // Warunek "brak parametrów APLIKACJI" jest istotny z dwóch powodów. Po pierwsze link
  // z filtrami (np. /?q=spider) ma zadziałać tak, jak go udostępniono, zamiast przerzucać odbiorcę
  // do jego własnego miasta. Po drugie "wszystkie miasta" w filtrach prowadzi na /?miasta=wszystkie,
  // a nie na goły "/" - właśnie po to, żeby nie wpaść tutaj i nie zostać odesłanym z powrotem.
  // Znaczniki obcych serwisów (fbclid itp.) świadomie IGNORUJEMY - patrz APP_PARAMS.
  const hasAppParams = APP_PARAMS.some((k) => typeof params?.[k] === 'string' && params[k]);
  if (slug === '' && !hasAppParams) {
    const remembered = scopeFromCookie((await cookies()).get(CITY_COOKIE)?.value ?? '', cities);
    if (remembered === null) redirect('/wybierz-miasto');
    // Pusta lista = "cała Polska", czyli dokładnie ten adres - przekierowanie byłoby pętlą.
    if (remembered.length > 0) redirect(cityScopeHref(remembered));
  }

  const scope = parseCityScope(slug, miastaParam, cities);
  if (!scope.valid) notFound();
  const selectedCities = scope.selected; // pusta lista = cała Polska

  // Zrównoleglenie pobierania wszystkich danych (odczyty z bazy są cache'owane w queries.ts)
  const [
    movies,
    cinemaAvailabilities,
    screeningCounts,
    availableDates,
    formats,
    serverAvailByCity
  ] = await Promise.all([
    getMovies(),
    getCinemaAvailabilities(),
    getScreeningCounts(),
    Promise.resolve(getAvailableDates(1)), // dzisiejsza data dla karuzel
    getAvailableFormats(),
    // Gdy aktywny filtr daty/formatu: dostępność (film -> franczyzy) z pasujących seansów, po stronie serwera.
    // RPC przyjmuje JEDNO miasto, więc przy wyborze kilku odpytujemy je równolegle i sumujemy wyniki
    // (film pasuje, jeśli gra w KTÓRYMKOLWIEK z wybranych miast). W typowym przypadku - jedno miasto
    // albo cała Polska - to dokładnie jedno zapytanie, czyli tyle samo co dotąd.
    serverFilterActive
      ? Promise.all(
          (selectedCities.length ? selectedCities : ['']).map((c) =>
            getFilteredAvailability(rangeFrom, rangeTo, c, selectedFormats).then(
              (m) => [c, m] as const,
            ),
          ),
        )
      : Promise.resolve(null),
  ]);

  // Scalenie wyników RPC z poszczególnych miast w jedną strukturę: film -> miasta + franczyzy.
  const serverAvail = serverAvailByCity
    ? (() => {
        const merged = new Map<string, { cities: Set<string>; franchises: Set<string> }>();
        for (const [city, byMovie] of serverAvailByCity) {
          for (const [movieId, franchises] of byMovie) {
            let e = merged.get(movieId);
            if (!e) { e = { cities: new Set(), franchises: new Set() }; merged.set(movieId, e); }
            if (city) e.cities.add(city);
            for (const f of franchises) e.franchises.add(f);
          }
        }
        return merged;
      })()
    : null;

  // Dostępność per film: miasta oraz franczyzy w rozbiciu na miasto. Dzięki temu badge'y kin
  // można zawęzić do wybranego miasta (bez filtra pokazujemy wszystkie franczyzy filmu).
  const availabilityByMovie = new Map<string, { cities: Set<string>; franchisesByCity: Map<string, Set<string>> }>();
  for (const row of cinemaAvailabilities) {
    let entry = availabilityByMovie.get(row.movie_id);
    if (!entry) {
      entry = { cities: new Set(), franchisesByCity: new Map() };
      availabilityByMovie.set(row.movie_id, entry);
    }
    entry.cities.add(row.city);
    if (row.franchise) {
      let set = entry.franchisesByCity.get(row.city);
      if (!set) { set = new Set(); entry.franchisesByCity.set(row.city, set); }
      set.add(row.franchise);
    }
  }

  // Wzbogacenie filmów o dostępność kin ZALEŻNĄ OD AKTYWNYCH FILTRÓW. Zarówno badge'y (available_franchises),
  // jak i przynależność do wyników (matchesFilters) liczą się z tego samego zbioru, więc są zawsze spójne:
  //  - filtr daty/formatu  -> franczyzy/przynależność z pasujących seansów (miasto uwzględnione już w RPC),
  //  - samo miasto         -> franczyzy tego miasta z globalnego agregatu,
  //  - brak filtrów        -> wszystkie franczyzy filmu.
  // Tokeny gatunku filmu (kolumna genre to lista rozdzielona przecinkami).
  const movieGenres = (genre: string | null) => (genre ? genre.split(',').map(g => g.trim()).filter(Boolean) : []);
  // Dopasowanie gatunku: brak wybranych = każdy; inaczej film musi mieć któryś z wybranych (OR, jak format/wersja).
  const genreMatch = (genre: string | null) =>
    selectedGenres.length === 0 || movieGenres(genre).some(g => selectedGenres.includes(g));

  const enhancedMovies = movies.map(movie => {
    const entry = availabilityByMovie.get(movie.id);
    let franchises: string[];
    let matchesFilters: boolean;

    if (serverAvail) {
      const e = serverAvail.get(movie.id);
      matchesFilters = e !== undefined;
      franchises = e ? [...e.franchises].sort() : [];
    } else if (selectedCities.length) {
      // Film pasuje, jeśli gra w KTÓRYMKOLWIEK z wybranych miast; badge'y to suma franczyz z tych miast.
      matchesFilters = selectedCities.some((c) => entry?.cities.has(c));
      franchises = [
        ...new Set(selectedCities.flatMap((c) => [...(entry?.franchisesByCity.get(c) ?? [])])),
      ].sort();
    } else {
      matchesFilters = true;
      franchises = entry ? [...new Set([...entry.franchisesByCity.values()].flatMap(s => [...s]))].sort() : [];
    }

    // Filtr gatunku (po stronie klienta) zawężamy razem z dostępnością - spójnie dla listy i badge'ów.
    matchesFilters = matchesFilters && genreMatch(movie.genre);

    return {
      ...movie,
      available_cities: entry ? [...entry.cities] : [],
      available_franchises: franchises,
      matchesFilters,
    };
  });

  // Dostępne gatunki do filtra + licznik filmów per gatunek (ze wszystkich filmów).
  // Sortowanie: malejąco po liczbie, remisy alfabetycznie.
  const genreCounts = new Map<string, number>();
  for (const m of movies) {
    for (const g of movieGenres(m.genre)) genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1);
  }
  const availableGenres = [...genreCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'pl'));

  // Popularność liczona dla WYBRANYCH miast (pusty wybór = cała Polska). Widok daje licznik
  // per (film, miasto), więc sumujemy go po zaznaczonych. Wcześniej kolejność szła z globalnego
  // rankingu i tylko odsiewaliśmy z niej filmy niegrane w mieście - przez co np. w Gdyni jedna
  // pozycja na dziesięć stała na właściwym miejscu, a lokalny hit przegrywał z filmem mającym
  // tam trzy seanse. Filtr miasta/daty jest już zakodowany w matchesFilters.
  const screeningsByMovie = new Map<string, number>();
  for (const row of screeningCounts) {
    if (selectedCities.length && !selectedCities.includes(row.city)) continue;
    screeningsByMovie.set(row.movie_id, (screeningsByMovie.get(row.movie_id) ?? 0) + (row.screening_count ?? 0));
  }

  let topMovies = enhancedMovies
    .filter((m) => m.matchesFilters
      && !CAROUSEL_EXCLUDED_TYPES.includes(m.movie_type ?? '')
      && screeningsByMovie.has(m.id))
    // Remisy po tytule, żeby kolejność nie skakała między buildami przy równej liczbie seansów.
    .sort((a, b) => screeningsByMovie.get(b.id)! - screeningsByMovie.get(a.id)!
      || a.title.localeCompare(b.title, 'pl'))
    .slice(0, 10);

  let filteredMovies = enhancedMovies.filter((m) => m.matchesFilters);

  // Karuzele wg daty premiery (na już przefiltrowanym po mieście/dacie zbiorze).
  // release_date to string 'YYYY-MM-DD', więc porównania i sortowanie działają leksykograficznie.
  // availableDates[0] to dzisiejsza data (Europe/Warsaw); obliczenia dat są w queries.ts (poza renderem).
  const todayStr = availableDates[0];
  const monthAgoStr = getDateDaysAgo(30);

  const carouselEligible = (m: typeof enhancedMovies[number]) => {
    if (!m.release_date) return false;
    if (CAROUSEL_EXCLUDED_TYPES.includes(m.movie_type ?? '')) return false;
    // Pomijamy wznowienia starych filmów: rok produkcji dużo wcześniejszy niż rok premiery kinowej.
    // release_year to teraz prawdziwy rok produkcji (konsolidowany po enrich ze wszystkich źródeł).
    if (m.release_year && Number(m.release_date.slice(0, 4)) - m.release_year > CAROUSEL_MAX_YEAR_GAP) return false;
    return true;
  };

  // Wkrótce: premiery w przyszłości, sortowane rosnąco po dacie premiery (najbliższa pierwsza), max 15
  let upcoming = filteredMovies
    .filter((m) => carouselEligible(m) && m.release_date! > todayStr)
    .sort((a, b) => (a.release_date ?? '').localeCompare(b.release_date ?? ''))
    .slice(0, 10);

  // Nowości: filmy już po premierze (ostatnie 30 dni), od najnowszej do najstarszej premiery, max 10
  let newReleases = filteredMovies
    .filter((m) => carouselEligible(m) && m.release_date! >= monthAgoStr && m.release_date! <= todayStr)
    .sort((a, b) => (b.release_date ?? '').localeCompare(a.release_date ?? ''))
    .slice(0, 10);

  // Najlepiej oceniane: wynik bayesowski łączony (Filmweb+IMDb+TMDB), ważony liczbą głosów.
  // Średnie ocen liczymy z pełnego zbioru (stabilne), a kandydatów bierzemy z przefiltrowanych po
  // mieście/dacie. Dopuszczamy też klasyki/KULTOWE - pomijamy tylko typy wydarzeń.
  const ratingMeans = computeRatingMeans(enhancedMovies);
  // Próg wyniku, nie tylko sortowanie: po zawężeniu filtrów pula topniała i do "wysoko ocenianych"
  // wchodziły filmy przeciętne, bo były najlepsze z tego, co zostało. Średnia zbioru to ~7,1,
  // mediana ~7,4 - stąd 7,5 jako wyraźnie "powyżej przeciętnej". Gdy przejdzie za mało filmów,
  // karuzela chowa się sama (warunek > SMALL_CATEGORY_MAX przy renderze).
  const MIN_TOP_RATED_SCORE = 7.5;
  let topRated = filteredMovies
    .filter((m) => !CAROUSEL_EXCLUDED_TYPES.includes(m.movie_type ?? ''))
    .map((m) => ({ movie: m, score: bayesianScore(m, ratingMeans) }))
    .filter((x): x is { movie: typeof enhancedMovies[number]; score: number } =>
      x.score !== null && x.score >= MIN_TOP_RATED_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15)
    .map((x) => x.movie);

  // Odfiltrowanie filmów w przypadku aktywnego wyszukiwania (w obrębie aktywnych filtrów miasta/daty).
  // Przeszukujemy tytuł, reżysera i obsadę (znormalizowane - bez diakrytyków, małe litery).
  if (query) {
    const nq = normalizeSearch(query);
    filteredMovies = enhancedMovies.filter((movie) => {
      if (!movie.matchesFilters) return false;
      const haystack = normalizeSearch([movie.title, movie.director, movie.cast].filter(Boolean).join(' '));
      return haystack.includes(nq);
    });
    // Wyszukiwanie nadpisuje osobne sekcje-karuzele
    topMovies = [];
    newReleases = [];
    upcoming = [];
    topRated = [];
  }

  // Przy małym zbiorze (np. po wyborze mniejszego miasta jak Suwałki) karuzele "odkrywcze"
  // pokazują w kółko te same kilka filmów i dublują je z sekcjami wg typu. Wtedy same sekcje
  // (które dzielą filmy bez powtórzeń) są czytelniejsze - chowamy karuzele.
  const DISCOVERY_MIN_MOVIES = 25;
  if (filteredMovies.length < DISCOVERY_MIN_MOVIES) {
    topMovies = [];
    newReleases = [];
    upcoming = [];
    topRated = [];
  }

  // Grupowanie filmów po typie. Filmy bez movie_type grane WYŁĄCZNIE w kinach studyjnych
  // trafiają do osobnej sekcji "Kino Studyjne" (zamiast do STANDARD).
  const groupedMovies = filteredMovies.reduce((acc, movie) => {
    let type: string;
    if (query) {
      type = 'Wyniki wyszukiwania';
    } else if (movie.movie_type) {
      type = movie.movie_type;
    } else {
      const franchises = movie.available_franchises;
      const studyjneOnly = franchises.length > 0 && franchises.every((f) => /studyjne/i.test(f));
      type = studyjneOnly ? 'Kina Studyjne' : 'STANDARD';
    }

    if (!acc[type]) {
      acc[type] = [];
    }
    acc[type].push(movie);
    return acc;
  }, {} as Record<string, typeof enhancedMovies>);

  // Filmy w obrębie każdej sekcji (STANDARD, KULTOWE, Kino Studyjne, typy wydarzeń) sortujemy
  // alfabetycznie po tytule (locale pl - poprawne ą/ć/ł itd.).
  for (const list of Object.values(groupedMovies)) {
    list.sort((a, b) => a.title.localeCompare(b.title, 'pl'));
  }

  // Kolejność: główna kategoria, potem KULTOWE, potem "Kino Studyjne", potem reszta alfabetycznie.
  const mainCategory = query ? 'Wyniki wyszukiwania' : 'STANDARD';
  const categoryRank = (c: string) =>
    c === mainCategory ? 0 : c === 'KULTOWE' ? 1 : c === 'Kina Studyjne' ? 2 : 3;
  const sortedCategories = Object.keys(groupedMovies).sort((a, b) => {
    const diff = categoryRank(a) - categoryRank(b);
    return diff !== 0 ? diff : a.localeCompare(b);
  });

  // Kategorie z tą liczbą filmów lub mniejszą nie dostają własnej sekcji - trafiają do scalonej
  // sekcji wydarzeń. Ten sam próg decyduje, czy górne karuzele w ogóle warto pokazywać.
  const SMALL_CATEGORY_MAX = 5;
  // Główna kategoria, KULTOWE i "Kino Studyjne" zawsze pełną szerokością (rozwinięta siatka).
  const alwaysWide = (c: string) => c === mainCategory || c === 'KULTOWE' || c === 'Kina Studyjne';
  const wideCategories = sortedCategories.filter(
    (c) => alwaysWide(c) || groupedMovies[c].length > SMALL_CATEGORY_MAX
  );

  // Długi ogon drobnych kategorii (sport, teatr, opera, balet, cyrk, maratony, Ladies Night...) scalamy
  // w JEDNĄ sekcję, a typ pokazujemy jako etykietę na karcie. Wcześniej każda z nich dostawała własne
  // pudełko z nagłówkiem, pakowane w rzędy algorytmem bin-packing - kilkanaście ramek i ~130 linii
  // logiki na ~30 filmów, z czego kilka kategorii miało po JEDNYM filmie. Nagłówek "Opera" nad jedną
  // kartą nie niósł więcej niż etykieta na tej karcie, a cała maszyneria była źródłem błędów układu
  // (rozjazd rozmiarów kafelków, samotne pudełka na telefonie).
  const SPECIAL_SECTION = 'Wydarzenia i pokazy specjalne';
  const specialCategories = sortedCategories.filter(
    (c) => !alwaysWide(c) && groupedMovies[c].length <= SMALL_CATEGORY_MAX
  );
  // Sortujemy po nazwie typu, żeby karty tego samego rodzaju trzymały się razem, a w obrębie typu
  // alfabetycznie po tytule (kolejność z sortowania wyżej).
  const specialMovies = specialCategories
    .flatMap((c) => groupedMovies[c].map((m) => ({ ...m, sectionType: c })))
    .sort((a, b) => a.sectionType.localeCompare(b.sectionType, 'pl') || a.title.localeCompare(b.title, 'pl'));

  // Pierwsze plakaty w kolejności renderowania dostają priority (obraz LCP „nad zgięciem" - eager load).
  const renderOrder = [
    ...topMovies, ...topRated, ...newReleases, ...upcoming,
    ...wideCategories.flatMap((c) => groupedMovies[c]),
    ...specialMovies,
  ];
  const priorityIds = new Set(renderOrder.slice(0, 6).map((m) => m.id));

  // Nagłówek mówi wprost, jaki zakres oglądasz - miasto jest filtrem głównym, więc nie powinno
  // być widoczne wyłącznie jako pigułka gdzieś w filtrach.
  const heading =
    // Nagłówek brzmi jak nazwa serwisu i jak pytanie, które użytkownik faktycznie zadaje:
    // "Co w kinie w Poznaniu?". Odmianę miasta daje citiesLocative (patrz lib/cities.ts).
    // Znak zapytania zostaje TYLKO tutaj - w <title> byłby szumem w wynikach wyszukiwania.
    `Co w kinie ${citiesLocative(selectedCities)}?`;

  return (
    <CityScopeProvider selected={selectedCities} all={cities}>
    <main className="container mx-auto px-3 sm:px-4 pt-8 pb-16 overflow-x-clip">
      <div className="mb-8 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h1 className="text-4xl font-extrabold text-slate-100 tracking-tight">{heading}</h1>
        <Link href="/kina" className="text-sm text-slate-400 hover:text-indigo-300 transition-colors">
          Lista kin
        </Link>
      </div>

      <Suspense fallback={<div className="h-14 mb-6" />}>
        <FilterBar cities={cities} formats={formats} genres={availableGenres} resultCount={filteredMovies.length} />
      </Suspense>

      <div className="space-y-10">
        {/* Komunikat o braku wyników */}
        {sortedCategories.length === 0 && topMovies.length === 0 && (
          <div className="text-center text-slate-400 py-16 bg-slate-900/30 rounded-xl border border-slate-800">
            Brak filmów pasujących do podanych kryteriów.
          </div>
        )}

        {/* Karuzela "Najwięcej seansów" */}
        {topMovies.length > SMALL_CATEGORY_MAX && (
          <section className="flex flex-col">
            <h2 className="text-2xl font-bold mb-4 text-slate-200 pl-1 border-l-4 border-amber-500 rounded-sm">
              Najpopularniejsze
            </h2>
            
            <Carousel>
              {topMovies.map((movie) => (
                <div key={`top-${movie.id}`} className={`${CARD_WIDTH} shrink-0 snap-start`}>
                  <MovieCard movie={movie} priority={priorityIds.has(movie.id)} />
                </div>
              ))}
            </Carousel>
          </section>
        )}

        {/* Karuzela "Najlepiej oceniane" - wynik bayesowski (Filmweb+IMDb+TMDB) ważony liczbą głosów */}
        {topRated.length > SMALL_CATEGORY_MAX && (
          <section className="flex flex-col">
            <h2 className="text-2xl font-bold mb-4 text-slate-200 pl-1 border-l-4 border-yellow-500 rounded-sm">
              Wysoko oceniane
            </h2>
            <Carousel>
              {topRated.map((movie) => (
                <div key={`rated-${movie.id}`} className={`${CARD_WIDTH} shrink-0 snap-start`}>
                  <MovieCard movie={movie} priority={priorityIds.has(movie.id)} />
                </div>
              ))}
            </Carousel>
          </section>
        )}

        {/* Karuzela "Nowości" - premiery z ostatniego miesiąca */}
        {newReleases.length > SMALL_CATEGORY_MAX && (
          <section className="flex flex-col">
            <h2 className="text-2xl font-bold mb-4 text-slate-200 pl-1 border-l-4 border-emerald-500 rounded-sm">
              Nowe premiery
            </h2>
            <Carousel>
              {newReleases.map((movie) => (
                <div key={`new-${movie.id}`} className={`${CARD_WIDTH} shrink-0 snap-start`}>
                  <MovieCard movie={movie} priority={priorityIds.has(movie.id)} />
                </div>
              ))}
            </Carousel>
          </section>
        )}

        {/* Karuzela "Wkrótce" - przyszłe premiery */}
        {upcoming.length > SMALL_CATEGORY_MAX && (
          <section className="flex flex-col">
            <h2 className="text-2xl font-bold mb-4 text-slate-200 pl-1 border-l-4 border-sky-500 rounded-sm">
              Wkrótce premiera
            </h2>
            <Carousel>
              {upcoming.map((movie) => (
                <div key={`soon-${movie.id}`} className={`${CARD_WIDTH} shrink-0 snap-start`}>
                  <MovieCard movie={movie} priority={priorityIds.has(movie.id)} />
                </div>
              ))}
            </Carousel>
          </section>
        )}

        {/* Duże sekcje - pełna szerokość. STANDARD i "Kino Studyjne" (oraz wyniki wyszukiwania)
            rozwijamy w pełną siatkę; pozostałe zostają poziomymi karuzelami. */}
        {wideCategories.map((category) => {
          const expanded = query || alwaysWide(category);
          return (
          <section key={category} className="flex flex-col">
            {/* Każda sekcja ma nagłówek, także ta z filmami bez wyróżnionego typu - wcześniej szła bez
                niego i pierwsza siatka na stronie wisiała bez podpisu. Etykiety bierzemy z categoryLabel,
                bo klucze to surowe `movie_type` zapisane wersalikami. */}
            <h2 className="text-2xl font-bold mb-4 text-slate-200 pl-1 border-l-4 border-indigo-500 rounded-sm">
              {categoryLabel(category)}
            </h2>

            {/* Rozwinięta: responsywna siatka wypełniająca szerokość. Karuzela: poziomy scroll. */}
            {expanded ? (
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 gap-2 sm:gap-4 pb-6">
                {groupedMovies[category].map((movie) => (
                  <MovieCard key={movie.id} movie={movie} priority={priorityIds.has(movie.id)} />
                ))}
              </div>
            ) : (
              <Carousel>
              {groupedMovies[category].map((movie) => (
                  <div key={movie.id} className={`${CARD_WIDTH} shrink-0 snap-start`}>
                    <MovieCard movie={movie} priority={priorityIds.has(movie.id)} />
                  </div>
                ))}
            </Carousel>
            )}
          </section>
          );
        })}

        {/* Drobne kategorie scalone w jedną sekcję - typ każdego filmu widać na jego karcie.
            Renderuje się jak każda inna sekcja, więc układ jest jednorodny na wszystkich ekranach. */}
        {specialMovies.length > 0 && (
          <section className="flex flex-col">
            <h2 className="text-2xl font-bold mb-4 text-slate-200 pl-1 border-l-4 border-indigo-500 rounded-sm">
              {SPECIAL_SECTION}
            </h2>
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 gap-2 sm:gap-4 pb-6">
              {specialMovies.map((movie) => (
                <MovieCard
                  key={movie.id}
                  movie={movie}
                  priority={priorityIds.has(movie.id)}
                  typeLabel={movie.sectionType}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
    </CityScopeProvider>
  );
}
