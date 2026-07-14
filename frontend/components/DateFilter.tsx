"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Calendar as CalendarIcon } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";

// Data 'YYYY-MM-DD' w strefie Europe/Warsaw (spójnie z resztą aplikacji)
const warsawFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Warsaw",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const addDays = (baseStr: string, n: number) =>
  warsawFmt.format(new Date(new Date(`${baseStr}T12:00:00Z`).getTime() + n * 86400000));

// Konwersja string <-> Date dla kalendarza (kalendarz pracuje w czasie lokalnym przeglądarki)
const parseDay = (s: string) => (s ? new Date(`${s}T00:00:00`) : undefined);
const fmtDay = (d?: Date) =>
  d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : "";
const label = (s: string) =>
  new Date(`${s}T12:00:00Z`).toLocaleDateString("pl-PL", { day: "numeric", month: "short", timeZone: "UTC" });

const chipClass = (active: boolean) =>
  `px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap snap-start shrink-0 ${
    active ? "bg-rose-600 text-white shadow-md" : "bg-slate-800 hover:bg-slate-700 text-slate-200"
  }`;

export default function DateFilter() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const from = searchParams.get("from") || "";
  const to = searchParams.get("to") || "";

  const { presets, minDate } = useMemo(() => {
    const t = warsawFmt.format(new Date());
    const dow = new Date(`${t}T12:00:00Z`).getUTCDay(); // 0=niedz .. 6=sob
    let wFrom = t;
    let wTo = t;
    if (dow !== 0) {
      const off = (6 - dow + 7) % 7; // dni do najbliższej soboty
      wFrom = addDays(t, off);
      wTo = addDays(wFrom, 1);
    }
    const presets = [
      { key: "any", labelText: "Dowolna data", from: "", to: "" },
      { key: "today", labelText: "Dzisiaj", from: t, to: t },
      { key: "tomorrow", labelText: "Jutro", from: addDays(t, 1), to: addDays(t, 1) },
      { key: "weekend", labelText: "Ten weekend", from: wFrom, to: wTo },
      { key: "week", labelText: "Najbliższy tydzień", from: t, to: addDays(t, 6) },
      { key: "2weeks", labelText: "Najbliższe 2 tyg.", from: t, to: addDays(t, 13) },
    ];
    return { presets, minDate: new Date(`${t}T00:00:00`) };
  }, []);

  const activeKey = presets.find((p) => p.from === from && p.to === to)?.key;
  const customActive = !activeKey && Boolean(from || to);
  const customLabel = customActive ? `${label(from)} – ${label(to)}` : "Zakres…";

  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<DateRange | undefined>(undefined);

  const navigate = (f: string, t: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (f) params.set("from", f); else params.delete("from");
    if (t) params.set("to", t); else params.delete("to");
    router.push(`/?${params.toString()}`, { scroll: false });
  };

  const handleOpenChange = (o: boolean) => {
    setOpen(o);
    if (o) {
      setRange(from || to ? { from: parseDay(from || to), to: parseDay(to || from) } : undefined);
    }
  };

  const applyRange = () => {
    if (range?.from) {
      navigate(fmtDay(range.from), fmtDay(range.to ?? range.from));
    }
    setOpen(false);
  };

  return (
    <div>
      <h2 className="text-lg font-semibold mb-3 text-slate-300">Wybierz datę:</h2>
      <div className="flex overflow-x-auto gap-2 pb-2 snap-x" style={{ scrollbarWidth: "none" }}>
        {presets.map((p) => (
          <button key={p.key} onClick={() => navigate(p.from, p.to)} className={chipClass(activeKey === p.key)}>
            {p.labelText}
          </button>
        ))}

        <Popover open={open} onOpenChange={handleOpenChange}>
          <PopoverTrigger asChild>
            <button className={`${chipClass(customActive)} inline-flex items-center gap-1.5`}>
              <CalendarIcon className="h-3.5 w-3.5" />
              {customLabel}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="p-0">
            <Calendar
              mode="range"
              selected={range}
              onSelect={setRange}
              disabled={{ before: minDate }}
              numberOfMonths={1}
            />
            <div className="flex items-center justify-between gap-2 border-t border-slate-800 p-3">
              <button
                onClick={() => { navigate("", ""); setOpen(false); }}
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
      </div>
    </div>
  );
}
