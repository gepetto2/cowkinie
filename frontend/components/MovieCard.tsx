"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { ZoomIn, X, Trees, Ellipsis, Play, Sofa, Accessibility } from "lucide-react";
import Image from "next/image";
import { Database } from "@/types/database.types";
import { supabase } from "@/lib/supabase/client";
import { movieRatings, movieRatingsFull } from "@/lib/ratings";
import { cinemaLabel, cinemaGroup, badgeKey, cinemaBadge } from "@/lib/cinemas";
import TrailerEmbed from "@/components/TrailerEmbed";
import HallPlan from "@/components/HallPlan";
import { MovieListItem } from "@/lib/supabase/queries";
import { useCityScope } from "@/components/CityScope";
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
  // Kolumna dodana w bazie (Muza: taras/poza_kinem). Zadeklarowana też tutaj, by typy działały
  // także zanim database.types.ts zostanie zregenerowany.
  is_outdoor?: boolean | null;
};

// Seans plenerowy („na świeżym powietrzu") - flaga z bazy (ustawiana w scraperze Muzy dla tarasu/poza kinem).
const isOutdoor = (s: Screening) => !!s.is_outdoor;

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
    // Miasto zostaje w nazwie - ten widok nie jest pogrupowany po mieście.
    const name = cinemaLabel(c);
    const byVersion = new Map<string, Screening[]>();
    for (const s of list) {
      const vparts = [s.format, s.lang].filter(Boolean);
      if (isOutdoor(s)) vparts.push("Na świeżym powietrzu");
      const vkey = vparts.join(" · ") || "—";
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
    result.push({ key, name, badge: cinemaBadge(c), versions });
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
  // "Inne" renderuje się ikoną (patrz FranchiseBadge), więc `initial` tu nie jest używany.
  else if (lower === "inne") { bgColor = "bg-teal-600"; }
  return { bgColor, textColor, initial };
}

function FranchiseBadge({ franchise, size = "md", className = "" }: { franchise: string; size?: "sm" | "md"; className?: string }) {
  const { bgColor, textColor, initial } = franchiseVisual(franchise);
  // Na mobile badge jest mniejszy także w wariancie "md". Kafelek ma tam ~112 px, a cztery badge'y
  // po 28 px z odstępami potrzebowałyby ~138 px - wylewały się poza plakat. Przy 20 px mieszczą się
  // cztery z zapasem. Od `sm` w górę kafelek ma 160+ px, więc wracamy do czytelniejszego rozmiaru.
  const dim = size === "sm" ? "w-5 h-5 text-[9px]" : "w-5 h-5 text-[9px] sm:w-7 sm:h-7 sm:text-[10px]";
  const iconDim = size === "sm" ? "h-3 w-3" : "h-3 w-3 sm:h-4 sm:w-4";
  // "Inne" (kina studyjne i niezależne) to NAJCZĘSTSZY badge w siatce, a jednocześnie jedyny, którego
  // nie da się rozszyfrować ze skrótu - "IN" nic nie znaczy, podczas gdy "CC" czy "H" odsyłają do marki.
  // Wielokropek czyta się jako "pozostałe": nie udaje czwartej marki i pozostaje czytelny nawet
  // w 20 pikselach, gdzie bardziej szczegółowa ikona zlewa się w plamę. Tooltip mówi wprost,
  // o jakie kina chodzi.
  const isOther = franchise === "Inne";
  return (
    <div
      className={`${dim} rounded-full flex items-center justify-center font-bold ${textColor} shadow-md border border-slate-900/50 ${bgColor} ${className}`}
      title={isOther ? "Kina studyjne i niezależne" : franchise}
    >
      {isOther ? <Ellipsis className={iconDim} strokeWidth={2} aria-hidden="true" /> : initial}
    </div>
  );
}

