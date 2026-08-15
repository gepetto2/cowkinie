import { unstable_cache } from 'next/cache';
import { supabase } from './client';
import { Database } from '@/types/database.types';
import { citiesMissingLocative } from '@/lib/cities';

// Dane repertuaru zmieniają się tylko przy scrapie, więc cache'ujemy odczyty na krótko,
// zamiast uderzać do Supabase pełnym zapytaniem przy każdym żądaniu (strona i tak filtruje w JS).
const CACHE_REVALIDATE_SECONDS = 120;

// Tylko kolumny potrzebne na stronie głównej (karta + karuzele + ranking ocen). Reszta wierszy movies
// (opisy, obsada, dane per-źródło) to zbędny balast przy renderze kafelków - nie pobieramy jej.
// UWAGA: trzymaj tę listę zsynchronizowaną z typem MovieListItem poniżej.
const MOVIE_CARD_COLUMNS =
  'id, title, poster, movie_type, release_year, release_date, director, length, genre, cast, trailer, ' +
  'rating_filmweb, rating_count_filmweb, rating_imdb, rating_count_imdb, rating_tmdb, rating_count_tmdb';

export type MovieListItem = Pick<
  Database['public']['Tables']['movies']['Row'],
  | 'id' | 'title' | 'poster' | 'movie_type' | 'release_year' | 'release_date' | 'director' | 'length' | 'genre' | 'cast'
  | 'trailer'
  | 'rating_filmweb' | 'rating_count_filmweb' | 'rating_imdb' | 'rating_count_imdb' | 'rating_tmdb' | 'rating_count_tmdb'
>;

// Wspólny formatter daty YYYY-MM-DD w strefie Europe/Warsaw (używany przez helpery dat)
const warsawDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export const getCities = unstable_cache(
  async () => {
    const { data, error } = await supabase.from('cinemas').select('city');
    if (error) {
      console.error('Błąd podczas pobierania miast:', error);
      return [];
    }
    // Wyciągamy unikalne miasta i sortujemy je alfabetycznie
    const cities = Array.from(new Set(data.map((c) => c.city))).sort();
    // Nowe kino w nieznanym mieście da nagłówek "w mieście Wrocław" zamiast "we Wrocławiu".
    // Zapasowa forma nie jest błędem gramatycznym, więc bez tego wpisu rozjazd przechodzi niezauważony.
    const missing = citiesMissingLocative(cities);
    if (missing.length) {
      console.warn(`Brak odmiany (miejscownika) dla miast: ${missing.join(', ')} - uzupełnij CITY_LOCATIVE w lib/cities.ts`);
    }
    return cities;
  },
  ['cities'],
  { tags: ['movies'], revalidate: CACHE_REVALIDATE_SECONDS },
);

// Liczba kin w każdym mieście - podpis na kafelkach ekranu wyboru miasta ("Poznań · 7 kin").
export const getCinemaCountsByCity = unstable_cache(
  async (): Promise<Record<string, number>> => {
    const { data, error } = await supabase.from('cinemas').select('city');
    if (error) {
      console.error('Błąd podczas pobierania liczby kin:', error);
      return {};
    }
    const counts: Record<string, number> = {};
    for (const row of data ?? []) counts[row.city] = (counts[row.city] ?? 0) + 1;
    return counts;
  },
  ['cinema-counts'],
  { tags: ['movies'], revalidate: CACHE_REVALIDATE_SECONDS },
);

export const getMovies = unstable_cache(
  async (): Promise<MovieListItem[]> => {
    const { data, error } = await supabase.from('movies').select(MOVIE_CARD_COLUMNS);
    if (error) {
      console.error('Błąd podczas pobierania filmów:', error);
      return [];
    }
    return (data ?? []) as unknown as MovieListItem[];
  },
  ['movies'],
  { tags: ['movies'], revalidate: CACHE_REVALIDATE_SECONDS },
);

// Supabase oddaje najwyżej 1000 wierszy na zapytanie i NIE sygnalizuje ucięcia - zbiór po prostu
// przychodzi krótszy. Widoki rozpisane na miasta rosną z każdym nowym miastem, więc czytamy stronami.
type PagedSource = keyof Database['public']['Views'] | keyof Database['public']['Tables'];

async function fetchAllRows<T>(table: PagedSource, columns: string): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    // supabase-js ma OSOBNE przeciążenia dla tabel i widoków, więc unia nie pasuje do żadnego.
    // Rzutujemy wewnątrz - nazwa i tak jest sprawdzona w sygnaturze, a do zapytania idzie sam string.
    const { data, error } = await supabase
      .from(table as keyof Database['public']['Tables'])
      .select(columns)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

// Dostępność i liczba seansów w rozbiciu na KINO: jeden wiersz na (film, kino). Wymiar kina jest
// konieczny do filtrów sieci i konkretnego kina, a przy okazji zastępuje dwa wcześniejsze widoki
// (movie_cinema_availability + movie_screening_counts) i jest od nich razem wziętych mniejszy.
// Wymaga widoku movie_cinema_breakdown - patrz sql/2026-08-14-filtr-kin.sql.
//
// Miasto wchodzi w wiersz, bo karuzela "Najpopularniejsze" ma odpowiadać wybranemu miastu -
// globalny ranking był w praktyce rankingiem warszawskim. Bez sortowania i limitu w bazie:
// kolejność zależy od aktywnych filtrów, więc ustala ją strona.
export type CinemaBreakdownRow = {
  movie_id: string;
  cinema_id: string;
  city: string;
  franchise: string | null;
  category: string | null;
  screening_count: number;
};

