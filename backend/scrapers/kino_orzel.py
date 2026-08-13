import asyncio
import logging
import re
from datetime import datetime
from html import unescape
from zoneinfo import ZoneInfo

from curl_cffi import requests

from utils import parse_start_time, clean_title, normalize_lang, ScraperError
from core.small_sources import is_not_a_screening
from db.database import upsert_cinema, upsert_movies_batch, upsert_screenings_chunked

logger = logging.getLogger(__name__)

# Kino Orzeł (Bydgoszcz, studyjne; prowadzone przez MCK). WordPress - repertuar renderowany
# serwerowo, więc komplet seansów kosztuje JEDNO żądanie.
#
# Strona zawiera dwa widoki tego samego repertuaru naraz:
#  - kalendarzowy (`rep-film`)      - film powtórzony przy każdym dniu, dzień w nadrzędnym kontenerze,
#  - alfabetyczny (`rep-film alfa`) - film RAZ, a dni siedzą w jego środku.
# Parsujemy alfabetyczny: dzień stoi tam obok godziny, więc nie trzeba śledzić stanu między blokami,
# a każdy film pojawia się dokładnie raz (35 bloków = 35 tytułów).
BASE_URL = "https://www.kino-orzel.pl"
REPERTOIRE_URL = f"{BASE_URL}/repertuar/"
CINEMA_NAME = "Kino Orzeł"
CITY = "Bydgoszcz"

# Kino jednosalowe - sala nie występuje w danych i nie jest potrzebna.
_ROOM = ""

_FILM = re.compile(r'class="rep-film alfa"(.*?)(?=class="rep-film(?: alfa)?"|\Z)', re.S)
_TITLE = re.compile(r'class="rep-film-title">([^<]+)<')
_FILM_URL = re.compile(r'href="(' + re.escape(BASE_URL) + r'/repertuar/[^"/]+/)"')
_FESTIVAL = re.compile(r'class="rep-festival-name">([^<]+)<')
# Najpierw cały <img> po klasie, potem src z jego wnętrza - w tym szablonie `src` stoi PRZED `class`,
# więc wzorzec zakładający kolejność atrybutów nie trafiał w nic.
_POSTER_IMG = re.compile(r'<img[^>]*\bclass="[^"]*rep-film-poster-image[^"]*"[^>]*>')
_POSTER_SRC = re.compile(r'\ssrc="([^"]+)"')
_BASIC_VALUE = re.compile(r'class="rep-film-basics-value">([^<]*)<')
# Blok dnia: nagłówek z datą, a pod nim seanse aż do kolejnego nagłówka.
_DAY_BLOCK = re.compile(r'class="rep-film-day-number">([\d.]+)</div>(.*?)(?=class="rep-film-day-number"|\Z)', re.S)
_SEANCE = re.compile(r'class="rep-film-hour">([\d:]+)</div>(.*?)(?=class="rep-film-hour"|\Z)', re.S)
_LANG = re.compile(r'class="rep-translation-label">([^<]*)<')

# Strona filmu: pary etykieta/wartość w <div class="film-detail-label">…</div><div class="film-detail-value">…</div>
_DETAIL_PAIR = re.compile(
    r'class="film-detail-label[^"]*">([^<]*)</div>\s*<div class="film-detail-value[^"]*">(.*?)</div>', re.S)
_TICKETS = re.compile(r'href="(https://www\.bilety24\.pl/[^"]+)"')


