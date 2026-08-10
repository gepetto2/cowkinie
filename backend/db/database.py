import logging
import re
import unicodedata
from datetime import datetime, time
from zoneinfo import ZoneInfo


logger = logging.getLogger(__name__)

def upsert_cinema(supabase, name: str, city: str, franchise: str, category: str,
                  address: str = None, latitude: float = None, longitude: float = None,
                  url: str = None) -> str:
    """Dodaje lub aktualizuje kino i zwraca jego ID.
    franchise = realna marka (Cinema City, Kino Muza...); category = klasyfikacja do grupowania
    badge'ów i sekcji: 'sieć' | 'studyjne' | 'niezależne'.

    Pola opisowe (adres, współrzędne, adres strony) są opcjonalne - nie każde źródło je podaje.
    Puste POMIJAMY w zapisie, żeby scraper bez tych danych nie skasował wartości wpisanej ręcznie
    albo pobranej wcześniej z innego miejsca.
    """
    # Nazwa wchodzi w klucz upsertu, więc białe znaki muszą być znormalizowane w JEDNYM miejscu.
    # Źródła podają je różnie ("Warszawa -  Arkadia" z CC, "Gdańsk  Forum" po wycięciu marki
    # w Heliosie), a rozjazd o jedną spację zakłada drugie kino zamiast uzupełnić istniejące.
    name = re.sub(r"\s+", " ", name or "").strip()
    row = {"name": name, "city": city, "franchise": franchise, "category": category}
    for key, value in (("address", address), ("latitude", latitude),
                       ("longitude", longitude), ("url", url)):
        if value is not None:
            row[key] = value
    cinema_res = supabase.table("cinemas").upsert(row, on_conflict="name,franchise").execute()
    return cinema_res.data[0]["id"]

def upsert_movies_batch(supabase, movies_to_upsert: dict) -> dict:
    """
    Upsertuje słownik z filmami i aktualizuje cache filmów o nowe ID z bazy.
    Zwraca zaktualizowany cache: {title: movie_id}
    """
    if not movies_to_upsert:
        return {}
        
    movie_res = supabase.table("movies").upsert(
        list(movies_to_upsert.values()),
        on_conflict="title"
    ).execute()
    
    return {m["title"]: m["id"] for m in movie_res.data}

def load_existing_movies(supabase, columns: list) -> dict:
    """Zwraca {title: wiersz} dla filmów już w bazie - pozwala pominąć kosztowne sub-fetche
    (plakaty/szczegóły) przy scrapie bez czyszczenia. `columns` to dodatkowe kolumny (title dołączany zawsze).
    Uwaga: przy >1000 filmach trzeba by paginować (obecnie ~130, mieści się w limicie)."""
    select = "title," + ",".join(columns)
    rows = supabase.table("movies").select(select).execute().data or []
    return {r["title"]: r for r in rows}

def upsert_screenings_chunked(supabase, screenings_dict: dict, cinema_name: str, chunk_size: int = 1000):
    """ZASTĘPUJE komplet seansów danego kina świeżym zestawem (usuwa stare, wstawia nowe).
    Dzięki temu scrapowanie działa poprawnie BEZ czyszczenia bazy: znikają seanse odwołane/przeszłe,
    a availability_ratio/format istniejących seansów się odświeżają. Scraper podaje pełny bieżący repertuar kina."""
    if not screenings_dict:
        return

    screenings_list = list(screenings_dict.values())
    cinema_id = screenings_list[0]["cinema_id"]

    # Usuwamy dotychczasowe seanse tego kina, potem wstawiamy świeży komplet (brak konfliktów -> zwykły insert).
    supabase.table("screenings").delete().eq("cinema_id", cinema_id).execute()
    for i in range(0, len(screenings_list), chunk_size):
        supabase.table("screenings").insert(screenings_list[i:i+chunk_size]).execute()
    logger.info(f"Zastąpiono {len(screenings_list)} seansów w bazie dla kina {cinema_name}.")

