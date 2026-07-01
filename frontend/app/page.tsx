import { Suspense } from 'react';
import { getCities, getMovies } from '@/lib/supabase/queries';
import MovieCard from '@/components/MovieCard';
import { supabase } from '@/lib/supabase/client';
import SearchBar from '@/components/SearchBar';

export const revalidate = 0;

export default async function Home({
  searchParams,
}: {
  searchParams?: { [key: string]: string | string[] | undefined };
}) {
  // Używamy Promise.resolve dla bezpiecznej kompatybilności wstecz i wprzód (Next.js 15 wymaga Promise)
  const params = await Promise.resolve(searchParams);
  const query = typeof params?.q === 'string' ? params.q.toLowerCase() : '';

  // Zrównoleglenie pobierania wszystkich danych
  const [
    cities,
    movies,
    { data: cinemaAvailabilities },
    { data: topScreenings }
  ] = await Promise.all([
    getCities(),
    getMovies(),
    supabase.from('movie_cinemas_view').select('*'),
    supabase.from('movie_screening_counts').select('*').order('screening_count', { ascending: false }).limit(10)
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
    .map((ts: any) => moviesMap.get(ts.movie_id))
    .filter(Boolean) as typeof enhancedMovies;

  let filteredMovies = enhancedMovies;

  // Odfiltrowanie filmów w przypadku aktywnego wyszukiwania
  if (query) {
    filteredMovies = enhancedMovies.filter((movie) =>
      movie.title.toLowerCase().includes(query)
    );
    topMovies = []; // Wyszukiwanie nadpisuje osobną sekcję "Najwięcej seansów"
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

      <section className="mb-10">
        <h2 className="text-lg font-semibold mb-3 text-slate-300">Wybierz miasto:</h2>
        <div className="flex overflow-x-auto gap-2 pb-2 snap-x" style={{ scrollbarWidth: 'none' }}>
          {cities.map((city) => (
            <button key={city} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-sm font-medium transition-colors whitespace-nowrap snap-start shrink-0">
              {city}
            </button>
          ))}
        </div>
      </section>

      <div className="space-y-10">
        {/* Komunikat o braku wyników */}
        {sortedCategories.length === 0 && topMovies.length === 0 && (
          <div className="text-center text-slate-400 py-16 bg-slate-900/30 rounded-xl border border-slate-800">
            Brak filmów pasujących do frazy <span className="text-slate-200">"{query}"</span>.
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
