import { supabase } from '@/lib/supabase/client';

// Wyłączamy cache, aby strona pomocnicza zawsze pokazywała najświeższe dane z bazy
export const revalidate = 0;

type InfoItem = { label: string; value: string | number | null };

const InfoBlock = ({ title, items }: { title: string; items: InfoItem[] }) => (
  <div className="bg-slate-950 p-4 rounded-xl border border-slate-800/60 shadow-inner">
    <h3 className="text-sm font-bold text-slate-300 mb-3 border-b border-slate-800/80 pb-2 uppercase tracking-wider">{title}</h3>
    <dl className="space-y-2 text-sm">
      {items.map((item, idx) => {
        const isLong = typeof item.value === 'string' && item.value.length > 50;
        return (
          <div key={idx} className={`flex ${isLong ? 'flex-col gap-1' : 'justify-between items-center gap-4'}`}>
            <dt className="text-slate-500 font-medium shrink-0">{item.label}</dt>
            <dd 
              className={`text-slate-300 ${isLong ? 'line-clamp-3 text-xs leading-relaxed' : 'text-right truncate font-medium max-w-[200px]'}`} 
              title={item.value !== null ? String(item.value) : ''}
            >
              {item.value !== null ? String(item.value) : <span className="text-slate-700">-</span>}
            </dd>
          </div>
        );
      })}
    </dl>
  </div>
);

const PosterImage = ({ src, source }: { src: string | null; source: string }) => {
  if (!src) return null;
  return (
    <div className="flex flex-col items-center gap-2 shrink-0">
      <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">{source}</span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img 
        src={src} 
        width={128}
        height={192}
        alt={`Plakat z ${source}`} 
        className="w-32 h-48 object-cover rounded-lg shadow-md border border-slate-700/50 bg-slate-900" 
        loading="lazy" 
      />
    </div>
  );
};

export default async function MoviesInfoPage() {
  const { data: movies, error } = await supabase
    .from('movies')
    .select('*')
    .order('title', { ascending: true });

  if (error) {
    return (
      <div className="p-8 text-red-400 bg-slate-950 min-h-screen">
        <h1 className="text-2xl font-bold mb-4">Wystąpił błąd podczas pobierania danych</h1>
        <pre>{error.message}</pre>
      </div>
    );
  }

  return (
    <main className="p-4 sm:p-8 min-h-screen bg-slate-950 flex flex-col">
      <div className="mb-6">
        <h1 className="text-3xl font-extrabold text-slate-100 tracking-tight">
          Informacje o filmach (Debug)
        </h1>
        <p className="text-slate-400 mt-2">
          Lista zawiera {movies?.length || 0} wpisów. Pokazuje połączone plakaty i detale z poszczególnych platform.
        </p>
      </div>

      <div className="flex-1 space-y-8 pb-12">
        {movies?.length === 0 ? (
          <div className="p-8 text-center text-slate-500 bg-slate-900 rounded-xl border border-slate-800">
            Brak filmów w bazie.
          </div>
        ) : (
          movies?.map((movie) => (
            <div key={movie.id} className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
              
              {/* Nagłówek filmu */}
              <div className="bg-slate-800/30 px-6 py-4 border-b border-slate-800">
                <div className="flex justify-between items-start gap-4">
                  <div>
                    <h2 className="text-2xl font-bold text-white">
                      {movie.title} <span className="text-slate-400 font-medium text-xl">({movie.release_year || 'Brak roku'})</span>
                    </h2>
                    <p className="text-slate-500 text-xs font-mono mt-1">ID: {movie.id}</p>
                  </div>
                </div>
              </div>

              <div className="p-6">
                {/* Sekcja Plakatów */}
                <div className="mb-8">
                  <h3 className="text-sm font-semibold text-slate-400 mb-4 border-l-2 border-indigo-500 pl-2">Zestawienie Plakatów</h3>
                  <div className="flex flex-nowrap overflow-x-auto gap-6 pb-2" style={{ scrollbarWidth: 'thin' }}>
                    <PosterImage src={movie.poster} source="Główny złączony" />
                    <PosterImage src={movie.poster_tmdb} source="TMDB" />
                    {/*<PosterImage src={movie.poster_filmweb} source="Filmweb" />*/}
                    <PosterImage src={movie.poster_cc} source="Cinema City" />
                    <PosterImage src={movie.poster_multikino} source="Multikino" />
                    <PosterImage src={movie.poster_helios} source="Helios" />
                  </div>
                </div>

                {/* Siatka Szczegółów (Zgrupowana wg źródła) */}
                <div>
                  <h3 className="text-sm font-semibold text-slate-400 mb-4 border-l-2 border-amber-500 pl-2">Szczegółowe dane ze źródeł</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                    <InfoBlock 
                      title="Złączone główne" 
                      items={[
                        { label: "Tytuł oryg.", value: movie.original_title },
                        { label: "Reżyser", value: movie.director },
                        { label: "Rok wydania", value: movie.release_year },
                        { label: "Czas", value: movie.length !== null ? `${movie.length} min` : null },
                        { label: "Typ", value: movie.movie_type }
                      ]} 
                    />
                    <InfoBlock 
                      title="TMDB" 
                      items={[
                        { label: "TMDB ID", value: movie.tmdb_id },
                        { label: "Tytuł", value: movie.title_tmdb },
                        { label: "Tytuł oryg.", value: movie.original_title_tmdb },
                        { label: "Reżyser", value: movie.director_tmdb },
                        { label: "Rok", value: movie.release_year_tmdb },
                        { label: "Czas", value: movie.length_tmdb !== null ? `${movie.length_tmdb} min` : null },
                        { label: "Opis", value: movie.description_tmdb }
                      ]} 
                    />
                    <InfoBlock 
                      title="Filmweb" 
                      items={[
                        { label: "Tytuł", value: movie.title_filmweb },
                        { label: "Reżyser", value: movie.director_filmweb },
                        { label: "Rok", value: movie.release_year_filmweb },
                        { label: "Czas", value: movie.length_filmweb !== null ? `${movie.length_filmweb} min` : null }
                      ]} 
                    />
                    <InfoBlock 
                      title="Cinema City" 
                      items={[
                        { label: "Tytuł oryg.", value: movie.original_title_cc },
                        { label: "Reżyser", value: movie.director_cc },
                        { label: "Rok", value: movie.release_year_cc },
                        { label: "Czas", value: movie.length_cc !== null ? `${movie.length_cc} min` : null },
                        { label: "Typ", value: movie.movie_type_cc }
                      ]} 
                    />
                    <InfoBlock 
                      title="Multikino" 
                      items={[
                        { label: "Reżyser", value: movie.director_multikino },
                        { label: "Obsada", value: movie.cast_multikino },
                        { label: "Rok", value: movie.release_year_multikino },
                        { label: "Czas", value: movie.length_multikino !== null ? `${movie.length_multikino} min` : null },
                        { label: "Typ", value: movie.movie_type_multikino },
                        { label: "Opis", value: movie.description_multikino }
                      ]} 
                    />
                    <InfoBlock 
                      title="Helios" 
                      items={[
                        { label: "Tytuł oryg.", value: movie.original_title_helios },
                        { label: "Reżyser", value: movie.director_helios },
                        { label: "Rok", value: movie.release_year_helios },
                        { label: "Czas", value: movie.length_helios !== null ? `${movie.length_helios} min` : null },
                        { label: "Typ", value: movie.movie_type_helios }
                      ]} 
                    />
                  </div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </main>
  );
}
