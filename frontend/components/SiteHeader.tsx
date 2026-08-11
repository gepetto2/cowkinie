import Link from "next/link";
import { Clapperboard } from "lucide-react";
import { SITE_NAME } from "@/lib/site";

// Nawigacja serwisu. Bez niej podstrony były ślepymi zaułkami, a link do listy kin dzielił wiersz
// z <h1> - przy zawijanym nagłówku spadał na własną linię i czytał się jak podpis.
// Świadomie NIE w layout.tsx: /wybierz-miasto ma wymusić jedną decyzję, więc nie dostaje nawigacji.

const SECTIONS = [
  { key: "repertuar", label: "Repertuar", href: "/" },
  { key: "kina", label: "Kina", href: "/kina" },
] as const;

export default function SiteHeader({ active = "repertuar" }: { active?: "repertuar" | "kina" }) {
  return (
    <header className="border-b border-slate-800/80">
      {/* Ten sam kontener co strony pod spodem - inaczej pasek nie trzymałby z nimi pionu. */}
      <div className="container mx-auto px-3 sm:px-4 h-14 flex items-center justify-between gap-3">
        {/* "/" czyta ciasteczko i przekierowuje do zapamiętanego miasta, więc marka wraca na repertuar. */}
        <Link
          href="/"
          className="flex items-center gap-2 font-bold tracking-tight text-slate-100 hover:text-indigo-300 transition-colors"
        >
          <Clapperboard className="h-5 w-5 shrink-0 text-indigo-400" aria-hidden="true" />
          {SITE_NAME}
        </Link>

        {/* Przełącznik zamiast pojedynczego przycisku: pokazuje, że sekcje są dwie, więc lista kin
            jest odkrywalna, a stan bieżący widać bez zgadywania. Kształt celowo inny niż okrągłe
            pigułki filtrów w FilterBar - to nawigacja, nie kontrolka. */}
        <nav className="inline-flex shrink-0 rounded-lg border border-slate-800 bg-slate-900/70 p-0.5">
          {SECTIONS.map((s) => {
            const on = s.key === active;
            return (
              <Link
                key={s.key}
                href={s.href}
                aria-current={on ? "page" : undefined}
                className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                  on ? "bg-slate-700 font-semibold text-slate-100" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {s.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
