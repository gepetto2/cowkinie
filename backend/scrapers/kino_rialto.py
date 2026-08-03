import asyncio
import json
import logging
import re
from datetime import datetime
from html import unescape
from zoneinfo import ZoneInfo

from curl_cffi import requests

from utils import parse_start_time, clean_title, normalize_lang, ScraperError
from core.small_sources import fetch_details
from db.database import upsert_cinema, upsert_movies_batch, upsert_screenings_chunked

logger = logging.getLogger(__name__)

# Kino Rialto (Poznań, studyjne). WordPress z wtyczką `b24-api`, czyli integracją z systemem biletowym
# Bilety24 - ten sam produkt bywa u innych kin, więc adres i nazwa są PARAMETRAMI, a nie stałymi:
# obsługa kolejnego kina na tym silniku sprowadzi się do wywołania z innym `base_url`.
#
# Repertuar jest renderowany serwerowo pod ?b24_day=YYYY-MM-DD, a strona publikuje w skrypcie tablicę
# `eventDates` z listą dni, w których cokolwiek gra. Dzięki temu nie zgadujemy horyzontu ani nie
# odpytujemy pustych dni - pobieramy dokładnie tyle stron, ile trzeba.
BASE_URL = "https://www.kinorialto.poznan.pl"
CINEMA_NAME = "Kino Rialto"
CITY = "Poznań"

# Strona renderuje każdy seans DWA razy (osobny markup dla desktopu i mobile), więc deduplikujemy
# po identyfikatorze seansu z linku do rezerwacji.
_ITEM_SPLIT = '<div class="list-item">'

# Wpisy, które pojawiają się w repertuarze, ale nie są seansami (np. voucher prezentowy).
_NOT_A_SCREENING = re.compile(r"bilet\s+podarunkowy", re.IGNORECASE)

# Przedrostki cykli. Zdejmujemy je, bo inaczej "Wakacje w Rialto: Góra mocy" nie scali się z filmem
# "Góra mocy", który jest już w bazie z innych kin. Lista jawna - generyczne cięcie po dwukropku
# zniszczyłoby tytuły w rodzaju "Spider-Man: Całkiem nowy dzień".
_CYCLE_PREFIXES = re.compile(
    r"^(?:Wakacje w Rialto|Filmowy Klub Seniora|Kino Konesera|DKF)\s*:\s*", re.IGNORECASE
)

# Sufiksy opisujące OKAZJĘ, a nie film. Wszystko od separatora w prawo idzie do usunięcia.
_OCCASION_SUFFIX = re.compile(
    r"\s*(?:\||-)\s*(?:pokaz przedpremierowy|prelekcja\b.*|retransmisja\b.*|spotkanie\b.*)$",
    re.IGNORECASE,
)

# Kody wersji językowej doklejane do formatu ("2D NAP"). Reszta tokenów to format.
_LANG_CODES = {"NAP": "NAPISY", "DUB": "DUBBING", "LEK": "LEKTOR", "ORG": "ORYGINALNY"}


def _strip_html(text: str) -> str:
    return unescape(re.sub(r"<[^>]+>", "", text or "")).replace("\xa0", " ").strip()


def _title(raw: str) -> str:
    """Czysty tytuł, spójny z pozostałymi kinami.

    Rialto pisze nowości WERSALIKAMI, dokleja nazwy cykli z przodu i informacje o okazji z tyłu.
    Bez tego czyszczenia te same filmy tworzyłyby w bazie osobne rekordy zamiast dołączyć do
    istniejących (a enrichment nie znalazłby ich w TMDB).
    """
    t = _strip_html(raw)
    t = _CYCLE_PREFIXES.sub("", t)
    t = _OCCASION_SUFFIX.sub("", t)
    t = re.sub(r"\s*\(re-release\)\s*$", "", t, flags=re.IGNORECASE)
    t = clean_title(t)
    if t and t == t.upper():
        t = t.capitalize()
    return t


def _format_and_lang(raw: str):
    """'2D NAP' -> ('2D', 'NAPISY'). Puste pole -> ('2D', None).

    Jedno pole na stronie niesie obie informacje, więc rozdzielamy je po tokenach: znane kody języka
    idą do wersji, reszta zostaje formatem. Brak formatu traktujemy jak 2D - kino studyjne nie ma
    innych sal, a `None` psułoby filtr formatu na stronie.
    """
    lang = None
    fmt_parts = []
    for token in (raw or "").upper().split():
        if token in _LANG_CODES:
            lang = _LANG_CODES[token]
        else:
            fmt_parts.append(token)
    return " ".join(fmt_parts) or "2D", normalize_lang(lang)


