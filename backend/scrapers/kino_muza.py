import logging
import asyncio
import re
from html import unescape
from curl_cffi import requests
from utils import parse_start_time, clean_title, normalize_lang, parse_release_date
from db.database import upsert_cinema, upsert_movies_batch, upsert_screenings_chunked, load_existing_movies

logger = logging.getLogger(__name__)

# Kino Muza (Poznań, studyjne) - repertuar jako JSON per dzień: /repertoire/day/{N}.json, N = offset dni.
BASE_URL = "https://www.kinomuza.pl/repertoire/day/{}.json"
DAYS_AHEAD = 45  # Muza publikuje repertuar ~5-6 tygodni w przód; nadmiar dni zwraca pusty repertuar
DAY_CHUNK = 10   # pobieramy dniami-porcjami; cała pusta porcja = koniec repertuaru (przerywamy dalsze)


def _strip_html(text: str):
    """Usuwa tagi HTML i dekoduje encje z opisu."""
    if not text:
        return None
    return unescape(re.sub(r"<[^>]+>", "", text)).strip() or None


def _muza_lang(item: dict):
    """Wersja językowa seansu z pól lang (audio) / subtitlesLang."""
    if item.get("lang") == "pl":
        return "PL"
    if item.get("subtitlesLang") == "pl":
        return "NAPISY"
    return None


def _muza_movie_type(item: dict):
    """Mapuje cykl/wydarzenie Muzy na movie_type. Na razie tylko 'Najlepsze z Najgorszych'."""
    text = f"{item.get('cycle') or ''} {item.get('event') or ''}".lower()
    if "najlepsze z najgorszych" in text:
        return "NAJLEPSZE Z NAJGORSZYCH"
    return None


def _extract_poster(page_html: str):
    """Wyciąga PIONOWY plakat ze strony filmu (thumb z JSON to poziomy kadr, nie plakat).
    Kolejno: nazwa z 'plakat' -> rozmiar plakatowy (B1/B2/A1) -> obraz w orientacji pionowej (H > W).
    Skanujemy też data-src (lazy-load)."""
    imgs = re.findall(r'(?:data-src|src)="([^"]+)"', page_html)
    uploads = [s for s in imgs if s.startswith("http") and "/uploads/" in s]

    for src in uploads:
        if "plakat" in src.lower():
            return src
    for src in uploads:
        if re.search(r"[-_](?:b1|b2|a1)[-_.]", src.lower()):
            return src
    for src in uploads:
        m = re.search(r"-(\d+)x(\d+)\.(?:jpg|jpeg|png|webp)", src, re.IGNORECASE)
        if m and int(m.group(2)) > int(m.group(1)):
            return src
    # 4. Oryginał bez sufiksu -WxH (WordPress generuje -WxH tylko dla poziomych kadrów; plakat bywa oryginałem)
    for src in uploads:
        if re.search(r"\.(?:jpg|jpeg|png|webp)$", src, re.IGNORECASE) and not re.search(r"-\d+x\d+\.", src, re.IGNORECASE):
            return src
    return None


async def _fetch_day(client: requests.AsyncSession, n: int, sem: asyncio.Semaphore, retries: int = 1) -> list:
    """Repertuar jednego dnia. Ponawiamy przy timeout/błędzie sieci (mały serwer Muzy bywa chwilowo
    przeciążony); status != 200 traktujemy jako brak dnia (bez ponawiania)."""
    async with sem:
        for attempt in range(retries + 1):
            try:
                resp = await client.get(BASE_URL.format(n), timeout=15.0)
                if resp.status_code == 200:
                    return resp.json().get("repertoire", []) or []
                return []
            except Exception as e:
                if attempt < retries:
                    await asyncio.sleep(0.5 * (attempt + 1))
                    continue
                logger.error(f"Błąd pobierania dnia +{n} (po {retries + 1} próbach): {e}")
        return []


async def _fetch_poster(client: requests.AsyncSession, title: str, movie_link: str, sem: asyncio.Semaphore):
    async with sem:
        try:
            resp = await client.get(movie_link, timeout=20.0)
            if resp.status_code == 200:
                return title, _extract_poster(resp.text)
        except Exception as e:
            logger.debug(f"Nie udało się pobrać plakatu dla '{title}' ({movie_link}): {e}")
        return title, None


