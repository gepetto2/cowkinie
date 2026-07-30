import type { Metadata } from 'next';
import { getCities, getCinemaCountsByCity } from '@/lib/supabase/queries';
import CityPicker from '@/components/CityPicker';

export const metadata: Metadata = {
  title: 'Wybierz miasto',
  description: 'Repertuar kin w Polsce - wybierz miasto, żeby zobaczyć seanse i godziny.',
};

// Ekran wyboru pod WŁASNYM adresem, pokazywany zawsze - w odróżnieniu od "/", które przy zapamiętanym
// ciasteczku od razu przekierowuje do miasta. Bez tej trasy nie dałoby się wrócić do wyboru, bo każde
// wejście na "/" odbijałoby z powrotem. Segment statyczny ma pierwszeństwo przed [miasto], więc nie kolidują.
export default async function ChooseCity() {
  const [cities, counts] = await Promise.all([getCities(), getCinemaCountsByCity()]);
  return <CityPicker cities={cities} counts={counts} />;
}
