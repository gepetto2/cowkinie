from curl_cffi import requests
from utils import parse_start_time
from database import upsert_cinema, upsert_movies_batch, upsert_screenings_chunked

async def get_target_cinemas(client: requests.AsyncSession, cities: list) -> list:
    """Pobiera listę kin Multikino i filtruje te z wybranych miast."""
    cinemas_url = "https://www.multikino.pl/api/microservice/showings/cinemas"
    
    print("Pobieranie listy kin z Multikina...")
    headers = {"Accept": "application/json"}
    try:
        response = await client.get(cinemas_url, headers=headers, timeout=60.0)
        if response.status_code != 200:
            print(f"Błąd pobierania listy kin (Kod {response.status_code}): {response.text[:200]}")
            return []
            
        data = response.json()
        all_cinemas_groups = data.get("result", [])
        
        target_cinemas = []
        for group in all_cinemas_groups:
            for cinema in group.get("cinemas", []):
                cinema_name = cinema.get("cinemaName", "")
                matched_city = None
                for city in cities:
                    if city in cinema_name:
                        matched_city = city
                        break
                if matched_city:
                    target_cinemas.append({
                        "id": cinema.get("cinemaId"),
                        "name": cinema_name,
                        "city": matched_city
                    })
                    
        print(f"Znaleziono {len(target_cinemas)} kin dla miast: {', '.join(cities)}.")
        return target_cinemas
        
    except Exception as e:
        print(f"Błąd podczas pobierania listy kin: {e}")
        return []

async def scrape_and_save(supabase, cities=["Poznań"]):
    # Używamy curl_cffi z proxy, co pozwala nam zachować sesję (ciasteczka) i sygnaturę Chrome
    async with requests.AsyncSession(impersonate="chrome") as client:
        try:
            # KROK 1: Wejście na stronę główną, aby Cloudflare nadał nam ciasteczka (np. cf_clearance)
            print("Rozpoczynam pobieranie ciasteczek...")
            await client.get("https://www.multikino.pl/", timeout=60.0)
            
            # KROK 2: Pobranie kin w wybranych miastach
            target_cinemas = await get_target_cinemas(client, cities)
            if not target_cinemas:
                print("Nie znaleziono kin lub wystąpił błąd. Zakończono.")
                return
                
            movies_cache = {}

            # KROK 3: Iteracja po znalezionych kinach
            for cinema in target_cinemas:
                cinema_id_api = cinema["id"]
                cinema_name = cinema["name"]
                cinema_city = cinema["city"]

                print(f"\n--- Rozpoczynam scraping dla: {cinema_name} (ID: {cinema_id_api}) ---")
                
                # Upsert kina w Supabase
                db_cinema_id = upsert_cinema(supabase, cinema_name, cinema_city, "Multikino")
                
                # Właściwe zapytanie do API kina
                target_url = f"https://www.multikino.pl/api/microservice/showings/cinemas/{cinema_id_api}/films"
                headers = {"Referer": "https://www.multikino.pl/", "Accept": "application/json"}
                response = await client.get(target_url, headers=headers, timeout=60.0)
                
                if response.status_code != 200:
                    print(f"Błąd Multikina dla {cinema_name} (Kod {response.status_code}): {response.text[:200]}")
                    continue
                    
                try:
                    data = response.json()
                except ValueError:
                    print(f"Odpowiedź nie jest poprawnym formatem JSON. Fragment: {response.text[:250]}")
                    continue

                films_list = data.get("result", []) if isinstance(data, dict) else []
                print(f"Pobrano {len(films_list)} filmów dla {cinema_name}. Zapisywanie do bazy...")

                # KROK 4: Zbieranie filmów do operacji Upsert
                movies_to_upsert = {}
                for film in films_list:
                    title = film.get("filmTitle").strip()
                    if not title:
                        continue
                        
                    film_attrs = film.get("filmAttributes", [])
                    movie_type = (film_attrs[0].get("shortName") or film_attrs[0].get("name")) if film_attrs else None
                    if movie_type:
                        movie_type = movie_type.removesuffix(" - wydarzenie specjalne")
                        if movie_type == "FAMILIJNY":
                            movie_type = None
                        if movie_type == "KNO":
                            movie_type = "LADIES NIGHT/KNO"
                        if movie_type == "WIDOWISKO":
                            movie_type = "CYRK"

                    # Sprawdzenie, czy któryś z seansów ma atrybut "KULTOWE KINO"
                    if any(
                        attr.get("name") == "KULTOWE KINO"
                        for group in film.get("showingGroups", [])
                        for session in group.get("sessions", [])
                        for attr in session.get("attributes", [])
                    ):
                        movie_type = "KULTOWE"

                    if title.startswith("Maraton:") or title.startswith("Minimaraton"):
                        movie_type = "MARATON"

                    release_date = film.get("releaseDate")
                    release_year = release_date[:4] if release_date else None

                    movies_to_upsert[title] = {
                        "title": title,
                        "movie_type_multikino": movie_type,
                        "length_multikino": film.get("runningTime") if film.get("runningTime") and film.get("runningTime") > 0 else None,
                        "poster_multikino": film.get("posterImageSrc"),
                        "release_year_multikino": release_year,
                        "description_multikino": film.get("synopsisShort"),
                        "director_multikino": film.get("director").strip(),
                        "cast_multikino": film.get("cast")
                    }
                    
                if movies_to_upsert:
                    updated_cache = upsert_movies_batch(supabase, movies_to_upsert)
                    movies_cache.update(updated_cache)

                # KROK 5: Zbieranie seansów do operacji Upsert
                new_screenings = {}
                for film in films_list:
                    title = film.get("filmTitle", "").strip()
                    movie_id = movies_cache.get(title)
                    if not movie_id:
                        continue

                    for group in film.get("showingGroups", []):
                        for session in group.get("sessions", []):
                            start_time_raw = session.get("startTime", "")
                            if not start_time_raw:
                                continue
                                
                            start_time = parse_start_time(start_time_raw)
                                
                            screen_name = session.get("screenName", "")
                            booking_url = session.get("bookingUrl", "")
                            if booking_url and not booking_url.startswith("http"):
                                booking_url = f"https://www.multikino.pl{booking_url}"
                            
                            # Wyciągnięcie odpowiedniej wartości dla kolumny lang
                            lang = None
                            for attr in session.get("attributes", []):
                                if attr.get("attributeType") == "Language":
                                    lang = attr.get("name")
                                    break
                            
                            
                            screening_key = (movie_id, start_time, screen_name)
                            new_screenings[screening_key] = {
                                "movie_id": movie_id,
                                "cinema_id": db_cinema_id,
                                "start_time": start_time,
                                "end_time": parse_start_time(session.get("endTime")) if session.get("endTime") else None,
                                "duration": session.get("duration"),
                                "room_name": screen_name,
                                "lang": "PL" if lang=="POLSKI" else lang,
                                "booking_link": booking_url
                            }
                                
                if new_screenings:
                    upsert_screenings_chunked(supabase, new_screenings, cinema_name)

            print("\nZakończono zapisywanie danych z Multikina!")

        except Exception as e:
            print(f"Wystąpił błąd: {str(e)}")

if __name__ == "__main__":
    print("Skrypt uruchom poprzez plik run_scrapers.py")