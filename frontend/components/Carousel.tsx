"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

// Ile karuzela przewija się na jedno kliknięcie strzałki (ułamek szerokości widoku).
// Ta sama wartość steruje strzałkami i wskaźnikami, więc są spójne.
const STEP = 0.7;

// Pozioma karuzela: ukryty natywny suwak, strzałki (desktop), gradientowe krawędzie oraz
// wskaźniki pod spodem (klikalne). Liczba wskaźników = liczba kliknięć do końca + 1,
// dzięki czemu pojawiają się nawet przy krótkim przewinięciu (mniej niż pełna szerokość).
export default function Carousel({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);
  const [pages, setPages] = useState(1);
  const [active, setActive] = useState(0);

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 8);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 8);
    const step = el.clientWidth * STEP;
    const maxScroll = el.scrollWidth - el.clientWidth;
    const clicks = step > 0 && maxScroll > 8 ? Math.ceil(maxScroll / step) : 0;
    setPages(clicks + 1);
    setActive(maxScroll > 0 ? Math.round((el.scrollLeft / maxScroll) * clicks) : 0);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    // ResizeObserver łapie zmiany rozmiaru kontenera, których nie zgłasza window.resize
    // (przebudowa layoutu, pojawienie się paska strony) - inaczej pomiar zostaje nieaktualny.
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      ro.disconnect();
    };
  }, [update]);

  // Przelicz też po każdej zmianie zawartości (filtrowanie zmienia liczbę kart, a więc scrollWidth,
  // bez zmiany rozmiaru samego kontenera - inaczej pasek/strzałki zostają z nieaktualnym stanem).
  useEffect(() => {
    update();
  }, [update, children]);

  const scroll = (dir: number) => {
    ref.current?.scrollBy({ left: dir * ref.current.clientWidth * STEP, behavior: "smooth" });
  };
  const goToPage = (i: number) => {
    const el = ref.current;
    if (el) el.scrollTo({ left: Math.min(i * el.clientWidth * STEP, el.scrollWidth - el.clientWidth), behavior: "smooth" });
  };

  const arrowBase =
    "hidden sm:flex absolute top-[38%] -translate-y-1/2 z-20 h-10 w-10 items-center justify-center " +
    "rounded-full bg-slate-950/80 backdrop-blur border border-slate-600/80 text-slate-100 shadow-lg " +
    "hover:bg-slate-800 hover:scale-110 hover:border-slate-500 transition-all duration-200 " +
    "disabled:opacity-0 disabled:pointer-events-none";
  const fadeBase = "hidden sm:block pointer-events-none absolute inset-y-0 z-10 w-16 transition-opacity duration-200";

  return (
    <div>
      <div className="group relative">
        <div
          ref={ref}
          className="flex gap-5 overflow-x-auto pb-3 snap-x scroll-smooth -mx-4 px-4 sm:mx-0 sm:px-0 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
        >
          {children}
        </div>

        <div className={`${fadeBase} left-0 bg-gradient-to-r from-slate-950 to-transparent ${canLeft ? "opacity-100" : "opacity-0"}`} />
        <div className={`${fadeBase} right-0 bg-gradient-to-l from-slate-950 to-transparent ${canRight ? "opacity-100" : "opacity-0"}`} />

        <button
          type="button"
          aria-label="Przewiń w lewo"
          onClick={() => scroll(-1)}
          disabled={!canLeft}
          className={`${arrowBase} left-0`}
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <button
          type="button"
          aria-label="Przewiń w prawo"
          onClick={() => scroll(1)}
          disabled={!canRight}
          className={`${arrowBase} right-0`}
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>

      {/* Wskaźniki stron (paski) - widoczne, gdy jest więcej niż jedna strona */}
      {pages > 1 && (
        <div className="flex justify-center items-center gap-1.5 mt-2 pb-2">
          {Array.from({ length: pages }).map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Strona ${i + 1} z ${pages}`}
              onClick={() => goToPage(i)}
              className={`h-1.5 rounded-full transition-all duration-200 ${
                i === active ? "w-6 bg-slate-300" : "w-2 bg-slate-700 hover:bg-slate-500"
              }`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
