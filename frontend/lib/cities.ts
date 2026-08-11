// Miasto jest filtrem GŁÓWNYM, więc mieszka w ścieżce, a nie w query:
//   /                          -> cała Polska (adres domyślny)
//   /poznan                    -> dokładnie jedno miasto (przypadek najczęstszy)
//   /?miasta=gdansk,gdynia     -> podzbiór (np. Trójmiasto)
// Podzbiór trafia do query jako lista po przecinkach - tak samo jak istniejące filtry
// format/lang/genre, więc konwencja adresów pozostaje jednolita.
// Ekran wyboru miasta ma własny adres /wybierz-miasto (segment statyczny wygrywa z catch-allem).

/** Wartość oznaczająca "cała Polska" - używana i w ciasteczku, i jako jawny znacznik w ?miasta=. */
export const ALL_VALUE = "wszystkie";
export const CITY_COOKIE = "miasto";

/** "Poznań" -> "poznan". 'ł' obsługujemy osobno, bo NFD go NIE rozkłada (jak w normalizeSearch). */
export function citySlug(city: string): string {
  return city
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // znaki łączące (diakrytyki) po rozkładzie NFD
    .replace(/ł/g, "l")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Slug -> nazwa miasta z bazy (lub null). Lista miast pochodzi z DB, więc nowe miasta działają same. */
export function cityFromSlug(slug: string, allCities: string[]): string | null {
  const s = slug.toLowerCase();
  return allCities.find((c) => citySlug(c) === s) ?? null;
}

export type CityScope = {
  /** Miasta do filtrowania. PUSTA lista = brak zawężenia (cała Polska). */
  selected: string[];
  /** false = slug w adresie nie odpowiada żadnemu miastu -> strona powinna dać 404. */
  valid: boolean;
};

/**
 * Wylicza zakres miast ze ścieżki i parametru `miasta`.
 * `slug` pusty = adres główny "/" = cała Polska; wtedy zawężenie może przyjść z `miasta`.
 * `?miasta=wszystkie` to JAWNE "cała Polska" - wynik jest ten sam co bez parametru, ale sama
 * obecność parametru mówi stronie, że użytkownik trafił tu świadomie (patrz komentarz przy
 * przekierowaniu w page.tsx), więc nie wolno go odesłać do domyślnego miasta.
 * Nieznane slugi w `miasta` są po cichu pomijane - literówka w udostępnionym linku ma zawęzić
 * wynik do tego, co dało się rozpoznać, a nie wysypać całą stronę.
 */
export function parseCityScope(slug: string, miastaParam: string, allCities: string[]): CityScope {
  if (!slug) {
    if (miastaParam.trim() === ALL_VALUE) return { selected: [], valid: true };
    const subset = miastaParam
      .split(",")
      .map((s) => cityFromSlug(s.trim(), allCities))
      .filter((c): c is string => Boolean(c));
    return { selected: [...new Set(subset)], valid: true };
  }
  const city = cityFromSlug(slug, allCities);
  return city ? { selected: [city], valid: true } : { selected: [], valid: false };
}

/**
 * Adres docelowy dla danego zestawu miast:
 * 1 miasto -> /<miasto>, 2+ -> /?miasta=a,b, 0 -> /?miasta=wszystkie.
 *
 * Uwaga na ostatni przypadek: goły "/" jest zarezerwowany dla WEJŚCIA na stronę, które przekierowuje
 * do domyślnego miasta. Gdyby "wszystkie miasta" w filtrach prowadziło na goły "/", użytkownik
 * zostałby natychmiast odesłany z powrotem do swojego miasta. Jawny znacznik odróżnia "wszedłem na
 * stronę" od "świadomie chcę zobaczyć całą Polskę".
 *
 * `extraQuery` to pozostałe filtry (data/format/język/gatunek/szukajka), które trzeba zachować.
 */
export function cityScopeHref(selected: string[], extraQuery?: URLSearchParams): string {
  const params = new URLSearchParams(extraQuery?.toString() ?? "");
  params.delete("miasta");

  let path: string;
  if (selected.length === 1) {
    path = `/${citySlug(selected[0])}`;
  } else {
    path = "/";
    params.set("miasta", selected.length > 1 ? selected.map(citySlug).join(",") : ALL_VALUE);
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Wartość ciasteczka -> zapamiętany zakres. Ciasteczko trzyma slugi, a adres liczymy z nich na nowo
 *  (bezpieczniej niż trzymać gotową ścieżkę, którą dałoby się podmienić na obcą).
 *  null = brak zapamiętanego wyboru (użytkownik jeszcze nie wybierał). */
export function scopeFromCookie(value: string, allCities: string[]): string[] | null {
  if (!value) return null;
  if (value === ALL_VALUE) return [];
  const cities = value
    .split(",")
    .map((s) => cityFromSlug(s.trim(), allCities))
    .filter((c): c is string => Boolean(c));
  return cities.length ? cities : null;
}

/** Zakres -> wartość ciasteczka. */
export function scopeToCookie(selected: string[]): string {
  return selected.length ? selected.map(citySlug).join(",") : ALL_VALUE;
}

// Miejscownik nazw miast ("w Poznaniu", nie "w Poznań"). Polskiej odmiany nie da się wyliczyć
// regułą - Bydgoszcz/Bydgoszczy, Gdynia/Gdyni i Suwałki/Suwałkach mają różne wzorce - więc trzymamy
// jawną mapę. Miasto spoza mapy dostaje bezpieczne "w mieście X": brzmi sztywniej, ale nigdy nie jest
// błędem gramatycznym, więc dodanie kina w nowym mieście nie wyprodukuje nagłówka typu "w Kraków".
const CITY_LOCATIVE: Record<string, string> = {
  "Bełchatów": "Bełchatowie",
  "Biała Podlaska": "Białej Podlaskiej",
  "Białystok": "Białymstoku",
  "Bielsko-Biała": "Bielsku-Białej",
  "Bydgoszcz": "Bydgoszczy",
  "Bytom": "Bytomiu",
  "Cieszyn": "Cieszynie",
  "Czechowice-Dziedzice": "Czechowicach-Dziedzicach",
  "Częstochowa": "Częstochowie",
  "Dąbrowa Górnicza": "Dąbrowie Górniczej",
  "Elbląg": "Elblągu",
  "Gdańsk": "Gdańsku",
  "Gdynia": "Gdyni",
  "Gliwice": "Gliwicach",
  "Gniezno": "Gnieźnie",
  "Gorzów Wielkopolski": "Gorzowie Wielkopolskim",
  "Grudziądz": "Grudziądzu",
  "Głogów": "Głogowie",
  "Janki": "Jankach",
  "Jaworzno": "Jaworznie",
  "Jelenia Góra": "Jeleniej Górze",
  "Kalisz": "Kaliszu",
  "Katowice": "Katowicach",
  "Kielce": "Kielcach",
  "Konin": "Koninie",
  "Koszalin": "Koszalinie",
  "Kraków": "Krakowie",
  "Krosno": "Krośnie",
  "Kędzierzyn-Koźle": "Kędzierzynie-Koźlu",
  "Kłodzko": "Kłodzku",
  "Legionowo": "Legionowie",
  "Legnica": "Legnicy",
  "Leszno": "Lesznie",
  "Lubin": "Lubinie",
  "Lublin": "Lublinie",
  "Mielec": "Mielcu",
  "Nowy Sącz": "Nowym Sączu",
  "Olsztyn": "Olsztynie",
  "Opole": "Opolu",
  "Ostrów Wielkopolski": "Ostrowie Wielkopolskim",
  "Pabianice": "Pabianicach",
  "Piotrków Trybunalski": "Piotrkowie Trybunalskim",
  "Piła": "Pile",
  "Poznań": "Poznaniu",
  "Pruszków": "Pruszkowie",
  "Przemyśl": "Przemyślu",
  "Płock": "Płocku",
  "Radom": "Radomiu",
  "Ruda Śląska": "Rudzie Śląskiej",
  "Rumia": "Rumi",
  "Rybnik": "Rybniku",
  "Rzeszów": "Rzeszowie",
  "Siedlce": "Siedlcach",
  "Sopot": "Sopocie",
  "Sosnowiec": "Sosnowcu",
  "Stalowa Wola": "Stalowej Woli",
  "Starachowice": "Starachowicach",
  "Starogard Gdański": "Starogardzie Gdańskim",
  "Suwałki": "Suwałkach",
  "Szczecin": "Szczecinie",
  "Słupsk": "Słupsku",
  "Tarnów": "Tarnowie",
  "Tczew": "Tczewie",
  "Tomaszów Mazowiecki": "Tomaszowie Mazowieckim",
  "Toruń": "Toruniu",
  "Tychy": "Tychach",
  "Warszawa": "Warszawie",
  "Wałbrzych": "Wałbrzychu",
  "Wołomin": "Wołominie",
  "Wrocław": "Wrocławiu",
  "Włocławek": "Włocławku",
  "Zabrze": "Zabrzu",
  "Zgorzelec": "Zgorzelcu",
  "Zielona Góra": "Zielonej Górze",
  "Łomża": "Łomży",
  "Łódź": "Łodzi",
  "Świdnica": "Świdnicy",
  "Żory": "Żorach",
};

/** "Poznań" -> "Poznaniu". Nieznane miasto zwracamy bez zmian (patrz `citiesLocative`). */
export function cityLocative(city: string): string | null {
  return CITY_LOCATIVE[city] ?? null;
}

/**
 * Zakres miast -> człon miejsca do nagłówka i tytułu: "w Poznaniu", "w Poznaniu i Gdyni",
 * "w Poznaniu, Gdańsku i Gdyni", a dla pustego zakresu "w całej Polsce".
 * Ostatnie dwa miasta łączymy spójnikiem, resztę przecinkami - tak, jak zapisałoby się to w zdaniu.
 */
export function citiesLocative(cities: string[]): string {
  if (cities.length === 0) return "w całej Polsce";
  const forms = cities.map((c) => cityLocative(c) ?? `mieście ${c}`);
  // Przyimek zależy od PIERWSZEGO członu, bo tylko przed nim stoi: "we Wrocławiu i Poznaniu".
  const prep = /^w[^aąeęioóuy]/i.test(forms[0]) ? "we" : "w";
  if (forms.length === 1) return `${prep} ${forms[0]}`;
  const last = forms[forms.length - 1];
  return `${prep} ${forms.slice(0, -1).join(", ")} i ${last}`;
}

/** Miasta z bazy, dla których nie mamy odmiany - dostają zapasowe "w mieście X".
 *  Służy do ostrzeżenia przy starcie, żeby mapa nie dryfowała po cichu za nowymi kinami. */
export function citiesMissingLocative(cities: string[]): string[] {
  return cities.filter((c) => !CITY_LOCATIVE[c]);
}
