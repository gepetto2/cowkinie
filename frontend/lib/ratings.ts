import { Database } from "@/types/database.types";

// Funkcje ocen potrzebują tylko kolumn ocen - dzięki temu działają zarówno na pełnym wierszu movies,
// jak i na odchudzonym typie karty (MovieListItem).
type Movie = Pick<
  Database["public"]["Tables"]["movies"]["Row"],
  "rating_filmweb" | "rating_count_filmweb" | "rating_imdb" | "rating_count_imdb" | "rating_tmdb" | "rating_count_tmdb"
>;

// Źródła ocen w skali 0-10 (Filmweb, IMDb, TMDB).
// - `m`             = prior bayesowski ("siła ściągania" oceny do średniej przy małej liczbie głosów).
// - `minVotesShow`  = próg do POKAZANIA oceny użytkownikowi (karta, modal).
// - `minVotesScore` = próg do wliczenia oceny w ranking (bayesianScore i średnie, na których się opiera).
// - `showOnCard`    = czy pokazywać na karcie pod plakatem (TMDB pomijamy, by oceny mieściły się w 1 linii).
// Wszystkie progi są do strojenia.
//
// Dlaczego progi są DWA, a nie jeden: te dwa zastosowania znoszą różną niepewność.
// Na karcie pokazujemy wartość SUROWĄ, więc "Filmweb 4.4 z 362 głosów" to uczciwa, konkretna informacja.
// W rankingu ta sama ocena przechodzi przez `m`, które przy tak małej liczbie głosów ściąga ją niemal
// do średniej: 3.4 z 148 głosów daje 6.96, a 7.5 ze 108 głosów daje 7.15 - filmy różniące się o cztery
// punkty rozjeżdżają się o 0.3 i ranking przestaje cokolwiek o nich mówić. Dlatego do rankingu wpuszczamy
// tylko oceny naprawdę ustabilizowane, a do wyświetlenia - także te z mniejszą, ale sensowną próbką.
//
// Skąd te liczby: dziesiąty percentyl liczby głosów to ok. 235 dla Filmwebu i 414 dla IMDb, więc progi
// 500/1000 ucinały cały ogon repertuaru kin studyjnych (Ostatni konsjerż 4.4 z 362, Wojna Gwiazd 7.3
// z 235, Pejzaż w kolorze sepii 6.3 z 135) - a to właśnie te filmy, o których użytkownik wie najmniej.
// TMDB ma zupełnie inną skalę głosów (mediana 932 wobec 15790 na Filmwebie), więc jego próg zostaje
// wspólny - 50 głosów odsiewa tam już wyraźny szum (zdarzają się oceny 10/10 z jednego głosu).
type RatingSource = {
  key: string;
  label: string;
  rating: keyof Movie;
  count: keyof Movie;
  m: number;
  minVotesShow: number;
  minVotesScore: number;
  showOnCard: boolean;
};

export const RATING_SOURCES: RatingSource[] = [
  { key: "filmweb", label: "Filmweb", rating: "rating_filmweb", count: "rating_count_filmweb", m: 3000, minVotesShow: 100, minVotesScore: 500, showOnCard: true },
  { key: "imdb", label: "IMDb", rating: "rating_imdb", count: "rating_count_imdb", m: 10000, minVotesShow: 200, minVotesScore: 1000, showOnCard: true },
  { key: "tmdb", label: "TMDB", rating: "rating_tmdb", count: "rating_count_tmdb", m: 300, minVotesShow: 50, minVotesScore: 50, showOnCard: false },
];

export type RatingMeans = Record<string, number>;

// Czy ocena danego źródła jest wiarygodna (jest i ma dość głosów) wobec ZADANEGO progu.
// Próg podaje wywołujący, bo inny obowiązuje przy wyświetlaniu, a inny w rankingu (patrz RATING_SOURCES).
function qualifies(movie: Movie, src: RatingSource, minVotes: number): boolean {
  const rating = movie[src.rating] as number | null;
  const votes = (movie[src.count] as number | null) ?? 0;
  return rating != null && votes >= minVotes;
}

// Średnia ocen per źródło z całego zbioru (C w formule bayesowskiej), tylko z wiarygodnych ocen.
// Liczona raz, z pełnego zbioru filmów, żeby była stabilna niezależnie od filtrów miasta/daty.
// Używa progu RANKINGOWEGO - to punkt odniesienia dla bayesianScore, więc musi być liczony z tego
// samego zbioru ocen, który potem wchodzi do wyniku.
export function computeRatingMeans(movies: Movie[]): RatingMeans {
  const means: RatingMeans = {};
  for (const src of RATING_SOURCES) {
    const vals = movies
      .filter((m) => qualifies(m, src, src.minVotesScore))
      .map((m) => m[src.rating] as number);
    means[src.key] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  return means;
}

// Bayesowski wynik łączony (0-10) lub null, gdy film nie ma żadnej wiarygodnej oceny.
// Dla każdego kwalifikującego się źródła: bayes = (v*R + m*C) / (v + m); wynik = średnia po źródłach.
// Mała liczba głosów (v) ściąga ocenę do średniej C, a poniżej `minVotesScore` źródło w ogóle się nie liczy.
export function bayesianScore(movie: Movie, means: RatingMeans): number | null {
  const scores: number[] = [];
  for (const src of RATING_SOURCES) {
    if (!qualifies(movie, src, src.minVotesScore)) continue;
    const R = movie[src.rating] as number;
    const v = movie[src.count] as number;
    scores.push((v * R + src.m * means[src.key]) / (v + src.m));
  }
  return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
}

// Oceny do wyświetlenia na karcie: tylko źródła oznaczone showOnCard i z dość głosami (próg pokazywania).
export function movieRatings(movie: Movie): { key: string; label: string; value: number }[] {
  return RATING_SOURCES
    .filter((src) => src.showOnCard && qualifies(movie, src, src.minVotesShow))
    .map((src) => ({ key: src.key, label: src.label, value: movie[src.rating] as number }));
}

// Wszystkie oceny 0-10 do modalu (Filmweb/IMDb/TMDB) - także te bez showOnCard (TMDB).
export function movieRatingsFull(movie: Movie): { key: string; label: string; value: number }[] {
  return RATING_SOURCES
    .filter((src) => qualifies(movie, src, src.minVotesShow))
    .map((src) => ({ key: src.key, label: src.label, value: movie[src.rating] as number }));
}
