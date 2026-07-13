import { unstable_cache } from 'next/cache';
import { supabase } from './client';

// Dane repertuaru zmieniają się tylko przy scrapie, więc cache'ujemy odczyty na krótko,
// zamiast uderzać do Supabase pełnym zapytaniem przy każdym żądaniu (strona i tak filtruje w JS).
const CACHE_REVALIDATE_SECONDS = 120;

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
  async () => {
    const { data, error } = await supabase.from('movies').select('*');
    if (error) {
      console.error('Błąd podczas pobierania filmów:', error);
      return [];
    }
    return data;
  },
  ['movies'],
  { tags: ['movies'], revalidate: CACHE_REVALIDATE_SECONDS },
);

export const getCinemaAvailabilities = unstable_cache(
  async () => {
    const { data, error } = await supabase.from('movie_cinemas_view').select('*');
    if (error) {
      console.error('Błąd podczas pobierania dostępności kin:', error);
      return [];
    }
    return data ?? [];
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

export async function getMovieIdsByDateAndCity(dateStr: string, cityStr?: string) {
  let query = supabase.from('movie_dates_view').select('movie_id');

  query = query.eq('screening_date', dateStr);

  if (cityStr) {
    query = query.eq('city', cityStr);
  }

  const { data, error } = await query;

  if (error || !data) {
    console.error('Błąd podczas pobierania id filmów dla daty:', error);
    return new Set<string>();
  }

  return new Set(data.map(row => row.movie_id as string));
}
