"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import { Database } from "@/types/database.types";
import { supabase } from "@/lib/supabase/client";
import { movieRatings } from "@/lib/ratings";
import { MovieListItem } from "@/lib/supabase/queries";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

// Karta potrzebuje tylko odchudzonego zestawu kolumn (MovieListItem) + danych o dostępności kin.
type Movie = MovieListItem & {
  available_cities?: string[];
  available_franchises?: string[];
};
type Screening = Database["public"]["Tables"]["screenings"]["Row"] & {
  cinemas: { name: string; city: string; franchise: string | null } | null;
};

// Dzień seansu liczymy w strefie kina (Europe/Warsaw), spójnie z chipami "Wybierz datę" na stronie głównej,
// zamiast w lokalnej strefie przeglądarki (inaczej seans o 23:30 mógłby wpaść do innego dnia).
const warsawDayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
});
const toWarsawDay = (iso: string) => warsawDayFormatter.format(new Date(iso));

// Kolor + skrót sieci kin (wspólne dla plakatu i listy dni w modalu)
function franchiseVisual(franchise: string) {
  const lower = franchise.toLowerCase();
  let bgColor = "bg-slate-700";
  let initial = franchise.charAt(0).toUpperCase();
  if (lower.includes("cinema") && lower.includes("city")) { bgColor = "bg-orange-500"; initial = "CC"; }
  else if (lower.includes("multikino")) bgColor = "bg-red-600";
  else if (lower.includes("helios")) bgColor = "bg-blue-600";
  else if (lower.includes("studyjne")) { bgColor = "bg-indigo-600"; initial = "KS"; }
  return { bgColor, initial };
}

function FranchiseBadge({ franchise, size = "md", className = "" }: { franchise: string; size?: "sm" | "md"; className?: string }) {
  const { bgColor, initial } = franchiseVisual(franchise);
  const dim = size === "sm" ? "w-5 h-5 text-[9px]" : "w-7 h-7 text-[10px]";
  return (
    <div
      className={`${dim} rounded-full flex items-center justify-center font-bold text-white shadow-md border border-slate-900/50 ${bgColor} ${className}`}
      title={franchise}
    >
      {initial}
    </div>
  );
}

const formatScreeningsCount = (count: number) => {
  if (count === 1) return "1 seans";
  const lastDigit = count % 10;
  const lastTwoDigits = count % 100;
  if (lastDigit >= 2 && lastDigit <= 4 && (lastTwoDigits < 12 || lastTwoDigits > 14)) {
    return `${count} seanse`;
  }
  return `${count} seansów`;
};

