"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { MapPin, Globe2, Search } from "lucide-react";
import { CITY_COOKIE, citySlug, cityScopeHref, scopeToCookie } from "@/lib/cities";

// Ciasteczko, a nie localStorage: serwer odczytuje je przy wejściu na "/" i od razu przekierowuje
// do właściwego miasta. Przy localStorage decyzja zapadałaby dopiero w przeglądarce, więc powracający
// zobaczyliby mignięcie tego ekranu przed przeskoczeniem dalej.
const ONE_YEAR = 60 * 60 * 24 * 365;

// Ile miast pokazujemy jako skrót. Reszta i tak jest niżej w pełnej liście - to podpowiedź,
// a nie podział zbioru, więc największe miasta występują w obu miejscach (inaczej ktoś szukający
// Warszawy alfabetycznie nie znalazłby jej pod "W").
const SHORTLIST = 6;

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
  const [query, setQuery] = useState("");

  const go = (selected: string[]) => {
    remember(selected);
    router.push(cityScopeHref(selected));
  };

  // Dopasowanie przez citySlug: znosi diakrytyki i zrównuje spacje z myślnikami, więc "lodz"
  // trafia w "Łódź", a "bielsko biala" w "Bielsko-Biała".
  const matches = useMemo(() => {
    const q = citySlug(query);
    if (!q) return [];
    // Trafienia od POCZĄTKU nazwy przed trafieniami w środku - przy "lodz" najpierw Łódź,
    // dopiero potem Kłodzko. Liczy się podwójnie, bo Enter wybiera pierwszy wynik.
    return cities
      .filter((c) => citySlug(c).includes(q))
      .sort((a, b) => Number(!citySlug(a).startsWith(q)) - Number(!citySlug(b).startsWith(q))
        || a.localeCompare(b, "pl"));
  }, [cities, query]);

  const top = useMemo(
    () => [...cities].sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0) || a.localeCompare(b, "pl")).slice(0, SHORTLIST),
    [cities, counts],
  );

  // Pełna lista alfabetycznie, pogrupowana po pierwszej literze - przy kilkudziesięciu miastach
  // litery przewodnie robią za punkty zaczepienia dla wzroku.
  const groups = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const c of [...cities].sort((a, b) => a.localeCompare(b, "pl"))) {
      const letter = c[0].toUpperCase();
      const arr = map.get(letter);
      if (arr) arr.push(c);
      else map.set(letter, [c]);
    }
    return [...map.entries()];
  }, [cities]);

  const searching = query.trim().length > 0;

  return (
    <main className="min-h-dvh flex flex-col items-center p-6">
      {/* `my-auto` zamiast `justify-center` na rodzicu: gdy lista jest wyższa niż ekran,
          wyśrodkowanie flexem ucina górę treści i nie da się do niej doscrollować. */}
      <div className="my-auto w-full max-w-2xl">
        <h1 className="text-3xl sm:text-4xl font-extrabold text-slate-100 tracking-tight text-center">
          Wybierz domyślne miasto
        </h1>
        {/* Wprost mówimy, że to ustawienie TRWAŁE, a nie jednorazowy filtr - inaczej wybór na
            pełnym ekranie wygląda jak zwykłe pytanie „co dziś oglądasz". */}
        <p className="mt-3 text-center text-slate-400 text-sm">
          Zapamiętamy je i pokażemy przy kolejnych wizytach. Zmienisz je w każdej chwili w filtrach.
        </p>

        {/* Enter wybiera pierwsze trafienie - przy znanej nazwie miasta wystarczą trzy litery. */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (matches.length) go([matches[0]]);
          }}
          className="mt-7 flex items-center gap-2.5 rounded-xl border border-slate-700 bg-slate-900/60 px-3.5 py-2.5 focus-within:border-indigo-500 transition-colors"
        >
          <Search className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Szukaj miasta…"
            aria-label="Szukaj miasta"
            className="w-full bg-transparent text-slate-100 placeholder:text-slate-500 outline-none text-sm"
          />
          <span className="shrink-0 text-xs text-slate-600">{cities.length} miast</span>
        </form>

        {searching ? (
          <div className="mt-5">
            {matches.length === 0 ? (
              <p className="text-center text-slate-500 text-sm py-8">Brak miasta pasującego do „{query}&rdquo;</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {matches.map((city) => (
                  <li key={city}>
                    <button
                      type="button"
                      onClick={() => go([city])}
                      className="w-full flex items-baseline gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-slate-800/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                    >
                      <span className="font-medium text-slate-100">{city}</span>
                      <span className="text-xs text-slate-500">{cinemaCount(counts[city] ?? 0)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <>
            <p className="mt-7 mb-2.5 text-xs uppercase tracking-wide text-slate-500">Najwięcej kin</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {top.map((city) => (
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

            {/* Długi ogon bez licznika kin: przy kilkudziesięciu miastach to szum, a nie informacja. */}
            <p className="mt-7 mb-2.5 text-xs uppercase tracking-wide text-slate-500">Wszystkie miasta</p>
            <div className="flex flex-col gap-1.5">
              {groups.map(([letter, list]) => (
                <div key={letter} className="flex items-baseline gap-3">
                  <span className="w-3 shrink-0 text-xs font-bold text-slate-600">{letter}</span>
                  <div className="flex flex-wrap gap-x-1 gap-y-0.5">
                    {list.map((city) => (
                      <button
                        key={city}
                        type="button"
                        onClick={() => go([city])}
                        className="rounded-md px-1.5 py-0.5 text-sm text-slate-300 transition-colors hover:bg-slate-800 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                      >
                        {city}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Wybór drugorzędny: rzadko ktoś szuka seansów w całej Polsce naraz, ale musi istnieć
            droga do przeglądania wszystkiego - prowadzi na adres główny "/". */}
        <button
          type="button"
          onClick={() => go([])}
          className="mt-6 w-full flex items-center justify-center gap-2 rounded-xl border border-slate-800/80 px-4 py-3 text-sm text-slate-400 transition-colors hover:border-slate-700 hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          <Globe2 className="h-4 w-4" />
          Pokaż wszystkie miasta
        </button>
      </div>
    </main>
  );
}