async def scrape_and_save(supabase, cities=["Poznań"]):
    # Kino Muza jest wyłącznie w Poznaniu
    if "Poznań" not in cities:
        logger.info("Pomijam Kino Muza (Poznań nie jest wśród wybranych miast).")
        return

    async with requests.AsyncSession(impersonate="chrome") as client:
        try:
            logger.info("Rozpoczynam scraping Kina Muza (Poznań)...")
            db_cinema_id = upsert_cinema(supabase, "Kino Muza", "Poznań", "Kina Studyjne")

            # Serwer Muzy dławi się przy większej współbieżności (przy 5 częste timeouty i utrata dni).
            # Przy 2 równoległych żądaniach jest zarazem szybciej i bez timeoutów (zmierzone).
            sem = asyncio.Semaphore(2)

            logger.info(f"Pobieranie repertuaru (do {DAYS_AHEAD} dni)...")
            # Repertuar Muzy jest ciągły od dziś - pobieramy porcjami po DAY_CHUNK dni i przerywamy,
            # gdy cała porcja jest pusta (dalsze dni też będą puste). Skraca to czas i odciąża serwer,
            # gdy repertuar jest krótszy niż DAYS_AHEAD.
            items = []
            days_with_rep = 0
            for start in range(0, DAYS_AHEAD, DAY_CHUNK):
                batch = range(start, min(start + DAY_CHUNK, DAYS_AHEAD))
                results = await asyncio.gather(*[_fetch_day(client, n, sem) for n in batch])
                items.extend(it for day in results for it in day)
                days_with_rep += sum(1 for d in results if d)
                if not any(results):
                    break
            logger.info(f"Pobrano {len(items)} seansów z {days_with_rep} dni.")

            if not items:
                logger.warning("Brak seansów w repertuarze Kina Muza.")
                return

            # KROK 1: filmy (jeden wpis na tytuł; dane filmu są w każdym seansie)
            movies_to_upsert = {}
            movie_links = {}
            for it in items:
                title = clean_title(it.get("title") or "")
                if not title:
                    continue
                mtype = _muza_movie_type(it)
                # Typ jest per-seans; jeśli film już dodany, ale dotąd bez typu - uzupełnij z tego seansu
                if title in movies_to_upsert:
                    if mtype and not movies_to_upsert[title].get("movie_type_muza"):
                        movies_to_upsert[title]["movie_type_muza"] = mtype
                    continue
                movie_links[title] = it.get("movieLink")
                year = it.get("year")
                duration = it.get("duration")
                movies_to_upsert[title] = {
                    "title": title,
                    "movie_type_muza": mtype,
                    "release_year_muza": int(year) if year and str(year).isdigit() else None,
                    "release_date_muza": parse_release_date(it.get("premiereDate")),
                    "director_muza": (it.get("director") or "").strip() or None,
                    "original_title_muza": (it.get("originalTitle") or "").strip() or None,
                    "length_muza": int(duration) if duration and str(duration).isdigit() else None,
                    "poster_muza": None,  # uzupełnimy prawdziwym (pionowym) plakatem ze strony filmu
                    "description_muza": _strip_html(it.get("shortDesc") or it.get("desc")),
                }

            # KROK 2: prawdziwe plakaty ze stron filmów (thumb z repertuaru to poziomy kadr).
            # Pomijamy pobieranie strony filmu, jeśli plakat jest już w bazie (scrape bez czyszczenia).
            existing = load_existing_movies(supabase, ["poster_muza"])
            reused = 0
            to_fetch = []
            for title, link in movie_links.items():
                cached = existing.get(title, {}).get("poster_muza")
                if cached:
                    movies_to_upsert[title]["poster_muza"] = cached
                    reused += 1
                elif link:
                    to_fetch.append((title, link))
            logger.info(f"Plakaty: {reused} z bazy (pominięto), {len(to_fetch)} do pobrania ze stron filmów...")

            poster_tasks = [_fetch_poster(client, t, link, sem) for t, link in to_fetch]
            found = 0
            for i, coro in enumerate(asyncio.as_completed(poster_tasks), 1):
                title, poster = await coro
                if poster:
                    movies_to_upsert[title]["poster_muza"] = poster
                    found += 1
                if i % 10 == 0 or i == len(poster_tasks):
                    logger.info(f"  Plakaty: {i}/{len(to_fetch)} (znaleziono {found})")

            movies_cache = upsert_movies_batch(supabase, movies_to_upsert)
            logger.info(f"Zapisano {len(movies_cache)} filmów Kina Muza.")

            # KROK 3: seanse
            new_screenings = {}
            for it in items:
                title = clean_title(it.get("title") or "")
                movie_id = movies_cache.get(title)
                start_raw = it.get("datetime")
                if not movie_id or not start_raw:
                    continue

                start_time = parse_start_time(start_raw)
                room_name = it.get("hall") or ""

                screening_key = (movie_id, start_time, room_name)
                new_screenings[screening_key] = {
                    "movie_id": movie_id,
                    "cinema_id": db_cinema_id,
                    "start_time": start_time,
                    "room_name": room_name,
                    "lang": normalize_lang(_muza_lang(it)),
                    "booking_link": it.get("ticketLink") or None,
                    "format": "35mm" if it.get("tape35mm") else None,
                }

            if new_screenings:
                upsert_screenings_chunked(supabase, new_screenings, "Kino Muza")

            logger.info("Zakończono zapisywanie danych z Kina Muza!")

        except Exception:
            logger.exception("[Kino Muza] Błąd w trakcie scrapowania")
            raise
