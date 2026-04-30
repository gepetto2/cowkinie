import re
import execjs
from curl_cffi import requests
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from utils import parse_start_time
from database import upsert_cinema, upsert_movies_batch, upsert_screenings_chunked

async def fetch_nuxt_state(client: requests.AsyncSession, url: str) -> dict:
    """Pobiera i dekoduje stan window.__NUXT__ ze wskazanej strony."""
    try:
        response = await client.get(url, timeout=60.0)
        if response.status_code != 200:
            print(f"Błąd HTTP {response.status_code} dla {url}")
            return {}
            
        match = re.search(r'window\.__NUXT__=(.*?);</script>', response.text, re.DOTALL)
        if not match:
            return {}
            
        return execjs.eval(match.group(1))
    except Exception as e:
        print(f"Błąd pobierania/parsowania {url}: {e}")
        return {}

async def get_target_cinemas(client: requests.AsyncSession, cities: list) -> list:
    """Pobiera listę kin Helios poprzez parsowanie obiektu stanu window.__NUXT__."""
    print("Pobieranie listy kin z Helios (parsowanie window.__NUXT__)...")
    nuxt_state = await fetch_nuxt_state(client, "https://helios.pl/")
    cinemas_data = nuxt_state.get("state", {}).get("core", {}).get("cinemas", [])

    target_cinemas = [
        {
            "id": c.get("sourceId"),
            "name": c.get("name"),
            "city": c.get("city"),
            "slug_city": c.get("slugCity"),
            "slug": c.get("slug")
        }
        for c in cinemas_data if c.get("city") in cities
    ]
            
    print(f"Znaleziono {len(target_cinemas)} kin Helios dla miast: {', '.join(cities)}.")
    return target_cinemas

