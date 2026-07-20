import { Suspense } from 'react';
import {
  getCities, getMovies, getAvailableDates, getMovieIdsByDateRange, getDateDaysAgo,
  getCinemaAvailabilities, getTopScreenings,
} from '@/lib/supabase/queries';
import MovieCard from '@/components/MovieCard';
import FilterBar from '@/components/FilterBar';

// Typy filmów pomijane w karuzelach "Nowości"/"Wkrótce" (dopisuj wg potrzeb).
const CAROUSEL_EXCLUDED_TYPES = ['SPORT', 'TEATR', 'UKRAIŃSKI DUBBING', 'UNLIMITED SHOW', 'CYRK', 'MARATON', 'WYSTAWY'];

// Maksymalna różnica (w latach) między rokiem produkcji a rokiem premiery kinowej.
// Powyżej tej wartości traktujemy film jako wznowienie starego tytułu i pomijamy w karuzelach.
const CAROUSEL_MAX_YEAR_GAP = 1;

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

  // Zrównoleglenie pobierania wszystkich danych (odczyty z bazy są cache'owane w queries.ts)
  const [
    cities,
    movies,
    cinemaAvailabilities,
    topScreenings,
    availableDates,
    moviesInRange
  ] = await Promise.all([
    getCities(),
    getMovies(),
    getCinemaAvailabilities(),
    getTopScreenings(),
    Promise.resolve(getAvailableDates(1)), // dzisiejsza data dla karuzel
    rangeActive ? getMovieIdsByDateRange(rangeFrom, rangeTo, cityQuery) : Promise.resolve(null)
  ]);

  // Optymalizacja O(1) do szybkiego wyszukiwania dostępności kin dla filmu
  const availabilitiesMap = new Map(
    cinemaAvailabilities.map(a => [a.movie_id, a])
  );

  // Wzbogacenie obiektów filmów o dane o kinach
  const enhancedMovies = movies.map(movie => {
    const availability = availabilitiesMap.get(movie.id);
    return {
      ...movie,
      available_cities: availability?.cities || [],
      available_franchises: availability?.franchises || [],
    };
  });

  // Optymalizacja O(1) do szybkiego wyszukiwania pełnych danych filmu po id
  const moviesMap = new Map(enhancedMovies.map(m => [m.id, m]));

  // Dopasowanie pobranych idków do pełnych danych filmów
  let topMovies = (topScreenings || [])
    .map((ts) => (ts.movie_id ? moviesMap.get(ts.movie_id) : undefined))
    .filter(Boolean) as typeof enhancedMovies;

  let filteredMovies = enhancedMovies;

  // Filtrowanie po wybranym mieście
  if (cityQuery) {
    filteredMovies = filteredMovies.filter((movie) =>
      movie.available_cities.includes(cityQuery)
    );
    topMovies = topMovies.filter((movie) =>
      movie.available_cities.includes(cityQuery)
    );
  }

  // Filtrowanie po wybranym zakresie dat
  if (rangeActive && moviesInRange) {
    filteredMovies = filteredMovies.filter((movie) =>
      moviesInRange.has(movie.id)
    );
    topMovies = topMovies.filter((movie) =>
      moviesInRange.has(movie.id)
    );
  }

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

  // Odfiltrowanie filmów w przypadku aktywnego wyszukiwania
  if (query) {
    filteredMovies = enhancedMovies.filter((movie) =>
      movie.title.toLowerCase().includes(query)
    );
    // Wyszukiwanie nadpisuje osobne sekcje-karuzele
    topMovies = [];
    newReleases = [];
    upcoming = [];
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
      type = studyjneOnly ? 'Kino Studyjne' : 'STANDARD';
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

  // Kolejność: główna kategoria, potem "Kino Studyjne", potem reszta alfabetycznie.
  const mainCategory = query ? 'Wyniki wyszukiwania' : 'STANDARD';
  const categoryRank = (c: string) => (c === mainCategory ? 0 : c === 'Kino Studyjne' ? 1 : 2);
  const sortedCategories = Object.keys(groupedMovies).sort((a, b) => {
    const diff = categoryRank(a) - categoryRank(b);
    return diff !== 0 ? diff : a.localeCompare(b);
  });

  // Krótkie sekcje (mało filmów) upakowujemy obok siebie w siatce; duże zostają pełną szerokością.
  const NARROW_SECTION_MAX = 4;
  // Główna kategoria i "Kino Studyjne" zawsze pełną szerokością (jak STANDARD).
  const alwaysWide = (c: string) => c === mainCategory || c === 'Kino Studyjne';
  const wideCategories = sortedCategories.filter(
    (c) => alwaysWide(c) || groupedMovies[c].length > NARROW_SECTION_MAX
  );
  const narrowCategories = sortedCategories.filter(
    (c) => !alwaysWide(c) && groupedMovies[c].length <= NARROW_SECTION_MAX
  );

  return (
    <main className="container mx-auto p-4 pt-8 pb-16 overflow-x-clip">
      <h1 className="text-4xl font-extrabold mb-8 text-slate-100 tracking-tight">Repertuar Kin</h1>

      <Suspense fallback={<div className="h-14 mb-6" />}>
        <FilterBar cities={cities} resultCount={filteredMovies.length} />
      </Suspense>

      <div className="space-y-10">
        {/* Komunikat o braku wyników */}
        {sortedCategories.length === 0 && topMovies.length === 0 && (
          <div className="text-center text-slate-400 py-16 bg-slate-900/30 rounded-xl border border-slate-800">
            Brak filmów pasujących do podanych kryteriów.
          </div>
        )}

        {/* Karuzela "Najwięcej seansów" */}
        {topMovies.length > 0 && (
          <section className="flex flex-col">
            <h2 className="text-2xl font-bold mb-4 text-slate-200 pl-1 border-l-4 border-amber-500 rounded-sm">
              Najpopularniejsze
            </h2>
            
            <div 
              className="flex overflow-x-auto gap-5 pb-6 snap-x -mx-4 px-4 sm:mx-0 sm:px-0" 
              style={{ scrollbarWidth: 'thin' }}
            >
              {topMovies.map((movie) => (
                <div key={`top-${movie.id}`} className="w-[140px] sm:w-[160px] lg:w-[180px] shrink-0 snap-start">
                  <MovieCard movie={movie} />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Karuzela "Nowości" - premiery z ostatniego miesiąca */}
        {newReleases.length > 0 && (
          <section className="flex flex-col">
            <h2 className="text-2xl font-bold mb-4 text-slate-200 pl-1 border-l-4 border-emerald-500 rounded-sm">
              Nowości
            </h2>
            <div
              className="flex overflow-x-auto gap-5 pb-6 snap-x -mx-4 px-4 sm:mx-0 sm:px-0"
              style={{ scrollbarWidth: 'thin' }}
            >
              {newReleases.map((movie) => (
                <div key={`new-${movie.id}`} className="w-[140px] sm:w-[160px] lg:w-[180px] shrink-0 snap-start">
                  <MovieCard movie={movie} />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Karuzela "Wkrótce" - przyszłe premiery */}
        {upcoming.length > 0 && (
          <section className="flex flex-col">
            <h2 className="text-2xl font-bold mb-4 text-slate-200 pl-1 border-l-4 border-sky-500 rounded-sm">
              Wkrótce
            </h2>
            <div
              className="flex overflow-x-auto gap-5 pb-6 snap-x -mx-4 px-4 sm:mx-0 sm:px-0"
              style={{ scrollbarWidth: 'thin' }}
            >
              {upcoming.map((movie) => (
                <div key={`soon-${movie.id}`} className="w-[140px] sm:w-[160px] lg:w-[180px] shrink-0 snap-start">
                  <MovieCard movie={movie} />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Duże sekcje - pełna szerokość. STANDARD i "Kino Studyjne" (oraz wyniki wyszukiwania)
            rozwijamy w pełną siatkę; pozostałe zostają poziomymi karuzelami. */}
        {wideCategories.map((category) => {
          const expanded = query || alwaysWide(category);
          return (
          <section key={category} className="flex flex-col">
            <h2 className="text-2xl font-bold mb-4 text-slate-200 pl-1 border-l-4 border-indigo-500 rounded-sm">
              {category}
            </h2>

            {/* Rozwinięta siatka (flex-wrap) albo pozioma karuzela */}
            <div
              className={`flex gap-5 pb-6 -mx-4 px-4 sm:mx-0 sm:px-0 ${expanded ? 'flex-wrap' : 'overflow-x-auto snap-x'}`}
              style={expanded ? undefined : { scrollbarWidth: 'thin' }}
            >
              {groupedMovies[category].map((movie) => (
                <div key={movie.id} className="w-[140px] sm:w-[160px] lg:w-[180px] shrink-0 snap-start">
                  <MovieCard movie={movie} />
                </div>
              ))}
            </div>
          </section>
          );
        })}

        {/* Krótkie sekcje jako kafelki o szerokości dopasowanej do liczby filmów (w-fit).
            Dzięki temu kafelek nigdy nie ma pustego slotu, a kafelki (równej wysokości) płyną w rzędach. */}
        {narrowCategories.length > 0 && (
          <div className="flex flex-wrap gap-5 items-stretch">
            {narrowCategories.map((category) => (
              <section
                key={category}
                className="w-fit max-w-full border border-slate-800 bg-slate-900/40 rounded-xl p-4 flex flex-col"
              >
                <h2 className="text-lg font-bold mb-3 text-slate-200 pl-2 border-l-4 border-indigo-500 rounded-sm">
                  {category}
                </h2>
                <div className="flex flex-wrap gap-4">
                  {groupedMovies[category].map((movie) => (
                    <div key={movie.id} className="w-[140px] sm:w-[160px] lg:w-[180px] shrink-0">
                      <MovieCard movie={movie} />
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
