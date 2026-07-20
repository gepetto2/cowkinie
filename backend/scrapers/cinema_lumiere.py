import logging
import re
from html import unescape
from curl_cffi import requests
from utils import parse_start_time, clean_title, normalize_lang
from db.database import upsert_cinema, upsert_movies_batch, upsert_screenings_chunked

logger = logging.getLogger(__name__)

# Cinema Lumiere (Suwałki) - jeden endpoint zwraca cały repertuar w polu repertoireEvents.
CITY = "Suwałki"
API_URL = "https://suwalki.cinema-lumiere.pl/MSI/mvc/pl/Repertoire/GetShortEventsWithFilters"
BOOKING_URL = "https://suwalki.cinema-lumiere.pl/MSI/Default.aspx?event_id={}&typetran=1"


def _strip_html(text: str):
    if not text:
        return None
    return unescape(re.sub(r"<[^>]+>", "", text)).strip() or None


def _title_and_lang(event_title: str):
    """Zdejmuje sufiks (napisy)/(dubbing) z tytułu i zwraca (czysty_tytuł, wersja_językowa)."""
    low = (event_title or "").lower()
    lang = "DUBBING" if "(dubbing)" in low else ("NAPISY" if "(napisy)" in low else None)
    title = re.sub(r"\s*\((?:napisy|dubbing)\)\s*$", "", event_title or "", flags=re.IGNORECASE)
    return clean_title(title), lang


async def scrape_and_save(supabase, cities=["Poznań"]):
    if CITY not in cities:
        logger.info("Pomijam Cinema Lumiere (Suwałki nie jest wśród wybranych miast).")
        return

    async with requests.AsyncSession(impersonate="chrome") as client:
        try:
            logger.info("Rozpoczynam scraping Cinema Lumiere (Suwałki)...")
            db_cinema_id = upsert_cinema(supabase, "Cinema Lumiere", CITY, "Kina Studyjne")

            resp = await client.get(API_URL, timeout=30.0, headers={"X-Requested-With": "XMLHttpRequest"})
            if resp.status_code != 200:
                logger.error(f"Błąd pobierania repertuaru Cinema Lumiere: {resp.status_code}")
                return
            events = resp.json().get("repertoireEvents", []) or []
            logger.info(f"Pobrano {len(events)} seansów z Cinema Lumiere.")
            if not events:
                logger.warning("Brak seansów w repertuarze Cinema Lumiere.")
                return

            # KROK 1: filmy (dane filmu są w zagnieżdżonym 'details' każdego eventu)
            movies_to_upsert = {}
            for ev in events:
                title, _lang = _title_and_lang(ev.get("eventTitle") or "")
                if not title or title in movies_to_upsert:
                    continue
                det = ev.get("details") or {}
                length = det.get("lengthInMinutes")
                movies_to_upsert[title] = {
                    "title": title,
                    "length_lumiere": length if isinstance(length, int) and length > 0 else None,
                    "description_lumiere": _strip_html(det.get("description")),
                    "genre_lumiere": (det.get("eventDetailType") or "").strip() or None,
                }

            movies_cache = upsert_movies_batch(supabase, movies_to_upsert)
            logger.info(f"Zapisano {len(movies_cache)} filmów Cinema Lumiere.")

            # KROK 2: seanse
            new_screenings = {}
            for ev in events:
                title, lang = _title_and_lang(ev.get("eventTitle") or "")
                movie_id = movies_cache.get(title)
                start_raw = ev.get("eventDateTime")
                if not movie_id or not start_raw:
                    continue

                start_time = parse_start_time(start_raw)
                # Dostępność z realnej liczby miejsc (Lumiere podaje wolne/łącznie)
                free = ev.get("msiFreeSeatsNumber")
                total = ev.get("msiTotalSeatsNumber")
                avail = round(free / total, 2) if isinstance(free, (int, float)) and isinstance(total, (int, float)) and total > 0 else None
                event_id = ev.get("eventId")

                # Lumiere nie podaje sali - room_name pusty
                screening_key = (movie_id, start_time, "")
                new_screenings[screening_key] = {
                    "movie_id": movie_id,
                    "cinema_id": db_cinema_id,
                    "start_time": start_time,
                    "room_name": "",
                    "lang": normalize_lang(lang),
                    "booking_link": BOOKING_URL.format(event_id) if event_id else None,
                    "availability_ratio": avail,
                }

            if new_screenings:
                upsert_screenings_chunked(supabase, new_screenings, "Cinema Lumiere")

            logger.info("Zakończono zapisywanie danych z Cinema Lumiere!")

        except Exception:
            logger.exception("[Cinema Lumiere] Błąd w trakcie scrapowania")
            raise
