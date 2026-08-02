import logging
import re

from curl_cffi import requests

from utils import parse_start_time, clean_title, ScraperError
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

JSON_HEADERS = {"Accept": "application/json"}

# Sale: API podaje angielskie nazwy techniczne, a dziedziniec to seanse plenerowe (jak taras Muzy).
_ROOMS = {
    "Cinema Hall": ("Sala Kinowa", False),
    "Audiovisual Hall": ("Sala Audiowizualna", False),
    "Dziedziniec Zamkowy": ("Dziedziniec Zamkowy", True),
}

# Przedrostki cykli. Zdejmujemy je, żeby film scalił się z tym samym tytułem z innych kin.
# Lista jawna - generyczne cięcie po dwukropku zniszczyłoby np. "Spider-Man: Całkiem nowy dzień".
# Uwaga na brak spacji po dwukropku ("Plenerowe Pałacowe:The Florida Project") - stąd \s* z obu stron.
_CYCLE_PREFIXES = re.compile(
    r"^(?:Poranek dla dzieci|Plenerowe Pałacowe|DKF Zamek|Kino bez barier|Kino Konesera"
    r"|WAJDA:\s*re-visions\.)\s*:?\s*",
    re.IGNORECASE,
)

# Wszystko po pionowej kresce to adnotacja o okazji ("| repremiera", "| Przedpremiera", "| pokaz w 4K",
# "| Federico Fellini: ciao a tutti!"), a nie część tytułu.
_ANNOTATION = re.compile(r"\s*\|.*$")

# Oznaczenia dostępności seansu (audiodeskrypcja, napisy dla niesłyszących, język migowy).
# Celowo wąski wzorzec: NIE może zjeść "(wersja rozszerzona)" ani "(wersja reżyserska)",
# bo te odróżniają osobne wydania filmu (patrz version_key w core/merge_movies.py).
_ACCESSIBILITY = re.compile(r"\s*\((?:AD|CC|PJM|\+|\s)+\)\s*$", re.IGNORECASE)


def clean_movie_title(raw: str) -> str:
    """Tytuł oczyszczony z nazw cykli i adnotacji, spójny z pozostałymi kinami."""
    t = (raw or "").strip()
    t = _CYCLE_PREFIXES.sub("", t)
    t = _ANNOTATION.sub("", t)
    t = _ACCESSIBILITY.sub("", t)
    return clean_title(t)


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
                    "start_time": parse_start_time(f"{date}T{time}"),
                    "room_name": room,
                    "is_outdoor": outdoor,
                    "booking_link": e.get("ticket_url") or None,
                })
    return out


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


async def scrape_and_save(supabase, cities=["Poznań"]):
    if CITY not in cities:
        logger.info(f"Pomijam {CINEMA_NAME} ({CITY} nie jest wśród wybranych miast).")
        return

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

        except Exception:
            logger.exception(f"[{CINEMA_NAME}] Błąd w trakcie scrapowania")
            raise
