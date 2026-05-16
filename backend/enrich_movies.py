import asyncio
import aiohttp
from datetime import datetime
from supabase import Client

from tmdb import get_tmdb_movie_details
from filmweb import search_movie_details

async def enrich_movies_data(supabase: Client):
    print("\nRozpoczynamy wzbogacanie danych o filmach z TMDB i Filmweb...")
    
    # Pobieramy filmy, które nie mają jeszcze danych z TMDB (zabezpieczenie przed ponownym pobieraniem)
    response = supabase.table("movies").select("id, title, release_year, movie_type, director").is_("title_tmdb", "null").execute()
    movies = response.data

    # Pomijamy filmy typu SPORT i MARATON
    movies = [m for m in movies if m.get("movie_type") not in ("SPORT", "MARATON")]

    if not movies:
        print("Wszystkie filmy mają już pobrane informacje z baz zewnętrznych.")
        return

    print(f"Znaleziono {len(movies)} filmów do uzupełnienia.\n")
    current_year = datetime.now().year

    async with aiohttp.ClientSession() as session:
        for i, movie in enumerate(movies, 1):
            db_id = movie.get("id")
            db_title = movie.get("title")
            db_year_raw = movie.get("release_year")
            db_director = movie.get("director")
            
            # Modyfikacja tytułu przed wyszukiwaniem
            search_title = db_title.replace("cz.", "część").replace("Cz.", "Część")
            
            search_year = None
            if db_year_raw:
                try:
                    parsed_year = int(str(db_year_raw)[:4])
                    search_year = parsed_year
                except ValueError:
                    pass
            
            print(f"[{i}/{len(movies)}] Uzupełnianie: '{db_title}' -> szukane jako '{search_title}'")
            
            tmdb_task = get_tmdb_movie_details(search_title, search_year, db_director, session)
            filmweb_task = search_movie_details(search_title, search_year, session)
            
            tmdb_data, filmweb_data = await asyncio.gather(tmdb_task, filmweb_task)
            update_data = {}
            
            if tmdb_data:
                poster_path = tmdb_data.get("poster_path")
                poster_url = f"https://image.tmdb.org/t/p/w500{poster_path}" if poster_path else None
                
                update_data.update({
                    "title_tmdb": tmdb_data.get("title"),
                    "original_title_tmdb": tmdb_data.get("original_title"),
                    "release_year_tmdb": tmdb_data.get("release_year"),
                    "length_tmdb": tmdb_data.get("length"),
                    "director_tmdb": tmdb_data.get("director"),
                    "poster_tmdb": poster_url,
                    "description_tmdb": tmdb_data.get("overview")
                })
                
            if filmweb_data:
                update_data.update({
                    "title_filmweb": filmweb_data.get("title"),
                    "release_year_filmweb": filmweb_data.get("year"),
                    "length_filmweb": filmweb_data.get("duration"),
                    "director_filmweb": filmweb_data.get("directors")
                })
                
            if update_data:
                try:
                    supabase.table("movies").update(update_data).eq("id", db_id).execute()
                except Exception as e:
                    print(f"  Błąd podczas aktualizacji filmu '{db_title}' w bazie: {e}")
                    
    print("\nZakończono wzbogacanie danych o filmach!")
