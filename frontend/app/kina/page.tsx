import type { Metadata } from 'next';
import Link from 'next/link';
import { MapPin, ExternalLink } from 'lucide-react';
import { getCinemas, type CinemaListItem } from '@/lib/supabase/queries';
import { citySlug } from '@/lib/cities';

export const metadata: Metadata = {
  title: 'Kina',
  description: 'Wszystkie kina w serwisie - sieciowe i studyjne, z adresami i linkami do stron.',
};

// Grupujemy po mieście, a nie po sieci: użytkownik szuka kina tam, gdzie jest, a nie u konkretnej marki.
function groupByCity(cinemas: CinemaListItem[]): [string, CinemaListItem[]][] {
  const map = new Map<string, CinemaListItem[]>();
  for (const c of cinemas) {
    const arr = map.get(c.city);
    if (arr) arr.push(c);
    else map.set(c.city, [c]);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pl'));
}

export default async function CinemasPage() {
  const cinemas = await getCinemas();
  const byCity = groupByCity(cinemas);

  return (
    <main className="container mx-auto px-3 sm:px-4 pt-8 pb-16">
      <h1 className="text-4xl font-extrabold mb-2 text-slate-100 tracking-tight">Kina</h1>
      <p className="text-slate-400 mb-8">
        {cinemas.length} kin w {byCity.length} miastach.
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
              {list.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-900/40 p-4"
                >
                  <div>
                    <p className="font-semibold text-slate-100">{c.name}</p>
                    {c.franchise && c.franchise !== c.name && (
                      <p className="text-xs text-slate-500 mt-0.5">{c.franchise}</p>
                    )}
                  </div>

                  {c.address && (
                    <p className="flex items-start gap-1.5 text-sm text-slate-400">
                      <MapPin className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
                      {c.address}
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
              ))}
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
  );
}
