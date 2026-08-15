import type { Metadata } from 'next';
import Link from 'next/link';
import { MapPin, ExternalLink, Armchair } from 'lucide-react';
import { getCinemas, getHallStats, type CinemaListItem } from '@/lib/supabase/queries';
import { citySlug } from '@/lib/cities';
import { cinemaLabel, cinemaAddress, cinemaBadge } from '@/lib/cinemas';
import { franchiseSurface } from '@/lib/franchise';
import SiteHeader from '@/components/SiteHeader';

export const metadata: Metadata = {
  title: 'Kina',
  description: 'Wszystkie kina w serwisie - sieciowe i studyjne, z adresami i linkami do stron.',
};

// Polska odmiana po liczbie: 1 sala / 2-4 sale / 5+ sal, z wyjątkiem nastek (12-14 idą jak 5+).
function plural(n: number, one: string, few: string, many: string) {
  const d = n % 10;
  const dd = n % 100;
  if (n === 1) return `${n} ${one}`;
  return `${n} ${d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? few : many}`;
}

// Grupujemy po mieście, a nie po sieci: użytkownik szuka kina tam, gdzie jest, a nie u konkretnej marki.
function groupByCity(cinemas: CinemaListItem[]): [string, CinemaListItem[]][] {
  const map = new Map<string, CinemaListItem[]>();
  for (const c of cinemas) {
    const arr = map.get(c.city);
    if (arr) arr.push(c);
    else map.set(c.city, [c]);
  }
  // W mieście najpierw po sieci, potem po nazwie - inaczej sortowanie po surowej nazwie przeplata
  // marki ("Warszawa Blue City" wypada przed "Warszawa - Bemowo", bo spacja < myślnik).
  for (const list of map.values()) {
    list.sort(
      (a, b) =>
        (a.franchise ?? '').localeCompare(b.franchise ?? '', 'pl') ||
        cinemaLabel(a, true).localeCompare(cinemaLabel(b, true), 'pl'),
    );
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pl'));
}

export default async function CinemasPage() {
  const [cinemas, hallStats] = await Promise.all([getCinemas(), getHallStats()]);
  const byCity = groupByCity(cinemas);
  const totals = Object.values(hallStats).reduce(
    (acc, s) => ({ halls: acc.halls + s.halls, seats: acc.seats + s.seats }),
    { halls: 0, seats: 0 },
  );

  return (
    <>
    <SiteHeader active="kina" />
    <main className="container mx-auto px-3 sm:px-4 pt-6 pb-16">
      <h1 className="text-4xl font-extrabold mb-2 text-slate-100 tracking-tight">Kina</h1>
      <p className="text-slate-400 mb-8">
        {cinemas.length} kin w {byCity.length} miastach
        {/* Sale znamy tylko dla sieciówek, więc podajemy je jako osobny fakt, a nie jako sumę
            opisującą wszystkie kina z lewej strony zdania. */}
        {totals.halls > 0 && `, w tym ${plural(totals.halls, 'sala', 'sale', 'sal')} i ${plural(totals.seats, 'miejsce', 'miejsca', 'miejsc')}`}.
      </p>

      <div className="flex flex-col gap-10">
        {byCity.map(([city, list]) => (
          <section key={city}>
            <h2 className="text-2xl font-bold mb-4 text-slate-200 pl-1 border-l-4 border-indigo-500 rounded-sm">
              <Link href={`/${citySlug(city)}`} className="hover:text-indigo-300 transition-colors">
                {city}
              </Link>
            </h2>

            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((c) => {
                const address = cinemaAddress(c.address, c.city);
                // Barwa sieci niesiona przez samą kartę: lewa krawędź + poświata gasnąca w prawo.
                // Gradient ustawia background-image, więc nie gryzie się z bg-slate-900/40.
                const surface = franchiseSurface(cinemaBadge(c) ?? '');
                const stats = hallStats[c.id];
                return (
                <li
                  key={c.id}
                  className={`flex flex-col gap-2 rounded-xl border border-slate-800 border-l-4 bg-slate-900/40 bg-linear-to-r to-transparent p-4 ${surface}`}
                >
                  {/* Miasto niesie nagłówek sekcji, więc nazwa i adres są bez niego. */}
                  <p className="font-semibold text-slate-100">{cinemaLabel(c, true)}</p>

                  {/* Kina niezależne nie mają sal w bazie (brak API z mapami), więc wiersz po
                      prostu nie powstaje - lepsze niż "0 sal", które sugerowałoby zamknięte kino. */}
                  {stats && (
                    <p className="flex items-center gap-1.5 text-sm text-slate-400">
                      <Armchair className="h-4 w-4 shrink-0" aria-hidden="true" />
                      {plural(stats.halls, 'sala', 'sale', 'sal')} · {plural(stats.seats, 'miejsce', 'miejsca', 'miejsc')}
                    </p>
                  )}

                  {address && (
                    <p className="flex items-start gap-1.5 text-sm text-slate-400">
                      <MapPin className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
                      {address}
                    </p>
                  )}

                  {c.url && (
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-auto inline-flex items-center gap-1.5 self-start text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
                    >
                      Strona kina
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    </a>
                  )}
                </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      {cinemas.length === 0 && (
        <div className="text-center text-slate-400 py-16 bg-slate-900/30 rounded-xl border border-slate-800">
          Nie udało się pobrać listy kin.
        </div>
      )}
    </main>
    </>
  );
}
