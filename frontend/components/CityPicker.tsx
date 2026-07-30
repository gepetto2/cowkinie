"use client";

import { useRouter } from "next/navigation";
import { MapPin, Globe2 } from "lucide-react";
import { CITY_COOKIE, cityScopeHref, scopeToCookie } from "@/lib/cities";

// Ciasteczko, a nie localStorage: serwer odczytuje je przy wejściu na "/" i od razu przekierowuje
// do właściwego miasta. Przy localStorage decyzja zapadałaby dopiero w przeglądarce, więc powracający
// zobaczyliby mignięcie tego ekranu przed przeskoczeniem dalej.
const ONE_YEAR = 60 * 60 * 24 * 365;

function remember(selected: string[]) {
  document.cookie = `${CITY_COOKIE}=${encodeURIComponent(scopeToCookie(selected))}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
}

function cinemaCount(n: number) {
  if (n === 1) return "1 kino";
  const d = n % 10;
  const dd = n % 100;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return `${n} kina`;
  return `${n} kin`;
}

export default function CityPicker({
  cities,
  counts,
}: {
  cities: string[];
  counts: Record<string, number>;
}) {
  const router = useRouter();

  const go = (selected: string[]) => {
    remember(selected);
    router.push(cityScopeHref(selected));
  };

  // Miasta z największą liczbą kin na górze - trafiają w najczęstszy wybór bez czytania całej listy.
  const ordered = [...cities].sort(
    (a, b) => (counts[b] ?? 0) - (counts[a] ?? 0) || a.localeCompare(b, "pl"),
  );

  return (
    <main className="min-h-dvh flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-2xl">
        <h1 className="text-3xl sm:text-4xl font-extrabold text-slate-100 tracking-tight text-center">
          Wybierz domyślne miasto
        </h1>
        {/* Wprost mówimy, że to ustawienie TRWAŁE, a nie jednorazowy filtr - inaczej wybór na
            pełnym ekranie wygląda jak zwykłe pytanie „co dziś oglądasz". */}
        <p className="mt-3 text-center text-slate-400 text-sm">
          Zapamiętamy je i pokażemy przy kolejnych wizytach. Zmienisz je w każdej chwili w filtrach.
        </p>

        <div className="mt-8 grid grid-cols-2 sm:grid-cols-3 gap-3">
          {ordered.map((city) => (
            <button
              key={city}
              type="button"
              onClick={() => go([city])}
              className="group flex flex-col items-start gap-1 rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-4 text-left transition-colors hover:border-indigo-500 hover:bg-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              <span className="flex items-center gap-1.5 text-slate-100 font-semibold">
                <MapPin className="h-4 w-4 text-indigo-400" />
                {city}
              </span>
              <span className="text-xs text-slate-500">{cinemaCount(counts[city] ?? 0)}</span>
            </button>
          ))}
        </div>

        {/* Wybór drugorzędny: rzadko ktoś szuka seansów w całej Polsce naraz, ale musi istnieć
            droga do przeglądania wszystkiego - prowadzi na adres główny "/". */}
        <button
          type="button"
          onClick={() => go([])}
          className="mt-4 w-full flex items-center justify-center gap-2 rounded-xl border border-slate-800/80 px-4 py-3 text-sm text-slate-400 transition-colors hover:border-slate-700 hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          <Globe2 className="h-4 w-4" />
          Pokaż wszystkie miasta
        </button>
      </div>
    </main>
  );
}
