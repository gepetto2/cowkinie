import logging
import asyncio
import json
import re
from html import unescape
from curl_cffi import requests
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from utils import parse_start_time, clean_title, get_valid_poster, normalize_lang, parse_release_date
from db.database import upsert_cinema, upsert_movies_batch, upsert_screenings_chunked, load_existing_movies

logger = logging.getLogger(__name__)


def _strip_html(text: str):
    """Usuwa tagi HTML i dekoduje encje z opisu (synopsis CC ma m.in. &nbsp;)."""
    if not text:
        return None
    return unescape(re.sub(r"<[^>]+>", "", text)).replace("\xa0", " ").strip() or None

# Mapowanie tokenów formatu/technologii z attributeIds na czytelną formę (spójną z Multikinem).
# Pozostałe attributeIds to gatunki, kategorie wiekowe, języki, typ foteli itp. - nie są formatem.
CC_FORMAT_MAP = {
    "2d": "2D", "3d": "3D",
    "imax": "IMAX", "imax-3d": "IMAX 3D",
    "4dx": "4DX", "4dx-3d": "4DX 3D", "4dx-2d": "4DX",
    "screenx": "ScreenX", "vip": "VIP",
    "dolby-atmos": "Dolby Atmos", "dbox": "D-BOX", "d-box": "D-BOX",
}

# Tokeny gatunków z attributeIds filmu -> polskie nazwy. Whitelist, bo attributeIds miesza
# gatunki z formatem/językiem/kategorią wiekową - nieznane tokeny ignorujemy.
CC_GENRE_MAP = {
    "action": "Akcja", "adventure": "Przygodowy", "animation": "Animacja", "anime": "Anime",
    "biography": "Biograficzny", "black-comedy": "Czarna komedia", "comedy": "Komedia",
    "crime": "Kryminał", "documentary": "Dokumentalny", "drama": "Dramat", "family": "Familijny",
    "fantasy": "Fantasy", "history": "Historyczny", "horror": "Horror", "musical": "Musical",
    "romance": "Romans", "sci-fi": "Sci-Fi", "thriller": "Thriller", "war": "Wojenny", "western": "Western",
}

async def get_target_cinemas(client: requests.AsyncSession, cities: list) -> list:
    """Pobiera listę kin Cinema City i filtruje te z wybranych miast."""
    # Używamy daty daleko w przyszłości, aby mieć pewność, że dostaniemy wszystkie kina, które mają jakiekolwiek wydarzenia
    until_date = (datetime.now(ZoneInfo("Europe/Warsaw")) + timedelta(days=365*2)).strftime("%Y-%m-%d")
    cinemas_url = f"https://www.cinema-city.pl/pl/data-api-service/v1/quickbook/10103/cinemas/with-event/until/{until_date}"

    logger.info("Pobieranie listy kin z Cinema City...")
    headers = {"Accept": "application/json"}
    try:
        response = await client.get(cinemas_url, headers=headers, timeout=60.0)
        response.raise_for_status()  # Rzuci wyjątkiem dla kodów 4xx/5xx

        data = response.json()
        all_cinemas = data.get("body", {}).get("cinemas", [])

        target_cinemas = [
            cinema for cinema in all_cinemas
            if cinema.get("addressInfo", {}).get("city") in cities
        ]

        logger.info(f"Znaleziono {len(target_cinemas)} kin dla miast: {', '.join(cities)}.")
        return target_cinemas

    except requests.errors.RequestsError as e:
        logger.error(f"Błąd HTTP podczas pobierania listy kin: {e}")
        return []
    except json.JSONDecodeError:
        logger.error("Błąd dekodowania JSON z listy kin.")
        return []

async def fetch_events_for_date(client: requests.AsyncSession, cinema_id_api, date, headers, sem: asyncio.Semaphore):
    """Funkcja pomocnicza do współbieżnego odpytywania API na dany dzień."""
    async with sem:
        events_url = f"https://www.cinema-city.pl/pl/data-api-service/v1/quickbook/10103/film-events/in-cinema/{cinema_id_api}/at-date/{date}"
        try:
            response = await client.get(events_url, headers=headers, timeout=60.0)
            if response.status_code == 200:
                return date, response.json()
        except Exception as e:
            logger.error(f"Błąd pobierania dnia {date}: {e}")
        return date, None

