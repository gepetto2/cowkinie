import { getCities, getMovies } from '@/lib/supabase/queries';
import MovieCard from '@/components/MovieCard';

export default async function Home() {
  const cities = await getCities();
  const movies = await getMovies();

  return (
    <main className="container mx-auto p-4 pt-8">
      <h1 className="text-4xl font-extrabold mb-8 text-slate-100 tracking-tight">Repertuar Kin</h1>

      <section className="mb-10">
        <h2 className="text-lg font-semibold mb-3 text-slate-300">Wybierz miasto:</h2>
        <div className="flex flex-wrap gap-2">
          {cities.map((city) => (
            <button key={city} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-sm font-medium transition-colors">
              {city}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-4 text-slate-300">Dostępne filmy:</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
          {movies.map((movie) => (
            <MovieCard key={movie.id} movie={movie} />
          ))}
        </div>
      </section>
    </main>
  );
}