def consolidate_movie_data(supabase):
    """Przed enrich: wypełnia TYLKO pola używane jako wejście do wyszukiwania w TMDB/Filmweb
    (release_year, movie_type, director, original_title). Reszta (poster, genre, release_date, length)
    konsolidowana jest po enrich w consolidate_post_enrich - dzięki temu może korzystać z danych z API."""
    logger.info("Konsolidacja danych do wyszukiwania (release_year, movie_type, director, original_title)...")

    # Źródła per pole (kolejność = priorytet tam, gdzie bierzemy pierwszą niepustą wartość).
    # Rok i movie_type mają osobne listy, bo Bułgarska dostarcza tylko movie_type (Kino Dzieci -> DLA DZIECI).
    cinemas = ("multikino", "cc", "helios", "muza")
    # Reżyser trafia też ze wspólnych kolumn małych kin - używa go dopasowanie w TMDB.
    director_sources = cinemas + ("small",)
    year_sources = cinemas + ("apollo", "small")              # rok produkcji: kina + Apollo + małe kina
    type_sources = cinemas + ("apollo", "bulgarska", "small") # movie_type: + Apollo (NzN), Bułgarska, małe kina
    # original_title: Helios i Muza (CC/Multikino nie dostarczają) + wspólne źródło małych kin.
    ot_sources = ("helios", "muza", "small")

    # Pobieramy filmy, które nie mają jeszcze głównego release_year, movie_type, director lub original_title
    select_cols = ["id", "title", "release_year", "movie_type", "director", "original_title"]
    select_cols += [f"release_year_{s}" for s in year_sources]
    select_cols += [f"movie_type_{s}" for s in type_sources]
    select_cols += [f"director_{s}" for s in director_sources]
    select_cols += [f"original_title_{s}" for s in ot_sources]
    response = supabase.table("movies").select(", ".join(select_cols)).or_(
        "release_year.is.null,movie_type.is.null,director.is.null,original_title.is.null"
    ).execute()
    movies = response.data

    if not movies:
        logger.info("Wszystkie filmy mają już określony release_year, movie_type, director oraz original_title.")
        return

    updated_count = 0
    for movie in movies:
        update_data = {}

        if movie.get("release_year") is None:
            valid_years = [y for y in (movie.get(f"release_year_{s}") for s in year_sources) if y is not None]
            if valid_years:
                # Wybieramy najstarszy zeskrapowany rok
                update_data["release_year"] = min(valid_years)

        if movie.get("movie_type") is None:
            valid_types = [t for t in (movie.get(f"movie_type_{s}") for s in type_sources) if t]
            if valid_types:
                unique_types = list(set(valid_types))
                if len(unique_types) > 1:
                    logger.warning(f"Niezgodność typów dla filmu '{movie.get('title')}': {unique_types}")
                # Wybieramy pierwszą z brzegu niepustą wartość
                update_data["movie_type"] = valid_types[0]

        if movie.get("director") is None:
            valid_directors = [d for d in (movie.get(f"director_{s}") for s in director_sources) if d]
            if valid_directors:
                unique_directors = list({d.lower(): d for d in valid_directors}.values())
                if len(unique_directors) > 1:
                    longest_director_lower = max(unique_directors, key=len).lower()
                    if not all(d.lower() in longest_director_lower for d in unique_directors):
                        logger.warning(f"Niezgodność reżyserów dla filmu '{movie.get('title')}': {unique_directors}")
                # Wybieramy najdłuższą z dostępnych wartości
                update_data["director"] = max(valid_directors, key=len)

        if movie.get("original_title") is None:
            valid_titles = [t for t in (movie.get(f"original_title_{s}") for s in ot_sources) if t]
            if valid_titles:
                if len(set(valid_titles)) > 1:
                    logger.warning(f"Niezgodność oryginalnych tytułów dla filmu '{movie.get('title')}': {list(set(valid_titles))}")
                # ot_sources jest już w kolejności priorytetu (Helios -> CC -> Muza)
                update_data["original_title"] = valid_titles[0]

        if update_data:
            supabase.table("movies").update(update_data).eq("id", movie["id"]).execute()
            updated_count += 1

    logger.info(f"Zaktualizowano dane dla {updated_count} filmów.")

def _is_truncated_desc(text: str) -> bool:
    """Opis to urwany teaser, jeśli kończy się wielokropkiem (Filmweb /preview tak zwraca zajawki)."""
    return text.rstrip().endswith(("...", "…", "[...]", "(...)"))

def _is_multikino_placeholder(url) -> bool:
    """Multikino czasem zwraca placeholder "wkrótce" zamiast plakatu (.../wkrotce_1_plakat.jpg).
    ?rev=... to zmienny znacznik wersji zasobu, więc dopasowujemy po stałej części ścieżki."""
    return bool(url) and "wkrotce_1_plakat" in url

# Kanonizacja gatunków: różne źródła używają synonimów ("Animowany"/"Animacja",
# "Science fiction"/"Sci-Fi", "Fantastyczny"/"Fantasy") oraz pod-gatunków ("Dramat obyczajowy").
# Sprowadzamy do jednej, kontrolowanej formy; tokeny spoza mapy przechodzą bez zmian.
# Wartość może być krotką - wtedy złożony gatunek ROZBIJAMY na istniejące składowe
# ("Komedia romantyczna" -> "Komedia" + "Romans"). None = token nie jest gatunkiem (pomijamy).
_GENRE_CANON = {
    "Animowany": "Animacja",
    "Science fiction": "Sci-Fi",
    "Fantastyczny": "Fantasy",
    "Komedia rom.": ("Komedia", "Romans"),
    "Komedia romantyczna": ("Komedia", "Romans"),
    "Komedia kryminalna": ("Komedia", "Kryminał"),
    "Dokument muzyczny": ("Dokumentalny", "Muzyczny"),
    "Dramat obyczajowy": ("Dramat", "Obyczajowy"),
    # "Obyczajowy": "Dramat",
    # "Psychologiczny": "Dramat",
    "Poetycki": "Dramat",
    "Dramat historyczny": ("Dramat", "Historyczny"),
    "Melodramat": "Romans",
    "Sensacyjny": "Akcja",
    "Sztuki walki": "Akcja",
    "Przyrodniczy": "Dokumentalny",
    "Dla dzieci": "Familijny",
    "Musical": "Muzyczny",
    "Niemy": None,
    # FORMATY WYDARZEŃ, nie gatunki filmowe. Helios podaje je w polu gatunku, choć z tych samych
    # napisów wylicza sobie movie_type (KONCERT, TEATR, CYRK) - ta sama informacja trafiała więc do
    # dwóch pól, a w gatunku bywała JEDYNĄ wartością ("Katy Perry: The Lifetimes Tour" -> "Koncert").
    "Koncert": None,
    "Spektakl teatralny": None,
    "Wydarzenie cyrkowe": None,
    "Stand-up": None,
}

