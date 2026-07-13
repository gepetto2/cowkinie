import { Suspense } from 'react';
import Link from 'next/link';
import { getCities, getMovies, getAvailableDates, getMovieIdsByDateAndCity, getDateDaysAgo } from '@/lib/supabase/queries';
import MovieCard from '@/components/MovieCard';
import { supabase } from '@/lib/supabase/client';
import SearchBar from '@/components/SearchBar';

export const revalidate = 0;

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
  const dateQuery = typeof params?.date === 'string' ? params.date : '';

  // Zrównoleglenie pobierania wszystkich danych
  const [
    cities,
    movies,
    { data: cinemaAvailabilities },
    { data: topScreenings },
    availableDates,
    moviesOnDate
  ] = await Promise.all([
    getCities(),
    getMovies(),
    supabase.from('movie_cinemas_view').select('*'),
    supabase.from('movie_screening_counts').select('*').order('screening_count', { ascending: false }).limit(10),
    Promise.resolve(getAvailableDates(7)), // 7 najbliższych dni
    dateQuery ? getMovieIdsByDateAndCity(dateQuery, cityQuery) : Promise.resolve(null)
  ]);

  // Optymalizacja O(1) do szybkiego wyszukiwania dostępności kin dla filmu
  const availabilitiesMap = new Map(
    cinemaAvailabilities?.map(a => [a.movie_id, a]) || []
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

  // Filtrowanie po wybranej dacie
  if (dateQuery && moviesOnDate) {
    filteredMovies = filteredMovies.filter((movie) =>
      moviesOnDate.has(movie.id)
    );
    topMovies = topMovies.filter((movie) =>
      moviesOnDate.has(movie.id)
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

  // Grupowanie filmów po typie
  const groupedMovies = filteredMovies.reduce((acc, movie) => {
    const type = query ? 'Wyniki wyszukiwania' : (movie.movie_type || 'STANDARD');

    if (!acc[type]) {
      acc[type] = [];
    }
    acc[type].push(movie);
    return acc;
  }, {} as Record<string, typeof enhancedMovies>);

  // Wymuszamy, by główna kategoria była na samej górze
  const mainCategory = query ? 'Wyniki wyszukiwania' : 'STANDARD';
  const sortedCategories = Object.keys(groupedMovies).sort((a, b) => {
    if (a === mainCategory) return -1;
    if (b === mainCategory) return 1;
    return a.localeCompare(b);
  });

  return (
    <main className="container mx-auto p-4 pt-8 pb-16 overflow-hidden">
      <h1 className="text-4xl font-extrabold mb-8 text-slate-100 tracking-tight">Repertuar Kin</h1>

      <Suspense fallback={<div className="h-10 bg-slate-900 animate-pulse rounded-lg mb-8 max-w-2xl"></div>}>
        <SearchBar />
      </Suspense>

      <section className="mb-10 space-y-6">
        <div>
          <h2 className="text-lg font-semibold mb-3 text-slate-300">Wybierz datę:</h2>
          <div className="flex overflow-x-auto gap-2 pb-2 snap-x" style={{ scrollbarWidth: 'none' }}>
            <Link 
              href={(() => {
                const urlParams = new URLSearchParams();
                if (query) urlParams.set('q', query);
                if (cityQuery) urlParams.set('city', cityQuery);
                return `/?${urlParams.toString()}`;
              })()}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap snap-start shrink-0 ${
                !dateQuery
                  ? 'bg-rose-600 text-white shadow-md' 
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
              }`}
            >
              Dowolna data
            </Link>
            
            {availableDates.map((date, index) => {
              const isActive = date === dateQuery;
              const urlParams = new URLSearchParams();
              if (query) urlParams.set('q', query);
              if (cityQuery) urlParams.set('city', cityQuery);
              urlParams.set('date', date);
              
              let label = "";
              if (index === 0) label = "Dzisiaj";
              else if (index === 1) label = "Jutro";
              else {
                const d = new Date(date);
                label = d.toLocaleDateString("pl-PL", { weekday: "short", day: "numeric", month: "numeric" });
              }
              
              return (
                <Link 
                  key={date} 
                  href={`/?${urlParams.toString()}`}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap snap-start shrink-0 capitalize ${
                    isActive 
                      ? 'bg-rose-600 text-white shadow-md' 
                      : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
                  }`}
                >
                  {label}
                </Link>
              );
            })}
          </div>
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-3 text-slate-300">Wybierz miasto:</h2>
          <div className="flex overflow-x-auto gap-2 pb-2 snap-x" style={{ scrollbarWidth: 'none' }}>
            <Link 
              href={(() => {
                const urlParams = new URLSearchParams();
                if (query) urlParams.set('q', query);
                if (dateQuery) urlParams.set('date', dateQuery);
                return `/?${urlParams.toString()}`;
              })()}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap snap-start shrink-0 ${
                !cityQuery
                  ? 'bg-indigo-600 text-white shadow-md' 
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
              }`}
            >
              Wszystkie
            </Link>
            
            {cities.map((city) => {
              const isActive = city === cityQuery;
              const urlParams = new URLSearchParams();
              if (query) urlParams.set('q', query);
              if (dateQuery) urlParams.set('date', dateQuery);
              urlParams.set('city', city);
              
              return (
                <Link 
                  key={city} 
                  href={`/?${urlParams.toString()}`}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap snap-start shrink-0 ${
                    isActive 
                      ? 'bg-indigo-600 text-white shadow-md' 
                      : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
                  }`}
                >
                  {city}
                </Link>
              );
            })}
          </div>
        </div>
      </section>

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
              Najwięcej seansów
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

        {sortedCategories.map((category) => (
          <section key={category} className="flex flex-col">
            <h2 className="text-2xl font-bold mb-4 text-slate-200 pl-1 border-l-4 border-indigo-500 rounded-sm">
              {category}
            </h2>
            
            {/* Kontener dla karuzeli lub siatki dla wyników */}
            <div 
              className={`flex gap-5 pb-6 -mx-4 px-4 sm:mx-0 sm:px-0 ${query ? 'flex-wrap' : 'overflow-x-auto snap-x'}`}
              style={query ? undefined : { scrollbarWidth: 'thin' }}
            >
              {groupedMovies[category].map((movie) => (
                <div key={movie.id} className="w-[140px] sm:w-[160px] lg:w-[180px] shrink-0 snap-start">
                  <MovieCard movie={movie} />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
