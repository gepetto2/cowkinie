"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import { Search } from "lucide-react";

export default function SearchBar() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(searchParams.get("q") || "");
  const isFirstRender = useRef(true);

  useEffect(() => {
    // Pomijamy pierwsze renderowanie, aby nie nadpisywać URL bez potrzeby
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    // Ustawienie debouncingu (opóźnienia) na 300ms
    const timer = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      
      if (query.trim()) {
        params.set("q", query.trim());
      } else {
        params.delete("q");
      }
      
      router.push(`/?${params.toString()}`);
    }, 300);

    // Czyszczenie timera, jeśli użytkownik wpisze kolejny znak przed upływem 300ms
    return () => clearTimeout(timer);
  }, [query, router, searchParams]);

  return (
    <div className="mb-8 relative w-full max-w-2xl">
      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
        <Search className="h-4 w-4 text-slate-500" />
      </div>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Wyszukaj film po tytule..."
        className="w-full bg-slate-900 border border-slate-800 text-slate-100 rounded-lg pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all placeholder:text-slate-500"
      />
    </div>
  );
}