async def fetch_film_details(client: requests.AsyncSession, api_film_id: str, headers: dict, sem: asyncio.Semaphore):
    """Pobiera dodatkowe informacje o filmie z Cinema City (reżyser, oryginalny tytuł)."""
    async with sem:
        details_url = f"https://www.cinema-city.pl/pl/data-api-service/v1/10103/films/byDistributorCode/{api_film_id}"
        try:
            response = await client.get(details_url, headers=headers, timeout=30.0)
            if response.status_code == 200:
                data = response.json()
                film_details = data.get("body", {}).get("filmDetails", {})
                return api_film_id, film_details
        except Exception as e:
            logger.error(f"Błąd pobierania szczegółów filmu {api_film_id}: {e}")
        return api_film_id, None

async def scrape_and_save(supabase, cities=["Poznań"]):
    async with requests.AsyncSession(impersonate="chrome") as client:
        try:
            # KROK 1: Inicjalizacja sesji i pobranie ciasteczek
            logger.info("Nawiązywanie połączenia z Cinema City...")
            await client.get("https://www.cinema-city.pl/", timeout=60.0)

            # KROK 2: Pobranie kin
            target_cinemas = await get_target_cinemas(client, cities)
            if not target_cinemas:
                logger.info("Nie znaleziono kin lub wystąpił błąd. Zakończono.")
                return

            movies_cache = {}  # Pamięć podręczna dla pobranych/dodanych filmów z bazy
            global_film_details_cache = {}  # Pamięć dla szczegółów z API (reżyser, obsada, opis)
            # Filmy już w bazie - pozwala pominąć pobieranie szczegółów przy scrapie bez czyszczenia.
            # Bierzemy pola ze szczegółów; brak description_cc = szczegóły jeszcze niepobrane (dociągniemy).
            existing_cc = load_existing_movies(supabase, ["director_cc", "cast_cc", "description_cc"])

            sem = asyncio.Semaphore(10)  # Ograniczenie do max. 10 jednoczesnych połączeń

            # KROK 3: Iteracja po znalezionych kinach
            for cinema in target_cinemas:
                cinema_id_api = cinema.get("id")
                cinema_name = cinema.get("displayName")
                cinema_city = cinema.get("addressInfo", {}).get("city")

                if not cinema_id_api or not cinema_name:
                    continue

                logger.info(f"--- Rozpoczynam scraping dla: {cinema_name} (ID: {cinema_id_api}) ---")

                # Upsert kina w Supabase (wymaga nałożonego UNIQUE na kolumnach 'name, franchise')
                db_cinema_id = upsert_cinema(supabase, cinema_name, cinema_city, "Cinema City", "sieć")

                # Pobranie dostępnych dat
                until_date = (datetime.now(ZoneInfo("Europe/Warsaw")) + timedelta(days=365)).strftime("%Y-%m-%d")
                dates_url = f"https://www.cinema-city.pl/pl/data-api-service/v1/quickbook/10103/dates/in-cinema/{cinema_id_api}/until/{until_date}"

                logger.info("Pobieranie dostępnych dat...")
                headers = {"Accept": "application/json"}
                dates_response = await client.get(dates_url, headers=headers, timeout=60.0)

                if dates_response.status_code != 200:
                    logger.error(f"Błąd pobierania dat dla kina {cinema_name}: {dates_response.status_code}")
                    continue

                dates_data = dates_response.json()
                dates_list = (dates_data.get("body") or {}).get("dates", [])

                if not dates_list:
                    logger.info(f"Brak dostępnych dat w API dla kina {cinema_name}.")
                    continue

                logger.info(f"Znaleziono {len(dates_list)} dni z seansami. Pobieranie harmonogramów...")

                # Współbieżne pobieranie wydarzeń dla wszystkich dni
                tasks = [fetch_events_for_date(client, cinema_id_api, date, headers, sem) for date in dates_list]
                results = await asyncio.gather(*tasks)

                all_movies_to_upsert = {}
                all_films_api_list = []
                all_events_api_list = []

                # Rozpakowywanie wyników
                for date, events_data in results:
                    if not events_data:
                        continue
                    body = events_data.get("body") or {}
                    all_films_api_list.extend(body.get("films", []))
                    all_events_api_list.extend(body.get("events", []))

                # Filtrowanie unikalnych filmów i pobieranie brakujących szczegółów.
                # Pomijamy szczegóły tylko dla filmów, które mają już w bazie opis (czyli szczegóły
                # zostały wcześniej pobrane); resztę - w tym nowe i te sprzed dodania opisu/obsady - dociągamy.
                unique_films = {f["id"]: f for f in all_films_api_list if f.get("id")}.values()
                missing_details_ids = [
                    f["id"] for f in unique_films
                    if f["id"] not in global_film_details_cache
                    and not existing_cc.get(clean_title((f.get("name") or "").strip()), {}).get("description_cc")
                ]

                if missing_details_ids:
                    logger.info(f"Pobieranie dodatkowych szczegółów dla {len(missing_details_ids)} filmów...")
                    details_tasks = [fetch_film_details(client, film_id, headers, sem) for film_id in missing_details_ids]
                    details_results = await asyncio.gather(*details_tasks)
                    
                    for film_id, details in details_results:
                        if details is not None:
                            global_film_details_cache[film_id] = details

                for film in unique_films:
                    # Zabezpieczenie w przypadku braku 'name' w filmie
                    title = (film.get("name") or "").strip()
                    
                    movie_type_override = None
                    if re.search(r" - National Theatre Live \d{4}$", title):
                        movie_type_override = "TEATR"
                    elif re.match(r"^Ladies\s*Night\b", title, re.IGNORECASE):
                        # CC nie zawsze taguje seans atrybutem 'ladies-night' - łapiemy po prefiksie tytułu.
                        # Tytuł zostaje z prefiksem, by film nie skolidował po upsert(on_conflict=title) ze zwykłą wersją.
                        movie_type_override = "LADIES NIGHT/KNO"
                    title = clean_title(title)

                    if title and title not in movies_cache and title not in all_movies_to_upsert:
                        api_film_id = film.get("id")
                        details = global_film_details_cache.get(api_film_id, {})

                        attribute_ids = film.get("attributeIds", [])
                        type_mapping = {
                            "opera": "OPERA",
                            "marathon": "MARATON",
                            "music-event": "KONCERT",
                            "sport-event": "SPORT",
                            "sport": "SPORT",
                            "dubbed-lang-uk": "UKRAIŃSKI DUBBING",
                            "ladies-night": "LADIES NIGHT/KNO",
                            # Przedpremiera dla członków Unlimited - CC daje osobny rekord filmu z tym atrybutem
                            # (tytuł bywa "Unlimited Show: X" lub "UL - X", więc łapiemy po atrybucie, nie po tytule).
                            "unlimited-screening": "UNLIMITED SHOW"
                        }
                        movie_type = movie_type_override or next((val for key, val in type_mapping.items() if key in attribute_ids), None)

                        raw_release_year = film.get("releaseYear")
                        release_year = str(raw_release_year).replace('/', ',').split(',')[0].strip() if raw_release_year else None

                        # Dane ze szczegółów (reżyser/obsada/opis): ze świeżo pobranych, a dla pominiętych
                        # (znanych) filmów reużywamy wartości z bazy, by nie nadpisać ich nullem.
                        cached = existing_cc.get(title, {})
                        director_cc = details.get("directors") or cached.get("director_cc")
                        cast_cc = details.get("cast") or cached.get("cast_cc")
                        description_cc = _strip_html(details.get("synopsis")) or cached.get("description_cc")

                        # Gatunek: tokeny gatunków z attributeIds (bez dodatkowego zapytania), złączone przecinkiem
                        genres = [CC_GENRE_MAP[a] for a in attribute_ids if a in CC_GENRE_MAP]
                        genre_cc = ", ".join(dict.fromkeys(genres)) or None

                        all_movies_to_upsert[title] = {
                            "title": title,
                            "movie_type_cc": movie_type,
                            "length_cc": film.get("length"),
                            "poster_cc": get_valid_poster(film.get("posterLink")),
                            "release_year_cc": release_year,
                            "release_date_cc": parse_release_date(film.get("releaseDate")),
                            "director_cc": director_cc,
                            "cast_cc": cast_cc,
                            "description_cc": description_cc,
                            "genre_cc": genre_cc
                        }
                        
                # Zbiorczy Upsert wszystkich nowych filmów ze wszystkich dni
                if all_movies_to_upsert:
                    updated_cache = upsert_movies_batch(supabase, all_movies_to_upsert)
                    movies_cache.update(updated_cache)

                # Utworzenie mapy z API ID do BAZA ID
                film_id_map = {}
                lektor_film_ids = set()  # filmy z "LEKTOR" w tytule - ich seanse dostaną lang=LEKTOR
                for film in unique_films:
                    api_film_id = film.get("id")
                    raw_name = film.get("name") or ""
                    if api_film_id and re.search(r"\bLEKTOR\b", raw_name, re.IGNORECASE):
                        lektor_film_ids.add(api_film_id)

                    title = clean_title(raw_name.strip())

                    if api_film_id and title in movies_cache:
                        film_id_map[api_film_id] = movies_cache[title]
                
                new_screenings = {}
                for event in all_events_api_list:
                    api_film_id = event.get("filmId")
                    start_time_raw = event.get("eventDateTime")
                    room_name = event.get("auditorium")

                    if not api_film_id or not start_time_raw:
                        continue

                    start_time = parse_start_time(start_time_raw)

                    db_movie_id = film_id_map.get(api_film_id)
                    if not db_movie_id:
                        continue

                    attribute_ids = event.get("attributeIds", [])
                    lang = None
                    # "LEKTOR" jest w tytule filmu, nie w atrybutach (CC oznacza go jako 'dubbed') - nadpisujemy.
                    if api_film_id in lektor_film_ids:
                        lang = "LEKTOR"
                    elif "subbed" in attribute_ids:
                        lang = "NAPISY"
                    elif "dubbed" in attribute_ids:
                        lang = "DUBBING"
                    elif "original-lang-pl" in attribute_ids:
                        lang = "PL"
                    elif "original" in attribute_ids or any(a.startswith("original-lang-") for a in attribute_ids):
                        # Wersja oryginalna (obcojęzyczna, bez polskiego dubbingu/napisów)
                        lang = "ORYGINALNY"
                    lang = normalize_lang(lang)

                    # Format/technologia seansu (2D/3D/IMAX/4DX/ScreenX/VIP...) z attributeIds
                    # dict.fromkeys usuwa duplikaty zachowując kolejność
                    formats = [CC_FORMAT_MAP[a] for a in attribute_ids if a in CC_FORMAT_MAP]
                    screening_format = " ".join(dict.fromkeys(formats)) or None

                    screening_key = (db_movie_id, start_time, room_name)
                    new_screenings[screening_key] = {
                        "movie_id": db_movie_id,
                        "cinema_id": db_cinema_id,
                        "start_time": start_time,
                        "room_name": room_name,
                        "lang": lang,
                        "booking_link": event.get("bookingLink"),
                        "availability_ratio": event.get("availabilityRatio"),
                        "format": screening_format
                    }

                if new_screenings:
                    upsert_screenings_chunked(supabase, new_screenings, cinema_name)

            logger.info(f"Zakończono zapisywanie danych z Cinema City dla miast: {', '.join(cities)}!")

        except Exception:
            logger.exception("[Cinema City] Błąd w trakcie scrapowania")
            raise

if __name__ == "__main__":
    logger.info("Skrypt uruchom poprzez plik run_scrapers.py")