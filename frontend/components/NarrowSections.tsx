"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import MovieCard from "@/components/MovieCard";
import { MovieListItem } from "@/lib/supabase/queries";

type Movie = MovieListItem & { available_cities?: string[]; available_franchises?: string[] };
type Section = { category: string; movies: Movie[] };

// Krótkie sekcje (mało filmów) pakujemy w rzędy jak bin-packing. Optymalne ułożenie zależy od
// REALNEJ szerokości kontenera (ile kart mieści się w rzędzie), której serwer nie zna - dlatego
// mierzymy ją w przeglądarce, liczymy First-Fit-Decreasing dla zmierzonej pojemności i renderujemy
// dokładne rzędy. Przeliczamy przy każdej zmianie rozmiaru (ResizeObserver) - działa na każdej
// rozdzielczości, w przeciwieństwie do zaszytej na sztywno pojemności.
export default function NarrowSections({ sections, priorityIds }: { sections: Section[]; priorityIds: string[] }) {
  const prio = new Set(priorityIds);
  const containerRef = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<number[][] | null>(null);
  // Sygnatura zawartości - zmiana (np. po filtrowaniu) wymusza ponowny pomiar i przeliczenie.
  const sig = sections.map((s) => `${s.category}:${s.movies.length}`).join("|");

  // Gdy zawartość się zmieni (filtrowanie), stare `rows` mają indeksy dla poprzedniej listy sekcji
  // (mogą być poza zakresem nowej). Resetujemy do null JESZCZE w renderze, żeby nie renderować
  // nieistniejących sekcji - efekt zaraz przeliczy pakowanie dla nowej zawartości.
  const prevSig = useRef(sig);
  if (prevSig.current !== sig) {
    prevSig.current = sig;
    if (rows !== null) setRows(null);
  }

  const repack = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const cw = container.clientWidth;
    if (cw <= 0) return;
    // Szerokość sekcji liczymy DETERMINISTYCZNIE (liczba filmów + rozmiar karty wg breakpointu), a nie
    // mierzymy z DOM - inaczej pomiar zależałby od aktualnego ułożenia i powstawałaby pętla (migotanie).
    const vw = window.innerWidth;
    const card = vw >= 1024 ? 180 : vw >= 640 ? 160 : 140; // w-[140px] sm:w-[160px] lg:w-[180px]
    const SECTION_GAP = 20; // gap-5 między sekcjami
    const MOVIE_GAP = 16;   // gap-4 między kartami
    const PAD = 32;         // p-4 (16 z każdej strony)
    const widths = sections.map((s) => {
      const n = s.movies.length;
      return Math.min(cw, PAD + n * card + (n - 1) * MOVIE_GAP);
    });
    // First-Fit-Decreasing: sekcje malejąco po szerokości trafiają do pierwszego rzędu, w którym się mieszczą.
    const order = widths.map((_, i) => i).sort((a, b) => widths[b] - widths[a] || a - b);
    const packed: number[][] = [];
    const used: number[] = [];
    for (const i of order) {
      let placed = false;
      for (let r = 0; r < packed.length; r++) {
        if (used[r] + SECTION_GAP + widths[i] <= cw + 1) {
          packed[r].push(i);
          used[r] += SECTION_GAP + widths[i];
          placed = true;
          break;
        }
      }
      if (!placed) {
        packed.push([i]);
        used.push(widths[i]);
      }
    }
    // Aktualizujemy tylko przy realnej zmianie ułożenia (wynik jest deterministyczny, więc pętli nie ma).
    setRows((prev) => (prev && JSON.stringify(prev) === JSON.stringify(packed) ? prev : packed));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // Pierwszy pomiar po klatce (layout ustawiony); kolejne z ResizeObserver.
    const raf = requestAnimationFrame(repack);
    const ro = new ResizeObserver(repack);
    ro.observe(container);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [repack]);

  const renderSection = (s: Section) => (
    <section
      key={s.category}
      className="w-fit max-w-full border border-slate-800 bg-slate-900/40 rounded-xl p-4 flex flex-col"
    >
      <h2 className="text-lg font-bold mb-3 text-slate-200 pl-2 border-l-4 border-indigo-500 rounded-sm">{s.category}</h2>
      <div className="flex flex-wrap gap-4">
        {s.movies.map((movie) => (
          <div key={movie.id} className="w-[140px] sm:w-[160px] lg:w-[180px] shrink-0">
            <MovieCard movie={movie} priority={prio.has(movie.id)} />
          </div>
        ))}
      </div>
    </section>
  );

  // Przed pomiarem (SSR + pierwszy render): zwykły flex-wrap w podanej kolejności (bez skoków hydratacji).
  if (!rows) {
    return (
      <div ref={containerRef} className="flex flex-wrap gap-5 items-stretch">
        {sections.map(renderSection)}
      </div>
    );
  }
  // Po pomiarze: dokładne rzędy policzone dla realnej szerokości. Każdy rząd to osobny flex (flex-wrap
  // jako zabezpieczenie przed przepełnieniem przy zaokrągleniach pomiaru).
  return (
    <div ref={containerRef} className="flex flex-col gap-5">
      {rows.map((row, ri) => (
        <div key={ri} className="flex flex-wrap gap-5 items-stretch">
          {row.map((i) => sections[i]).filter((s): s is Section => !!s).map(renderSection)}
        </div>
      ))}
    </div>
  );
}
