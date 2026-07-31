import logging
import asyncio
import aiohttp
from datetime import datetime
from supabase import Client

from api.tmdb import get_tmdb_movie_details, get_tmdb_ratings_by_id
from api.filmweb import search_movie_details, get_filmweb_rating_by_id
from api.omdb import get_omdb_ratings
from core.merge_movies import check_and_merge_movie, version_key
from utils import search_title


logger = logging.getLogger(__name__)

# Po ilu dniach od premiery uznajemy ocenę za ustabilizowaną. Świeży film zbiera głosy lawinowo
# i jego średnia potrafi się zmienić o kilka dziesiątych w ciągu tygodnia; klasyk sprzed lat
# praktycznie nie drgnie, więc odpytywanie go co dobę to czysty narzut.
RATING_FRESH_DAYS = 180

# Ile filmów odświeżamy jednocześnie. Filmweb to nieoficjalne API - nie chcemy go zalewać.
RATING_CONCURRENCY = 5
async def enrich_movies_data(supabase: Client):
    logger.info("Rozpoczynamy wzbogacanie danych o filmach z TMDB i Filmweb...")
    
    # Pobieramy filmy, które nie mają jeszcze danych z TMDB (zabezpieczenie przed ponownym pobieraniem)
    response = supabase.table("movies").select("id, title, original_title, release_year, movie_type, director").is_("title_tmdb", "null").execute()
    movies = response.data

    # Pomijamy typy wydarzeniowe, które nie są filmami (nie mają sensownego odpowiednika w TMDB/Filmweb)
    # DLA DZIECI to zwykle prawdziwe filmy dziecięce (są w TMDB) - wzbogacamy je. Eventy Heliosa
    # oznaczone DLA DZIECI są chronione przed scaleniem z bazowym filmem w check_and_merge_movie.
    SKIP_ENRICH_TYPES = ("SPORT", "MARATON", "TEATR", "CYRK", "OPERA", "BALET", "WYSTAWY", "SALON KULTURY")
    movies = [m for m in movies if m.get("movie_type") not in SKIP_ENRICH_TYPES]

    if not movies:
        logger.info("Wszystkie filmy mają już pobrane informacje z baz zewnętrznych.")
        return 0

    logger.info(f"Znaleziono {len(movies)} filmów do uzupełnienia.")

    # --- NOWE: Pobieramy już wzbogacone filmy z bazy, aby wiedzieć jakie tmdb_id już posiadamy ---
    try:
        enriched_response = supabase.table("movies").select("id, tmdb_id, title, movie_type").not_.is_("tmdb_id", "null").execute()
        # Klucz (tmdb_id, wersja) - spójnie z check_and_merge_movie, by wersje rozszerzone/reżyserskie
        # tego samego filmu NIE były scalane z podstawową (mają to samo tmdb_id, ale to osobny film).
        seen_tmdb_ids = {(m["tmdb_id"], version_key(m["title"])): {"id": m["id"], "title": m["title"]} for m in enriched_response.data if m.get("tmdb_id") and m.get("movie_type") not in ("LADIES NIGHT/KNO", "UKRAIŃSKI DUBBING", "UNLIMITED SHOW", "DLA DZIECI")}
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
                    "cast_tmdb": tmdb_data.get("cast"),
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
                    "filmweb_id": filmweb_data.get("id"),
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


def _needs_rating_refresh(movie: dict, today) -> bool:
    """Czy warto odpytać API o oceny tego filmu.

    Dwa powody: film jest ŚWIEŻY (oceny wciąż się ruszają) albo ma DZIURY w ocenach (poprzednia próba
    się nie powiodła - np. OMDb nie odpowiedziało - i bez ponowienia zostałaby pusta na zawsze).
    Klasyk z kompletem ocen pomijamy: jego średnia się nie zmienia, a zapytanie i tak kosztuje.
    """
    if not all(movie.get(k) is not None for k in ("rating_tmdb", "rating_imdb", "rating_filmweb")):
        return True
    raw_date = movie.get("release_date")
    if not raw_date:
        return True  # bez daty nie wiemy, czy film jest świeży - bezpieczniej odświeżyć
    try:
        return (today - datetime.fromisoformat(raw_date).date()).days <= RATING_FRESH_DAYS
    except ValueError:
        return True


