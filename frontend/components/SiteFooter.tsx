import Image from "next/image";

// Atrybucja TMDB jest WYMAGANA przez ich regulamin API: "You shall place the following notice
// prominently on your application". Treść i logo pochodzą wprost od nich
// (themoviedb.org/about/logos-attribution), formuła jest po angielsku, bo jest cytatem z regulaminu.
// Stopka siedzi w layoucie głównym, więc widać ją na każdej podstronie.
export default function SiteFooter() {
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
