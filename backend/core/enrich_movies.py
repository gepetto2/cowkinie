import logging
import asyncio
import aiohttp
from datetime import datetime
from supabase import Client

from api.tmdb import get_tmdb_movie_details
from api.filmweb import search_movie_details
from api.omdb import get_omdb_ratings
from core.merge_movies import check_and_merge_movie
from utils import search_title


logger = logging.getLogger(__name__)
async def enrich_movies_data(supabase: Client):
    logger.info("Rozpoczynamy wzbogacanie danych o filmach z TMDB i Filmweb...")
    
    # Pobieramy filmy, które nie mają jeszcze danych z TMDB (zabezpieczenie przed ponownym pobieraniem)
    response = supabase.table("movies").select("id, title, original_title, release_year, movie_type, director").is_("title_tmdb", "null").execute()
    movies = response.data

    # Pomijamy typy wydarzeniowe, które nie są filmami (nie mają sensownego odpowiednika w TMDB/Filmweb)
    SKIP_ENRICH_TYPES = ("SPORT", "MARATON", "TEATR", "CYRK", "OPERA", "BALET", "WYSTAWY")
    movies = [m for m in movies if m.get("movie_type") not in SKIP_ENRICH_TYPES]

    if not movies:
        logger.info("Wszystkie filmy mają już pobrane informacje z baz zewnętrznych.")
        return 0

    logger.info(f"Znaleziono {len(movies)} filmów do uzupełnienia.")

    # --- NOWE: Pobieramy już wzbogacone filmy z bazy, aby wiedzieć jakie tmdb_id już posiadamy ---
    try:
        enriched_response = supabase.table("movies").select("id, tmdb_id, title, movie_type").not_.is_("tmdb_id", "null").execute()
        seen_tmdb_ids = {m["tmdb_id"]: {"id": m["id"], "title": m["title"]} for m in enriched_response.data if m.get("tmdb_id") and m.get("movie_type") not in ("LADIES NIGHT/KNO", "UKRAIŃSKI DUBBING", "UNLIMITED SHOW")}
    except Exception as e:
        logger.warning(f"Nie udało się pobrać istniejących tmdb_id (upewnij się, że kolumna 'tmdb_id' istnieje w tabeli 'movies'): {e}")
        seen_tmdb_ids = {}

    async with aiohttp.ClientSession() as session:
        for i, movie in enumerate(movies, 1):
            db_id = movie.get("id")
            db_title = movie.get("title")
            db_original_title = movie.get("original_title")
            db_year_raw = movie.get("release_year")
            db_director = movie.get("director")
            
            search_year = None
            if db_year_raw:
                try:
                    parsed_year = int(str(db_year_raw)[:4])
                    search_year = parsed_year
                except ValueError:
                    pass
            
            # Do zapytań używamy tytułu bez ozdobników pokazów specjalnych (w bazie zostaje pełny)
            query_title = search_title(db_title)
            if query_title != db_title:
                logger.info(f"[{i}/{len(movies)}] Uzupełnianie: '{db_title}' (szukam jako '{query_title}')")
            else:
                logger.info(f"[{i}/{len(movies)}] Uzupełnianie: '{db_title}'")

            tmdb_task = get_tmdb_movie_details(query_title, search_year, db_director, db_original_title, session)
            filmweb_task = search_movie_details(query_title, search_year, session)
            
            tmdb_data, filmweb_data = await asyncio.gather(tmdb_task, filmweb_task)
            update_data = {}
            
            if tmdb_data:
                tmdb_id = tmdb_data.get("tmdb_id")
                
                # --- MERGE LOGIC: Jeśli znaleźliśmy ten sam film w TMDB, robimy scalenie ---
                if tmdb_id:
                    tmdb_title = tmdb_data.get("title", "")
                    is_duplicate = check_and_merge_movie(supabase, movie, tmdb_id, seen_tmdb_ids, tmdb_title)
                    if is_duplicate:
                        # Przerywamy dalszą aktualizację dla usuniętego filmu
                        continue
                    
                    update_data["tmdb_id"] = tmdb_id

                poster_path = tmdb_data.get("poster_path")
                poster_url = f"https://image.tmdb.org/t/p/w500{poster_path}" if poster_path else None

                update_data.update({
                    "title_tmdb": tmdb_data.get("title"),
                    "original_title_tmdb": tmdb_data.get("original_title"),
                    "release_year_tmdb": tmdb_data.get("release_year"),
                    "release_date_tmdb": tmdb_data.get("release_date_pl"),
                    "length_tmdb": tmdb_data.get("length"),
                    "director_tmdb": tmdb_data.get("director"),
                    "poster_tmdb": poster_url,
                    "description_tmdb": tmdb_data.get("overview"),
                    "rating_tmdb": tmdb_data.get("rating"),
                    "rating_count_tmdb": tmdb_data.get("rating_count")
                })

                # OMDb: oceny IMDb/RT/Metacritic po imdb_id z TMDB (jednoznaczne dopasowanie).
                # Sekwencyjnie po TMDB, bo imdb_id pochodzi z jego szczegółów.
                imdb_id = tmdb_data.get("imdb_id")
                if imdb_id:
                    update_data["imdb_id"] = imdb_id
                    omdb_data = await get_omdb_ratings(imdb_id, session)
                    if omdb_data:
                        update_data.update(omdb_data)

            if filmweb_data:
                update_data.update({
                    "title_filmweb": filmweb_data.get("title"),
                    "release_year_filmweb": filmweb_data.get("year"),
                    "release_date_filmweb": filmweb_data.get("release_date"),
                    "length_filmweb": filmweb_data.get("duration"),
                    "director_filmweb": filmweb_data.get("directors"),
                    "rating_filmweb": filmweb_data.get("rating"),
                    "rating_count_filmweb": filmweb_data.get("rating_count"),
                    "description_filmweb": filmweb_data.get("description"),
                    "cast_filmweb": filmweb_data.get("cast"),
                    "genre_filmweb": filmweb_data.get("genre"),
                    "poster_filmweb": filmweb_data.get("poster")
                })
                
            if update_data:
                try:
                    supabase.table("movies").update(update_data).eq("id", db_id).execute()
                except Exception as e:
                    logger.error(f"Błąd podczas aktualizacji filmu '{db_title}' w bazie: {e}")
                    
    logger.info("Zakończono wzbogacanie danych o filmach!")
    return len(movies)
