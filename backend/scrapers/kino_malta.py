import asyncio
import json
import logging
import re
from html import unescape

from curl_cffi import requests

from utils import parse_start_time, clean_title, ScraperError
from db.database import upsert_cinema, upsert_movies_batch, upsert_screenings_chunked

logger = logging.getLogger(__name__)

# Kino Malta (Poznań, studyjne; oficjalnie "Charlie Monroe Kino Malta"). WordPress - repertuar
# renderowany serwerowo, więc wystarczy JEDNO żądanie na komplet seansów. Strona podaje ten sam
# repertuar w dwóch postaciach naraz i obie są nam potrzebne:
#   - JSON-LD <script type="application/ld+json"> typu ScreeningEvent - data, godzina, plakat, czas trwania,
#   - <article class="movie-card"> - to samo PLUS sala, której JSON-LD w ogóle nie zawiera.
# Łączymy je po identyfikatorze rezerwacji z linku do biletów i porównujemy godziny (patrz _cross_check):
# rozjazd między nimi oznacza zmianę szablonu i lepiej się o niej dowiedzieć z logu niż z błędnych godzin.
#
# Świadomie NIE korzystamy z bilety.kinomalta.pl: ten sam komplet seansów, ale bez plakatów,
# z zerowym czasem trwania i tytułami zapisanymi wersalikami.
BASE_URL = "https://www.kinomalta.pl"
REPERTOIRE_URL = f"{BASE_URL}/seanse"
CINEMA_NAME = "Kino Malta"
CITY = "Poznań"

# Repertuar obejmuje ok. 4 dni - to realny horyzont kina, nie ograniczenie strony: portal biletowy
# zwraca te same identyfikatory, przełącznik dni (`showday()`) jest czystym JS-em chowającym wpisy
# już obecne w HTML, a próby wymuszenia innej daty parametrem oddają bajt w bajt tę samą stronę.
_MIN_EXPECTED_SHOWS = 4

_ARTICLE = re.compile(r'<article class="movie-card">(.*?)</article>', re.S)
_LD_BLOCK = re.compile(r'<script type="application/ld\+json">(.*?)</script>', re.S)
_TITLE = re.compile(r'<h2 class="title">([^<]+)</h2>')
_META = re.compile(r'<div class="meta">([^<]*)</div>')
_MOVIE_URL = re.compile(r'href="(' + re.escape(BASE_URL) + r'/movies/[^"]+)"')
_SHOWTIME_ROW = re.compile(r'<div class="showtimes-row">(.*?)(?=<div class="showtimes-row">|\Z)', re.S)
_HALL = re.compile(r'<div class="hall-label">(?:<i[^>]*></i>)?\s*([^<]+?)\s*</div>', re.S)
_BUTTON = re.compile(r"<button[^>]*onclick=\"window\.open\('([^']+)'.*?</button>", re.S)
_TIME = re.compile(r'<span class="time">\s*([0-2]?\d:[0-5]\d)\s*</span>')
# Data siedzi w <span class="price"> - to niechlujstwo ich szablonu, więc szukamy jej wzorcem
# po całym przycisku zamiast opierać się na tak mylącej klasie.
_DATE = re.compile(r"\b(\d{1,2})\.(\d{1,2})\.(20\d{2})\b")
_BOOKING_ID = re.compile(r"[?&]id=(\d+)")

# Strona filmu (wtyczka wpmovylibrary) - konsekwentne klasy, więc czytamy po nich, a nie po tekście.
_DIRECTOR = re.compile(
    r'meta director">.*?meta value">(.*?)</span>', re.S)
_DESC = re.compile(r"<hr\s*/?>\s*<p>(.*?)</p>", re.S)
_SRCSET = re.compile(r'(?:data-)?srcset="([^"]+)"')


