import { Suspense } from 'react';
import {
  getCities, getMovies, getAvailableDates, getFilteredAvailability, getDateDaysAgo,
  getCinemaAvailabilities, getTopScreenings, getAvailableFormats, getAvailableLangs,
} from '@/lib/supabase/queries';
import MovieCard from '@/components/MovieCard';
import Carousel from '@/components/Carousel';
import FilterBar from '@/components/FilterBar';
import NarrowSections from '@/components/NarrowSections';
import { computeRatingMeans, bayesianScore } from '@/lib/ratings';

// Typy filmów pomijane w karuzelach "Nowości"/"Wkrótce" (dopisuj wg potrzeb).
const CAROUSEL_EXCLUDED_TYPES = ['SPORT', 'TEATR', 'UKRAIŃSKI DUBBING', 'UNLIMITED SHOW', 'CYRK', 'MARATON', 'WYSTAWY', 'DLA DZIECI', 'SALON KULTURY', 'KONCERT', 'LADIES NIGHT/KNO', 'BALET', 'OPERA'];

// Maksymalna różnica (w latach) między rokiem produkcji a rokiem premiery kinowej.
// Powyżej tej wartości traktujemy film jako wznowienie starego tytułu i pomijamy w karuzelach.
const CAROUSEL_MAX_YEAR_GAP = 1;

// Normalizacja do wyszukiwania: małe litery, bez diakrytyków (ł->l), by np. "zelazny" znalazł
// "Żelazny", a "lea seydoux" -> "Léa Seydoux". Stosowana i do zapytania, i do przeszukiwanego tekstu.
const normalizeSearch = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');

