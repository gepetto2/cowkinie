import logging
import re
from datetime import datetime
from html import unescape
from zoneinfo import ZoneInfo
from curl_cffi import requests
from utils import parse_start_time, clean_title, ScraperError
from db.database import upsert_cinema, upsert_movies_batch, upsert_screenings_chunked

logger = logging.getLogger(__name__)

# Kino Bułgarska 19 (Poznań, studyjne). Brak API - repertuar renderowany serwerowo w HTML.
# Strona deklaruje UTF-8 i realnie jest w UTF-8. Repertuar to bogate <section class="clearfix">
# per seans, pogrupowane pod DATOWANYMI nagłówkami dni ("Wtorek, 28 lipca"); dalej jest kompaktowa
# kopia (krótkie nazwy dni), którą pomijamy. Krótki horyzont (~3 dni), brak online-bookingu.
REPERTOIRE_URL = "http://kinobulgarska19.pl/repertuar"
FILM_URL = "http://kinobulgarska19.pl/filmy/{}"

_PL_MONTHS = {
    "stycznia": 1, "lutego": 2, "marca": 3, "kwietnia": 4, "maja": 5, "czerwca": 6,
    "lipca": 7, "sierpnia": 8, "września": 9, "października": 10, "listopada": 11, "grudnia": 12,
}


def _parse_date(h3_text: str, now: datetime):
    """'Wtorek, 28 lipca' -> 'YYYY-MM-DD'. Rok bieżący; przy przełomie roku (miesiąc < obecnego) - następny."""
    m = re.search(r"(\d{1,2})\s+([a-ząćęłńóśźż]+)", h3_text.lower())
    if not m:
        return None
    day = int(m.group(1))
    month = _PL_MONTHS.get(m.group(2))
    if not month:
        return None
    year = now.year + 1 if month < now.month else now.year
    return f"{year:04d}-{month:02d}-{day:02d}"


def _title(raw: str):
    """Czysty, spójny z resztą kin tytuł: bez dopisków po en-dashu (Poznańska premiera / Kino dzieci),
    ALL CAPS -> zdanie (Bułgarska podaje tytuły wersalikami)."""
    t = unescape(raw or "").strip()
    t = re.split(r"\s+[–—-]\s+", t)[0].strip()  # dopiski są po myślniku
    t = clean_title(t)
    if t and t == t.upper():
        t = t.capitalize()
    return t


def _strip_html(text: str):
    if not text:
        return None
    return unescape(re.sub(r"<[^>]+>", "", text)).strip() or None


def _movie_type(raw_title: str):
    """movie_type z dopisku w tytule. Na razie tylko 'Kino Dzieci' -> DLA DZIECI (rozszerzalne)."""
    return "DLA DZIECI" if "kino dzieci" in (raw_title or "").lower() else None


def parse_repertoire(html: str, now: datetime):
    """Parsuje HTML repertuaru -> lista seansów (dict): date, time, slug, title, hall.
    Metadanych filmu NIE zbieramy (bierze je enrichment). Czysta funkcja (testowalna offline)."""
    out = []
    # Datowane nagłówki dni (zawierają 'DD miesiąc'); kompaktowa część niżej ma krótkie nazwy -> ją pomijamy.
    day_hdrs = list(re.finditer(r"<h3>([^<]*\d{1,2}\s+[a-ząćęłńóśźż]+[^<]*)</h3>", html, re.I))
    for idx, hdr in enumerate(day_hdrs):
        date = _parse_date(hdr.group(1), now)
        if not date:
            continue
        end = day_hdrs[idx + 1].start() if idx + 1 < len(day_hdrs) else len(html)
        block = html[hdr.end():end]
        for sec in re.findall(r'<section class="clearfix">(.*?)</section>', block, re.S):
            m_time = re.search(r'start-info clock">([\d\s:]+)<', sec)
            m_film = re.search(r'/filmy/([^"/]+)"[^>]*>([^<]+)</a>', sec)
            if not m_time or not m_film:
                continue
            raw_title = m_film.group(2)
            title = _title(raw_title)
            if not title:
                continue
            m_hall = re.search(r'show-type-badge[^>]*>\s*<a[^>]*>([^<]+)</a>', sec)
            out.append({
                "date": date,
                "time": re.sub(r"\s+", "", m_time.group(1)),  # '13 : 10' -> '13:10'
                "slug": m_film.group(1).strip(),
                "title": title,
                "movie_type": _movie_type(raw_title),  # np. 'Kino Dzieci' -> DLA DZIECI (przed ucięciem dopisku)
                "hall": _strip_html(m_hall.group(1)) if m_hall else None,
            })
    return out


async def scrape_and_save(supabase, cities=["Poznań"]):
    # Kino Bułgarska 19 jest wyłącznie w Poznaniu
    if "Poznań" not in cities:
        logger.info("Pomijam Kino Bułgarska (Poznań nie jest wśród wybranych miast).")
        return

    async with requests.AsyncSession(impersonate="chrome") as client:
        try:
            logger.info("Rozpoczynam scraping Kina Bułgarska 19 (Poznań)...")
            db_cinema_id = upsert_cinema(supabase, "Kino Bułgarska 19", "Poznań", "Kino Bułgarska 19", "studyjne")

            resp = await client.get(REPERTOIRE_URL, timeout=30.0)
            if resp.status_code != 200:
                raise ScraperError(f"Kino Bułgarska 19: repertuar zwrócił HTTP {resp.status_code}.")
            shows = parse_repertoire(resp.text, datetime.now(ZoneInfo("Europe/Warsaw")))
            if not shows:
                raise ScraperError("Kino Bułgarska 19: nie sparsowano żadnego seansu - zmiana struktury strony?")

            # KROK 1: filmy - tytuł + movie_type (Kino Dzieci -> DLA DZIECI). Pozostałe metadane (plakat,
            # długość, reżyser, gatunek, opis) bierze enrichment (TMDB/Filmweb), by nie mnożyć kolumn
            # per-małe-kino. Małe kina studyjne wnoszą przede wszystkim SEANSE + kategoryzację.
            movies_to_upsert = {}
            for s in shows:
                entry = movies_to_upsert.setdefault(s["title"], {"title": s["title"], "movie_type_bulgarska": None})
                if s["movie_type"] and not entry["movie_type_bulgarska"]:
                    entry["movie_type_bulgarska"] = s["movie_type"]
            movies_cache = upsert_movies_batch(supabase, movies_to_upsert)
            logger.info(f"Zapisano {len(movies_cache)} filmów Kina Bułgarska.")

            # KROK 2: seanse
            new_screenings = {}
            for s in shows:
                movie_id = movies_cache.get(s["title"])
                if not movie_id:
                    continue
                start_time = parse_start_time(f"{s['date']}T{s['time']}:00")
                room_name = s["hall"] or ""
                screening_key = (movie_id, start_time, room_name)
                new_screenings[screening_key] = {
                    "movie_id": movie_id,
                    "cinema_id": db_cinema_id,
                    "start_time": start_time,
                    "room_name": room_name,
                    "booking_link": FILM_URL.format(s["slug"]),
                    # Kino studyjne - bez rozbicia na formaty/wersje; przyjmujemy 2D.
                    "format": "2D",
                }

            if new_screenings:
                upsert_screenings_chunked(supabase, new_screenings, "Kino Bułgarska 19")

            logger.info("Zakończono zapisywanie danych z Kina Bułgarska 19!")

        except Exception:
            logger.exception("[Bułgarska] Błąd w trakcie scrapowania")
            raise
