"use client";

import { useMemo, useState, useEffect, useRef } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import Link from "next/link";
import { Search, Calendar as CalendarIcon, MapPin, Building2, X, Plus, ChevronDown, Film, Check, SlidersHorizontal, Tag, Globe2 } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { useCityScope } from "@/components/CityScope";
import { citySlug, cityScopeHref } from "@/lib/cities";
import { cinemaLabel, cinemaVenue, groupCinemasByChain } from "@/lib/cinemas";
import type { CinemaListItem } from "@/lib/supabase/queries";

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

// Wiersz miasta to DWA osobne przyciski, więc każdy podświetla się z osobna - wspólny hover
// na całym wierszu zacierałby to, że są to różne akcje. Kreska między nimi jest zawsze (na dotyku
// nie ma hovera, a to jedyna wskazówka o podziale) i mocnieje, gdy kursor wejdzie w wiersz.
const cityRowCls = "group flex items-stretch rounded-md";
const cityNameCls =
  "flex-1 min-w-0 text-left text-sm px-2.5 py-1.5 text-slate-200 rounded-l-md transition-colors hover:bg-slate-800";
const cityActionCls =
  "shrink-0 flex items-center px-2.5 rounded-r-md border-l border-slate-800/80 group-hover:border-slate-700 transition-colors";

const triggerCls = (active: boolean) =>
  `inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium border transition-colors shrink-0 ${
    active ? "bg-indigo-600 border-indigo-500 text-white" : "bg-slate-900 border-slate-800 text-slate-200 hover:bg-slate-800"
  }`;

/** Kina z zadanego zakresu miast. Pusty zakres = cała Polska, czyli wszystkie. */
const cinemasInScope = (list: CinemaListItem[], scope: string[]) =>
  scope.length ? list.filter((c) => scope.includes(c.city)) : list;

function formatCount(n: number) {
  const d = n % 10;
  const dd = n % 100;
  if (n === 1) return "1 film";
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return `${n} filmy`;
  return `${n} filmów`;
}

