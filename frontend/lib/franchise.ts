// Barwy sieci dla KART na /kina. Badge'y (plakat, modal) mają własne `franchiseVisual`
// w MovieCard.tsx - na wypełnionym kółku barwa logotypu działa wprost, a na ciemnej karcie już nie.
// Klasy MUSZĄ być tu pełnymi literałami - Tailwind skanuje źródła tekstowo i nie zobaczy
// nazwy sklejanej ze zmiennej.

/** Lewa krawędź + poświata karty. Granat Heliosa (#002b55) zlewa się ze slate-900, więc krawędź
 *  bierze jaśniejszy odcień tej samej barwy - blue-600, nie blue-500, żeby nie mylił się
 *  z indygo nagłówka miasta. */
export function franchiseSurface(franchise: string): string {
  const lower = franchise.toLowerCase();
  if (lower.includes("cinema") && lower.includes("city")) return "border-l-[#f5821f] from-[#f5821f]/10";
  if (lower.includes("multikino")) return "border-l-[#eb008b] from-[#eb008b]/10";
  if (lower.includes("helios")) return "border-l-blue-600 from-blue-600/10";
  if (lower === "inne") return "border-l-teal-500 from-teal-500/10";
  return "border-l-slate-600 from-slate-500/10";
}