def _strip_tags(html: str):
    """HTML -> tekst. Znaczniki zastępujemy spacją, żeby nie skleić sąsiadujących wyrazów.

    Przy listach w osobnych <a> ('<a>Bartosz Szpak</a>, <a>Helena Ganjalyan</a>') zostawia to spację
    PRZED przecinkiem, więc na koniec ją usuwamy - inaczej reżyserzy duetów trafialiby do bazy
    jako 'Bartosz Szpak , Helena Ganjalyan'.
    """
    if not html:
        return None
    text = re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", html)))
    return re.sub(r"\s+([,;])", r"\1", text).strip() or None


def _booking_id(url: str):
    m = _BOOKING_ID.search(url or "")
    return m.group(1) if m else None


def _genre_and_length(meta: str):
    """'Dramat, Komedia / 121 min' -> ('Dramat, Komedia', 121). Każdy człon bywa nieobecny."""
    if not meta:
        return None, None
    m_len = re.search(r"(\d{2,3})\s*min", meta)
    length = int(m_len.group(1)) if m_len else None
    genre = re.split(r"\s*/\s*", meta)[0].strip() or None
    # Gdy zostanie sam czas trwania ("/ 98 min"), nie ma gatunku do wzięcia.
    if genre and re.fullmatch(r"[\d\s]*min\.?", genre, re.IGNORECASE):
        genre = None
    return genre, length


def _poster_from_srcset(html: str, fallback: str = None):
    """Plakat ze `srcset` strony filmu - największy wariant do 1024 px.

    Pełny plik potrafi ważyć 5 MB (oryginały wgrywane przez kino), a wariant z listingu ma tylko
    200 px szerokości, czyli za mało na modal. WordPress generuje pośrednie rozmiary - bierzemy
    największy rozsądny.
    """
    best_url, best_w = fallback, 0
    for m in _SRCSET.finditer(html or ""):
        for part in m.group(1).split(","):
            bits = part.strip().split()
            if len(bits) != 2 or not bits[1].endswith("w"):
                continue
            try:
                width = int(bits[1][:-1])
            except ValueError:
                continue
            if best_w < width <= 1024:
                best_url, best_w = bits[0], width
    return best_url


def _parse_json_ld(html: str) -> dict:
    """Seanse z bloków JSON-LD, zindeksowane identyfikatorem rezerwacji."""
    out = {}
    for raw in _LD_BLOCK.findall(html):
        try:
            data = json.loads(raw)
        except ValueError:
            continue
        for item in (data if isinstance(data, list) else [data]):
            if not isinstance(item, dict) or item.get("@type") != "ScreeningEvent":
                continue
            key = _booking_id((item.get("offers") or {}).get("url"))
            if key:
                out[key] = item
    return out


def _cross_check(shows: list, ld: dict):
    """Porównuje godziny z kart HTML z tymi z JSON-LD i raportuje rozjazdy.

    UWAGA na strefę czasową: w `startDate` kino wysyła stałe '+01:00' także latem, gdy w Polsce
    obowiązuje '+02:00'. Godzina ŚCIENNA jest poprawna i zgodna z kartą, więc porównujemy wyłącznie
    'YYYY-MM-DDTHH:MM' i nigdzie nie czytamy tego pola jako gotowego znacznika czasu - inaczej cały
    repertuar Malty wylądowałby w bazie godzinę za późno.
    """
    checked = mismatched = 0
    for s in shows:
        event = ld.get(s["booking_id"])
        if not event:
            continue
        checked += 1
        if (event.get("startDate") or "")[:16] != f"{s['date']}T{s['time']}":
            mismatched += 1
            logger.warning(
                "[%s] Rozjazd HTML vs JSON-LD dla '%s' (id=%s): karta %sT%s, JSON-LD %s.",
                CINEMA_NAME, s["title"], s["booking_id"], s["date"], s["time"], event.get("startDate"),
            )
    logger.info(f"{CINEMA_NAME}: zgodność HTML/JSON-LD sprawdzona dla {checked} z {len(shows)} seansów "
                f"(rozjazdów: {mismatched}).")


