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
  cinemas: { name: string; city: string; franchise: string | null; category: string | null } | null;
};

// Grupa do badge'a: dla sieci realna marka, dla reszty kategoria (studyjne/niezależne) - spójnie z widokiem.
function cinemaGroup(cinema: { franchise: string | null; category: string | null } | null): string | null {
  if (!cinema) return null;
  return cinema.category === "sieć" ? cinema.franchise : cinema.category;
}

// Klucz badge'a: sieci osobno (marka), a studyjne i niezależne łączymy w jedno "Inne".
function badgeKey(group: string): string {
  return group === "studyjne" || group === "niezależne" ? "Inne" : group;
}

// Grupowanie seansów wybranego dnia do widoku: kino -> wersja (format + język) -> godziny.
// Każde kino osobno (skanowanie do swojego kina), a w jego obrębie podsekcje per format/wersja.
type VersionGroup = { key: string; label: string; screenings: Screening[] };
type CinemaGroup = { key: string; name: string; badge: string | null; versions: VersionGroup[] };

function buildCinemaGroups(screenings: Screening[]): CinemaGroup[] {
  // Klucz kina musi uwzględniać franczyzę i miasto - nazwy sieciówek to często sama nazwa miasta
  // (np. CC/Helios/Multikino w Bydgoszczy mają name="Bydgoszcz"), więc sama nazwa je scala.
  const byCinema = new Map<string, Screening[]>();
  for (const s of screenings) {
    const c = s.cinemas;
    const key = `${c?.franchise ?? ""}|${c?.city ?? ""}|${c?.name ?? ""}`;
    const arr = byCinema.get(key);
    if (arr) arr.push(s);
    else byCinema.set(key, [s]);
  }
  const result: CinemaGroup[] = [];
  for (const [key, list] of byCinema) {
    const c = list[0].cinemas;
    const rawName = c?.name || "Nieznane kino";
    // Markę dołączamy do każdej nazwy dla spójności ("Helios Bydgoszcz", "Multikino Poznań Stary
    // Browar"), poza kinami, których nazwa już jest marką (np. "Kino Muza" - bez dublowania).
    const name = c?.franchise && rawName !== c.franchise ? `${c.franchise} ${rawName}` : rawName;
    const group = cinemaGroup(c);
    const byVersion = new Map<string, Screening[]>();
    for (const s of list) {
      const vkey = [s.format, s.lang].filter(Boolean).join(" · ") || "—";
      const arr = byVersion.get(vkey);
      if (arr) arr.push(s);
      else byVersion.set(vkey, [s]);
    }
    const versions = [...byVersion.entries()]
      .map(([vkey, scr]) => ({
        key: vkey,
        label: vkey === "—" ? "" : vkey,
        screenings: [...scr].sort((a, b) => a.start_time.localeCompare(b.start_time)),
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
    result.push({ key, name, badge: group ? badgeKey(group) : null, versions });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

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
  let textColor = "text-white";
  let initial = franchise.charAt(0).toUpperCase();
  // Kolory z logotypów kin: tło = kolor podstawowy, font = kolor drugorzędny marki (gdy jest).
  if (lower.includes("cinema") && lower.includes("city")) { bgColor = "bg-[#f5821f]"; initial = "CC"; }
  else if (lower.includes("multikino")) { bgColor = "bg-[#eb008b]"; textColor = "text-[#fbe82c]"; }
  else if (lower.includes("helios")) { bgColor = "bg-[#002b55]"; textColor = "text-white"; }
  else if (lower === "inne") { bgColor = "bg-teal-600"; initial = "IN"; }
  return { bgColor, textColor, initial };
}

function FranchiseBadge({ franchise, size = "md", className = "" }: { franchise: string; size?: "sm" | "md"; className?: string }) {
  const { bgColor, textColor, initial } = franchiseVisual(franchise);
  const dim = size === "sm" ? "w-5 h-5 text-[9px]" : "w-7 h-7 text-[10px]";
  return (
    <div
      className={`${dim} rounded-full flex items-center justify-center font-bold ${textColor} shadow-md border border-slate-900/50 ${bgColor} ${className}`}
      title={franchise}
    >
      {initial}
    </div>
  );
}

// Czas trwania w formacie "2 godz. 15 min" / "48 min" / "2 godz."
function formatRuntime(length: number | null): string | null {
  if (!length || length <= 0) return null;
  const h = Math.floor(length / 60);
  const m = length % 60;
  if (h && m) return `${h} godz. ${m} min`;
  if (h) return `${h} godz.`;
  return `${m} min`;
}

// Opis bierzemy ze skonsolidowanej kolumny `description` (potok wybiera najlepsze źródło,
// degradując urwane teasery) - front nie musi już ściągać 8 kolumn per-źródło.
type MovieDetails = { genre: string | null; synopsis: string | null; cast: string | null };

// Opis fabuły bywa długi (Filmweb/Helios do 1500-2000 znaków), a lewa kolumna jest wąska,
// więc domyślnie przycinamy do kilku linii z możliwością rozwinięcia. Toggle pokazujemy tylko
// gdy tekst realnie się nie mieści (~heurystyka po długości, bez mierzenia DOM).
function SynopsisBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const clampable = text.length > 220;
  return (
    <div className="text-sm text-slate-300 leading-relaxed">
      <p className={!expanded && clampable ? "line-clamp-5" : ""}>{text}</p>
      {clampable && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-xs text-indigo-400 hover:text-indigo-300"
        >
          {expanded ? "Pokaż mniej" : "Pokaż więcej"}
        </button>
      )}
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

export default function MovieCard({ movie, priority = false }: { movie: Movie; priority?: boolean }) {
  const searchParams = useSearchParams();
  const cityQuery = searchParams.get("city");
  const formatQuery = searchParams.get("format");
  const langQuery = searchParams.get("lang");
  const fromQuery = searchParams.get("from");
  const toQuery = searchParams.get("to");
  // Preselekcja dnia w modalu ma sens tylko dla pojedynczego dnia (from === to), nie dla zakresu
  const singleDay = fromQuery && fromQuery === toQuery ? fromQuery : null;

  const [isOpen, setIsOpen] = useState(false);
  const [screenings, setScreenings] = useState<Screening[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [details, setDetails] = useState<MovieDetails | null>(null);

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
        .select("*, cinemas!inner(name, city, franchise, category)")
        .eq("movie_id", movie.id)
        .order("start_time", { ascending: true });

      if (cityQuery) {
        queryBuilder = queryBuilder.eq("cinemas.city", cityQuery);
      }
      // Filtr formatu / wersji językowej: listy dokładnych wartości (multi-select), spójnie z listą filmów.
      const formats = (formatQuery || "").split(",").filter(Boolean);
      if (formats.length) {
        queryBuilder = queryBuilder.in("format", formats);
      }
      const langs = (langQuery || "").split(",").filter(Boolean);
      if (langs.length) {
        queryBuilder = queryBuilder.in("lang", langs);
      }

      const { data, error } = await queryBuilder;

      if (!error && data) {
        setScreenings(data as unknown as Screening[]);
      }
      setIsLoading(false);
    }

    fetchScreenings();
  }, [isOpen, movie.id, cityQuery, formatQuery, langQuery]);

  // Szczegóły filmu (gatunek, opis) dociągamy leniwie przy otwarciu - nie ma ich w odchudzonym
  // MovieListItem. Opis to skonsolidowana kolumna `description` (wybór źródła robi potok).
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    async function fetchDetails() {
      const { data } = await supabase
        .from("movies")
        .select("genre, description, cast")
        .eq("id", movie.id)
        .single();
      if (cancelled || !data) return;
      const d = data as unknown as Record<string, string | null>;
      setDetails({
        genre: d.genre,
        synopsis: (d.description || "").trim() || null,
        cast: (d.cast || "").trim() || null,
      });
    }
    fetchDetails();
    return () => {
      cancelled = true;
    };
  }, [isOpen, movie.id]);

  // Wyodrębnienie unikalnych dat seansów i zliczenie ich ilości (dzień w strefie kina - Europe/Warsaw)
  const screeningsPerDay = screenings.reduce((acc, s) => {
    const dateStr = toWarsawDay(s.start_time);
    acc[dateStr] = (acc[dateStr] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Zbiór sieci kin grających film danego dnia (do ikon po prawej stronie wiersza)
  const franchisesPerDay = screenings.reduce((acc, s) => {
    const dateStr = toWarsawDay(s.start_time);
    const group = cinemaGroup(s.cinemas);
    if (group) {
      (acc[dateStr] ??= new Set<string>()).add(badgeKey(group));
    }
    return acc;
  }, {} as Record<string, Set<string>>);

  const uniqueDays = Object.keys(screeningsPerDay).sort();

  // Dostępne oceny (Filmweb/IMDb/TMDB) do wyświetlenia pod tytułem
  const ratings = movieRatings(movie);

  // Badge'y na plakacie: sieci osobno, studyjne+niezależne złączone w "Inne" (bez duplikatów)
  const posterBadges = [...new Set((movie.available_franchises ?? []).map(badgeKey))];

  // Filtrowanie po wybranej dacie (również w strefie kina)
  const filteredScreenings = screenings.filter(s => toWarsawDay(s.start_time) === selectedDate);
  const cinemaGroups = selectedDate ? buildCinemaGroups(filteredScreenings) : [];

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
              <Image src={movie.poster} alt={movie.title} fill priority={priority} sizes="(max-width: 640px) 30vw, (max-width: 1024px) 20vw, 180px" className="object-cover" />
            ) : (
              <div className="flex items-center justify-center w-full h-full text-slate-500 text-xs text-center p-2">Brak plakatu</div>
            )}
            
            {/* Ikony kin (studyjne + niezależne złączone w jedno "Inne", z deduplikacją) */}
            {posterBadges.length > 0 && (
              <div className="absolute bottom-2 right-2 flex flex-row gap-1.5 z-10">
                {posterBadges.map(franchise => (
                  <FranchiseBadge key={franchise} franchise={franchise} className="hover:scale-110 transition-transform" />
                ))}
              </div>
            )}
          </div>
          <h3 className="font-semibold text-sm leading-tight text-slate-100 line-clamp-2">{movie.title}</h3>
          <p className="text-xs text-slate-400 mt-1">
            {[movie.release_year, formatRuntime(movie.length)].filter(Boolean).join(' · ')}
          </p>
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
      <DialogContent className="sm:max-w-[900px] bg-slate-950 border-slate-800 text-slate-50 p-0 flex flex-col sm:flex-row gap-0 overflow-hidden">

        {/* Lewa kolumna: mały plakat o stałej szerokości + dane obok niego, a opis na pełną
            szerokość poniżej. Plakat się nie rozciąga, więc zostaje miejsce na informacje i opis. */}
        <div className="hidden sm:flex sm:flex-col w-[400px] shrink-0 self-start max-h-[85vh] overflow-y-auto bg-slate-900 p-5 gap-4">
          <div className="flex gap-4">
            <div className="relative w-[180px] shrink-0 aspect-[2/3] rounded-lg overflow-hidden bg-slate-800 shadow-md">
              {movie.poster ? (
                <Image src={movie.poster} alt={movie.title} fill sizes="180px" className="object-cover" />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-xs p-2 text-center">Brak plakatu</div>
              )}
            </div>
            <div className="flex flex-col gap-2.5 text-sm min-w-0">
              {ratings.length > 0 && (
                <div className="flex flex-col gap-1">
                  {ratings.map((r) => (
                    <span key={r.label} className="whitespace-nowrap text-slate-200">
                      <span className="text-amber-400">★</span> {r.value.toFixed(1)} <span className="text-slate-500 text-xs">{r.label}</span>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex flex-col gap-1.5">
                {movie.release_year && (
                  <div className="text-slate-300"><span className="text-slate-500">Rok:</span> {movie.release_year}</div>
                )}
                {formatRuntime(movie.length) && (
                  <div className="text-slate-300"><span className="text-slate-500">Długość:</span> {formatRuntime(movie.length)}</div>
                )}
                {details?.genre && (
                  <div className="text-slate-300"><span className="text-slate-500">Gatunek:</span> {details.genre}</div>
                )}
                {movie.director && (
                  <div className="text-slate-300"><span className="text-slate-500">Reżyseria:</span> {movie.director}</div>
                )}
              </div>
            </div>
          </div>
          {details?.cast && (
            <div className="text-sm text-slate-300"><span className="text-slate-500">Obsada:</span> {details.cast}</div>
          )}
          {details?.synopsis && <SynopsisBlock text={details.synopsis} />}
        </div>

        {/* Prawa kolumna z treścią */}
        <div className="flex-1 p-6 flex flex-col min-h-[450px] max-h-[85vh] overflow-hidden">
          <DialogHeader className="mb-4 shrink-0">
            <DialogTitle className="text-2xl">{movie.title}</DialogTitle>
            <DialogDescription className="text-slate-400">
              Repertuar i godziny seansów.
            </DialogDescription>
          </DialogHeader>

          {/* Meta na mobile (bez lewej kolumny) - żeby oceny i podstawowe dane były widoczne na telefonie */}
          <div className="sm:hidden shrink-0 mb-4 flex flex-col gap-1.5 text-sm">
            {ratings.length > 0 && (
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {ratings.map((r) => (
                  <span key={r.label} className="whitespace-nowrap text-slate-200">
                    <span className="text-amber-400">★</span> {r.value.toFixed(1)} <span className="text-slate-500 text-xs">{r.label}</span>
                  </span>
                ))}
              </div>
            )}
            {movie.release_year && (
              <div className="text-slate-300"><span className="text-slate-500">Rok:</span> {movie.release_year}</div>
            )}
            {formatRuntime(movie.length) && (
              <div className="text-slate-300"><span className="text-slate-500">Długość:</span> {formatRuntime(movie.length)}</div>
            )}
            {details?.genre && (
              <div className="text-slate-300"><span className="text-slate-500">Gatunek:</span> {details.genre}</div>
            )}
            {movie.director && (
              <div className="text-slate-300"><span className="text-slate-500">Reżyseria:</span> {movie.director}</div>
            )}
            {details?.cast && (
              <div className="text-slate-300"><span className="text-slate-500">Obsada:</span> {details.cast}</div>
            )}
            {details?.synopsis && <SynopsisBlock text={details.synopsis} />}
          </div>

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
                {cinemaGroups.length > 0 ? (
                  <div className="flex flex-col gap-3">
                    {cinemaGroups.map((cg) => (
                      <div key={cg.key} className="bg-slate-900/50 p-3 rounded-lg border border-slate-800">
                        <div className="flex items-center gap-2 mb-2.5">
                          {cg.badge && <FranchiseBadge franchise={cg.badge} size="sm" />}
                          <span className="font-semibold text-sm text-slate-200">{cg.name}</span>
                        </div>
                        <div className="flex flex-col gap-2.5">
                          {cg.versions.map((v) => (
                            <div key={v.key}>
                              {v.label && (
                                <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1.5">{v.label}</div>
                              )}
                              <div className="flex flex-wrap gap-2">
                                {v.screenings.map((s) => {
                                  const time = new Date(s.start_time).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Warsaw" });
                                  return (
                                    <a
                                      key={s.id}
                                      href={s.booking_link || "#"}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="bg-slate-800 hover:bg-indigo-600 border border-slate-700 hover:border-indigo-500 transition-colors rounded-md px-3 py-1.5 text-sm font-semibold text-slate-200"
                                    >
                                      {time}
                                    </a>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="w-full text-center text-sm text-slate-400 py-4">Brak seansów tego dnia w wybranych kinach.</div>
                )}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
