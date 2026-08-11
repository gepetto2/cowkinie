import logging
import re

from curl_cffi import requests

from utils import parse_start_time, clean_title, ScraperError
from core.small_sources import fetch_details
from db.database import upsert_cinema, upsert_movies_batch, upsert_screenings_chunked

logger = logging.getLogger(__name__)

# Kino Pałacowe (Poznań, CK Zamek, studyjne). Ma prawdziwe API (Django REST Framework), więc zamiast
# parsować HTML odpytujemy je wprost - ale TYLKO z nagłówkiem Accept: application/json. Bez niego DRF
# oddaje swoją przeglądarkową wersję HTML i parsowanie skończyłoby się na stronie z dokumentacją.
BASE_URL = "https://kinopalacowe.pl"
CALENDAR_API = f"{BASE_URL}/public/api/calendar/"
REPERTOIRE_PAGE = f"{BASE_URL}/podstrony/371-repertuar/"
CINEMA_NAME = "Kino Pałacowe"
CITY = "Poznań"

# Serwis jest DWUJĘZYCZNY i wybiera wersję po `Accept-Language`. Bez tego nagłówka część wydarzeń
# wraca po angielsku - "WAJDA: re-visions. Chronicle of Love Accidents" zamiast "Kronika wypadków
# miłosnych" - i taki tytuł trafiał do bazy jako osobny film, którego nie dało się dopasować w TMDB
# (ich angielski tytuł brzmi jeszcze inaczej: "Chronicle of Amorous Accidents").
# Nagłówek dotyczy tak samo API kalendarza, jak i stron filmów, z których czytamy reżysera i długość -
# tam angielska wersja podawała "dir." zamiast "reż.".
PL_HEADERS = {"Accept-Language": "pl-PL,pl;q=0.9"}
JSON_HEADERS = {"Accept": "application/json", **PL_HEADERS}

# Sale: API podaje angielskie nazwy techniczne, a dziedziniec to seanse plenerowe (jak taras Muzy).
_ROOMS = {
    "Cinema Hall": ("Sala Kinowa", False),
    "Audiovisual Hall": ("Sala Audiowizualna", False),
    "Dziedziniec Zamkowy": ("Dziedziniec Zamkowy", True),
}

# Przedrostki cykli. Zdejmujemy je, żeby film scalił się z tym samym tytułem z innych kin.
# Lista jawna - generyczne cięcie po dwukropku zniszczyłoby np. "Spider-Man: Całkiem nowy dzień".
# Uwaga na brak spacji po dwukropku ("Plenerowe Pałacowe:The Florida Project") - stąd \s* z obu stron.
# `re-wizje` to polska nazwa cyklu, `re-visions` angielska - zostawiamy oba, bo pojedyncze wydarzenia
# bywają zakładane po angielsku i wtedy nawet przy Accept-Language: pl wraca wersja oryginalna.
_CYCLE_PREFIXES = re.compile(
    r"^(?:Poranek dla dzieci|Plenerowe Pałacowe|DKF Zamek|Kino bez barier|Kino Konesera"
    r"|WAJDA:\s*re-(?:wizje|visions)\.)\s*:?\s*",
    re.IGNORECASE,
)

# Wszystko po pionowej kresce to adnotacja o okazji ("| repremiera", "| Przedpremiera", "| pokaz w 4K",
# "| Federico Fellini: ciao a tutti!"), a nie część tytułu.
_ANNOTATION = re.compile(r"\s*\|.*$")

# Oznaczenia dostępności seansu (audiodeskrypcja, napisy dla niesłyszących, język migowy).
# Celowo wąski wzorzec: NIE może zjeść "(wersja rozszerzona)" ani "(wersja reżyserska)",
# bo te odróżniają osobne wydania filmu (patrz version_key w core/merge_movies.py).
_ACCESSIBILITY = re.compile(r"\s*\((?:AD|CC|PJM|\+|\s)+\)\s*$", re.IGNORECASE)


# Cykl "Kino bez barier" - pokazy z audiodeskrypcją, napisami dla niesłyszących i tłumaczeniem
# na język migowy. W API nie ma na to ŻADNEGO osobnego pola (`category` niesie tylko nazwę sali),
# więc jedynym sygnałem jest prefiks w tytule: "Kino bez barier: La Grazia (AD + CC + PJM)".
_BARRIER_FREE = re.compile(r"^\s*Kino bez barier\s*:?\s*", re.IGNORECASE)