# Cykle programowe: (wzorzec przedrostka, movie_type, czy seans plenerowy).
#
# Obcinamy je, bo "Wakacje w Kinie Orzeł: Góra mocy" to ten sam film co "Góra mocy" w innych kinach -
# bez tego trafia do bazy jako osobny wpis (tak powstały 4 duplikaty przy pierwszym przebiegu).
# Separator bywa dwukropkiem ALBO myślnikiem, ale dopuszczamy go tylko po ZNANEJ nazwie cyklu:
# generyczne cięcie po myślniku okroiłoby tytuły w rodzaju "NOTHING MORE - NIC WIĘCEJ - Żywot Mateusza".
_SEP = r"\s*[:–—-]\s*"
_CYCLES = (
    (re.compile(rf"^Najlepsze z Najgorszych{_SEP}", re.I), "NAJLEPSZE Z NAJGORSZYCH", False),
    (re.compile(rf"^Wystawa w kinie{_SEP}", re.I), "WYSTAWY", False),
    # Projekcja na parkingu to cecha SEANSU, nie filmu - "Najgorszy człowiek na świecie" grany pod
    # chmurką to ten sam film co w sali, więc zamiast typu ustawiamy flagę seansu (jak taras Muzy).
    (re.compile(rf"^Letnie kino na parkingu{_SEP}", re.I), None, True),
    (re.compile(rf"^Wakacje w Kinie Orzeł{_SEP}", re.I), None, False),
    (re.compile(rf"^Wajda re-Wizje{_SEP}", re.I), None, False),
    (re.compile(rf"^Żuławski\. Kino ekstazy{_SEP}", re.I), None, False),
    (re.compile(rf"^Kino Konesera{_SEP}", re.I), None, False),
    (re.compile(rf"^DKF{_SEP}", re.I), None, False),
)

# Okoliczność pokazu to cecha SEANSU, nie inny film - inaczej "Zmruż oczy + spotkanie" nie scali się
# ze "Zmruż oczy", a "Requiem dla snu (pokaz jednorazowy)" założy drugi wpis obok "Requiem dla snu".
_OCCASION_SUFFIX = re.compile(
    r"\s*(?:\+\s*spotkanie.*|\((?:pokaz\b[^)]*|prelekcja[^)]*|spotkanie[^)]*)\))\s*$", re.IGNORECASE)

# Po zdjęciu przedrostków: co jest WYDARZENIEM, a nie filmem. Bloki konkursowe, gale i wystawy
# nie mają odpowiednika w TMDB; zwykły film grany w ramach przeglądu (np. "Following") - ma.
_EVENT_TITLE = re.compile(r"\bblok\b|\bgala\b|\bwystaw|pokaz dla szkół|małe formy", re.IGNORECASE)


def _text(raw: str):
    return unescape(re.sub(r"<[^>]+>", " ", raw or "")).strip() or None


def _title_and_type(raw_title: str, festival: str):
    """(tytuł, movie_type, czy_plenerowy) z surowego tytułu i nazwy festiwalu.

    Przedrostek festiwalu zdejmujemy DOKŁADNIE tym, co poda strona (`rep-festival-name`), więc bez
    zgadywania wzorcem. `FESTIWAL` nadajemy dopiero wtedy, gdy po obcięciu tytuł nadal opisuje
    wydarzenie - przynależność do przeglądu jest cechą seansu, a nie samego filmu.
    """
    # Twarde spacje (\xa0) z edytora WordPressa - bez tego "Żuławski.\xa0Kino\xa0ekstazy:" nie
    # dopasowuje się do wzorca cyklu, choć wygląda identycznie jak wpis obok.
    t = re.sub(r"\s+", " ", unescape(raw_title or "")).strip()

    movie_type, outdoor = None, False
    for pattern, cycle_type, cycle_outdoor in _CYCLES:
        if pattern.match(t):
            t = pattern.sub("", t)
            movie_type, outdoor = cycle_type, cycle_outdoor
            break

    if festival and t.lower().startswith(festival.lower()):
        t = t[len(festival):].lstrip(": -–—").strip()
    t = _OCCASION_SUFFIX.sub("", t)
    if movie_type is None and festival and _EVENT_TITLE.search(t):
        movie_type = "FESTIWAL"
    return clean_title(t), movie_type, outdoor


