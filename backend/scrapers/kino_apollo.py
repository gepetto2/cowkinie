import logging
import re
import asyncio
from html import unescape
from datetime import datetime
from zoneinfo import ZoneInfo
from curl_cffi import requests
from utils import clean_title
from db.database import upsert_cinema, upsert_movies_batch, upsert_screenings_chunked

logger = logging.getLogger(__name__)

# Kino Apollo (Poznań, studyjne). Strona WordPress bez API repertuaru, ale:
# - lista TYLKO filmowych seansów (odsiane teatr/koncerty/stand-up) jest pod JSF-em z paginacją,
# - czyste dane seansu (tytuł z datą, link biletowy) są w REST CPT 'repertuar',
# - plakat/opis filmu w REST CPT 'kino'.
CITY = "Poznań"
FILM_LISTING = "https://kinoapollo.pl/kino/?jsf=jet-engine:repertuar&pagenum={}"
REST = "https://kinoapollo.pl/wp-json/wp/v2"
MAX_PAGES = 20


def _strip_html(text: str):
    if not text:
        return None
    return unescape(re.sub(r"<[^>]+>", "", text)).strip() or None


def _match_key(title: str):
    """Klucz do dopasowania seans->film: bez sufiksów (rok), '– wersja/seans...', bez diakrytyków."""
    t = unescape(title or "")
    t = re.sub(r"\s*\((?:19|20)\d\d\)\s*$", "", t)                       # (1995)
    t = re.sub(r"\s*[–—-]\s*(?:wersja|seans|pokaz|napisy|dubbing|premiera|spotkanie).*$", "", t, flags=re.I)
    return re.sub(r"\s+", " ", t).strip().lower()


def _clean_apollo_name(name: str):
    """Zdejmuje z tytułu Apollo dopiski i zwraca (czysta_nazwa, rok_produkcji, movie_type):
    - 'NzN' (np. 'Big Shark NzN') = Najlepsze z Najgorszych -> movie_type,
    - rok w nawiasie (np. 'Milczenie owiec (1991)') -> rok produkcji (i lepszy tytuł do dopasowania/TMDB)."""
    movie_type = None
    if re.search(r"[,\s]+NzN\s*$", name, flags=re.IGNORECASE):
        movie_type = "NAJLEPSZE Z NAJGORSZYCH"
        name = re.sub(r"[,\s]+NzN\s*$", "", name, flags=re.IGNORECASE)

    year = None
    m = re.search(r"\s*\((\d{4})\)\s*$", name)
    if m:
        yr = int(m.group(1))
        if 1900 <= yr <= 2100:
            year = yr
            name = name[:m.start()].rstrip()
    return name.strip(), year, movie_type


def _screening_from_post(post: dict):
    """Z posta 'repertuar' wyciąga (booking_id, tytuł, start_time, rok, movie_type) albo None (zniekształcony)."""
    raw = unescape((post.get("title") or {}).get("rendered") or "")
    link = post.get("link-do-biletow") or ""
    m_id = re.search(r"/id/(\d+)", link)
    booking_id = m_id.group(1) if m_id else None

    # Tytuł: "Nazwa YYYY-MM-DD HH:MM:SS ID" lub "Nazwa YYYY-MM-DD godz. HH:MM (ID)"
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})\s*(?:godz\.?\s*)?(\d{1,2})[:.](\d{2})", raw)
    if not m:
        return None
    y, mo, d, hh, mm = (int(x) for x in m.groups())
    start_time = datetime(y, mo, d, hh, mm, tzinfo=ZoneInfo("Europe/Warsaw")).isoformat()

    name = re.sub(r"\s*\d{4}-\d{2}-\d{2}.*$", "", raw).strip(" –—-")
    name, year, movie_type = _clean_apollo_name(name)
    name = clean_title(name)
    if not name or name.isdigit():
        return None
    return booking_id, name, start_time, year, movie_type


async def _fetch_json(client, url):
    resp = await client.get(url, timeout=40.0)
    if resp.status_code == 200:
        return resp.json()
    return None


