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
