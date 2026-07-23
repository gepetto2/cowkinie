"use client";

import { useMemo, useState, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, Calendar as CalendarIcon, MapPin, X, ChevronDown, Film, Check, Languages, SlidersHorizontal } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";

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
const itemCls = (active: boolean) =>
  `w-full text-left text-sm px-3 py-1.5 rounded-md transition-colors ${
    active ? "bg-indigo-600 text-white" : "text-slate-200 hover:bg-slate-800"
  }`;

function formatCount(n: number) {
  const d = n % 10;
  const dd = n % 100;
  if (n === 1) return "1 film";
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return `${n} filmy`;
  return `${n} filmów`;
}

export default function FilterBar({ cities, formats, langs, resultCount }: { cities: string[]; formats: string[]; langs: string[]; resultCount: number }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const q = searchParams.get("q") || "";
  const city = searchParams.get("city") || "";
  const from = searchParams.get("from") || "";
  const to = searchParams.get("to") || "";
  const selectedFormats = (searchParams.get("format") || "").split(",").filter(Boolean);
  const selectedLangs = (searchParams.get("lang") || "").split(",").filter(Boolean);

  const setParams = (updates: Record<string, string>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v) params.set(k, v); else params.delete(k);
    }
    router.push(`/?${params.toString()}`, { scroll: false });
  };

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
  const [langOpen, setLangOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false); // zwijanie filtrów na telefonie
  const activeFilterCount = (from || to ? 1 : 0) + (city ? 1 : 0) + selectedFormats.length + selectedLangs.length;

  // Przełączenie w multi-select (dropdown zostaje otwarty)
  const toggleFormat = (f: string) => {
    const next = selectedFormats.includes(f) ? selectedFormats.filter((x) => x !== f) : [...selectedFormats, f];
    setParams({ format: next.join(",") });
  };
  const formatLabel = selectedFormats.length === 0 ? "Każdy format"
    : selectedFormats.length === 1 ? selectedFormats[0] : `Formaty (${selectedFormats.length})`;
  const toggleLang = (l: string) => {
    const next = selectedLangs.includes(l) ? selectedLangs.filter((x) => x !== l) : [...selectedLangs, l];
    setParams({ lang: next.join(",") });
  };
  const langLabel = selectedLangs.length === 0 ? "Wersja językowa"
    : selectedLangs.length === 1 ? selectedLangs[0] : `Wersje (${selectedLangs.length})`;

  // --- Aktywne filtry (pigułki) ---
  const pills: { label: string; clear: () => void }[] = [];
  if (q) pills.push({ label: `„${q}”`, clear: () => { setQuery(""); setParams({ q: "" }); } });
  if (from || to) pills.push({ label: dateLabel, clear: () => setParams({ from: "", to: "" }) });
  if (city) pills.push({ label: city, clear: () => setParams({ city: "" }) });
  for (const f of selectedFormats) {
    pills.push({ label: f, clear: () => setParams({ format: selectedFormats.filter((x) => x !== f).join(",") }) });
  }
  for (const l of selectedLangs) {
    pills.push({ label: l, clear: () => setParams({ lang: selectedLangs.filter((x) => x !== l).join(",") }) });
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
            placeholder="Szukaj filmu..."
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

        {/* Miasto */}
        <Popover open={cityOpen} onOpenChange={setCityOpen}>
          <PopoverTrigger asChild>
            <button className={triggerCls(Boolean(city))}>
              <MapPin className="h-4 w-4" />
              <span className="max-w-[140px] truncate">{city || "Wszystkie miasta"}</span>
              <ChevronDown className="h-3.5 w-3.5 opacity-60" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-52 p-2">
            <button onClick={() => { setParams({ city: "" }); setCityOpen(false); }} className={itemCls(!city)}>
              Wszystkie miasta
            </button>
            {cities.map((c) => (
              <button key={c} onClick={() => { setParams({ city: c }); setCityOpen(false); }} className={itemCls(c === city)}>
                {c}
              </button>
            ))}
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

        {/* Wersja językowa (multi-select) */}
        {langs.length > 0 && (
        <Popover open={langOpen} onOpenChange={setLangOpen}>
          <PopoverTrigger asChild>
            <button className={triggerCls(selectedLangs.length > 0)}>
              <Languages className="h-4 w-4" />
              <span className="max-w-[130px] truncate">{langLabel}</span>
              <ChevronDown className="h-3.5 w-3.5 opacity-60" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-48 p-2">
            {langs.map((l) => {
              const on = selectedLangs.includes(l);
              return (
                <button
                  key={l}
                  onClick={() => toggleLang(l)}
                  className="w-full flex items-center gap-2.5 text-left text-sm px-2.5 py-1.5 rounded-md text-slate-200 hover:bg-slate-800 transition-colors"
                >
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                    on ? "bg-indigo-600 border-indigo-500" : "border-slate-600"
                  }`}>
                    {on && <Check className="h-3 w-3 text-white" />}
                  </span>
                  {l}
                </button>
              );
            })}
            {selectedLangs.length > 0 && (
              <button
                onClick={() => { setParams({ lang: "" }); setLangOpen(false); }}
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
