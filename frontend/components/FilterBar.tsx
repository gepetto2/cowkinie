"use client";

import { useMemo, useState, useEffect, useRef } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import Link from "next/link";
import { Search, Calendar as CalendarIcon, MapPin, X, ChevronDown, Film, Check, SlidersHorizontal, Tag, Globe2 } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { useCityScope } from "@/components/CityScope";
import { cityScopeHref } from "@/lib/cities";

// --- Helpery dat w strefie Europe/Warsaw (spójnie z resztą aplikacji) ---
const warsawFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
});
const addDays = (base: string, n: number) =>
  warsawFmt.format(new Date(new Date(`${base}T12:00:00Z`).getTime() + n * 86400000));
const parseDay = (s: string) => (s ? new Date(`${s}T00:00:00`) : undefined);
const fmtDay = (d?: Date) =>
  d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : "";
const shortLabel = (s: string) =>
  new Date(`${s}T12:00:00Z`).toLocaleDateString("pl-PL", { day: "numeric", month: "short", timeZone: "UTC" });

const triggerCls = (active: boolean) =>
  `inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium border transition-colors shrink-0 ${
    active ? "bg-indigo-600 border-indigo-500 text-white" : "bg-slate-900 border-slate-800 text-slate-200 hover:bg-slate-800"
  }`;

function formatCount(n: number) {
  const d = n % 10;
  const dd = n % 100;
  if (n === 1) return "1 film";
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return `${n} filmy`;
  return `${n} filmów`;
}

