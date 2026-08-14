// Nazwy kin w bazie są takie, jak podaje je sieć: raz samo miasto ("Bydgoszcz"), raz miasto
// z obiektem ("Warszawa - Mokotów"), raz nazwa własna ("Kino Muza"). Tu sprowadzamy je do jednej
// formy do wyświetlenia. Bazy NIE ruszamy - `name` wchodzi w klucz upsertu (name, franchise).

type CinemaLike = {
  name?: string | null;
  city?: string | null;
  franchise?: string | null;
};

type CinemaGroupLike = { franchise?: string | null; category?: string | null };

/** Grupa do badge'a: dla sieci realna marka, dla reszty kategoria (studyjne/niezależne). */
export function cinemaGroup(c: CinemaGroupLike | null | undefined): string | null {
  if (!c) return null;
  return c.category === 'sieć' ? c.franchise ?? null : c.category ?? null;
}

/** Klucz badge'a: sieci osobno (marka), studyjne i niezależne razem jako "Inne". */
export function badgeKey(group: string): string {
  return group === 'studyjne' || group === 'niezależne' ? 'Inne' : group;
}

/** Skrót na `cinemaGroup` + `badgeKey` - najczęstsze użycie obu. */
export function cinemaBadge(c: CinemaGroupLike | null | undefined): string | null {
  const group = cinemaGroup(c);
  return group ? badgeKey(group) : null;
}

// Helios bywa oddaje nazwy z podwójną spacją ("Gdańsk  Forum") - patrz scrapers/helios.py.
const squash = (s?: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();

// "Warszawa - Mokotów" -> "Mokotów"; "Bydgoszcz" -> "". Po mieście musi stać separator,
// inaczej ucięlibyśmy nazwę tylko zaczynającą się tak samo (hipotetyczne "Gdyniaplex").
function stripCity(name: string, city?: string | null): string {
  if (!city || !name.startsWith(city)) return name;
  const rest = name.slice(city.length);
  if (rest && !/^[\s\-–—]/.test(rest)) return name;
  return rest.replace(/^[\s\-–—]+/, '').trim();
}

/** Nazwa kina do wyświetlenia: "Helios Bydgoszcz", "Cinema City Mokotów", "Kino Muza".
 *  `omitCity` dla widoków już pogrupowanych po mieście (podstrona /kina) - bez powtarzania miasta. */
export function cinemaLabel(c: CinemaLike | null | undefined, omitCity = false): string {
  const name = squash(c?.name) || 'Nieznane kino';
  const franchise = squash(c?.franchise);
  const venue = omitCity ? stripCity(name, c?.city) : name;
  if (!franchise || venue === franchise) return venue || name;
  return venue ? `${franchise} ${venue}` : franchise;
}

/** Sam obiekt, bez marki i miasta: "Poznań - Kinepolis" -> "Kinepolis", "Bydgoszcz" -> "Bydgoszcz".
 *  Do list POGRUPOWANYCH po sieci, gdzie marka stoi już w nagłówku grupy. */
export function cinemaVenue(c: CinemaLike | null | undefined): string {
  const name = squash(c?.name);
  return stripCity(name, c?.city) || squash(c?.city) || cinemaLabel(c);
}

type CinemaPickable = CinemaLike & { id: string; category?: string | null };

/** Kina pogrupowane do filtra: najpierw sieci (malejąco po liczbie kin), na końcu reszta razem.
 *  `franchise` nagłówka jest null dla grupy "Inne" - te kina wybiera się wyłącznie pojedynczo,
 *  bo ich `franchise` to nazwa własna pojedynczego kina, a nie sieć. */
export function groupCinemasByChain<T extends CinemaPickable>(cinemas: T[]) {
  const chains = new Map<string, T[]>();
  const others: T[] = [];
  for (const c of cinemas) {
    if (c.category === 'sieć' && c.franchise) {
      const arr = chains.get(c.franchise);
      if (arr) arr.push(c);
      else chains.set(c.franchise, [c]);
    } else {
      others.push(c);
    }
  }
  const byName = (a: T, b: T) => cinemaLabel(a).localeCompare(cinemaLabel(b), 'pl');
  const groups: { label: string; franchise: string | null; cinemas: T[] }[] = [...chains.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'pl'))
    .map(([franchise, list]) => ({ label: franchise, franchise, cinemas: [...list].sort(byName) }));
  if (others.length) {
    groups.push({ label: 'Inne kina', franchise: null, cinemas: [...others].sort(byName) });
  }
  return groups;
}

/** Adres bez miasta ("ul. Wołoska 12, Warszawa" -> "ul. Wołoska 12"), gdy miasto niesie nagłówek. */
export function cinemaAddress(address?: string | null, city?: string | null): string | null {
  const a = squash(address);
  if (!a) return null;
  const i = a.lastIndexOf(',');
  return i > 0 && city && a.slice(i + 1).trim() === city ? a.slice(0, i).trim() : a;
}