# Dopisek doklejany do tytułu takiego seansu. Konwencja jak przy ukraińskim dubbingu czy wersji
# rozszerzonej: sufiks w nawiasie, dzięki czemu film sortuje się pod własną literą, obok wersji zwykłej.
BARRIER_FREE_SUFFIX = "(Kino bez barier)"
BARRIER_FREE_TYPE = "KINO BEZ BARIER"


def is_barrier_free(raw: str) -> bool:
    """Czy wpis pochodzi z cyklu „Kino bez barier" (rozpoznawane po prefiksie tytułu)."""
    return bool(_BARRIER_FREE.match(raw or ""))


def clean_movie_title(raw: str) -> str:
    """Tytuł oczyszczony z nazw cykli i adnotacji, spójny z pozostałymi kinami.

    Seanse „Kino bez barier" dostają ten dopisek z powrotem jako sufiks - świadomie NIE scalamy ich
    ze zwykłym pokazem tego samego filmu. To osobna WERSJA seansu, a nie ten sam seans: widz, który
    potrzebuje audiodeskrypcji albo tłumaczenia na migowy, nie pójdzie zamiennie na zwykły pokaz.
    Ta sama zasada rządzi ukraińskim dubbingiem i wersjami rozszerzonymi.
    """
    t = (raw or "").strip()
    barrier_free = is_barrier_free(t)
    t = _CYCLE_PREFIXES.sub("", t)
    t = _ANNOTATION.sub("", t)
    t = _ACCESSIBILITY.sub("", t)
    cleaned = clean_title(t)
    if barrier_free and cleaned:
        return f"{cleaned} {BARRIER_FREE_SUFFIX}"
    return cleaned


def parse_entries(payload: dict) -> list:
    """Wyciąga seanse z jednej strony odpowiedzi API. Czysta funkcja (testowalna offline).

    Struktura: results[] -> dzień -> subsections[] -> entries[] -> pojedynczy seans.
    """
    out = []
    for day in payload.get("results") or []:
        for sub in day.get("subsections") or []:
            for e in sub.get("entries") or []:
                title = clean_movie_title(e.get("title"))
                date, time = e.get("start_date"), e.get("start_time")
                if not title or not date or not time:
                    continue
                room, outdoor = _ROOMS.get(e.get("category") or "", (e.get("category") or "", False))
                out.append({
                    "title": title,
                    "movie_type": BARRIER_FREE_TYPE if is_barrier_free(e.get("title")) else None,
                    "start_time": parse_start_time(f"{date}T{time}"),
                    "room_name": room,
                    "is_outdoor": outdoor,
                    "booking_link": e.get("ticket_url") or None,
                    "poster": _poster_url(e.get("photo")),
                    "movie_id": e.get("id"),
                    "movie_url": e.get("url") or None,
                })
    return out


def _poster_url(photo) -> str | None:
    """Pełny adres plakatu z pola `photo` API (ścieżki są względne).

    Bierzemy największy dostępny rozmiar - kafelki i modal skalują obraz w dół, a przy wznowieniach
    i filmach studyjnych bywa to jedyny plakat, jaki w ogóle mamy.
    """
    sizes = (photo or {}).get("sizes") or {}
    path = sizes.get("lg") or sizes.get("md") or (photo or {}).get("image") or sizes.get("sm")
    if not path:
        return None
    return path if path.startswith("http") else f"{BASE_URL}{path}"


async def _discover_widget_hash(client) -> str:
    """Znajduje hash widgetu kalendarza, wymagany przez API.

    Bez `widgetHash` API odpowiada `count: 0` zamiast błędem - czyli cichą pustką, która wyglądałaby
    jak "kino nie ma repertuaru". Dlatego hash wyciągamy ze strony repertuaru i sprawdzamy kandydatów
    po kolei, zamiast zapisywać go na sztywno. Strona ma kilka widgetów, tylko jeden obsługuje kalendarz.
    """
    resp = await client.get(REPERTOIRE_PAGE, timeout=30.0)
    if resp.status_code != 200:
        raise ScraperError(f"{CINEMA_NAME}: strona repertuaru zwróciła HTTP {resp.status_code}.")
    candidates = sorted(set(re.findall(r"widget_[0-9a-zA-Z]+", resp.text)))
    if not candidates:
        raise ScraperError(f"{CINEMA_NAME}: nie znaleziono żadnego widgetu na stronie repertuaru.")

    for h in candidates:
        params = {"q": "", "startDay": 0, "endDay": 0, "widgetHash": h, "page": 1}
        r = await client.get(CALENDAR_API, params=params, headers=JSON_HEADERS, timeout=30.0)
        if r.status_code != 200:
            continue
        try:
            if (r.json() or {}).get("count"):
                logger.info(f"{CINEMA_NAME}: widget kalendarza = {h} (z {len(candidates)} kandydatów).")
                return h
        except ValueError:
            continue
    raise ScraperError(
        f"{CINEMA_NAME}: żaden z widgetów {candidates} nie zwrócił danych kalendarza - zmiana API?"
    )