def _parse_date(day_month: str, now: datetime):
    """'03.09' -> 'YYYY-MM-DD'. Strona nie podaje roku, więc przy przełomie (miesiąc < obecnego)
    przyjmujemy następny - tak samo jak w Bułgarskiej i Malcie."""
    m = re.match(r"(\d{1,2})\.(\d{1,2})", (day_month or "").strip())
    if not m:
        return None
    day, month = int(m.group(1)), int(m.group(2))
    year = now.year + 1 if month < now.month else now.year
    return f"{year:04d}-{month:02d}-{day:02d}"


def _basics(block: str):
    """(długość, rok) z listy wartości przy tytule. Etykiety na stronie są puste, więc NIE polegamy
    na kolejności: długość to liczba minut, rok to pierwsze czterocyfrowe 19xx/20xx (bywa zakresem
    '2024-2025' przy blokach festiwalowych)."""
    length = year = None
    for raw in _BASIC_VALUE.findall(block):
        v = raw.strip()
        if length is None and re.fullmatch(r"\d{1,3}", v):
            length = int(v)
        if year is None and (m := re.match(r"(19|20)\d{2}", v)):
            year = int(m.group(0))
    return length, year


def parse_repertoire(html: str, now: datetime):
    """HTML repertuaru -> lista seansów. Czysta funkcja (testowalna offline).

    Seans: title, date, time, lang, movie_type, is_outdoor, film_url, poster, length, release_year.
    """
    out = []
    for block in _FILM.findall(html):
        m_title = _TITLE.search(block)
        if not m_title:
            continue
        raw_title = unescape(m_title.group(1)).strip()
        if is_not_a_screening(raw_title):
            continue

        m_url = _FILM_URL.search(block)
        m_img = _POSTER_IMG.search(block)
        m_poster = _POSTER_SRC.search(m_img.group(0)) if m_img else None
        m_fest = _FESTIVAL.search(block)
        festival = unescape(m_fest.group(1)).strip() if m_fest else None
        title, movie_type, outdoor = _title_and_type(raw_title, festival)
        if not title:
            continue
        length, release_year = _basics(block)

        for day_month, day_body in _DAY_BLOCK.findall(block):
            date = _parse_date(day_month, now)
            if not date:
                continue
            for hour, seance_body in _SEANCE.findall(day_body):
                m_lang = _LANG.search(seance_body)
                out.append({
                    "title": title,
                    "date": date,
                    "time": hour.strip(),
                    "lang": normalize_lang(_text(m_lang.group(1)) if m_lang else None),
                    "movie_type": movie_type,
                    "is_outdoor": outdoor,
                    "film_url": m_url.group(1) if m_url else None,
                    "poster": m_poster.group(1) if m_poster else None,
                    "length": length,
                    "release_year": release_year,
                })
    return out


async def _fetch_details(client: requests.AsyncSession, urls: set) -> dict:
    """{url: {director, original_title, description, booking_link}} ze stron filmów.

    Listing nie ma reżysera, a bez niego dopasowanie w TMDB potrafi trafić w inny film o tym samym
    tytule. Strona filmu podaje go w oklasowanych parach etykieta/wartość, więc bez zgadywania z prozy.
    """
    sem = asyncio.Semaphore(6)

    async def one(url):
        async with sem:
            try:
                resp = await client.get(url, timeout=30.0)
                if resp.status_code != 200:
                    return url, {}
            except Exception as e:
                logger.debug("%s: nie pobrano %s (%s)", CINEMA_NAME, url, e)
                return url, {}
        html = resp.text
        fields = {_text(label) or "": _text(value) for label, value in _DETAIL_PAIR.findall(html)}
        m_len = re.match(r"(\d+)", fields.get("Czas trwania") or "")
        m_tickets = _TICKETS.search(html)
        return url, {
            "director": fields.get("Reżyseria"),
            "original_title": fields.get("Tytuł oryginalny"),
            "release_year": int(fields["Rok Produkcji"][:4]) if (fields.get("Rok Produkcji") or "")[:4].isdigit() else None,
            "length": int(m_len.group(1)) if m_len else None,
            "booking_link": m_tickets.group(1) if m_tickets else None,
        }

    return dict(await asyncio.gather(*[one(u) for u in urls]))


