import { supabase } from './client';

export async function getCities() {
  const { data, error } = await supabase
    .from('cinemas')
    .select('city');

  if (error) {
    console.error('Błąd podczas pobierania miast:', error);
    return [];
  }

  // Wyciągamy unikalne miasta i sortujemy je alfabetycznie
  const cities = Array.from(new Set(data.map((c) => c.city))).sort();
  return cities;
}

export async function getMovies() {
  const { data, error } = await supabase
    .from('movies')
    .select('*');

  if (error) {
    console.error('Błąd podczas pobierania filmów:', error);
    return [];
  }

  return data;
}

export function getAvailableDates(days = 14) {
  const dates = [];
  const now = new Date();
  
  // Używamy formatu en-CA, by uzyskać stabilne YYYY-MM-DD
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    dates.push(formatter.format(d));
  }
  return dates;
}

export function getDateDaysAgo(days: number) {
  // Data sprzed N dni w formacie YYYY-MM-DD (strefa Europe/Warsaw)
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
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