# Token musi wyglądać jak nazwa gatunku: bez cyfr i o rozsądnej długości. Bez tego DOWOLNY napis
# od kina ląduje w polu widocznym dla użytkownika - tak film 'Kuźma' dostał gatunek '133 min'
# (Rialto podało w tym polu samą długość). Źródło naprawiamy u siebie, ale kin jest dziesięć i każde
# może wstawić tam cokolwiek, więc odsiew zostaje TUTAJ, na wspólnej drodze wszystkich źródeł.
# Dolny limit to 2 znaki - dopuszczamy skróty w rodzaju "SF", odcinamy śmieci w rodzaju "-".
_GENRE_REJECT = re.compile(r"\d|^.$|^.{31,}$")


# Słownik nazw gatunków - służy do ROZBIJANIA członów sklejonych spacjami. Kino Rialto zapisuje
# gatunki niekonsekwentnie: raz "Komedia / Dramat", raz "Dramat Kryminał", raz jednym słowem.
# Ukośnik i przecinek rozdzielamy przy konsolidacji, ale samej spacji nie da się ciąć na ślepo -
# "Czarna komedia" i "Komedia romantyczna" to POJEDYNCZE gatunki, które rozpadłyby się na kawałki.
#
# Stąd dopasowanie zachłanne od lewej, najdłuższym pasującym członem:
#   "Akcja Czarna komedia Thriller" -> Akcja + Czarna komedia + Thriller
# Gatunki, które NIE wymagają mapowania - przechodzą przez kanonizację bez zmian, więc nie ma ich
# w _GENRE_CANON. Wymieniamy je wyłącznie po to, by `_split_spaced_genres` wiedziało, że są nazwami
# gatunków. Reszta słownika wylicza się z _GENRE_CANON - patrz niżej.
_PLAIN_GENRES = (
    "Anime", "Biograficzny", "Czarna komedia", "Horror", "Krótkometrażowy", "Przygodowy",
    "Psychologiczny", "Sportowy", "Surrealistyczny", "Thriller", "Wojenny",
)


def _genre_vocabulary() -> tuple:
    """Wszystkie znane nazwy gatunków, W ORYGINALNEJ PISOWNI: klucze i wartości mapy kanonizującej
    plus te, które mapowania nie wymagają.

    Wyliczamy je z _GENRE_CANON zamiast przepisywać, bo inaczej obie listy rozjeżdżałyby się przy
    każdej zmianie. Dopisanie nowego gatunku do mapy działa więc od razu także przy rozbijaniu
    członów sklejonych spacjami - bez tego np. 'Koncert' i 'Wydarzenie cyrkowe' były w mapie,
    ale segmentacja ich nie znała i człon w rodzaju "Koncert Dokumentalny" przechodziłby w całości.
    """
    names = set(_PLAIN_GENRES) | set(_GENRE_CANON)
    for value in _GENRE_CANON.values():
        if isinstance(value, tuple):
            names.update(value)
        elif value:
            names.add(value)
    return tuple(sorted(names))


_GENRE_NAMES = _genre_vocabulary()

# Trzy widoki tego samego słownika, wszystkie kluczowane MAŁYMI literami - bo źródła zapisują
# gatunki różnie i porównywanie musi być niewrażliwe na wielkość liter:
#  - _KNOWN_GENRES    -> czy dany człon jest nazwą gatunku (segmentacja po spacjach),
#  - _CANONICAL_CASE  -> jedna, ustalona pisownia; bez tego Rialto ze swoim "animacja | 45 min"
#                        tworzyło w bazie DRUGI gatunek obok "Animacja" z pozostałych kin,
#  - _CANON_KEYS      -> mapowanie synonimów działające niezależnie od zapisu ("ANIMOWANY" też trafi).
_KNOWN_GENRES = frozenset(n.lower() for n in _GENRE_NAMES)
_CANONICAL_CASE = {n.lower(): n for n in _GENRE_NAMES}
_CANON_KEYS = {k.lower(): k for k in _GENRE_CANON}

# Najdłuższa nazwa gatunku (w słowach) - tyle członów próbujemy dopasować naraz. Liczone ze słownika,
# żeby dodanie dłuższej nazwy nie wymagało pamiętania o tej stałej.
_MAX_GENRE_WORDS = max(len(n.split()) for n in _KNOWN_GENRES)


def _split_spaced_genres(token: str):
    """Rozbija człon sklejony spacjami na osobne gatunki - ale TYLKO gdy rozkład jest pełny.

    Zwraca listę gatunków albo `[token]` bez zmian, jeśli choć jedno słowo nie jest znanym gatunkiem.
    Ta zasada "wszystko albo nic" chroni przed sieczką: nieznana nazwa ("Kino akcji przygodowe")
    zostaje w całości i rozstrzyga o niej dopiero `_canon_genre`, zamiast rozsypać się na wyrazy.
    """
    words = token.split()
    if len(words) < 2:
        return [token]

    out, i = [], 0
    while i < len(words):
        for size in range(min(_MAX_GENRE_WORDS, len(words) - i), 0, -1):
            candidate = " ".join(words[i:i + size])
            if candidate.lower() in _KNOWN_GENRES:
                out.append(candidate)
                i += size
                break
        else:
            return [token]  # nie rozłożyliśmy w całości - lepiej nie ruszać
    return out


