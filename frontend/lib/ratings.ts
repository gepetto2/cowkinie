import { Database } from "@/types/database.types";

// Funkcje ocen potrzebują tylko kolumn ocen - dzięki temu działają zarówno na pełnym wierszu movies,
// jak i na odchudzonym typie karty (MovieListItem).
type Movie = Pick<
  Database["public"]["Tables"]["movies"]["Row"],
  "rating_filmweb" | "rating_count_filmweb" | "rating_imdb" | "rating_count_imdb" | "rating_tmdb" | "rating_count_tmdb"
>;

// Źródła ocen w skali 0-10 (Filmweb, IMDb, TMDB).
// - `m`        = prior bayesowski ("siła ściągania" oceny do średniej przy małej liczbie głosów).
// - `minVotes` = twardy dolny próg głosów; poniżej niego ocena jest ignorowana (i w wyniku, i na karcie),
//                bo kilka-kilkadziesiąt głosów (np. film przed premierą) daje mało miarodajną średnią.
// - `showOnCard` = czy pokazywać na karcie pod plakatem (TMDB pomijamy, by oceny mieściły się w 1 linii).
// Wszystkie progi są do strojenia.
type RatingSource = {
  key: string;
  label: string;
  rating: keyof Movie;
  count: keyof Movie;
  m: number;
  minVotes: number;
  showOnCard: boolean;
};

export const RATING_SOURCES: RatingSource[] = [
  { key: "filmweb", label: "Filmweb", rating: "rating_filmweb", count: "rating_count_filmweb", m: 3000, minVotes: 500, showOnCard: true },
  { key: "imdb", label: "IMDb", rating: "rating_imdb", count: "rating_count_imdb", m: 10000, minVotes: 1000, showOnCard: true },
  { key: "tmdb", label: "TMDB", rating: "rating_tmdb", count: "rating_count_tmdb", m: 300, minVotes: 50, showOnCard: false },
];

export type RatingMeans = Record<string, number>;

// Czy ocena danego źródła jest wiarygodna (jest i ma dość głosów).
function qualifies(movie: Movie, src: RatingSource): boolean {
  const rating = movie[src.rating] as number | null;
  const votes = (movie[src.count] as number | null) ?? 0;
  return rating != null && votes >= src.minVotes;
}

// Średnia ocen per źródło z całego zbioru (C w formule bayesowskiej), tylko z wiarygodnych ocen.
// Liczona raz, z pełnego zbioru filmów, żeby była stabilna niezależnie od filtrów miasta/daty.
export function computeRatingMeans(movies: Movie[]): RatingMeans {
  const means: RatingMeans = {};
  for (const src of RATING_SOURCES) {
    const vals = movies
      .filter((m) => qualifies(m, src))
      .map((m) => m[src.rating] as number);
    means[src.key] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  return means;
}

// Bayesowski wynik łączony (0-10) lub null, gdy film nie ma żadnej wiarygodnej oceny.
// Dla każdego kwalifikującego się źródła: bayes = (v*R + m*C) / (v + m); wynik = średnia po źródłach.
// Mała liczba głosów (v) ściąga ocenę do średniej C, a poniżej `minVotes` źródło w ogóle się nie liczy.
export function bayesianScore(movie: Movie, means: RatingMeans): number | null {
  const scores: number[] = [];
  for (const src of RATING_SOURCES) {
    if (!qualifies(movie, src)) continue;
    const R = movie[src.rating] as number;
    const v = movie[src.count] as number;
    scores.push((v * R + src.m * means[src.key]) / (v + src.m));
  }
  return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
}

// Oceny do wyświetlenia na karcie: tylko źródła oznaczone showOnCard i z dość głosami.
export function movieRatings(movie: Movie): { key: string; label: string; value: number }[] {
  return RATING_SOURCES
    .filter((src) => src.showOnCard && qualifies(movie, src))
    .map((src) => ({ key: src.key, label: src.label, value: movie[src.rating] as number }));
}

// Wszystkie oceny 0-10 do modalu (Filmweb/IMDb/TMDB) - także te bez showOnCard (TMDB).
export function movieRatingsFull(movie: Movie): { key: string; label: string; value: number }[] {
  return RATING_SOURCES
    .filter((src) => qualifies(movie, src))
    .map((src) => ({ key: src.key, label: src.label, value: movie[src.rating] as number }));
}
