import logging
import re
from datetime import datetime
from html import unescape
from zoneinfo import ZoneInfo
from curl_cffi import requests
from utils import parse_start_time, clean_title, ScraperError
from core.small_sources import parse_credits, html_to_text
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


# Wpisy, które NIE są seansem. Kino ogłasza przerwę techniczną jako zwykłą pozycję repertuaru
# ("KINO NIECZYNNE - PRZERWA TECHNICZNA", godzina 00:00, jedna na każdy dzień zamknięcia), więc bez
# tego filtra trafiała do bazy jako film z pięcioma seansami.
#
# Filtrujemy po TYTULE, choć strukturalnie te wpisy też się wyróżniają (brak plakietki sali i linii
# `movie-meta` z reżyserem). Powód: gdy zawiedzie filtr tytułowy, do bazy trafi jeden zbędny wpis -
# rzuca się w oczy i łatwo poprawić. Gdyby zawiódł filtr strukturalny, po cichu zniknąłby prawdziwy
# seans filmu, który akurat nie ma podanego reżysera.
_NOT_A_SCREENING = re.compile(r"kino\s+nieczynne|przerwa\s+techniczna", re.IGNORECASE)


def _movie_type(raw_title: str):
    """movie_type z dopisku w tytule. Na razie tylko 'Kino Dzieci' -> DLA DZIECI (rozszerzalne)."""
    return "DLA DZIECI" if "kino dzieci" in (raw_title or "").lower() else None


def parse_repertoire(html: str, now: datetime):
    """Parsuje HTML repertuaru -> (lista seansów, liczba komunikatów o zamknięciu).

    Seans to dict: date, time, slug, title, hall. Metadanych filmu NIE zbieramy (bierze je
    enrichment). Drugi element odróżnia kino nieczynne od zmiany struktury strony - przy przerwie
    technicznej strona ma komplet sekcji dni, tylko w każdej stoi komunikat zamiast filmu.
    Czysta funkcja (testowalna offline)."""
    out, closed = [], 0
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
            if _NOT_A_SCREENING.search(unescape(raw_title)):
                closed += 1
                continue
            title = _title(raw_title)
            if not title:
                continue
            m_hall = re.search(r'show-type-badge[^>]*>\s*<a[^>]*>([^<]+)</a>', sec)
            # Linia 'reż. …' jest na stronie repertuaru, którą i tak pobieramy - zero dodatkowych żądań.
            director, year, length = parse_credits(html_to_text(sec))
            out.append({
                "date": date,
                "time": re.sub(r"\s+", "", m_time.group(1)),  # '13 : 10' -> '13:10'
                "slug": m_film.group(1).strip(),
                "title": title,
                "movie_type": _movie_type(raw_title),  # np. 'Kino Dzieci' -> DLA DZIECI (przed ucięciem dopisku)
                "hall": _strip_html(m_hall.group(1)) if m_hall else None,
                "director": director,
                "release_year": year,
                "length": length,
            })
    return out, closed


async def scrape_and_save(supabase):
    async with requests.AsyncSession(impersonate="chrome") as client:
        try:
            logger.info("Rozpoczynam scraping Kina Bułgarska 19 (Poznań)...")
            db_cinema_id = upsert_cinema(supabase, "Kino Bułgarska 19", "Poznań", "Kino Bułgarska 19", "studyjne")

            resp = await client.get(REPERTOIRE_URL, timeout=30.0)
            if resp.status_code != 200:
                raise ScraperError(f"Kino Bułgarska 19: repertuar zwrócił HTTP {resp.status_code}.")
            shows, closed = parse_repertoire(resp.text, datetime.now(ZoneInfo("Europe/Warsaw")))
            if not shows:
                # Pustka ma dwie przyczyny. Gdy wszystkie wpisy to komunikaty ("kino nieczynne",
                # "przerwa techniczna"), zero seansów jest PRAWDZIWĄ odpowiedzią - kino jest zamknięte
                # i zgłoszenie awarii byłoby fałszywym alarmem (a ten blokuje kasowanie osieroconych
                # filmów w całym przebiegu). Dopiero brak rozpoznanych wpisów znaczy, że strona się zmieniła.
                if closed:
                    logger.info("Kino Bułgarska 19: kino nieczynne (%s dni z komunikatem) - brak seansów.", closed)
                    return
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

            # Reżyser, rok i długość idą do wspólnych kolumn małych kin - scalaniem po priorytecie
            # zajmuje się core/small_sources.py po zakończeniu wszystkich scraperów.
            meta = {}
            for s in shows:
                entry = meta.setdefault(s["title"], {})
                for field in ("director", "release_year", "length"):
                    if entry.get(field) is None and s.get(field) is not None:
                        entry[field] = s[field]
            return meta

        except Exception:
            logger.exception("[Bułgarska] Błąd w trakcie scrapowania")
            raise