export default async function Home({
  searchParams,
}: {
  searchParams?: { [key: string]: string | string[] | undefined };
}) {
  // Używamy Promise.resolve dla bezpiecznej kompatybilności wstecz i wprzód (Next.js 15 wymaga Promise)
  const params = await Promise.resolve(searchParams);
  const query = typeof params?.q === 'string' ? params.q.toLowerCase() : '';
  const cityQuery = typeof params?.city === 'string' ? params.city : '';
  // Zakres dat: from/to (włącznie). Jedna granica = pojedynczy dzień.
  const fromQuery = typeof params?.from === 'string' ? params.from : '';
  const toQuery = typeof params?.to === 'string' ? params.to : '';
  const rangeFrom = fromQuery || toQuery;
  const rangeTo = toQuery || fromQuery;
  const rangeActive = Boolean(rangeFrom);
  // Format i wersja językowa to listy (multi-select), w URL rozdzielone przecinkami.
  const selectedFormats = typeof params?.format === 'string' && params.format
    ? params.format.split(',').filter(Boolean)
    : [];
  const selectedLangs = typeof params?.lang === 'string' && params.lang
    ? params.lang.split(',').filter(Boolean)
    : [];
  // Gatunek to atrybut filmu (kolumna genre), więc filtrujemy po stronie klienta (bez RPC).
  const selectedGenres = typeof params?.genre === 'string' && params.genre
    ? params.genre.split(',').filter(Boolean)
    : [];
  // Filtr daty/formatu/języka wymaga danych na poziomie seansu -> liczymy je po stronie serwera (RPC).
  const serverFilterActive = rangeActive || selectedFormats.length > 0 || selectedLangs.length > 0;

  // Zrównoleglenie pobierania wszystkich danych (odczyty z bazy są cache'owane w queries.ts)
  const [
    cities,
    movies,
    cinemaAvailabilities,
    topScreenings,
    availableDates,
    formats,
    langs,
    serverAvail
  ] = await Promise.all([
    getCities(),
    getMovies(),
    getCinemaAvailabilities(),
    getTopScreenings(),
    Promise.resolve(getAvailableDates(1)), // dzisiejsza data dla karuzel
    getAvailableFormats(),
    getAvailableLangs(),
    // Gdy aktywny filtr daty/formatu/języka: dostępność (film -> franczyzy) z pasujących seansów, po stronie serwera.
    serverFilterActive ? getFilteredAvailability(rangeFrom, rangeTo, cityQuery, selectedFormats, selectedLangs) : Promise.resolve(null)
  ]);

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
      const fr = serverAvail.get(movie.id);
      matchesFilters = fr !== undefined;
      franchises = fr ? [...fr].sort() : [];
    } else if (cityQuery) {
      matchesFilters = entry?.cities.has(cityQuery) ?? false;
      franchises = [...(entry?.franchisesByCity.get(cityQuery) ?? [])].sort();
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

  // Optymalizacja O(1) do szybkiego wyszukiwania pełnych danych filmu po id
  const moviesMap = new Map(enhancedMovies.map(m => [m.id, m]));

  // Dostępne gatunki do filtra + licznik filmów per gatunek (ze wszystkich filmów).
  // Sortowanie: malejąco po liczbie, remisy alfabetycznie.
  const genreCounts = new Map<string, number>();
  for (const m of movies) {
    for (const g of movieGenres(m.genre)) genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1);
  }
  const availableGenres = [...genreCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'pl'));

  // Filtr miasta/daty jest już zakodowany w matchesFilters (jeden spójny zbiór dla listy i badge'ów).
  let topMovies = (topScreenings || [])
    .map((ts) => (ts.movie_id ? moviesMap.get(ts.movie_id) : undefined))
    .filter((m): m is typeof enhancedMovies[number] => m !== undefined && m.matchesFilters);

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
  let topRated = filteredMovies
    .filter((m) => !CAROUSEL_EXCLUDED_TYPES.includes(m.movie_type ?? ''))
    .map((m) => ({ movie: m, score: bayesianScore(m, ratingMeans) }))
    .filter((x): x is { movie: typeof enhancedMovies[number]; score: number } => x.score !== null)
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

  // Próg karuzeli: sekcje z tą liczbą filmów lub mniejszą nie renderują się jako karuzela.
  // Kategorie idą wtedy w statyczne kafelki, a górne karuzele (poniżej) w ogóle się nie pokazują.
  const NARROW_SECTION_MAX = 5;
  // Główna kategoria, KULTOWE i "Kino Studyjne" zawsze pełną szerokością (rozwinięta siatka).
  const alwaysWide = (c: string) => c === mainCategory || c === 'KULTOWE' || c === 'Kina Studyjne';
  const wideCategories = sortedCategories.filter(
    (c) => alwaysWide(c) || groupedMovies[c].length > NARROW_SECTION_MAX
  );
  // Wąskie sekcje to karty o szerokości ~ liczbie filmów. Flexbox pakuje je zachłannie w kolejności
  // DOM (next-fit) i NIE cofa się, więc samo sortowanie malejące zostawia luki obok dużych kart.
  // Robimy więc First-Fit-Decreasing z backfillem: sekcje (malejąco) wkładziemy do pierwszego rzędu,
  // w którym się mieszczą, a potem emitujemy je rzędami - flexbox odtworzy te ciaśniejsze rzędy,
  // wciągając małe sekcje w luki obok dużych. Capacity ~ liczba plakatów w rzędzie na szerokim ekranie
  // (węższe viewporty flexbox i tak zawinie po swojemu; przeplot małych/dużych i tak pomaga).
  const NARROW_ROW_CAPACITY = 7;
  const narrowBySize = sortedCategories
    .filter((c) => !alwaysWide(c) && groupedMovies[c].length <= NARROW_SECTION_MAX)
    .sort((a, b) => groupedMovies[b].length - groupedMovies[a].length || b.length - a.length);
  const narrowRows: string[][] = [];
  for (const c of narrowBySize) {
    const size = groupedMovies[c].length;
    const row = narrowRows.find((r) => r.reduce((s, x) => s + groupedMovies[x].length, 0) + size <= NARROW_ROW_CAPACITY);
    if (row) row.push(c);
    else narrowRows.push([c]);
  }
  const narrowCategories = narrowRows.flat();

  // Pierwsze plakaty w kolejności renderowania dostają priority (obraz LCP „nad zgięciem" - eager load).
  const renderOrder = [
    ...topMovies, ...topRated, ...newReleases, ...upcoming,
    ...wideCategories.flatMap((c) => groupedMovies[c]),
    ...narrowCategories.flatMap((c) => groupedMovies[c]),
  ];
  const priorityIds = new Set(renderOrder.slice(0, 6).map((m) => m.id));

  return (
    <main className="container mx-auto p-4 pt-8 pb-16 overflow-x-clip">
      <h1 className="text-4xl font-extrabold mb-8 text-slate-100 tracking-tight">Repertuar Kin</h1>

      <Suspense fallback={<div className="h-14 mb-6" />}>
        <FilterBar cities={cities} formats={formats} langs={langs} genres={availableGenres} resultCount={filteredMovies.length} />
      </Suspense>

      <div className="space-y-10">
        {/* Komunikat o braku wyników */}
        {sortedCategories.length === 0 && topMovies.length === 0 && (
          <div className="text-center text-slate-400 py-16 bg-slate-900/30 rounded-xl border border-slate-800">
            Brak filmów pasujących do podanych kryteriów.
          </div>
        )}

        {/* Karuzela "Najwięcej seansów" */}
        {topMovies.length > NARROW_SECTION_MAX && (
          <section className="flex flex-col">
            <h2 className="text-2xl font-bold mb-4 text-slate-200 pl-1 border-l-4 border-amber-500 rounded-sm">
              Najpopularniejsze
            </h2>
            
            <Carousel>
              {topMovies.map((movie) => (
                <div key={`top-${movie.id}`} className="w-[140px] sm:w-[160px] lg:w-[180px] shrink-0 snap-start">
                  <MovieCard movie={movie} priority={priorityIds.has(movie.id)} />
                </div>
              ))}
            </Carousel>
          </section>
        )}

        {/* Karuzela "Najlepiej oceniane" - wynik bayesowski (Filmweb+IMDb+TMDB) ważony liczbą głosów */}
        {topRated.length > NARROW_SECTION_MAX && (
          <section className="flex flex-col">
            <h2 className="text-2xl font-bold mb-4 text-slate-200 pl-1 border-l-4 border-yellow-500 rounded-sm">
              Najlepiej oceniane
            </h2>
            <Carousel>
              {topRated.map((movie) => (
                <div key={`rated-${movie.id}`} className="w-[140px] sm:w-[160px] lg:w-[180px] shrink-0 snap-start">
                  <MovieCard movie={movie} priority={priorityIds.has(movie.id)} />
                </div>
              ))}
            </Carousel>
          </section>
        )}

        {/* Karuzela "Nowości" - premiery z ostatniego miesiąca */}
        {newReleases.length > NARROW_SECTION_MAX && (
          <section className="flex flex-col">
            <h2 className="text-2xl font-bold mb-4 text-slate-200 pl-1 border-l-4 border-emerald-500 rounded-sm">
              Nowe premiery
            </h2>
            <Carousel>
              {newReleases.map((movie) => (
                <div key={`new-${movie.id}`} className="w-[140px] sm:w-[160px] lg:w-[180px] shrink-0 snap-start">
                  <MovieCard movie={movie} priority={priorityIds.has(movie.id)} />
                </div>
              ))}
            </Carousel>
          </section>
        )}

        {/* Karuzela "Wkrótce" - przyszłe premiery */}
        {upcoming.length > NARROW_SECTION_MAX && (
          <section className="flex flex-col">
            <h2 className="text-2xl font-bold mb-4 text-slate-200 pl-1 border-l-4 border-sky-500 rounded-sm">
              Wkrótce premiera
            </h2>
            <Carousel>
              {upcoming.map((movie) => (
                <div key={`soon-${movie.id}`} className="w-[140px] sm:w-[160px] lg:w-[180px] shrink-0 snap-start">
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
            {/* Sekcja STANDARD to zwykłe filmy bez wyróżnionego typu - bez nagłówka (nazwa niepotrzebna). */}
            {category !== 'STANDARD' && (
              <h2 className="text-2xl font-bold mb-4 text-slate-200 pl-1 border-l-4 border-indigo-500 rounded-sm">
                {category}
              </h2>
            )}

            {/* Rozwinięta: responsywna siatka wypełniająca szerokość. Karuzela: poziomy scroll. */}
            {expanded ? (
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 gap-3 sm:gap-4 pb-6">
                {groupedMovies[category].map((movie) => (
                  <MovieCard key={movie.id} movie={movie} priority={priorityIds.has(movie.id)} />
                ))}
              </div>
            ) : (
              <Carousel>
              {groupedMovies[category].map((movie) => (
                  <div key={movie.id} className="w-[140px] sm:w-[160px] lg:w-[180px] shrink-0 snap-start">
                    <MovieCard movie={movie} priority={priorityIds.has(movie.id)} />
                  </div>
                ))}
            </Carousel>
            )}
          </section>
          );
        })}

        {/* Krótkie sekcje (mało filmów) jako kafelki o szerokości dopasowanej do liczby filmów.
            Pakowaniem w rzędy zajmuje się komponent kliencki - mierzy realną szerokość i liczy FFD
            pod nią (poprawne na każdej rozdzielczości, nie na sztywno). */}
        {narrowCategories.length > 0 && (
          <NarrowSections
            sections={narrowCategories.map((category) => ({ category, movies: groupedMovies[category] }))}
            priorityIds={[...priorityIds]}
          />
        )}
      </div>
    </main>
  );
}