async def scrape_and_save(supabase, cities=["Poznań"]):
    async with requests.AsyncSession(impersonate="chrome") as client:
        try:
            print("Nawiązywanie połączenia z Heliosem...")
            target_cinemas = await get_target_cinemas(client, cities)
            if not target_cinemas:
                print("Nie znaleziono kin Heliosa. Zakończono.")
                return

            movies_cache = {}

            for cinema in target_cinemas:
                cinema_name = cinema['name']
                print(f"\n--- Repertuar dla: {cinema_name} ---")

                # Zapis kina do bazy
                db_cinema_id = upsert_cinema(supabase, cinema_name, cinema['city'], "Helios")

                # --- POBIERANIE INFORMACJI O SALACH Z REST API ---
                cinema_source_id = cinema['id']
                screens_url = f"https://restapi.helios.pl/api/cinema/{cinema_source_id}/screen"
                screens_mapping = {}
                try:
                    screens_resp = await client.get(screens_url, timeout=30.0)
                    if screens_resp.status_code == 200:
                        for screen in screens_resp.json():
                            screens_mapping[screen["id"]] = screen.get("name", "")
                except Exception as e:
                    print(f"Błąd pobierania sal dla kina {cinema_name}: {e}")

                # --- POBIERANIE LISTY FILMÓW Z NUXT ---
                repertoire_url = f"https://helios.pl/{cinema['slug_city']}/{cinema['slug']}/repertuar"
                nuxt_state = await fetch_nuxt_state(client, repertoire_url)
                repertoire = nuxt_state.get("state", {}).get("repertoire", {})

                # Mapowanie _id filmu/wydarzenia na typ (np. Helios na Scenie) na podstawie flag
                id_to_movie_type = {}
                irrelevant_flags = {"premiera", "familijny", "Już w sprzedaży!"}
                for date_screenings in repertoire.get("screenings", {}).values():
                    for _id, item_data in date_screenings.items():
                        flags = item_data.get("flags")
                        if flags and _id not in id_to_movie_type:
                            for flag in flags:
                                if flag not in irrelevant_flags:
                                    id_to_movie_type[_id] = flag
                                    break
                
                clean_titles = {}
                for date_data in repertoire.get("screenings", {}).values():
                    for _id, item_data in date_data.items():
                        if _id not in clean_titles:
                            for scr in item_data.get("screenings", []):
                                movies = scr.get("screeningMovies", [])
                                if movies and movies[0].get("movie", {}).get("title"):
                                    clean_titles[_id] = movies[0]["movie"]["title"]
                                    break

                api_id_to_title = {}
                orig_title_to_title = {}
                movies_to_upsert = {}

                for m in repertoire.get("list", []):
                    _id = m.get("_id")
                    source_id = m.get("sourceId")
                    orig_title = m.get("title") or m.get("name")
                    if not orig_title:
                        continue

                    title = clean_titles.get(_id) or orig_title
                    
                    if source_id:
                        api_id_to_title[source_id] = title
                    orig_title_to_title[orig_title] = title

                    if title not in movies_to_upsert:
                        release_date = m.get("premiereDate", "")
                        movies_to_upsert[title] = {
                            "title": title,
                            "movie_type": id_to_movie_type.get(_id),
                            "length": m.get("duration"),
                            "poster": m.get("posterPhoto", {}).get("url"),
                            "release_year": release_date[:4] if release_date else None
                        }
                # --- POBIERANIE SEANSÓW Z REST API ---
                screenings_url = f"https://restapi.helios.pl/api/cinema/{cinema_source_id}/screening"
                try:
                    screenings_resp = await client.get(screenings_url, timeout=30.0)
                    screenings_data = screenings_resp.json() if screenings_resp.status_code == 200 else []
                except Exception as e:
                    print(f"Błąd pobierania seansów dla kina {cinema_name}: {e}")
                    screenings_data = []
                
                # --- POBIERANIE WYDARZEŃ (SEANSÓW SPECJALNYCH) Z REST API ---
                now = datetime.now(ZoneInfo("Europe/Warsaw"))
                date_from = now.strftime("%Y-%m-%dT00:00:00.000")
                date_to = (now + timedelta(days=14)).strftime("%Y-%m-%dT23:59:59.999")
                events_url = f"https://restapi.helios.pl/api/cinema/{cinema_source_id}/event?dateTimeFrom={date_from}&dateTimeTo={date_to}"
                try:
                    events_resp = await client.get(events_url, timeout=30.0)
                    events_data = events_resp.json() if events_resp.status_code == 200 else []
                except Exception as e:
                    print(f"Błąd pobierania wydarzeń dla kina {cinema_name}: {e}")
                    events_data = []

                if not screenings_data and not events_data:
                    print(f"Brak seansów dla kina {cinema_name}.")
                    continue

                print("Zapisywanie filmów do bazy...")

                if movies_to_upsert:
                    updated_cache = upsert_movies_batch(supabase, movies_to_upsert)
                    movies_cache.update(updated_cache)

                print("Przetwarzanie i zapisywanie seansów do bazy...")
                new_screenings = {}
                
                # 1. Zwykłe seanse
                for scr in screenings_data:
                    movie_id_api = scr.get("movieId")
                    title = api_id_to_title.get(movie_id_api)
                    if not title:
                        continue
                        
                    db_movie_id = movies_cache.get(title)
                    
                    start_time_raw = scr.get("screeningTimeFrom")
                    scr_id = scr.get("id")
                    
                    if not db_movie_id or not start_time_raw or not scr_id:
                        continue
                        
                    start_time = parse_start_time(start_time_raw)
                        
                    screen_id = scr.get("screenId")
                    room_name = screens_mapping.get(screen_id, "") if screen_id else ""
                    
                    screening_key = (db_movie_id, db_cinema_id, start_time, room_name)
                    new_screenings[screening_key] = {
                        "movie_id": db_movie_id,
                        "cinema_id": db_cinema_id,
                        "start_time": start_time,
                        "room_name": room_name,
                        "booking_link": f"https://bilety.helios.pl/screen/{scr_id}?cinemaId={cinema_source_id}"
                    }
                            
                # 2. Seanse wydarzeń specjalnych
                for event in events_data:
                    orig_title = event.get("name")
                    title = orig_title_to_title.get(orig_title) or orig_title
                    
                    db_movie_id = movies_cache.get(title)
                    
                    start_time_raw = event.get("timeFrom")
                    scr_id = event.get("screeningId")
                    
                    if not db_movie_id or not start_time_raw or not scr_id:
                        continue
                        
                    start_time = parse_start_time(start_time_raw)
                        
                    screen_id = event.get("screenId")
                    room_name = screens_mapping.get(screen_id, "") if screen_id else ""
                        
                    screening_key = (db_movie_id, db_cinema_id, start_time, room_name)
                    new_screenings[screening_key] = {
                        "movie_id": db_movie_id,
                        "cinema_id": db_cinema_id,
                        "start_time": start_time,
                        "room_name": room_name,
                        "booking_link": f"https://bilety.helios.pl/screen/{scr_id}?cinemaId={cinema_source_id}"
                    }
                            
                if new_screenings:
                    upsert_screenings_chunked(supabase, new_screenings, cinema_name)

            print("\nZakończono zapisywanie danych z Heliosa!")

        except Exception as e:
            print(f"Wystąpił błąd w trakcie scrapowania Heliosa: {str(e)}")