export const getCinemaBreakdown = unstable_cache(
  async (): Promise<CinemaBreakdownRow[]> => {
    try {
      return await fetchAllRows<CinemaBreakdownRow>(
        'movie_cinema_breakdown', 'movie_id, cinema_id, city, franchise, category, screening_count');
    } catch (error) {
      console.error('Błąd podczas pobierania rozbicia kin:', error);
      return [];
    }
  },
  ['cinema-breakdown'],
  { tags: ['movies'], revalidate: CACHE_REVALIDATE_SECONDS },
);

// Dostępne formaty do filtra - dokładne wartości z bazy (widok screening_format_options = distinct format).
// Bez rozbijania kombinacji: "2D IMAX", "3D 4DX" itd. to osobne opcje (multi-select po dokładnym dopasowaniu).
export const getAvailableFormats = unstable_cache(
  async (): Promise<string[]> => {
    const { data, error } = await supabase.from('screening_format_options').select('format');
    if (error || !data) {
      console.error('Błąd podczas pobierania formatów:', error);
      return [];
    }
    const formats = (data as { format: string | null }[])
      .map((r) => r.format)
      .filter((f): f is string => Boolean(f));
    return [...new Set(formats)].sort((a, b) => a.localeCompare(b));
  },
  ['format-options'],
  { tags: ['movies'], revalidate: CACHE_REVALIDATE_SECONDS },
);

export function getAvailableDates(days = 14) {
  const dates = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    dates.push(warsawDateFormatter.format(d));
  }
  return dates;
}

export function getDateDaysAgo(days: number) {
  // Data sprzed N dni w formacie YYYY-MM-DD (strefa Europe/Warsaw)
  return warsawDateFormatter.format(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
}

// Dostępność przefiltrowana po dacie [from, to] (włącznie) i opcjonalnie po mieście - agregacja
// po stronie serwera (RPC filtered_movie_franchises). Zwraca mapę movie_id -> franczyzy seansów
// pasujących do filtrów. Klucze = filmy z seansem w zakresie; wartości sterują badge'ami kin.
// Dzięki agregacji w bazie payload jest minimalny (1 wiersz na film) i nie ma limitu 1000 wierszy.
// Pod przyszłe filtry (format itd.) wystarczy dodać kolejny parametr do funkcji i klauzulę WHERE.
export async function getFilteredAvailability(
  from?: string, to?: string, cityStr?: string, formats?: string[], langs?: string[],
  franchises?: string[], cinemaIds?: string[],
): Promise<Map<string, string[]>> {
  const { data, error } = await supabase.rpc('filtered_movie_franchises', {
    // Puste pomijamy - funkcja ma dla każdego parametru default null (= brak tego filtra).
    // format_filter / lang_filter to listy dokładnych wartości (multi-select) - dopasowanie = any(...).
    date_from: from || undefined,
    date_to: to || undefined,
    city_filter: cityStr || undefined,
    format_filter: formats && formats.length ? formats : undefined,
    lang_filter: langs && langs.length ? langs : undefined,
    // Sieć i kino sumują się w funkcji (OR), nie przecinają.
    franchise_filter: franchises && franchises.length ? franchises : undefined,
    cinema_filter: cinemaIds && cinemaIds.length ? cinemaIds : undefined,
  });

  const map = new Map<string, string[]>();
  if (error || !data) {
    console.error('Błąd podczas pobierania dostępności dla zakresu dat:', error);
    return map;
  }
  for (const row of data as { movie_id: string; franchises: string[] | null }[]) {
    if (row.movie_id) map.set(row.movie_id, row.franchises ?? []);
  }
  return map;
}

// Kina do podstrony /kina. Pola opisowe (adres, url) mamy na razie tylko dla sieciówek,
// więc typ dopuszcza null - podstrona pokazuje to, co jest.
export type CinemaListItem = Pick<
  Database['public']['Tables']['cinemas']['Row'],
  'id' | 'name' | 'city' | 'franchise' | 'category' | 'address' | 'url'
>;

// Podsumowanie sal per kino do podstrony /kina. Agregujemy tutaj, a nie w bazie, bo to raptem
// 951 wierszy bez `layout` (~170 KB) i mieści się w jednym cache'owanym odczycie.
// Kina bez wpisów (niezależne - nie mają API z mapami sal) po prostu nie trafiają do mapy.
export type HallStats = { halls: number; seats: number };

export const getHallStats = unstable_cache(
  async (): Promise<Record<string, HallStats>> => {
    try {
      const rows = await fetchAllRows<{ cinema_id: string; seats_total: number | null }>(
        'cinema_halls', 'cinema_id, seats_total');

      const out: Record<string, HallStats> = {};
      for (const row of rows) {
        const stat = (out[row.cinema_id] ??= { halls: 0, seats: 0 });
        stat.halls += 1;
        stat.seats += row.seats_total ?? 0;
      }
      return out;
    } catch (error) {
      console.error('Błąd podczas pobierania danych o salach:', error);
      return {};
    }
  },
  ['hall-stats'],
  { tags: ['movies'], revalidate: CACHE_REVALIDATE_SECONDS },
);

export const getCinemas = unstable_cache(
  async (): Promise<CinemaListItem[]> => {
    const { data, error } = await supabase
      .from('cinemas')
      .select('id, name, city, franchise, category, address, url')
      .order('city')
      .order('name');
    if (error) {
      console.error('Błąd podczas pobierania kin:', error);
      return [];
    }
    return data ?? [];
  },
  ['cinemas-list'],
  { tags: ['movies'], revalidate: CACHE_REVALIDATE_SECONDS },
);
