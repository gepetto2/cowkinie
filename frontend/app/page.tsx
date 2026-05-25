import { getCities, getMovies } from '@/lib/supabase/queries';
import MovieCard from '@/components/MovieCard';
import { supabase } from '@/lib/supabase/client';

export const revalidate = 0;

export default async function Home() {
  const cities = await getCities();
  const movies = await getMovies();

  // Wykorzystanie widoku SQL do zliczenia seansów i pobrania top 10 wyników prosto z bazy
  const { data: topScreenings } = await supabase
    .from('movie_screening_counts')
    .select('*')
    .order('screening_count', { ascending: false })
    .limit(10);

  // Dopasowanie pobranych idków do pełnych danych filmów
  const topMovies = (topScreenings || [])
    .map((ts: any) => movies.find((m) => m.id === ts.movie_id))
    .filter(Boolean) as typeof movies;

  // Grupowanie filmów po typie
  const groupedMovies = movies.reduce((acc, movie) => {
    const type = movie.movie_type || 'STANDARD';

    if (!acc[type]) {
      acc[type] = [];
    }
    acc[type].push(movie);
    return acc;
  }, {} as Record<string, typeof movies>);

  // Wymuszamy, by "STANDARD" było na samej górze
  const mainCategory = "STANDARD";
  const sortedCategories = Object.keys(groupedMovies).sort((a, b) => {
    if (a === mainCategory) return -1;
    if (b === mainCategory) return 1;
    return a.localeCompare(b);
  });

  return (
    <main className="container mx-auto p-4 pt-8 pb-16 overflow-hidden">
      <h1 className="text-4xl font-extrabold mb-8 text-slate-100 tracking-tight">Repertuar Kin</h1>

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
            
            {/* Kontener dla karuzeli */}
            <div 
              className="flex overflow-x-auto gap-5 pb-6 snap-x -mx-4 px-4 sm:mx-0 sm:px-0" 
              style={{ scrollbarWidth: 'thin' }}
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