def _canon_genre(token: str):
    """Znormalizowane tokeny gatunku: lista 0/1/2 elementów (złożone rozbijamy na składowe).

    Porównania są NIEWRAŻLIWE NA WIELKOŚĆ LITER, a znane gatunki dostają ustaloną pisownię.
    Kina zapisują je różnie i bez tego ta sama nazwa tworzyła w bazie dwa osobne gatunki -
    Rialto podaje przy jednym filmie "animacja", pozostałe kina "Animacja", i obie wersje
    trafiały na stronę jako oddzielne pozycje.

    Tokeny spoza słownika przechodzą bez zmian (w oryginalnej pisowni, bo nie wiemy, jaka jest
    właściwa), ale tylko jeśli w ogóle przypominają gatunek.
    """
    t = (token or "").strip()
    if not t:
        return []
    key = _CANON_KEYS.get(t.lower())
    if key is not None:
        # Wpisy ze słownika są zaufane - dodaliśmy je świadomie i filtr ich nie dotyczy.
        mapped = _GENRE_CANON[key]
        if mapped is None:
            return []
        return list(mapped) if isinstance(mapped, tuple) else [mapped]
    if _GENRE_REJECT.search(t):
        logger.debug("Odrzucono token gatunku (nie wygląda na gatunek): %r", t)
        return []
    return [_CANONICAL_CASE.get(t.lower(), t)]

# Progi, powyżej których uznajemy, że TMDB i Filmweb opisują RÓŻNE filmy, a nie ten sam z drobnymi
# rozbieżnościami w danych. Rok jest sygnałem najmocniejszym: remake'i i wznowienia dzielą od
# oryginału zwykle dekady, a legalny rozjazd (premiera festiwalowa vs kinowa) to najwyżej rok.
# Publiczny, bo enrich_movies ponawia na nim dopasowanie Filmwebu - oba miejsca MUSZĄ używać tej
# samej wartości, inaczej ponowienie odpalałoby się dla innych filmów niż te zgłaszane w logu.
MISMATCH_YEAR_GAP = 3
_MISMATCH_LENGTH_MIN = 20


def _log_source_mismatch(movie: dict):
    """Ostrzega, gdy TMDB i Filmweb najwyraźniej dopasowały się do DWÓCH RÓŻNYCH filmów.

    Bez tego taki rozjazd przechodzi bez śladu, a konsolidacja skleja z obu źródeł jeden rekord-zlepek:
    tak powstał "Oldboy" z tmdb_id i reżyserem remake'u z 2013 oraz opisem i rokiem oryginału z 2003.
    Świadomie tylko logujemy - automatyczne odrzucanie danych przy niepewnej heurystyce zrobiłoby
    więcej szkody niż pożytku, a wpis w logu wystarczy, by namierzyć film i poprawić dopasowanie.
    """
    y_tmdb, y_fw = movie.get("release_year_tmdb"), movie.get("release_year_filmweb")
    l_tmdb, l_fw = movie.get("length_tmdb"), movie.get("length_filmweb")
    d_tmdb, d_fw = movie.get("director_tmdb"), movie.get("director_filmweb")

    reasons = []
    if y_tmdb and y_fw and abs(int(y_tmdb) - int(y_fw)) >= MISMATCH_YEAR_GAP:
        reasons.append(f"rok {y_tmdb} vs {y_fw}")
    if l_tmdb and l_fw and abs(int(l_tmdb) - int(l_fw)) >= _MISMATCH_LENGTH_MIN:
        reasons.append(f"długość {l_tmdb} vs {l_fw} min")
    if d_tmdb and d_fw:
        # Nazwiska bywają zapisane różnie (kolejność, znaki diakrytyczne), więc za rozjazd uznajemy
        # dopiero brak JAKIEJKOLWIEK wspólnej części - inaczej hałasowałoby przy każdym duecie reżyserów.
        a, b = d_tmdb.lower(), d_fw.lower()
        if a not in b and b not in a and not (set(a.split()) & set(b.split())):
            reasons.append(f"reżyser '{d_tmdb}' vs '{d_fw}'")

    # Sam rozjazd długości bywa niewinny (wersje reżyserskie, różne montaże), więc alarmujemy dopiero
    # przy dwóch niezależnych sygnałach albo przy rozjeździe roku, który sam w sobie jest rozstrzygający.
    year_off = any(r.startswith("rok") for r in reasons)
    if year_off or len(reasons) >= 2:
        logger.warning(
            "Niezgodność źródeł dla filmu '%s' - TMDB i Filmweb mogły trafić w różne filmy (%s)",
            movie.get("title"), "; ".join(reasons),
        )


