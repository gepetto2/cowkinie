"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { ZoomIn, X } from "lucide-react";
import Image from "next/image";
import { Database } from "@/types/database.types";
import { supabase } from "@/lib/supabase/client";
import { movieRatings, movieRatingsFull } from "@/lib/ratings";
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
  else if (lower.includes("multikino")) { bgColor = "bg-[#eb008b]"; textColor = "text-white"; }
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
type MovieDetails = { genre: string | null; synopsis: string | null; cast: string | null; ratingUrls: Record<string, string> };

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

// Opis dostępności miejsc z availability_ratio (frakcja WOLNYCH miejsc; null = kino nie podaje danych).
// `dot` = kolor CSS kropki na chipie godziny. Kropkę pokazujemy TYLKO gdy miejsc zaczyna brakować
// (<60% wolnych) - przy dużej dostępności bez kropki. Kolor to gradient bursztyn->czerwień w miarę
// zapełniania (60% wolnych -> bursztyn, 0% -> czerwień). null = brak kropki (dużo miejsc lub brak danych).
function availabilityInfo(ratio: number | null): { label: string; color: string; pct: number | null; dot: string | null } {
  if (ratio === null || ratio === undefined) return { label: "Brak danych o dostępności miejsc", color: "text-slate-400", pct: null, dot: null };
  const pct = Math.round(ratio * 100);
  const dot = ratio < 0.60 ? `hsl(${Math.max(0, Math.min(42, (42 * ratio) / 0.60))} 90% 55%)` : null;
  if (ratio <= 0) return { label: "Wyprzedane", color: "text-rose-400", pct: 0, dot };
  if (ratio <= 0.30) return { label: `Ostatnie miejsca · ${pct}% wolnych`, color: "text-rose-400", pct, dot };
  if (ratio < 0.60) return { label: `Mało miejsc · ${pct}% wolnych`, color: "text-amber-400", pct, dot };
  return { label: `${pct}% miejsc wolnych`, color: "text-emerald-400", pct, dot };
}