export default function FilterBar({ cities, cinemas, formats, genres, resultCount }: { cities: string[]; cinemas: CinemaListItem[]; formats: string[]; genres: { name: string; count: number }[]; resultCount: number }) {
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
  // Sieć przeżywa zmianę miasta, konkretne kino nie - patrz setCities.
  const selectedFranchises = (searchParams.get("siec") || "").split(",").filter(Boolean);
  const selectedCinemaIds = (searchParams.get("kino") || "").split(",").filter(Boolean);

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
    // Wybór KONKRETNEGO kina jest związany z miastem, więc przy zmianie zakresu przycinamy go do
    // kin, które w nim zostały - inaczej filtr zostawałby aktywny bez ani jednego pasującego seansu
    // i wyglądałoby to na pustą bazę. Sieci (?siec=) nie ruszamy: są niezależne od miasta.
    if (selectedCinemaIds.length) {
      const allowed = new Set(cinemasInScope(cinemas, next).map((c) => c.id));
      const kept = selectedCinemaIds.filter((id) => allowed.has(id));
      if (kept.length) params.set("kino", kept.join(",")); else params.delete("kino");
    }
    router.push(cityScopeHref(next, params), { scroll: false });
  };

  // Miasto ma DWIE intencje: "zamiast" (częsta) i "dodatkowo" (rzadka), więc dostaje dwa cele
  // kliknięcia zamiast jednego toggle'a. Przełączenie zamyka listę - wybór jest kompletny;
  // dodawanie zostawia ją otwartą, bo zwykle idzie seriami (Trójmiasto, aglomeracja).
  const switchCity = (c: string) => { setCities([c]); openCity(false); };
  const addCity = (c: string) => setCities([...selectedCities, c]);
  const removeCity = (c: string) => setCities(selectedCities.filter((x) => x !== c));

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
  const [cityQuery, setCityQuery] = useState("");
  // Zapytanie czyścimy przy zamknięciu - po ponownym otwarciu lista ma być pełna, a nie zawężona
  // tym, czego szukało się ostatnim razem.
  const openCity = (o: boolean) => {
    setCityOpen(o);
    if (!o) setCityQuery("");
  };
  // Do wyboru zostają miasta niezaznaczone (zaznaczone są przypięte nad listą), zawężone zapytaniem.
  const cityMatches = useMemo(() => {
    const q = citySlug(cityQuery);
    const hits = cities.filter((c) => !selectedCities.includes(c) && (!q || citySlug(c).includes(q)));
    // Trafienia od POCZĄTKU nazwy pierwsze: przy "lodz" najpierw Łódź, potem Kłodzko.
    return q
      ? hits.sort((a, b) => Number(!citySlug(a).startsWith(q)) - Number(!citySlug(b).startsWith(q))
          || a.localeCompare(b, "pl"))
      : hits;
  }, [cities, cityQuery, selectedCities]);
  const [formatOpen, setFormatOpen] = useState(false);
  const [genreOpen, setGenreOpen] = useState(false);
  const [venueOpen, setVenueOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false); // zwijanie filtrów na telefonie
  const activeFilterCount = (from || to ? 1 : 0) + selectedCities.length + selectedFormats.length
    + selectedGenres.length + selectedFranchises.length + selectedCinemaIds.length;

  const cityLabel = selectedCities.length === 0 ? "Wszystkie miasta"
    : selectedCities.length === 1 ? selectedCities[0] : `Miasta (${selectedCities.length})`;

  // --- Kina: sieci i pojedyncze kina z bieżącego zakresu miast ---
  const scopedCinemas = useMemo(() => cinemasInScope(cinemas, selectedCities), [cinemas, selectedCities]);
  const cinemaGroups = useMemo(() => groupCinemasByChain(scopedCinemas), [scopedCinemas]);
  const cinemaById = useMemo(() => new Map(cinemas.map((c) => [c.id, c])), [cinemas]);

  const toggleFranchise = (f: string) => {
    const next = selectedFranchises.includes(f) ? selectedFranchises.filter((x) => x !== f) : [...selectedFranchises, f];
    setParams({ siec: next.join(",") });
  };
  const toggleCinema = (id: string) => {
    const next = selectedCinemaIds.includes(id) ? selectedCinemaIds.filter((x) => x !== id) : [...selectedCinemaIds, id];
    setParams({ kino: next.join(",") });
  };

  const venueCount = selectedFranchises.length + selectedCinemaIds.length;
  const venueLabel = venueCount === 0 ? "Wszystkie kina"
    : venueCount > 1 ? `Kina (${venueCount})`
    : selectedFranchises[0] ?? cinemaLabel(cinemaById.get(selectedCinemaIds[0]));

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
  const pills: { label: string; icon?: boolean; clear: () => void }[] = [];
  if (q) pills.push({ label: `„${q}”`, clear: () => { setQuery(""); setParams({ q: "" }); } });
  if (from || to) pills.push({ label: dateLabel, clear: () => setParams({ from: "", to: "" }) });
  // Każde miasto osobną pigułką - przy kilku wybranych da się odjąć jedno bez czyszczenia reszty.
  // Pinezka odróżnia je od pigułek formatu i gatunku, które inaczej wyglądają identycznie.
  for (const c of selectedCities) {
    pills.push({ label: c, icon: true, clear: () => removeCity(c) });
  }
  for (const f of selectedFranchises) {
    pills.push({ label: f, clear: () => toggleFranchise(f) });
  }
  // Kino z INNEGO miasta niż bieżące nie może się tu pojawić - setCities przycina wybór przy zmianie
  // zakresu - ale gdyby ktoś wkleił adres z nieznanym id, pigułka i tak pozwoli je zdjąć.
  for (const id of selectedCinemaIds) {
    pills.push({ label: cinemaLabel(cinemaById.get(id)), clear: () => toggleCinema(id) });
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

        {/* Miasto - klik w nazwę przełącza, przycisk obok dodaje do wyboru. Odwrotnie niż przy
            pozostałych filtrach, bo miasto prawie zawsze jest jedno i zwykle się je ZMIENIA. */}
        <Popover open={cityOpen} onOpenChange={openCity}>
          <PopoverTrigger asChild>
            <button className={triggerCls(selectedCities.length > 0)}>
              <MapPin className="h-4 w-4" />
              <span className="max-w-[160px] truncate">{cityLabel}</span>
              <ChevronDown className="h-3.5 w-3.5 opacity-60" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-60 p-2">
            {/* Wyszukiwarka: przy kilkudziesięciu miastach przewijanie listy przestaje mieć sens.
                Dopasowanie przez citySlug znosi diakrytyki i zrównuje spacje z myślnikami. */}
            {/* Enter przełącza na pierwsze trafienie - tak samo jak na ekranie /wybierz-miasto. */}
            <form
              onSubmit={(e) => { e.preventDefault(); if (cityMatches.length) switchCity(cityMatches[0]); }}
              className="flex items-center gap-2 rounded-md border border-slate-700 px-2 py-1.5 mb-2 focus-within:border-indigo-500 transition-colors"
            >
              <Search className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden="true" />
              <input
                value={cityQuery}
                onChange={(e) => setCityQuery(e.target.value)}
                placeholder="Szukaj…"
                aria-label="Szukaj miasta"
                className="w-full bg-transparent text-sm text-slate-100 placeholder:text-slate-500 outline-none"
              />
            </form>

            {/* Zaznaczone na górze, poza listą przewijaną - inaczej przy 77 miastach usunięcie
                jednego wymagałoby odszukania go w całej liście. */}
            {selectedCities.map((c) => (
              <div key={c} className={`${cityRowCls} bg-indigo-500/10`}>
                <button onClick={() => switchCity(c)} className={cityNameCls} title="Pokaż tylko to miasto">
                  <span className="truncate">{c}</span>
                </button>
                <button
                  onClick={() => removeCity(c)}
                  aria-label={`Usuń ${c} z wyboru`}
                  title="Usuń z wyboru"
                  className={`${cityActionCls} text-slate-400 hover:bg-rose-500/15 hover:text-rose-300`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {selectedCities.length > 0 && <div className="my-1.5 border-t border-slate-800" />}

            <div className="max-h-56 overflow-y-auto">
              {cityMatches.length === 0 && (
                <p className="px-2.5 py-2 text-sm text-slate-500">Brak miasta.</p>
              )}
              {cityMatches.map((c) => (
                <div key={c} className={cityRowCls}>
                  <button onClick={() => switchCity(c)} className={cityNameCls} title={`Pokaż tylko ${c}`}>
                    <span className="truncate">{c}</span>
                  </button>
                  <button
                    onClick={() => addCity(c)}
                    aria-label={`Dodaj ${c} do wyboru`}
                    title="Dodaj do wyboru"
                    className={`${cityActionCls} text-slate-500 hover:bg-indigo-500/20 hover:text-indigo-300`}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
            {selectedCities.length > 0 && (
              <button
                onClick={() => { setCities([]); openCity(false); }}
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

        {/* Kina - sieć albo konkretne kino. Ukryte, gdy w zakresie jest jedno kino: w 52 z 77 miast
            kontrolka nie miałaby czego filtrować. Nagłówek grupy zaznacza całą sieć (?siec=,
            przeżywa zmianę miasta), wiersz pod nim pojedyncze kino (?kino=, przycinane do zakresu). */}
        {scopedCinemas.length > 1 && (
        <Popover open={venueOpen} onOpenChange={setVenueOpen}>
          <PopoverTrigger asChild>
            <button className={triggerCls(venueCount > 0)}>
              <Building2 className="h-4 w-4" />
              <span className="max-w-[160px] truncate">{venueLabel}</span>
              <ChevronDown className="h-3.5 w-3.5 opacity-60" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-2">
            <div className="max-h-80 overflow-y-auto">
              {cinemaGroups.map((group) => {
                const on = group.franchise !== null && selectedFranchises.includes(group.franchise);
                return (
                  <div key={group.label} className="mb-1.5 last:mb-0">
                    {/* Grupa "Inne kina" nie ma zaznaczalnego nagłówka: jej `franchise` to nazwa
                        własna pojedynczego kina, a nie sieć, więc byłby to filtr udający sieć. */}
                    {group.franchise === null ? (
                      <p className="px-2.5 py-1 text-xs uppercase tracking-wide text-slate-500">{group.label}</p>
                    ) : (
                      <button
                        onClick={() => toggleFranchise(group.franchise!)}
                        className="w-full flex items-center gap-2.5 text-left text-sm px-2.5 py-1.5 rounded-md font-medium text-slate-100 hover:bg-slate-800 transition-colors"
                      >
                        <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${on ? "bg-indigo-600 border-indigo-500" : "border-slate-600"}`}>
                          {on && <Check className="h-3 w-3 text-white" />}
                        </span>
                        <span className="truncate">{group.label}</span>
                        <span className="ml-auto shrink-0 text-xs text-slate-500 tabular-nums">{group.cinemas.length}</span>
                      </button>
                    )}
                    {/* Pojedyncze kina sieci pokazujemy tylko wtedy, gdy jest z czego wybierać -
                        przy jednym kinie powielałyby nagłówek grupy. */}
                    {(group.franchise === null || group.cinemas.length > 1) && group.cinemas.map((c) => {
                      const picked = selectedCinemaIds.includes(c.id);
                      return (
                        <button
                          key={c.id}
                          onClick={() => toggleCinema(c.id)}
                          className={`w-full flex items-center gap-2.5 text-left text-sm px-2.5 py-1.5 rounded-md hover:bg-slate-800 transition-colors ${group.franchise === null ? "" : "pl-7"} ${picked ? "text-slate-100" : "text-slate-300"}`}
                        >
                          <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${picked ? "bg-indigo-600 border-indigo-500" : "border-slate-600"}`}>
                            {picked && <Check className="h-3 w-3 text-white" />}
                          </span>
                          {/* W grupie sieci marka stoi w nagłówku, więc wiersz pokazuje sam obiekt
                              ("Kinepolis", "Bydgoszcz") - inaczej co drugie słowo to "Helios". */}
                          <span className="truncate">
                            {group.franchise === null ? cinemaLabel(c) : cinemaVenue(c)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            {venueCount > 0 && (
              <button
                onClick={() => { setParams({ siec: "", kino: "" }); setVenueOpen(false); }}
                className="mt-1 w-full text-left text-sm px-2.5 py-1.5 rounded-md text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors border-t border-slate-800"
              >
                Wszystkie kina
              </button>
            )}
          </PopoverContent>
        </Popover>
        )}

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
              className={`inline-flex items-center gap-1.5 text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-full ${p.icon ? "pl-2.5" : "pl-3.5"} pr-2.5 py-1.5 transition-colors`}
            >
              {p.icon && <MapPin className="h-3.5 w-3.5 shrink-0 text-indigo-400" />}
              <span className="max-w-[220px] truncate">{p.label}</span>
              <X className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