export default function FilterBar({ cities, formats, genres, resultCount }: { cities: string[]; formats: string[]; genres: { name: string; count: number }[]; resultCount: number }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();

  const q = searchParams.get("q") || "";
  // Miasto nie jest już parametrem query - niesie je ścieżka (/poznan, "/" dla całej Polski),
  // a serwer podaje rozwiązaną listę przez kontekst.
  const { selected: selectedCities } = useCityScope();
  const from = searchParams.get("from") || "";
  const to = searchParams.get("to") || "";
  const selectedFormats = (searchParams.get("format") || "").split(",").filter(Boolean);
  const selectedGenres = (searchParams.get("genre") || "").split(",").filter(Boolean);

  const setParams = (updates: Record<string, string>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v) params.set(k, v); else params.delete(k);
    }
    // Zmiany filtrów zostają W OBRĘBIE bieżącej ścieżki. Wcześniej było tu zaszyte `/?...`, co po
    // przejściu miasta do segmentu wyrzucałoby użytkownika z /poznan na ekran wyboru miasta przy
    // każdej zmianie daty czy formatu.
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  // Zmiana zestawu miast zmienia ŚCIEŻKĘ (kanonicznie: 1 miasto -> /poznan, 0 -> "/", 2+ -> /?miasta=),
  // więc idzie osobną drogą niż pozostałe filtry.
  // ŚWIADOMIE nie dotykamy tu ciasteczka: to zawężenie bieżącego widoku, a nie zmiana ustawienia.
  // Domyślne miasto ustawia się wyłącznie na ekranie wyboru (/wybierz-miasto) - dzięki temu
  // "pooglądam, co grają w Gdańsku" nie przestawia na stałe tego, co widzisz po wejściu na stronę.
  const setCities = (next: string[]) => {
    const params = new URLSearchParams(searchParams.toString());
    router.push(cityScopeHref(next, params), { scroll: false });
  };

  const toggleCity = (c: string) =>
    setCities(selectedCities.includes(c) ? selectedCities.filter((x) => x !== c) : [...selectedCities, c]);

  // --- Wyszukiwarka (debounce 300ms) ---
  const [query, setQuery] = useState(q);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    if (query === (searchParams.get("q") || "")) return;
    const t = setTimeout(() => setParams({ q: query.trim() }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // --- Presety dat ---
  const presets = useMemo(() => {
    const t = warsawFmt.format(new Date());
    const dow = new Date(`${t}T12:00:00Z`).getUTCDay();
    let wFrom = t, wTo = t;
    if (dow !== 0) { const off = (6 - dow + 7) % 7; wFrom = addDays(t, off); wTo = addDays(wFrom, 1); }
    return [
      { key: "any", label: "Dowolna data", from: "", to: "" },
      { key: "today", label: "Dzisiaj", from: t, to: t },
      { key: "tomorrow", label: "Jutro", from: addDays(t, 1), to: addDays(t, 1) },
      { key: "weekend", label: "Ten weekend", from: wFrom, to: wTo },
      { key: "week", label: "Najbliższy tydzień", from: t, to: addDays(t, 6) },
      { key: "2weeks", label: "Najbliższe 2 tyg.", from: t, to: addDays(t, 13) },
    ];
  }, []);
  const minDate = useMemo(() => new Date(`${warsawFmt.format(new Date())}T00:00:00`), []);

  const activePreset = presets.find((p) => p.from === from && p.to === to);
  const dateLabel = activePreset
    ? activePreset.label
    : from || to ? `${shortLabel(from || to)} – ${shortLabel(to || from)}` : "Dowolna data";

  const [dateOpen, setDateOpen] = useState(false);
  const [range, setRange] = useState<DateRange | undefined>(undefined);
  const openDate = (o: boolean) => {
    setDateOpen(o);
    if (o) setRange(from || to ? { from: parseDay(from || to), to: parseDay(to || from) } : undefined);
  };
  const applyRange = () => {
    if (range?.from) setParams({ from: fmtDay(range.from), to: fmtDay(range.to ?? range.from) });
    setDateOpen(false);
  };

  const [cityOpen, setCityOpen] = useState(false);
  const [formatOpen, setFormatOpen] = useState(false);
  const [genreOpen, setGenreOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false); // zwijanie filtrów na telefonie
  const activeFilterCount = (from || to ? 1 : 0) + selectedCities.length + selectedFormats.length + selectedGenres.length;

  const cityLabel = selectedCities.length === 0 ? "Wszystkie miasta"
    : selectedCities.length === 1 ? selectedCities[0] : `Miasta (${selectedCities.length})`;

  // Przełączenie w multi-select (dropdown zostaje otwarty)
  const toggleFormat = (f: string) => {
    const next = selectedFormats.includes(f) ? selectedFormats.filter((x) => x !== f) : [...selectedFormats, f];
    setParams({ format: next.join(",") });
  };
  const formatLabel = selectedFormats.length === 0 ? "Każdy format"
    : selectedFormats.length === 1 ? selectedFormats[0] : `Formaty (${selectedFormats.length})`;
  const toggleGenre = (g: string) => {
    const next = selectedGenres.includes(g) ? selectedGenres.filter((x) => x !== g) : [...selectedGenres, g];
    setParams({ genre: next.join(",") });
  };
  const genreLabel = selectedGenres.length === 0 ? "Gatunek"
    : selectedGenres.length === 1 ? selectedGenres[0] : `Gatunki (${selectedGenres.length})`;

  // --- Aktywne filtry (pigułki) ---
  const pills: { label: string; clear: () => void }[] = [];
  if (q) pills.push({ label: `„${q}”`, clear: () => { setQuery(""); setParams({ q: "" }); } });
  if (from || to) pills.push({ label: dateLabel, clear: () => setParams({ from: "", to: "" }) });
  // Każde miasto osobną pigułką - przy kilku wybranych da się odjąć jedno bez czyszczenia reszty.
  for (const c of selectedCities) {
    pills.push({ label: c, clear: () => setCities(selectedCities.filter((x) => x !== c)) });
  }
  for (const f of selectedFormats) {
    pills.push({ label: f, clear: () => setParams({ format: selectedFormats.filter((x) => x !== f).join(",") }) });
  }
  for (const g of selectedGenres) {
    pills.push({ label: g, clear: () => setParams({ genre: selectedGenres.filter((x) => x !== g).join(",") }) });
  }

  return (
    <div className="sticky top-0 z-30 -mx-4 px-4 py-3 mb-6 bg-slate-950/85 backdrop-blur border-b border-slate-800/70">
      <div className="flex flex-wrap items-center gap-2">
        {/* Wyszukiwarka */}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Szukaj: tytuł, reżyser, aktor..."
            className="w-full bg-slate-900 border border-slate-800 text-slate-100 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 placeholder:text-slate-500"
          />
        </div>

        {/* Przełącznik filtrów - tylko na telefonie */}
        <button
          type="button"
          onClick={() => setFiltersOpen((o) => !o)}
          className={`sm:hidden ${triggerCls(activeFilterCount > 0)}`}
        >
          <SlidersHorizontal className="h-4 w-4" />
          <span>Filtry{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}</span>
          <ChevronDown className={`h-3.5 w-3.5 opacity-60 transition-transform ${filtersOpen ? "rotate-180" : ""}`} />
        </button>

        {/* Filtry: zwijane na telefonie, w rzędzie na desktopie */}
        <div className={`${filtersOpen ? "flex" : "hidden"} sm:flex w-full sm:w-auto flex-wrap items-center gap-2`}>
        {/* Kiedy? */}
        <Popover open={dateOpen} onOpenChange={openDate}>
          <PopoverTrigger asChild>
            <button className={triggerCls(Boolean(from || to))}>
              <CalendarIcon className="h-4 w-4" />
              <span className="max-w-[160px] truncate">{dateLabel}</span>
              <ChevronDown className="h-3.5 w-3.5 opacity-60" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto">
            <div className="flex flex-col gap-1 p-3 border-b border-slate-800">
              {presets.map((p) => (
                <button
                  key={p.key}
                  onClick={() => { setParams({ from: p.from, to: p.to }); setDateOpen(false); }}
                  className={`text-left text-sm px-3 py-1.5 rounded-md transition-colors ${
                    p.from === from && p.to === to ? "bg-rose-600 text-white" : "text-slate-200 hover:bg-slate-800"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <Calendar mode="range" selected={range} onSelect={setRange} disabled={{ before: minDate }} numberOfMonths={1} />
            <div className="flex items-center justify-between gap-2 p-3 border-t border-slate-800">
              <button
                onClick={() => { setParams({ from: "", to: "" }); setDateOpen(false); }}
                className="text-sm text-slate-400 hover:text-slate-200 transition-colors"
              >
                Wyczyść
              </button>
              <button
                onClick={applyRange}
                disabled={!range?.from}
                className="rounded-lg bg-rose-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-rose-500 transition-colors disabled:opacity-40"
              >
                Zastosuj
              </button>
            </div>
          </PopoverContent>
        </Popover>

        {/* Miasto - wybór wielokrotny. Popover zostaje otwarty przy zaznaczaniu, żeby dało się
            zebrać kilka miast (np. Trójmiasto) bez otwierania listy za każdym razem. */}
        <Popover open={cityOpen} onOpenChange={setCityOpen}>
          <PopoverTrigger asChild>
            <button className={triggerCls(selectedCities.length > 0)}>
              <MapPin className="h-4 w-4" />
              <span className="max-w-[160px] truncate">{cityLabel}</span>
              <ChevronDown className="h-3.5 w-3.5 opacity-60" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-52 p-2">
            {/* Ten sam wzorzec co przy formacie/wersji/gatunku - kwadracik z ptaszkiem od razu
                pokazuje, że wyborów może być kilka. */}
            {cities.map((c) => {
              const on = selectedCities.includes(c);
              return (
                <button
                  key={c}
                  onClick={() => toggleCity(c)}
                  className="w-full flex items-center gap-2.5 text-left text-sm px-2.5 py-1.5 rounded-md text-slate-200 hover:bg-slate-800 transition-colors"
                >
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                    on ? "bg-indigo-600 border-indigo-500" : "border-slate-600"
                  }`}>
                    {on && <Check className="h-3 w-3 text-white" />}
                  </span>
                  {c}
                </button>
              );
            })}
            {selectedCities.length > 0 && (
              <button
                onClick={() => { setCities([]); setCityOpen(false); }}
                className="mt-1 w-full text-left text-sm px-2.5 py-1.5 rounded-md text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors border-t border-slate-800"
              >
                Wszystkie miasta
              </button>
            )}
            {/* Jedyne miejsce, w którym zmienia się ustawienie na stałe. Prowadzi do
                /wybierz-miasto, a nie do "/", bo "/" ma ciasteczko i odesłałoby z powrotem tutaj. */}
            <Link
              href="/wybierz-miasto"
              className="mt-1 w-full flex items-center gap-2 text-sm px-2.5 py-1.5 rounded-md text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors border-t border-slate-800"
            >
              <Globe2 className="h-3.5 w-3.5" />
              Zmień domyślne miasto
            </Link>
          </PopoverContent>
        </Popover>

        {/* Format (multi-select) */}
        {formats.length > 0 && (
        <Popover open={formatOpen} onOpenChange={setFormatOpen}>
          <PopoverTrigger asChild>
            <button className={triggerCls(selectedFormats.length > 0)}>
              <Film className="h-4 w-4" />
              <span className="max-w-[120px] truncate">{formatLabel}</span>
              <ChevronDown className="h-3.5 w-3.5 opacity-60" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-48 p-2">
            {formats.map((f) => {
              const on = selectedFormats.includes(f);
              return (
                <button
                  key={f}
                  onClick={() => toggleFormat(f)}
                  className="w-full flex items-center gap-2.5 text-left text-sm px-2.5 py-1.5 rounded-md text-slate-200 hover:bg-slate-800 transition-colors"
                >
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                    on ? "bg-indigo-600 border-indigo-500" : "border-slate-600"
                  }`}>
                    {on && <Check className="h-3 w-3 text-white" />}
                  </span>
                  {f}
                </button>
              );
            })}
            {selectedFormats.length > 0 && (
              <button
                onClick={() => { setParams({ format: "" }); setFormatOpen(false); }}
                className="mt-1 w-full text-left text-sm px-2.5 py-1.5 rounded-md text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors border-t border-slate-800"
              >
                Wyczyść
              </button>
            )}
          </PopoverContent>
        </Popover>
        )}

        {/* Gatunek (multi-select) */}
        {genres.length > 0 && (
        <Popover open={genreOpen} onOpenChange={setGenreOpen}>
          <PopoverTrigger asChild>
            <button className={triggerCls(selectedGenres.length > 0)}>
              <Tag className="h-4 w-4" />
              <span className="max-w-[130px] truncate">{genreLabel}</span>
              <ChevronDown className="h-3.5 w-3.5 opacity-60" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-52 p-2 max-h-80 overflow-y-auto">
            {genres.map(({ name, count }) => {
              const on = selectedGenres.includes(name);
              return (
                <button
                  key={name}
                  onClick={() => toggleGenre(name)}
                  className="w-full flex items-center gap-2.5 text-left text-sm px-2.5 py-1.5 rounded-md text-slate-200 hover:bg-slate-800 transition-colors"
                >
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                    on ? "bg-indigo-600 border-indigo-500" : "border-slate-600"
                  }`}>
                    {on && <Check className="h-3 w-3 text-white" />}
                  </span>
                  <span className="flex-1 truncate">{name}</span>
                  <span className="shrink-0 text-xs text-slate-500 tabular-nums">{count}</span>
                </button>
              );
            })}
            {selectedGenres.length > 0 && (
              <button
                onClick={() => { setParams({ genre: "" }); setGenreOpen(false); }}
                className="mt-1 w-full text-left text-sm px-2.5 py-1.5 rounded-md text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors border-t border-slate-800"
              >
                Wyczyść
              </button>
            )}
          </PopoverContent>
        </Popover>
        )}
        </div>

        {/* Licznik wyników (na telefonie chowamy, by nie zabierał miejsca) */}
        <span className="hidden sm:block text-sm text-slate-400 ml-auto shrink-0 tabular-nums">{formatCount(resultCount)}</span>
      </div>

      {/* Aktywne filtry */}
      {pills.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mt-2">
          {pills.map((p, i) => (
            <button
              key={i}
              onClick={p.clear}
              className="inline-flex items-center gap-1.5 text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-full pl-3.5 pr-2.5 py-1.5 transition-colors"
            >
              <span className="max-w-[220px] truncate">{p.label}</span>
              <X className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
