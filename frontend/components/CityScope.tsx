"use client";

import { createContext, useContext } from "react";

// Wybrane miasta rozwiązuje SERWER z segmentu ścieżki (/poznan) i parametru ?miasta=, po czym podaje
// je tu gotową listą nazw z bazy. Dzięki temu komponenty klienckie nie muszą same tłumaczyć slugów na
// nazwy (potrzebowałyby do tego pełnej listy miast), a MovieCard - renderowany w siedmiu miejscach -
// nie wymaga przepychania propsów przez karuzele i sekcje.
type CityScopeValue = {
  /** Miasta zawężające widok. PUSTA lista = cała Polska (adres główny "/" bez ?miasta). */
  selected: string[];
  /** Wszystkie miasta mające kina - lista do filtrów i ekranu wyboru. */
  all: string[];
};

const CityScopeContext = createContext<CityScopeValue>({ selected: [], all: [] });

export function CityScopeProvider({
  selected,
  all,
  children,
}: CityScopeValue & { children: React.ReactNode }) {
  return (
    // Wartość jest zwykłym obiektem tworzonym przy renderze serwera i zmienia się wyłącznie razem
    // z adresem, więc memoizacja nic by tu nie dała.
    <CityScopeContext.Provider value={{ selected, all }}>{children}</CityScopeContext.Provider>
  );
}

export function useCityScope() {
  return useContext(CityScopeContext);
}