def parse_listing(html: str) -> list:
    """Parsuje stronę repertuaru -> lista seansów (dict). Czysta funkcja (testowalna offline).

    Jedna karta = jeden seans (ten sam film ma osobną kartę na każdy termin), ale obsługujemy też
    kartę z wieloma terminami - szablon dopuszcza kilka bloków `showtimes-row`, każdy z własną salą.
    """
    ld = _parse_json_ld(html)
    shows = []

    for card in _ARTICLE.findall(html):
        m_title = _TITLE.search(card)
        if not m_title:
            continue
        title = clean_title(unescape(m_title.group(1)).strip())
        if not title:
            continue

        m_meta = _META.search(card)
        genre, length = _genre_and_length(unescape(m_meta.group(1)) if m_meta else "")
        m_url = _MOVIE_URL.search(card)

        for row in _SHOWTIME_ROW.findall(card):
            m_hall = _HALL.search(row)
            hall = _strip_tags(m_hall.group(1)) if m_hall else None
            for btn in _BUTTON.finditer(row):
                booking_link = unescape(btn.group(1))
                block = btn.group(0)
                m_time, m_date = _TIME.search(block), _DATE.search(block)
                if not m_time or not m_date:
                    continue
                day, month, year = m_date.groups()
                booking_id = _booking_id(booking_link)
                event = ld.get(booking_id) or {}
                work = event.get("workPresented") or {}
                shows.append({
                    "title": title,
                    "date": f"{year}-{int(month):02d}-{int(day):02d}",
                    "time": m_time.group(1).rjust(5, "0"),
                    "hall": hall,
                    "booking_link": booking_link,
                    "booking_id": booking_id,
                    "movie_url": m_url.group(1) if m_url else None,
                    "genre": genre,
                    "length": length,
                    # Plakat z listingu ma tylko 200 px - służy jako zapas, gdy nie uda się pobrać
                    # strony filmu z porządnym srcset.
                    "poster": work.get("image") or None,
                })

    _cross_check(shows, ld)
    return shows


def parse_movie_page(html: str) -> dict:
    """Metadane ze strony filmu: reżyser, pełny opis, plakat w przyzwoitym rozmiarze.

    Świadomie NIE bierzemy stąd roku: w nawiasie przy tytule kino podaje rok POLSKIEJ dystrybucji,
    a nie produkcji - "Requiem dla snu (2026)", "Harry Angel (2025)". Malta regularnie gra wznowienia
    klasyki, więc ten rok wpuszczony do release_year psułby dopasowanie w TMDB dokładnie tam, gdzie
    najbardziej na nim zależy (klasyk kontra remake). Pilnuje tego też EXCLUDED_FIELDS w small_sources.
    """
    m_dir = _DIRECTOR.search(html or "")
    m_desc = _DESC.search(html or "")
    return {
        "director": _strip_tags(m_dir.group(1)) if m_dir else None,
        "description": _strip_tags(m_desc.group(1)) if m_desc else None,
        "poster": _poster_from_srcset(html),
    }


async def fetch_movie_details(client, urls: dict, concurrency: int = 4) -> dict:
    """Pobiera strony filmów -> {adres: metadane}. Raz na FILM, nie raz na seans.

    38 seansów to ok. 21 filmów, więc deduplikacja po adresie oszczędza prawie połowę żądań.
    Ograniczona równoległość - to zwykły WordPress na współdzielonym hostingu.
    Wspólnego core.small_sources.fetch_details nie użyjemy: tamten czyta jednolinijkowe 'reż. X, KRAJ ROK',
    a Malta rozbija te dane na oklasowane pola wtyczki wpmovielibrary.
    """
    sem = asyncio.Semaphore(concurrency)

    async def one(url):
        async with sem:
            try:
                resp = await client.get(url, timeout=30.0)
            except Exception as e:
                logger.debug("Nie pobrano szczegółów %s: %s", url, e)
                return url, {}
            if resp.status_code != 200:
                logger.debug("Szczegóły %s: HTTP %s", url, resp.status_code)
                return url, {}
            return url, parse_movie_page(resp.text)

    return dict(await asyncio.gather(*[one(u) for u in urls]))