async def scrape_and_save(supabase):
    async with requests.AsyncSession(impersonate="chrome") as client:
        try:
            logger.info(f"Rozpoczynam scraping {CINEMA_NAME} ({CITY})...")
            db_cinema_id = upsert_cinema(supabase, CINEMA_NAME, CITY, CINEMA_NAME, "studyjne")

            widget_hash = await _discover_widget_hash(client)

            # KROK 1: kalendarz stronicowany po 16 dni - idziemy, dopóki API mówi, że jest `next`.
            shows, page = [], 1
            while True:
                params = {"q": "", "startDay": 0, "endDay": 0, "widgetHash": widget_hash, "page": page}
                r = await client.get(CALENDAR_API, params=params, headers=JSON_HEADERS, timeout=30.0)
                if r.status_code != 200:
                    raise ScraperError(f"{CINEMA_NAME}: kalendarz (strona {page}) zwrócił HTTP {r.status_code}.")
                data = r.json() or {}
                shows.extend(parse_entries(data))
                if not data.get("next"):
                    break
                page += 1
                if page > 20:  # bezpiecznik na wypadek zapętlonej paginacji
                    logger.warning(f"[{CINEMA_NAME}] Przerwano paginację na stronie {page}.")
                    break

            if not shows:
                raise ScraperError(f"{CINEMA_NAME}: API nie zwróciło żadnego seansu.")
            logger.info(f"{CINEMA_NAME}: pobrano {len(shows)} seansów z {page} stron kalendarza.")

            # KROK 2: filmy - sam tytuł. Plakat, opis i gatunek są w API, ale bierze je enrichment,
            # żeby nie mnożyć kolumn per-źródło dla każdego małego kina.
            movies_to_upsert = {s["title"]: {"title": s["title"]} for s in shows}
            movies_cache = upsert_movies_batch(supabase, movies_to_upsert)
            logger.info(f"Zapisano {len(movies_cache)} filmów {CINEMA_NAME}.")

            # KROK 3: seanse
            new_screenings = {}
            for s in shows:
                movie_id = movies_cache.get(s["title"])
                if not movie_id:
                    continue
                screening_key = (movie_id, s["start_time"], s["room_name"])
                new_screenings[screening_key] = {
                    "movie_id": movie_id,
                    "cinema_id": db_cinema_id,
                    "start_time": s["start_time"],
                    "room_name": s["room_name"],
                    "is_outdoor": s["is_outdoor"],
                    "booking_link": s["booking_link"],
                    # Kino studyjne - bez rozbicia na formaty; przyjmujemy 2D.
                    "format": "2D",
                }

            if new_screenings:
                upsert_screenings_chunked(supabase, new_screenings, CINEMA_NAME)

            logger.info(f"Zakończono zapisywanie danych z {CINEMA_NAME}!")

            # Reżyser, rok i długość są TYLKO na stronie filmu - API ich nie wystawia (sprawdzone:
            # calendar, events, search). Pobieramy je raz na FILM, nie raz na seans: 80 seansów to
            # ~50 unikalnych filmów, więc deduplikacja po identyfikatorze oszczędza 30 żądań.
            pages = {s["movie_id"]: s["movie_url"] for s in shows if s.get("movie_id") and s.get("movie_url")}
            details = await fetch_details(client, pages, headers=PL_HEADERS)
            found = sum(1 for v in details.values() if v[0])
            logger.info(f"{CINEMA_NAME}: pobrano szczegóły {len(pages)} filmów (reżyser w {found}).")

            # Metadane oddajemy do scalenia po priorytecie (core/small_sources.py). Świadomie BEZ opisu:
            # pole `lead` z API opisuje wydarzenie ("Plenerowe Pałacowe 2026, Dziedziniec Zamkowy…"),
            # a nie film, więc jako opis filmu byłoby mylące.
            meta = {}
            for s in shows:
                entry = meta.setdefault(s["title"], {})
                if entry.get("poster") is None and s.get("poster"):
                    entry["poster"] = s["poster"]
                director, year, length = details.get(s.get("movie_id"), (None, None, None))
                for field, value in (("director", director), ("release_year", year), ("length", length),
                                     ("movie_type", s.get("movie_type"))):
                    if entry.get(field) is None and value is not None:
                        entry[field] = value
            return meta

        except Exception:
            logger.exception(f"[{CINEMA_NAME}] Błąd w trakcie scrapowania")
            raise
