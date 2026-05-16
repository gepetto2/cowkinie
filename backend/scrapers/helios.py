import re
import asyncio
from curl_cffi import requests
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from utils import parse_start_time
from database import upsert_cinema, upsert_movies_batch, upsert_screenings_chunked

def clean_title(title: str) -> str:
    if not title:
        return ""
    # Usuwa przedrostek w stylu "NT Live: "
    title = re.sub(r'^NT Live:\s*', '', title, flags=re.IGNORECASE)
    # Usuwa dopisek w stylu " 40. Rocznica" lub ". 30. Rocznica"
    title = re.sub(r'(?:\.\s*)?\s*\d+\.?\s*[Rr]ocznica\b.*$', '', title, flags=re.IGNORECASE)
    return title.strip()

async def get_target_cinemas(client: requests.AsyncSession, cities: list) -> list:
    """Pobiera listę kin Helios z API v1 i filtruje te z wybranych miast."""
    cinemas_url = "https://api.helios.pl/api/v1/cinemas"
    
    print("Pobieranie listy kin z Heliosa...")
    try:
        response = await client.get(cinemas_url, timeout=30.0)
        if response.status_code != 200:
            print(f"Błąd pobierania listy kin (Kod {response.status_code})")
            return []
            
        all_cinemas = response.json().get("data", [])
        
        target_cinemas = [
            cinema for cinema in all_cinemas
            if cinema.get("location", {}).get("city") in cities
        ]
        
        print(f"Znaleziono {len(target_cinemas)} kin dla miast: {', '.join(cities)}.")
        return target_cinemas
        
    except Exception as e:
        print(f"Błąd podczas pobierania listy kin: {e}")
        return []

async def fetch_movie_details(client: requests.AsyncSession, movie_id: str, sem: asyncio.Semaphore) -> tuple:
    """Pobiera szczegółowe informacje o filmie z REST API za pomocą UUID."""
    async with sem:
        url = f"https://restapi.helios.pl/api/movie/{movie_id}"
        try:
            resp = await client.get(url, timeout=30.0)
            if resp.status_code == 200:
                return movie_id, resp.json()
        except Exception as e:
            print(f"Błąd pobierania szczegółów filmu (ID: {movie_id}): {e}")
        return movie_id, {}