async def _film_booking_ids(client) -> set:
    """Paginuje listę TYLKO filmową (JSF) i zbiera ID seansów biletowych = whitelist filmów."""
    ids = set()
    for pg in range(1, MAX_PAGES + 1):
        try:
            resp = await client.get(FILM_LISTING.format(pg), timeout=40.0)
        except Exception as e:
            logger.error(f"[Apollo] Błąd pobierania listy filmowej str {pg}: {e}")
            break
        if resp.status_code != 200:
            break
        page_ids = set(re.findall(r"event/view/id/(\d+)", resp.text))
        if not (page_ids - ids):  # brak nowych = koniec paginacji
            break
        ids |= page_ids
    return ids


async def _fetch_all(client, cpt: str, fields: str) -> list:
    """Pobiera wszystkie posty danego CPT z REST (paginacja po 100)."""
    out = []
    for page in range(1, 30):
        data = await _fetch_json(client, f"{REST}/{cpt}?per_page=100&page={page}&_fields={fields}")
        if not data:
            break
        out.extend(data)
        if len(data) < 100:
            break
    return out


async def scrape_and_save(supabase, cities=["Poznań"]):
    if CITY not in cities:
        logger.info("Pomijam Kino Apollo (Poznań nie jest wśród wybranych miast).")
        return

    async with requests.AsyncSession(impersonate="chrome") as client:
        try:
            logger.info("Rozpoczynam scraping Kina Apollo (Poznań)...")
            db_cinema_id = upsert_cinema(supabase, "Kino Apollo", CITY, "Kino Apollo", "studyjne")

            # Whitelist filmowych seansów + dane seansów + filmy (plakat/opis) - równolegle
            film_ids, rep_posts, kino_posts = await asyncio.gather(
                _film_booking_ids(client),
                _fetch_all(client, "repertuar", "id,title,link-do-biletow"),
                _fetch_all(client, "kino", "id,title,plakat,opis"),
            )
            logger.info(f"Kino Apollo: {len(film_ids)} filmowych seansów (whitelist), {len(rep_posts)} postów repertuaru, {len(kino_posts)} filmów.")
            if not film_ids:
                logger.warning("Brak filmowych seansów Kina Apollo (whitelist pusta).")
                return

            # Mapa dopasowania: klucz tytułu -> plakat/opis z CPT 'kino'
            kino_by_key = {}
            for k in kino_posts:
                key = _match_key((k.get("title") or {}).get("rendered") or "")
                if key and key not in kino_by_key:
                    kino_by_key[key] = k

            # KROK 1: filmy + seanse z 'repertuar' ograniczone do whitelisty filmowej
            movies_to_upsert = {}
            parsed = []  # (title, start_time, booking_link)
            for post in rep_posts:
                sc = _screening_from_post(post)
                if not sc:
                    continue
                booking_id, title, start_time, year, movie_type = sc
                if not booking_id or booking_id not in film_ids:
                    continue  # nie-film (teatr/koncert) albo poza whitelistą
                booking_link = post.get("link-do-biletow") or None
                parsed.append((title, start_time, booking_link))

                if title not in movies_to_upsert:
                    km = kino_by_key.get(_match_key(title))
                    movies_to_upsert[title] = {
                        "title": title,
                        "poster_apollo": (km or {}).get("plakat") or None,
                        "description_apollo": _strip_html((km or {}).get("opis")),
                        "release_year_apollo": year,
                        "movie_type_apollo": movie_type,
                    }

            if not parsed:
                logger.warning("Kino Apollo: brak seansów po dopasowaniu do whitelisty.")
                return

            movies_cache = upsert_movies_batch(supabase, movies_to_upsert)
            logger.info(f"Zapisano {len(movies_cache)} filmów Kina Apollo.")

            # KROK 2: seanse
            new_screenings = {}
            for title, start_time, booking_link in parsed:
                movie_id = movies_cache.get(title)
                if not movie_id:
                    continue
                screening_key = (movie_id, start_time, "")
                new_screenings[screening_key] = {
                    "movie_id": movie_id,
                    "cinema_id": db_cinema_id,
                    "start_time": start_time,
                    "room_name": "",
                    "booking_link": booking_link,
                }

            if new_screenings:
                upsert_screenings_chunked(supabase, new_screenings, "Kino Apollo")

            logger.info("Zakończono zapisywanie danych z Kina Apollo!")

        except Exception:
            logger.exception("[Kino Apollo] Błąd w trakcie scrapowania")
            raise