/**
 * Hosty, których plakatów NIE przepuszczamy przez optymalizator obrazków Next.js.
 *
 * Multikino odrzuca żądania przychodzące z zagranicznych adresów i serwerowni - to ta sama blokada,
 * przez którą scraper repertuaru działa z polskiego łącza, a padał przy próbach uruchomienia go
 * z Azure w USA czy z Cloud Shella. Optymalizator Vercela chodzi we Frankfurcie, więc dostaje od
 * Multikina odmowę, a Vercel zwraca wtedy 502 OPTIMIZED_EXTERNAL_IMAGE_REQUEST_UNAUTHORIZED
 * i kafelek zostaje pusty.
 *
 * `unoptimized` sprawia, że przeglądarka pobiera taki plakat wprost ze źródła - czyli tak, jak
 * działało to przed włączeniem optymalizacji. Tracimy na tych obrazkach konwersję do WebP
 * i skalowanie, ale to jedyny host z tym problemem; pozostałe osiem korzysta z optymalizacji normalnie.
 */
const UNOPTIMIZED_POSTER_HOSTS = ["www.multikino.pl"];

const isUnoptimizedPoster = (src: string | null | undefined): boolean =>
  !!src && UNOPTIMIZED_POSTER_HOSTS.some((host) => src.startsWith(`https://${host}/`));

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
// `lines` ustawiamy osobno dla mobile (3) i desktopu (5) - na wąskim ekranie 5 linii opisu spychało
// listę seansów poza widok. Próg "czy w ogóle skracać" musi iść ZA liczbą linii: przy sztywnym progu
// krótszy clamp ucinałby tekst bez pokazania przycisku rozwijania. 44 znaki/linię to przybliżenie,
// a 5 * 44 = 220 zachowuje dotychczasowe zachowanie na desktopie.
function SynopsisBlock({ text, lines = 5 }: { text: string; lines?: 3 | 5 }) {
  const [expanded, setExpanded] = useState(false);
  const clampable = text.length > lines * 44;
  return (
    <div className="text-sm text-slate-300 leading-relaxed">
      {/* Klasy line-clamp muszą być pełnymi literałami - Tailwind nie widzi nazw sklejanych w locie. */}
      <p className={!expanded && clampable ? (lines === 3 ? "line-clamp-3" : "line-clamp-5") : ""}>{text}</p>
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

/**
 * Szacowanie długości bloku reklam i godziny startu właściwego filmu - WYŁĄCZONE.
 */
const SHOW_AD_ESTIMATE = false;

// Dane sali z `cinema_halls`, dociągane osobno: złączenie idzie po (cinema_id, room_name),
// a to nie jest klucz obcy, więc PostgREST nie zrobi tego zagnieżdżonym selectem.
type HallInfo = { seats_total: number; rows_count: number; wheelchair_seats: number; sofa_seats: number };

const hallKey = (cinemaId: string, room: string | null) => `${cinemaId}|${room ?? ""}`;

const rowWord = (n: number) => (n === 1 ? "rząd" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "rzędy" : "rzędów");

// Widok szczegółów pojedynczego seansu (trzeci poziom modalu): dane z bazy + przycisk zakupu.
function ScreeningDetails({ screening, hall, dateLabel, filmLength, onBack }: { screening: Screening; hall?: HallInfo; dateLabel: string; filmLength: number | null; onBack: () => void }) {
  const c = screening.cinemas;
  const cinemaName = cinemaLabel(c);
  const badge = cinemaBadge(c);
  const fmtT = (iso: string) => new Date(iso).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Warsaw" });
  const end = screening.end_time ? fmtT(screening.end_time) : null;
  // Blok reklam+zwiastunów = (koniec − start) − długość filmu (tylko gdy mamy realny koniec).
  // Dzięki temu wiemy, że sam film startuje ~X min po godzinie z repertuaru.
  const startMs = new Date(screening.start_time).getTime();
  const slotMin = screening.end_time ? Math.round((new Date(screening.end_time).getTime() - startMs) / 60000) : null;
  const adMin = slotMin != null && filmLength ? slotMin - filmLength : null;
  const showAds = SHOW_AD_ESTIMATE && adMin != null && adMin >= 5 && adMin <= 60;
  const filmStart = showAds ? fmtT(new Date(startMs + (adMin as number) * 60000).toISOString()) : null;
  const avail = availabilityInfo(screening.availability_ratio);
  // Nazwa sali i jej rozmiar to jedna informacja - rozbita na dwa wiersze wyglądała jak dwa
  // niezależne fakty.
  const hallLabel = [
    screening.room_name,
    hall && `${hall.seats_total} miejsc`,
    hall && `${hall.rows_count} ${rowWord(hall.rows_count)}`,
  ].filter(Boolean).join(" · ");
  const rows: [string, string | null][] = [
    ["Sala", hallLabel || null],
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
      {isOutdoor(screening) && (
        <span className="self-start inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-300">
          <Trees className="h-3.5 w-3.5" /> Na świeżym powietrzu
        </span>
      )}
      <div>
        <div className="text-3xl font-bold text-slate-100">
          {fmtT(screening.start_time)}
          {end && <span className="text-xl font-normal text-slate-400"> – {end}</span>}
        </div>
        <div className="text-sm text-slate-400 capitalize mt-0.5">{dateLabel}</div>
        {showAds && (
          <div className="text-xs text-slate-500 mt-1.5">
            Szacowana długość reklam: ok. {adMin} min · start filmu ok. {filmStart}
          </div>
        )}
      </div>
      <dl className="flex flex-col gap-2 text-sm border-t border-slate-800 pt-3">
        {rows.filter(([, v]) => v).map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4">
            <dt className="text-slate-500">{label}</dt>
            <dd className="text-slate-200 text-right">{value}</dd>
          </div>
        ))}
      </dl>
      {/* Kanapy i miejsca dla niepełnosprawnych pokazujemy TYLKO gdy są. Zera nie renderujemy, bo "0 kanap"
          nieprawdziwie sugerowałoby, że sieć to zgłasza - Cinema City kanap w ogóle nie oznacza. */}
      {hall && (hall.sofa_seats > 0 || hall.wheelchair_seats > 0) && (
        <div className="flex flex-wrap gap-2 -mt-1">
          {hall.sofa_seats > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-800/60 px-2.5 py-1 text-xs text-slate-300">
              <Sofa className="h-3.5 w-3.5 text-indigo-300" /> {hall.sofa_seats} miejsc na kanapach
            </span>
          )}
          {hall.wheelchair_seats > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-800/60 px-2.5 py-1 text-xs text-slate-300">
              <Accessibility className="h-3.5 w-3.5 text-indigo-300" /> {hall.wheelchair_seats} dla niepełnosprawnych
            </span>
          )}
        </div>
      )}
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
      {/* Plan sali NA KOŃCU, pod przyciskiem zakupu: to najwyższy element tego widoku, a jest
          dodatkiem, nie powodem wejścia tutaj. Wyżej spychał "Kup bilet" poza ekran.
          `key` wymusza remount przy zmianie sali - inaczej zostałby stan poprzedniego układu. */}
      {hall && screening.room_name && (
        <HallPlan
          key={`${screening.cinema_id}|${screening.room_name}`}
          cinemaId={screening.cinema_id}
          roomName={screening.room_name}
        />
      )}
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
// Rząd przełączników zawężających seanse w modalu (format, wersja językowa).
// Renderujemy go TYLKO gdy jest z czego wybierać - przy jednej dostępnej wartości filtr niczego
// nie zmienia, a zabiera miejsce nad listą dni (na telefonie szczególnie kosztowne).
function OptionChips({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  if (options.length < 2) return null;
  return (
    /* Etykieta w rozmiarze DialogDescription ("Repertuar i godziny seansów"), same chipy odrobinę
       mniejsze - text-[13px] i wyściółka jak w RatingPill wyżej, żeby modal był spójny wewnętrznie. */
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-sm text-slate-500 shrink-0">{label}:</span>
      {options.map((o) => {
        const on = selected.includes(o);
        return (
          <button
            key={o}
            type="button"
            onClick={() => onToggle(o)}
            className={`rounded-full border px-2.5 py-1 text-[13px] transition-colors ${
              on
                ? "bg-indigo-600 border-indigo-500 text-white"
                : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"
            }`}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}

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

// `typeLabel` podajemy tylko w scalonej sekcji wydarzeń specjalnych - tam karty różnych typów leżą
// obok siebie, więc bez etykiety nie wiadomo, czy to opera, maraton czy mecz. W pozostałych sekcjach
// typ wynika z nagłówka i powtarzanie go na każdej karcie byłoby szumem.
export default function MovieCard({ movie, priority = false, typeLabel }: { movie: Movie; priority?: boolean; typeLabel?: string }) {
  const searchParams = useSearchParams();
  // Miasta pochodzą ze ścieżki (/poznan, "/" dla całej Polski), więc bierzemy je z kontekstu,
  // gdzie serwer zostawił już rozwiązane nazwy. Klucz do useEffect musi być stabilnym stringiem,
  // bo tablica z kontekstu jest przy każdym renderze nową referencją.
  const { selected: selectedCities } = useCityScope();
  const cityKey = selectedCities.join(",");
  // Format z paska filtrów służy tylko do WSTĘPNEGO ustawienia kontrolki w modalu - dalej modal
  // rządzi się sam. Wersji językowej nie ma już w filtrach globalnych: to wybór dotyczący
  // konkretnego filmu ("napisy czy dubbing"), a nie sposób przeglądania repertuaru.
  const urlFormats = (searchParams.get("format") || "").split(",").filter(Boolean);
  const fromQuery = searchParams.get("from");
  const toQuery = searchParams.get("to");
  // Preselekcja dnia w modalu ma sens tylko dla pojedynczego dnia (from === to), nie dla zakresu
  const singleDay = fromQuery && fromQuery === toQuery ? fromQuery : null;

  const [isOpen, setIsOpen] = useState(false);
  const [screenings, setScreenings] = useState<Screening[]>([]);
  const [halls, setHalls] = useState<Map<string, HallInfo>>(new Map());
  const [isLoading, setIsLoading] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedScreening, setSelectedScreening] = useState<Screening | null>(null);
  const [details, setDetails] = useState<MovieDetails | null>(null);
  // Jedno okno pełnoekranowe na plakat ALBO zwiastun - dwa nakładające się lightboxy mogłyby
  // się przykryć, a nigdy nie chcemy obu naraz.
  const [overlay, setOverlay] = useState<"poster" | "trailer" | null>(null);
  // Filtry seansów działają lokalnie (bez URL-a): modal nie ma własnego adresu, więc nie ma czego
  // współdzielić, a filtrowanie na pobranym zbiorze nie wymaga ponownego zapytania przy każdym kliknięciu.
  const [pickedFormats, setPickedFormats] = useState<string[]>([]);
  const [pickedLangs, setPickedLangs] = useState<string[]>([]);

  // Reset/inicjalizacja wybranej daty odbywa się w handlerze otwarcia, aby nie wołać
  // setState synchronicznie w efekcie (unika kaskadowych re-renderów).
  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    // Jeśli użytkownik otworzył modal mając wybrany pojedynczy dzień na stronie głównej, użyj go
    setSelectedDate(open ? singleDay : null);
    setSelectedScreening(null);
    setOverlay(null);
    // Format przejmujemy z paska filtrów, żeby po wejściu w film widzieć to, czego się szukało.
    // Wersja językowa startuje pusta - nie ma jej wśród filtrów globalnych.
    setPickedFormats(open ? urlFormats : []);
    setPickedLangs([]);
  };

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    let cancelled = false;

    async function fetchScreenings() {
      setIsLoading(true);
      // Pobieramy STRONICUJĄC. Supabase zwraca maksymalnie 1000 wierszy na zapytanie, a najpopularniejszy
      // film potrafi mieć ich ponad 1200 w skali kraju - bez tego ostatnie dni repertuaru znikały po cichu,
      // wyglądając jak koniec repertuaru. Kompletny zbiór jest też potrzebny, żeby poprawnie wyliczyć
      // listę dostępnych formatów i wersji językowych dla filtrów niżej.
      const PAGE = 1000;
      const all: Screening[] = [];
      for (let from = 0; ; from += PAGE) {
        // Builder tworzymy w każdej iteracji - `range` modyfikuje zapytanie, więc nie da się go reużyć.
        // Filtr miasta zostaje po stronie bazy (join !inner): realnie zmniejsza liczbę wierszy.
        let queryBuilder = supabase
          .from("screenings")
          .select("*, cinemas!inner(name, city, franchise, category)")
          .eq("movie_id", movie.id)
          .order("start_time", { ascending: true })
          .range(from, from + PAGE - 1);
        if (selectedCities.length) {
          queryBuilder = queryBuilder.in("cinemas.city", selectedCities);
        }

        const { data, error } = await queryBuilder;
        if (error || !data) break;
        all.push(...(data as unknown as Screening[]));
        if (data.length < PAGE) break;
      }

      if (!cancelled) {
        setScreenings(all);
        setIsLoading(false);
      }

      // Sale dociągamy DOPIERO po seansach i tylko dla kin, które w nich wystąpiły - komplet to
      // 951 sal (168 KB), a jeden film gra zwykle w kilkunastu. Bez `layout`, który waży 10 MB.
      const cinemaIds = [...new Set(all.map((s) => s.cinema_id))];
      if (!cancelled && cinemaIds.length) {
        const { data } = await supabase
          .from("cinema_halls")
          .select("cinema_id, room_name, seats_total, rows_count, wheelchair_seats, sofa_seats")
          .in("cinema_id", cinemaIds);
        if (!cancelled && data) {
          setHalls(new Map(data.map((h) => [hallKey(h.cinema_id!, h.room_name), h as HallInfo])));
        }
      }
    }

    fetchScreenings();
    return () => {
      cancelled = true;
    };
    // selectedCities to przy każdym renderze nowa referencja; zależnością jest jej stabilna
    // reprezentacja tekstowa (cityKey). Format/wersja NIE są tu zależnościami - filtrujemy je
    // po stronie klienta na już pobranym zbiorze, więc przełączanie nie wymaga nowego zapytania.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, movie.id, cityKey]);

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

  // Opcje filtrów bierzemy z SEANSÓW TEGO FILMU, a nie z globalnej listy wartości w bazie - dzięki
  // temu przy filmie granym wyłącznie z dubbingiem nie pokaże się martwa opcja "napisy".
  const availableFormats = [...new Set(screenings.map((s) => s.format).filter(Boolean))].sort() as string[];
  const availableLangs = [...new Set(screenings.map((s) => s.lang).filter(Boolean))].sort() as string[];

  // Pusty wybór = bez zawężenia (jak w pozostałych multi-selectach w aplikacji).
  const visibleScreenings = screenings.filter(
    (s) =>
      (pickedFormats.length === 0 || (s.format !== null && pickedFormats.includes(s.format))) &&
      (pickedLangs.length === 0 || (s.lang !== null && pickedLangs.includes(s.lang))),
  );

  const toggleIn = (list: string[], value: string) =>
    list.includes(value) ? list.filter((x) => x !== value) : [...list, value];

  // Wyodrębnienie unikalnych dat seansów i zliczenie ich ilości (dzień w strefie kina - Europe/Warsaw)
  const screeningsPerDay = visibleScreenings.reduce((acc, s) => {
    const dateStr = toWarsawDay(s.start_time);
    acc[dateStr] = (acc[dateStr] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Zbiór sieci kin grających film danego dnia (do ikon po prawej stronie wiersza)
  const franchisesPerDay = visibleScreenings.reduce((acc, s) => {
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
  const filteredScreenings = visibleScreenings.filter(s => toWarsawDay(s.start_time) === selectedDate);
  const cinemaGroups = selectedDate ? buildCinemaGroups(filteredScreenings) : [];

  // Data POLSKIEJ premiery kinowej (konsolidowana z kin i TMDB), nie rok produkcji - ten wisi obok
  // jako chip. Formatujemy w UTC, żeby strefa nie przesunęła dnia.
  const premiere = movie.release_date
    ? new Date(`${movie.release_date}T00:00:00Z`).toLocaleDateString("pl-PL",
        { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    : null;

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
              <Image src={movie.poster} alt={movie.title} fill priority={priority} unoptimized={isUnoptimizedPoster(movie.poster)} sizes="(max-width: 640px) 30vw, (max-width: 1024px) 20vw, 180px" className="object-cover" />
            ) : (
              <div className="flex items-center justify-center w-full h-full text-slate-500 text-xs text-center p-2">Brak plakatu</div>
            )}
            
            {/* Typ wydarzenia w lewym górnym rogu - nie zabiera wysokości karty (badge'y kin siedzą
                w prawym dolnym, więc się nie zderzają). */}
            {typeLabel && (
              <span className="absolute top-1.5 left-1.5 z-10 max-w-[calc(100%-0.75rem)] truncate rounded-md bg-slate-950/85 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-200 shadow-md">
                {typeLabel}
              </span>
            )}

            {/* Ikony kin (studyjne + niezależne złączone w jedno "Inne", z deduplikacją) */}
            {posterBadges.length > 0 && (
              <div className="absolute bottom-1.5 right-1.5 sm:bottom-2 sm:right-2 flex flex-row gap-1 sm:gap-1.5 z-10">
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
      {/* Na desktopie modal ma STAŁĄ wysokość. Bez tego rósł i kurczył się razem z treścią (rozwinięcie
          opisu, wybór daty z inną liczbą seansów), a że jest wyśrodkowany przez -translate-y-1/2,
          rozjeżdżał się w obie strony naraz. Przy stałej wysokości te zmiany przewijają się wewnątrz
          kolumn zamiast ruszać ramą. min(85vh,720px) - na dużych ekranach nie robi się przesadnie wysoki.
          Mobile bez zmian: tam wysokość wynika z treści, a przewija się cała kolumna. */}
      <DialogContent onOpenAutoFocus={(e) => e.preventDefault()} className="sm:max-w-[900px] sm:h-[min(85vh,720px)] bg-slate-950 border-slate-800 text-slate-50 p-0 flex flex-col sm:flex-row gap-0 overflow-hidden">

        {/* Lewa kolumna: mały plakat o stałej szerokości + dane obok niego, a opis na pełną
            szerokość poniżej. Plakat się nie rozciąga, więc zostaje miejsce na informacje i opis. */}
        <div className="hidden sm:flex sm:flex-col w-[400px] shrink-0 min-h-0 overflow-y-auto bg-slate-900 p-5 gap-4">
          <div className="flex gap-4">
            {movie.poster ? (
              <button
                type="button"
                onClick={() => setOverlay("poster")}
                onMouseDown={(e) => e.preventDefault()}
                aria-label="Powiększ plakat"
                className="group relative w-[170px] shrink-0 aspect-[2/3] rounded-lg overflow-hidden bg-slate-800 shadow-md cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
              >
                <Image src={movie.poster} alt={movie.title} fill unoptimized={isUnoptimizedPoster(movie.poster)} sizes="170px" className="object-cover" />
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
              {movie.trailer && (
                <button
                  type="button"
                  onClick={() => setOverlay("trailer")}
                  className="inline-flex w-fit items-center gap-1.5 rounded-md bg-indigo-600 px-2.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                >
                  <Play className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                  Zwiastun
                </button>
              )}
            </div>
          </div>
          {movie.director && <InfoRow label="Reżyseria" value={movie.director} />}
          {details?.cast && <InfoRow label="Obsada" value={details.cast} />}
          {premiere && <InfoRow label="Premiera" value={premiere} />}
          {details?.synopsis && <SynopsisBlock text={details.synopsis} />}
        </div>

        {/* Prawa kolumna z treścią.
            Mobile: przewija się CAŁA kolumna (opis/oceny nie odbierają miejsca liście seansów - wcześniej
            meta było shrink-0, a seanse dostawały tylko resztę wysokości i skrolowały się w skrawku).
            Desktop (sm+): kolumna wypełnia stałą wysokość ramy, a wewnątrz przewija się lista seansów. */}
        <div className="flex-1 p-4 sm:p-6 flex flex-col min-h-[450px] sm:min-h-0 max-h-[85vh] overflow-y-auto sm:overflow-hidden">
          {/* Miniatura tylko na mobile - tam nie ma lewej kolumny, więc bez niej plakatu nie da się
              w ogóle obejrzeć. Otwiera ten sam lightbox co plakat na desktopie. */}
          <div className="mb-4 shrink-0 flex gap-3">
            {movie.poster && (
              <button
                type="button"
                onClick={() => setOverlay("poster")}
                aria-label="Powiększ plakat"
                className="sm:hidden relative w-[52px] shrink-0 self-start aspect-[2/3] rounded-md overflow-hidden bg-slate-800 cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                <Image src={movie.poster} alt="" fill unoptimized={isUnoptimizedPoster(movie.poster)} sizes="52px" className="object-cover" />
                <span className="absolute top-1 right-1 flex h-4 w-4 items-center justify-center rounded bg-slate-950/75 text-slate-100">
                  <ZoomIn className="h-2.5 w-2.5" />
                </span>
              </button>
            )}
            <DialogHeader className="min-w-0">
              <DialogTitle className="text-2xl">{movie.title}</DialogTitle>
              <DialogDescription className="text-slate-400">
                Repertuar i godziny seansów.
              </DialogDescription>
            </DialogHeader>
          </div>

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
            {movie.trailer && (
              <button
                type="button"
                onClick={() => setOverlay("trailer")}
                className="inline-flex w-fit items-center gap-1.5 rounded-md bg-indigo-600 px-2.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
              >
                <Play className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                Zwiastun
              </button>
            )}
            {movie.director && <InfoRow label="Reżyseria" value={movie.director} />}
            {details?.cast && <InfoRow label="Obsada" value={details.cast} />}
            {premiere && <InfoRow label="Premiera" value={premiere} />}
            {details?.synopsis && <SynopsisBlock text={details.synopsis} lines={3} />}
          </div>

          {/* Własny scroll TYLKO od sm - na mobile przewijaniem zajmuje się kolumna wyżej.
              Dwa zagnieżdżone obszary przewijania na telefonie dawałyby maleńkie okienko na seanse.
              scrollbar-gutter:stable rezerwuje miejsce na pasek, żeby przełączanie dat (raz lista
              dłuższa, raz krótsza) nie przesuwało treści w poziomie. */}
          {/* Filtry seansów NAD obszarem przewijania (shrink-0), żeby nie uciekały przy scrollowaniu
              listy dni. Znikają, gdy film ma tylko jedną wersję i jeden format, oraz w szczegółach
              pojedynczego seansu - tam nie ma już czego zawężać, a zabierały miejsce nad treścią. */}
          {!isLoading && !selectedScreening && screenings.length > 0 && (availableFormats.length > 1 || availableLangs.length > 1) && (
            <div className="shrink-0 mb-3 flex flex-col gap-2">
              <OptionChips
                label="Format"
                options={availableFormats}
                selected={pickedFormats}
                onToggle={(v) => setPickedFormats((prev) => toggleIn(prev, v))}
              />
              <OptionChips
                label="Wersja"
                options={availableLangs}
                selected={pickedLangs}
                onToggle={(v) => setPickedLangs((prev) => toggleIn(prev, v))}
              />
            </div>
          )}

          <div className="flex flex-col gap-4 pr-2 sm:overflow-y-auto sm:flex-1 sm:min-h-0 sm:[scrollbar-gutter:stable]">
            {isLoading ? (
              <div className="text-sm text-slate-400 text-center py-8 animate-pulse">Szukam seansów...</div>
            ) : screenings.length === 0 ? (
              <div className="text-sm text-slate-400 text-center py-8">
                Brak zaplanowanych seansów dla tego filmu w naszej bazie.
              </div>
            ) : visibleScreenings.length === 0 ? (
              /* Odróżniamy "film nie ma seansów" od "filtry nic nie przepuściły" - w drugim przypadku
                 użytkownik musi wiedzieć, że wystarczy poluzować własny wybór. */
              <div className="text-sm text-slate-400 text-center py-8">
                Żaden seans nie pasuje do wybranego formatu i wersji.
                <button
                  type="button"
                  onClick={() => { setPickedFormats([]); setPickedLangs([]); }}
                  className="mt-2 block mx-auto text-indigo-400 hover:text-indigo-300"
                >
                  Wyczyść filtry seansów
                </button>
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
                hall={halls.get(hallKey(selectedScreening.cinema_id, selectedScreening.room_name))}
                dateLabel={formatDateLabel(selectedDate)}
                filmLength={movie.length}
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
    <Dialog open={overlay !== null} onOpenChange={(o) => !o && setOverlay(null)}>
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        onClick={() => setOverlay(null)}
        className="inset-0 top-0 left-0 h-full w-full max-w-none sm:max-w-none translate-x-0 translate-y-0 flex items-center justify-center rounded-none bg-black/90 p-6 ring-0 sm:p-10 cursor-zoom-out"
      >
        <DialogTitle className="sr-only">
          {overlay === "trailer" ? "Zwiastun" : "Plakat"}: {movie.title}
        </DialogTitle>
        <button
          type="button"
          aria-label="Zamknij"
          onClick={() => setOverlay(null)}
          className="absolute top-4 right-4 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white/90 hover:bg-white/20 hover:text-white transition cursor-pointer"
        >
          <X className="h-5 w-5" />
        </button>
        {/* `fill`, nie width/height: przy `w-auto` rozmiar brałby się z naturalnej szerokości pliku,
            a `srcset` + `sizes` każe przeglądarce traktować go jak obraz wysokiej gęstości - plakat
            wychodził przez to ułamek ekranu. Kontener decyduje o rozmiarze, `object-contain` o proporcjach. */}
        {overlay === "trailer" && movie.trailer && (
          // stopPropagation: klik w odtwarzacz nie może zamykać okna (tło ma cursor-zoom-out).
          <div className="w-full max-w-4xl cursor-default" onClick={(e) => e.stopPropagation()}>
            <TrailerEmbed youtubeId={movie.trailer} title={movie.title} />
          </div>
        )}
        {overlay === "poster" && movie.poster && (
          <div className="relative h-full w-full">
          <Image
            src={movie.poster}
            alt={movie.title}
            fill
            unoptimized={isUnoptimizedPoster(movie.poster)}
            sizes="90vw"
            className="object-contain drop-shadow-2xl"
          />
          </div>
        )}
      </DialogContent>
    </Dialog>
    </>
  );
}