async def scrape_and_save(supabase, cities=["Poznań"]):
    async with requests.AsyncSession(impersonate="chrome") as client:
        try:
            print("Nawiązywanie połączenia z Heliosem...")
            target_cinemas = await get_target_cinemas(client, cities)
            
            if not target_cinemas:
                print("Nie znaleziono kin Heliosa lub wystąpił błąd. Zakończono.")
                return
                
            db_movies_cache = {}
            global_movie_details_cache = {}
            sem = asyncio.Semaphore(15)
            
            # Ustawienie ram czasowych
            now = datetime.now(ZoneInfo("Europe/Warsaw"))
            date_from = now.strftime("%Y-%m-%dT00:00:00.000")
            date_to = (now + timedelta(days=365)).strftime("%Y-%m-%dT23:59:59.999")

            for cinema in target_cinemas:
                cinema_uuid = cinema.get("sourceId") 
                cinema_name = cinema.get("name")
                cinema_city = cinema.get("location", {}).get("city")
                cinema_int_id = cinema.get("id")
                
                if not cinema_uuid or not cinema_name:
                    continue
                    
                print(f"\n--- Rozpoczynam scraping dla: {cinema_name} ---")
                
                # Zapis kina do bazy
                db_cinema_id = upsert_cinema(supabase, cinema_name, cinema_city, "Helios")
                
                # 1. Pobranie sal (Screen mapping)
                screens_mapping = {}
                try:
                    screens_url = f"https://restapi.helios.pl/api/cinema/{cinema_uuid}/screen"
                    screens_resp = await client.get(screens_url, timeout=30.0)
                    if screens_resp.status_code == 200:
                        for screen in screens_resp.json():
                            screens_mapping[screen["id"]] = screen.get("name", "")
                except Exception as e:
                    print(f"Błąd pobierania sal: {e}")

                # 2. Pobranie zwykłych seansów i wydarzeń
                screenings_data, events_data, v1_screenings_data = [], [], {}
                try:
                    screenings_url = f"https://restapi.helios.pl/api/cinema/{cinema_uuid}/screening?dateTimeFrom={date_from}&dateTimeTo={date_to}"
                    events_url = f"https://restapi.helios.pl/api/cinema/{cinema_uuid}/event?dateTimeFrom={date_from}&dateTimeTo={date_to}"
                    v1_screenings_url = f"https://api.helios.pl/api/v1/cinemas/{cinema_int_id}/screenings"
                    
                    scr_resp, ev_resp, v1_resp = await asyncio.gather(
                        client.get(screenings_url, timeout=30.0),
                        client.get(events_url, timeout=30.0),
                        client.get(v1_screenings_url, timeout=30.0)
                    )
                    
                    if scr_resp.status_code == 200: screenings_data = scr_resp.json()
                    if ev_resp.status_code == 200: events_data = ev_resp.json()
                    if v1_resp.status_code == 200: v1_screenings_data = v1_resp.json()
                except Exception as e:
                    print(f"Błąd pobierania harmonogramu: {e}")

                if not screenings_data and not events_data:
                    print(f"Brak seansów dla {cinema_name}.")
                    continue

                # 3. Rozwiązanie brakujących tytułów filmów ze zwykłych seansów i wydarzeń
                unique_movie_ids = {s.get("movieId") for s in screenings_data if s.get("movieId")}
                for ev in events_data:
                    items = ev.get("items", [])
                    if items and items[0].get("movieId"):
                        unique_movie_ids.add(items[0].get("movieId"))
                        
                missing_movie_ids = {mid for mid in unique_movie_ids if mid not in global_movie_details_cache}
                if missing_movie_ids:
                    fetch_tasks = [fetch_movie_details(client, mid, sem) for mid in missing_movie_ids]
                    movie_details_results = await asyncio.gather(*fetch_tasks)
                    global_movie_details_cache.update(dict(movie_details_results))

                # 4. Tworzenie mapowania sourceId (UUID) -> movie_type na podstawie API v1
                v1_movie_types = {}
                v1_data = v1_screenings_data.get("data", {})
                
                for category in ["events", "movies"]:
                    for item_id, details in v1_data.get(category, {}).items():
                        if not isinstance(details, dict):
                            continue
                        
                        source_id = details.get("sourceId")
                        if not source_id:
                            continue
                            
                        flags = details.get("flags", [])
                        flags_upper = [f.upper() if isinstance(f, str) else f.get("name", "").upper() for f in flags]
                        genres = [g.get("name", "").lower() for g in details.get("genres", [])]
                        
                        movie_type = None
                        if "HELIOS NA SCENIE" in flags_upper:
                            if "wydarzenie cyrkowe" in genres:
                                movie_type = "CYRK"
                            elif "spektakl teatralny" in genres:
                                movie_type = "TEATR"
                            else:
                                movie_type = "KONCERT"
                        elif "HELIOS SPORT" in flags_upper: movie_type = "SPORT"
                        elif "MARATON FILMOWY" in flags_upper: movie_type = "MARATON"
                        elif "HELIOS REPLAY" in flags_upper: movie_type = "KULTOWE"
                        elif "KINO KOBIET" in flags_upper: movie_type = "LADIES NIGHT/KNO"
                        elif "HELIOS ANIME" in flags_upper: movie_type = "ANIME"
                        elif "WERSJA JĘZYKOWA UA" in flags_upper: movie_type = "UKRAIŃSKI DUBBING"
                            
                        if movie_type:
                            v1_movie_types[source_id] = movie_type

                # 5. Upsertowanie filmów z events i screenings
                movies_to_upsert = {}
                event_titles = {}
                
                for ev in events_data:
                    movie_info = {}
                    items = ev.get("items", [])
                    if items and items[0].get("movieId"):
                        movie_info = global_movie_details_cache.get(items[0].get("movieId"), {})
                        
                    movie_type = None
                    event_tags = [
                        t.get("symbol", "").upper() 
                        for tg in ev.get("tagGroups", []) 
                        for t in tg.get("tags", [])
                    ]
                    event_genres = [g.get("name", "").lower() for g in ev.get("genres", [])]
                    
                    if "HELIOS NA SCENIE" in event_tags:
                        if "wydarzenie cyrkowe" in event_genres:
                            movie_type = "CYRK"
                        elif "spektakl teatralny" in event_genres:
                            movie_type = "TEATR"
                        else:
                            movie_type = "KONCERT"
                    elif "HELIOS SPORT" in event_tags: movie_type = "SPORT"
                    elif "MARATON FILMOWY" in event_tags: movie_type = "MARATON"
                    elif "HELIOS REPLAY" in event_tags: movie_type = "KULTOWE"
                    elif "KINO KOBIET" in event_tags: movie_type = "LADIES NIGHT/KNO"
                    elif "HELIOS ANIME" in event_tags: movie_type = "ANIME"

                    event_source_id = ev.get("id")
                    if not movie_type:
                        movie_type = v1_movie_types.get(event_source_id)
                        
                    # Ustalanie czystego tytułu (usuwanie dopisków dla specjalnych pokazów)
                    if movie_type in ["MARATON", "SPORT", "LADIES NIGHT/KNO"]:
                        title = ev.get("name")
                    else:
                        title = movie_info.get("title") or (items[0].get("movieName") if items else None) or ev.get("name")
                        
                    title = clean_title(title)

                    if not title:
                        continue
                        
                    scr_id = ev.get("screeningId") or ev.get("id")
                    if scr_id:
                        event_titles[scr_id] = title
                        
                    if title in db_movies_cache or title in movies_to_upsert:
                        continue
                        
                    posters = ev.get("posters") or movie_info.get("posters") or []
                    
                    movies_to_upsert[title] = {
                        "title": title,
                        "movie_type_helios": movie_type,
                        "length_helios": ev.get("duration") or movie_info.get("duration"),
                        "poster_helios": posters[0] if posters else None,
                        "release_year_helios": movie_info.get("yearOfProduction"),
                        "director_helios": movie_info.get("director"),
                        "original_title_helios": movie_info.get("originalTitle")
                    }

                for scr in screenings_data:
                    scr_movie_id = scr.get("movieId")
                    movie_info = global_movie_details_cache.get(scr_movie_id, {})
                    title = movie_info.get("title")
                    title = clean_title(title)
                    
                    if not title or title in db_movies_cache or title in movies_to_upsert:
                        continue
                    
                    movie_type = v1_movie_types.get(scr_movie_id)
                    posters = movie_info.get("posters") or []

                    movies_to_upsert[title] = {
                        "title": title,
                        "movie_type_helios": movie_type,
                        "length_helios": movie_info.get("duration"),
                        "poster_helios": posters[0] if posters else None,
                        "release_year_helios": movie_info.get("yearOfProduction"),
                        "director_helios": movie_info.get("director"),
                        "original_title_helios": movie_info.get("originalTitle")
                    }

                if movies_to_upsert:
                    updated_db_cache = upsert_movies_batch(supabase, movies_to_upsert)
                    db_movies_cache.update(updated_db_cache)

                # 5. Generowanie seansów
                new_screenings = {}
                all_sessions = screenings_data + events_data

                for session in all_sessions:
                    scr_id = session.get("screeningId") or session.get("id")
                    
                    # Odkodowanie odpowiedniego tytułu dla seansu
                    if "items" in session:
                        title = event_titles.get(scr_id)
                    else:
                        title = global_movie_details_cache.get(session.get("movieId"), {}).get("title")
                        title = clean_title(title)
                        
                    start_time_raw = session.get("timeFrom") or session.get("screeningTimeFrom")

                    if not title or not start_time_raw or not scr_id:
                        continue

                    db_movie_id = db_movies_cache.get(title)
                    if not db_movie_id:
                        continue

                    start_time = parse_start_time(start_time_raw)
                    screen_id = session.get("screenId")
                    room_name = screens_mapping.get(screen_id, "") if screen_id else ""

                    max_occ = session.get("maxOccupancy") or 0
                    aud = session.get("audience") or 0
                    avail_ratio = round(max(0.0, (max_occ - aud) / max_occ), 2) if max_occ > 0 else 1.0

                    # Pobieranie języka
                    lang_raw = session.get("speakingType")
                    if not lang_raw and session.get("items") and len(session.get("items")) > 0:
                        lang_raw = session.get("items")[0].get("speakingType")
                    
                    lang = lang_raw.upper() if lang_raw else None

                    screening_key = (db_movie_id, db_cinema_id, start_time, room_name)
                    new_screenings[screening_key] = {
                        "movie_id": db_movie_id,
                        "cinema_id": db_cinema_id,
                        "start_time": start_time,
                        "room_name": room_name,
                        "booking_link": f"https://bilety.helios.pl/screen/{scr_id}?cinemaId={cinema_uuid}",
                        "lang": lang,
                        "availability_ratio": avail_ratio
                    }

                if new_screenings:
                    upsert_screenings_chunked(supabase, new_screenings, cinema_name)

            print("\nZakończono zapisywanie danych z Heliosa!")

        except Exception as e:
            print(f"Wystąpił błąd w trakcie scrapowania Heliosa: {str(e)}")
