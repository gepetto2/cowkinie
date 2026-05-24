"use client";

import { useState, useEffect } from "react";
import { Database } from "@/types/database.types";
import { supabase } from "@/lib/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Film } from "lucide-react";

type Movie = Database["public"]["Tables"]["movies"]["Row"];
type Screening = Database["public"]["Tables"]["screenings"]["Row"] & {
  cinemas: { name: string; city: string } | null;
};

export default function MovieCard({ movie }: { movie: Movie }) {
  const [isOpen, setIsOpen] = useState(false);
  const [screenings, setScreenings] = useState<Screening[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    // Jeśli okienko jest zamknięte LUB już pobraliśmy dane - nie odpytujemy bazy ponownie
    if (!isOpen || hasFetched) return;

    async function fetchScreenings() {
      setIsLoading(true);
      const now = new Date().toISOString();
      
      // Pobieramy wszystkie seanse dla wybranego filmu, nie filtrujemy po mieście
      const { data, error } = await supabase
        .from("screenings")
        .select(`
          *,
          cinemas(name, city)
        `)
        .eq("movie_id", movie.id)
        .gte("start_time", now) // Filtrujemy tylko przyszłe i trwające seanse
        .order("start_time", { ascending: true });

      if (!error && data) {
        setScreenings(data as unknown as Screening[]);
      }
      setIsLoading(false);
      setHasFetched(true);
    }

    fetchScreenings();
  }, [isOpen, movie.id, hasFetched]);

  // Grupujemy seanse po kinie, ale dodajemy w nawiasie miasto (np. "Multikino (Warszawa)")
  const groupedScreenings = screenings.reduce((acc, screening) => {
    const cinemaLocation = screening.cinemas 
      ? `${screening.cinemas.name} (${screening.cinemas.city})` 
      : "Nieznane kino";
    if (!acc[cinemaLocation]) acc[cinemaLocation] = [];
    acc[cinemaLocation].push(screening);
    return acc;
  }, {} as Record<string, Screening[]>);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      {/* DialogTrigger opakowuje plakat. Kliknięcie w niego otworzy modal */}
      <DialogTrigger asChild>
        <div className="flex flex-col group cursor-pointer">
          <div className="relative w-full aspect-[2/3] bg-slate-800 rounded-xl overflow-hidden mb-3 shadow-sm group-hover:shadow-md transition-shadow">
            {movie.poster && !imgError ? (
              <img 
                src={movie.poster} 
                alt={movie.title} 
                className="object-cover w-full h-full transition-transform duration-300 group-hover:scale-105" 
                onError={() => setImgError(true)}
              />
            ) : (
              <div className="flex flex-col items-center justify-center w-full h-full text-slate-500 bg-slate-800/50 p-2">
                <Film className="w-8 h-8 mb-2 opacity-40" />
                <span className="text-[10px] uppercase tracking-wider font-semibold text-center opacity-40">Brak plakatu</span>
              </div>
            )}
          </div>
          <h3 className="font-semibold text-sm leading-tight text-slate-100 line-clamp-2">{movie.title}</h3>
          <p className="text-xs text-slate-400 mt-1">{movie.release_year || ''}</p>
        </div>
      </DialogTrigger>
      
      {/* Zawartość okienka, które się pojawi */}
      <DialogContent className="sm:max-w-[800px] bg-slate-950 border-slate-800 text-slate-50 p-0 flex flex-col sm:flex-row gap-0 overflow-hidden">
        
        {/* Lewa kolumna z plakatem */}
        <div className="hidden sm:block w-[300px] shrink-0 bg-slate-900 relative">
          {movie.poster && !imgError ? (
            <img 
              src={movie.poster} 
              alt={movie.title} 
              className="object-contain w-full h-full absolute inset-0" 
              onError={() => setImgError(true)}
            />
          ) : (
            <div className="flex flex-col items-center justify-center w-full h-full text-slate-500 bg-slate-900 absolute inset-0">
              <Film className="w-16 h-16 mb-4 opacity-20" />
              <span className="text-sm uppercase tracking-wider font-semibold opacity-30">Brak plakatu</span>
            </div>
          )}
        </div>
        
        {/* Prawa kolumna z treścią */}
        <div className="flex-1 p-6 flex flex-col min-h-[450px] max-h-[85vh] overflow-hidden">
          <DialogHeader className="mb-4 shrink-0">
            <DialogTitle className="text-2xl">{movie.title}</DialogTitle>
            <DialogDescription className="text-slate-400">
              {movie.director ? `Reżyseria: ${movie.director}` : 'Godziny seansów we wszystkich kinach.'}
            </DialogDescription>
          </DialogHeader>
          
          <div className="flex flex-col gap-4 overflow-y-auto pr-2 flex-1 min-h-0">
            {isLoading ? (
              <div className="text-sm text-slate-400 text-center py-8 animate-pulse">Szukam seansów...</div>
            ) : screenings.length === 0 ? (
              <div className="text-sm text-slate-400 text-center py-8">
                Brak zaplanowanych seansów dla tego filmu w naszej bazie.
              </div>
            ) : (
              Object.entries(groupedScreenings).map(([cinemaLocation, cinemaScreenings]) => (
                <div key={cinemaLocation} className="mb-4 bg-slate-900/50 p-3 rounded-lg border border-slate-800">
                  <h4 className="font-semibold text-indigo-400 mb-3">{cinemaLocation}</h4>
                  <div className="flex flex-wrap gap-2">
                    {cinemaScreenings.map((s) => {
                      const dateObj = new Date(s.start_time);
                      const time = dateObj.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
                      const date = dateObj.toLocaleDateString("pl-PL", { day: "numeric", month: "short" });
                      
                      return (
                        <a
                          key={s.id}
                          href={s.booking_link || "#"}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="group flex flex-col items-center justify-center bg-slate-800 hover:bg-indigo-600 border border-slate-700 hover:border-indigo-500 transition-colors rounded-md p-2 text-xs text-slate-200 min-w-[64px]"
                        >
                          <span className="font-bold text-sm mb-0.5">{time}</span>
                          <span className="text-[10px] text-slate-400 group-hover:text-slate-200">{date}</span>
                          {s.lang && <span className="text-[9px] uppercase mt-0.5 opacity-70 bg-slate-950/50 px-1 rounded">{s.lang}</span>}
                        </a>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