export default function MovieCard({ movie }: { movie: Movie }) {
  const searchParams = useSearchParams();
  const cityQuery = searchParams.get("city");
  const fromQuery = searchParams.get("from");
  const toQuery = searchParams.get("to");
  // Preselekcja dnia w modalu ma sens tylko dla pojedynczego dnia (from === to), nie dla zakresu
  const singleDay = fromQuery && fromQuery === toQuery ? fromQuery : null;

  const [isOpen, setIsOpen] = useState(false);
  const [screenings, setScreenings] = useState<Screening[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  // Reset/inicjalizacja wybranej daty odbywa się w handlerze otwarcia, aby nie wołać
  // setState synchronicznie w efekcie (unika kaskadowych re-renderów).
  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    // Jeśli użytkownik otworzył modal mając wybrany pojedynczy dzień na stronie głównej, użyj go
    setSelectedDate(open ? singleDay : null);
  };

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    async function fetchScreenings() {
      setIsLoading(true);
      // Filtr po mieście robimy po stronie zapytania (join !inner), by nie ściągać seansów z innych miast
      let queryBuilder = supabase
        .from("screenings")
        .select("*, cinemas!inner(name, city, franchise)")
        .eq("movie_id", movie.id)
        .order("start_time", { ascending: true });

      if (cityQuery) {
        queryBuilder = queryBuilder.eq("cinemas.city", cityQuery);
      }

      const { data, error } = await queryBuilder;

      if (!error && data) {
        setScreenings(data as unknown as Screening[]);
      }
      setIsLoading(false);
    }

    fetchScreenings();
  }, [isOpen, movie.id, cityQuery]);

  // Wyodrębnienie unikalnych dat seansów i zliczenie ich ilości (dzień w strefie kina - Europe/Warsaw)
  const screeningsPerDay = screenings.reduce((acc, s) => {
    const dateStr = toWarsawDay(s.start_time);
    acc[dateStr] = (acc[dateStr] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Zbiór sieci kin grających film danego dnia (do ikon po prawej stronie wiersza)
  const franchisesPerDay = screenings.reduce((acc, s) => {
    const dateStr = toWarsawDay(s.start_time);
    const franchise = s.cinemas?.franchise;
    if (franchise) {
      (acc[dateStr] ??= new Set<string>()).add(franchise);
    }
    return acc;
  }, {} as Record<string, Set<string>>);

  const uniqueDays = Object.keys(screeningsPerDay).sort();

  // Dostępne oceny (Filmweb/IMDb/TMDB) do wyświetlenia pod tytułem
  const ratings = movieRatings(movie);

  // Filtrowanie po wybranej dacie (również w strefie kina)
  const filteredScreenings = screenings.filter(s => toWarsawDay(s.start_time) === selectedDate);

  const formatDateLabel = (dateString: string) => {
    // dateString to już dzień w strefie Warsaw ('YYYY-MM-DD'); formatujemy w UTC, by nie przesunąć dnia
    const d = new Date(`${dateString}T00:00:00Z`);
    return d.toLocaleDateString("pl-PL", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      {/* DialogTrigger opakowuje plakat. Kliknięcie w niego otworzy modal */}
      <DialogTrigger asChild>
        <div className="flex flex-col group cursor-pointer">
          <div className="relative w-full aspect-[2/3] bg-slate-800 rounded-xl overflow-hidden mb-3 shadow-sm group-hover:shadow-md transition-shadow">
            {movie.poster ? (
              <Image src={movie.poster} alt={movie.title} fill sizes="(max-width: 640px) 140px, (max-width: 1024px) 160px, 180px" className="object-cover" />
            ) : (
              <div className="flex items-center justify-center w-full h-full text-slate-500 text-xs text-center p-2">Brak plakatu</div>
            )}
            
            {/* Ikony kin */}
            {movie.available_franchises && movie.available_franchises.length > 0 && (
              <div className="absolute bottom-2 right-2 flex flex-row gap-1.5 z-10">
                {movie.available_franchises.map(franchise => (
                  <FranchiseBadge key={franchise} franchise={franchise} className="hover:scale-110 transition-transform" />
                ))}
              </div>
            )}
          </div>
          <h3 className="font-semibold text-sm leading-tight text-slate-100 line-clamp-2">{movie.title}</h3>
          <p className="text-xs text-slate-400 mt-1">{movie.release_year || ''}</p>
          {ratings.length > 0 && (
            <div className="flex flex-wrap gap-x-2 gap-y-0.5 mt-1 text-[11px] text-slate-400">
              {ratings.map((r) => (
                <span key={r.label} className="whitespace-nowrap">
                  <span className="text-amber-400">★</span> {r.value.toFixed(1)} <span className="text-slate-500">{r.label}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </DialogTrigger>
      
      {/* Zawartość okienka, które się pojawi */}
      <DialogContent className="sm:max-w-[800px] bg-slate-950 border-slate-800 text-slate-50 p-0 flex flex-col sm:flex-row gap-0 overflow-hidden">
        
        {/* Lewa kolumna z plakatem */}
        <div className="hidden sm:block w-[300px] shrink-0 bg-slate-900 relative">
          {movie.poster ? (
            <Image src={movie.poster} alt={movie.title} fill sizes="300px" className="object-cover" />
          ) : (
            <div className="flex items-center justify-center w-full h-full text-slate-500 text-sm p-4 text-center absolute inset-0">Brak plakatu</div>
          )}
        </div>
        
        {/* Prawa kolumna z treścią */}
        <div className="flex-1 p-6 flex flex-col min-h-[450px] max-h-[85vh] overflow-hidden">
          <DialogHeader className="mb-4 shrink-0">
            <DialogTitle className="text-2xl">{movie.title}</DialogTitle>
            <DialogDescription className="text-slate-400">
              {movie.director ? `Reżyseria: ${movie.director}` : 'Wybierz datę, aby zobaczyć godziny seansów.'}
            </DialogDescription>
          </DialogHeader>
          
          <div className="flex flex-col gap-4 overflow-y-auto pr-2 flex-1 min-h-0">
            {isLoading ? (
              <div className="text-sm text-slate-400 text-center py-8 animate-pulse">Szukam seansów...</div>
            ) : screenings.length === 0 ? (
              <div className="text-sm text-slate-400 text-center py-8">
                Brak zaplanowanych seansów dla tego filmu w naszej bazie.
              </div>
            ) : !selectedDate ? (
              <div className="flex flex-col gap-2 pb-4">
                {uniqueDays.map(date => {
                  const count = screeningsPerDay[date];
                  return (
                    <button
                      key={date}
                      onClick={() => setSelectedDate(date)}
                      className="group w-full bg-slate-800 hover:bg-indigo-600 border border-slate-700 hover:border-indigo-500 transition-colors rounded-lg p-4 text-left flex items-center justify-between"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-semibold text-slate-200 capitalize truncate">{formatDateLabel(date)}</span>
                        <span className="text-sm text-slate-400 group-hover:text-indigo-200 transition-colors shrink-0">({formatScreeningsCount(count)})</span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 pl-2">
                        <div className="flex flex-row gap-1">
                          {[...(franchisesPerDay[date] ?? [])].sort().map(franchise => (
                            <FranchiseBadge key={franchise} franchise={franchise} size="sm" />
                          ))}
                        </div>
                        <span className="text-slate-500 group-hover:text-slate-200 transition-colors">&rarr;</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <button
                  onClick={() => setSelectedDate(null)}
                  className="self-start text-sm text-indigo-400 hover:text-indigo-300 flex items-center gap-1 mb-2"
                >
                  &larr; Wróć do wyboru daty
                </button>
                <h3 className="text-lg font-bold text-slate-200 capitalize border-b border-slate-800 pb-2 mb-2">
                  {formatDateLabel(selectedDate)}
                </h3>
                <div className="mb-4 bg-slate-900/50 p-3 rounded-lg border border-slate-800">
                  <div className="flex flex-wrap gap-2">
                    {filteredScreenings.length > 0 ? (
                      filteredScreenings.map((s) => {
                        const time = new Date(s.start_time).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Warsaw" });
                        const cinemaName = s.cinemas?.name || "Nieznane kino";
                        
                        return (
                          <a
                            key={s.id}
                            href={s.booking_link || "#"}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="group flex flex-col items-center justify-center bg-slate-800 hover:bg-indigo-600 border border-slate-700 hover:border-indigo-500 transition-colors rounded-md p-2 text-xs text-slate-200 min-w-[72px]"
                          >
                            <span className="font-bold text-sm mb-0.5">{time}</span>
                            <span className="text-[10px] text-slate-400 group-hover:text-indigo-100 text-center leading-tight mb-0.5">{cinemaName}</span>
                            {s.lang && <span className="text-[9px] uppercase mt-0.5 opacity-70 bg-slate-950/50 px-1 rounded">{s.lang}</span>}
                          </a>
                        );
                      })
                    ) : (
                      <div className="w-full text-center text-sm text-slate-400 py-4">Brak seansów tego dnia w wybranych kinach.</div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