// Widok szczegółów pojedynczego seansu (trzeci poziom modalu): dane z bazy + przycisk zakupu.
function ScreeningDetails({ screening, dateLabel, onBack }: { screening: Screening; dateLabel: string; onBack: () => void }) {
  const c = screening.cinemas;
  const cinemaName = c?.franchise && c.name !== c.franchise ? `${c.franchise} ${c.name}` : (c?.name || "Nieznane kino");
  const group = cinemaGroup(c);
  const badge = group ? badgeKey(group) : null;
  const fmtT = (iso: string) => new Date(iso).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Warsaw" });
  const end = screening.end_time ? fmtT(screening.end_time) : null;
  const avail = availabilityInfo(screening.availability_ratio);
  const rows: [string, string | null][] = [
    ["Sala", screening.room_name],
    ["Format", screening.format],
    ["Wersja", screening.lang],
  ];
  return (
    <div className="flex flex-col gap-4">
      <button onClick={onBack} className="self-start text-sm text-indigo-400 hover:text-indigo-300 flex items-center gap-1">
        &larr; Wróć do godzin
      </button>
      <div className="flex items-center gap-2">
        {badge && <FranchiseBadge franchise={badge} size="sm" />}
        <span className="font-semibold text-slate-100">{cinemaName}</span>
      </div>
      <div>
        <div className="text-3xl font-bold text-slate-100">
          {fmtT(screening.start_time)}
          {end && <span className="text-xl font-normal text-slate-400"> – {end}</span>}
        </div>
        <div className="text-sm text-slate-400 capitalize mt-0.5">{dateLabel}</div>
      </div>
      <dl className="flex flex-col gap-2 text-sm border-t border-slate-800 pt-3">
        {rows.filter(([, v]) => v).map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4">
            <dt className="text-slate-500">{label}</dt>
            <dd className="text-slate-200 text-right">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="border-t border-slate-800 pt-3">
        <div className={`text-sm font-medium ${avail.color}`}>{avail.label}</div>
        {avail.pct !== null && (
          <div className="mt-2 h-2 rounded-full bg-slate-800 overflow-hidden">
            <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${avail.pct}%` }} />
          </div>
        )}
      </div>
      <a
        href={screening.booking_link || "#"}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1 inline-flex items-center justify-center rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2.5 text-sm font-semibold text-white transition-colors"
      >
        Kup bilet →
      </a>
    </div>
  );
}

// Akcent koloru nazwy źródła oceny (barwy zbliżone do logotypów).
const RATING_ACCENT: Record<string, string> = {
  filmweb: "text-[#f2d31c]",
  imdb: "text-[#f5c518]",
  tmdb: "text-[#5dd6c0]",
};

// Wiersz „etykieta: wartość" (Reżyseria/Obsada) na pełną szerokość.
function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-sm">
      <span className="text-slate-500 shrink-0 w-[68px]">{label}</span>
      <span className="text-slate-200">{value}</span>
    </div>
  );
}

// Pigułka oceny; klikalna (link do strony źródła), gdy znamy URL - inaczej zwykły znacznik.
function RatingPill({ pkey, label, value, url }: { pkey: string; label: string; value: number; url?: string }) {
  const accent = RATING_ACCENT[pkey] || "text-slate-400";
  const inner = (
    <>
      <span className="text-amber-400">★</span>
      <span className="font-medium text-slate-100">{value.toFixed(1)}</span>
      <span className={`text-[11px] font-medium ${accent}`}>{label}</span>
      {url && <span className="text-[11px] text-slate-500" aria-hidden="true">↗</span>}
    </>
  );
  const cls = "inline-flex items-center gap-1.5 rounded-full bg-slate-800 border border-slate-700 px-2.5 py-1 text-[13px] whitespace-nowrap";
  return url ? (
    <a href={url} target="_blank" rel="noopener noreferrer" className={`${cls} hover:bg-slate-700 hover:border-slate-600 transition-colors`} title={`${label} — otwórz stronę filmu`}>
      {inner}
    </a>
  ) : (
    <span className={cls}>{inner}</span>
  );
}

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
  const [selectedScreening, setSelectedScreening] = useState<Screening | null>(null);
  const [details, setDetails] = useState<MovieDetails | null>(null);
  const [zoom, setZoom] = useState(false); // powiększenie plakatu (lightbox)

  // Reset/inicjalizacja wybranej daty odbywa się w handlerze otwarcia, aby nie wołać
  // setState synchronicznie w efekcie (unika kaskadowych re-renderów).
  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    // Jeśli użytkownik otworzył modal mając wybrany pojedynczy dzień na stronie głównej, użyj go
    setSelectedDate(open ? singleDay : null);
    setSelectedScreening(null);
    setZoom(false);
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
        .select("genre, description, cast, imdb_id, tmdb_id, filmweb_id")
        .eq("id", movie.id)
        .single();
      if (cancelled || !data) return;
      const d = data as unknown as Record<string, unknown>;
      // Linki do stron źródeł (bezpośrednie po id; Filmweb przez redirect z samego id).
      const ratingUrls: Record<string, string> = {};
      if (d.filmweb_id) ratingUrls.filmweb = `https://www.filmweb.pl/film/x-0-${d.filmweb_id}`;
      if (d.imdb_id) ratingUrls.imdb = `https://www.imdb.com/title/${d.imdb_id}/`;
      if (d.tmdb_id) ratingUrls.tmdb = `https://www.themoviedb.org/movie/${d.tmdb_id}`;
      setDetails({
        genre: (d.genre as string) ?? null,
        synopsis: ((d.description as string) || "").trim() || null,
        cast: ((d.cast as string) || "").trim() || null,
        ratingUrls,
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
  const allRatings = movieRatingsFull(movie); // pełny zestaw ocen do modalu (Filmweb/IMDb/TMDB/RT/Metacritic)
  // Meta jako chipy: rok, długość, poszczególne gatunki.
  const metaChips = [
    movie.release_year ? String(movie.release_year) : null,
    formatRuntime(movie.length),
    ...(details?.genre ? details.genre.split(",").map((g) => g.trim()).filter(Boolean) : []),
  ].filter(Boolean) as string[];

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
    <>
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
      <DialogContent onOpenAutoFocus={(e) => e.preventDefault()} className="sm:max-w-[900px] bg-slate-950 border-slate-800 text-slate-50 p-0 flex flex-col sm:flex-row gap-0 overflow-hidden">

        {/* Lewa kolumna: mały plakat o stałej szerokości + dane obok niego, a opis na pełną
            szerokość poniżej. Plakat się nie rozciąga, więc zostaje miejsce na informacje i opis. */}
        <div className="hidden sm:flex sm:flex-col w-[400px] shrink-0 self-start max-h-[85vh] overflow-y-auto bg-slate-900 p-5 gap-4">
          <div className="flex gap-4">
            {movie.poster ? (
              <button
                type="button"
                onClick={() => setZoom(true)}
                onMouseDown={(e) => e.preventDefault()}
                aria-label="Powiększ plakat"
                className="group relative w-[170px] shrink-0 aspect-[2/3] rounded-lg overflow-hidden bg-slate-800 shadow-md cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
              >
                <Image src={movie.poster} alt={movie.title} fill sizes="170px" className="object-cover" />
                <span className="absolute inset-0 bg-black/0 group-hover:bg-black/35 transition-colors" />
                <span className="absolute top-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-md bg-slate-950/70 text-slate-100 opacity-80 group-hover:opacity-100 group-hover:bg-slate-950/90 transition">
                  <ZoomIn className="h-3.5 w-3.5" />
                </span>
              </button>
            ) : (
              <div className="relative w-[170px] shrink-0 aspect-[2/3] rounded-lg overflow-hidden bg-slate-800 shadow-md">
                <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-xs p-2 text-center">Brak plakatu</div>
              </div>
            )}
            <div className="flex flex-col gap-3 min-w-0">
              {allRatings.length > 0 && (
                <div className="flex flex-col items-start gap-1.5">
                  {allRatings.map((r) => (
                    <RatingPill key={r.key} pkey={r.key} label={r.label} value={r.value} url={details?.ratingUrls[r.key]} />
                  ))}
                </div>
              )}
              {metaChips.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {metaChips.map((c, i) => (
                    <span key={i} className="rounded-md bg-slate-800 border border-slate-700 px-2 py-0.5 text-xs text-slate-300">{c}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
          {movie.director && <InfoRow label="Reżyseria" value={movie.director} />}
          {details?.cast && <InfoRow label="Obsada" value={details.cast} />}
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
          <div className="sm:hidden shrink-0 mb-4 flex flex-col gap-2.5">
            {allRatings.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {allRatings.map((r) => (
                  <RatingPill key={r.key} pkey={r.key} label={r.label} value={r.value} url={details?.ratingUrls[r.key]} />
                ))}
              </div>
            )}
            {metaChips.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {metaChips.map((c, i) => (
                  <span key={i} className="rounded-md bg-slate-800 border border-slate-700 px-2 py-0.5 text-xs text-slate-300">{c}</span>
                ))}
              </div>
            )}
            {movie.director && <InfoRow label="Reżyseria" value={movie.director} />}
            {details?.cast && <InfoRow label="Obsada" value={details.cast} />}
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
            ) : selectedScreening ? (
              <ScreeningDetails
                screening={selectedScreening}
                dateLabel={formatDateLabel(selectedDate)}
                onBack={() => setSelectedScreening(null)}
              />
            ) : (
              <div className="flex flex-col gap-4">
                <button
                  onClick={() => { setSelectedDate(null); setSelectedScreening(null); }}
                  className="self-start text-sm text-indigo-400 hover:text-indigo-300 flex items-center gap-1 mb-2"
                >
                  &larr; Wróć do wyboru daty
                </button>
                <h3 className="text-lg font-bold text-slate-200 capitalize border-b border-slate-800 pb-2 mb-2">
                  {formatDateLabel(selectedDate)}
                </h3>
                {cinemaGroups.length > 0 ? (
                  <div className="flex flex-col gap-3">
                    <p className="text-xs text-indigo-300/80 flex items-center gap-1">
                      <span aria-hidden="true">›</span> Kliknij godzinę, aby zobaczyć szczegóły i dostępność miejsc
                    </p>
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
                                  const dot = availabilityInfo(s.availability_ratio).dot;
                                  return (
                                    <button
                                      key={s.id}
                                      type="button"
                                      onClick={() => setSelectedScreening(s)}
                                      className="relative bg-slate-800 hover:bg-indigo-600 border border-slate-700 hover:border-indigo-500 transition-all rounded-md px-3 py-1.5 text-sm font-semibold text-slate-200 cursor-pointer hover:-translate-y-0.5 hover:shadow-lg"
                                    >
                                      {time}
                                      <span className="ml-1 font-normal text-slate-500" aria-hidden="true">›</span>
                                      {dot && (
                                        <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full border-[1.5px] border-slate-900" style={{ backgroundColor: dot }} />
                                      )}
                                    </button>
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

    {/* Lightbox plakatu jako osobny Dialog Radix - poprawne warstwowanie i zamykanie tylko jego
        (klik w tło / ✕ / Esc zamyka powiększenie, modal filmu zostaje otwarty). */}
    <Dialog open={zoom} onOpenChange={setZoom}>
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        onClick={() => setZoom(false)}
        className="inset-0 top-0 left-0 h-full w-full max-w-none sm:max-w-none translate-x-0 translate-y-0 flex items-center justify-center rounded-none bg-black/90 p-6 ring-0 sm:p-10 cursor-zoom-out"
      >
        <DialogTitle className="sr-only">Plakat: {movie.title}</DialogTitle>
        <button
          type="button"
          aria-label="Zamknij"
          onClick={() => setZoom(false)}
          className="absolute top-4 right-4 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white/90 hover:bg-white/20 hover:text-white transition cursor-pointer"
        >
          <X className="h-5 w-5" />
        </button>
        {movie.poster && (
          <Image
            src={movie.poster}
            alt={movie.title}
            width={800}
            height={1200}
            sizes="90vw"
            className="h-auto max-h-full w-auto max-w-full rounded-xl object-contain shadow-2xl"
          />
        )}
      </DialogContent>
    </Dialog>
    </>
  );
}