async def scrape_and_save(supabase):
    async with requests.AsyncSession(impersonate="chrome") as client:
        try:
            logger.info(f"Rozpoczynam scraping {CINEMA_NAME} ({CITY})...")
            db_cinema_id = upsert_cinema(supabase, CINEMA_NAME, CITY, CINEMA_NAME, "studyjne")

            resp = await client.get(REPERTOIRE_URL, timeout=40.0)
            if resp.status_code != 200:
                raise ScraperError(f"{CINEMA_NAME}: repertuar zwrócił HTTP {resp.status_code}.")

            shows = parse_repertoire(resp.text, datetime.now(ZoneInfo("Europe/Warsaw")))
            if not shows:
                raise ScraperError(f"{CINEMA_NAME}: nie sparsowano żadnego seansu - zmiana struktury strony?")
            logger.info(f"{CINEMA_NAME}: pobrano {len(shows)} seansów.")

            # KROK 1: filmy - sam tytuł. Reszta (w tym movie_type) idzie do wspólnych kolumn
            # małych kin, żeby nie mnożyć kolumn per kino.
            movies_to_upsert = {s["title"]: {"title": s["title"]} for s in shows}
            movies_cache = upsert_movies_batch(supabase, movies_to_upsert)
            logger.info(f"Zapisano {len(movies_cache)} filmów {CINEMA_NAME}.")

            # KROK 2: metadane ze stron filmów (reżyser, tytuł oryginalny, link do biletów).
            pages = {s["film_url"] for s in shows if s.get("film_url")}
            details = await _fetch_details(client, pages)
            found = sum(1 for d in details.values() if d.get("director"))
            logger.info(f"{CINEMA_NAME}: pobrano szczegóły {len(pages)} filmów (reżyser w {found}).")

            # KROK 3: seanse
            new_screenings = {}
            for s in shows:
                movie_id = movies_cache.get(s["title"])
                if not movie_id:
                    continue
                detail = details.get(s.get("film_url")) or {}
                start_time = parse_start_time(f"{s['date']}T{s['time']}:00")
                screening_key = (movie_id, start_time, _ROOM)
                new_screenings[screening_key] = {
                    "movie_id": movie_id,
                    "cinema_id": db_cinema_id,
                    "start_time": start_time,
                    "room_name": _ROOM,
                    "lang": s["lang"],
                    "is_outdoor": s["is_outdoor"],
                    # Link jest per FILM, nie per seans - kino nie wystawia adresów pojedynczych
                    # seansów w repertuarze. Gdy brak, kierujemy na stronę filmu.
                    "booking_link": detail.get("booking_link") or s.get("film_url"),
                    # Kino studyjne, jednosalowe - bez rozbicia na formaty.
                    "format": "2D",
                }

            if new_screenings:
                upsert_screenings_chunked(supabase, new_screenings, CINEMA_NAME)
            logger.info(f"Zakończono zapisywanie danych z {CINEMA_NAME}!")

            # KROK 4: wspólne kolumny małych kin (core/small_sources.py). Rok bierzemy ze strony
            # filmu ("Rok Produkcji"), a nie z listingu - przy blokach festiwalowych listing podaje
            # zakres ("2024-2025"), który jest rokiem zestawu, nie filmu.
            meta = {}
            for s in shows:
                entry = meta.setdefault(s["title"], {})
                detail = details.get(s.get("film_url")) or {}
                for field, value in (
                    ("movie_type", s["movie_type"]),
                    ("director", detail.get("director")),
                    ("original_title", detail.get("original_title")),
                    ("poster", s.get("poster")),
                    ("length", detail.get("length") or s.get("length")),
                    ("release_year", detail.get("release_year") or s.get("release_year")),
                ):
                    if entry.get(field) is None and value is not None:
                        entry[field] = value
            return meta

        except Exception:
            logger.exception(f"[{CINEMA_NAME}] Błąd w trakcie scrapowania")
            raise