def parse_event_dates(html: str) -> list:
    """Lista dni z seansami, którą strona publikuje w skrypcie (`let eventDates = [...]`).

    Czysta funkcja - testowalna offline, bez sieci.
    """
    m = re.search(r"let\s+eventDates\s*=\s*(\[[^\]]*\])", html)
    if not m:
        return []
    try:
        dates = json.loads(m.group(1))
    except json.JSONDecodeError:
        return []
    return [d for d in dates if isinstance(d, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", d)]


def _genre_and_length(info: str):
    """'Dramat | 114 min' -> ('Dramat', 114). Pole bywa niepełne - w dowolną stronę.

    Może zabraknąć czasu ('Przygodowy'), ale też SAMEGO GATUNKU ('133 min') - i wtedy nie ma znaku '|',
    po którym dzielimy. Dlatego czasu szukamy we WSZYSTKICH członach, a pierwszy człon uznajemy za
    gatunek dopiero, gdy nie okazał się samą długością. Bez tego film z takim polem dostawał
    gatunek '133 min' i tracił długość naraz (tak trafiła do bazy 'Kuźma').
    """
    raw = _strip_html(info)
    if not raw:
        return None, None
    parts = [p.strip() for p in raw.split("|")]

    length = None
    for p in parts:
        m = re.search(r"(\d{2,3})\s*min", p)
        if m:
            length = int(m.group(1))
            break

    first = parts[0] or None
    genre = None if first and re.fullmatch(r"\d{2,3}\s*min\.?", first, re.IGNORECASE) else first
    return genre, length


def parse_day(html: str, date: str) -> list:
    """Parsuje stronę jednego dnia -> lista seansów (dict): time, title, format, lang, screening_id,
    a także gatunek i długość filmu (trafiają do wspólnych kolumn *_small małych kin).
    Czysta funkcja (testowalna offline).
    """
    out, seen = [], set()
    for part in (chunk[:4000] for chunk in html.split(_ITEM_SPLIT)[1:]):
        m_time = re.search(r'b24-button__hour hour">([^<]+)<', part)
        m_title = re.search(r'list-item-title[^>]*><a[^>]*>([^<]+)</a>', part)
        if not m_time or not m_title:
            continue

        raw_title = m_title.group(1)
        if _NOT_A_SCREENING.search(raw_title):
            continue  # voucher prezentowy - siedzi w repertuarze, ale nie jest seansem
        title = _title(raw_title)
        if not title:
            continue

        m_id = re.search(r"b24-do-miejsc[^?]*\?id=(\d+)", part)
        screening_id = m_id.group(1) if m_id else None
        # Deduplikacja markupu desktop/mobile. Bez identyfikatora klucz z godziny i tytułu.
        key = screening_id or f"{m_time.group(1).strip()}|{title}"
        if key in seen:
            continue
        seen.add(key)

        m_fmt = re.search(r'b24-button__format format">([^<]*)<', part)
        fmt, lang = _format_and_lang(m_fmt.group(1) if m_fmt else "")
        m_info = re.search(r'<div class="info">([^<]*)</div>', part)
        genre, length = _genre_and_length(m_info.group(1) if m_info else "")
        m_movie = re.search(r'/wydarzenie/\?id=(\d+)', part)
        movie_id = m_movie.group(1) if m_movie else None

        out.append({
            "date": date,
            "time": m_time.group(1).strip(),
            "title": title,
            "format": fmt,
            "lang": lang,
            "screening_id": screening_id,
            "genre": genre,
            "length": length,
            "movie_id": movie_id,
        })
    return out


async def _fetch_day(client, base_url: str, date: str, sem):
    async with sem:
        try:
            resp = await client.get(f"{base_url}/?b24_day={date}", timeout=30.0)
        except Exception as e:
            logger.warning(f"[Rialto] Nie pobrano dnia {date}: {e}")
            return date, None
        if resp.status_code != 200:
            logger.warning(f"[Rialto] Dzień {date}: HTTP {resp.status_code}")
            return date, None
        return date, resp.text


async def scrape_and_save(supabase, cities=["Poznań"], base_url: str = BASE_URL,
                          cinema_name: str = CINEMA_NAME, city: str = CITY):
    if city not in cities:
        logger.info(f"Pomijam {cinema_name} ({city} nie jest wśród wybranych miast).")
        return

    async with requests.AsyncSession(impersonate="chrome") as client:
        try:
            logger.info(f"Rozpoczynam scraping {cinema_name} ({city})...")
            db_cinema_id = upsert_cinema(supabase, cinema_name, city, cinema_name, "studyjne")

            # KROK 1: dowolna strona dnia zawiera listę WSZYSTKICH dni z seansami.
            today = datetime.now(ZoneInfo("Europe/Warsaw")).strftime("%Y-%m-%d")
            resp = await client.get(f"{base_url}/?b24_day={today}", timeout=30.0)
            if resp.status_code != 200:
                raise ScraperError(f"{cinema_name}: strona repertuaru zwróciła HTTP {resp.status_code}.")

            dates = parse_event_dates(resp.text)
            if not dates:
                raise ScraperError(f"{cinema_name}: nie znaleziono listy dni (eventDates) - zmiana strony?")
            # Przeszłe dni zostawiamy - i tak sprząta je delete_past_screenings.
            dates = [d for d in dates if d >= today]
            logger.info(f"{cinema_name}: {len(dates)} dni z repertuarem ({dates[0]} .. {dates[-1]}).")

            # KROK 2: strony dni równolegle, ale ostrożnie - to mała witryna na współdzielonym hostingu.
            sem = asyncio.Semaphore(4)
            results = await asyncio.gather(*[_fetch_day(client, base_url, d, sem) for d in dates])

            shows = []
            failed_days = []
            for date, html in results:
                if html is None:
                    failed_days.append(date)
                    continue
                shows.extend(parse_day(html, date))
            if failed_days:
                logger.warning(f"[Rialto] Nie udało się pobrać {len(failed_days)} dni: {failed_days}")
            if not shows:
                raise ScraperError(f"{cinema_name}: nie sparsowano żadnego seansu - zmiana struktury strony?")
            logger.info(f"{cinema_name}: pobrano {len(shows)} seansów.")

            # KROK 3: filmy - sam tytuł. Gatunek i długość są na stronie, ale bierzemy je z enrichmentu,
            # żeby nie mnożyć kolumn per-źródło dla każdego małego kina.
            movies_to_upsert = {s["title"]: {"title": s["title"]} for s in shows}
            movies_cache = upsert_movies_batch(supabase, movies_to_upsert)
            logger.info(f"Zapisano {len(movies_cache)} filmów {cinema_name}.")

            # KROK 4: seanse
            new_screenings = {}
            for s in shows:
                movie_id = movies_cache.get(s["title"])
                if not movie_id:
                    continue
                start_time = parse_start_time(f"{s['date']}T{s['time']}:00")
                screening_key = (movie_id, start_time, "")
                new_screenings[screening_key] = {
                    "movie_id": movie_id,
                    "cinema_id": db_cinema_id,
                    "start_time": start_time,
                    "room_name": "",  # Rialto ma jedną salę i jej nie podaje
                    "format": s["format"],
                    "lang": s["lang"],
                    "booking_link": (
                        f"{base_url}/b24-do-miejsc-numerowanych-i-nienumerowanych/?id={s['screening_id']}"
                        if s["screening_id"] else None
                    ),
                }

            if new_screenings:
                upsert_screenings_chunked(supabase, new_screenings, cinema_name)

            logger.info(f"Zakończono zapisywanie danych z {cinema_name}!")

            # Metadanych NIE zapisujemy tutaj - zwracamy je, a scalaniem po priorytecie zajmuje się
            # core/small_sources.py po zakończeniu wszystkich scraperów (patrz komentarz tamże).
            # Reżyser i rok są tylko na stronie wydarzenia - pobieramy raz na FILM, nie na seans.
            pages = {s["movie_id"]: f"{base_url}/wydarzenie/?id={s['movie_id']}"
                     for s in shows if s.get("movie_id")}
            details = await fetch_details(client, pages)
            found = sum(1 for v in details.values() if v[0])
            logger.info(f"{cinema_name}: pobrano szczegóły {len(pages)} filmów (reżyser w {found}).")

            meta = {}
            for s in shows:
                entry = meta.setdefault(s["title"], {})
                for field in ("genre", "length"):
                    if entry.get(field) is None and s.get(field) is not None:
                        entry[field] = s[field]
                director, year, length = details.get(s.get("movie_id"), (None, None, None))
                for field, value in (("director", director), ("release_year", year), ("length", length)):
                    if entry.get(field) is None and value is not None:
                        entry[field] = value
            return meta

        except Exception:
            logger.exception(f"[{cinema_name}] Błąd w trakcie scrapowania")
            raise