async def refresh_movie_ratings(supabase: Client):
    """Odświeża oceny (TMDB / IMDb / Filmweb) filmów JUŻ dopasowanych do zewnętrznych baz.

    Po co: `enrich_movies_data` bierze wyłącznie filmy bez `title_tmdb`, więc raz dopasowany film
    nigdy nie dostawał aktualizacji - jego oceny zostawały zamrożone w dniu premiery, czyli w momencie
    najmniej wiarygodnym (kilkaset głosów, chwiejna średnia). Ranking "Wysoko oceniane" opierał się
    właśnie na tych danych.

    Odpytujemy PO ZAPISANYCH ID, nigdy przez wyszukiwanie po tytule - powtórne wyszukiwanie mogłoby
    dopasować rekord do innego filmu i po cichu podmienić poprawne dane.

    Aktualizujemy TYLKO oceny. Tytuły, plakaty i opisy zostawiamy nietknięte: przeszły już przez
    konsolidację i nadpisywanie ich przy każdym przebiegu tylko groziłoby regresją.
    """
    cols = "id, title, release_date, tmdb_id, imdb_id, filmweb_id, rating_tmdb, rating_imdb, rating_filmweb"
    try:
        rows = supabase.table("movies").select(cols).execute().data or []
    except Exception as e:
        logger.error(f"Nie udało się pobrać filmów do odświeżenia ocen: {e}")
        return 0

    today = datetime.now().date()
    targets = [
        m for m in rows
        if (m.get("tmdb_id") or m.get("imdb_id") or m.get("filmweb_id")) and _needs_rating_refresh(m, today)
    ]
    if not targets:
        logger.info("Odświeżanie ocen: brak filmów wymagających aktualizacji.")
        return 0

    logger.info(f"Odświeżanie ocen dla {len(targets)} z {len(rows)} filmów...")
    sem = asyncio.Semaphore(RATING_CONCURRENCY)
    updated = 0

    async def refresh_one(session, movie):
        nonlocal updated
        async with sem:
            # Każde źródło osobno - brak jednego nie może zablokować pozostałych.
            tmdb_task = get_tmdb_ratings_by_id(movie["tmdb_id"], session) if movie.get("tmdb_id") else _none()
            omdb_task = get_omdb_ratings(movie["imdb_id"], session) if movie.get("imdb_id") else _none()
            fw_task = get_filmweb_rating_by_id(movie["filmweb_id"], session) if movie.get("filmweb_id") else _none()
            tmdb_r, omdb_r, fw_r = await asyncio.gather(tmdb_task, omdb_task, fw_task, return_exceptions=True)

        update = {}
        if isinstance(tmdb_r, dict):
            update.update(tmdb_r)
        if isinstance(omdb_r, dict):
            # Z OMDb bierzemy WYŁĄCZNIE oceny - reszta pól (tytuł, rok, długość) służy diagnostyce
            # przy pierwszym dopasowaniu i nie ma powodu jej nadpisywać.
            update.update({k: omdb_r[k] for k in ("rating_imdb", "rating_count_imdb", "rating_rt", "rating_metacritic") if k in omdb_r})
        if isinstance(fw_r, dict):
            update.update(fw_r)

        # Nie zapisujemy nulli: gdy API chwilowo nie oddało oceny, lepiej zostawić poprzednią wartość
        # niż wyczyścić działającą ocenę z powodu jednej nieudanej odpowiedzi.
        update = {k: v for k, v in update.items() if v is not None}
        if not update:
            return
        try:
            supabase.table("movies").update(update).eq("id", movie["id"]).execute()
            updated += 1
        except Exception as e:
            logger.error(f"Błąd aktualizacji ocen dla '{movie.get('title')}': {e}")

    async with aiohttp.ClientSession() as session:
        await asyncio.gather(*[refresh_one(session, m) for m in targets])

    logger.info(f"Odświeżono oceny w {updated} filmach.")
    return updated


async def _none():
    """Placeholder dla źródła, którego id nie znamy - upraszcza gather bez rozgałęziania."""
    return None
