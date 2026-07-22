import { unstable_cache } from 'next/cache';
import { supabase } from './client';
import { Database } from '@/types/database.types';

// Dane repertuaru zmieniają się tylko przy scrapie, więc cache'ujemy odczyty na krótko,
// zamiast uderzać do Supabase pełnym zapytaniem przy każdym żądaniu (strona i tak filtruje w JS).
const CACHE_REVALIDATE_SECONDS = 120;

// Tylko kolumny potrzebne na stronie głównej (karta + karuzele + ranking ocen). Reszta wierszy movies
// (opisy, obsada, dane per-źródło) to zbędny balast przy renderze kafelków - nie pobieramy jej.
// UWAGA: trzymaj tę listę zsynchronizowaną z typem MovieListItem poniżej.
const MOVIE_CARD_COLUMNS =
  'id, title, poster, movie_type, release_year, release_date, director, ' +
  'rating_filmweb, rating_count_filmweb, rating_imdb, rating_count_imdb, rating_tmdb, rating_count_tmdb';

export type MovieListItem = Pick<
  Database['public']['Tables']['movies']['Row'],
  | 'id' | 'title' | 'poster' | 'movie_type' | 'release_year' | 'release_date' | 'director'
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
    return Array.from(new Set(data.map((c) => c.city))).sort();
  },
  ['cities'],
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

// Ziarnista dostępność: jeden wiersz na (film, miasto, franczyza). Pozwala policzyć franczyzy
// zawężone do wybranego miasta (badge'y na plakacie mają odpowiadać aktywnemu filtrowi), a nie
// wszystkie franczyzy filmu w ogóle. Wymaga widoku movie_cinema_availability (patrz SQL).
export type CinemaAvailabilityRow = { movie_id: string; city: string; franchise: string | null };

export const getCinemaAvailabilities = unstable_cache(
  async (): Promise<CinemaAvailabilityRow[]> => {
    const { data, error } = await supabase
      .from('movie_cinema_availability')
      .select('movie_id, city, franchise');
    if (error) {
      console.error('Błąd podczas pobierania dostępności kin:', error);
      return [];
    }
    return (data ?? []) as unknown as CinemaAvailabilityRow[];
  },
  ['cinema-availabilities'],
  { tags: ['movies'], revalidate: CACHE_REVALIDATE_SECONDS },
);

export const getTopScreenings = unstable_cache(
  async () => {
    const { data, error } = await supabase
      .from('movie_screening_counts')
      .select('*')
      .order('screening_count', { ascending: false })
      .limit(10);
    if (error) {
      console.error('Błąd podczas pobierania rankingu seansów:', error);
      return [];
    }
    return data ?? [];
  },
  ['top-screenings'],
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
export async function getFilteredAvailability(from: string, to: string, cityStr?: string): Promise<Map<string, string[]>> {
  const { data, error } = await supabase.rpc('filtered_movie_franchises', {
    date_from: from,
    date_to: to,
    // Pomijamy przy braku miasta - funkcja ma default null (traktuje jako "wszystkie miasta").
    city_filter: cityStr || undefined,
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
