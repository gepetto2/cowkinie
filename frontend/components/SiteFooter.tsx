import Image from "next/image";
import { getLastScrape } from "@/lib/supabase/queries";

// Atrybucja TMDB jest WYMAGANA przez ich regulamin API: "You shall place the following notice
// prominently on your application". Treść i logo pochodzą wprost od nich
// (themoviedb.org/about/logos-attribution), formuła jest po angielsku, bo jest cytatem z regulaminu.
// Stopka siedzi w layoucie głównym, więc widać ją na każdej podstronie.
export default async function SiteFooter() {
  const lastScrape = await getLastScrape();
  return (
    <footer className="mt-auto border-t border-slate-800/70 bg-slate-950">
      <div className="container mx-auto flex flex-col gap-3 px-3 py-6 text-xs text-slate-500 sm:flex-row sm:items-center sm:gap-4 sm:px-4">
        <a
          href="https://www.themoviedb.org/"
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 transition-opacity hover:opacity-80"
        >
          {/* Logo bez zmian kolorów i proporcji - wytyczne TMDB nie pozwalają go przerabiać. */}
          <Image src="/tmdb.svg" alt="The Movie Database (TMDB)" width={92} height={12} unoptimized />
        </a>
        {/* Świeżość repertuaru to najmocniejszy sygnał zaufania w serwisie z godzinami seansów -
            użytkownik pyta przede wszystkim "czy to jeszcze aktualne". */}
        {lastScrape && (
          <p className="shrink-0 sm:order-last sm:ml-auto">
            Repertuar zaktualizowany{" "}
            <time dateTime={lastScrape} className="text-slate-400">{formatScrape(lastScrape)}</time>
          </p>
        )}
        <p className="leading-relaxed">
          This product uses the TMDB API but is not endorsed or certified by TMDB.
          <span className="mt-1 block text-slate-600">
            Dane o filmach pochodzą także z Filmwebu i OMDb, a repertuar ze stron kin.
          </span>
        </p>
      </div>
    </footer>
  );
}

// "dziś o 01:03" / "wczoraj o 01:02" / "24 sierpnia o 01:10" - w strefie kin, nie przeglądarki.
function formatScrape(iso: string) {
  const tz = "Europe/Warsaw";
  const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
  const when = new Date(iso);
  const now = new Date();
  const time = new Intl.DateTimeFormat("pl-PL", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(when);

  const diff = (Date.parse(day(now)) - Date.parse(day(when))) / 86400000;
  if (diff === 0) return `dziś o ${time}`;
  if (diff === 1) return `wczoraj o ${time}`;
  const date = new Intl.DateTimeFormat("pl-PL", { timeZone: tz, day: "numeric", month: "long" }).format(when);
  return `${date} o ${time}`;
}