def consolidate_post_enrich(supabase):
    """Po enrich: konsoliduje pola, które NIE są potrzebne do wyszukiwania w API, więc korzystają
    już z danych TMDB/Filmweb - release_date, release_year (finalny), length, poster, genre.
    Korekta roku jest kluczowa dla wznowień: kina podają rok WZNOWIENIA, a TMDB/Filmweb rok produkcji.
    Czas trwania bierzemy w priorytecie TMDB -> Filmweb -> kina (kanoniczny czas filmu; kina bywają z reklamami).
    Plakat preferuje lokalne (PL) plakaty z kin, a TMDB jest ostatecznym fallbackiem."""
    logger.info("Konsolidacja po enrich (release_date, release_year, length, poster, genre, director, original_title)...")

    # Źródła per pole. Kolejność = priorytet dla length i poster (pierwsza niepusta wygrywa).
    # Datę/rok premiery bierzemy z kin + TMDB/Filmweb (bez Lumiere - jego premiera bywa datą wznowienia).
    date_sources = ("multikino", "cc", "helios", "tmdb", "filmweb", "muza")
    year_sources = date_sources + ("apollo", "small")  # rok też z Apollo i małych kin (nie podają daty premiery)
    length_sources = ("tmdb", "filmweb", "helios", "cc", "multikino", "muza", "lumiere", "small")
    # Lokalne (PL) plakaty z kin, TMDB/Filmweb jako fallback. "cc_framed" (plakaty CC z brandową
    # pomarańczową ramką) na samym końcu - bierzemy je dopiero w ostateczności, gdy nie ma nic czystszego.
    poster_sources = ("cc", "helios", "multikino", "muza", "apollo", "small", "tmdb", "filmweb", "cc_framed")
    # Gatunek konsolidujemy jako UNIĘ znormalizowanych tokenów ze wszystkich źródeł. Kolejność źródeł
    # steruje kolejnością wyświetlania (pierwszy gatunek = główny) - Filmweb najpierw (najbogatszy, 75% pokrycia).
    genre_sources = ("filmweb", "cc", "helios", "lumiere", "small")
    GENRE_MAX = 4  # limit tokenów, by lista nie puchła
    # Obsada: priorytet z zachowaniem kolejności - TMDB (billing) -> najbogatsze kino -> Filmweb (płytki).
    cast_sources = ("tmdb", "cc", "helios", "multikino", "filmweb")
    CAST_MAX = 6  # limit nazwisk
    # Opis: natywny PL i redakcyjny najpierw. Filmweb bywa urwanym teaserem z /preview ("…") - takie
    # DEGRADUJEMY: preferujemy pierwszy PEŁNY (nie urwany) opis, a urwany bierzemy dopiero jako fallback.
    desc_sources = ("filmweb", "tmdb", "cc", "multikino", "helios", "lumiere", "muza", "apollo", "small")
    # Reżyser i tytuł oryginalny: kina konsolidowane są przed-enrich; tu DOPEŁNIAMY z TMDB/Filmweb
    # dla filmów, które nie mają tych danych z kin (TMDB ma kanoniczny original_title).
    director_fallback = ("tmdb", "filmweb")
    original_title_fallback = ("tmdb",)

    select_cols = ["id", "title", "release_year", "length", "poster", "genre", "director", "original_title", "description", "cast"]
    select_cols += [f"release_date_{s}" for s in date_sources]
    select_cols += [f"release_year_{s}" for s in year_sources]
    select_cols += [f"length_{s}" for s in length_sources]
    select_cols += [f"poster_{s}" for s in poster_sources]
    select_cols += [f"genre_{s}" for s in genre_sources]
    select_cols += [f"director_{s}" for s in director_fallback]
    select_cols += [f"original_title_{s}" for s in original_title_fallback]
    select_cols += [f"description_{s}" for s in desc_sources]
    select_cols += [f"cast_{s}" for s in cast_sources]
    response = supabase.table("movies").select(", ".join(select_cols)).execute()
    movies = response.data

    if not movies:
        logger.info("Brak filmów do konsolidacji.")
        return

    updated_count = 0
    for movie in movies:
        update_data = {}

        # Sygnalizujemy rozjazd TMDB/Filmweb ZANIM zaczniemy sklejać z nich jeden rekord.
        _log_source_mismatch(movie)

        # Data premiery: mediana dostępnych źródeł (stringi ISO 'YYYY-MM-DD' porównują się chronologicznie).
        # Odporna na wczesne daty-outliery: TMDB czasem podaje datę festiwalu/premiery (np. lipiec),
        # gdy właściwa premiera kinowa jest później (sierpień) i zgadzają się co do niej Filmweb + kina.
        # Górny środek przy parzystej liczbie -> preferuje późniejszą, uzgodnioną datę.
        valid_dates = sorted(d for s in date_sources if (d := movie.get(f"release_date_{s}")))
        if valid_dates:
            update_data["release_date"] = valid_dates[len(valid_dates) // 2]

        # Rok produkcji: najwcześniejszy ze WSZYSTKICH źródeł. Nadpisuje ewentualny rok wznowienia
        # ustawiony w konsolidacji przed-enrich (która nie zna jeszcze lat z TMDB/Filmweb).
        valid_years = [int(y) for y in (movie.get(f"release_year_{s}") for s in year_sources) if y is not None]
        if valid_years:
            new_year = min(valid_years)
            if new_year != movie.get("release_year"):
                update_data["release_year"] = new_year

        # Czas trwania: mediana dostępnych źródeł (odporna na błędne pojedyncze wartości, np. TMDB=5 min
        # dla Wall-E). Przy parzystej liczbie źródeł bierzemy górny środek - zwraca zawsze realną wartość
        # któregoś źródła (bez uśredniania) i preferuje dłuższy czas przy wersjach rozszerzonych.
        lengths = sorted(v for s in length_sources if (v := movie.get(f"length_{s}")))
        length = lengths[len(lengths) // 2] if lengths else None
        if length and length != movie.get("length"):
            update_data["length"] = length

        # Plakat: preferujemy prawdziwy plakat wg priorytetu (lokalne z kin, TMDB jako fallback),
        # pomijając placeholder "wkrótce" z Multikino. Dopiero gdy NIC innego nie ma, używamy go jako
        # ostateczność (lepszy niż brak plakatu). Repick uruchamiamy też, gdy główny plakat to placeholder.
        current_poster = movie.get("poster")
        if current_poster is None or _is_multikino_placeholder(current_poster):
            poster = next((p for s in poster_sources if (p := movie.get(f"poster_{s}")) and not _is_multikino_placeholder(p)), None)
            if poster is None:
                poster = movie.get("poster_multikino")  # ostateczność: placeholder "wkrótce"
            if poster != current_poster:
                update_data["poster"] = poster

        # Gatunek: unia znormalizowanych tokenów ze wszystkich źródeł (dedup, kolejność wg priorytetu
        # źródeł). Liczymy od nowa co przebieg - gatunek jest w całości pochodną źródeł (bez wartości ręcznych).
        genre_toks = []
        for s in genre_sources:
            raw = movie.get(f"genre_{s}")
            if not raw:
                continue
            # Dzielimy po przecinku ORAZ po ukośniku: małe kina zapisują pary jako "Komedia / Dramat",
            # co bez tego zostawało jednym tokenem, zjadało miejsce w limicie i dublowało gatunek już
            # dodany osobno przez inne źródło ('Absolwent': "Dramat, Obyczajowy, Komedia / Dramat").
            for tok in re.split(r"[,/]", raw):
                # Po przecinku i ukośniku zostają jeszcze człony sklejone spacjami (Rialto) - te
                # rozbijamy po słowniku gatunków, patrz _split_spaced_genres.
                for part in _split_spaced_genres(tok.strip()):
                    for canon in _canon_genre(part):
                        if canon not in genre_toks:
                            genre_toks.append(canon)
        genre = ", ".join(genre_toks[:GENRE_MAX]) or None
        # Zapisujemy TAKŻE pustkę. Wcześniej warunek brzmiał `if genre and ...`, więc wyczyszczenie
        # gatunku było niemożliwe: film, którego jedyny token okazał się nie-gatunkiem ('133 min',
        # 'Koncert'), zachowywał starą wartość mimo poprawki w kanonizacji. Nadpisanie pustką jest tu
        # bezpieczne, bo kolumny źródłowe `genre_*` zostają w bazie między przebiegami - awaria
        # pojedynczego źródła nie sprawi, że unia nagle zrobi się pusta.
        if genre != movie.get("genre"):
            update_data["genre"] = genre

        # Reżyser: dopełnienie z TMDB/Filmweb, gdy kina go nie podały (konsolidacja kin jest przed-enrich)
        if movie.get("director") is None:
            director = next((movie.get(f"director_{s}") for s in director_fallback if movie.get(f"director_{s}")), None)
            if director:
                update_data["director"] = director

        # Tytuł oryginalny: dopełnienie z TMDB, gdy kina go nie podały (TMDB ma kanoniczny original_title)
        if movie.get("original_title") is None:
            original_title = next((movie.get(f"original_title_{s}") for s in original_title_fallback if movie.get(f"original_title_{s}")), None)
            if original_title:
                update_data["original_title"] = original_title

        # Opis: pierwszy PEŁNY (nie urwany "…") wg priorytetu; urwany teaser tylko jako fallback.
        # Wybór liczymy od nowa co przebieg (opis jest w całości pochodną źródeł, bez wartości ręcznych).
        chosen_desc = None
        trunc_fallback = None
        for s in desc_sources:
            v = movie.get(f"description_{s}")
            if v and (v := v.strip()):
                if not _is_truncated_desc(v):
                    chosen_desc = v
                    break
                if trunc_fallback is None:
                    trunc_fallback = v
        chosen_desc = chosen_desc or trunc_fallback
        if chosen_desc and chosen_desc != movie.get("description"):
            update_data["description"] = chosen_desc

        # Obsada: priorytet z zachowaniem kolejności - TMDB (uporządkowana wg billingu), a gdy brak,
        # najbogatsze kino (najwięcej nazwisk), na końcu Filmweb (tylko topka). Przycinamy do CAST_MAX.
        cast = movie.get("cast_tmdb")
        if not (cast and cast.strip()):
            cinema_casts = [c for s in ("cc", "helios", "multikino") if (c := movie.get(f"cast_{s}")) and c.strip()]
            cast = max(cinema_casts, key=lambda c: c.count(",")) if cinema_casts else movie.get("cast_filmweb")
        if cast and cast.strip():
            trimmed = ", ".join([n.strip() for n in cast.split(",") if n.strip()][:CAST_MAX])
            if trimmed and trimmed != movie.get("cast"):
                update_data["cast"] = trimmed

        if update_data:
            supabase.table("movies").update(update_data).eq("id", movie["id"]).execute()
            updated_count += 1

    logger.info(f"Zaktualizowano dane po enrich dla {updated_count} filmów.")

def _normalize_title_key(title: str) -> str:
    """Klucz porównawczy tytułu: bez diakrytyków, bez wielkości liter, ze zbitymi spacjami.
    'André Rieu' i 'Andre Rieu' dają ten sam klucz. 'ł' nie ma dekompozycji NFKD - mapujemy ręcznie."""
    if not title:
        return ""
    s = unicodedata.normalize("NFKD", title)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.replace("ł", "l").replace("Ł", "L")
    # Ignorujemy interpunkcję - 'Spider-Man. Całkiem...' (Helios) i 'Spider-Man: Całkiem...' (CC)
    # to ten sam film, różny tylko kropką/dwukropkiem.
    s = re.sub(r"[^\w\s]", " ", s)
    return re.sub(r"\s+", " ", s).strip().lower()

def _accent_score(title: str) -> int:
    """Miara 'bogactwa' pisowni - liczba znaków spoza ASCII (im więcej diakrytyków, tym lepszy tytuł)."""
    return sum(1 for c in (title or "") if ord(c) > 127)

def dedupe_by_normalized_title(supabase):
    """Łączy filmy różniące się tylko diakrytykami/wielkością liter/spacjami w tytule
    (np. 'Andre Rieu' vs 'André Rieu'). Zostawia rekord z najbogatszą pisownią, przepina do niego
    seanse, przenosi brakujące dane, resztę kasuje. Uruchamiane po scrapie, przed konsolidacją."""
    logger.info("Deduplikacja filmów po znormalizowanym tytule (diakrytyki/wielkość liter)...")

    movies = supabase.table("movies").select("*").execute().data or []

    groups = {}
    for m in movies:
        key = _normalize_title_key(m.get("title"))
        if key:
            groups.setdefault(key, []).append(m)

    merged_count = 0
    for group in groups.values():
        if len(group) < 2:
            continue

        # Ocalały: najwięcej diakrytyków, potem najdłuższy, potem stabilnie po id
        survivor = max(group, key=lambda m: (_accent_score(m.get("title")), len(m.get("title") or ""), str(m.get("id"))))
        dups = [m for m in group if m["id"] != survivor["id"]]

        logger.info(f"Scalanie {len(group)} wariantów -> '{survivor.get('title')}': {[m.get('title') for m in group]}")

        update_payload = {}
        for dup in dups:
            try:
                # Niepuste wartości z duplikatu w puste miejsca ocalałego (tytułu nie ruszamy)
                for k, v in dup.items():
                    if k in ("id", "created_at", "title"):
                        continue
                    if survivor.get(k) is None and update_payload.get(k) is None and v is not None:
                        update_payload[k] = v
                # Przepięcie seansów, potem usunięcie duplikatu
                supabase.table("screenings").update({"movie_id": survivor["id"]}).eq("movie_id", dup["id"]).execute()
                supabase.table("movies").delete().eq("id", dup["id"]).execute()
                merged_count += 1
            except Exception as e:
                logger.error(f"Błąd przy scalaniu '{dup.get('title')}' -> '{survivor.get('title')}': {e}")

        if update_payload:
            supabase.table("movies").update(update_payload).eq("id", survivor["id"]).execute()

    logger.info(f"Zdeduplikowano {merged_count} rekordów.")

def dedupe_ukrainian_by_tmdb(supabase):
    """Scala rekordy ukraińskiego dubbingu tego samego filmu z różnych sieci kin. Mają wspólne tmdb_id,
    ale różne tytuły ('ВАЯНА' / 'Vajana - UA' / 'Vaiana ukraiński dubbing'), więc upsert ich nie łączy,
    a scalanie po tmdb_id jest dla tego typu wyłączone (żeby nie zlać z polskim oryginałem).
    Tu łączymy ukraiński-z-ukraińskim: zostaje jeden rekord z kanonicznym tytułem '{tytuł_tmdb} (ukraiński dubbing)',
    seanse ze wszystkich sieci są przepięte, a niepuste pola przeniesione. Uruchamiane PO enrich (potrzebne tmdb_id)."""
    logger.info("Scalanie rekordów ukraińskiego dubbingu po tmdb_id...")

    movies = supabase.table("movies").select("*").eq("movie_type", "UKRAIŃSKI DUBBING").execute().data or []

    groups = {}
    for m in movies:
        if m.get("tmdb_id"):
            groups.setdefault(m["tmdb_id"], []).append(m)

    merged_count = 0
    renamed_count = 0
    for tmdb_id, group in groups.items():
        # Kanoniczny tytuł z dowolnego dostępnego title_tmdb w grupie
        title_tmdb = next((m.get("title_tmdb") for m in group if m.get("title_tmdb")), None)

        # Pojedynczy rekord (film tylko w jednym kinie): nie ma czego scalać, ale ujednolicamy
        # tytuł do tego samego formatu co rekordy scalone.
        if len(group) < 2:
            movie = group[0]
            single_title = f"{title_tmdb} (ukraiński dubbing)" if title_tmdb else None
            if single_title and single_title != movie.get("title"):
                try:
                    supabase.table("movies").update({"title": single_title}).eq("id", movie["id"]).execute()
                    logger.info(f"Ujednolicono tytuł: '{movie.get('title')}' -> '{single_title}'")
                    renamed_count += 1
                except Exception as e:
                    logger.error(f"Błąd przy zmianie tytułu '{movie.get('title')}' -> '{single_title}': {e}")
            continue

        # Ocalały: najbardziej kompletny rekord (najwięcej niepustych pól), stabilnie po id
        survivor = max(group, key=lambda m: (sum(1 for v in m.values() if v is not None), str(m.get("id"))))
        dups = [m for m in group if m["id"] != survivor["id"]]

        new_title = f"{title_tmdb} (ukraiński dubbing)" if title_tmdb else survivor.get("title")

        logger.info(f"Scalanie {len(group)} wariantów (tmdb {tmdb_id}) -> '{new_title}': {[m.get('title') for m in group]}")

        update_payload = {}
        for dup in dups:
            try:
                # Niepuste wartości z duplikatu w puste miejsca ocalałego (tytuł ustawiamy osobno)
                for k, v in dup.items():
                    if k in ("id", "created_at", "title"):
                        continue
                    if survivor.get(k) is None and update_payload.get(k) is None and v is not None:
                        update_payload[k] = v
                # Przepięcie seansów, potem usunięcie duplikatu
                supabase.table("screenings").update({"movie_id": survivor["id"]}).eq("movie_id", dup["id"]).execute()
                supabase.table("movies").delete().eq("id", dup["id"]).execute()
                merged_count += 1
            except Exception as e:
                logger.error(f"Błąd przy scalaniu '{dup.get('title')}' -> '{new_title}': {e}")

        # Tytuł ustawiamy PO usunięciu duplikatów, by uniknąć kolizji unique (jeden z dupów mógł mieć ten tytuł)
        if new_title and new_title != survivor.get("title"):
            update_payload["title"] = new_title

        if update_payload:
            supabase.table("movies").update(update_payload).eq("id", survivor["id"]).execute()

    logger.info(f"Ukraiński dubbing: scalono {merged_count} rekordów, ujednolicono {renamed_count} tytułów.")

def delete_past_screenings(supabase):
    """Usuwa seanse z przeszłości (start_time przed dzisiejszą północą w strefie Europe/Warsaw).
    Bezpieczne w każdym przebiegu - przeszłe seanse są zawsze nieaktualne."""
    warsaw_midnight = datetime.combine(
        datetime.now(ZoneInfo("Europe/Warsaw")).date(), time.min, tzinfo=ZoneInfo("Europe/Warsaw")
    )
    cutoff = warsaw_midnight.isoformat()
    res = supabase.table("screenings").delete().lt("start_time", cutoff).execute()
    count = len(res.data or [])
    logger.info(f"Usunięto przeszłe seanse (start_time < {cutoff}): {count}.")
    return count

def delete_orphan_movies(supabase):
    """Usuwa filmy bez żadnego seansu (wypadły z repertuaru). Uruchamiać TYLKO gdy wszystkie źródła
    zescrapowały się poprawnie - inaczej skasowalibyśmy filmy chwilowo nieudanego źródła."""
    all_ids = {m["id"] for m in supabase.table("movies").select("id").execute().data}

    # movie_screening_counts ma wiersz na (film, MIASTO), więc jest ich wielokrotnie więcej niż filmów
    # i rosną z każdym nowym mieście. Supabase tnie odpowiedź na 1000 wierszy BEZ sygnalizowania tego,
    # a film ucięty z tej listy wyglądałby na osieroconego i zostałby skasowany razem z seansami.
    # Dlatego czytamy stronami - tu ucięcie kosztowałoby utratę danych, nie tylko niepełny widok.
    PAGE = 1000
    used_ids, offset = set(), 0
    while True:
        batch = (supabase.table("movie_screening_counts").select("movie_id")
                 .range(offset, offset + PAGE - 1).execute().data)
        used_ids.update(r["movie_id"] for r in batch)
        if len(batch) < PAGE:
            break
        offset += PAGE

    orphans = [i for i in all_ids if i not in used_ids]

    if not orphans:
        logger.info("Brak osieroconych filmów do usunięcia.")
        return 0

    for i in range(0, len(orphans), 100):
        supabase.table("movies").delete().in_("id", orphans[i:i+100]).execute()
    logger.info(f"Usunięto {len(orphans)} osieroconych filmów (bez seansów).")
    return len(orphans)

def log_run_summary(supabase, enriched_count=0, past_deleted=0, orphans_deleted=0, failed_sources=None):
    """Wypisuje na końcu logu zwięzłe podsumowanie przebiegu (stan bazy + statystyki sprzątania).

    UWAGA przy czytaniu: liczby to STAN BAZY, nie dorobek tego przebiegu. Jeśli źródło zawiodło,
    jego seanse zostają z poprzedniego przebiegu (upsert_screenings_chunked nie rusza bazy przy pustym
    zestawie) - dlatego nieudane źródła wypisujemy osobno, żeby nie brać starych danych za świeże."""
    total_movies = supabase.table("movies").select("id", count="exact").limit(1).execute().count
    total_scr = supabase.table("screenings").select("id", count="exact").limit(1).execute().count

    # Seanse w rozbiciu na sieci (po kilka zapytań count - pozwala wychwycić źródło, które nic nie zwróciło)
    cinemas = supabase.table("cinemas").select("id, franchise").execute().data
    by_franchise = {}
    for c in cinemas:
        by_franchise.setdefault(c.get("franchise") or "?", []).append(c["id"])
    parts, empty = [], []
    for fr, ids in sorted(by_franchise.items()):
        cnt = supabase.table("screenings").select("id", count="exact").in_("cinema_id", ids).limit(1).execute().count
        parts.append(f"{fr}: {cnt}")
        if not cnt:
            empty.append(fr)

    logger.info("=== PODSUMOWANIE ===")
    logger.info("Filmy w bazie: %s (nowo wzbogaconych w tym przebiegu: %s)", total_movies, enriched_count)
    logger.info("Seanse w bazie: %s  [%s]", total_scr, ", ".join(parts))
    if empty:
        logger.warning("Sieci BEZ ani jednego seansu: %s - sprawdź, czy źródło nie jest zablokowane.", ", ".join(empty))
    if failed_sources:
        logger.error("ŹRÓDŁA NIEUDANE w tym przebiegu: %s. Ich seanse powyżej pochodzą z POPRZEDNIEGO "
                     "przebiegu (albo nie ma ich wcale) - nie traktuj tych liczb jako świeżych.",
                     ", ".join(failed_sources))
    logger.info("Sprzątanie: przeszłych seansów usunięto %s, osieroconych filmów %s", past_deleted, orphans_deleted)