async def scrape_and_save(supabase):
    async with requests.AsyncSession(impersonate="chrome") as client:
        try:
            logger.info(f"Rozpoczynam scraping {CINEMA_NAME} ({CITY})...")
            db_cinema_id = upsert_cinema(supabase, CINEMA_NAME, CITY, CINEMA_NAME, "studyjne")

            resp = await client.get(REPERTOIRE_URL, timeout=30.0)
            if resp.status_code != 200:
                raise ScraperError(f"{CINEMA_NAME}: repertuar zwrócił HTTP {resp.status_code}.")

            shows = parse_listing(resp.text)
            if not shows:
                raise ScraperError(f"{CINEMA_NAME}: nie sparsowano żadnego seansu - zmiana struktury strony?")
            if len(shows) < _MIN_EXPECTED_SHOWS:
                # Repertuar bywa krótki (4 dni), ale garstka seansów przy poprawnie wczytanej stronie
                # zwykle znaczy, że szablon się zmienił i większość kart przelatuje nam obok parsera.
                logger.warning(f"{CINEMA_NAME}: tylko {len(shows)} seansów - sprawdź, czy szablon się nie zmienił.")
            logger.info(f"{CINEMA_NAME}: pobrano {len(shows)} seansów.")

            # KROK 1: filmy - sam tytuł. Reszta metadanych idzie do wspólnych kolumn małych kin.
            movies_to_upsert = {s["title"]: {"title": s["title"]} for s in shows}
            movies_cache = upsert_movies_batch(supabase, movies_to_upsert)
            logger.info(f"Zapisano {len(movies_cache)} filmów {CINEMA_NAME}.")

            # KROK 2: seanse
            new_screenings = {}
            for s in shows:
                movie_id = movies_cache.get(s["title"])
                if not movie_id:
                    continue
                room_name = s["hall"] or ""
                start_time = parse_start_time(f"{s['date']}T{s['time']}:00")
                screening_key = (movie_id, start_time, room_name)
                new_screenings[screening_key] = {
                    "movie_id": movie_id,
                    "cinema_id": db_cinema_id,
                    "start_time": start_time,
                    "room_name": room_name,
                    "booking_link": s["booking_link"],
                    # Kino studyjne - bez rozbicia na formaty; przyjmujemy 2D.
                    "format": "2D",
                }

            if new_screenings:
                upsert_screenings_chunked(supabase, new_screenings, CINEMA_NAME)

            logger.info(f"Zakończono zapisywanie danych z {CINEMA_NAME}!")

            # KROK 3: metadane ze stron filmów -> wspólne kolumny małych kin (core/small_sources.py).
            pages = {s["movie_url"] for s in shows if s.get("movie_url")}
            details = await fetch_movie_details(client, pages)
            found = sum(1 for d in details.values() if d.get("director"))
            logger.info(f"{CINEMA_NAME}: pobrano szczegóły {len(pages)} filmów (reżyser w {found}).")

            meta = {}
            for s in shows:
                entry = meta.setdefault(s["title"], {})
                detail = details.get(s.get("movie_url")) or {}
                # Plakat i opis ze strony filmu są lepsze (większy plakat, pełny opis zamiast urwanego
                # wielokropkiem), więc listing służy tu tylko jako zapas.
                for field, value in (
                    ("director", detail.get("director")),
                    ("description", detail.get("description")),
                    ("poster", detail.get("poster") or s.get("poster")),
                    ("genre", s.get("genre")),
                    ("length", s.get("length")),
                ):
                    if entry.get(field) is None and value is not None:
                        entry[field] = value
            return meta

        except Exception:
            logger.exception(f"[{CINEMA_NAME}] Błąd w trakcie scrapowania")
            raise
